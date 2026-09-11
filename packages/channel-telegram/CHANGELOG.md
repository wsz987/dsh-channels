# @wsz987/channel-telegram

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

- Updated dependencies [f085a55]
- Updated dependencies [d0df3dc]
- Updated dependencies [213fd5c]
  - @wsz987/channel-core@0.5.1
  - @wsz987/channel-control@0.5.1

## 0.4.2

### Patch Changes

- Add Telegram Bot API 10.2 Rich Markdown rendering and draft streaming, generic
  channel actions, callback-query interactions, and the Harness ApiProxy bridge
  for interactive user questions.
- Keep Rich Markdown byte-limit segmentation fast under concurrent CI load by
  reusing parser source ranges and avoiding redundant block serialization.
- Updated dependencies
  - @wsz987/channel-core@0.4.2
  - @wsz987/channel-control@0.4.2
