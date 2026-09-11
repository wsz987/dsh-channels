# @wsz987/channel-weixin

Weixin / 微信 channel adapter for DeepSeek Harness.

Direct Tencent Weixin iLink integration (QR login, long-poll receive, text/image
send). This adapter is an upstream-gap source-port: it speaks the iLink
protocol directly rather than consuming an official host-neutral npm package.

> **Status:** `experimental` — real-Weixin live verification is still pending.
> The adapter is fully implemented and offline-tested, but it must not claim
> `tested` until the live platform gate passes.

## Install

```bash
pnpm add @wsz987/channel-weixin
```

Or install the whole bundle:

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest
```

## Configuration

Weixin has no credential or setup-form fields; the only configurable values are
network/reconnect tuning (all with defaults). Login happens on the mounted
adapter, not through YAML.

```yaml
- id: channels-weixin
  name: '@wsz987/dsh-channels/weixin'
  inject: [channels, channelControl]
  config:
    enabled: true
    accountId: main
    ilink:
      baseUrl: https://ilinkai.weixin.qq.com        # default iLink API base
      cdnBaseUrl: https://novac2c.cdn.weixin.qq.com/c2c  # default CDN base
    network:
      timeoutMs: 15000
      longPollTimeoutMs: 35000
    reconnect:
      enabled: true
      baseDelayMs: 2000
      maxDelayMs: 30000
```

The row above is the one shipped by the bundle patch
(`packages/channels/cordis.patch.yml`). Two details are easy to get wrong:

- `name` addresses the **bundle** subpath (`@wsz987/dsh-channels/weixin`), because
  the bundle re-exports every plugin from one direct profile dependency. The
  adapter package `@wsz987/channel-weixin` has no `./weixin` subpath of its own.
- The plugin module itself declares `inject = ['channels']`; the row adds
  `channelControl`. The loader merges the row's `inject` into the plugin's own,
  so the two are additive rather than required to be identical.

Login is QR-based: the control plane exposes the QR in Harness Web
「设置 → 渠道」, or the adapter can be driven headlessly through
`beginAuth` / `pollAuth` / `submitAuthInput`.

## Capabilities

| Capability | Value |
| --- | --- |
| text | ✅ |
| image | ✅ (Harness-native `saveImage` / `ImageBlock`) |
| file | ✅ (inbound download + AES decrypt; outbound `uploadMedia` + `sendMedia`) |
| video | ✅ (inbound download; outbound `sendVideo`) |
| audio | ❌ (inbound `localData` only; no Tencent 2.4.6 outbound voice path) |
| markdown / cards / reactions / threads | ❌ |
| streaming | `buffered` |

## Upstream

| Field | Value |
| --- | --- |
| Reference | `Tencent/openclaw-weixin` |
| Strategy | `source-port` (iLink protocol) |
| Protocol | `weixin-ilink` |
| Official package | `@tencent-weixin/openclaw-weixin` |

## Development

```bash
pnpm --filter @wsz987/channel-weixin build
pnpm --filter @wsz987/channel-weixin typecheck
pnpm --filter @wsz987/channel-weixin test
pnpm --filter @wsz987/channel-weixin test:live   # live verification (requires real Weixin)
```

## Related

- [Repository root](../../README.md)
- [Weixin live verification runbook](../../docs/weixin-live-verification-runbook.md)

## License

[MIT](../../LICENSE)
