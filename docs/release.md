---
title: 发布流程
summary: Changesets 独立发版、预构建产物、上游更新策略与 release gate。
when_to_use: 发版 | changeset | release gate | 版本 | 发布
authoritative: 版本策略、Changesets 流程、上游更新策略、DSH Bundle 校验、Weixin release gate、release.yml 流程。
see_also: [architecture.md, weixin-live-verification-runbook.md]
status: as-built
---

# Release Pipeline

The channel release pipeline: Changesets-based
independent versioning, prebuilt publish artifacts, the automated release
workflow and the manual DSH bundle release validation.

## Versioning policy

Every release-family package is versioned **independently** — Changesets is
configured with no `fixed` / `linked` groups
(`.changeset/config.json`, `baseBranch: main`, `access: public`).

The automated release family is an explicit allowlist: the bundle plus its ten
runtime dependencies (`channel-core`, `channel-harness`, `channel-control`,
`channel-files`, `channel-web`, the five built-in adapters, and Telegram). The
ignored development/governance packages (`channel-compat`, `channel-testkit`,
`channel-verify`) are not packed or published by this workflow.

| Package                | Version |
| ---------------------- | ------- |
| @wsz987/channel-core      | 0.3.0   |
| @wsz987/channel-harness   | 0.4.2   |
| @wsz987/channel-control   | 0.1.0   |
| @wsz987/channel-files     | 0.1.0   |
| @wsz987/channel-web       | 0.1.0   |
| @wsz987/channel-weixin    | 0.8.1   |
| @wsz987/channel-qq        | 0.5.4   |
| @wsz987/channel-dingtalk  | 0.7.0   |
| @wsz987/channel-lark      | 0.6.3   |
| @wsz987/dsh-channels      | 0.9.0   |

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
   verifies and packs every public workspace package, then publishes those
   exact tarballs with npm Trusted Publishing. Versions already present on npm
   are skipped so a partial release can be retried safely.

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

## Upstream update strategy

Keep each adapter in sync with its official upstream SDK / package / protocol
source without silently drifting onto untested code:

```text
Upstream new version
       ↓
Renovate PR
       ↓
typecheck
       ↓
adapter contract
       ↓
payload fixtures
       ↓
adapter-specific tests
       ↓
Harness compatibility
       ↓
E2E
       ↓
update testedVersion
```

禁止：

```text
依赖 latest
+
未经测试自动部署
```

## DSH Bundle Validation

### Automated (offline) gate — `pnpm check:bundle`

`pnpm check:bundle` runs the bundle test suite
(`packages/channels/test/bundle.test.ts`, vitest). It:

1. parses `packages/channels/cordis.patch.yml` (hand-rolled parser, no YAML
   dependency) and asserts the patch inserts exactly the ten plugin ids —
   `channels-service`, `channels-files`, `channels-harness`,
   `channels-control`, `channels-weixin`, `channels-qq`,
   `channels-dingtalk`, `channels-lark`, `channels-telegram`,
   `channels-web` — with their
   `inject` lists (`channels-harness` → `[channels, agents, agentDefaultModel,
   commands]`, `channels-control` → `[channels, credentials]`, the channel
   adapters → `[channels, (credentials,) channelControl]`);
2. dynamically `import()`s every bundle-owned plugin specifier — this enforces
   Node ESM **exports-map resolution** (`@wsz987/dsh-channels/service`, etc.)
   and asserts the Cordis plugin shape
   (`name`, `apply`, optional `inject`);
3. asserts every patch row resolves through the bundle package itself, so a
   profile needs only `@wsz987/dsh-channels` as a direct dependency, and checks
   that its `package.json` `exports` map covers every referenced subpath;
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
npx @deepseek-ai/dsh plugin --profile release-validation add -w @wsz987/dsh-channels@latest

# 2. dump the merged config — verify the ten plugins were inserted
npx @deepseek-ai/dsh --profile release-validation --dump-config

# 3. start the profile — all plugins load (channels-service, channels-files,
#    channels-harness, channels-control, channels-weixin, channels-qq,
#    channels-dingtalk, channels-lark, channels-telegram, channels-web)
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
  "url": "git+https://github.com/wsz987/dsh-channels.git"
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
| architecture docs            | ✅     | `docs/architecture.md` + `docs/architecture/*.md` |
| adapter authoring docs       | ✅     | `docs/adapter-authoring.md` |

## Weixin release gate

Before a Weixin channel release is declared, every item below must be green.
The gate is split into an **Offline CI** leg (runs on every PR / push to `main`)
and a **Live Platform Gate** (manual only — live 测试不放在普通 PR)。

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
  `versionRange: '*'` long-term.

### README ✓

- 根 `README.md` 的「渠道总览」反映实际（已验证）能力矩阵：微信保持
  `experimental` 且不夸大未验证能力（live gate 通过前不得标 `tested`）。

### Media caveat

微信图片 / 通用文件路径已随实现落地（见 README 渠道总览），但在 live 验收通过前，
`status` 仍保持 `experimental`，不得在 manifest 或文档中把未通过 live 验证的能力
写成 `tested` / 已官方验证。

## `.github/workflows/release.yml`

Tag-driven publish — validation also supports `workflow_dispatch`, but npm
publication runs **only when a `v*` release tag is pushed**. Normal commits and
PRs do not trigger it:

1. checkout + pnpm 9.15.3 + Node 22 (cache pnpm);
2. `pnpm install --frozen-lockfile`;
3. verifies release metadata and requires the `v*` tag to match the independently
   versioned `@wsz987/dsh-channels` bundle;
4. runs release-script tests, build, typecheck, the full test suite, fixtures,
   manifests, doctor and bundle validation;
5. packs the ten allowlisted release-family packages in dependency order,
   checks the packed manifests and records SHA-512 checksums;
6. uploads the exact tarballs and downloads them in an isolated publish job;
7. installs npm 11.5.1 and publishes missing versions with npm Trusted
   Publishing. Prerelease bundle versions use the `beta` dist-tag, stable
   versions use `latest`, and `NPM_DIST_TAG` can explicitly override either.

Every published package must configure npm Trusted Publishing for GitHub user
`wsz987`, repository `dsh-channels`, workflow `release.yml`, environment
`npm-publish`, and the `npm publish` action. Only the publish job receives
`id-token: write`; no long-lived `NPM_TOKEN` is used.

Already-published versions are skipped to make partial releases retryable. This
workflow intentionally does not promote an existing prerelease version between
dist-tags. A stable release must have a new stable SemVer (without a prerelease
suffix); it is then published under `latest`, while prerelease versions use
`beta`.
