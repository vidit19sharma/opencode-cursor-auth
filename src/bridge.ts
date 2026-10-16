/**
 * OpenAI chat-completions JSON <-> @cursor/sdk bridge, fully in-process.
 *
 * Tool loop ("held run" pattern, from pwnapplehat/Cursor-OpenAI):
 * each opencode tool is registered as a Cursor customTool whose execute()
 * PARKS on a promise. When the model requests tools we flush them to the
 * client as OpenAI tool_calls and keep the Cursor run alive. The client's
 * next HTTP request (role:"tool" messages) resolves the parked promises and
 * the SAME run continues — one metered Cursor run per opencode tool loop.
 */
import { Agent, AuthenticationError, ConfigurationError, NetworkError, RateLimitError, type SDKAgent, type Run } from "@cursor/sdk"
import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { markBlocked, resolveVariant } from "./models.js"

// @cursor/sdk has no log-level switch: it prints "HH:MM:SS.mmm INFO ..." through
// whatever console.* is installed at call time, ANSI-coloured when stdout is a
// TTY (the opencode TUI). Match after stripping colours; re-wrap per request so
// a host that replaces console.* after plugin load cannot bypass the filter.
const SDK_LOG_LINE = /^\d{2}:\d{2}:\d{2}\.\d{3} (TRACE|DEBUG|INFO|WARN)\s/
const ANSI = /\x1b\[[0-9;]*m/g
const QUIET = Symbol.for("opencode-cursor-auth.quiet")
type ConsoleFn = ((...args: unknown[]) => void) & { [QUIET]?: true }
export function ensureQuietConsole() {
  for (const m of ["log", "info", "warn", "debug"] as const) {
    const current = console[m] as ConsoleFn
    if (current[QUIET]) continue
    const wrapped: ConsoleFn = (...args) => {
      if (typeof args[0] === "string" && SDK_LOG_LINE.test(args[0].replace(ANSI, ""))) return
      current(...args)
    }
    wrapped[QUIET] = true
    console[m] = wrapped
  }
}
ensureQuietConsole()

type ContentPart = { type: string; text?: string }
type OaMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | ContentPart[] | null
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}
type OaTool = {
  type: "function"
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}
type OaBody = {
  model: string
  messages: OaMessage[]
  tools?: OaTool[]
  stream?: boolean
  cursor_params?: unknown
}

function textOf(content: OaMessage["content"]): string {
  if (typeof content === "string") return content
  if (!content) return ""
  return content.map((p) => p.text ?? "").join("")
}

type ToolCallOut = { id: string; name: string; argumentsJson: string }
type Usage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens: number }
  completion_tokens_details?: { reasoning_tokens: number }
}

type Sink = {
  text(t: string): void
  reasoning(t: string): void
  toolCalls(calls: ToolCallOut[]): void
  finish(reason: "stop" | "tool_calls", usage?: Usage): void
  /** Post-first-byte failure: error frame, then close WITHOUT [DONE]. */
  fail(err: unknown): void
  close(): void
}

type ErrorBody = { error: { message: string; type: string; code?: string } }

// err.code is Cursor's backend error name (MODEL_BLOCKED, PRO_USER_USAGE_LIMIT, ...) when the SDK has
// one. The SDK files a bad key under ConfigurationError and a spent plan under RateLimitError, so the
// code decides those before the class does.
const KEY_CODES = new Set(["BAD_API_KEY", "BAD_USER_API_KEY", "unauthenticated"])
const USAGE_LIMIT_CODES = new Set(["FREE_USER_USAGE_LIMIT", "PRO_USER_USAGE_LIMIT"])

function statusFor(err: unknown): number {
  const e = (typeof err === "object" && err !== null ? err : {}) as { message?: unknown; code?: unknown; status?: unknown; syscall?: unknown }
  // a local failure (EACCES writing AGENTS.md says "permission denied") is not Cursor's verdict on the
  // model, and a 403 would mark the model blocked
  if (typeof e.syscall === "string") return 502
  const msg = String(e.message ?? err ?? "")
  const code = typeof e.code === "string" ? e.code : ""
  if (err instanceof AuthenticationError || e.status === 401 || KEY_CODES.has(code) || /invalid user api key/i.test(msg)) return 401
  // 402, not 429: opencode retries a 429, and waiting does not refill a plan's included usage
  if (USAGE_LIMIT_CODES.has(code)) return 402
  if (err instanceof RateLimitError || e.status === 429 || code === "resource_exhausted" || /rate limit/i.test(msg)) return 429
  if (code === "MODEL_BLOCKED" || code === "permission_denied" || /model blocked|permission denied|forbidden/i.test(msg)) return 403
  if (err instanceof ConfigurationError || code === "invalid_argument" || code === "not_found" || /cannot use this model|unknown model/i.test(msg)) return 400
  return 502
}

const ERROR_TYPE: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "insufficient_quota",
  403: "permission_error",
  429: "rate_limit_error",
}

// "try again in 30 seconds" / "resets in 2h": tell opencode how long to wait instead of letting it guess
function retryAfterSeconds(msg: string): number | undefined {
  const m = msg.match(/\b(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/i)
  if (!m) return undefined
  const unit = m[2].toLowerCase()
  const factor = unit === "ms" ? 0.001 : unit.startsWith("s") ? 1 : unit.startsWith("m") ? 60 : 3600
  return Math.max(1, Math.ceil(Number(m[1]) * factor))
}

function errorBody(err: unknown, status = statusFor(err)): ErrorBody {
  const e = (typeof err === "object" && err !== null ? err : {}) as { message?: unknown; code?: unknown }
  return {
    error: {
      message: String(e.message ?? err ?? "unknown error"),
      type: ERROR_TYPE[status] ?? "api_error",
      ...(typeof e.code === "string" ? { code: e.code } : {}),
    },
  }
}

const abortError = () => new DOMException("aborted", "AbortError")
const isAbort = (err: unknown) => (err as { name?: unknown } | null)?.name === "AbortError"

export function isTransient(err: unknown): boolean {
  const e = (typeof err === "object" && err !== null ? err : {}) as { message?: unknown; code?: unknown; status?: unknown; name?: unknown; isRetryable?: unknown }
  if (e.name === "AbortError" || e.code === "ABORT_ERR") return false
  const status = statusFor(err)
  if (status === 429) return true
  if (status === 400 || status === 401 || status === 402 || status === 403 || e.status === 404) return false
  // isRetryable is the backend's own flag; the SDK defaults it to false when none was sent, so only true counts
  if (e.isRetryable === true || err instanceof NetworkError || (typeof e.status === "number" && e.status >= 500)) return true
  return /unavailable|deadline_exceeded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(`${e.code ?? ""} ${e.message ?? ""}`)
}

export async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal, baseDelayMs = 1000, retryable = isTransient): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError()
    try {
      return await fn()
    } catch (err) {
      if (signal?.aborted || isAbort(err)) throw abortError()
      if (attempt >= 2 || !retryable(err)) throw err
      const delay = Math.min(baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5), 30_000)
      await new Promise((r) => {
        const t = setTimeout(r, delay)
        signal?.addEventListener("abort", () => (clearTimeout(t), r(undefined)), { once: true })
      })
    }
  }
}

// ponytail: global semaphore over generating runs; per-session fairness if it ever matters. A run parked
// on tool results gives its slot back, so a parent waiting on a Cursor sub-agent can never starve it.
let maxActive = Number(process.env.OPENCODE_CURSOR_MAX_ACTIVE) || 4
let active = 0
const waiters: (() => void)[] = []

function pump() {
  while (active < maxActive && waiters.length) {
    active++
    waiters.shift()!()
  }
}

// first: a parked run's continuation, whose turn is already under way, jumps the queue
function acquireSlot(signal?: AbortSignal, first = false): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  if (active < maxActive && !waiters.length) {
    active++
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const i = waiters.indexOf(go)
      if (i >= 0) waiters.splice(i, 1)
      reject(abortError())
    }
    const go = () => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    if (first) waiters.unshift(go)
    else waiters.push(go)
  })
}

function releaseSlot() {
  active--
  pump()
}

export function _setMaxActive(n: number) {
  maxActive = n
  pump()
}

export function errorResponse(err: unknown, status = statusFor(err)): Response {
  const body = errorBody(err, status)
  const wait = status === 429 ? retryAfterSeconds(body.error.message) : undefined
  return Response.json(body, { status, ...(wait ? { headers: { "retry-after": String(wait) } } : {}) })
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null, usage?: Usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }
}

function sseResponse(model: string, onCancel: () => void): { response: Response; sink: Sink } {
  const id = `chatcmpl-${randomUUID()}`
  const enc = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      send({ role: "assistant", content: "" })
    },
    cancel() {
      closed = true
      onCancel()
    },
  })
  function frame(payload: unknown) {
    if (closed) return
    controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
  }
  function send(delta: Record<string, unknown>, finish: string | null = null, usage?: Usage) {
    frame(chunk(id, model, delta, finish, usage))
  }
  function close() {
    if (closed) return
    closed = true
    try { controller.close() } catch {}
  }
  function end() {
    if (closed) return
    controller.enqueue(enc.encode("data: [DONE]\n\n"))
    close()
  }
  const sink: Sink = {
    text: (t) => send({ content: t }),
    reasoning: (t) => send({ reasoning_content: t }),
    toolCalls: (calls) =>
      send({
        tool_calls: calls.map((c, index) => ({
          index,
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.argumentsJson },
        })),
      }),
    finish: (reason, usage) => {
      send({}, reason, usage)
      end()
    },
    fail: (err) => {
      frame(errorBody(err))
      close()
    },
    close,
  }
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    }),
    sink,
  }
}

function jsonCollector(model: string, resolve: (r: Response) => void): Sink {
  const id = `chatcmpl-${randomUUID()}`
  let content = ""
  let calls: ToolCallOut[] = []
  return {
    text: (t) => (content += t),
    reasoning: () => {},
    toolCalls: (c) => (calls = calls.concat(c)),
    finish: (reason, usage) =>
      resolve(
        Response.json({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: content || null,
                ...(calls.length
                  ? {
                      tool_calls: calls.map((c2) => ({
                        id: c2.id,
                        type: "function",
                        function: { name: c2.name, arguments: c2.argumentsJson },
                      })),
                    }
                  : {}),
              },
              finish_reason: reason,
            },
          ],
          usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      ),
    fail: (err) => resolve(errorResponse(err)),
    close: () => {},
  }
}

type SessionEntry = { agentId: string; cwd: string; lastUsedAt: number }

type Deferred = { promise: Promise<Response>; resolve: (r: Response) => void; reject: (e: unknown) => void }

function deferred(): Deferred {
  let resolve!: Deferred["resolve"]
  let reject!: Deferred["reject"]
  const promise = new Promise<Response>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Held = {
  agent: SDKAgent
  cwd: string
  apiKey?: string
  model: string
  run: Run | null
  messages: OaMessage[]
  scope?: string
  textAcc: string
  sink: Sink | null
  // reply is settled on the first delta (streaming) or on finish/fail, so a
  // pre-first-byte failure can still become a real HTTP status
  reply: Deferred
  response: Response | null
  opened: boolean
  detachSignal: (() => void) | null
  buffer: { kind: "text" | "reasoning"; t: string }[]
  pendingCalls: ToolCallOut[]
  parked: Map<string, (result: string) => void>
  flushTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  usage?: Usage
  modelCalls: number
  wired: boolean
  done: boolean
  slot: boolean
  // the prompt reached Cursor, so the agent's history moved on (see abortHeld)
  sent: boolean
  // session entry consumed to resume this agent, put back if the turn fails before any output
  restore?: { key: string; entry: SessionEntry }
}

const BATCH_SETTLE_MS = 300
// Backstop only: releaseSession frees a parked run as soon as opencode goes idle on its session, and a
// tool result can legitimately take long (sub-agent, permission prompt, question to the user).
const TOOL_RESULT_TIMEOUT_MS = 2 * 60 * 60 * 1000
const SESSION_TTL_MS = 30 * 60 * 1000
const DISK_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
// ponytail: single-user plugin, small fixed caps; make configurable if ever shared
const MAX_SESSIONS = 8
const SESSION_STORE_DIR = join(homedir(), ".cache", "opencode-cursor-auth")
const SESSION_STORE_PATH = join(SESSION_STORE_DIR, "sessions.json")
const TMP_CWD_PREFIX = join(tmpdir(), "opencode-cursor-")

const sessions = new Map<string, SessionEntry>()
const heldByAgent = new Map<string, Held>()
const agentByToolCallId = new Map<string, string>()
let diskSessions = new Map<string, SessionEntry>()
let sessionsLoaded = false

let notice: ((message: string) => void) | undefined
/** Where user-facing notices go; plugin.ts points this at opencode's toast. */
export function setNotice(fn: (message: string) => void) {
  notice = fn
}

// opencode prices a step as tokens × model.cost and lets no provider report a real cost (only Copilot's),
// and Cursor bills plan-included usage at $0. So charges beyond the plan surface as a notice, from what
// Cursor has billed each agent (cents, as last seen; billing lands a few seconds after a run ends).
const CHARGE_CHECK_DELAY_MS = 10_000
const chargedCents = new Map<string, number>()
let billingUnavailable = false

function checkCharges(agentId: string, apiKey: string | undefined, baselineOnly = false) {
  if (billingUnavailable) return
  Agent.getUsage(agentId, apiKey ? { apiKey } : undefined).then(
    ({ cost }) => {
      if (!cost) return
      const before = chargedCents.get(agentId)
      chargedCents.set(agentId, cost.chargedCents)
      if (baselineOnly || before === undefined || cost.chargedCents <= before) return
      const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`
      const message = `Cursor billed ${dollars(cost.chargedCents - before)} on-demand for the last turn (${dollars(cost.chargedCents)} in this conversation)`
      console.error(`[opencode-cursor-auth] ${message}`)
      notice?.(message)
    },
    (err) => {
      // accounts without billing access answer "[feature_unavailable] ..." every time
      const e = (err ?? {}) as { code?: unknown; message?: unknown }
      if (/feature_unavailable/.test(`${e.code ?? ""} ${e.message ?? ""}`)) billingUnavailable = true
    },
  )
}

// where @cursor/sdk keeps a workspace's agent store and transcripts (its utils/workspace-paths.ts slug)
function cursorProjectDir(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
  return join(process.env.CURSOR_DATA_DIR?.trim() || join(homedir(), ".cursor"), "projects", slug)
}

// ponytail: no orphan sweep, other opencode instances may own those dirs
// Once nothing references a workspace, nothing can resume its agent either: delete the agent (after
// its cancel settles, the SDK refuses while a run is live), Cursor's store and transcript for it, and
// the workspace.
function releaseCwd(cwd: string, agentId?: string, settled?: Promise<unknown>) {
  if (!cwd.startsWith(TMP_CWD_PREFIX)) return
  for (const v of sessions.values()) if (v.cwd === cwd) return
  for (const v of diskSessions.values()) if (v.cwd === cwd) return
  for (const h of heldByAgent.values()) if (h.cwd === cwd) return
  if (agentId) chargedCents.delete(agentId)
  void Promise.resolve(settled)
    .then(() => (agentId ? Agent.delete(agentId, { cwd }) : undefined))
    .catch(() => {})
    .finally(() => {
      for (const dir of [cursorProjectDir(cwd), cwd]) try { rmSync(dir, { recursive: true, force: true }) } catch {}
    })
}

// scope (opencode session id) is folded in so identical histories from
// different sessions (e.g. parallel sub-agents) never share a Cursor agent.
// Tool calls hash by id/name/arguments only: opencode tags the last two messages with
// cache_control for claude-* ids, so the same call serializes differently a turn later.
// With a scope, system text stays out too: it changes on its own (opencode puts today's
// date in it) and reaches the agent through AGENTS.md on every turn anyway.
function hashMessages(messages: OaMessage[], scope?: string): string {
  const norm: unknown[] = messages
    .filter((m) => !scope || m.role !== "system")
    .map((m) => [m.role, textOf(m.content), m.tool_call_id ?? "", (m.tool_calls ?? []).map((c) => [c.id, c.function?.name, c.function?.arguments])])
  if (scope) norm.unshift(["scope", scope])
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex")
}

function collectDiskEntries(): Record<string, SessionEntry> {
  const now = Date.now()
  const entries: Record<string, SessionEntry> = {}
  for (const [k, v] of diskSessions) if (now - v.lastUsedAt <= DISK_SESSION_TTL_MS) entries[k] = v
  return entries
}

async function loadSessions() {
  if (sessionsLoaded) return
  sessionsLoaded = true
  try {
    const raw = JSON.parse(await readFile(SESSION_STORE_PATH, "utf8")) as {
      version?: number
      entries?: Record<string, SessionEntry>
    }
    if (raw.version !== 1 || !raw.entries) return
    const now = Date.now()
    for (const [k, v] of Object.entries(raw.entries)) {
      // disk entries stay out of the 30-min memory map so the memory sweep
      // can't evict a still-valid 7-day entry; lookup falls back to diskSessions
      if (now - v.lastUsedAt <= DISK_SESSION_TTL_MS) diskSessions.set(k, v)
    }
    for (const v of Object.values(raw.entries)) if (now - v.lastUsedAt > DISK_SESSION_TTL_MS) releaseCwd(v.cwd, v.agentId)
  } catch {}
}

let warnedSave = false

// Best effort: a read-only or full cache dir must never fail or hang a request, it only costs resume
// after a restart. Written via rename so a crash mid-write can't leave torn JSON behind.
function saveSessions() {
  const tmp = `${SESSION_STORE_PATH}.${randomUUID()}.tmp`
  try {
    mkdirSync(SESSION_STORE_DIR, { recursive: true })
    const fd = openSync(tmp, "w")
    try {
      writeSync(fd, JSON.stringify({ version: 1, entries: collectDiskEntries() }))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, SESSION_STORE_PATH)
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch {}
    if (!warnedSave) {
      warnedSave = true
      console.error(`[opencode-cursor-auth] could not save ${SESSION_STORE_PATH}, sessions resume only until restart: ${(err as Error).message}`)
    }
  }
}

function sweepSessions(save = true) {
  const now = Date.now()
  const evicted: SessionEntry[] = []
  for (const [k, v] of diskSessions)
    if (now - v.lastUsedAt > DISK_SESSION_TTL_MS) {
      diskSessions.delete(k)
      evicted.push(v)
    }
  for (const [k, v] of sessions)
    if (now - v.lastUsedAt > SESSION_TTL_MS) {
      sessions.delete(k)
      evicted.push(v)
    }
  while (sessions.size > MAX_SESSIONS) {
    let oldestKey = ""
    let oldest = Infinity
    for (const [k, v] of sessions)
      if (v.lastUsedAt < oldest) {
        oldest = v.lastUsedAt
        oldestKey = k
      }
    evicted.push(sessions.get(oldestKey)!)
    sessions.delete(oldestKey)
  }
  for (const v of evicted) releaseCwd(v.cwd, v.agentId)
  if (save) saveSessions()
}

/**
 * Re-key the session under the conversation state the NEXT request will
 * present (current messages + the assistant message we just produced), since
 * session-unaware clients like opencode resend full history every turn.
 */
function rememberSession(held: Held, toolCalls: ToolCallOut[]) {
  const assistant: OaMessage = {
    role: "assistant",
    content: held.textAcc || null,
    ...(toolCalls.length
      ? { tool_calls: toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.argumentsJson } })) }
      : {}),
  }
  rememberState(held, held.messages.concat(assistant))
}

function rememberState(held: Held, messages: OaMessage[]) {
  remember(hashMessages(messages, held.scope), { agentId: held.agent.agentId, cwd: held.cwd, lastUsedAt: Date.now() })
}

// One key per agent: an agent only ever sits at its latest state, so an older key (a parked
// tool-call state, a reverted turn) must not resume it.
function remember(key: string, entry: SessionEntry) {
  for (const map of [sessions, diskSessions]) for (const [k, v] of map) if (v.agentId === entry.agentId && k !== key) map.delete(k)
  const displaced = sessions.get(key) ?? diskSessions.get(key)
  sessions.set(key, entry)
  diskSessions.set(key, entry)
  sweepSessions()
  if (displaced && displaced.cwd !== entry.cwd) releaseCwd(displaced.cwd, displaced.agentId)
}

/**
 * The agent whose last-seen state is a prefix of messages, and the messages it hasn't seen: normally
 * all but the last. Tool results whose run is gone (backstop, Esc, laptop sleep), plus maybe a new
 * user message, resume from the tool-call message they answer, the state that run parked in.
 */
function findSession(messages: OaMessage[], scope?: string): { key: string; entry: SessionEntry; suffix: OaMessage[] } | undefined {
  const at = (n: number) => {
    const key = hashMessages(messages.slice(0, n), scope)
    const entry = sessions.get(key) ?? diskSessions.get(key)
    return entry && { key, entry, suffix: messages.slice(n) }
  }
  const found = at(messages.length - 1)
  if (found) return found
  let i = messages.length - 1
  if (messages[i]?.role === "user") i--
  const lastTool = i
  while (i >= 0 && messages[i].role === "tool") i--
  return i >= 0 && i < lastTool && messages[i].tool_calls?.length ? at(i + 1) : undefined
}

async function syncAgentsMd(cwd: string, messages: OaMessage[]) {
  mkdirSync(cwd, { recursive: true })
  const path = join(cwd, "AGENTS.md")
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join("\n\n")
  if (systemText) await writeFile(path, systemText)
  else if (existsSync(path)) rmSync(path)
}

// A Cursor turn spans every model call of its agent loop (one per tool round trip), and its usage sums
// them, re-counting the whole context each call. opencode reads a step's usage as the context size
// (meter, auto-compaction), so report the per-call average rather than the N-fold sum.
function mapUsage(u?: {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}, modelCalls = 1): Usage | undefined {
  if (!u) return undefined
  const per = (n?: number) => Math.round((n ?? 0) / Math.max(1, modelCalls))
  // Cursor's inputTokens exclude cache reads/writes (its totalTokens adds them); OpenAI's prompt_tokens
  // include them, and opencode derives uncached input as prompt_tokens - cached_tokens
  const prompt = per(u.inputTokens) + per(u.cacheReadTokens) + per(u.cacheWriteTokens)
  const completion = per(u.outputTokens)
  const usage: Usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  if (u.cacheReadTokens) usage.prompt_tokens_details = { cached_tokens: per(u.cacheReadTokens) }
  if (u.reasoningTokens) usage.completion_tokens_details = { reasoning_tokens: per(u.reasoningTokens) }
  return usage
}

// deltas arriving between tool flush and the continuation request get buffered
function emit(held: Held, kind: "text" | "reasoning", t: string) {
  if (held.sink) (kind === "text" ? held.sink.text : held.sink.reasoning)(t)
  else held.buffer.push({ kind, t })
}

function openReply(held: Held) {
  if (held.opened) return
  held.opened = true
  held.restore = undefined
  if (held.response) held.reply.resolve(held.response)
}

function attachSink(held: Held, sink: Sink) {
  held.sink = sink
  if (held.buffer.length) openReply(held)
  for (const b of held.buffer) (b.kind === "text" ? sink.text : sink.reasoning)(b.t)
  held.buffer = []
  // tool calls that arrived after the last segment closed go out on this one
  if (held.pendingCalls.length && !held.flushTimer) held.flushTimer = setTimeout(() => flushToolCalls(held), BATCH_SETTLE_MS)
}

function attachSignal(held: Held, signal: AbortSignal | undefined) {
  held.detachSignal?.()
  held.detachSignal = null
  if (!signal) return
  // listeners never fire on an already-aborted signal (abort during Agent.create/resume)
  if (signal.aborted) return abortHeld(held)
  const onAbort = () => abortHeld(held)
  signal.addEventListener("abort", onAbort, { once: true })
  held.detachSignal = () => signal.removeEventListener("abort", onAbort)
}

function closeAgent(held: Held) {
  try { held.agent.close() } catch {}
}

function teardownHeld(held: Held) {
  held.done = true
  if (held.slot) {
    held.slot = false
    releaseSlot()
  }
  held.detachSignal?.()
  held.detachSignal = null
  if (held.flushTimer) clearTimeout(held.flushTimer)
  if (held.idleTimer) clearTimeout(held.idleTimer)
  for (const id of held.parked.keys()) agentByToolCallId.delete(id)
  heldByAgent.delete(held.agent.agentId)
}

function failHeld(held: Held, err: unknown) {
  if (isAbort(err)) return abortHeld(held)
  teardownHeld(held)
  const cancelled = held.run?.cancel().catch(() => {})
  if (statusFor(err) === 403) markBlocked(held.model)
  if (held.response && !held.opened) {
    held.opened = true
    held.reply.resolve(errorResponse(err))
    held.sink?.close()
  } else {
    held.sink?.fail(err)
  }
  closeAgent(held)
  // the client's retry resends this exact request, so let it resume the same agent
  if (held.restore) remember(held.restore.key, held.restore.entry)
  releaseCwd(held.cwd, held.agent.agentId, cancelled)
}

function abortHeld(held: Held) {
  if (held.done) return
  const parked = !held.sink
  teardownHeld(held)
  const cancelled = held.run?.cancel().catch(() => {})
  closeAgent(held)
  held.sink?.close()
  held.reply.reject(new DOMException("aborted", "AbortError"))
  // Keep the agent resumable from where opencode's history will stand: a parked run keeps its
  // tool-call key; a cancelled segment ends with the text opencode already shows (opencode drops
  // an aborted reply that showed none); a turn that never reached Cursor gets its entry back.
  if (!parked) {
    if (held.sent) rememberState(held, held.textAcc ? held.messages.concat({ role: "assistant", content: held.textAcc }) : held.messages)
    else if (held.restore) remember(held.restore.key, held.restore.entry)
  }
  releaseCwd(held.cwd, held.agent.agentId, cancelled)
}

/** opencode went idle on this session, so a run still parked on its tool results will never get them. */
export function releaseSession(scope: string) {
  for (const held of [...heldByAgent.values()]) if (held.scope === scope && !held.sink) abortHeld(held)
}

/** Model requested tools: emit tool_calls, end this HTTP segment, park the run. */
function flushToolCalls(held: Held) {
  held.flushTimer = null
  // a call that arrives after the segment closed waits for the next one (see attachSink)
  if (held.done || !held.sink || !held.pendingCalls.length) return
  const calls = held.pendingCalls
  held.pendingCalls = []
  for (const c of calls) agentByToolCallId.set(c.id, held.agent.agentId)
  const sink = held.sink
  held.sink = null
  // the parked run outlives this HTTP segment, so its abort signal must not
  // reach it; the continuation request attaches its own
  held.detachSignal?.()
  held.detachSignal = null
  // parked, the run generates nothing until opencode answers
  if (held.slot) {
    held.slot = false
    releaseSlot()
  }
  openReply(held)
  sink.toolCalls(calls)
  sink.finish("tool_calls", held.usage)
  rememberSession(held, calls)
  if (held.idleTimer) clearTimeout(held.idleTimer)
  held.idleTimer = setTimeout(() => abortHeld(held), TOOL_RESULT_TIMEOUT_MS)
  held.idleTimer.unref?.()
}

async function wireRunCompletion(held: Held) {
  if (held.wired || !held.run) return
  held.wired = true
  let result
  try {
    result = await held.run.wait()
  } catch (err) {
    if (!held.done) failHeld(held, err)
    return
  }
  if (held.done) return
  if (result.status === "cancelled") return abortHeld(held)
  if (result.status === "error") return failHeld(held, result.error ?? new Error("cursor run failed"))
  // the last turn's usage is the context opencode should see; result.usage sums every turn of the run
  const usage = held.usage ?? mapUsage(result.usage, held.modelCalls)
  teardownHeld(held)
  rememberSession(held, [])
  openReply(held)
  held.sink?.finish("stop", usage)
  closeAgent(held)
  setTimeout(() => checkCharges(held.agent.agentId, held.apiKey), CHARGE_CHECK_DELAY_MS).unref?.()
}

export function _resetForTest() {
  sessions.clear()
  diskSessions.clear()
  heldByAgent.clear()
  agentByToolCallId.clear()
  sessionsLoaded = false
}

let failAfterFirstDelta: string | null = null
export function _failAfterFirstDelta(message: string | null) {
  failAfterFirstDelta = message
}

export function _stats() {
  return {
    held: heldByAgent.size,
    sessions: sessions.size,
    disk: diskSessions.size,
    agentIds: [...sessions.values()].map((v) => v.agentId).sort(),
    active,
    waiting: waiters.length,
  }
}

export async function handleChatCompletion(body: OaBody, apiKey?: string, signal?: AbortSignal, scope?: string): Promise<Response> {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError")
  ensureQuietConsole()
  await loadSessions()
  const streaming = body.stream !== false
  const reply = deferred()
  let held: Held | undefined
  const sse = streaming ? sseResponse(body.model, () => held && abortHeld(held)) : undefined
  const sink = sse?.sink ?? jsonCollector(body.model, reply.resolve)

  // continuation: trailing tool results for a parked run
  const lastMsg = body.messages[body.messages.length - 1]
  if (lastMsg?.role === "tool" && lastMsg.tool_call_id) {
    const agentId = agentByToolCallId.get(lastMsg.tool_call_id)
    const parked = agentId ? heldByAgent.get(agentId) : undefined
    if (parked && !parked.done) {
      await acquireSlot(signal, true)
      if (parked.done) releaseSlot()
      else {
        held = parked
        held.slot = true
        if (held.idleTimer) clearTimeout(held.idleTimer)
        held.messages = body.messages
        held.textAcc = ""
        held.reply = reply
        held.response = sse?.response ?? null
        held.opened = false
        attachSignal(held, signal)
        if (held.done) return reply.promise
        attachSink(held, sink)
        for (const m of body.messages) {
          if (m.role !== "tool" || !m.tool_call_id) continue
          const resolve = held.parked.get(m.tool_call_id)
          if (resolve) {
            held.parked.delete(m.tool_call_id)
            agentByToolCallId.delete(m.tool_call_id)
            resolve(textOf(m.content))
          }
        }
        return reply.promise
      }
    }
    // the run is gone (backstop, Esc, laptop sleep): a new turn below resumes its agent from the
    // tool-call state it parked in and sends these results as the next message
  }

  // opencode wraps variant options as providerOptions.cursor; @ai-sdk/openai-compatible (name "cursor") spreads them into the body top level
  const model = resolveVariant(body.model, body.cursor_params) ?? { id: body.model }
  if (typeof model === "string") return errorResponse(model, 400)

  // new turn: reuse the agent whose last-seen conversation matches our prefix
  await acquireSlot(signal)
  const found = findSession(body.messages, scope)
  let agent: SDKAgent | undefined
  let cwd: string | undefined
  let newSuffix: OaMessage[] = body.messages
  let restore: Held["restore"]
  const agentOptions = (cwd: string) => ({
    model,
    tools: ["mcp"] as ["mcp"],
    ...(apiKey ? { apiKey } : {}),
    local: { cwd, settingSources: ["project"] as ["project"], enableAgentRetries: true },
  })
  if (found) {
    const { key, entry } = found
    sessions.delete(key)
    diskSessions.delete(key)
    cwd = entry.cwd
    agent = await withRetry(() => Agent.resume(entry.agentId, agentOptions(cwd!)), signal).catch(() => undefined)
    if (signal?.aborted) {
      // nothing reached the agent, so its entry still describes it
      try { agent?.close() } catch {}
      remember(key, entry)
      releaseSlot()
      throw abortError()
    }
    if (agent) {
      newSuffix = found.suffix
      restore = { key, entry }
      if (!chargedCents.has(entry.agentId)) checkCharges(entry.agentId, apiKey, true)
    } else {
      saveSessions()
      releaseCwd(entry.cwd, entry.agentId)
    }
  }
  if (!agent) {
    cwd = await mkdtemp(TMP_CWD_PREFIX)
    try {
      agent = await withRetry(() => Agent.create(agentOptions(cwd!)), signal)
    } catch (err) {
      releaseSlot()
      releaseCwd(cwd)
      if (signal?.aborted || isAbort(err)) throw abortError()
      return errorResponse(err)
    }
    chargedCents.set(agent.agentId, 0)
  }

  held = {
    agent,
    cwd: cwd!,
    apiKey,
    model: body.model,
    run: null,
    messages: body.messages,
    scope,
    textAcc: "",
    sink: null,
    reply,
    response: sse?.response ?? null,
    opened: false,
    detachSignal: null,
    buffer: [],
    pendingCalls: [],
    parked: new Map(),
    flushTimer: null,
    idleTimer: null,
    modelCalls: 0,
    wired: false,
    done: false,
    slot: true,
    sent: false,
    restore,
  }
  const self = held
  heldByAgent.set(agent.agentId, held)
  attachSignal(held, signal)
  if (held.done) return reply.promise
  attachSink(held, sink)

  const customTools: Record<string, unknown> = {}
  for (const t of body.tools ?? []) {
    customTools[t.function.name] = {
      description: t.function.description ?? "",
      inputSchema: t.function.parameters ?? { type: "object", properties: {} },
      execute: (args: unknown, ctx: { toolCallId?: string }) => {
        const id = (ctx.toolCallId ?? `call_${randomUUID()}`).replace(/\s+/g, "_")
        self.pendingCalls.push({ id, name: t.function.name, argumentsJson: JSON.stringify(args ?? {}) })
        if (self.flushTimer) clearTimeout(self.flushTimer)
        self.flushTimer = setTimeout(() => flushToolCalls(self), BATCH_SETTLE_MS)
        return new Promise<string>((resolve) => self.parked.set(id, resolve))
      },
    }
  }

  try {
    await syncAgentsMd(cwd!, body.messages)
  } catch (err) {
    if (!self.done) failHeld(self, err)
    return reply.promise
  }
  if (self.done) return reply.promise
  const prompt =
    newSuffix
      .filter((m) => m.role !== "system")
      .map((m) => (m.role === "user" ? textOf(m.content) : `${m.role.toUpperCase()}: ${textOf(m.content)}`))
      .filter(Boolean)
      .join("\n\n") || "(empty message)"

  const sendOptions = {
    onDelta: ({ update }: { update: { type: string; text?: string; usage?: Parameters<typeof mapUsage>[0] } }) => {
      if (self.done) return
      if (update.type === "text-delta" && update.text) {
        openReply(self)
        self.textAcc += update.text
        emit(self, "text", update.text)
        if (failAfterFirstDelta !== null) {
          const message = failAfterFirstDelta
          failAfterFirstDelta = null
          failHeld(self, new Error(message))
        }
      } else if (update.type === "thinking-delta" && update.text) {
        openReply(self)
        emit(self, "reasoning", update.text)
      } else if (update.type === "tool-requests-listed") {
        // one per model response, tool calls or not
        self.modelCalls++
      } else if (update.type === "turn-ended") {
        self.usage = mapUsage(update.usage, self.modelCalls)
      }
    },
    local: { customTools: customTools as never },
  }
  let run: Run
  try {
    run = await withRetry(() => {
      self.sent = true
      return agent.send(prompt, sendOptions)
    }, signal, 1000, (err) => !self.opened && !self.done && isTransient(err))
  } catch (err) {
    if (!self.done) failHeld(self, err)
    return reply.promise
  }
  if (self.done) {
    run.cancel().catch(() => {})
    return reply.promise
  }
  if (run.agentId !== agent.agentId) console.error(`[opencode-cursor-auth] run.agentId ${run.agentId} != agent.agentId ${agent.agentId}`)
  self.run = run
  void wireRunCompletion(self)

  return reply.promise
}
