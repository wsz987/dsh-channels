# @wsz987/channel-qq

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

- 9d7f651: **QQ native inline keyboard + interaction round-trip for `ask_user_question` (P1).**

  - **`interactiveActions: true`** — QQ adapter now declares native interactive actions: `OutboundMessage.actions` map to the new QQ Markdown inline keyboard (`msg_type=2` + `markdown.content` + `keyboard`, callback action type `1`) and button presses emit a canonical `interaction.received` for the Harness question presenter.
  - **Outbound**: new `toQqKeyboard` mapper (`OutboundActionRow[]` → QQ `InlineKeyboard`); the opaque `uq_*` action id rides in `action.data` (echoed back as `button_data`) and the button `id`; `primary` style maps to QQ style 1, all other styles to default (never invents unsupported values). Media + actions degrades to a plain media send (QQ does not reliably support buttons on media sends) with a debug note.
  - **Inbound**: `QQSdkClient` seam extended with `onInteraction` / `sendMarkdownWithKeyboard` / `acknowledgeInteraction`; the adapter ACKs every interaction within the ~5s platform window (fire-and-forget, before Harness resolution), zod-validates the untrusted `InteractionEvent` slice at the trust boundary, and emits `interaction.received` with the conversation/sender derived from the QQ openids (C2C `user_openid`; group `group_openid` + `group_member_openid`). Ambiguous or invalid payloads fail closed (logged drop, never a guessed event). Authorization stays in `channel-harness`'s Access Gate — the adapter only emits canonical events.
  - **New QQ group activation**: `GROUP_AT_MESSAGE_CREATE` now maps to strict `activation.mentionedBot=true` and strips the leading platform mention marker. An authorized `@机器人 2` answer is consumed by the pending Harness question before ordinary Agent queueing.
  - **Minimal intents**: the Tencent client now passes an explicit `intents` mask (`GROUP_AND_C2C | INTERACTION` = `(1 << 25) | (1 << 26)`) instead of relying on the SDK `FULL_INTENTS` default, per the minimal-intent principle.

  Offline contract suite (Fake QQSdkClient) is green; a real QQ app live gate is still required before production use (button display, press callback, ACK).

### Patch Changes

- d0df3dc: Add canonical conversation discovery for access-policy configuration, including
  QQ group OpenID discovery and an explicit Web refresh control. Normalize QQ and
  DingTalk activation facts used by the shared access layer, and update Lark
  interactive question actions to the official Card 2.0 callback-button schema.
- Updated dependencies [f085a55]
- Updated dependencies [d0df3dc]
- Updated dependencies [213fd5c]
  - @wsz987/channel-core@0.5.1
  - @wsz987/channel-control@0.5.1

## 0.4.2

### Patch Changes

- Updated dependencies
  - @wsz987/channel-core@0.4.2
  - @wsz987/channel-control@0.4.2
