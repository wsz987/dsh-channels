# @wsz987/channel-core

Stable cross-channel contract and Cordis `ChannelService` for DeepSeek Harness Channels.

`channel-core` is the foundation of the `dsh-channels` monorepo. It defines the
**Channel Contract** that every adapter implements, and the shared runtime
service mounted at `ctx.channels`. It never imports Harness Agent APIs and never
depends on a concrete messaging platform.

## Install

```bash
pnpm add @wsz987/channel-core
```

As a Cordis plugin:

```yaml
- id: channels-service
  name: '@wsz987/channel-core/plugin'
```

## What's inside

| Export | Purpose |
| --- | --- |
| `ChannelAdapter` / `defineChannelAdapter` | The adapter contract and the third-party authoring helper |
| `ChannelService` (`ctx.channels`) | Adapter registry, typed event bus, shared secrets/storage resources |
| `ChannelCapabilities` | Capability negotiation (`text`, `image`, `file`, `streaming`, …) |
| `ChannelTarget` / `OutboundMessage` / `SendResult` / `ReplyHandle` | Structured messaging types |
| `ChannelEvent` / `AuthChallenge` / `ChannelHealth` | Event, auth and health surfaces |
| `ChannelError` / `isChannelError` | Stable machine-readable error hierarchy |
| `mountChannelAdapter` | Transactional mount lifecycle (register → start → stop → unregister) |
| `ChannelRuntimeResources` | Durable secrets and storage shared by all mounted adapters |
| media helpers | `SecureRemoteMediaFetcher`, `RemotePolicy`, bounded response readers |

## Quick start

```ts
import { defineChannelAdapter } from '@wsz987/channel-core';

export default defineChannelAdapter({
  id: 'my-channel',
  capabilities: {
    text: true,
    image: false,
    file: false,
    audio: false,
    video: false,
    markdown: false,
    cards: false,
    reactions: false,
    threads: false,
    streaming: 'buffered', // 'native' | 'edit' | 'buffered'
  },
  async start(ctx) {
    // connect the platform, then emit messages with ctx.emit('message', ...)
  },
  async stop() {
    // idempotent cleanup
  },
  async send(target, message) {
    // send one OutboundMessage
  },
});
```

In production the plugin wires file-backed resources automatically; in tests the
service falls back to in-memory stores:

```ts
import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@wsz987/channel-core';

const ctx = new Context();
const channels = new ChannelService(ctx);

channels.register(adapter);
channels.on((event) => console.log(event.type));
```

## Data directory

The plugin resolves the durable data directory in this order:

1. `DSH_CHANNELS_DATA_DIR` (explicit override)
2. `<Harness home>/dsh-channels` (`$DSH_HOME`, else `~/.dsh`)

## Development

```bash
pnpm --filter @wsz987/channel-core build
pnpm --filter @wsz987/channel-core typecheck
pnpm --filter @wsz987/channel-core test
```

## Related

- [Repository root](../../README.md)
- [Adapter authoring guide](../../docs/adapter-authoring.md)

## License

[MIT](../../LICENSE)
