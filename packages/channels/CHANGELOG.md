# @wsz987/dsh-channels

## 0.5.1

### Patch Changes

- d0df3dc: Add canonical conversation discovery for access-policy configuration, including
  QQ group OpenID discovery and an explicit Web refresh control. Normalize QQ and
  DingTalk activation facts used by the shared access layer, and update Lark
  interactive question actions to the official Card 2.0 callback-button schema.
- 9d7f651: **QQ native inline keyboard + interaction round-trip for `ask_user_question` (P1).**

  - **`interactiveActions: true`** — QQ adapter now declares native interactive actions: `OutboundMessage.actions` map to the new QQ Markdown inline keyboard (`msg_type=2` + `markdown.content` + `keyboard`, callback action type `1`) and button presses emit a canonical `interaction.received` for the Harness question presenter.
  - **Outbound**: new `toQqKeyboard` mapper (`OutboundActionRow[]` → QQ `InlineKeyboard`); the opaque `uq_*` action id rides in `action.data` (echoed back as `button_data`) and the button `id`; `primary` style maps to QQ style 1, all other styles to default (never invents unsupported values). Media + actions degrades to a plain media send (QQ does not reliably support buttons on media sends) with a debug note.
  - **Inbound**: `QQSdkClient` seam extended with `onInteraction` / `sendMarkdownWithKeyboard` / `acknowledgeInteraction`; the adapter ACKs every interaction within the ~5s platform window (fire-and-forget, before Harness resolution), zod-validates the untrusted `InteractionEvent` slice at the trust boundary, and emits `interaction.received` with the conversation/sender derived from the QQ openids (C2C `user_openid`; group `group_openid` + `group_member_openid`). Ambiguous or invalid payloads fail closed (logged drop, never a guessed event). Authorization stays in `channel-harness`'s Access Gate — the adapter only emits canonical events.
  - **New QQ group activation**: `GROUP_AT_MESSAGE_CREATE` now maps to strict `activation.mentionedBot=true` and strips the leading platform mention marker. An authorized `@机器人 2` answer is consumed by the pending Harness question before ordinary Agent queueing.
  - **Minimal intents**: the Tencent client now passes an explicit `intents` mask (`GROUP_AND_C2C | INTERACTION` = `(1 << 25) | (1 << 26)`) instead of relying on the SDK `FULL_INTENTS` default, per the minimal-intent principle.

  Offline contract suite (Fake QQSdkClient) is green; a real QQ app live gate is still required before production use (button display, press callback, ACK).

- Updated dependencies [d0df3dc]
- Updated dependencies [bb03191]
- Updated dependencies [363e49a]
- Updated dependencies [9d7f651]
- Updated dependencies [9d7f651]
  - @wsz987/channel-core@0.5.1
  - @wsz987/channel-control@0.5.1
  - @wsz987/channel-web@0.5.1
  - @wsz987/channel-qq@0.5.1
  - @wsz987/channel-dingtalk@0.5.1
  - @wsz987/channel-lark@0.5.1
  - @wsz987/channel-harness@0.5.1
  - @wsz987/channel-files@0.5.1
  - @wsz987/channel-telegram@0.5.1
  - @wsz987/channel-weixin@0.5.1

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
- Updated dependencies [6919d3e]
- Updated dependencies [213fd5c]
  - @wsz987/channel-core@0.5.0
  - @wsz987/channel-harness@0.5.0
  - @wsz987/channel-files@0.5.0
  - @wsz987/channel-telegram@0.5.0
  - @wsz987/channel-qq@0.5.0
  - @wsz987/channel-lark@0.5.0
  - @wsz987/channel-dingtalk@0.5.0
  - @wsz987/channel-weixin@0.5.0
  - @wsz987/channel-control@0.5.0
  - @wsz987/channel-web@0.5.0

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
- Updated dependencies [6919d3e]
- Updated dependencies [213fd5c]
  - @wsz987/channel-core@0.5.0-beta.0
  - @wsz987/channel-harness@0.5.0-beta.0
  - @wsz987/channel-files@0.5.0-beta.0
  - @wsz987/channel-telegram@0.5.0-beta.0
  - @wsz987/channel-qq@0.5.0-beta.0
  - @wsz987/channel-lark@0.5.0-beta.0
  - @wsz987/channel-dingtalk@0.5.0-beta.0
  - @wsz987/channel-weixin@0.5.0-beta.0
  - @wsz987/channel-control@0.5.0-beta.0
  - @wsz987/channel-web@0.5.0-beta.0

## 0.4.2

### Patch Changes

- Add Telegram Bot API 10.2 Rich Markdown rendering and draft streaming, generic
  channel actions, callback-query interactions, and the Harness ApiProxy bridge
  for interactive user questions.
- Keep Telegram Rich Markdown byte-limit segmentation fast under concurrent CI
  load by reusing parser source ranges and avoiding redundant serialization.
- Updated dependencies
  - @wsz987/channel-core@0.4.2
  - @wsz987/channel-harness@0.4.2
  - @wsz987/channel-telegram@0.4.2
  - @wsz987/channel-control@0.4.2
  - @wsz987/channel-dingtalk@0.4.2
  - @wsz987/channel-files@0.4.2
  - @wsz987/channel-lark@0.4.2
  - @wsz987/channel-qq@0.4.2
  - @wsz987/channel-web@0.4.2
  - @wsz987/channel-weixin@0.4.2
