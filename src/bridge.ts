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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
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
  // the SDK marks aborts isRetryable:true; an abort is never worth retrying
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

// ponytail: global semaphore over generating segments only (a parked run gives its slot back, a
// continuation re-acquires ahead of new turns); per-session fairness if it ever matters
let maxActive = Number(process.env.OPENCODE_CURSOR_MAX_ACTIVE) || 4
let active = 0
const waiters: (() => void)[] = []
const priorityWaiters: (() => void)[] = []

function pump() {
  while (active < maxActive && (priorityWaiters.length || waiters.length)) {
    active++
    ;(priorityWaiters.shift() ?? waiters.shift()!)()
  }
}

function acquireSlot(signal?: AbortSignal, priority = false): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  const queue = priority ? priorityWaiters : waiters
  if (active < maxActive && !priorityWaiters.length && (priority || !waiters.length)) {
    active++
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const i = queue.indexOf(go)
      if (i >= 0) queue.splice(i, 1)
      reject(abortError())
    }
    const go = () => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    queue.push(go)
  })
}

function releaseSlot() {
  active--
  pump()
}

export function _setBatchSettleMs(ms: number) {
  batchSettleMs = ms
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

// lastPrompt: prompt size of the turn that produced this entry
type SessionEntry = { agentId: string; cwd: string; prefixHash: string; lastUsedAt: number; lastPrompt?: number }

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
  model: string
  run: Run | null
  messages: OaMessage[]
  key: string
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
  // tool-requests-listed deltas seen on this run; model calls = calls + 1
  calls: number
  lastPrompt?: number
  wired: boolean
  done: boolean
  slot: boolean
  // a continuation is waiting for its slot; blocks duplicates and idle release
  claimed: boolean
}

let batchSettleMs = 300
const TOOL_RESULT_TIMEOUT_MS = 10 * 60 * 1000
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
// ponytail: single-user plugin, fixed cap; make configurable if ever shared
const MAX_SESSIONS = 256
const SESSION_STORE_DIR = join(homedir(), ".cache", "opencode-cursor-auth")
const SESSION_STORE_PATH = join(SESSION_STORE_DIR, "sessions.json")
const TMP_CWD_PREFIX = join(tmpdir(), "opencode-cursor-")

// key: `s:${opencode session id}\0${agent name}`, or `h:${hashMessages(...)}` when opencode sends no session id
const sessions = new Map<string, SessionEntry>()
const heldByAgent = new Map<string, Held>()
const agentByToolCallId = new Map<string, string>()
let loading: Promise<void> | undefined

// Where @cursor/sdk keeps a workspace's agent store and transcripts. The slug mirrors the SDK's
// utils/workspace-paths; transcripts honour CURSOR_DATA_DIR (used untrimmed, as the SDK does) while the
// agent store always lives under ~/.cursor. Only ever called for our own tmp workspaces (releaseCwd guard).
function cursorProjectDirs(cwd: string): string[] {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
  const dataDir = process.env.CURSOR_DATA_DIR
  const home = join(homedir(), ".cursor")
  return [...new Set([join(dataDir?.trim() ? dataDir : home, "projects", slug), join(home, "projects", slug)])]
}

// a workspace this process could have made with mkdtemp(TMP_CWD_PREFIX), nothing else
const isOwnWorkspace = (cwd: string) =>
  resolve(cwd) === cwd && dirname(cwd) === tmpdir() && /^opencode-cursor-[A-Za-z0-9]{6}$/.test(basename(cwd))

// Once nothing references a workspace, nothing can resume its agent either: delete the agent (after
// its cancel settles, the SDK refuses while a run is live), Cursor's store and transcript for it, and
// the workspace.
function releaseCwd(cwd: string, agentId?: string, settled?: Promise<unknown>) {
  if (!isOwnWorkspace(cwd)) return
  for (const v of sessions.values()) if (v.cwd === cwd) return
  for (const h of heldByAgent.values()) if (h.cwd === cwd) return
  void Promise.resolve(settled)
    .then(() => (agentId ? Agent.delete(agentId, { cwd }) : undefined))
    .catch(() => {})
    .finally(() => {
      for (const dir of [...cursorProjectDirs(cwd), cwd]) try { rmSync(dir, { recursive: true, force: true }) } catch {}
    })
}

// System messages are left out: opencode's system prompt differs per process (skill paths), the
// conversation itself is byte-stable. Tool calls hash by id/name/arguments only: opencode tags the last
// two messages with cache_control for claude-* ids, so the same call serializes differently a turn later.
function hashMessages(messages: OaMessage[]): string {
  const norm = messages
    .filter((m) => m.role !== "system")
    .map((m) => [m.role, textOf(m.content), m.tool_call_id ?? "", (m.tool_calls ?? []).map((c) => [c.id, c.function?.name, c.function?.arguments])])
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex")
}

const loadSessions = () => (loading ??= doLoadSessions())

async function doLoadSessions() {
  try {
    const raw = JSON.parse(await readFile(SESSION_STORE_PATH, "utf8")) as { version?: number; entries?: Record<string, SessionEntry> }
    // v1 (<= 0.3.4) keys hashed the system prompt, so none can match again; its workspaces are left to
    // sweepOrphans rather than released here, an older opencode process may still be using them
    if (raw.version === 2) for (const [k, v] of Object.entries(raw.entries ?? {})) sessions.set(k, v)
  } catch {}
  sweepOrphans()
  sweepSessions()
}

// Workspaces/project dirs no entry references, untouched for SESSION_TTL_MS. Age is the newest of the dir's and
// its AGENTS.md's mtime: any live opencode process (this or another) rewrites AGENTS.md every turn.
function sweepOrphans() {
  const old = (p: string) => {
    try {
      return Date.now() - Math.max(statSync(p).mtimeMs, statSync(join(p, "AGENTS.md"), { throwIfNoEntry: false })?.mtimeMs ?? 0) > SESSION_TTL_MS
    } catch {
      return false
    }
  }
  const live = new Set([...sessions.values(), ...heldByAgent.values()].flatMap((v) => [v.cwd, ...cursorProjectDirs(v.cwd)]))
  try {
    for (const name of readdirSync(tmpdir())) {
      const p = join(tmpdir(), name)
      if (/^opencode-cursor-[A-Za-z0-9]{6}$/.test(name) && !live.has(p) && old(p)) releaseCwd(p)
    }
  } catch {}
  const dataDir = process.env.CURSOR_DATA_DIR
  for (const root of new Set([join(homedir(), ".cursor", "projects"), ...(dataDir?.trim() ? [join(dataDir, "projects")] : [])])) {
    try {
      for (const name of readdirSync(root)) {
        const id = name.match(/-opencode-cursor-([A-Za-z0-9]{6})$/)?.[1]
        const p = join(root, name)
        if (id && !live.has(p) && !existsSync(TMP_CWD_PREFIX + id) && old(p)) rmSync(p, { recursive: true, force: true })
      }
    } catch {}
  }
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
      writeSync(fd, JSON.stringify({ version: 2, entries: Object.fromEntries(sessions) }))
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

function sweepSessions() {
  const now = Date.now()
  const evicted: SessionEntry[] = []
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
  saveSessions()
}

/**
 * Record the conversation state the NEXT request will present (current messages + the assistant
 * message we just produced) as the entry's prefixHash, since opencode resends full history every turn.
 */
function rememberSession(held: Held, toolCalls: ToolCallOut[]) {
  const assistant: OaMessage = {
    role: "assistant",
    content: held.textAcc || null,
    ...(toolCalls.length
      ? { tool_calls: toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.argumentsJson } })) }
      : {}),
  }
  const prefixHash = hashMessages(held.messages.concat(assistant))
  if (held.key.startsWith("h:")) {
    sessions.delete(held.key)
    held.key = `h:${prefixHash}`
  }
  const old = sessions.get(held.key)
  sessions.set(held.key, {
    agentId: held.agent.agentId,
    cwd: held.cwd,
    prefixHash,
    lastUsedAt: Date.now(),
    ...(held.lastPrompt ? { lastPrompt: held.lastPrompt } : {}),
  })
  if (old && old.cwd !== held.cwd) releaseCwd(old.cwd, old.agentId)
  sweepSessions()
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

// turn-ended usage sums every model call in the run (n calls, previous turn's prompt L). Prompts only
// grow within a run, so the last call's prompt is at most S - (n-1)*L: an upper-bound estimate, clamped to [S/n, S].
export function mapUsage(
  u?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number },
  n = 1,
  L = 0,
): Usage | undefined {
  if (!u) return undefined
  const S = u.inputTokens ?? 0
  const prompt = n <= 1 ? S : Math.min(S, Math.max(Math.ceil(S / n), S - (n - 1) * L))
  const completion = u.outputTokens ?? 0
  const usage: Usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  // inputTokens already includes cache; opencode subtracts cached from prompt, so keep it <= prompt
  const cached = Math.min(u.cacheReadTokens ?? 0, prompt)
  if (cached > 0) usage.prompt_tokens_details = { cached_tokens: cached }
  if (u.reasoningTokens) usage.completion_tokens_details = { reasoning_tokens: u.reasoningTokens }
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
  if (held.response) held.reply.resolve(held.response)
}

function attachSink(held: Held, sink: Sink) {
  held.sink = sink
  if (held.buffer.length) openReply(held)
  for (const b of held.buffer) (b.kind === "text" ? sink.text : sink.reasoning)(b.t)
  held.buffer = []
  // a parallel call that missed the previous flush goes out on this segment
  if (held.pendingCalls.length) scheduleFlush(held)
}

function scheduleFlush(held: Held) {
  if (held.flushTimer) clearTimeout(held.flushTimer)
  held.flushTimer = setTimeout(() => flushToolCalls(held), batchSettleMs)
}

function armIdle(held: Held) {
  if (held.idleTimer) clearTimeout(held.idleTimer)
  held.idleTimer = setTimeout(() => abortHeld(held), TOOL_RESULT_TIMEOUT_MS)
  held.idleTimer.unref?.()
}

function releaseHeldSlot(held: Held) {
  if (!held.slot) return
  held.slot = false
  releaseSlot()
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
  releaseHeldSlot(held)
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
  const e = err as { code?: unknown; message?: unknown } | null
  if (e?.code === "MODEL_BLOCKED" || /model blocked/i.test(String(e?.message ?? err))) markBlocked(held.model)
  if (held.response && !held.opened) {
    held.opened = true
    held.reply.resolve(errorResponse(err))
    held.sink?.close()
  } else {
    held.sink?.fail(err)
  }
  closeAgent(held)
  releaseCwd(held.cwd, held.agent.agentId, cancelled)
}

function abortHeld(held: Held) {
  if (held.done) return
  teardownHeld(held)
  const cancelled = held.run?.cancel().catch(() => {})
  closeAgent(held)
  held.sink?.close()
  held.reply.reject(new DOMException("aborted", "AbortError"))
  releaseCwd(held.cwd, held.agent.agentId, cancelled)
}

/** Model requested tools: emit tool_calls, end this HTTP segment, park the run. */
function flushToolCalls(held: Held) {
  held.flushTimer = null
  // no sink: the calls stay pending until the next continuation attaches one
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
  openReply(held)
  sink?.toolCalls(calls)
  sink?.finish("tool_calls")
  rememberSession(held, calls)
  releaseHeldSlot(held)
  armIdle(held)
}

/** opencode session went idle (Esc during a tool call): drop its parked runs now, not in 10 min. */
export function releaseParked(scope: string) {
  for (const held of [...heldByAgent.values()]) {
    if (held.scope === scope && !held.done && !held.sink && !held.claimed) abortHeld(held)
  }
}

/** opencode session deleted: nothing can resume its agents, release them and their workspaces now. */
export function forgetSession(sessionID: string) {
  for (const [k, v] of sessions)
    if (k.startsWith(`s:${sessionID}\u0000`)) {
      sessions.delete(k)
      releaseCwd(v.cwd, v.agentId)
    }
  releaseParked(sessionID)
  saveSessions()
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
  const usage = mapUsage(result.usage, held.calls + 1, held.lastPrompt) ?? held.usage
  if (usage) held.lastPrompt = usage.prompt_tokens
  teardownHeld(held)
  rememberSession(held, [])
  openReply(held)
  held.sink?.finish("stop", usage)
  closeAgent(held)
}

export function _resetForTest() {
  sessions.clear()
  heldByAgent.clear()
  agentByToolCallId.clear()
  loading = undefined
}

export const _sessionEntries = () => [...sessions]

let failAfterFirstDelta: string | null = null
export function _failAfterFirstDelta(message: string | null) {
  failAfterFirstDelta = message
}

export function _stats() {
  return {
    held: heldByAgent.size,
    sessions: sessions.size,
    agentIds: [...sessions.values()].map((v) => v.agentId).sort(),
    active,
    waiting: waiters.length + priorityWaiters.length,
  }
}

export async function handleChatCompletion(body: OaBody, apiKey?: string, signal?: AbortSignal, scope?: string, agentName?: string): Promise<Response> {
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
  let replay = false
  const parked = lastMsg?.role === "tool" && lastMsg.tool_call_id ? heldByAgent.get(agentByToolCallId.get(lastMsg.tool_call_id) ?? "") : undefined
  if (parked && !parked.done && (parked.sink || parked.claimed)) {
    return Response.json(
      { error: { message: "continuation already in progress for this tool call", type: "invalid_request_error", code: "continuation_in_progress" } },
      { status: 409 },
    )
  }
  if (parked && !parked.done) {
    held = parked
    held.claimed = true
    if (held.idleTimer) clearTimeout(held.idleTimer)
    try {
      await acquireSlot(signal, true)
    } catch (err) {
      held.claimed = false
      if (!held.done) armIdle(held)
      throw err
    }
    held.claimed = false
    if (held.done) {
      // torn down while queued (run failed): replay as a fresh turn below
      releaseSlot()
      held = undefined
      replay = true
    } else held.slot = true
  } else if (lastMsg?.role === "tool") replay = true
  if (held) {
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

  // opencode wraps variant options as providerOptions.cursor; @ai-sdk/openai-compatible (name "cursor") spreads them into the body top level
  const model = resolveVariant(body.model, body.cursor_params) ?? { id: body.model }
  if (typeof model === "string") return errorResponse(model, 400)

  // new turn: reuse this session's agent if its last-seen conversation is our prefix
  const prefixHash = hashMessages(body.messages.slice(0, -1))
  const key = scope ? `s:${scope}\u0000${agentName ?? ""}` : `h:${prefixHash}`
  await acquireSlot(signal)
  // expired tool call: its run is gone, so a fresh agent gets the whole history (tool results included).
  // A prefix mismatch means history was edited or compacted: same thing.
  let entry = sessions.get(key)
  if (entry && (replay || entry.prefixHash !== prefixHash)) {
    sessions.delete(key)
    saveSessions()
    releaseCwd(entry.cwd, entry.agentId)
    entry = undefined
  }
  let agent: SDKAgent | undefined
  let cwd: string | undefined
  let newSuffix: OaMessage[] = body.messages
  const lastPrompt = entry?.lastPrompt
  const agentOptions = (cwd: string) => ({
    model,
    tools: ["mcp"] as ["mcp"],
    ...(apiKey ? { apiKey } : {}),
    local: { cwd, settingSources: ["project"] as ["project"], enableAgentRetries: true },
  })
  if (entry) {
    const e = entry
    try {
      agent = await withRetry(() => Agent.resume(e.agentId, agentOptions(e.cwd)), signal)
      cwd = e.cwd
      newSuffix = body.messages.slice(-1)
    } catch (err) {
      // aborted, bad key or rate limited: the agent is fine, keep the entry for the next attempt
      if (signal?.aborted || isAbort(err)) {
        releaseSlot()
        throw abortError()
      }
      const status = statusFor(err)
      if (status === 401 || status === 429) {
        releaseSlot()
        return errorResponse(err, status)
      }
    }
    sessions.delete(key)
    saveSessions()
    if (!agent) releaseCwd(e.cwd, e.agentId)
  }
  if (!agent) {
    try {
      cwd = await mkdtemp(TMP_CWD_PREFIX)
      agent = await withRetry(() => Agent.create(agentOptions(cwd!)), signal)
    } catch (err) {
      releaseSlot()
      if (cwd) releaseCwd(cwd)
      if (signal?.aborted || isAbort(err)) throw abortError()
      return errorResponse(err)
    }
  }

  held = {
    agent,
    cwd: cwd!,
    model: body.model,
    run: null,
    messages: body.messages,
    key,
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
    calls: 0,
    lastPrompt,
    wired: false,
    done: false,
    slot: true,
    claimed: false,
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
        if (self.sink) scheduleFlush(self)
        return new Promise<string>((resolve) => self.parked.set(id, resolve))
      },
    }
  }

  try {
    await syncAgentsMd(cwd!, body.messages)
  } catch (err) {
    // through failHeld so the slot, the held run and the workspace are released
    if (!self.done) failHeld(self, err)
    return reply.promise
  }
  if (self.done) return reply.promise
  const toolNames = new Map(newSuffix.flatMap((m) => (m.tool_calls ?? []).map((c) => [c.id, c.function?.name] as const)))
  const prompt =
    newSuffix
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (m.role === "user") return textOf(m.content)
        if (m.role === "tool") return `TOOL(${toolNames.get(m.tool_call_id ?? "") ?? m.tool_call_id}): ${textOf(m.content)}`
        const calls = (m.tool_calls ?? []).map((c) => `\n[already called ${c.function?.name}(${c.function?.arguments ?? ""})]`).join("")
        return `${m.role.toUpperCase()}: ${textOf(m.content)}${calls}`
      })
      .filter(Boolean)
      .concat(newSuffix.at(-1)?.role === "tool" ? ["(The tool calls above already ran and their results are shown. Do not call them again; continue from these results.)"] : [])
      .join("\n\n") || "(empty message)"

  let run: Run
  try {
    run = await withRetry(() => agent.send(prompt, {
      onDelta: ({ update }: { update: { type: string; text?: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number } } }) => {
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
          // ponytail: empirical (6/6 live probes), model calls = listed + 1; no per-step usage event exists
          self.calls++
        } else if (update.type === "turn-ended") {
          self.usage = mapUsage(update.usage, self.calls + 1, self.lastPrompt)
        }
      },
      local: { customTools: customTools as never },
    }), signal, 1000, (err) => !self.opened && !self.done && isTransient(err))
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
