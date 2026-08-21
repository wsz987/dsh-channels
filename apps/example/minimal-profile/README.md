# Example DSH profile — minimal

Example DSH profile using the official **bundle / profile / patch** model. It
shows a user profile that consumes the **@wsz987/dsh-channels** bundle and then
overrides it to run a QQ-only channel setup.

## Files

- `package.json` — the profile manifest: declares the bundles to install via
  the `dsh.profile.bundles` list (`@deepseek-ai/dsh-base`, `@wsz987/dsh-channels`).
- `cordis.patch.yml` — the **user profile patch** that overrides rows inserted
  by the bundle: disables weixin / dingtalk / lark / telegram and overrides
  `channels-qq` with its full QQ config.

## Install flow

```bash
# 1. add the bundle to the profile (DSH installs the bundle into
#    dsh.profile.bundles and applies the bundle's cordis.patch.yml)
npx @deepseek-ai/dsh plugin --profile minimal add -w @wsz987/dsh-channels@latest

# 2. inspect the merged config
npx @deepseek-ai/dsh --profile minimal --dump-config

# 3. run the profile
npx @deepseek-ai/dsh --profile minimal
```

## Profile override semantics

A Harness patch **replaces the whole `config` of the target row** — it is *not*
a deep merge. Every `config:` block in `cordis.patch.yml` must therefore carry
the complete config for that plugin, not just the key you want to change.

## Credentials

The QQ AppSecret is **never** written into the profile, the bundle config, or
git. Config carries only the credential **reference** (`appSecretRef`, e.g.
`QQBOT_APP_SECRET`); the actual secret lives in `ctx.credentials` and is
resolved at startup:

```yaml
appSecretRef: QQBOT_APP_SECRET   # reference only — the value lives in ctx.credentials
```

The `channels-qq` plugin injects `[channels, credentials, channelControl]`; the
`channel-harness` bridge injects `[channels, agents, agentDefaultModel, llm,
commands, apiProxy]`.

> **Note:** a real clean-profile install requires the dsh CLI (this repo ships
> the bundle, not the CLI) and is a **manual release-validation step** —
> documented in [docs/release.md](../../docs/release.md) under
> "DSH Bundle Validation".
