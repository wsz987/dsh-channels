# THIRD-PARTY NOTICES

## Weixin iLink protocol reference

The Weixin protocol implementation in `packages/channel-weixin` (iLink endpoint
shapes, request/response field names such as `message_id`, `from_user_id`,
`item_list`, `context_token`, `client_id`, `run_id`, the QR login state machine
states, `get_updates_buf` cursor semantics, `base_info`, the `X-WECHAT-UIN`
header encoding, and the `sendmessage` payload layout) is based on / ported from
the Tencent **openclaw-weixin** iLink implementation.

- Repository: https://github.com/Tencent/openclaw-weixin
- Source of protocol details: `src/api/api.ts`, `src/api/types.ts`,
  `src/auth/login-qr.ts`, `src/messaging/send.ts`, `src/auth/accounts.ts`.
- License: MIT (see the upstream repository).

We do not depend on the openclaw runtime or its plugin SDK. Only the iLink
wire protocol field names and endpoint conventions were used to build a clean,
self-contained client for DeepSeek Harness. The CDN media and AES-128-ECB
behavior follows the upstream's own implementation (see
`packages/channel-weixin/src/media/` and the upstream facade), not a
re-derived spec.

This project is not affiliated with Tencent and is not an official Weixin SDK.
