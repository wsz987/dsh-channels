# @wsz987/channel-qq

QQ Bot channel adapter for DeepSeek Harness.

Consumes the official Tencent SDK `@tencent-connect/qqbot-nodejs` and maps it to
the stable Channel Contract. The SDK owns token acquisition, the WebSocket
gateway, media upload and C2C streaming; the adapter adds dedup, reply routing,
image hydration and DSH lifecycle handling.

## Install

```bash
pnpm add @wsz987/channel-qq
```

Or install the whole bundle:

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest
```

## Configuration

```yaml
- id: channels-qq
  name: '@wsz987/channel-qq'
  inject: [channels, credentials, channelControl]
  config:
    enabled: true
    accountId: main
    appId: "102345678"               # QQ 开放平台 AppId（非机密）
    appSecretRef: QQBOT_APP_SECRET   # 真实 AppSecret 只存 ctx.credentials
    markdownSupport: false
    streaming:
      enabled: true
      throttleMs: 500
    dedup:
      enabled: true
      windowMs: 5000
    startupTimeoutMs: 15000
```

The AppSecret is resolved through `ctx.credentials` at startup and injected as
`deps.appSecret`. It never appears in config, logs or fixtures.

## Streaming

Streaming is target-aware:

- **C2C + reply-to-message-id** → `native` (full-text replace streaming)
- **group / other targets** → `buffered` (send once at turn end)

## Capabilities

| Capability | Value |
| --- | --- |
| text / image / file / audio / video | ✅ |
| markdown | depends on `markdownSupport` |
| cards / reactions / threads | ❌ |
| streaming | `native` (C2C) / `buffered` (default) |

## Upstream

| Field | Value |
| --- | --- |
| SDK | `@tencent-connect/qqbot-nodejs` |
| Tested version | `1.0.4` |
| Status | `tested` (offline contract + fixture + E2E suites) |

## Development

```bash
pnpm --filter @wsz987/channel-qq build
pnpm --filter @wsz987/channel-qq typecheck
pnpm --filter @wsz987/channel-qq test
```

## Related

- [Repository root](../../README.md)
- [Adapter authoring guide](../../docs/adapter-authoring.md)

## License

[MIT](../../LICENSE)
