# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.3.6 — 2026-10-16

### Added

- Images. Attachments in a message are forwarded to Cursor (`data:` URLs inline, `http(s)` by reference). Every model is advertised as image-capable because Cursor's catalog carries no vision flag; a model that cannot take images answers with Cursor's own error.

### Fixed

- Cursor's built-in tools (shell, read, edit, …) are now explicitly disabled on every agent, not only via the `tools: ["mcp"]` header. The model can only act through opencode's tools.
- A stored workspace is resumed only if it is still a real, private directory owned by the current user. A path swapped for a symlink or opened up to other users drops the session entry instead of being reused.
- `sessions.json` and `models.json` are written `0600` (cache directory `0700`). Existing files are fixed on the next save.
- When a conversation is replayed into a fresh agent, each turn is wrapped in nonce delimiters so text inside a tool result cannot pose as a user turn.

## 0.3.5 — 2026-10-16 (not published to npm; included in 0.3.6)

### Fixed

- Session resume only worked inside one opencode process. The session map was keyed by a hash of the full message history including the system prompt, and opencode's skill index paths differ per process, so every restart, `opencode run -c`, second terminal, or date rollover missed the map and replayed the whole conversation as prose. Sessions are now keyed by opencode's session id and agent name (sent as `x-opencode-session` / `x-opencode-agent` headers); the non-system message prefix is only used to detect a diverged history (revert, edit). `sessions.json` is now version 2; older files are ignored.
- Every tool loop left a stale entry in the session map, so entries grew without bound, workspaces were never released, and a reverted conversation could resume the wrong Cursor agent. On the user's machine this had accumulated 192 temp workspaces and 396 `~/.cursor/projects` directories (113 MB). The scope entry is now overwritten and the displaced workspace released.
- Workspaces and `~/.cursor/projects` directories left behind by a killed opencode process were never cleaned up. The plugin now sweeps expired `opencode-cursor-*` workspaces and their project directories at load, and releases a session's Cursor agent and workspace when opencode deletes the session.
- A failure while creating the temp workspace leaked a concurrency slot.
- Any 403 marked the model as blocked and hid it from the list; now only Cursor's `MODEL_BLOCKED` does.
- An aborted, unauthenticated, or rate-limited `Agent.resume` destroyed the session entry; those cases now keep it.
- Plugin init no longer races the auth-entry seeding.

## 0.3.4 — 2026-10-16

### Fixed

- A run waiting for a tool result held a concurrency slot until its continuation or the 10-minute timer, so a Cursor parent parked on a Cursor sub-agent could deadlock at the cap and Esc pinned a slot for 10 minutes. Parked runs now release their slot; continuations re-acquire one through a priority queue. Esc (session idle) releases that session's parked runs immediately; a second continuation for the same tool call gets 409 `continuation_in_progress`.
- A parallel tool call that arrived after the 300 ms batch window was never delivered and the run hung until the idle timer. It is now delivered on the next segment.
- A tool result for a run that is gone (Esc, idle release, sleep, restart) returned 400 `tool_call_expired`. It now replays the conversation into a fresh agent, with tool results attributed by name and the earlier calls marked as already made.
- After a tool loop, opencode's context meter and auto-compaction saw Cursor's summed usage for every model call in the run (2–4× the real context). The bridge now reports an upper-bound estimate of the last call's prompt, remembering the previous turn's prompt per agent, and keeps `cached_tokens` ≤ `prompt_tokens` (Cursor's `inputTokens` already includes cache).
- Errors are classified by Cursor's backend error code before the SDK class or message: `BAD_API_KEY` / `BAD_USER_API_KEY` → 401, `MODEL_BLOCKED` → 403, and a spent plan (`FREE_USER_USAGE_LIMIT` / `PRO_USER_USAGE_LIMIT`) → new 402 `insufficient_quota`, which is never retried. A 429 carries `retry-after` when Cursor's message names a wait; aborts are never retried. Local system errors (e.g. `EACCES` writing `AGENTS.md`) are 502 and never mark a model blocked. (from #1 by @Dakuaisu)
- An unwritable or full cache dir made `sessions.json` writes throw, failing turns and throwing from the tool-flush timer; session persistence is now best effort and atomic (temp file, fsync, rename), and workspace removal no longer throws. A failed `AGENTS.md` write now fails the request normally instead of leaking the concurrency slot. A stale model catalog is served immediately and refreshed in the background; a first run with no cache waits at most 15 s. (from #1 by @Dakuaisu)
- opencode aborted requests after 5 minutes without response headers or between chunks, which a queued request, silent reasoning or a large tool argument could exceed. `headerTimeout` and `chunkTimeout` now default to 30 minutes for the cursor provider (user-set `provider.cursor.options` win). (from #1 by @Dakuaisu)
- Session resume after a tool-using turn never worked for `cursor/claude-*` models: opencode's `cache_control` tags changed how tool calls serialized a turn later, so every such turn replayed the whole history into a new agent. Tool calls now hash by id, name and arguments. Existing session keys change once. (from #1 by @Dakuaisu)
- Cursor agents were never deleted: every conversation left an agent plus its store and transcript under `~/.cursor/projects/<workspace>`. When a workspace is released, the bridge now deletes the agent (after any cancel settles) and removes Cursor's project dir along with the workspace; deletion is limited to the bridge's own `opencode-cursor-XXXXXX` temp workspaces. (from #1 by @Dakuaisu)

## 0.3.3 — 2026-10-16

### Added

- `npx @vidit19sharma/opencode-cursor-auth update` — removes opencode's cached copy of the plugin so the next opencode start installs the current release. opencode resolves `@latest` once at first install and never re-checks, so users were silently stuck on the version they first installed (`--dry-run` supported).
- Mocked plugin unit tests (`bun run test:plugin`) covering key handling, expiry, headless login URL passthrough and auth-entry seeding.

### Fixed

- Pressing Esc before the first byte (during agent setup) returned HTTP 502 "aborted"; it now propagates as a proper abort.
- `@cursor/sdk` INFO/WARN log lines leaked into the opencode TUI: the lines are ANSI-coloured when stdout is a TTY, so the filter never matched there. Colours are stripped before matching and the filter is re-asserted per request.
- An empty or whitespace API key stored via the paste method silently fell back to the SDK key store; it now returns 401 `invalid_api_key`.
- A failure after content has already streamed emits a single SSE `error` frame and closes without `[DONE]` (covered by a test).

## 0.3.2 — 2026-10-16

### Added

- `npx @vidit19sharma/opencode-cursor-auth setup` — adds the plugin to opencode config idempotently (`--dry-run`, `--config`).

### Fixed

- The first request before `opencode auth login` hung in opencode's connect loop: without a `cursor` auth entry opencode skips the plugin's auth loader and dials the dummy `http://cursor.local/v1`. The plugin now seeds its auth entry (only when none exists), so the loader runs and returns a clear 401 telling you to run `opencode auth login`.

### Changed

- Docs no longer claim the Cursor CLI (`cursor-agent`) is required; `@cursor/sdk` talks to Cursor's backend directly.

## 0.3.1 — 2026-10-16

### Fixed

- opencode crashed at startup on a fresh machine (`undefined is not an object (evaluating 'C.provider')`, and `C.auth` on `opencode auth login`) as soon as the plugin was enabled. opencode invokes **every named export** of a plugin module as a plugin; the entry module also exported `CursorAuthPlugin`, `keyProblem` and `parseContext`, so opencode called the helpers as plugins and tried to read hooks off their return values. The entry now exposes only `default`; helpers moved to `src/plugin.ts`. Affects 0.1.0–0.3.0. A test guards the export shape.

## 0.3.0 — 2026-10-16

### Breaking

- The suffixed variant ids from 0.2.0 (`cursor/gpt-5.5-low`, `cursor/claude-opus-5-5-1m-max`, …) no longer exist; Cursor rejects them with 400 "Cannot use this model". Migrate `cursor/gpt-5.5-low` to model `cursor/gpt-5.5` + variant `low` (Ctrl+T in the TUI, or `variant:` in config).

### Added

- Cursor variants on opencode's native variant picker (Ctrl+T): the model list is the 47 base ids only, and every other Cursor variant is attached as an opencode model variant, named by the params that differ from Cursor's default (e.g. `low`, `272k-none`, `no-thinking`, `xhigh-fast`).
- Variants are selectable in config with `variant: "<name>"` next to `model` in an agent entry.
- `installation.md`: step-by-step install guide for AI coding agents (prerequisites, config edit, auth, verification, troubleshooting), shipped in the npm tarball; the README has a one-line prompt to hand to any LLM agent.
- `spike/probe-models.ts`: probes every base model once and reports AVAILABLE / BLOCKED / OTHER for the logged-in account.

### Changed

- A base id now means Cursor's own default variant (`isDefault`), sends its params explicitly, and gets that variant's context limit; previously it implied the first-listed param values and under-reported context (`gpt-5.5`: 272k → 1M).
- Models cache bumped to v4 `{name, context, params, variants, allowed}`; older cache files are refetched once.

### Fixed

- Blocked-model flags learned from 403s persist across the 24h catalog refresh (carried over by base id), so admin-blocked models stay hidden instead of reappearing; delete `models.json` to re-check.
- An unknown variant param id or value (sent as `cursor_params`) returns 400 `invalid_request_error` before any Cursor agent is created or concurrency slot taken.

## 0.2.0 — 2026-10-16

### Added

- Model variants: every variant Cursor publishes (reasoning effort, fast, 1M context) is a selectable id, e.g. `cursor/gpt-5.5-low-fast`, `cursor/claude-opus-5-5-1m-max`. Ids are the base id plus non-default param values and map back to Cursor `ModelSelection` params; unknown ids still pass through to Cursor's own 400.
- Model context limits: each model gets `limit.context` from Cursor's `context` parameter (default 200k) and `limit.output` 32k. Without a limit opencode 1.19 sets context to 0 and silently disables auto-compaction and the context indicator.
- SDK key check on `/chat/completions` (60s cache, skipped for pasted/env keys): a missing or expired key returns 401 telling the user to run `opencode auth login`; one-time stderr warning within 7 days of expiry.
- Concurrency cap: a FIFO semaphore limits concurrently active Cursor runs (default 4, `OPENCODE_CURSOR_MAX_ACTIVE` to override). Extra requests queue; tool-result continuations never take a slot.
- Retry: `Agent.create` / `Agent.resume` / `send` are attempted up to 3 times with jittered backoff on 429, 5xx, and network errors; never after the first byte.
- Usage reports cache-read tokens (`prompt_tokens_details.cached_tokens`) and reasoning tokens (`completion_tokens_details.reasoning_tokens`).

### Changed

- Models cache bumped to v3 `{name, context, params}`; older cache files are refetched once. Catalog code moved to `src/models.ts`.
- The reply is opened only on content deltas (text/thinking), so run errors before any content become real JSON error responses instead of a 200 stream with an error frame.

### Fixed

- Real HTTP error statuses: failures before the first byte return a JSON error with a real status (400 bad model/argument, 401 auth, 403 blocked, 429 rate limit, 502 otherwise); mid-stream failures emit an OpenAI error frame and close without `[DONE]`.
- Admin-blocked models: "Model Blocked" / `permission_denied` map to 403 `permission_error` and are never retried. A 403 marks the model and its variants blocked in the models cache; they are hidden from the model list until the next 24h catalog refresh and still resolve if used explicitly.
- Abort propagation: the request AbortSignal and stream `cancel()` cancel the Cursor run, close the agent, and release registries (no more zombie runs burning usage).
- agentId race: the held run is registered before `send()`, so a tool call firing immediately can never miss its continuation lookup.
- Session resume is scoped by opencode session id (via the `chat.headers` hook), so byte-identical histories from different sessions (parallel sub-agents) never resume each other's Cursor agent. Unscoped callers and existing disk entries hash exactly as before.
- Per-session temp workspaces are removed once no session, disk, or held entry references them.

## 0.1.0 — 2026-10-15

- Initial release: in-process Cursor SDK bridge, auth, tool loop, session resume, AGENTS.md system prompt, dynamic model list.
