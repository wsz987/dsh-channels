<div align="center">

# dsh-channels

Connect WeChat, QQ, DingTalk, Lark and Telegram to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

Multi-channel integration with unified configuration — chat with your Agent on every platform

Send and receive images and files, with PDF, DOCX, XLSX and text content readable by the Agent

[![CI](https://github.com/wsz987/dsh-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/wsz987/dsh-channels/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40wsz987%2Fdsh-channels)](https://www.npmjs.com/package/@wsz987/dsh-channels)
[![npm downloads](https://img.shields.io/npm/dm/%40wsz987%2Fdsh-channels)](https://www.npmjs.com/package/@wsz987/dsh-channels)
[![GitHub stars](https://img.shields.io/github/stars/wsz987/dsh-channels?style=flat)](https://github.com/wsz987/dsh-channels/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

English | [简体中文](README.md)

</div>

> This project adapts each platform's OpenClaw-oriented channel integration to DeepSeek Harness using the official SDKs / APIs. It does not depend on OpenClaw at runtime.
>
> Community project, not an official DeepSeek component.

## Preview

Once installed, configure and authorize channels via QR code in the Harness Web "Settings → Channels" panel, then chat with your Agent directly in each platform's conversation (screenshots from [docs/ScreenShot](./docs/ScreenShot)):

**Harness Web · Channels settings and Telegram integration example (image and file transfer, attachment reading)**

<p align="center">
  <img src="./docs/ScreenShot/dsh-channels-setting.png" alt="Harness Web channel settings panel" width="43%"/>
  <img src="./docs/ScreenShot/telegram.png" alt="Telegram integration example: image and file transfer with attachment reading" width="54%"/>
</p>

**Platform conversations**

<p align="center">
  <img src="./docs/ScreenShot/weixin.jpg" alt="WeChat conversation" width="24%"/>
  <img src="./docs/ScreenShot/qq.jpg" alt="QQ conversation" width="24%"/>
  <img src="./docs/ScreenShot/dingding.jpg" alt="DingTalk conversation" width="24%"/>
  <img src="./docs/ScreenShot/feishu.jpg" alt="Lark conversation" width="24%"/>
</p>

## Capability matrix

| Channel | Text | Images | Files | Streaming | Status |
| --- | --- | --- | --- | --- | --- |
| WeChat | Yes | send/receive | inbound read | - | ✅ |
| QQ | Yes | send/receive | send/receive | Yes | ✅ |
| DingTalk | Yes | send/receive | send/receive | Yes | ✅ |
| Lark | Yes | send/receive | send/receive | Yes | ✅ |
| Telegram | Yes | send/receive | send/receive | Yes | ✅ |

- Vision-capable multimodal models can inspect images directly; PDF, DOCX, XLSX and text attachments can be extracted for the Agent to read (100 MiB inbound limit per file); audio and video are currently degraded.

## Before you start

- Confirm that `npx @deepseek-ai/dsh` runs and a normal Harness Web session can chat.
- Channel sessions normally use `Workspace Write`; enable `Full access` only when the task must access files outside the Workspace and you trust it.
- The project is evolving quickly; back up your data before upgrading.

## Installation

```bash
# Install the stable bundle
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest

# Verify the bundle was merged into the profile
npx @deepseek-ai/dsh --profile web --dump-config

# Start Harness Web
npx @deepseek-ai/dsh web
```

After installation, configure or log in to the channels you need in Harness Web "Settings → Channels".

### Update and uninstall

Keep the `-w` flag when installing, updating and uninstalling.

```bash
# Update within the current package.json version range
npx @deepseek-ai/dsh plugin --profile web update -w @wsz987/dsh-channels

# Uninstall the bundle
npx @deepseek-ai/dsh plugin --profile web remove -w @wsz987/dsh-channels
```

## Configuration and login

| Channel | Required | Login |
| --- | --- | --- |
| WeChat | none | QR-code login; credentials auto-persist |
| QQ | AppID, AppSecret | Create a bot on the [QQ open platform](https://q.qq.com/qqbot/openclaw/) |
| DingTalk | clientId, clientSecret (optional) | Scan a QR code, or create an app on the [DingTalk open platform](https://open-dev.dingtalk.com/) |
| Lark | AppId, AppSecret | Create an app on the [Lark open platform](https://open.feishu.cn/app), or scan a QR code to create an agent |
| Telegram | Bot Token | Create a bot in [@BotFather](https://t.me/BotFather) and enter the token |

Harness manages secrets; put only references such as `appSecretRef` in `cordis.patch.yml`. See [minimal-profile](apps/example/minimal-profile/) for a complete example. A config patch replaces the whole `config`; it is not a deep merge.

### First use: identify your chat account

After a channel connects, use **Secure access** to confirm who may use the local Agent through the bot. The system never treats everyone who can message the bot as authorized by default.

- WeChat automatically selects the account used for the current QR-code login and limits access to that account.
- For QQ, DingTalk, Lark, and Telegram, select **Identify my account**, send the one-time identification command to the bot in a private chat, then confirm the detected account on the local page.
- After confirmation, the default mode is **Owner only**: only the confirmed account may drive the Agent in a private chat, and group access remains disabled.

While the owner is unidentified, or when the access policy is missing or invalid, the channel may stay connected so account identification can work. All ordinary messages and commands are blocked before they reach the Agent, create a session, or execute operations such as `/stop`. A preselected **Owner only** option is only a suggested draft; it does not take effect until an owner has been identified and confirmed.

Direct-message access can be set to **Disabled**, **Owner only**, **Specific users**, or **Everyone (danger)**. Group-chat access is configured separately and requires each allowed group to be added explicitly. Selecting **Everyone** for direct messages never opens any group chat automatically.

## Common operations

### Channel commands

In any channel conversation you can send slash commands, parsed and executed by Harness's official command system:

| Command | Description |
| --- | --- |
| `/stop` | Stop the current task immediately (highest priority: does not wait for queued channel messages; cancels the current agent directly) |
| `/new` | Start a fresh session (try it if you hit a bug) |
| `/help [command]` | List the commands active in the current session, or show one command's usage |
| `/status` | Show the current session / agent / model status |
| `/models [provider]` | List the model providers and their models registered in Harness |
| `/model [<provider> <model> [<reasoningEffort>]]` | Show or switch the current session's model |

If the host loads official plugins (`/compact`, `/goal`, `/plan`, `/feedback`, ...), those commands also appear in channels automatically — no channel upgrade needed.
**Unregistered slash commands are no longer intercepted**: they pass through to the model as ordinary user input.

#### `/model` examples

```text
/model                       # show the current model
/model deepseek deepseek-chat
/model openai gpt-5.6 high   # specify a reasoning effort
```

> `/model` also sets the global default model at the same time (visible in the Web UI / new sessions, no refresh needed).

### Proactive send

Have the Agent call `send_channel_message` inside a channel session to proactively send text, images or supported files to the current channel. Plain sessions created directly in Harness Web have no channel binding and cannot send out of band.

### Workspace isolation

By default each channel / account pair gets an isolated Workspace at `<dsh-home>/workspaces/channels/<channel>/<account>` — no extra configuration required.

To reuse the Harness launch directory or disable isolation, override `channels-harness` in the profile patch:

```yaml
- id: channels-harness
  name: '@wsz987/dsh-channels/harness'
  inject: [channels, agents, agentDefaultModel, llm, commands]
  config:
    workspace:
      mode: channel-account # channel-account (default) | host-cwd | disabled
      autoCreate: true
```

> A Harness patch replaces the whole target plugin config — it is not a merge; keep all required fields when overriding.

### Disable unused channels

Set the corresponding channel plugin's `enabled` to `false` in the profile patch, or delete the optional `channels-files` line to turn off the generic file extension.

## Known limitations

| Current limitation | Workaround | Planned direction |
| --- | --- | --- |
| No permission-switching command in channels | Adjust the default permission for future sessions in Harness Web, or change the Access setting of the session | Improve in-channel session management |

This limitation means the channel interaction layer has not yet wired up the corresponding capability — not that Harness lacks it. See the [Harness Reference](https://deepseek-harness.github.io/deepseek-harness/reference/) for the underlying upstream capabilities.

## Roadmap

- Improve in-channel session management and error recovery.
- Support more IM channels (wishlist).

## Running from source

```bash
git clone https://github.com/wsz987/dsh-channels.git
cd dsh-channels
pnpm install
pnpm build
pnpm channels
pnpm web:debug
```

- `pnpm channels` can select channels, e.g. `pnpm channels weixin qq`.
- Rebuild and restart Harness after code changes; run `pnpm channels:clean` before switching back to the npm version.

Run the full gate before submitting:

```bash
pnpm ci:check
```

## 📚 Documentation

- [Architecture overview](docs/architecture.md)
- [Common/unified code design](docs/architecture/common-design.md)
- [Multi-channel planning](docs/architecture/channel-roadmap.md)
- [Architecture decision records (ADR)](docs/architecture/adr/)
- [Inbound access control (security)](docs/security/inbound-access-control.md)
- [Channel identity map (security)](docs/security/channel-identity-map.md)
- [Third-party adapter authoring guide](docs/adapter-authoring.md)
- [Release pipeline](docs/release.md)
- [Weixin live verification runbook](docs/weixin-live-verification-runbook.md)
- [Archived docs (historical plans / superseded records)](docs/archive/)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- Per-package READMEs: `packages/*/README.md` (install / config / dev notes for each package)

---

## 🤝 Development guide

Follows the layering convention of mainstream open-source projects (Koishi / Wechaty style): **the adapter layer never touches core; core is unaware of platforms**.

### Repository structure

| Directory | Responsibility |
| --- | --- |
| `packages/channels` | Public bundle `@wsz987/dsh-channels` (aggregated patch) |
| `packages/channel-core` | **Channel Contract**: types + `ctx.channels` Service + `defineChannelAdapter` |
| `packages/channel-harness` | Channel ↔ Harness bridge; keeps only the optional `ChannelFileProvider` port |
| `packages/channel-files` | Optional generic-file extension: private storage, mature doc parsers, read tool |
| `packages/channel-control` | Control plane: config / credentials / QR auth / runtime lifecycle |
| `packages/channel-{weixin,qq,dingtalk,lark,telegram}` | The five built-in channel adapters |
| `packages/channel-{compat,testkit,verify,web}` | Contract verification / test tooling / Web visualization |
| `templates/channel-adapter` | Scaffold for new channels |

### Using the core package (channel-core)

An adapter only implements the `ChannelAdapter` contract; core handles registration / mounting / receipt / health checks automatically:

```ts
import { defineChannelAdapter } from '@wsz987/channel-core';

export default defineChannelAdapter({
  id: 'my-channel',
  capabilities: {
    text: true, image: false, file: false,
    audio: false, video: false, markdown: false,
    cards: false, reactions: false, threads: false,
    streaming: 'buffered',   // native | edit | buffered
  },
  async start(ctx) { /* connect the platform, ctx.emit('message', ...) */ },
  async stop() { /* idempotent cleanup */ },
  async send(target, message) { /* send */ },
  // optional: createReply streaming / beginAuth+pollAuth QR / getHealth
});
```

Three red lines (see [docs/adapter-authoring.md](docs/adapter-authoring.md)):

1. **Never special-case a channel in core** — channel differences are negotiated by core via `capabilities`
2. Adapters must **not** call Harness Agent APIs (`ctx.agents...`)
3. Raw platform payloads must be mapped to structured `MessagePart` — never fed to the model directly

If the contract cannot express a need, report a contract gap — never modify channel-core / channel-harness.

### Adding a channel in four steps

1. Copy `templates/channel-adapter` to `packages/channel-<name>` and implement `defineChannelAdapter` (config / transport / mapper)
2. Add one line to `packages/channels/cordis.patch.yml` (`pnpm channels` auto-detects new channels)
3. `pnpm build && pnpm typecheck && pnpm test`
4. `pnpm verify packages/channel-<name> --test` to run contract verification (fixtures + manifest + test suite)

### Adding channel commands

Commands live as factories in `packages/channel-harness/src/commands/`; adding them to the `commandFactories` array registers them with the Agent automatically (official `@deepseek-ai/dsh-commands` format, no bridge changes needed):

```ts
// packages/channel-harness/src/commands/reset.ts
export function createResetCommand(deps: ChannelCommandDependencies): CommandDefinition {
  return {
    name: 'reset',
    description: 'Reset the current session',
    async handler(invocation) {
      if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: 'Usage: /reset' };
      if (invocation.agent.status !== 'idle') return { kind: 'error', text: 'The current session is still running, please try again later.' };
      // ...call the bridge capability provided by deps
      return { kind: 'success', text: 'Session reset.' };
    },
  };
}
```

- `commandFactories` is the single registration point: `['createNewCommand', createResetCommand]`
- When a new bridge capability is needed, add a method (platform-agnostic) to `ChannelCommandDependencies` and implement it on the bridge side

### Commit and release

- **Commit**: Conventional Commits (`feat(scope): ...` / `fix(scope): ...` / `docs: ...`), scope is the package name (e.g. `channel-qq`)
- **PR**: pass CI (build + typecheck + test + contract verification + pre-live-gate checks)
- **Release**: record changes with `pnpm changeset` → `pnpm release` after CI merge (Changesets auto-publishes, see [docs/release.md](docs/release.md))

## 🙏 Acknowledgements

This project builds on the following open-source projects:

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — DeepSeek Harness (`@deepseek-ai/*`)
- [DingTalk-Real-AI/dingtalk-openclaw-connector](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector) — DingTalk channel plugin (`@dingtalk-real-ai/dingtalk-connector`)
- [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot) — QQ bot channel plugin (`@tencent-connect/openclaw-qqbot`)
- [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark) — Lark channel plugin (`@larksuite/openclaw-lark`)
- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) — WeChat channel plugin (`@tencent-weixin/openclaw-weixin`)

## License

[MIT](LICENSE) © 2026 [wsz987](https://github.com/wsz987)
