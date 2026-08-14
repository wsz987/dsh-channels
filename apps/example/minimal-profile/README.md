# Example DSH profile — minimal (bundle)

Example profile for the **@dsh/channels** DSH bundle (Phase 16, Task 16.3). It
shows the result of the bundle patch (`packages/channels/cordis.patch.yml`):
the ChannelService (`channels-service`), the Harness bridge
(`channels-harness`) and the four official channel adapters
(`channels-weixin`, `channels-qq`, `channels-dingtalk`, `channels-lark`),
each with realistic per-channel config including `enabled: true` and commented
`enabled: false` examples for disabling channels via config.

> This directory intentionally has **no package.json**: it is not a workspace
> package and is ignored by turbo / vitest. It is a reference profile, not a
> buildable app (compare `apps/fake-channel`).

## Commands

Apply the bundle to a clean `minimal` profile and inspect the merged config:

```bash
# 1. add the bundle (installs the patch into the clean profile)
dsh plugin --profile minimal add ./packages/channels

# 2. dump the merged config — verify the six plugins from cordis.patch.yml
dsh --profile minimal --dump-config

# 3. start the profile — all plugins load, channels register on ctx.channels
dsh --profile minimal
```

To disable a single channel, edit the profile config (mirroring this file) and
set `plugins.channels-weixin.enabled: false` (etc.) — the adapter plugin's
`apply()` returns early when `enabled` is false.

> **Note:** a real clean-profile install requires the dsh CLI (this repo ships
> the bundle, not the CLI) and is a **manual release-validation step** —
> documented in [docs/release.md](../../docs/release.md) under
> "DSH Bundle Validation".
