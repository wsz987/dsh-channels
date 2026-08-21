# @wsz987/channel-telegram

Telegram Bot API channel adapter for DeepSeek Harness.

## Install

```bash
pnpm add @wsz987/channel-telegram
```

## Bundled community channel

This package is part of the community-maintained `@wsz987/dsh-channels` bundle.
It is not an official DeepSeek Harness or Telegram package.
It implements the same Channel Contract as weixin / qq / dingtalk / lark,
with no changes to channel-core, channel-harness or the other adapters.
Setup and credentials go through the Channel Control Plane; the bot token is
stored via `ctx.credentials` (`tokenRef`), never in profile config.

> The bundle patch inserts this adapter as `channels-telegram` and the Web settings
> panel shows it with the other bundled channels.


Contract coverage:

- `ChannelAdapter` contract (`start` / `stop` / `send` / `getHealth` / capabilities)
- `runChannelAdapterContract` — the testkit's full contract suite passes
- Cordis plugin shape (`name` / `inject` / `apply` via `ctx.effect`)
- Schemastery `Config` with an injectable `HttpTransport` (offline fake in tests)
- Fixture-driven mapper tests (`fixtures/telegram/*.json`, Bot API 10.2 shapes)
- M4 governance: `readonly manifest` class field + `manifest.ts` for
  `channels doctor` compatibility checks

The adapter remains `experimental` until its real-platform live gate passes;
offline contract tests and fixtures do not by themselves justify `tested`.

## Pointing it at a real bot

In your profile config:

```json
{
  "plugins": {
    "channel-telegram": {
      "enabled": true,
      "accountId": "main",
      "baseUrl": "https://api.telegram.org",
      "tokenRef": "TELEGRAM_BOT_TOKEN",
      "longPollTimeoutMs": 25000
    }
  }
}
```

The token is a **secret** resolved through `ctx.credentials` (`tokenRef`): it is never logged (bearer-style path segments are
redacted in transport error messages) and it only ever appears in the Bot API
request path built by the upstream driver. It is never written into fixture
files.

Inbound delivery currently uses Telegram Bot API long polling (`getUpdates`),
matching OpenClaw's local-install default. Startup removes an existing webhook
before polling because Telegram makes webhook and `getUpdates` delivery mutually
exclusive. This is an operational takeover of the Bot's update receiver: do not
reuse the same Bot for another webhook consumer. A hosted webhook transport is
not implemented yet.

## Capabilities

| capability   | value     |
| ------------ | --------- |
| text / image / file / audio / video | ✅ |
| markdown     | ✅ Rich Markdown |
| reactions    | ❌        |
| cards        | ❌        |
| threads      | ✅        |
| streaming    | DM Rich Draft; group plain preview + rich final edit; set `streaming.enabled: false` for buffered |

## Known limits

- Minimum supported upstream is Telegram Bot API 10.2. Older or pinned custom
  Bot API servers are not supported; use `formatting.mode: plain` only as an
  explicit presentation choice, not as an old-server compatibility mode.
- `getUpdates` subscribes to `message` and `callback_query`. Button interactions
  are currently intended only for callback queries carrying `message.chat`;
  inline-message callbacks without chat context are not a supported routing
  surface and require a mapper hardening change before release.
- The ordinary message mapper still needs a complete zod trust-boundary schema;
  the current partial envelope validation and TypeScript casts are an identified
  release blocker, not evidence that arbitrary Telegram updates are supported.
- Media sends currently need the same `ok` envelope validation used by text and
  edit methods. Until that is fixed and live-tested, an `ok: false` media response
  must not be interpreted as verified delivery.
- Inbound media hydration downloads image and document bytes through `getFile`; audio/video keep their `resourceRef` placeholder in V1.
- Telegram albums (`media_group_id`) are intentionally delivered one update at
  a time. Each image is downloaded, dispatched, retried and acknowledged
  independently; no cross-update buffering or delayed album aggregation is
  performed.
- Media captions are preserved as a text part before the image or document, so
  the model receives both the caption and the shared attachment representation.
- Media outbound accepts trusted `localData` via `multipart/form-data`, a
  public `url`, or a platform `file_id` (`resourceRef`).
- Inbound media maps Telegram `file_id` to the contract's `resourceRef` carrier
  (an opaque platform handle), never to `url` — `url` is reserved for real
  `http(s)` URLs.
- `beginAuth`/`pollAuth` are omitted: auth is token-driven (getMe() check at start).
- Forum topics preserve `message_thread_id`; `chat.type === 'channel'`
  currently maps to a `dm` conversation.

## Development

```bash
pnpm --filter @wsz987/channel-telegram build
pnpm --filter @wsz987/channel-telegram typecheck
pnpm --filter @wsz987/channel-telegram test
```

## Related

- [Repository root](../../README.md)
- [Adapter authoring guide](../../docs/adapter-authoring.md)

## License

[MIT](../../LICENSE)
