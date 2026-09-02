# @wsz987/channel-lark

Lark / Feishu / 飞书 channel adapter for DeepSeek Harness.

Maps Lark to the stable Channel Contract through the official
`@larksuiteoapi/node-sdk` **only**:

- **Inbound** — `WSClient` + `EventDispatcher` (WebSocket long-connection):
  `im.message.receive_v1` and `card.action.trigger`.
- **Outbound** — the official OpenAPI client: `im.v1.message.create` / `patch`,
  image/file uploads, and CardKit 2.0 card entities with **native streaming**
  (`cardkit.v1.card.create` → `cardElement.content` → `card.settings`).

There is no self-hosted gateway and no legacy transport. Interactive cards
use **Card JSON 2.0** only (buttons are direct `body.elements` with
`behaviors[].value`; no `tag: "action"` container and no `lark_md`).

## Install

```bash
pnpm add @wsz987/channel-lark
```

Or install the whole bundle:

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest
```

## Configuration

```yaml
- id: channels-lark
  name: '@wsz987/channel-lark'
  inject: [channels, credentials, channelControl]
  config:
    enabled: true
    accountId: main
    upstream:
      mode: sdk          # fixed — the official SDK is the only upstream driver
      appId: "cli_xxx"   # AppId（非机密）
      domain: feishu     # feishu（国内）| lark（海外）
      # appSecretRef 默认 DSH_CHANNEL_LARK_MAIN_APP_SECRET
      # 真实 AppSecret 只存 ctx.credentials
    card:
      createOnFirstDelta: true
      typingIndicator: true
```

The AppSecret is resolved through `ctx.credentials` at startup and injected as
`deps.appSecret`; it is never written to profile config.

> **Fail-closed config governance**: a legacy config carrying
> `upstream.mode: gateway` or a non-empty plaintext `upstream.appSecret`
> **fails config validation** (the plugin never enters the runtime). Move the
> secret into `ctx.credentials` under `upstream.appSecretRef` and remove the
> field from config before loading. There is no runtime migration.

## Streaming

Lark uses `edit` streaming over **CardKit 2.0 native streaming** (the official
"打字机" typewriter flow — never `im.v1.message.patch` pseudo-streaming):

1. `cardkit.v1.card.create` creates a Card JSON 2.0 entity with
   `streaming_mode: true` and a stable `element_id`;
2. `im.v1.message.create` sends the card reference
   (`{ type: "card", data: { card_id } }`);
3. every streamed delta replaces the markdown element's full content via
   `cardkit.v1.cardElement.content` with a monotonically increasing `sequence`
   and a stable `uuid`;
4. `finish()` / `fail()` close the stream by setting `streaming_mode: false`
   (and the final summary) through `cardkit.v1.card.settings`.

When a single markdown element approaches the platform's ~30,000-char cap the
handle rolls over into a fresh card (`chunkIds` records every sent card).

## Capabilities

| Capability | Value |
| --- | --- |
| text / image / file / audio | ✅ |
| markdown / cards / reactions / threads | ✅ |
| interactive buttons | ✅ (`card.action.trigger`, Card JSON 2.0) |
| video | ❌ |
| streaming | `edit` (CardKit 2.0 native streaming) |

## Upstream

| Field | Value |
| --- | --- |
| SDK | `@larksuiteoapi/node-sdk` |
| Tested version | `1.73.1` |
| Status | `tested` (**offline-tested**: contract + fixture + SDK-mode suites) |

> Live gate status: **LIVE-REQUIRED**. `status: tested` reflects the offline
> Channel Contract + fixture + official-SDK offline suites only. Real-app
> permission / event subscription / message & card send behavior must still be
> verified live (see §8 of the alignment plan) before the adapter may be
> claimed live-tested.

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
