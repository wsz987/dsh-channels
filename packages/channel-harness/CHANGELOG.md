# @wsz987/channel-harness

## 0.5.1

### Minor Changes

- f085a55: **Attachment Gateway (P0/P1): directional media capabilities + Generic Attachment compatibility backend.**

  - **Directional `capabilities.media`** (`channel-core`) joins the legacy coarse
    `image` / `file` / `audio` / `video` booleans: per kind, inbound is
    `'bytes' | 'locator' | 'unsupported'` and outbound is `'bytes' | 'unsupported'`.
    `channel-verify` checks it whenever a kind claims `'bytes'`.
  - **Inbound binary hydration extended to audio/video** across Telegram, QQ,
    DingTalk and Weixin (DingTalk keeps a `locator` verdict pending a real-account
    live gate; Lark follows its official media API verdict).
  - **Provider rename** (`channel-harness`): `ChannelFileProvider` →
    `ChannelAttachmentProvider`, with the `ChannelFile*` names kept as deprecated
    aliases and `installTools` → the optional `installCompatibilityTools`.
  - **`channel-files` is the Generic Attachment compatibility backend**: legacy
    PDF/DOCX/XLSX/TXT extraction is retained, Attachment Catalog v2 and the
    copy+verify migration infrastructure ship **default-off**, and legacy
    `attachments/v1` data stays permanently readable (never rewritten or deleted).

  No breaking changes: legacy capability booleans, `ChannelFile*` exports and
  existing tool registration semantics remain available.

- 213fd5c: **DeepSeek Harness `0.1.5-rc.2` baseline — opens the 0.5.x release line (BREAKING).**

  0.5.x is version-line compatible with Harness `0.1.5-rc.2`, **not** runtime
  dual-compatible: on Harness `0.1.0-rc.7` / `0.1.1-rc.2` stay on
  `@wsz987/dsh-channels@0.4.2`. Upgrade the Harness CLI first, then reinstall the
  bundle. Full version/Node matrix and the per-scenario verification table live in
  [`docs/compatibility-matrix.md`](https://github.com/wsz987/dsh-channels/blob/main/docs/compatibility-matrix.md);
  the rc.1/rc.2 API diff record is in
  [`docs/harness-0.5.x-migration-plan.md`](https://github.com/wsz987/dsh-channels/blob/main/docs/harness-0.5.x-migration-plan.md).

  What breaking changes require attention on upgrade:

  - **Minimum Harness `0.1.5-rc.2`** (exact pins, no carets) and **minimum Node 22.19**.
  - **ApiProxy is gone** — the `channels-harness` inject no longer lists it; host
    model selection goes through `ctx.sessionController`.
  - **User Questions ride the official `user-questions/request` waterfall** — the
    ApiProxy mux and direct `UserQuestionProvider` backends are retired; a declined
    channel presentation delegates via `next()`.
  - **Durable reads use `sessionPersistence.open(id, 'read')`** — `persistence.inspect()`
    and `Session.events` are gone (`snapshotEvents()` instead).
  - **Unknown slash commands are rejected** instead of reaching the model.
  - Remove `imageCompatibility` from any existing config; image visibility is now
    decided entirely by the official Harness Image Pipeline.

  Also in this line: `/version` plus a prompt-only Web update check, `/mirror on|off`
  (opt-in web-turn mirroring, issue #5), `/bind <id> [confirm]` (issue #6), working
  outbound image sends through the channel asset store (issue #7), and durable
  bindings that survive restarts (issue #8).

### Patch Changes

- 6919d3e: Channel-triggered Harness turns that terminate with
  `turn/end.reason.kind = "error"` now return a safe terminal failure notice to
  the originating channel. `AUTH` failures hide raw provider diagnostics and
  display `API key is invalid`. No-output terminal turns also stop typing
  indicators correctly. Structured `QUOTA` diagnostics prefer their validated
  provider message over the raw status and JSON envelope.
- bb03191: Restrict every group-chat slash command to the access policy owner. Missing or
  mismatched owner identity now denies the command before `/stop`, session,
  binding, workspace, or Agent side effects while leaving ordinary group messages
  under the existing access policy.
- 9d7f651: `ask_user_question` 统一文本兜底（P0）：`interactiveActions` 不再作为问题准入条件，
  只要渠道 `text: true` 即可通过编号文字完成问答；`interactiveActions: true` 仅升级为
  原生按钮展示。非按钮渠道（Weixin / QQ / DingTalk / Lark）现在会收到编号选项文本
  （`1. xxx`，无 description 也始终渲染），支持数字 / 选项文字 / 自定义 / `跳过` /
  多选 `1,3` 回答；群聊文字回答支持平台 `replyTo` 或每道题生成的短关联码
  （`Q-XXXXXX`）两种关联方式；越界多选输入提示重新输入而不取消整个问题。
  Telegram 原生按钮 + ForceReply 路径保持不变。
- Updated dependencies [f085a55]
- Updated dependencies [d0df3dc]
- Updated dependencies [213fd5c]
  - @wsz987/channel-core@0.5.1

## 0.5.0

### Minor Changes

- f085a55: **Attachment Gateway (P0/P1): directional media capabilities + Generic Attachment compatibility backend.**

  - **Directional `capabilities.media`** (`channel-core`): an optional per-kind media map is added to `ChannelCapabilities` — inbound `'bytes' | 'locator' | 'unsupported'`, outbound `'bytes' | 'unsupported'` — alongside the legacy coarse `image` / `file` / `audio` / `video` booleans (retained for compatibility). `channel-verify` now checks `capabilities.media` when a kind claims `'bytes'` (fixtures must prove `localData` before emit).
  - **Inbound binary hydration extended to audio/video**: Telegram, QQ, DingTalk and Weixin best-effort hydrate inbound audio/video to `localData`; DingTalk keeps its public audio/video verdict at `locator` pending official documentation plus a real-account live gate. Lark follows its official media API verdict. Hydration runs through the shared protocol-agnostic `applyHydrationResult` helper (`channel-core` media/hydration).
  - **Provider rename** (`channel-harness`): `ChannelFileProvider` → `ChannelAttachmentProvider` is now the canonical name, with deprecated `ChannelFile*` aliases (`ChannelFileProvider` / `ChannelFileContext` / `ChannelFileDescriptor`) retained; `installTools` becomes the optional `installCompatibilityTools` (keeps registering `read_channel_attachment` as a compatibility tool).
  - **channel-files as Generic Attachment compatibility backend**: session-scoped storage keeps legacy PDF/DOCX/XLSX/TXT extraction as compatibility behavior. Attachment Catalog v2 (`attachments/catalog/v2`), a native capability seam (interface + fake only) and lazy copy+verify migration infrastructure are added **default-off**, to be activated via public capability detection once Harness ships an official native generic attachment surface. Legacy `attachments/v1` remains permanently readable and is never rewritten or deleted on upgrade.
  - Multi-channel binary ingress contract runner (`runBinaryIngressContract`) is added to `channel-testkit`.

  No breaking changes: legacy capability booleans, `ChannelFile*` exports and existing tool registration semantics remain available.

- 213fd5c: **DeepSeek Harness `0.1.1-rc.2` baseline — opens the 0.5.x release line (BREAKING).**

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

### Patch Changes

- 6919d3e: Channel-triggered Harness turns that terminate with
  `turn/end.reason.kind = "error"` now return a safe terminal failure notice to
  the originating channel. `AUTH` failures hide raw provider diagnostics and
  display `API key is invalid`. No-output terminal turns also stop typing
  indicators correctly. Structured `QUOTA` diagnostics prefer their validated
  provider message over the raw status and JSON envelope.
- Updated dependencies [f085a55]
- Updated dependencies [213fd5c]
  - @wsz987/channel-core@0.5.0

## 0.5.0-beta.0

### Minor Changes

- f085a55: **Attachment Gateway (P0/P1): directional media capabilities + Generic Attachment compatibility backend.**

  - **Directional `capabilities.media`** (`channel-core`): an optional per-kind media map is added to `ChannelCapabilities` — inbound `'bytes' | 'locator' | 'unsupported'`, outbound `'bytes' | 'unsupported'` — alongside the legacy coarse `image` / `file` / `audio` / `video` booleans (retained for compatibility). `channel-verify` now checks `capabilities.media` when a kind claims `'bytes'` (fixtures must prove `localData` before emit).
  - **Inbound binary hydration extended to audio/video**: Telegram, QQ, DingTalk and Weixin best-effort hydrate inbound audio/video to `localData`; DingTalk keeps its public audio/video verdict at `locator` pending official documentation plus a real-account live gate. Lark follows its official media API verdict. Hydration runs through the shared protocol-agnostic `applyHydrationResult` helper (`channel-core` media/hydration).
  - **Provider rename** (`channel-harness`): `ChannelFileProvider` → `ChannelAttachmentProvider` is now the canonical name, with deprecated `ChannelFile*` aliases (`ChannelFileProvider` / `ChannelFileContext` / `ChannelFileDescriptor`) retained; `installTools` becomes the optional `installCompatibilityTools` (keeps registering `read_channel_attachment` as a compatibility tool).
  - **channel-files as Generic Attachment compatibility backend**: session-scoped storage keeps legacy PDF/DOCX/XLSX/TXT extraction as compatibility behavior. Attachment Catalog v2 (`attachments/catalog/v2`), a native capability seam (interface + fake only) and lazy copy+verify migration infrastructure are added **default-off**, to be activated via public capability detection once Harness ships an official native generic attachment surface. Legacy `attachments/v1` remains permanently readable and is never rewritten or deleted on upgrade.
  - Multi-channel binary ingress contract runner (`runBinaryIngressContract`) is added to `channel-testkit`.

  No breaking changes: legacy capability booleans, `ChannelFile*` exports and existing tool registration semantics remain available.

- 213fd5c: **DeepSeek Harness `0.1.1-rc.2` baseline — opens the 0.5.x release line (BREAKING).**

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

### Patch Changes

- 6919d3e: Channel-triggered Harness turns that terminate with
  `turn/end.reason.kind = "error"` now return a safe terminal failure notice to
  the originating channel. `AUTH` failures hide raw provider diagnostics and
  display `API key is invalid`. No-output terminal turns also stop typing
  indicators correctly. Structured `QUOTA` diagnostics prefer their validated
  provider message over the raw status and JSON envelope.
- Updated dependencies [f085a55]
- Updated dependencies [213fd5c]
  - @wsz987/channel-core@0.5.0-beta.0

## 0.4.2

### Patch Changes

- Add Telegram Bot API 10.2 Rich Markdown rendering and draft streaming, generic
  channel actions, callback-query interactions, and the Harness ApiProxy bridge
  for interactive user questions.
- Updated dependencies
  - @wsz987/channel-core@0.4.2
