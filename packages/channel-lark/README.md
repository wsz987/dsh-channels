# @wsz987/channel-lark

Lark / Feishu / 飞书 channel adapter for DeepSeek Harness.

Maps Lark to the stable Channel Contract with two selectable upstream drivers:

- **`sdk`** — inbound via the official `@larksuiteoapi/node-sdk` (WebSocket
  long-connection); outbound via the official OpenAPI client. No localhost
  gateway required.
- **`gateway`** — self-hosted HTTP gateway long-poll driver (legacy).

## Install

```bash
pnpm add @wsz987/channel-lark
```

Or install the whole bundle:

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@beta
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

Gateway mode (legacy, self-hosted HTTP gateway):

```yaml
- id: channels-lark
  name: '@wsz987/channel-lark'
  inject: [channels, credentials, channelControl]
  config:
    enabled: true
    accountId: main
    upstream:
      mode: gateway
    baseUrl: http://127.0.0.1:9300
    longPollTimeoutMs: 25000
```

The AppSecret is resolved through `ctx.credentials` at startup and injected as
`deps.appSecret`. A legacy plaintext `upstream.appSecret` is migrated into the
credentials seam once and then stripped.

## Streaming

Lark uses `edit` streaming: the adapter creates an editable card, patches it
with each delta, and finalizes (or marks it failed) at turn end.

## Capabilities

| Capability | Value |
| --- | --- |
| text / image / file / audio | ✅ |
| markdown / cards / reactions / threads | ✅ |
| video | ❌ |
| streaming | `edit` (editable card) |

## Upstream

| Field | Value |
| --- | --- |
| SDK | `@larksuiteoapi/node-sdk` |
| Tested version | `1.73.0` |
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
