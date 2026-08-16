# @wsz987/channel-telegram

Telegram Bot API channel adapter for DeepSeek Harness — the **M5 extensibility proof**.

## Install

```bash
pnpm add @wsz987/channel-telegram
```

## Extensibility proof

This package was built against the **public Channel Contract** (`@wsz987/channel-core` +
`@wsz987/channel-testkit`) with **zero changes** to `channel-core`, `channel-harness`,
the `@wsz987/dsh-channels` bundle, or the four official adapters (weixin / qq / dingtalk /
lark). It is a fifth channel that joins the ecosystem exactly the way a third-party
adapter would.

> **Deliberately NOT part of the `@wsz987/dsh-channels` bundle.** The bundle ships the four
> official channels; this adapter is the standalone proof that the contract is
> extensible from the outside, without any core or harness changes.

What the proof exercises:

- `ChannelAdapter` contract (`start` / `stop` / `send` / `getHealth` / capabilities)
- `runChannelAdapterContract` — the testkit's full contract suite passes
- Cordis plugin shape (`name` / `inject` / `apply` via `ctx.effect`)
- Schemastery `Config` with an injectable `HttpTransport` (offline fake in tests)
- Fixture-driven mapper tests (`fixtures/telegram/*.json`, Bot API 7.10 shapes)
- M4 governance: `readonly manifest` class field + `manifest.ts` for
  `channels doctor` compatibility checks

## Pointing it at a real bot

In your profile config:

```json
{
  "plugins": {
    "channel-telegram": {
      "enabled": true,
      "accountId": "main",
      "baseUrl": "https://api.telegram.org",
      "token": "<your bot token from @BotFather>",
      "longPollTimeoutMs": 25000
    }
  }
}
```

The token is a **secret**: it is never logged (bearer-style path segments are
redacted in transport error messages) and it only ever appears in the Bot API
request path built by the upstream driver. It is never written into fixture
files.

## Capabilities

| capability   | value     |
| ------------ | --------- |
| text / image / file / audio / video | ✅ |
| markdown     | ✅        |
| reactions    | ✅        |
| cards        | ❌        |
| threads      | ❌        |
| streaming    | `buffered` — Telegram `editMessageText` makes `edit` streaming reachable; documented future capability |

## Known limits (V1 proof)

- `streaming: 'buffered'` — chunks accumulate and are delivered once per turn.
- Media outbound sends a public `url` or a platform `file_id` (`resourceRef`)
  as the Bot API file reference (`sendPhoto`/… `photo: <ref>`); real file
  uploads (`multipart/form-data`) and `getFile`-based downloads are future work.
- Inbound media maps Telegram `file_id` to the contract's `resourceRef` carrier
  (an opaque platform handle), never to `url` — `url` is reserved for real
  `http(s)` URLs.
- `beginAuth`/`pollAuth` are omitted: auth is token-driven (getMe() check at start).
- `chat.type === 'channel'` currently maps to a `dm` conversation.

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
