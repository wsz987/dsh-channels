---
'@wsz987/dsh-channels': minor
'@wsz987/channel-core': minor
'@wsz987/channel-harness': minor
'@wsz987/channel-control': minor
'@wsz987/channel-web': minor
'@wsz987/channel-weixin': minor
'@wsz987/channel-qq': minor
'@wsz987/channel-dingtalk': minor
'@wsz987/channel-lark': minor
'@wsz987/channel-telegram': minor
'@wsz987/channel-testkit': minor
---

**Inbound Access Control (BREAKING SECURITY CHANGE)** — Fail-Closed, Owner-aware enforcement for all external inbound messages.

- **Unified Access Gate in `channel-harness`**: every `message.received` now passes Reserved Claim suppression → identity validation → access-policy resolution → security authorization → activation gate, **before** `/stop`, command dispatch, session/binding/workspace creation and any Agent side effect. No valid policy, a corrupt policy, an unknown sender or an unknown group all fail closed (silent drop + structured `channel-access` log, never an attacker-revealing reply).
- **Shared versioned policy contract in `channel-core`**: `ChannelAccessPolicy` (version 1) + zod schema + `access:policy:v1:<channel>:<account>` storage key + `MessageActivation.mentionedBot`.
- **Management in `channel-control`**: access descriptors on all five built-in channels, policy store/validation/materialization, `getAccess`/`saveAccess`, and the **Owner Claim** flow (`/dsh-claim`), plus `resolveOwnerIdentity` for Weixin (auto-owner migration from the scanned QR `userId`).
- **Web**: new "安全访问" (Secure access) section per channel — DM policy, named-group rules, danger warnings, owner claim UI, and access-readiness surfaced on the collapsed row. Kept separate from the platform "权限与事件" section.
- **Migration**: QQ / DingTalk / Lark / Telegram require a local Owner Claim before ordinary messages are processed (`needs-owner` → ordinary inbound DENY). Weixin with an existing credential `userId` auto-migrates to an owner-only policy. **Do not** assume "anyone who can message the bot may drive it".
- Group chats are disabled by default; V1 only supports explicitly named groups (no global "all groups open"). `requireMention` is an activation fact (not authorization) and stays off until a channel ships verified mention support.
- Users upgrading before completing owner onboarding must finish "识别我的账号" in the Channels UI.
