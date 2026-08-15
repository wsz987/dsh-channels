---
'@wsz987/channel-control': minor
'@wsz987/channel-core': minor
'@wsz987/channel-web': minor
'@wsz987/channel-qq': minor
'@wsz987/channel-dingtalk': minor
'@wsz987/channel-lark': minor
'@wsz987/channel-weixin': patch
---

Universal Channel Control Plane (final execution plan M2–M5):

- New `@wsz987/channel-control` package: `ChannelControlService` (registered as
  `ctx.channelControl`) with a `ChannelDefinition` registry, credential manager,
  auth session manager for real provider authorization (structured phase/QR
  payload/prompt, one active session, host-side poll throttle, TTL) and an
  internal runtime manager (start/stop/restart, mount handle map,
  unconfigured-channel-safe startup). New `/dsh-channels/api/v2`
  control-plane routes with a v1 compatibility layer.
- `channel-core`: `mountChannelAdapter` now returns an actively-callable
  `ChannelMountHandle` disposer (Cordis effect disposer; idempotent, parent
  fiber unload still auto-cleans).
- `channel-qq` / `channel-dingtalk` / `channel-lark` / `channel-weixin`: register
  `ChannelDefinition`s into the control plane; unconfigured channels no longer
  crash profile startup. DingTalk/Lark secrets migrate to `ctx.credentials`
  reference names (`DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET`,
  `DSH_CHANNEL_LARK_MAIN_APP_SECRET`).
- Web client: step-based `ChannelSetupDialog` with a single “save and connect”
  credential form for QQ/DingTalk/Lark and real QR auth for Weixin. Official
  console URLs remain links, runtime lifecycle controls are not exposed, and
  secrets or credential refs never reach the browser.
