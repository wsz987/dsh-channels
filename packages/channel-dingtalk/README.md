# @wsz987/channel-dingtalk

DingTalk / 钉钉 channel adapter for DeepSeek Harness.

Maps DingTalk to the stable Channel Contract with two selectable upstream
drivers:

- **`sdk`** — inbound via the official `dingtalk-stream` SDK (WebSocket stream
  mode); outbound via `sessionWebhook` and DingTalk AI Card OpenAPI.
- **`gateway`** — self-hosted HTTP gateway long-poll driver (legacy).

## Install

```bash
pnpm add @wsz987/channel-dingtalk
```

Or install the whole bundle:

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@beta
```

## Configuration

SDK mode:

```yaml
- id: channels-dingtalk
  name: '@wsz987/channel-dingtalk'
  inject: [channels, credentials, channelControl]
  config:
    enabled: true
    accountId: main
    upstream:
      mode: sdk
      clientId: "ding-xxx"             # AppKey（非机密）
      # clientSecretRef 默认 DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET
      # 真实 AppSecret 只存 ctx.credentials
    card:
      createOnFirstDelta: true
```

Gateway mode (legacy, self-hosted HTTP gateway):

```yaml
- id: channels-dingtalk
  name: '@wsz987/channel-dingtalk'
  inject: [channels, credentials, channelControl]
  config:
    enabled: true
    accountId: main
    upstream:
      mode: gateway
    baseUrl: http://127.0.0.1:9100
    longPollTimeoutMs: 25000
```

The AppSecret is resolved through `ctx.credentials` at startup and injected as
`deps.clientSecret`. A legacy plaintext `upstream.clientSecret` is migrated into
the credentials seam once and then deleted.

## Streaming

DingTalk uses `edit` streaming: the adapter creates an AI Card, updates it with
each delta, and finalizes (or marks it failed) at turn end.

## Capabilities

| Capability | Value |
| --- | --- |
| text / image / file / audio | ✅ |
| markdown / cards | ✅ |
| video / reactions / threads | ❌ |
| streaming | `edit` (AI Card) |

## Upstream

| Field | Value |
| --- | --- |
| SDK | `dingtalk-stream` |
| Tested version | `2.1.5` |
| Status | `tested` (offline contract + fixture + SDK-mode E2E suites) |

## Development

```bash
pnpm --filter @wsz987/channel-dingtalk build
pnpm --filter @wsz987/channel-dingtalk typecheck
pnpm --filter @wsz987/channel-dingtalk test
```

## Related

- [Repository root](../../README.md)
- [Adapter authoring guide](../../docs/adapter-authoring.md)

## License

[MIT](../../LICENSE)
