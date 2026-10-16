# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Fixed

- Session resume after a tool-using turn never worked for `cursor/claude-*` models. opencode tags the last two messages with `cache_control` for ids containing `claude`, and the openai-compatible converter copies it into `tool_calls`, so a message hashed one turn earlier no longer matched; every such turn started a new agent and replayed the whole history. Tool calls now hash by id, name and arguments. With an opencode session id, system messages are left out of the key too (opencode's system prompt carries today's date; the prompt still reaches the agent via `AGENTS.md` each turn). Existing session keys change once.
- Esc during a tool call left the Cursor run parked, holding a concurrency slot, for 10 minutes; a few interrupts stalled every Cursor request. The plugin now listens for opencode's `session.idle` / `session.status` events and releases that session's parked runs.
- A tool that ran longer than 10 minutes (sub-agent, permission prompt, `question`, long bash) failed the turn with 400 `tool_call_expired`. The timeout is now a 2 h backstop, and tool results whose run is gone (backstop, Esc, laptop sleep) resume the run's agent from its tool calls instead of failing. A run parked on tool results no longer holds a slot; its continuation re-queues at the front, so Cursor sub-agents can't deadlock behind a Cursor parent.
- opencode aborted requests after 5 minutes without response headers or between chunks, which a queued request, silent reasoning, or a large tool argument could exceed. The plugin defaults `headerTimeout` and `chunkTimeout` to 30 minutes for the cursor provider (user-set `provider.cursor.options` win).
- An unwritable or full cache dir made `sessions.json` writes throw: plain turns never finished their stream, and tool flushes threw from a timer. Session persistence is now best effort and atomic (temp file, fsync, rename); temp-workspace removal no longer throws either.
- A transient failure or a cancel before Cursor answered dropped the conversation's agent mapping, so the retry replayed the whole history into a new agent. The mapping is now kept: put back for a retry, or re-keyed to the history opencode will send after an Esc.
- A parallel tool call that arrived after the 300 ms batch window was parked but never delivered, hanging the continuation. It now goes out on the next segment.
- A failed `AGENTS.md` write leaked the concurrency slot and the held run; it now fails the request normally.
- Reported usage now reads as context size, which is how opencode uses it (context meter, auto-compaction). Prompt tokens include Cursor's cache reads/writes (Cursor's `inputTokens` exclude them, so the meter undercounted or clamped to 0). Cursor sums a turn's usage over every model call of its agent loop, so long tool loops reported a multiple of the real context; the bridge now divides by the number of model calls. The final step prefers the last turn's usage over the run's total, and tool-call steps carry usage when Cursor reported it.
- opencode's startup waited for the catalog fetch whenever the cache was stale, with no timeout, and every offline start fetched again. A stale catalog is now served immediately and refreshed in the background; a first run waits at most 15 s.
- Cursor agents were never deleted: every conversation, title and summary request left an agent plus its store and transcript under `~/.cursor/projects/<workspace>` for good (`Agent.delete` alone keeps the transcript and store files). When a workspace is released (its session entry passed the 7-day TTL, or its first turn failed for good), the bridge now deletes the agent, waiting for a cancel to settle since the SDK refuses while a run is live, and removes Cursor's project dir along with the workspace.

### Added

- Charges beyond the plan are surfaced: after each turn the bridge reads what Cursor billed the agent (`Agent.getUsage`, `chargedCents`) and shows a toast when it grew, e.g. "Cursor billed $0.15 on-demand for the last turn ($0.52 in this conversation)". opencode still shows $0 per message, since it prices a step as tokens × `model.cost` and only Copilot can report a real cost. Accounts where Cursor answers `feature_unavailable` (SDK billing not enabled) are asked once per process, then never again.

### Changed

- Errors are classified by the SDK's backend error code before its class or message: `BAD_API_KEY` / `BAD_USER_API_KEY` → 401, `MODEL_BLOCKED` → 403, and a spent plan (`FREE_USER_USAGE_LIMIT` / `PRO_USER_USAGE_LIMIT`) → new 402 `insufficient_quota`, which neither the bridge nor opencode retries. A 429 carries `retry-after` when Cursor's message names a wait, and the SDK's `isRetryable: true` now counts as transient. Local system errors (e.g. `EACCES` writing `AGENTS.md`) are 502 and never mark a model blocked.

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
