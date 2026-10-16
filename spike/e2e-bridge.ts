/**
 * E2E driver for the bridge: simulates the exact requests opencode sends.
 * Test 1: plain streaming chat. Test 2: tool loop (request -> tool_calls ->
 * follow-up request with tool result -> final answer on the SAME cursor run).
 */
import { _failAfterFirstDelta, _resetForTest, _sessionEntries, _setBatchSettleMs, _setMaxActive, _stats, forgetSession, handleChatCompletion, isTransient, mapUsage, releaseParked, withRetry } from "../src/bridge.js";
import { currentModels, resolveModel, resolveVariant } from "../src/models.js";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const runId = Math.random().toString(36).slice(2, 8);

rmSync(join(homedir(), ".cache", "opencode-cursor-auth", "models.json"), { force: true });

async function readSse(res: Response): Promise<{ content: string; reasoning: string; toolCalls: { id: string; name: string; args: string }[]; finish: string | null }> {
  const text = await res.text();
  let content = "";
  let reasoning = "";
  let finish: string | null = null;
  const toolCalls: { id: string; name: string; args: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const chunk = JSON.parse(line.slice(6));
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.content) content += choice.delta.content;
    if (choice.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
    for (const tc of choice.delta?.tool_calls ?? []) {
      toolCalls.push({ id: tc.id, name: tc.function?.name, args: tc.function?.arguments });
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  return { content, reasoning, toolCalls, finish };
}

// --- Test 0: plugin entry exposes exactly one export ---
// opencode calls every named export of a plugin module as a plugin; a stray helper export crashes opencode at startup on a fresh machine
console.log("=== Test 0: plugin entry exports ===");
const entryExports = Object.keys(await import("../src/index.js"));
console.log("exports:", entryExports);
if (entryExports.length !== 1 || entryExports[0] !== "default") throw new Error(`Test 0 FAILED: src/index.ts must export only default, got ${entryExports}`);

// --- Test 1: plain chat, streaming ---
console.log("\n=== Test 1: plain streaming chat ===");
const messages1 = [
  { role: "system", content: "You are a terse assistant. Reply in one short sentence." },
  { role: "user", content: "Say BRIDGE-OK and nothing else." },
];
const res1 = await handleChatCompletion({ model: "gpt-5.5", messages: messages1 as never, stream: true });
const out1 = await readSse(res1);
console.log("content:", JSON.stringify(out1.content));
console.log("reasoning chars:", out1.reasoning.length, "| finish:", out1.finish);
if (!out1.content.includes("BRIDGE-OK")) throw new Error("Test 1 FAILED: no BRIDGE-OK");

// --- Test 2: tool loop ---
console.log("\n=== Test 2: tool loop ===");
const tools = [
  {
    type: "function",
    function: {
      name: "get_secret_number",
      description: "Returns the secret number for a given label.",
      parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
    },
  },
];
const messages2: Record<string, unknown>[] = [
  { role: "system", content: "You must use tools when relevant." },
  { role: "user", content: "Call get_secret_number with label 'alpha', then tell me the number you got." },
];
const res2 = await handleChatCompletion({ model: "gpt-5.5", messages: messages2 as never, tools: tools as never, stream: true });
const out2 = await readSse(res2);
console.log("turn 1 finish:", out2.finish, "| tool calls:", JSON.stringify(out2.toolCalls));
if (out2.finish !== "tool_calls" || out2.toolCalls.length === 0) throw new Error("Test 2 FAILED: no tool_calls turn");

// Simulate opencode sending back the tool result (full history replay)
const tc = out2.toolCalls[0];
messages2.push({
  role: "assistant",
  content: out2.content || null,
  tool_calls: [{ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } }],
});
messages2.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ secret_number: 7741 }) });

const res3 = await handleChatCompletion({ model: "gpt-5.5", messages: messages2 as never, tools: tools as never, stream: true });
const out3 = await readSse(res3);
console.log("turn 2 content:", JSON.stringify(out3.content));
console.log("turn 2 finish:", out3.finish);
if (!out3.content.includes("7741")) throw new Error("Test 2 FAILED: final answer missing 7741");

// --- Test 3: resume path (new turn, prefix matches remembered session -> Agent.resume) ---
console.log("\n=== Test 3: session resume ===");
messages2.push({ role: "assistant", content: out3.content });
messages2.push({ role: "user", content: "What was the secret number again? Reply with just the number." });
const res4 = await handleChatCompletion({ model: "gpt-5.5", messages: messages2 as never, tools: tools as never, stream: true });
const out4 = await readSse(res4);
console.log("turn 3 content:", JSON.stringify(out4.content), "| finish:", out4.finish);
if (!out4.content.includes("7741")) throw new Error("Test 3 FAILED: resumed agent lost context");

// --- Test 4: system prompt via AGENTS.md ---
console.log("\n=== Test 4: AGENTS.md system prompt ===");
const messages4 = [
  { role: "system", content: "You are TEST-BOT. End every reply with the token ZEBRA-99." },
  { role: "user", content: "Say hello in three words." },
];
const res5 = await handleChatCompletion({ model: "gpt-5.5", messages: messages4 as never, stream: true });
const out5 = await readSse(res5);
console.log("content:", JSON.stringify(out5.content), "| finish:", out5.finish);
if (!out5.content.includes("ZEBRA-99")) throw new Error("Test 4 FAILED: system prompt was not honored via AGENTS.md");

// --- Test 5: disk-backed resume after in-memory reset ---
console.log("\n=== Test 5: disk session resume ===");
messages2.push({ role: "assistant", content: out4.content });
_resetForTest();
messages2.push({ role: "user", content: "What was the secret number again? Just the number." });
const res6 = await handleChatCompletion({ model: "gpt-5.5", messages: messages2 as never, tools: tools as never, stream: true });
const out6 = await readSse(res6);
console.log("turn 4 content:", JSON.stringify(out6.content), "| finish:", out6.finish);
if (!out6.content.includes("7741")) throw new Error("Test 5 FAILED: disk-resumed agent lost context");

// --- Test 6: abort mid-stream tears down run + agent process ---
console.log("\n=== Test 6: abort mid-stream ===");
const ac = new AbortController();
const res7 = await handleChatCompletion(
  { model: "gpt-5.5", messages: [{ role: "user", content: "Count from 1 to 400, one number per line." }] as never, stream: true },
  undefined,
  ac.signal,
);
const reader = res7.body!.getReader();
const dec = new TextDecoder();
let aborted = false;
let chunks = 0;
const t0 = Date.now();
const drained = (async () => {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    chunks++;
    if (!aborted && dec.decode(value).includes('"content":"') && !dec.decode(value).includes('"content":""')) {
      aborted = true;
      ac.abort();
    }
  }
})();
await Promise.race([drained, new Promise((_, rej) => setTimeout(() => rej(new Error("Test 6 FAILED: stream did not end within 5s")), 5000))]);
console.log("stream ended after", Date.now() - t0, "ms |", chunks, "chunks | aborted:", aborted);
if (!aborted) throw new Error("Test 6 FAILED: never saw a content delta");
await new Promise((r) => setTimeout(r, 1500));
const stats = _stats();
console.log("stats:", JSON.stringify(stats));
if (stats.held !== 0) throw new Error("Test 6 FAILED: held run leaked");
const procs = new TextDecoder()
  .decode(Bun.spawnSync(["pgrep", "-fl", "cursor-agent"]).stdout)
  .split("\n")
  .filter((l) => l && !l.includes("worker-server"));
console.log("cursor-agent procs (non worker-server):", procs.length ? procs : "none");
if (procs.length) throw new Error("Test 6 FAILED: stray cursor-agent process after abort");
const res8 = await handleChatCompletion({ model: "gpt-5.5", messages: messages1 as never, stream: true });
const out8 = await readSse(res8);
console.log("post-abort content:", JSON.stringify(out8.content), "| finish:", out8.finish);
if (!out8.content.includes("BRIDGE-OK")) throw new Error("Test 6 FAILED: bridge unusable after abort");

// --- Test 7: auth error -> real HTTP status ---
console.log("\n=== Test 7: auth error status ===");
const res9 = await handleChatCompletion({ model: "gpt-5.5", messages: messages1 as never, stream: true }, "crsr_definitely_invalid_key");
const body9 = await res9.json();
console.log("status:", res9.status, "| body:", JSON.stringify(body9));
if (res9.status !== 401 || !body9?.error?.message) throw new Error("Test 7 FAILED: expected 401 with error.message");

console.log("\n=== Test 7b: bogus model ===");
const res10 = await handleChatCompletion({ model: "definitely-not-a-model", messages: messages1 as never, stream: true });
console.log("status:", res10.status, "| body:", (await res10.text()).slice(0, 160));
if (res10.status === 200) console.log("(Cursor accepted the bogus model; skipping assertion)");
else if (res10.status !== 400) throw new Error("Test 7b FAILED: expected 400 for unknown model");

// --- Test 8: scoped sessions do not collide ---
console.log("\n=== Test 8: scoped sessions do not collide ===");
const scopes = [`ses_test_A_${runId}`, `ses_test_B_${runId}`];
const messages8 = [
  { role: "system", content: "You are a terse bot. Reply with exactly the single word PING and nothing else." },
  { role: "user", content: "Say the word." },
];
const before8 = new Set(_stats().agentIds);
const turn1 = await Promise.all(
  scopes.map((s) => handleChatCompletion({ model: "gpt-5.5", messages: messages8 as never, stream: true }, undefined, undefined, s).then(readSse)),
);
console.log("turn 1 replies:", JSON.stringify(turn1.map((o) => o.content)));
const after8 = _stats().agentIds;
const new8 = after8.filter((id) => !before8.has(id));
console.log("new agentIds:", JSON.stringify(new8));
if (new8.length !== 2)
  throw new Error(`Test 8 FAILED: expected 2 new session agents, got ${new8.length} (without scoping identical replies collapse both into one entry)`);
const turn2 = await Promise.all(
  scopes.map((s, i) =>
    handleChatCompletion(
      {
        model: "gpt-5.5",
        messages: [...messages8, { role: "assistant", content: turn1[i].content }, { role: "user", content: "Say it once more." }] as never,
        stream: true,
      },
      undefined,
      undefined,
      s,
    ).then(readSse),
  ),
);
console.log("turn 2 replies:", JSON.stringify(turn2.map((o) => o.content)));
if (turn2.some((o) => !o.content)) throw new Error("Test 8 FAILED: empty turn 2 reply");
const final8 = new Set(_stats().agentIds);
if (final8.size !== before8.size + 2 || !new8.every((id) => final8.has(id)))
  throw new Error(`Test 8 FAILED: expected both scopes to resume their own agent, got ${JSON.stringify([...final8])}`);
console.log("stats:", JSON.stringify(_stats()));

// --- Test 9: model limits + key check (no network beyond the cached catalog) ---
console.log("\n=== Test 9: model limits + key check ===");
const { CursorAuthPlugin, parseContext, keyProblem } = await import("../src/plugin.js");
const item = (value?: string) => ({ id: "m", displayName: "M", parameters: value ? [{ id: "context", values: [{ value }] }] : [] });
const ctxCases: [string | undefined, number | undefined][] = [["272k", 272000], ["1m", 1000000], ["200K", 200000], [undefined, undefined]];
for (const [input, expected] of ctxCases) {
  const got = parseContext(item(input));
  if (got !== expected) throw new Error(`Test 9 FAILED: parseContext(${input}) = ${got}, expected ${expected}`);
}
const now = Date.now();
const missing = keyProblem({ status: "logged-out" }, now);
const expired = keyProblem({ status: "logged-in", backendUrl: "x", apiKeyExpiresAtMs: now - 1 }, now);
const valid = keyProblem({ status: "logged-in", backendUrl: "x", apiKeyExpiresAtMs: now + 1e9 }, now);
if (!missing?.includes("missing")) throw new Error(`Test 9 FAILED: logged-out -> ${missing}`);
if (!expired?.includes("expired")) throw new Error(`Test 9 FAILED: expired -> ${expired}`);
if (valid !== undefined) throw new Error(`Test 9 FAILED: valid key -> ${valid}`);
console.log("keyProblem(missing):", missing);
console.log("keyProblem(expired):", expired);
const hooks = await CursorAuthPlugin({} as never);
const cfg: Record<string, unknown> = {};
await hooks.config!(cfg as never);
const models9 = (cfg as { provider: { cursor: { models: Record<string, { limit?: { context: number; output: number } }> } } }).provider.cursor.models;
const gpt = models9["gpt-5.5"]?.limit;
const auto = models9["auto"]?.limit;
console.log("gpt-5.5 limit:", JSON.stringify(gpt), "| auto limit:", JSON.stringify(auto), "| models:", Object.keys(models9).length);
if (gpt?.context !== 1_000_000 || gpt?.output !== 32000) throw new Error(`Test 9 FAILED: gpt-5.5 limit ${JSON.stringify(gpt)}`);
if (!(typeof auto?.context === "number" && auto.context > 0)) throw new Error(`Test 9 FAILED: auto limit ${JSON.stringify(auto)}`);

// --- Test 10: model variants (opencode Ctrl+T) ---
console.log("\n=== Test 10: variants ===");
type Cfg10 = Record<string, { variants?: Record<string, { cursor_params: { id: string; value: string }[] }> }>;
const models10 = models9 as Cfg10;
const ids10 = Object.keys(models10);
console.log("total model ids:", ids10.length);
if (ids10.length > 60 || ids10.length < 40) throw new Error(`Test 10 FAILED: ${ids10.length} model ids`);
for (const base of ["gpt-5.5", "claude-opus-5", "grok-4.7"]) console.log(base, "variants:", JSON.stringify(Object.keys(models10[base]?.variants ?? {})));
const gptV = models10["gpt-5.5"]?.variants ?? {};
if (Object.keys(gptV).length < 5) throw new Error("Test 10 FAILED: gpt-5.5 has < 5 variants");
if (!gptV["low"] || !gptV["272k-none"]) throw new Error("Test 10 FAILED: gpt-5.5 missing low / 272k-none");
if (!models10["claude-opus-5"]?.variants?.["no-thinking"]) throw new Error("Test 10 FAILED: claude-opus-5 missing no-thinking");
const base10 = resolveModel("gpt-5.5");
console.log("resolveModel(gpt-5.5):", JSON.stringify(base10));
if (base10?.id !== "gpt-5.5" || !base10.params?.some((p) => p.id === "reasoning" && p.value === "medium")) throw new Error("Test 10 FAILED: base resolve");
const low10 = resolveVariant("gpt-5.5", gptV["low"].cursor_params);
console.log("resolveVariant(gpt-5.5, low):", JSON.stringify(low10));
if (typeof low10 !== "object" || !low10.params?.some((p) => p.id === "reasoning" && p.value === "low")) throw new Error("Test 10 FAILED: low variant resolve");
if (typeof resolveVariant("gpt-5.5", [{ id: "reasoning", value: "ultra" }]) !== "string") throw new Error("Test 10 FAILED: bad param accepted");
if (resolveModel("gpt-5.5-low") !== undefined) throw new Error("Test 10 FAILED: suffixed id still resolves");
if (resolveModel("nope") !== undefined) throw new Error("Test 10 FAILED: unknown id resolved");
const out10 = await readSse(
  await handleChatCompletion({ model: "gpt-5.5", cursor_params: gptV["low"].cursor_params, messages: [{ role: "user", content: "Reply with exactly the word VARIANT-OK." }] as never, stream: true }),
);
console.log("content:", JSON.stringify(out10.content), "| finish:", out10.finish);
if (out10.finish !== "stop" || !out10.content) throw new Error("Test 10 FAILED: variant chat");
const bad10 = await handleChatCompletion({ model: "gpt-5.5", cursor_params: [{ id: "reasoning", value: "ultra" }], messages: [{ role: "user", content: "x" }] as never, stream: true });
console.log("bad variant:", bad10.status, await bad10.text(), "| active:", _stats().active);
if (bad10.status !== 400 || _stats().active !== 0) throw new Error("Test 10 FAILED: bad variant must be 400 with no slot taken");

// --- Test 11: concurrency cap ---
console.log("\n=== Test 11: concurrency cap ===");
_setMaxActive(1);
let maxActive11 = 0;
let maxWaiting11 = 0;
const sampler = setInterval(() => {
  const st = _stats();
  maxActive11 = Math.max(maxActive11, st.active);
  maxWaiting11 = Math.max(maxWaiting11, st.waiting);
}, 50);
const outs11 = await Promise.all(
  [1, 2, 3].map((i) =>
    handleChatCompletion(
      { model: "gpt-5.5", messages: [{ role: "user", content: "Reply with exactly the word CAP-OK." }] as never, stream: true },
      undefined,
      undefined,
      `ses_cap_${i}`,
    ).then(readSse),
  ),
);
clearInterval(sampler);
_setMaxActive(4);
console.log("replies:", JSON.stringify(outs11.map((o) => o.content)), "| max active:", maxActive11, "| max waiting:", maxWaiting11);
if (maxActive11 > 1 || maxWaiting11 < 1) throw new Error("Test 11 FAILED: cap not enforced");
if (outs11.some((o) => !o.content)) throw new Error("Test 11 FAILED: empty reply");

// --- Test 12: retry (no network) ---
console.log("\n=== Test 12: retry ===");
let calls12 = 0;
const ok12 = await withRetry(async () => {
  if (++calls12 < 3) throw { status: 429, message: "rate" };
  return "ok";
}, undefined, 1);
if (ok12 !== "ok" || calls12 !== 3) throw new Error(`Test 12 FAILED: 429 retry -> ${ok12} after ${calls12}`);
let calls12b = 0;
const err12b = await withRetry(async () => { calls12b++; throw { status: 401 }; }, undefined, 1).catch((e) => e);
if (err12b?.status !== 401 || calls12b !== 1) throw new Error(`Test 12 FAILED: 401 -> ${calls12b} calls`);
let calls12c = 0;
const ac12 = new AbortController();
ac12.abort();
const err12c = await withRetry(async () => { calls12c++; return "x"; }, ac12.signal, 1).catch((e) => e);
if (err12c?.name !== "AbortError" || calls12c !== 0) throw new Error(`Test 12 FAILED: aborted -> ${err12c} after ${calls12c}`);
if (!isTransient(new Error("fetch failed")) || isTransient({ status: 400 })) throw new Error("Test 12 FAILED: isTransient");
console.log("429 x2 -> ok after", calls12, "calls | 401 ->", calls12b, "call | aborted ->", calls12c, "calls");

// --- Test 13: blocked model -> 403 and hidden from the list ---
console.log("\n=== Test 13: blocked model ===");
const blockedId = "claude-fable-5-1";
const res13 = await handleChatCompletion({ model: blockedId, messages: [{ role: "user", content: "Reply with exactly: FABLE-OK" }] as never, stream: true }, undefined, undefined, "ses_blocked");
if (res13.status === 200) {
  await res13.text();
  console.log("(this account can use", blockedId, "- skipping blocked-model assertions)");
} else {
  const body13 = await res13.json();
  console.log("status:", res13.status, "| body:", JSON.stringify(body13));
  if (res13.status !== 403 || body13?.error?.type !== "permission_error" || !/blocked/i.test(body13?.error?.message ?? "")) throw new Error("Test 13 FAILED: expected 403 permission_error mentioning blocked");
  const listed = Object.keys(await currentModels());
  const leaked = listed.filter((id) => id === blockedId || id.startsWith(blockedId + "-"));
  console.log("listed ids for", blockedId, "after block:", leaked.length, "| still resolvable:", !!resolveModel(blockedId));
  if (leaked.length) throw new Error(`Test 13 FAILED: blocked model still listed: ${leaked.slice(0, 3)}`);
  if (!resolveModel(blockedId)) throw new Error("Test 13 FAILED: blocked model must still resolve for explicit use");
}

const strayProcs = () =>
  new TextDecoder()
    .decode(Bun.spawnSync(["pgrep", "-fl", "cursor-agent"]).stdout)
    .split("\n")
    .filter((l) => l && !l.includes("worker-server"));

async function assertClean(label: string) {
  await new Promise((r) => setTimeout(r, 1500));
  const st = _stats();
  const procs = strayProcs();
  console.log("stats:", JSON.stringify(st), "| cursor-agent procs (non worker-server):", procs.length ? procs : "none");
  if (st.active !== 0 || st.held !== 0 || st.waiting !== 0) throw new Error(`${label} FAILED: leaked slot/held/waiter`);
  if (procs.length) throw new Error(`${label} FAILED: stray cursor-agent process`);
}

async function assertBridgeOk(label: string) {
  const r = await handleChatCompletion({ model: "gpt-5.5", messages: [{ role: "user", content: "Reply with exactly: BRIDGE-OK" }] as never, stream: true });
  const raw = await r.text();
  const out = await readSse(new Response(raw));
  console.log("follow-up status:", r.status, "| content:", JSON.stringify(out.content), "| [DONE]:", raw.includes("data: [DONE]"));
  if (r.status !== 200 || !out.content.includes("BRIDGE-OK") || !raw.includes("data: [DONE]")) throw new Error(`${label} FAILED: bridge unusable afterwards`);
}

// --- Test 14: abort before first byte -> AbortError, not 502 ---
console.log("\n=== Test 14: abort before first byte ===");
for (const ms of [15, 400]) {
  const ac14 = new AbortController();
  const p14 = handleChatCompletion(
    { model: "gpt-5.5", messages: [{ role: "user", content: "Count slowly from 1 to 200." }] as never },
    undefined,
    ac14.signal,
    "ses_test_abort_pre",
  );
  setTimeout(() => ac14.abort(), ms);
  const t14 = Date.now();
  try {
    const r14 = await p14;
    if (ms === 15) throw new Error(`Test 14 FAILED: resolved with status ${r14.status}: ${(await r14.text()).slice(0, 200)}`);
    if (r14.status !== 200) throw new Error(`Test 14 FAILED (${ms}ms): resolved with status ${r14.status}: ${(await r14.text()).slice(0, 200)}`);
    await Promise.race([r14.text(), new Promise((_, rej) => setTimeout(() => rej(new Error(`Test 14 FAILED (${ms}ms): stream did not end within 5s`)), 5000))]);
    console.log(`abort@${ms}ms: first byte won -> stream ended after`, Date.now() - t14, "ms");
  } catch (err) {
    if ((err as Error)?.message?.startsWith("Test 14 FAILED")) throw err;
    console.log(`abort@${ms}ms: rejected with`, (err as Error)?.name, "after", Date.now() - t14, "ms");
    if ((err as Error)?.name !== "AbortError") throw new Error(`Test 14 FAILED: expected AbortError, got ${err}`);
  }
  await assertClean("Test 14");
}
await assertBridgeOk("Test 14");

// --- Test 15: mid-stream failure -> SSE error frame, no [DONE] ---
console.log("\n=== Test 15: mid-stream failure emits error frame ===");
_failAfterFirstDelta("injected failure");
const res15 = await handleChatCompletion({ model: "gpt-5.5", messages: [{ role: "user", content: "Write three short sentences about the sea." }] as never, stream: true });
if (res15.status !== 200) throw new Error(`Test 15 FAILED: status ${res15.status}`);
const reader15 = res15.body!.getReader();
const dec15 = new TextDecoder();
let raw15 = "";
let errorAt = 0;
await Promise.race([
  (async () => {
    for (;;) {
      const { done, value } = await reader15.read();
      if (done) return;
      raw15 += dec15.decode(value, { stream: true });
      if (!errorAt && raw15.includes('"error"')) errorAt = Date.now();
    }
  })(),
  new Promise((_, rej) => setTimeout(() => rej(new Error("Test 15 FAILED: stream did not end within 60s")), 60_000)),
]);
const endedAfterError = errorAt ? Date.now() - errorAt : -1;
const frames15 = raw15.split("\n").filter((l) => l.startsWith("data: "));
const errFrames = frames15.filter((l) => l !== "data: [DONE]" && JSON.parse(l.slice(6)).error);
const errIdx = frames15.indexOf(errFrames[0]);
const contentBefore = frames15.slice(0, errIdx).some((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content);
console.log("frames:", frames15.length, "| error frame:", errFrames[0], "| content before:", contentBefore, "| ended", endedAfterError, "ms after error");
if (!contentBefore) throw new Error("Test 15 FAILED: no content delta before error");
if (errFrames.length !== 1) throw new Error(`Test 15 FAILED: expected exactly 1 error frame, got ${errFrames.length}`);
const err15 = JSON.parse(errFrames[0].slice(6)).error;
if (!String(err15.message).includes("injected failure") || typeof err15.type !== "string") throw new Error(`Test 15 FAILED: bad error frame ${errFrames[0]}`);
if (raw15.includes("data: [DONE]")) throw new Error("Test 15 FAILED: [DONE] after error");
if (endedAfterError < 0 || endedAfterError > 5000) throw new Error(`Test 15 FAILED: stream ended ${endedAfterError}ms after error`);
await assertClean("Test 15");
await assertBridgeOk("Test 15");

async function park(scope: string, prompt = "Call get_secret_number with label 'alpha', then tell me the number you got.") {
  const messages: Record<string, unknown>[] = [
    { role: "system", content: "You must use tools when relevant." },
    { role: "user", content: prompt },
  ];
  const out = await readSse(await handleChatCompletion({ model: "gpt-5.5", messages: messages as never, tools: tools as never, stream: true }, undefined, undefined, scope));
  if (out.finish !== "tool_calls" || !out.toolCalls.length) throw new Error(`park(${scope}) FAILED: no tool_calls turn`);
  messages.push({
    role: "assistant",
    content: out.content || null,
    tool_calls: out.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
  });
  return { messages, out };
}

const withResult = (messages: Record<string, unknown>[], id: string, n: number) => [...messages, { role: "tool", tool_call_id: id, content: JSON.stringify({ secret_number: n }) }];
const continueWith = (messages: Record<string, unknown>[], scope: string) =>
  handleChatCompletion({ model: "gpt-5.5", messages: messages as never, tools: tools as never, stream: true }, undefined, undefined, scope);

// --- Test 16: a parked run gives its slot back ---
console.log("\n=== Test 16: parked run releases its slot ===");
_setMaxActive(1);
const p16 = await park("ses_test_slot");
const st16 = _stats();
console.log("parked stats:", JSON.stringify(st16));
if (st16.active !== 0 || st16.held !== 1) throw new Error("Test 16 FAILED: parked run still holds a slot");
const plain16 = await Promise.race([
  handleChatCompletion({ model: "gpt-5.5", messages: [{ role: "user", content: "Reply with exactly: BRIDGE-OK" }] as never, stream: true }).then(readSse),
  new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Test 16 FAILED: plain request waited on the parked run")), 120_000)),
]);
console.log("plain while parked:", JSON.stringify(plain16.content));
if (!plain16.content.includes("BRIDGE-OK")) throw new Error("Test 16 FAILED: plain request");
const out16 = await readSse(await continueWith(withResult(p16.messages, p16.out.toolCalls[0].id, 7741), "ses_test_slot"));
console.log("continuation:", JSON.stringify(out16.content), "| stats:", JSON.stringify(_stats()));
_setMaxActive(4);
if (!out16.content.includes("7741")) throw new Error("Test 16 FAILED: continuation missing 7741");
if (_stats().held !== 0 || _stats().active !== 0) throw new Error("Test 16 FAILED: leaked held/slot");

// --- Test 17: session idle releases only that session's parked runs ---
console.log("\n=== Test 17: idle release ===");
await park("ses_test_idle");
releaseParked("ses_test_other");
console.log("after other-scope release:", JSON.stringify(_stats()));
if (_stats().held !== 1) throw new Error("Test 17 FAILED: released another session's parked run");
releaseParked("ses_test_idle");
releaseParked("ses_test_idle");
if (_stats().held !== 0) throw new Error("Test 17 FAILED: parked run not released");
// (workspace release is not visible through _stats: the remembered session keeps the cwd for resume)
await assertClean("Test 17");

// --- Test 18: expired tool call replays instead of 400 ---
console.log("\n=== Test 18: expired tool call replays ===");
const p18 = await park("ses_test_replay");
releaseParked("ses_test_replay");
const res18 = await continueWith(withResult(p18.messages, p18.out.toolCalls[0].id, 7741), "ses_test_replay");
console.log("status:", res18.status);
if (res18.status !== 200) throw new Error(`Test 18 FAILED: status ${res18.status}: ${(await res18.text()).slice(0, 200)}`);
const out18 = await readSse(res18);
console.log("replayed content:", JSON.stringify(out18.content), "| finish:", out18.finish);
if (!out18.content.includes("7741")) throw new Error("Test 18 FAILED: replayed agent did not see the tool result");
await assertClean("Test 18");

// --- Test 19: duplicate continuation -> one 200, one 409 ---
console.log("\n=== Test 19: duplicate continuation ===");
const p19 = await park("ses_test_dup");
const msgs19 = withResult(p19.messages, p19.out.toolCalls[0].id, 7741);
const [ra, rb] = await Promise.all([continueWith(msgs19, "ses_test_dup"), continueWith(msgs19, "ses_test_dup")]);
const statuses19 = [ra.status, rb.status];
console.log("statuses:", JSON.stringify(statuses19));
const ok19 = [ra, rb].find((r) => r.status === 200);
const dup19 = [ra, rb].find((r) => r.status === 409);
if (!ok19 || !dup19) throw new Error(`Test 19 FAILED: expected one 200 and one 409, got ${statuses19}`);
const body19 = await dup19.json();
const out19 = await readSse(ok19);
console.log("409 body:", JSON.stringify(body19), "| content:", JSON.stringify(out19.content));
if (body19?.error?.code !== "continuation_in_progress") throw new Error("Test 19 FAILED: bad 409 body");
if (!out19.content.includes("7741")) throw new Error("Test 19 FAILED: continuation missing 7741");
await assertClean("Test 19");

// --- Test 20: late parallel tool call goes out on the next segment ---
console.log("\n=== Test 20: late parallel tool call ===");
_setBatchSettleMs(1);
let done20 = false;
try {
  for (let attempt = 1; attempt <= 2 && !done20; attempt++) {
    const p20 = await park("ses_test_late_" + attempt, "Call get_secret_number for label 'alpha' AND for label 'beta' in parallel (two tool calls in the same step), then tell me both numbers.");
    const first = p20.out.toolCalls;
    console.log(`attempt ${attempt}: first segment tool calls:`, JSON.stringify(first));
    if (first.length !== 1) {
      releaseParked("ses_test_late_" + attempt);
      console.log(first.length > 1 ? "(both calls landed in one 1ms batch)" : "");
      continue;
    }
    const m20 = withResult(p20.messages, first[0].id, first[0].args.includes("beta") ? 2222 : 1111);
    const seg2 = await readSse(await continueWith(m20, "ses_test_late_" + attempt));
    console.log("second segment finish:", seg2.finish, "| tool calls:", JSON.stringify(seg2.toolCalls), "| content:", JSON.stringify(seg2.content));
    if (seg2.finish !== "tool_calls" || seg2.toolCalls.length !== 1) {
      releaseParked("ses_test_late_" + attempt);
      console.log("(model did not issue a second parallel call)");
      continue;
    }
    if (seg2.toolCalls[0].id === first[0].id) throw new Error("Test 20 FAILED: tool call emitted twice");
    m20.push({ role: "assistant", content: seg2.content || null, tool_calls: seg2.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })) });
    const final20 = await readSse(await continueWith(withResult(m20, seg2.toolCalls[0].id, seg2.toolCalls[0].args.includes("beta") ? 2222 : 1111), "ses_test_late_" + attempt));
    console.log("final:", JSON.stringify(final20.content), "| finish:", final20.finish);
    if (!final20.content.includes("1111") || !final20.content.includes("2222")) throw new Error("Test 20 FAILED: final answer missing a number");
    done20 = true;
  }
} finally {
  _setBatchSettleMs(300);
}
if (!done20) console.log("Test 20 SKIPPED: model would not issue a late parallel call in 2 attempts");
await assertClean("Test 20");

// --- Test 21: usage estimate in a tool loop ---
// turn-ended sums every model call; prompt_tokens must estimate the last call, never under it
console.log("\n=== Test 21: usage estimate in a tool loop ===");
const eq21 = (label: string, got: unknown, want: unknown) => {
  console.log(label, JSON.stringify(got));
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`Test 21 FAILED: ${label} expected ${JSON.stringify(want)}`);
};
eq21("one call:", mapUsage({ inputTokens: 4536, outputTokens: 5, cacheReadTokens: 3584 }, 1, 0), { prompt_tokens: 4536, completion_tokens: 5, total_tokens: 4541, prompt_tokens_details: { cached_tokens: 3584 } });
eq21("4 calls, L=4536:", mapUsage({ inputTokens: 19147, outputTokens: 210, cacheReadTokens: 16384, reasoningTokens: 36 }, 4, 4536), { prompt_tokens: 5539, completion_tokens: 210, total_tokens: 5749, prompt_tokens_details: { cached_tokens: 5539 }, completion_tokens_details: { reasoning_tokens: 36 } });
eq21("4 calls, L unknown:", mapUsage({ inputTokens: 19147, outputTokens: 210, cacheReadTokens: 16384 }, 4, 0), { prompt_tokens: 19147, completion_tokens: 210, total_tokens: 19357, prompt_tokens_details: { cached_tokens: 16384 } });
eq21("4 calls, L huge (avg floor):", mapUsage({ inputTokens: 19147, outputTokens: 210 }, 4, 100000)?.prompt_tokens, Math.ceil(19147 / 4));

const usageOf = async (res: Response) => {
  let usage: { prompt_tokens: number; prompt_tokens_details?: { cached_tokens: number } } | undefined;
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const u = JSON.parse(line.slice(6)).usage;
    if (u) usage = u;
  }
  if (!usage) throw new Error("Test 21 FAILED: no usage on final chunk");
  return usage;
};
// baseline: plain one-shot on a fresh scope; it also gives the tool-loop turn a known previous prompt (L)
const msgs21: Record<string, unknown>[] = [{ role: "user", content: "Reply with exactly: BRIDGE-OK" }];
const res21a = await handleChatCompletion({ model: "gpt-5.5", messages: msgs21 as never, tools: tools as never, stream: true }, undefined, undefined, "ses_test_usage");
const base21 = await usageOf(res21a);
msgs21.push({ role: "assistant", content: "BRIDGE-OK" });
msgs21.push({ role: "user", content: "Call get_secret_number with label 'alpha', then tell me the number you got." });
const seg21 = await readSse(await handleChatCompletion({ model: "gpt-5.5", messages: msgs21 as never, tools: tools as never, stream: true }, undefined, undefined, "ses_test_usage"));
if (seg21.finish !== "tool_calls" || !seg21.toolCalls.length) throw new Error("Test 21 FAILED: no tool_calls turn");
msgs21.push({ role: "assistant", content: seg21.content || null, tool_calls: seg21.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })) });
const loop21 = await usageOf(await continueWith(withResult(msgs21, seg21.toolCalls[0].id, 7741), "ses_test_usage"));
console.log("one-shot prompt_tokens:", base21.prompt_tokens, "| tool-loop prompt_tokens:", loop21.prompt_tokens, "| cached:", loop21.prompt_tokens_details?.cached_tokens ?? 0);
if (!(loop21.prompt_tokens > 0)) throw new Error("Test 21 FAILED: zero prompt_tokens");
if ((loop21.prompt_tokens_details?.cached_tokens ?? 0) > loop21.prompt_tokens) throw new Error("Test 21 FAILED: cached > prompt");
if (loop21.prompt_tokens >= 2 * base21.prompt_tokens) throw new Error("Test 21 FAILED: tool-loop prompt still looks like the summed run");
await assertClean("Test 21");

const keysOf = (scope: string) => _sessionEntries().filter(([k]) => k.startsWith(`s:${scope}\u0000`));
const agentOf = (scope: string, agent: string) => keysOf(scope).find(([k]) => k === `s:${scope}\u0000${agent}`)?.[1].agentId;
const chat = (messages: Record<string, unknown>[], scope: string, agent: string) =>
  handleChatCompletion({ model: "gpt-5.5", messages: messages as never, stream: true }, undefined, undefined, scope, agent).then(readSse);
const ownTmpDirs = () => readdirSync(tmpdir()).filter((n) => /^opencode-cursor-[A-Za-z0-9]{6}$/.test(n)).length;
async function waitGone(path: string, label: string) {
  for (let i = 0; i < 50 && existsSync(path); i++) await new Promise((r) => setTimeout(r, 100));
  if (existsSync(path)) throw new Error(`${label} FAILED: ${path} still exists`);
}

// --- Test 22: resume across a "restart" while the system prompt drifted ---
console.log("\n=== Test 22: cross-process resume with system drift ===");
const sys22 = (p: string) => ({ role: "system", content: `You are A. <location>/tmp/${p}/SKILL.md</location>` });
const user22 = { role: "user", content: "Remember the word KIWI. Reply OK" };
const out22a = await chat([sys22("x"), user22], `oca-t22-${runId}`, "main");
const id22 = agentOf(`oca-t22-${runId}`, "main");
_resetForTest();
const out22b = await chat([sys22("y"), user22, { role: "assistant", content: out22a.content }, { role: "user", content: "What word? Just the word." }], `oca-t22-${runId}`, "main");
console.log("turn 2:", JSON.stringify(out22b.content), "| agentId turn 1:", id22, "| now:", agentOf(`oca-t22-${runId}`, "main"));
if (!out22b.content.includes("KIWI")) throw new Error("Test 22 FAILED: reply missing KIWI");
if (!id22 || agentOf(`oca-t22-${runId}`, "main") !== id22) throw new Error("Test 22 FAILED: agent was recreated, not resumed");

// --- Test 23: a title request in the same session does not clobber the main agent ---
console.log("\n=== Test 23: title request does not clobber ===");
const user23 = { role: "user", content: "Remember the word PLUM. Reply OK" };
const out23a = await chat([{ role: "system", content: "You are A." }, user23], `oca-t23-${runId}`, "main");
const id23 = agentOf(`oca-t23-${runId}`, "main");
await chat([{ role: "system", content: "Generate a title" }, user23], `oca-t23-${runId}`, "title");
const out23b = await chat([{ role: "system", content: "You are A." }, user23, { role: "assistant", content: out23a.content }, { role: "user", content: "What word? Just the word." }], `oca-t23-${runId}`, "main");
console.log("turn 2:", JSON.stringify(out23b.content), "| keys:", keysOf(`oca-t23-${runId}`).length);
if (!out23b.content.includes("PLUM")) throw new Error("Test 23 FAILED: reply missing PLUM");
if (!id23 || agentOf(`oca-t23-${runId}`, "main") !== id23) throw new Error("Test 23 FAILED: main agent was recreated");
if (keysOf(`oca-t23-${runId}`).length !== 2) throw new Error(`Test 23 FAILED: expected 2 entries (main + title), got ${keysOf(`oca-t23-${runId}`).length}`);

// --- Test 24: a tool loop leaves exactly one entry and one workspace ---
console.log("\n=== Test 24: no stale entries after a tool loop ===");
const tmp24 = ownTmpDirs();
const p24 = await park(`oca-t24-${runId}`);
const out24 = await readSse(await continueWith(withResult(p24.messages, p24.out.toolCalls[0].id, 7741), `oca-t24-${runId}`));
await assertClean("Test 24");
console.log("final:", JSON.stringify(out24.content), "| entries:", keysOf(`oca-t24-${runId}`).length, "| tmp dirs:", tmp24, "->", ownTmpDirs());
if (!out24.content.includes("7741")) throw new Error("Test 24 FAILED: final answer missing 7741");
if (keysOf(`oca-t24-${runId}`).length !== 1) throw new Error(`Test 24 FAILED: expected 1 entry, got ${keysOf(`oca-t24-${runId}`).length}`);
if (ownTmpDirs() > tmp24 + 1) throw new Error("Test 24 FAILED: tmp workspaces grew by more than 1");

// --- Test 25: forgetSession releases the entry and its workspace ---
console.log("\n=== Test 25: forgetSession ===");
const cwd25 = keysOf(`oca-t24-${runId}`)[0][1].cwd;
forgetSession(`oca-t24-${runId}`);
if (keysOf(`oca-t24-${runId}`).length) throw new Error("Test 25 FAILED: entry survived forgetSession");
await waitGone(cwd25, "Test 25");
console.log("entry and", cwd25, "gone");

// --- Test 26: startup sweep removes old orphan workspaces and project dirs only ---
console.log("\n=== Test 26: startup sweep ===");
const slugOf = (p: string) => join(homedir(), ".cursor", "projects", p.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, ""));
const [sw1, sw2, sw3] = ["SWEEP1", "SWEEP2", "SWEEP3"].map((s) => join(tmpdir(), `opencode-cursor-${s}`));
const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
for (const d of [sw1, sw2, slugOf(sw1), slugOf(sw3)]) mkdirSync(d, { recursive: true });
writeFileSync(join(sw1, "AGENTS.md"), "x");
for (const p of [join(sw1, "AGENTS.md"), sw1, slugOf(sw1), slugOf(sw3)]) utimesSync(p, past, past);
_resetForTest();
await assertBridgeOk("Test 26");
await waitGone(sw1, "Test 26");
await waitGone(slugOf(sw1), "Test 26");
await waitGone(slugOf(sw3), "Test 26");
const kept26 = existsSync(sw2);
rmSync(sw2, { recursive: true, force: true });
if (!kept26) throw new Error("Test 26 FAILED: fresh workspace was swept");
console.log("old workspace + its project dir + orphan project dir swept, fresh workspace kept");

for (const [k] of _sessionEntries()) if (k.startsWith("s:") && k.includes(runId)) forgetSession(k.slice(2).split("\u0000")[0]);
await new Promise((r) => setTimeout(r, 1500));

console.log("\nALL BRIDGE TESTS PASSED");
process.exit(0);
