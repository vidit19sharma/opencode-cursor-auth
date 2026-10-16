# Releasing @vidit19sharma/opencode-cursor-auth

npm account: `vidit19sharma` (2FA = security key, so publishing always needs one browser tap).
This file is a maintainer doc; it is not in the npm tarball.

## 1. Gates (all green, clean tree)

```sh
bun run build                    # tsc → dist/
bun test spike/plugin.test.ts    # network-free plugin tests
bun run test:cli                 # npx setup/update against temp config dirs
bun spike/e2e-bridge.ts          # real Cursor account, uses real usage, ~12 min
bun run smoke                    # packs the plugin and loads it in a pristine HOME
```

CI (`.github/workflows/ci.yml`) runs the first three plus the single-default-export check; the e2e suite and smoke need a Cursor account and run locally only.
Check the tarball with `npm pack --dry-run` (dist/*, README.md, installation.md, CHANGELOG.md, LICENSE, package.json).

## 2. Version, commit, tag

```sh
# update CHANGELOG.md, bump "version" in package.json to X.Y.Z
git commit -am "chore: release X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main vX.Y.Z
```

Never publish from a dirty tree.

## 3. Publish (maintainer's own terminal)

```sh
npm whoami                      # should print: vidit19sharma  (if 401 -> run: npm login)
npm publish --access public     # browser opens -> tap security key
```

Success looks like `+ @vidit19sharma/opencode-cursor-auth@X.Y.Z`.

- `npm login`: browser opens -> log in -> tap key. `npm whoami` returning 401 just means log in again.
- Browser does not open: npm prints `https://www.npmjs.com/auth/cli/<id>`; open it manually. Single-use, expires in minutes; rerun if expired.

## 4. Pick it up locally

```sh
npx @vidit19sharma/opencode-cursor-auth@latest update   # drops opencode's cached copy
```

Then restart opencode.

## Broken release

```sh
npm deprecate @vidit19sharma/opencode-cursor-auth@X.Y.Z "broken: use X.Y.Z+1"
```

Then ship a fixed patch release through the steps above.

## Never

- Never paste an npm token into chat. Tokens that bypass 2FA are deprecated anyway.
