# @wsz987/channel-web

DeepSeek Harness Web client for the Channels dashboard: **Settings → 渠道**.

Host-side Cordis plugin plus a Web client surface. The host registers HTTP API
routes under `/dsh-channels/api/v1` and `/dsh-channels/api/v2`; the client
renders the channel setup panel (QR login, credentials form, status) inside the
Harness Web UI.

## Install

The Web dashboard is part of the `@wsz987/dsh-channels` bundle:

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest
```

To install it standalone:

```bash
pnpm add @wsz987/channel-web
```

## What it does

| Surface | Responsibility |
| --- | --- |
| `src/host/routes.ts` | M1 read-only dashboard + adapter auth loop (`/dsh-channels/api/v1`) |
| `src/host/routes-v2.ts` | Control-plane API (`/dsh-channels/api/v2`) delegating to `ctx.channelControl` |
| `src/client/*` | React components for the 「设置 → 渠道」 dashboard |
| `src/protocol.ts` | Shared host/client protocol types |

Security notes:

- State-changing routes are loopback-only.
- Mutation bodies must be `application/json`.
- Secret values are never echoed; they are written through the credentials seam.

The plugin injects `webServer`, `channels`, and optionally `channelControl`.
When `channelControl` is absent, v2 routes return `503` so a standalone web
profile still boots.

## Client build

The package declares a `dsh.client` block so the Harness Web runtime loads the
client surface from `@wsz987/channel-web/client`.

## Development

```bash
pnpm --filter @wsz987/channel-web build
pnpm --filter @wsz987/channel-web typecheck
pnpm --filter @wsz987/channel-web test
```

## Related

- [Repository root](../../README.md)
- [Architecture design](../../docs/architecture.md)

## License

[MIT](../../LICENSE)
