# Release Pipeline

Phase 16 of the execution plan
(`docs/deepseek-harness-channels-execution-plan.md`): Changesets-based
independent versioning, prebuilt publish artifacts, the automated release
workflow and the manual DSH bundle release validation (Task 16.3).

## Versioning policy

Every publishable package is versioned **independently** — Changesets is
configured with no `fixed` / `linked` groups
(`.changeset/config.json`, `baseBranch: main`, `access: public`).

| Package                | Version |
| ---------------------- | ------- |
| @dsh/channel-core      | 0.3.0   |
| @dsh/channel-harness   | 0.4.2   |
| @dsh/channel-testkit   | 0.2.0   |
| @dsh/channel-compat    | 0.2.0   |
| @dsh/channel-weixin    | 0.8.1   |
| @dsh/channel-qq        | 0.5.4   |
| @dsh/channel-dingtalk  | 0.7.0   |
| @dsh/channel-lark      | 0.6.3   |
| @dsh/channels          | 0.9.0   |
| @dsh/channel-verify    | 0.1.0   |
| @dsh/channel-telegram  | 0.1.0   |

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
  `lib/index.d.ts`, e.g. `@dsh/channel-core/plugin` →
  `./lib/plugin.js` / `./lib/plugin.d.ts`).
- **`files` field** — restricts the npm tarball to `lib` (+ `README.md`,
  and `cordis.patch.yml` for the bundle).

`lib/` is gitignored; the release workflow builds before publishing.

## DSH Bundle Validation (Task 16.3, v1.1 profile/patch model)

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
   **exports-map resolution** (`@dsh/channel-core/plugin` fails the test if
   the subpath export is missing) — and asserts the Cordis plugin shape
   (`name`, `apply`, optional `inject`);
3. asserts each referenced package exists in the workspace and its
   `package.json` `exports` map covers the referenced subpath;
4. asserts every channel adapter's `Config` exposes an `enabled` boolean
   (Schemastery object-schema introspection) so all channels can be disabled
   via config.

The bundle package (`@dsh/channels`) is marked as a DSH bundle with the
`dsh.bundle.patch` key pointing at `cordis.patch.yml` (v1.1 §38). A profile
consumes it via the `dsh.profile.bundles` list, not a hand-written
`plugins:` map (see `apps/example/minimal-profile/`).

`pnpm check:bundle` is wired into the CI governance job.

### Manual release validation (requires the dsh CLI)

The automated gate runs against the workspace packages; the final release
validation installs the bundle into a **clean profile** with the real dsh CLI:

```bash
# 1. clean profile — never reuse a dirty profile for release validation
dsh profile create release-validation

# 2. add the bundle (installs it into dsh.profile.bundles and applies
#    cordis.patch.yml to the clean profile)
dsh plugin --profile release-validation add @dsh/channels

# 3. dump the merged config — verify the six plugins were inserted
dsh --profile release-validation --dump-config

# 4. start the profile — all plugins load (channels-service, channels-harness,
#    channels-weixin, channels-qq, channels-dingtalk, channels-lark)
dsh --profile release-validation

# 5. override channels via a profile patch (apps/example/minimal-profile/
#    cordis.patch.yml shows a QQ-only override). A patch REPLACES the whole
#    target config (not a deep merge). QQ config uses `appSecretRef` (a
#    credential reference — the real AppSecret lives in ctx.credentials).
dsh --profile release-validation
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

`access: public` lets the `@dsh/*` scope publish to the public npm registry
without an org token; the repository field links npm back to the source.

## Release checklist (plan §25 Release DoD)

| DoD item                     | Status | Where |
| ---------------------------- | ------ | ----- |
| independent versions         | ✅     | Changesets config (no fixed/linked) |
| Changesets                   | ✅     | `.changeset/`, `pnpm changeset` / `version` / `release` |
| dependency update PR         | ✅     | Renovate + `.github/workflows/upgrade.yml` (Phase 15) |
| clean-profile DSH install    | ⏳     | manual step above — requires the dsh CLI |
| all-in-one bundle            | ✅     | `@dsh/channels` + `cordis.patch.yml` |
| example profile              | ✅     | `apps/example/minimal-profile/` |
| architecture docs            | ✅     | `docs/deepseek-harness-channels-architecture.md` |
| adapter authoring docs       | ✅     | `docs/adapter-authoring.md` |

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
npm automation token with publish rights for the `@dsh` scope to activate it.
