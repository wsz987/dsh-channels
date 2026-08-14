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
self-contained client for DeepSeek Harness. Where the CDN media / AES-128-ECB
specification is not fully pinned by that reference, the implementation ships
typed stubs (WX5) that throw a clear `WX5 not implemented` error rather than
guessing.

This project is not affiliated with Tencent and is not an official Weixin SDK.
