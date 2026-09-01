# @wsz987/channel-lark

Lark / Feishu / 飞书 channel adapter for DeepSeek Harness.

Maps Lark to the stable Channel Contract through the official
`@larksuiteoapi/node-sdk`: WebSocket long-connection for inbound events and
the official OpenAPI client for outbound messages. No localhost gateway is
required.

## Install

```bash
pnpm add @wsz987/channel-lark
```

Or install the whole bundle:

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest
```

## Configuration

SDK mode:

```yaml
- id: channels-lark
  name: '@wsz987/channel-lark'
  inject: [channels, credentials, channelControl]
  config:
    enabled: true
    accountId: main
    upstream:
      mode: sdk
      appId: "cli_xxx"                 # AppId（非机密）
      domain: feishu                   # feishu（国内）| lark（海外）
      # appSecretRef 默认 DSH_CHANNEL_LARK_MAIN_APP_SECRET
      # 真实 AppSecret 只存 ctx.credentials
    card:
      createOnFirstDelta: true
      typingIndicator: true
```

The AppSecret is resolved through `ctx.credentials` at startup and injected as
`deps.appSecret`; it is never written to profile config.

## Streaming

Lark uses `edit` streaming: the adapter creates an editable card, patches it
with each delta, and finalizes (or marks it failed) at turn end.

## Capabilities

| Capability | Value |
| --- | --- |
| text / image / file / audio | ✅ |
| markdown / cards / reactions / threads | ✅ |
| interactive buttons | ✅ (`card.action.trigger`) |
| video | ❌ |
| streaming | `edit` (editable card) |

## Upstream

| Field | Value |
| --- | --- |
| SDK | `@larksuiteoapi/node-sdk` |
| Tested version | `1.73.1` |
| Status | `tested` (offline contract + fixture + SDK-mode E2E suites) |

## Development

```bash
pnpm --filter @wsz987/channel-lark build
pnpm --filter @wsz987/channel-lark typecheck
pnpm --filter @wsz987/channel-lark test
```

## Related

- [Repository root](../../README.md)
- [Adapter authoring guide](../../docs/adapter-authoring.md)

## License

[MIT](../../LICENSE)
