---
'@wsz987/dsh-channels': minor
'@wsz987/channel-core': minor
'@wsz987/channel-control': minor
'@wsz987/channel-files': minor
'@wsz987/channel-harness': minor
'@wsz987/channel-web': minor
'@wsz987/channel-weixin': minor
'@wsz987/channel-qq': minor
'@wsz987/channel-dingtalk': minor
'@wsz987/channel-lark': minor
'@wsz987/channel-telegram': minor
---

**DeepSeek Harness `0.1.1-rc.2` baseline — opens the 0.5.x release line (BREAKING).**

0.5.x is version-line compatible with Harness `0.1.1-rc.2`, not runtime dual-compatible: users on Harness `0.1.0-rc.7` should stay on the 0.4.x line (`@wsz987/dsh-channels@0.4.2`). See `docs/compatibility-matrix.md` for the compatibility and verification matrix.

BREAKING:

- **Minimum Harness `0.1.1-rc.2`.** Every `@deepseek-ai/dsh-*` declaration is now the exact tested version `0.1.1-rc.2` (dependencies, devDependencies and peerDependencies — no `^`/ranges). Peer ranges no longer claim unverified prereleases as compatible; a verified newer Harness widens the explicit OR band (`0.1.1-rc.2 || <next-tested>`), never a caret. `channel-harness` adds the `dsh-host-apiproxy` and `dsh-user-questions` peers.
- **Minimum Node 22.19** (`engines: ^22.19.0 || >=24.0.0`), aligned with the official rc.2 runtime.
- **Unknown slash commands are no longer sent to the model.** A syntactically valid but unregistered `/command` now gets a direct channel notice (`未知命令：/foo…`), matching the rc.2 official Host `unknown-command` semantics. There is no opt-back to the legacy fall-through.
- **Legacy image compatibility removed.** The `imageCompatibility` config and the channel-side image rewrite are gone. Whether the current model sees an image (vision variant vs. deterministic text placeholder) is decided by the official Harness Image Pipeline at request projection; the durable session history keeps the original image attachment. Vision, text-only and DeepSeek Files paths need no channel-side special-casing.
- **Web client requires the rc.2 client module graph.** `dsh.client.inject` is now only `["@deepseek-ai/dsh-client-locale"]`; `react`, `cordis`, `dsh-client-ui-primitives` and `dsh-client-ui-slots` are static shell identities and are no longer dynamically injected. Web clients older than the rc.2 module graph cannot load the Channels panel.

Features / refactors:

- **New-version check (prompt-only).** `channel-control` periodically checks the npm dist-tags of `@wsz987/dsh-channels` (24h TTL cache in the channel storage, offline/timeout/corrupt responses tolerated silently, zod-validated registry input; configurable via `channels-control.updateCheck`). When a newer version exists (stable installs compare against `latest`; prerelease installs against max(latest, next)), Web Settings → Channels shows an upgrade banner and the new `/version` channel command prints the bundle version, the Harness tested baseline and the same hint — two-step commands when crossing a release line, a single `plugin update` within the line. It only ever prompts; nothing is installed automatically, and the browser never contacts npm (it reads a sanitized host-side DTO via `GET /dsh-channels/api/v2/update-check`). `@wsz987/channel-control` is part of this lockstep bump so its own package version keeps tracking the installed bundle version.
- **Question interactions rebuilt** (`channel-harness/src/interactions/`): one presenter, two official backends — Web profiles answer through the official ApiProxy mux contract, headless deployments register the channel as the official `UserQuestionProvider`. Uses the official domain model and schema (the hand-written protocol clone is removed), passes `intent` through, and headless no longer simulates an ApiProxy.
- **Official Host RPC types.** Model selection and host-facing RPC surfaces use the official `@deepseek-ai/dsh-host-apiproxy` types; the duplicated hand-written type layer is removed.
- **Session compatibility verified.** `ReplyRouter` passes the rc.2 session contract fixtures (16 cases) with zero implementation drift; persisted-resume and missing-binding paths follow the rc.2 session semantics.
- **Governance follows the tested baseline, not npm `latest`.** `check:upstream` gates the `dsh-*` family against `HARNESS_TESTED_VERSION` (exact pins; registry must publish the baseline; rc residue or ranged peers fail). New `pnpm check:harness-compat` entry point and the non-blocking `pnpm check:harness-newer` report for versions published above the baseline; both are wired into `pnpm ci:check`.
