---
'@wsz987/channel-qq': minor
'@wsz987/channel-harness': patch
---

QQ adapter migration + startup hardening (v1.1 follow-up):

- `@wsz987/channel-qq` (minor — breaking for 0.x): rebuilt on the official Tencent
  SDK `@tencent-connect/qqbot-nodejs@1.0.4`, removing the self-implemented
  gateway/transport/auth and the direct `ws` dependency. `appSecret` config is
  removed in favor of `appSecretRef` (resolved via `ctx.credentials`); gateway
  config keys are removed. Hardening: startup now fails fast on credential
  errors with transactional rollback (`mountChannelAdapter`), `streaming.enabled`
  actually gates C2C native streaming, and outbound `dataUri` media is decoded
  to the SDK `fileData` field instead of being sent as a URL.
- `@wsz987/channel-harness` (patch): `drainTimeoutMs` config (was hardcoded 5000);
  non-breaking, default preserved.
