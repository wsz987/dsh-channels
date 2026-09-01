---
'@wsz987/channel-qq': patch
'@wsz987/dsh-channels': patch
---

**QQ native inline keyboard + interaction round-trip for `ask_user_question` (P1).**

- **`interactiveActions: true`** — QQ adapter now declares native interactive actions: `OutboundMessage.actions` map to the new QQ Markdown inline keyboard (`msg_type=2` + `markdown.content` + `keyboard`, callback action type `1`) and button presses emit a canonical `interaction.received` for the Harness question presenter.
- **Outbound**: new `toQqKeyboard` mapper (`OutboundActionRow[]` → QQ `InlineKeyboard`); the opaque `uq_*` action id rides in `action.data` (echoed back as `button_data`) and the button `id`; `primary` style maps to QQ style 1, all other styles to default (never invents unsupported values). Media + actions degrades to a plain media send (QQ does not reliably support buttons on media sends) with a debug note.
- **Inbound**: `QQSdkClient` seam extended with `onInteraction` / `sendMarkdownWithKeyboard` / `acknowledgeInteraction`; the adapter ACKs every interaction within the ~5s platform window (fire-and-forget, before Harness resolution), zod-validates the untrusted `InteractionEvent` slice at the trust boundary, and emits `interaction.received` with the conversation/sender derived from the QQ openids (C2C `user_openid`; group `group_openid` + `group_member_openid`). Ambiguous or invalid payloads fail closed (logged drop, never a guessed event). Authorization stays in `channel-harness`'s Access Gate — the adapter only emits canonical events.
- **New QQ group activation**: `GROUP_AT_MESSAGE_CREATE` now maps to strict `activation.mentionedBot=true` and strips the leading platform mention marker. An authorized `@机器人 2` answer is consumed by the pending Harness question before ordinary Agent queueing.
- **Minimal intents**: the Tencent client now passes an explicit `intents` mask (`GROUP_AND_C2C | INTERACTION` = `(1 << 25) | (1 << 26)`) instead of relying on the SDK `FULL_INTENTS` default, per the minimal-intent principle.

Offline contract suite (Fake QQSdkClient) is green; a real QQ app live gate is still required before production use (button display, press callback, ACK).
