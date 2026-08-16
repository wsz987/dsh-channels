# @wsz987/dsh-channels

DeepSeek Harness **DSH Bundle** — built-in messaging channels:

- Weixin / 微信
- QQ Bot
- DingTalk / 钉钉
- Lark / Feishu / 飞书

## Install

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@beta
```

> The profile directory is itself a pnpm workspace, so `-w` (`--workspace-root`)
> is required to add the bundle to the workspace root (otherwise pnpm fails with
> `ERR_PNPM_ADDING_TO_ROOT`). `@beta` selects the beta dist-tag — currently the
> only published version is `0.1.0-beta.0`. Drop `@beta` once a stable release
> ships.

The bundle patch (`cordis.patch.yml`) inserts the `ChannelService`
(`@wsz987/channel-core`), the optional generic-file extension
(`@wsz987/channel-files`), the Harness bridge (`@wsz987/channel-harness`), the
control plane (`@wsz987/channel-control`), the Web settings panel
(`@wsz987/channel-web`) and the four channel adapters. Every channel can be
disabled through its plugin config.

## Quick start

```bash
# 1. add the bundle to a profile
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@beta

# 2. confirm the merged config inserted the channel plugins
npx @deepseek-ai/dsh --profile web --dump-config

# 3. start the profile — all four channels load
npx @deepseek-ai/dsh web
```

Disable a channel you don't use by setting its plugin `enabled` flag to `false`
in your profile patch, e.g. `plugins.channels-weixin.enabled = false`.
See `apps/example/minimal-profile/` in the repository for a reference profile.

## Verify your install

Use a clean profile to confirm the bundle loads end to end (never reuse a dirty
profile for release validation):

```bash
# 1. add the bundle to a clean profile (auto-initializes it on first use)
npx @deepseek-ai/dsh plugin --profile release-validation add -w @wsz987/dsh-channels@beta

# 2. dump the merged config — verify the channel plugins were inserted
npx @deepseek-ai/dsh --profile release-validation --dump-config

# 3. start the profile — channels-service / -harness / -control and the four
#    adapters (plus channels-web) should all load without error
npx @deepseek-ai/dsh --profile release-validation
```

## Dependencies

The bundle is a thin entry point. Its npm `dependencies` pull in the rest of the
channel suite automatically, so **you only ever install `@wsz987/dsh-channels`**:

| Package                  | Role |
| ------------------------ | ---- |
| `@wsz987/channel-core`   | Cross-channel contract + `ChannelService` (`ctx.channels`) |
| `@wsz987/channel-harness`| Harness bridge (`SessionBinding`, `AgentManager`, reply pipeline) |
| `@wsz987/channel-control`| Config / credentials / auth-session control plane |
| `@wsz987/channel-files`  | Optional generic-file extension (store / extract / `read_channel_attachment`) |
| `@wsz987/channel-web`    | Web dashboard (`Settings > Channels`) for GUI setup |
| `@wsz987/channel-weixin/qq/dingtalk/lark` | The four channel adapters |

The Web dashboard (`@wsz987/channel-web`) injects the Harness web client
surfaces (`@deepseek-ai/dsh-client-runtime`, `-locale`, `-ui-settings`,
`-ui-primitives`), which the Harness itself provides at runtime — nothing extra
to install for that panel beyond a Harness version that ships them.

## Individual adapters

Advanced users may install a single adapter:

```bash
npx @deepseek-ai/dsh plugin --profile minimal add -w @wsz987/channel-weixin@beta
```

## Architecture

```
Messaging Platform
      │
      ▼
Upstream Driver
      │
      ▼
Channel Adapter (channel-weixin/qq/dingtalk/lark)
      │
      ▼
ChannelService (Cordis Service, ctx.channels)
      │
      ▼
Harness Bridge (channel-harness)
      │
      ▼
DeepSeek Harness Agent / Session
```

- Adapters never touch `ctx.agents`.
- The Harness bridge is the only place allowed to import Harness public APIs.
- Replies flow from `session/event` back through the bridge to the adapters.

## Development

```bash
pnpm --filter @wsz987/dsh-channels build
pnpm --filter @wsz987/dsh-channels typecheck
pnpm --filter @wsz987/dsh-channels test
```

## Related

- [Repository root](../../README.md)
- [Architecture design](../../docs/deepseek-harness-channels-architecture.md)

## License

[MIT](../../LICENSE)
