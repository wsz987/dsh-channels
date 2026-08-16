# @wsz987/channel-control

Universal Channel Control Plane for DeepSeek Harness Channels.

Mounts a Cordis service at `ctx.channelControl` that owns channel configuration,
credentials, interactive auth sessions and runtime lifecycle. It is
adapter-agnostic: every channel is driven through its `ChannelDefinition`, never
through per-channel conditional code.

## Install

```bash
pnpm add @wsz987/channel-control
```

As a Cordis plugin:

```yaml
- id: channels-control
  name: '@wsz987/channel-control/plugin'
  inject:
    - channels
    - credentials
```

## What it does

| Manager | Responsibility |
| --- | --- |
| `definitions` (`ChannelDefinitionRegistry`) | Holds one `ChannelDefinition` per channel, registered by channel plugins |
| `credentials` (`CredentialManager`) | Thin structural seam over `ctx.credentials`; secret values are never returned |
| `auth` (`AuthSessionManager`) | Drives QR/credential auth sessions (`beginAuth`, `pollAuth`, `submitAuthInput`, `cancelAuth`) |
| `runtime` (`ChannelRuntimeManager`) | Mounts/starts/stops/restarts adapter instances and tracks health |

The service auto-starts configured channels when their definition is registered,
and stops all mounts when the owning Cordis fiber unloads. A single
misconfigured channel never crashes profile activation.

## API surface

```ts
ctx.channelControl.listChannels();          // ChannelSummary[]
ctx.channelControl.getSetup('qq');          // setup descriptor
ctx.channelControl.getConfiguredState('qq');
ctx.channelControl.saveConfig('qq', patch); // rejects secret fields
ctx.channelControl.saveCredential('qq', 'appSecret', value);
ctx.channelControl.applySetup('qq', input); // transactional setup + reconcile
ctx.channelControl.beginAuth('weixin', input);
ctx.channelControl.pollAuth(sessionId);
```

## Development

```bash
pnpm --filter @wsz987/channel-control build
pnpm --filter @wsz987/channel-control typecheck
pnpm --filter @wsz987/channel-control test
```

## Related

- [Repository root](../../README.md)
- [Architecture design](../../docs/architecture.md)

## License

[MIT](../../LICENSE)
