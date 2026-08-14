---
'@dsh/channel-weixin': minor
'@dsh/channel-harness': minor
'@dsh/channel-core': minor
---

Weixin iLink direct client + H0 harness compliance:

- `@dsh/channel-weixin`: replace the self-hosted HTTP gateway (localhost:9000, /qrcode, /auth/status, /messages/long-poll, /message/send) with a direct Tencent iLink client — QR login state machine (redirect / verify code), SecretStore credential persistence, getUpdates monitor with sync cursor + context_token + message_id-first dedup, real sendmessage payload (client_id / context_token / run_id), WX5 media scaffold and WX6 typing scaffold. Config restructured: `baseUrl` removed in favor of `ilink.baseUrl` / `ilink.cdnBaseUrl` (breaking for gateway-based configs).
- `@dsh/channel-harness`: H0 compliance — `AgentRouteSpec` replaces the `agentId` identity (preset / provider / model / maxTokens), SessionBinding v2 with one-time v1→v2 migration, create/resume route parity, optional `sessionPersistence` capability (queried at the use site, no error-regex detection), ReplyRouter durable-log reconcile on unload, plugin inject narrowed to `channels` + `agents`. Config: `defaultAgentId` / `agentOptions` removed in favor of `agent.default` + `routing.overrides` (breaking for v1 configs).
- `@dsh/channel-core`: add `mountChannelAdapter` (transactional adapter mount with start-failure rollback) and document two-layer capability semantics (platform media capability ≠ Harness attachment projection).
