# Release Pipeline

The channel release pipeline: Changesets-based
independent versioning, prebuilt publish artifacts, the automated release
workflow and the manual DSH bundle release validation.

## Versioning policy

Every publishable package is versioned **independently** — Changesets is
configured with no `fixed` / `linked` groups
(`.changeset/config.json`, `baseBranch: main`, `access: public`).

| Package                | Version |
| ---------------------- | ------- |
| @wsz987/channel-core      | 0.3.0   |
| @wsz987/channel-harness   | 0.4.2   |
| @wsz987/channel-testkit   | 0.2.0   |
| @wsz987/channel-compat    | 0.2.0   |
| @wsz987/channel-weixin    | 0.8.1   |
| @wsz987/channel-qq        | 0.5.4   |
| @wsz987/channel-dingtalk  | 0.7.0   |
| @wsz987/channel-lark      | 0.6.3   |
| @wsz987/dsh-channels          | 0.9.0   |
| @wsz987/channel-verify    | 0.1.0   |
| @wsz987/channel-telegram  | 0.1.0   |

`apps/*` are private (`"private": true`) and never published.

Internal workspace dependencies are declared as `workspace:*` and rewritten to
the published version by `changeset version` at release time.

## Changesets flow

1. **Describe** — run `pnpm changeset`, pick the affected packages and the
   bump type (patch / minor / major). A markdown file lands in
   `.changeset/*.md`.
2. **Review** — review the changeset file (package list + bump level + summary)
   and merge it to `main` together with the code change.
3. **Version** — run `pnpm changeset version`: consumes pending changesets,
   bumps the version fields, rewrites internal `workspace:*` dependencies
   and updates changelogs.
4. **Tag** — commit the version bump, then push a release tag:
   `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. **Publish** — the tag push runs `.github/workflows/release.yml`, which
   executes `pnpm release` (`changeset publish`) and publishes every
   package whose version is not yet on the npm registry.

Steps 3–5 are the tag-driven release flow (see the workflow section below).

## Prebuilt artifacts

Consumers install prebuilt JavaScript + TypeScript declarations — **nothing on
the consumer side requires TypeScript compilation**:

- **`lib/`** — emitted by `tsc` via `pnpm build` (turbo; `test` and
  `typecheck` depend on `^build` so dependencies are always built first).
- **`exports` map** — every subpath points into `lib/` (`lib/index.js` +
  `lib/index.d.ts`, e.g. `@wsz987/channel-core/plugin` →
  `./lib/plugin.js` / `./lib/plugin.d.ts`).
- **`files` field** — restricts the npm tarball to `lib` (+ `README.md`,
  and `cordis.patch.yml` for the bundle).

`lib/` is gitignored; the release workflow builds before publishing.

## DSH Bundle Validation (v1.1 profile/patch model)

### Automated (offline) gate — `pnpm check:bundle`

`pnpm check:bundle` runs the bundle test suite
(`packages/channels/test/bundle.test.ts`, vitest). It:

1. parses `packages/channels/cordis.patch.yml` (hand-rolled parser, no YAML
   dependency) and asserts the patch inserts exactly the six plugin ids —
   `channels-service`, `channels-harness`, `channels-weixin`,
   `channels-qq`, `channels-dingtalk`, `channels-lark` — with the v1.1
   `inject` lists (`channels-harness` → `[channels, agents, sessionPersistence]`,
   `channels-qq` → `[channels, credentials]`, the rest → `[channels]`);
2. dynamically `import()`s every plugin specifier — this enforces Node ESM
   **exports-map resolution** (`@wsz987/channel-core/plugin` fails the test if
   the subpath export is missing) — and asserts the Cordis plugin shape
   (`name`, `apply`, optional `inject`);
3. asserts each referenced package exists in the workspace and its
   `package.json` `exports` map covers the referenced subpath;
4. asserts every channel adapter's `Config` exposes an `enabled` boolean
   (Schemastery object-schema introspection) so all channels can be disabled
   via config.

The bundle package (`@wsz987/dsh-channels`) is marked as a DSH bundle with the
`dsh.bundle.patch` key pointing at `cordis.patch.yml`. A profile
consumes it via the `dsh.profile.bundles` list, not a hand-written
`plugins:` map (see `apps/example/minimal-profile/`).

`pnpm check:bundle` is wired into the CI governance job.

### Manual release validation (requires the dsh CLI)

The automated gate runs against the workspace packages; the final release
validation installs the bundle into a **clean profile** with the real dsh CLI
(`dsh` below is `npx @deepseek-ai/dsh` when the CLI is not installed globally):

```bash
# 1. add the bundle to a clean profile — `plugin` auto-initializes the
#    profile on first use (never reuse a dirty profile for release validation;
#    there is no `dsh profile create` step)
npx @deepseek-ai/dsh plugin --profile release-validation add @wsz987/dsh-channels

# 2. dump the merged config — verify the six plugins were inserted
npx @deepseek-ai/dsh --profile release-validation --dump-config

# 3. start the profile — all plugins load (channels-service, channels-harness,
#    channels-weixin, channels-qq, channels-dingtalk, channels-lark)
npx @deepseek-ai/dsh --profile release-validation

# 4. override channels via a profile patch (apps/example/minimal-profile/
#    cordis.patch.yml shows a QQ-only override). A patch REPLACES the whole
#    target config (not a deep merge). QQ config uses `appSecretRef` (a
#    credential reference — the real AppSecret lives in ctx.credentials).
npx @deepseek-ai/dsh --profile release-validation
```

See `apps/example/minimal-profile/` for a reference profile (`package.json`
with `dsh.profile.bundles` + `cordis.patch.yml` + `README.md`) showing the
bundle result and the profile-override semantics.

## Publish metadata

Every publishable package carries:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/wsz987/dsh-channels.git"
},
"publishConfig": {
  "access": "public"
}
```

`access: public` lets the `@wsz987/*` scope publish to the public npm registry
without an org token; the repository field links npm back to the source.

## Release checklist (Release DoD)

| DoD item                     | Status | Where |
| ---------------------------- | ------ | ----- |
| independent versions         | ✅     | Changesets config (no fixed/linked) |
| Changesets                   | ✅     | `.changeset/`, `pnpm changeset` / `version` / `release` |
| dependency update PR         | ✅     | Renovate + `.github/workflows/upgrade.yml` |
| clean-profile DSH install    | ⏳     | manual step above — requires the dsh CLI |
| all-in-one bundle            | ✅     | `@wsz987/dsh-channels` + `cordis.patch.yml` |
| example profile              | ✅     | `apps/example/minimal-profile/` |
| architecture docs            | ✅     | `docs/deepseek-harness-channels-architecture.md` |
| adapter authoring docs       | ✅     | `docs/adapter-authoring.md` |

## Weixin release gate (plan R6)

Before a Weixin channel release is declared, every item below must be green.
The gate is split into an **Offline CI** leg (runs on every PR / push to `main`)
and a **Live Platform Gate** (manual only — separation per the R6 "Live 测试不要放
普通 PR" rule).

### Offline CI ✓

- `pnpm build` + `pnpm typecheck` green.
- Full offline test suite (`pnpm test`) green.
- Governance green: `pnpm check:fixtures && pnpm check:manifests && pnpm doctor`
  and `pnpm check:bundle`.

### Harness compatibility ✓

- The pinned @deepseek-ai Harness family stays green against the committed
  `pnpm-lock.yaml` (frozen-lockfile install) — see `ci.yml` and `upgrade.yml`.

### iLink fixtures ✓

- The Weixin iLink fixtures under `fixtures/weixin/` cover the inbound/outbound
  and QR-login protocol surfaces the adapter consumes, and `pnpm check:fixtures`
  passes.

### Persistent restart test ✓

- Credentials cursor + context state survive a process restart (no re-login /
  no cursor reset / no duplicate replay after restart).

### Real Weixin Text smoke ✓ (Live Platform Gate)

- A real-Weixin **Text** round-trip succeeds via the live E2E
  (`packages/channel-weixin/test/live/`, only runs with `DSH_WEIXIN_LIVE=1`).
- The live gate is **`workflow_dispatch`-only** (never PR/CI) or a protected
  release environment — see `.github/workflows/live-weixin.yml`, which stays
  inert until the `WEIXIN_LIVE_ENABLED` repository secret is set to `'true'`.

### Manifest pinned ✓

- `packages/channel-weixin/src/manifest.ts` must NOT claim `status: 'tested'`
  before the live gate passes — it stays `'experimental'` until then, and
  `upstream.testedVersion` / `upstream.testedCommit` stay pending (filled only
  after live verification).
- `versionRange` must be pinned to the verified commit/range — do NOT keep
  `versionRange: '*'` long-term (doc R6 "不要保留 versionRange: '*' 长期").

### README ✓

- `packages/channel-weixin/README.md` reflects the actual (verified) support
  matrix and does not over-advertise unverified capabilities.

### Text-only release caveat (until WX5 lands)

Until WX5 (image/audio/file/video media paths) completes, a **Text-only** Weixin
release is allowed, but it must be explicit:

```ts
image: false
audio: false
file: false
video: false
```

Such a release must NOT be advertised as a full Weixin media channel — it is a
Text-only channel until the live media smoke passes.

## `.github/workflows/release.yml`

Tag-driven publish — it runs **only when a `v*` release tag is pushed** (or via
`workflow_dispatch`); normal commits and PRs do not trigger it:

1. checkout + pnpm 9.15.3 + Node 22 (cache pnpm);
2. `pnpm install --frozen-lockfile`;
3. `pnpm build` — `lib/` is gitignored, so packages are built before
   publishing (the tarball ships prebuilt JS + types);
4. writes `~/.npmrc` from `NPM_TOKEN`;
5. `pnpm release` (`changeset publish`) — publishes every package whose
   current version is not yet on npm.

The workflow **stays inert until the `NPM_TOKEN` repository secret is
configured**: without registry credentials the publish step cannot run (it only
ever publishes packages whose version is not yet on npm). Set `NPM_TOKEN` to an
npm automation token with publish rights for the `@wsz987` scope to activate it.
