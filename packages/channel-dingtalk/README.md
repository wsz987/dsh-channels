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
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest
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
      # 问答按钮是**可选**能力：必须填你自己卡片平台里已发布、且含 text/actions
      # 变量的模板 ID。留空（默认）= 不声明 interactiveActions，问题走编号文字回复
      # （与微信一致）。填了但模板未发布/无权限，Harness 会自动降级为文字回复。
      # interactiveTemplateId: "dac1dbec-55af-40c3-be91-6d6882ef3b66.schema"
      # 下面两个变量名必须与模板中的变量绑定一致
      interactiveTextParam: text
      interactiveActionsParam: actions
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

## Interactive buttons (opt-in)

`OutboundMessage.actions` uses the official interactive-card APIs:

- `POST /v1.0/im/interactiveCards/send`
- `PUT /v1.0/im/interactiveCards`
- Stream callback topic `/v1.0/card/instances/callback` (the `TOPIC_CARD`
  constant of `dingtalk-stream`)

This is not the legacy webhook `actionCard` API, whose buttons only open URLs
and cannot return a selection to the Harness.

Buttons are **opt-in and off by default**. A card only renders interactive
components when its template is published in *your* organization's Card
Platform, exposes the configured `text`/`actions` variables, and its buttons
return `cardPrivateData.params.action` (the action id). A built-in third-party
template id cannot satisfy that, so `card.interactiveTemplateId` has no default:
without it the adapter reports `interactiveActions: false` and Harness questions
use the numbered-text reply path (same as Weixin). When the template *is*
configured but the send still fails (unpublished template, missing permission),
`channel-harness` degrades that question to numbered text instead of cancelling
it.

LIVE-REQUIRED before advertising buttons as verified: a real-account round trip
that the card renders, that a click arrives on the STREAM callback topic, and
that the answer returns to the agent. The official troubleshooting note
requires `callbackType="STREAM"` at card creation *and* the registered callback
topic ([钉钉卡片示例 · 注意事项](https://github.com/open-dingtalk/dingtalk-card-examples));
whether `POST /v1.0/im/interactiveCards/send` honors `callbackType` is still
unverified here and is the first item to check in that gate.

## Capabilities

| Capability | Value |
| --- | --- |
| text / image / file / audio | ✅ |
| markdown / cards | ✅ (AI Card streaming replies) |
| interactive actions | ⚙️ opt-in: SDK mode **and** `card.interactiveTemplateId` set |
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
