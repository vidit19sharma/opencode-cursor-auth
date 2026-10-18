# Install @vidit19sharma/opencode-cursor-auth

These instructions are designed for AI coding agents.

The plugin lets opencode use a Cursor subscription through the official `@cursor/sdk`, in-process. Supported on macOS/Linux; Windows untested.

## Prerequisites

### Check opencode version

```bash
opencode --version
```

You should see `1.19` or newer. If older or missing, ask the user to install or upgrade opencode before continuing (on older opencode, sessions fall back to content-hash keys and long tool calls are cut off after 10 minutes).

### Check Node version

```bash
node --version
```

You should see `v22.13` or newer. opencode runs the plugin on its bundled Bun; Node >= 22.13 is needed for the `npx` CLI below. If older, ask the user to upgrade Node, or use the manual edit in Step 2.

A Cursor plan that includes agent usage is required.

## Installation

### Step 1: Remove the old open-cursor setup (only if present)

If `~/.config/opencode/plugin/cursor-acp.js` exists or the opencode config has a `cursor-acp` provider, the user has the old `@rama_nigg/open-cursor` proxy setup. Remove it:

1. Delete the `cursor-acp` block under `provider` in the opencode config.
2. Delete the file: `rm ~/.config/opencode/plugin/cursor-acp.js`
3. Uninstall it: `npm uninstall -g @rama_nigg/open-cursor`

Skip this step if none of these exist.

### Step 2: Add the plugin to the opencode config

**Preferred, if you can run shell commands:**

```bash
npx @vidit19sharma/opencode-cursor-auth setup
```

It adds the plugin idempotently (exit 0 = added or already present) and lists any open-cursor leftovers from Step 1 without deleting them. Exit 2 means it could not edit the file safely (it has comments or trailing commas, whatever the extension); it prints the exact edit, which you then make by hand as described below. Use `--dry-run` to preview. It edits the first of `--config <path>`, `$OPENCODE_CONFIG`, `opencode.jsonc` / `opencode.json` in `$OPENCODE_CONFIG_DIR`, `$XDG_CONFIG_HOME/opencode/` or `~/.config/opencode/`, and backs the original up to `<file>.bak-cursor-auth`.

**Fallback: edit the file by hand.** The config file is `~/.config/opencode/opencode.json` (or the location above if `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME` is set). Some users have `opencode.jsonc` instead; if both exist, edit `opencode.jsonc`.

If neither exists, create `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@vidit19sharma/opencode-cursor-auth@latest"]
}
```

If the file exists and has no top-level `plugin` array, add one:

```json
"plugin": ["@vidit19sharma/opencode-cursor-auth@latest"]
```

If a `plugin` array already exists, append `"@vidit19sharma/opencode-cursor-auth@latest"` and keep every existing entry.

Do not add a `provider.cursor` block by hand. On startup the plugin registers the `cursor` provider and its model list automatically. No `npm install` is needed; opencode installs the package at startup.

### Step 3: Authenticate

Pick one method.

**Browser login.** This step needs the user. Ask them to run:

```bash
opencode auth login
```

and choose provider **Cursor**, then **Log in with Cursor (browser)**. opencode prints (and may open) a cursor.com login URL; they sign in to Cursor. On a headless/SSH machine they can open the printed URL on any device; the key is saved on the machine running opencode. This mints a 90-day SDK key stored at `~/.cursor/sdk/auth.json` (written by `@cursor/sdk`, not by the plugin). When the key expires, requests return a 401 telling the user to run `opencode auth login` again; a warning is printed to stderr during the last 7 days.

**API key.** In `opencode auth login`, choose **Cursor**, then **Paste a Cursor API key**. Keys come from cursor.com/dashboard (Integrations / API keys). Alternatively, set `CURSOR_API_KEY` in the environment before starting opencode.

Key precedence: pasted key > `CURSOR_API_KEY` > browser-login key in `~/.cursor/sdk/auth.json`.

### Step 4: Restart opencode

The model list and a pasted key are read when opencode starts. Ask the user to quit and restart opencode after logging in; until then only `cursor/auto` is listed.

## Verification

```bash
opencode models | grep cursor/
```

You should see `cursor/auto`, `cursor/gpt-5.5`, `cursor/claude-opus-5-5`, and more. The first run fetches the catalog from Cursor (about 3 s); it is cached for 24 h at `~/.cache/opencode-cursor-auth/models.json`. Only `cursor/auto` means opencode was not restarted after login, or the fetch failed (see Troubleshooting).

Variants are not separate ids. In the TUI, press Ctrl+T on a cursor model to pick its effort, thinking, fast, or context variant.

```bash
opencode run -m cursor/gpt-5.5 "Reply with exactly: CURSOR-AUTH-OK"
```

You should see `CURSOR-AUTH-OK`. In some setups `opencode run` does not exit on its own because of other plugins; Ctrl-C after the reply is fine.

Optional: to see which models the account is actually allowed to use, clone the repo, run `bun install`, then `bun spike/probe-models.ts`. It sends one tiny request per model.

## Upgrading

opencode resolves `@latest` once, at first install, and keeps that cached version forever; restarting does not upgrade it. To upgrade, run:

```bash
npx @vidit19sharma/opencode-cursor-auth update
```

It deletes every cached `opencode-cursor-auth@*` dir under `<cache>/packages/@vidit19sharma/` and the legacy `<cache>/npm/@vidit19sharma/`, where `<cache>` is `$XDG_CACHE_HOME/opencode` or `~/.cache/opencode`; it prints "nothing to update" when there is none. Then tell the user to restart opencode; it installs the current release from npm on start. `update --dry-run` shows what would be removed. Manual equivalent:

```bash
rm -rf ~/.cache/opencode/packages/@vidit19sharma/opencode-cursor-auth@* ~/.cache/opencode/npm/@vidit19sharma/opencode-cursor-auth@*
```

To pin a version instead of `@latest`, use e.g. `"@vidit19sharma/opencode-cursor-auth@0.4.1"` in the `plugin` array; to roll back, change the pin, run `update`, restart opencode.

## Done

The plugin is installed. Every model the user's Cursor plan includes is available as `cursor/*` in opencode.

## Troubleshooting

- **401 ``Cursor SDK key missing — run `opencode auth login` and pick Cursor``** (or `expired on <date>`): never logged in, or the 90-day key expired. A request before any login fails immediately with this. Run `opencode auth login`, pick Cursor, restart opencode.
- **401 `invalid_api_key` "Cursor API key is empty"**: an empty key was pasted. Run `opencode auth login` again and paste a real key (or use browser login), then restart opencode.
- **403 `permission_error` "Model Blocked"**: a team admin disabled that model for the account. It is hidden from `opencode models` from then on; delete `~/.cache/opencode-cursor-auth/models.json` to re-check.
- **400 `Cannot use this model`**: the model id is not in Cursor's catalog for this account.
- **Request hangs with no error before any login**: `~/.local/share/opencode/auth.json` exists but is not valid JSON, so the plugin cannot seed its Cursor entry. Fix or move that file, or run `opencode auth login` and pick Cursor, then restart opencode.
- **Features missing / variants not showing on Ctrl+T**: opencode is running a stale cached version. Run `npx @vidit19sharma/opencode-cursor-auth update`, then restart opencode.
- **Model list empty or only `cursor/auto`**: opencode was not restarted after login, or the catalog fetch failed (offline or not logged in). Fix auth, delete `~/.cache/opencode-cursor-auth/models.json`, restart opencode.

### Paths

| Path | Contents |
| --- | --- |
| `~/.cursor/sdk/auth.json` | SDK key from browser login |
| `~/.cache/opencode-cursor-auth/models.json` (or `$XDG_CACHE_HOME/opencode-cursor-auth/`) | Model catalog, 24 h |
| `~/.cache/opencode-cursor-auth/sessions.json` (same dir) | opencode session to Cursor agent map, 7 days |
| `$TMPDIR/opencode-cursor-XXXXXX/AGENTS.md` | Per-session workspace; system prompt in plaintext |
| `~/.cursor/projects/<slug>` (or `$CURSOR_DATA_DIR/projects/`) | Cursor's agent store and transcripts; removed with the workspace, or swept after 7 idle days |
| `~/.local/share/opencode/auth.json` | opencode's auth registry; for browser login the Cursor entry is a sentinel and the real key lives in the SDK file; a pasted key is stored here |

See the [README](README.md) for more detail.
