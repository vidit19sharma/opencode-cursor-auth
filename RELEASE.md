# Releasing @vidit19sharma/opencode-cursor-auth

npm account: `vidit19sharma` (2FA = security key, so publishing always needs one browser tap).
This file is a maintainer doc; it is not in the npm tarball.

## 1. Gates (all green, clean tree)

```sh
bun run build                    # tsc → dist/
bun run test                     # offline: plugin unit tests, bridge unit tests, CLI tests (runs in CI)
bun run test:e2e                 # bun spike/e2e-bridge.ts: real Cursor account, Tests 0-32, ~12 min, spends quota
bun run smoke                    # fresh-HOME install smoke, 3 checks
bun run test:cli                 # npx setup/update against temp config dirs
```

CI (`.github/workflows/ci.yml`) runs the build, the offline suites and the single-default-export check; e2e and smoke need a Cursor account and run locally only.
Check the tarball with `npm pack --dry-run` (dist/*, README.md, installation.md, CHANGELOG.md, LICENSE, package.json).

## 2. Version, commit, tag

```sh
# update CHANGELOG.md, bump "version" in package.json to X.Y.Z
git commit -am "chore: release X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main vX.Y.Z
```

Never publish from a dirty tree. Only tag a version you are about to publish: v0.3.0, v0.3.5 and v0.3.6 were tagged but never published, so the GitHub tags name versions npm does not have.

## 3. Publish (maintainer's own terminal)

Publish only after CI is green for the tagged commit (CI runs on pushes to `main`, not on tags: `gh run list --commit "$(git rev-parse vX.Y.Z^{commit})"` or the Actions tab).

```sh
npm whoami                      # should print: vidit19sharma  (if 401 -> run: npm login)
npm publish --access public     # browser opens -> tap security key
```

Success looks like `+ @vidit19sharma/opencode-cursor-auth@X.Y.Z`.

- `npm login`: browser opens -> log in -> tap key. `npm whoami` returning 401 just means log in again.
- Browser does not open: npm prints `https://www.npmjs.com/auth/cli/<id>`; open it manually. Single-use, expires in minutes; rerun if expired.

Then create the GitHub Release from the CHANGELOG section (or paste it in the web UI):

```sh
gh release create vX.Y.Z --title vX.Y.Z \
  --notes-file <(awk '/^## X\.Y\.Z /{f=1;next} /^## /{f=0} f' CHANGELOG.md)
```

## 4. Pick it up locally

```sh
npx @vidit19sharma/opencode-cursor-auth@latest update   # drops opencode's cached copy
```

Then restart opencode.

## Broken release

```sh
npm deprecate "@vidit19sharma/opencode-cursor-auth@X.Y.Z" "<reason>; upgrade to latest"
```

Point at "latest", not a specific version, so the message never goes stale.

Then ship a fixed patch release through the steps above.

## Never

- Never paste an npm token into chat. Tokens that bypass 2FA are deprecated anyway.
