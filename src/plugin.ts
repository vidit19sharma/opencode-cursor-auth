import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { Cursor, type SdkAuthStatus } from "@cursor/sdk"
import { errorResponse, handleChatCompletion, releaseSession, setNotice } from "./bridge.js"
import { currentModels } from "./models.js"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
export { parseContext } from "./models.js"

const BASE_URL = "http://cursor.local/v1"
// opencode's auth entry for a key the SDK keeps itself (~/.cursor/sdk/auth.json or CURSOR_API_KEY)
const SDK_STORE_KEY = "cursor-sdk-store"

// opencode aborts a request after 5 min without response headers, or between chunks. A Cursor turn can
// sit longer: queued for a slot, reasoning silently, or writing a large tool argument (sent only once
// complete). Set provider.cursor.options to override.
const STREAM_TIMEOUT_MS = 30 * 60 * 1000

// Cursor publishes no output limit and the bridge never passes max_tokens to Cursor, so output is only an accounting reserve for opencode.
const DEFAULT_CONTEXT = 200_000
const DEFAULT_OUTPUT = 32_000

export function keyProblem(status: SdkAuthStatus, nowMs: number): string | undefined {
  if (status.status !== "logged-in") return "Cursor SDK key missing — run `opencode auth login` and pick Cursor"
  if (typeof status.apiKeyExpiresAtMs === "number" && status.apiKeyExpiresAtMs <= nowMs)
    return `Cursor SDK key expired on ${new Date(status.apiKeyExpiresAtMs).toISOString()} — run \`opencode auth login\` and pick Cursor`
  return undefined
}

const KEY_CHECK_TTL_MS = 60_000
const EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000
let keyStatus: { at: number; value: Promise<SdkAuthStatus | undefined> } | undefined
let warnedExpiry = false

async function checkKey(): Promise<string | undefined> {
  if (pastedApiKey || process.env.CURSOR_API_KEY) return undefined
  const now = Date.now()
  if (!keyStatus || now - keyStatus.at > KEY_CHECK_TTL_MS) {
    keyStatus = { at: now, value: Cursor.auth.status().catch(() => undefined) }
  }
  const status = await keyStatus.value
  if (!status) return undefined
  const exp = status.status === "logged-in" ? status.apiKeyExpiresAtMs : undefined
  if (!warnedExpiry && typeof exp === "number" && exp > now && exp - now <= EXPIRY_WARN_MS) {
    warnedExpiry = true
    const days = Math.ceil((exp - now) / (24 * 60 * 60 * 1000))
    console.error(`[opencode-cursor-auth] Cursor SDK key expires in ${days} days — run \`opencode auth login\` to renew`)
  }
  return keyProblem(status, now)
}

async function bodyText(input: Request | string | URL, init?: RequestInit): Promise<string> {
  const b = init?.body
  if (typeof b === "string") return b
  if (b instanceof Uint8Array) return new TextDecoder().decode(b)
  if (input instanceof Request) return input.text()
  return ""
}

export function _resetKeyCache() {
  keyStatus = undefined
  warnedExpiry = false
}

let pastedApiKey: string | undefined
const EMPTY_KEY = "Cursor API key is empty — run `opencode auth login` and pick Cursor, or paste a key from cursor.com/dashboard"

async function cursorFetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.includes("/chat/completions")) {
    if (pastedApiKey === "") return errorResponse({ message: EMPTY_KEY, code: "invalid_api_key" }, 401)
    const problem = await checkKey()
    if (problem) return errorResponse(problem, 401)
    const body = JSON.parse(await bodyText(input, init))
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const scope =
      new Headers(init?.headers).get("x-opencode-session") ??
      (input instanceof Request ? input.headers.get("x-opencode-session") : null) ??
      undefined
    return handleChatCompletion(body, pastedApiKey, signal, scope)
  }
  if (url.includes("/models")) {
    return Response.json({
      object: "list",
      data: Object.keys(await currentModels()).map((id) => ({ id, object: "model" })),
    })
  }
  return Response.json({ error: { message: `unsupported endpoint: ${url}` } }, { status: 404 })
}

async function seedAuthEntry(client: PluginInput["client"] | undefined): Promise<void> {
  if (!client?.auth?.set) return
  const file = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json")
  const entries = await readFile(file, "utf8").then(JSON.parse, (err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? {} : undefined))
  if (!entries || typeof entries !== "object" || "cursor" in entries) return
  await client.auth.set({ path: { id: "cursor" }, body: { type: "api", key: SDK_STORE_KEY } })
}

export const CursorAuthPlugin: Plugin = async (input) => {
  seedAuthEntry(input?.client).catch(() => {})
  setNotice((message) => {
    Promise.resolve(input?.client?.tui?.showToast?.({ body: { title: "Cursor", message, variant: "warning", duration: 10_000 } })).catch(() => {})
  })
  return {
    config: async (config) => {
      const providers = (config.provider ??= {})
      const cursor = (providers["cursor"] ??= { models: {} })
      cursor.npm ??= "@ai-sdk/openai-compatible"
      cursor.name ??= "Cursor"
      cursor.options = { headerTimeout: STREAM_TIMEOUT_MS, chunkTimeout: STREAM_TIMEOUT_MS, ...cursor.options, baseURL: BASE_URL }
      cursor.models ??= {}
      for (const [id, { name, context, variants }] of Object.entries(await currentModels())) {
        cursor.models[id] ??= { name }
        const model = cursor.models[id] as (typeof cursor.models)[string] & { variants?: Record<string, Record<string, unknown>> }
        model.cost = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
        model.limit ??= { context: context ?? DEFAULT_CONTEXT, output: DEFAULT_OUTPUT }
        if (variants) model.variants ??= Object.fromEntries(Object.entries(variants).map(([n, v]) => [n, { cursor_params: v.params }]))
      }
    },

    "chat.headers": async (input, output) => {
      if (input.model.providerID === "cursor") output.headers["x-opencode-session"] = input.sessionID
    },

    // a session goes idle only once its loop is over, so a run still parked on its tool
    // results (Esc mid-tool, an aborted sub-agent) will never get them
    event: async ({ event }) => {
      if (event.type === "session.idle") releaseSession(event.properties.sessionID)
      else if (event.type === "session.status" && event.properties.status.type === "idle") releaseSession(event.properties.sessionID)
    },

    auth: {
      provider: "cursor",
      loader: async (getAuth) => {
        const auth = await getAuth().catch(() => undefined)
        pastedApiKey = auth?.type === "api" && auth.key !== SDK_STORE_KEY ? (auth.key ?? "").trim() : undefined
        return {
          apiKey: "cursor-managed",
          baseURL: BASE_URL,
          fetch: cursorFetch,
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Log in with Cursor (browser)",
          authorize: async () => {
            let resolveUrl!: (url: string) => void
            const urlReady = new Promise<string>((r) => (resolveUrl = r))
            const login = Cursor.auth
              .login({
                apiKeyName: "opencode-cursor-auth",
                openBrowser: false,
                onLoginUrl: (url: string) => resolveUrl(url),
              })
              .catch((err: unknown) => err)
            const url = await Promise.race([urlReady, login.then(() => "")])
            return {
              url: typeof url === "string" && url ? url : "https://cursor.com/dashboard",
              instructions: "Complete the login in your browser. The key is stored in ~/.cursor/sdk/auth.json.",
              method: "auto" as const,
              callback: async () => {
                const result = await login
                if (result instanceof Error) return { type: "failed" as const }
                return { type: "success" as const, key: SDK_STORE_KEY }
              },
            }
          },
        },
        {
          type: "api",
          label: "Paste a Cursor API key (cursor.com/dashboard)",
        },
      ],
    },
  }
}


