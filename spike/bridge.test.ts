// Network-free tests for src/bridge.ts sweep/store hygiene. Run: bun test spike/bridge.test.ts
import { test, expect, mock, afterAll } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import { join } from "node:path"

// Sandbox every path the bridge could touch before it is imported.
const root = mkdtempSync(join(os.tmpdir(), "bridge-test-"))
const HOME = join(root, "home")
const TMP = join(root, "tmp")
const CACHE = join(root, "cache")
for (const d of [HOME, TMP, CACHE]) mkdirSync(d)
const savedEnv = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, CURSOR_DATA_DIR: process.env.CURSOR_DATA_DIR }
Object.assign(process.env, { HOME, TMPDIR: TMP, XDG_CACHE_HOME: CACHE })
delete process.env.CURSOR_DATA_DIR
// Bun caches homedir() at startup and ignores a later $HOME, so mock it
const realOs = { ...os }
mock.module("node:os", () => ({ ...realOs, homedir: () => HOME }))
if ((await import("node:os")).homedir() !== HOME || os.tmpdir() !== TMP) throw new Error("sandbox not in effect, refusing to run")

class AuthenticationError extends Error {}
class Other extends Error {}
const createMock = mock(async () => {
  throw Object.assign(new AuthenticationError("bad key"), { status: 401 })
})
mock.module("@cursor/sdk", () => ({
  Agent: { create: createMock, resume: createMock, delete: async () => {} },
  Cursor: { models: { list: async () => [] } },
  AuthenticationError,
  ConfigurationError: Other,
  NetworkError: Other,
  RateLimitError: Other,
}))

const bridge = await import("../src/bridge.ts")
const DAY = 24 * 60 * 60 * 1000
const slug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
const age = (p: string, days = 15) => {
  const t = new Date(Date.now() - days * DAY)
  utimesSync(p, t, t)
}
const settle = () => new Promise((r) => setTimeout(r, 50))
async function request(b = bridge) {
  b._resetForTest()
  const res = await b.handleChatCompletion({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: false })
  await settle()
  return res
}

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  rmSync(root, { recursive: true, force: true })
})

test("C1: sweep keeps a real project dir that merely ends in -opencode-cursor-xxxxxx", async () => {
  const projects = join(HOME, ".cursor", "projects")
  const real = join(projects, "Users-x-src-opencode-cursor-plugin")
  const orphan = join(projects, slug(join(TMP, "opencode-cursor-ABCDEF")))
  for (const d of [real, orphan]) {
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, "transcript.jsonl"), "{}")
    age(d)
  }
  expect((await request()).status).toBe(401)
  expect(existsSync(join(real, "transcript.jsonl"))).toBe(true)
  expect(existsSync(orphan)).toBe(false)
})

test("C2: null / malformed store entries never poison later requests", async () => {
  const store = join(CACHE, "opencode-cursor-auth", "sessions.json")
  mkdirSync(join(CACHE, "opencode-cursor-auth"), { recursive: true })
  writeFileSync(store, JSON.stringify({ version: 2, entries: { "s:x\u0000main": null, "s:z\u0000main": { cwd: 5 }, "s:y\u0000main": { agentId: "a", cwd: "/nope", prefixHash: "h", lastUsedAt: Date.now() } } }))
  bridge._resetForTest()
  for (let i = 0; i < 2; i++) {
    const res = await bridge.handleChatCompletion({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: false })
    expect(res.status).toBe(401)
  }
  expect(bridge._sessionEntries().map(([k]) => k)).toEqual(["s:y\u0000main"])
})

test("C4: an old workspace-named dir that is not private is not rm'd; a private one is", async () => {
  const ws = join(TMP, "opencode-cursor-ZZZZZZ")
  mkdirSync(ws)
  writeFileSync(join(ws, "keep"), "x")
  chmodSync(ws, 0o755)
  age(ws)
  await request()
  expect(existsSync(join(ws, "keep"))).toBe(true)
  chmodSync(ws, 0o700)
  await request()
  expect(existsSync(ws)).toBe(false)
})

test("C5: backstop never fires past the 2 h hard cap", () => {
  bridge._setIdleTimeoutMs(10_000)
  const now = Date.now()
  const cap = 2 * 60 * 60 * 1000
  expect(bridge._backstopDelay(now, now)).toBe(10_000)
  expect(bridge._backstopDelay(now - (cap - 3_000), now)).toBe(3_000)
  expect(bridge._backstopDelay(now - cap, now)).toBe(0)
  expect(bridge._backstopDelay(now - 3 * cap, now)).toBe(0)
  bridge._setIdleTimeoutMs()
})

test("C7: absolute XDG_CACHE_HOME holds sessions.json, a relative one is ignored", async () => {
  expect(existsSync(join(CACHE, "opencode-cursor-auth", "sessions.json"))).toBe(true)
  expect(existsSync(join(HOME, ".cache", "opencode-cursor-auth"))).toBe(false)
  process.env.XDG_CACHE_HOME = "rel-cache"
  const fresh = (await import("../src/bridge.ts?relative")) as typeof bridge
  await request(fresh)
  process.env.XDG_CACHE_HOME = CACHE
  expect(JSON.parse(readFileSync(join(HOME, ".cache", "opencode-cursor-auth", "sessions.json"), "utf8")).version).toBe(2)
  expect(existsSync("rel-cache")).toBe(false)
})

test("usage limit without a backend code maps to 402, not 502", async () => {
  const limit = new Error("Trial usage limit reached You've reached your trial usage limit. You can keep working with Cursor Models or Auto Mode.")
  const r = bridge.errorResponse(limit)
  expect(r.status).toBe(402)
  expect(((await r.json()) as { error: { type: string } }).error.type).toBe("insufficient_quota")
  expect(bridge.errorResponse(new Error("something else broke")).status).toBe(502)
})
