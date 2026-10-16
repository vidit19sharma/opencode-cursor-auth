// Network-free unit tests for src/plugin.ts auth/key logic. Run: bun test spike/plugin.test.ts
import { test, expect, mock, beforeEach, afterAll, spyOn } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"

// Sandbox every path the plugin could touch before it is imported.
const tmp = mkdtempSync(join(tmpdir(), "plugin-test-"))
const savedEnv = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, CURSOR_API_KEY: process.env.CURSOR_API_KEY }
process.env.HOME = tmp
process.env.XDG_DATA_HOME = join(tmp, "data")
delete process.env.CURSOR_API_KEY

const statusMock = mock(async (): Promise<unknown> => ({ status: "logged-out" }))
const loginMock = mock(async (_o: { onLoginUrl: (u: string) => void }): Promise<unknown> => ({}))
const modelsMock = mock(async () => [])
mock.module("@cursor/sdk", () => ({
  Cursor: { auth: { status: statusMock, login: loginMock }, models: { list: modelsMock } },
  Agent: {},
}))
const bridgeMock = mock(async (..._a: unknown[]) => new Response("ok"))
const releaseMock = mock((_scope: string) => {})
const forgetMock = mock((_scope: string) => {})
mock.module("../src/bridge.ts", () => ({
  handleChatCompletion: bridgeMock,
  releaseParked: releaseMock,
  forgetSession: forgetMock,
  // same shape as the real errorResponse for the inputs plugin.ts passes
  errorResponse: (err: { message?: string; code?: string } | string, status: number) => {
    const e = typeof err === "string" ? { message: err } : err
    return Response.json(
      { error: { message: e.message, type: status === 401 ? "authentication_error" : "api_error", ...(e.code ? { code: e.code } : {}) } },
      { status },
    )
  },
}))
mock.module("../src/models.ts", () => ({ currentModels: async () => ({ auto: { name: "Auto" } }), parseContext: () => undefined }))

const { CursorAuthPlugin, _resetKeyCache } = await import("../src/plugin.ts")

const DAY = 24 * 60 * 60 * 1000
const makeClient = () => ({ auth: { set: mock(async (_a: unknown) => ({})) } })
const makePlugin = (client = makeClient()) =>
  CursorAuthPlugin({ client, directory: tmp, worktree: tmp, $: undefined } as unknown as PluginInput)
const hooks: Hooks = await makePlugin()

async function callChat(key?: string) {
  const { fetch } = await hooks.auth!.loader!(
    (async () => (key === undefined ? undefined : { type: "api", key })) as never,
    {} as never,
  )
  const res: Response = await fetch("http://cursor.local/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    headers: { "x-opencode-session": "ses_unit", "x-opencode-agent": "build" },
  })
  return { res, called: bridgeMock.mock.calls.length > 0, args: bridgeMock.mock.calls[0] }
}

beforeEach(() => {
  _resetKeyCache()
  bridgeMock.mockClear()
  statusMock.mockClear()
  statusMock.mockImplementation(async () => ({ status: "logged-out" }))
  delete process.env.CURSOR_API_KEY
})

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  rmSync(tmp, { recursive: true, force: true })
})

test("empty / whitespace pasted key → 401 invalid_api_key, bridge not called", async () => {
  for (const key of ["", "   "]) {
    const { res, called } = await callChat(key)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string; type: string } }
    expect(body.error.code).toBe("invalid_api_key")
    expect(body.error.type).toBe("authentication_error")
    expect(called).toBe(false)
  }
  expect(statusMock).not.toHaveBeenCalled()
})

test("valid pasted key is trimmed, passed to bridge, status skipped", async () => {
  const { res, args } = await callChat("  crsr_abc \n")
  expect(res.status).toBe(200)
  expect(args?.[1]).toBe("crsr_abc")
  expect(args?.[3]).toBe("ses_unit")
  expect(args?.[4]).toBe("build")
  expect(statusMock).not.toHaveBeenCalled()
})

test("CURSOR_API_KEY env skips status check", async () => {
  process.env.CURSOR_API_KEY = "env_key"
  const { res, called } = await callChat()
  expect(res.status).toBe(200)
  expect(called).toBe(true)
  expect(statusMock).not.toHaveBeenCalled()
})

test("sentinel + logged-in → bridge with SDK-store key (undefined)", async () => {
  statusMock.mockImplementation(async () => ({ status: "logged-in", apiKeyExpiresAtMs: Date.now() + 30 * DAY }))
  const { res, called, args } = await callChat("cursor-sdk-store")
  expect(res.status).toBe(200)
  expect(called).toBe(true)
  expect(args?.[1]).toBeUndefined()
})

test("sentinel + logged-out → 401 mentioning opencode auth login", async () => {
  const { res, called } = await callChat("cursor-sdk-store")
  expect(res.status).toBe(401)
  expect(((await res.json()) as { error: { message: string } }).error.message).toContain("opencode auth login")
  expect(called).toBe(false)
})

test("sentinel + expired key → 401", async () => {
  statusMock.mockImplementation(async () => ({ status: "logged-in", apiKeyExpiresAtMs: Date.now() - 1000 }))
  const { res, called } = await callChat("cursor-sdk-store")
  expect(res.status).toBe(401)
  expect(((await res.json()) as { error: { message: string } }).error.message).toContain("expired")
  expect(called).toBe(false)
})

test("key expiring in 3 days → one-time stderr warning", async () => {
  statusMock.mockImplementation(async () => ({ status: "logged-in", apiKeyExpiresAtMs: Date.now() + 3 * DAY }))
  const err = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect((await callChat("cursor-sdk-store")).res.status).toBe(200)
    expect((await callChat("cursor-sdk-store")).res.status).toBe(200)
    const lines = err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("expires"))
    expect(lines.length).toBe(1)
  } finally {
    err.mockRestore()
  }
})

test("status is cached across requests within 60s", async () => {
  statusMock.mockImplementation(async () => ({ status: "logged-in", apiKeyExpiresAtMs: Date.now() + 30 * DAY }))
  await callChat("cursor-sdk-store")
  await callChat("cursor-sdk-store")
  expect(statusMock).toHaveBeenCalledTimes(1)
})

const oauth = () => hooks.auth!.methods[0] as { authorize: () => Promise<{ url: string; method: string; callback: () => Promise<unknown> }> }

test("headless login URL passthrough + success callback", async () => {
  const URL_ = "https://cursor.com/loginDeepControl?x=1"
  loginMock.mockImplementation(({ onLoginUrl }) => {
    setTimeout(() => onLoginUrl(URL_), 5)
    return new Promise((r) => setTimeout(() => r({ apiKey: "k", email: "e@x", apiKeyExpiresAtMs: Date.now() + 1e9 }), 20))
  })
  const result = await oauth().authorize()
  expect(result.url).toBe(URL_)
  expect(result.method).toBe("auto")
  expect(await result.callback()).toEqual({ type: "success", key: "cursor-sdk-store" })
  expect(loginMock.mock.calls.at(-1)?.[0]).toMatchObject({ apiKeyName: "opencode-cursor-auth", openBrowser: false })
})

test("login rejection → callback failed", async () => {
  loginMock.mockImplementation(() => Promise.reject(new Error("denied")))
  const result = await oauth().authorize()
  expect(result.url).toBe("https://cursor.com/dashboard")
  expect(await result.callback()).toEqual({ type: "failed" })
})

test("chat.headers stamps session + agent only for cursor provider", async () => {
  const run = async (providerID: string) => {
    const output = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]!({ sessionID: "ses_x", agent: "title", model: { providerID } } as never, output)
    return output.headers
  }
  expect(await run("cursor")).toEqual({ "x-opencode-session": "ses_x", "x-opencode-agent": "title" })
  expect(await run("anthropic")).toEqual({})
})

test("config: 30 min header/chunk timeouts unless the user set them", async () => {
  const cfg = {} as { provider?: Record<string, { options?: Record<string, unknown> }> }
  await hooks.config!(cfg as never)
  expect(cfg.provider!.cursor.options).toMatchObject({ headerTimeout: 1_800_000, chunkTimeout: 1_800_000, baseURL: "http://cursor.local/v1" })
  const own = { provider: { cursor: { options: { chunkTimeout: 5 } } } }
  await hooks.config!(own as never)
  expect(own.provider.cursor.options).toMatchObject({ chunkTimeout: 5, headerTimeout: 1_800_000 })
})

test("config: models accept images unless the user set modalities", async () => {
  const cfg = {} as { provider?: Record<string, { models: Record<string, { modalities?: unknown }> }> }
  await hooks.config!(cfg as never)
  expect(cfg.provider!.cursor.models.auto.modalities).toEqual({ input: ["text", "image"], output: ["text"] })
  const own = { provider: { cursor: { models: { auto: { name: "Auto", modalities: { input: ["text"], output: ["text"] } } } } } }
  await hooks.config!(own as never)
  expect(own.provider.cursor.models.auto.modalities).toEqual({ input: ["text"], output: ["text"] })
})

test("seedAuthEntry seeds sentinel before init resolves, only when no cursor entry exists", async () => {
  const dir = join(process.env.XDG_DATA_HOME!, "opencode")
  rmSync(dir, { recursive: true, force: true })
  const fresh = makeClient()
  await makePlugin(fresh)
  expect(fresh.auth.set).toHaveBeenCalledTimes(1)
  expect(fresh.auth.set.mock.calls[0][0]).toEqual({ path: { id: "cursor" }, body: { type: "api", key: "cursor-sdk-store" } })

  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ cursor: { type: "api", key: "x" } }))
  const seeded = makeClient()
  await makePlugin(seeded)
  expect(seeded.auth.set).not.toHaveBeenCalled()
})

test("event: session.deleted forgets that session", async () => {
  forgetMock.mockClear()
  await hooks.event!({ event: { type: "session.deleted", properties: { sessionID: "ses_gone", info: { id: "ses_gone" } } } } as never)
  await hooks.event!({ event: { type: "session.updated", properties: { info: { id: "ses_other" } } } } as never)
  expect(forgetMock.mock.calls).toEqual([["ses_gone"]])
})

test("event: session idle releases that session's parked runs, other events do not", async () => {
  releaseMock.mockClear()
  const fire = (event: unknown) => hooks.event!({ event } as never)
  await fire({ type: "session.idle", properties: { sessionID: "ses_idle" } })
  await fire({ type: "session.status", properties: { sessionID: "ses_status", status: { type: "idle" } } })
  expect(releaseMock.mock.calls).toEqual([["ses_idle"], ["ses_status"]])
  await fire({ type: "session.status", properties: { sessionID: "ses_busy", status: { type: "busy" } } })
  await fire({ type: "session.updated", properties: { info: { id: "ses_idle" } } })
  await fire({ type: "message.updated", properties: { info: { sessionID: "ses_idle" } } })
  expect(releaseMock).toHaveBeenCalledTimes(2)
})
