<div align="center">

# dsh-channels

将微信、QQ、钉钉、飞书和 Telegram 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

多渠道集成，统一配置，并在各平台与 Agent 对话

支持图片与文件收发，Agent 可直接读取 PDF、DOCX、XLSX 和文本内容

[![CI](https://github.com/wsz987/dsh-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/wsz987/dsh-channels/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40wsz987%2Fdsh-channels)](https://www.npmjs.com/package/@wsz987/dsh-channels)
[![npm downloads](https://img.shields.io/npm/dm/%40wsz987%2Fdsh-channels)](https://www.npmjs.com/package/@wsz987/dsh-channels)
[![GitHub stars](https://img.shields.io/github/stars/wsz987/dsh-channels?style=flat)](https://github.com/wsz987/dsh-channels/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

[English](README.en.md) | 简体中文

</div>

> 本项目参考各平台面向 OpenClaw 提供的渠道接入方案，结合官方 SDK / API 适配到 DeepSeek Harness。运行时不依赖 OpenClaw。

## 效果预览

接入后，在 Harness Web“设置 → 渠道”面板统一配置与扫码授权，并在各平台对话框中直接与 Agent 对话（图片来源：[docs/ScreenShot](./docs/ScreenShot)）：

**Harness Web · 渠道设置面板与 Telegram 对话**

<p align="center">
  <img src="./docs/ScreenShot/dsh-channels-setting.png" alt="Harness Web 渠道设置面板" width="43%"/>
  <img src="./docs/ScreenShot/telegram.png" alt="Telegram 图片与附件对话" width="54%"/>
</p>

**各平台对话框**

<p align="center">
  <img src="./docs/ScreenShot/weixin.jpg" alt="微信对话" width="24%"/>
  <img src="./docs/ScreenShot/qq.jpg" alt="QQ 对话" width="24%"/>
  <img src="./docs/ScreenShot/dingding.jpg" alt="钉钉对话" width="24%"/>
  <img src="./docs/ScreenShot/feishu.jpg" alt="飞书对话" width="24%"/>
</p>

## 能力总览

| 渠道 | 文本 | 图片 | 文件 | 流式回复 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 微信 | 支持 | 收发 | 入站读取 | - | ✅ |
| QQ | 支持 | 收发 | 收发 | 支持 | ✅ |
| 钉钉 | 支持 | 收发 | 收发 | 支持 | ✅ |
| 飞书 | 支持 | 收发 | 收发 | 支持 | ✅ |
| Telegram | 支持 | 收发 | 收发 | 支持 | ✅ |

- 收到的图片通过 Harness 原生图片链路传递给支持视觉的模型。
- 通用文件支持 PDF、DOCX、XLSX 和文本；入站附件会被保存并提取内容，Agent 可通过 `read_channel_attachment` 读取和识别，单文件上限为 100 MiB。
- `send_channel_message` 支持主动发送文本和图片；文件外发支持 QQ、钉钉 SDK、飞书和 Telegram（Bot API multipart）。
- 音频和视频目前会降级处理。

## 使用前须知

> **迭代期提示**：项目仍在快速迭代，版本升级可能调整配置或本地数据格式。
> 升级前请备份相关数据；现阶段不要把重要数据的唯一副本存放在渠道工作区会话中。

| 检查项 | 要求 |
| --- | --- |
| Harness CLI | 已能运行 `npx @deepseek-ai/dsh` |
| LLM 模型 | 先在 Harness Web 的“设置 → 模型”中配置模型提供方、凭据和默认模型，并确认普通 Web 会话可以正常对话。参见 [Harness 官方配置参考](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog) |
| 会话权限 | 渠道会话遵循 Harness 权限预设。新会话默认通常为 `Workspace Write`，可修改当前 Workspace 内的文件，访问更大范围时需要审批 |

任务确实需要访问 Workspace 外的文件时，可为对应会话选择 `Full access`。详见 [Harness 权限预设参考](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/permission-presets)。

> **安全警告**：`Full access` 会解除 DSH 文件沙箱限制并关闭审批提示。Agent 将能够修改运行进程有权访问的任意路径。请仅在信任当前任务、工作目录和模型时启用，并提前备份重要数据。

## 安装

```bash
# 安装稳定版 bundle
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest

# 检查 bundle 是否合并到 profile
npx @deepseek-ai/dsh --profile web --dump-config

# 启动 Harness Web
npx @deepseek-ai/dsh web
```

安装完成后，在 Harness Web 的“设置 → 渠道”中配置或登录需要使用的渠道。

### 更新与卸载

安装、更新和卸载时请保留 `-w` 参数。

```bash
# 在当前 package.json 版本范围内更新
npx @deepseek-ai/dsh plugin --profile web update -w @wsz987/dsh-channels

# 卸载 bundle
npx @deepseek-ai/dsh plugin --profile web remove -w @wsz987/dsh-channels
```

## 配置与登录

| 渠道 | 必要信息 | 登录方式 |
| --- | --- | --- |
| 微信 | 无 | 扫码登录，凭据自动持久化 |
| QQ | AppID、AppSecret | [QQ 开放平台](https://q.qq.com/qqbot/openclaw/)创建机器人 |
| 钉钉 | clientId、clientSecret（可选） | 扫码或在[钉钉开放平台](https://open-dev.dingtalk.com/)创建应用 |
| 飞书 | AppId、AppSecret | 在[飞书开放平台](https://open.feishu.cn/app)创建应用，或扫码创建智能体 |
| Telegram | Bot Token | 在 [@BotFather](https://t.me/BotFather) 创建机器人并填写 Token |

密钥不要写入 `cordis.patch.yml`。配置中只填写凭据引用，例如 `appSecretRef`；真实值由 Harness `ctx.credentials` 管理。完整配置示例见 [apps/example/minimal-profile](apps/example/minimal-profile/)。配置 patch 会整体替换目标插件的 `config`，不是深度合并。

## 常用操作

### 渠道指令

任意渠道会话内可直接发斜杠指令，由 Harness 官方命令系统解析执行：

| 指令 | 说明 |
| --- | --- |
| `/new` | 开启全新会话（遇到 bug 可以尝试使用） |

未注册的指令会被拦截（“未知指令”），不会发给模型。后续版本会继续完善更多渠道指令。

### 主动外发

在渠道会话中让 Agent 调用 `send_channel_message`，可以主动向当前渠道发送文本、图片或支持的文件。Harness Web 直接创建的普通会话没有渠道绑定，不能执行渠道外发。

### Workspace 隔离

默认按“渠道 / 账号”创建独立 Workspace，路径为 `<dsh-home>/workspaces/channels/<channel>/<account>`，无需额外配置。

如需复用 Harness 启动目录或关闭隔离，可在 profile patch 中覆盖 `channels-harness`：

```yaml
- id: channels-harness
  name: '@wsz987/dsh-channels/harness'
  inject: [channels, agents, agentDefaultModel, llm, commands]
  config:
    workspace:
      mode: channel-account # channel-account（默认）| host-cwd | disabled
      autoCreate: true
```

> Harness patch 会整体替换目标插件配置，并非局部合并；覆盖时请保留该插件需要的完整字段。

### 关闭不需要的渠道

在 profile patch 中将对应渠道插件的 `enabled` 设为 `false`，或删除可选的 `channels-files` 行以关闭通用文件扩展。

## 已知限制

| 当前限制 | 临时处理方式 | 后续方向 |
| --- | --- | --- |
| 无法从渠道终止正在运行的会话 | 模型长时间推理或工具调用未结束时，暂时需要等待本轮执行完成 | Harness 已提供 `Agent.cancel()`，后续增加 `/stop` 指令 |
| 无法在当前渠道会话中直接切换模型 | 先在 Harness Web 中选择模型，再发送 `/new` 创建使用新默认模型的会话 | 增加模型选择指令 |
| 渠道内没有权限切换指令 | 在 Harness Web 中调整未来新会话的默认权限，或修改对应会话的 Access 设置 | 完善渠道内的会话管理能力 |

上述限制是当前渠道交互层尚未接入对应能力，不代表 Harness 完全不支持取消或模型选择。相关上游能力可查阅 [Harness Reference](https://deepseek-harness.github.io/deepseek-harness/reference/)。

## Roadmap

- 增加 `/stop`、模型选择等渠道指令。
- 完善渠道内的会话管理和异常恢复体验。
- 接入更多即时通讯渠道（画饼中）。

## 从源码运行

```bash
git clone https://github.com/wsz987/dsh-channels.git
cd dsh-channels
pnpm install
pnpm build
pnpm channels
pnpm web:debug
```

- `pnpm channels` 可指定渠道，例如 `pnpm channels weixin qq`。
- 修改代码后重新构建并重启 Harness；切回 npm 版本前运行 `pnpm channels:clean`。

提交前运行完整门禁：

```bash
pnpm ci:check
```

## 📚 文档

- [架构总览](docs/architecture.md)
- [公共/统一代码设计](docs/architecture/common-design.md)
- [多渠道规划](docs/architecture/channel-roadmap.md)
- [架构决策记录（ADR）](docs/architecture/adr/)
- [第三方渠道接入指南](docs/adapter-authoring.md)
- [发布流程](docs/release.md)
- [微信 live 验证手册](docs/weixin-live-verification-runbook.md)
- [第三方版权声明](THIRD_PARTY_NOTICES.md)
- 各子包 README：`packages/*/README.md`（每个包的安装、配置、开发说明）

---

## 🤝 二次开发规范

参考主流开源项目（Koishi / Wechaty 风格）的分层约定：**适配器层零侵入核心，核心层不感知平台**。

### 仓库结构

| 目录 | 职责 |
| --- | --- |
| `packages/channels` | 对外 bundle `@wsz987/dsh-channels`（聚合 patch） |
| `packages/channel-core` | **Channel Contract**：类型 + `ctx.channels` Service + `defineChannelAdapter` |
| `packages/channel-harness` | 渠道 ↔ Harness 桥；只保留可选 `ChannelFileProvider` 端口 |
| `packages/channel-files` | 可选通用文件扩展：私有存储、成熟文档解析库、读取工具 |
| `packages/channel-control` | 控制面：配置 / 凭据 / 扫码授权 / 运行时生命周期 |
| `packages/channel-{weixin,qq,dingtalk,lark,telegram}` | 五个内置渠道适配器 |
| `packages/channel-{compat,testkit,verify,web}` | 契约验证 / 测试工具 / Web 可视化 |
| `templates/channel-adapter` | 新渠道脚手架 |

### 使用核心包（channel-core）

适配器只需实现 `ChannelAdapter` 契约，核心自动完成注册 / 挂载 / 回执 / 健康检查：

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
  async start(ctx) { /* 连接平台、ctx.emit('message', ...) */ },
  async stop() { /* 幂等清理 */ },
  async send(target, message) { /* 发送 */ },
  // 可选：createReply 流式 / beginAuth+pollAuth 扫码 / getHealth 健康
});
```

三条红线（详见 [docs/adapter-authoring.md](docs/adapter-authoring.md)）：

1. **不在 core 里按渠道做特判**——渠道差异由 core 按 `capabilities` 协商处理
2. 适配器**禁止**调用 Harness Agent API（`ctx.agents...`）
3. 平台原始 payload 必须映射为结构化 `MessagePart`，**禁止**直塞给模型

契约表达不了的需求 → 上报 contract gap，**禁止**改 channel-core / channel-harness。

### 新增渠道四步

1. 复制 `templates/channel-adapter` 为 `packages/channel-<name>`，实现 `defineChannelAdapter`（含 config / transport / mapper）
2. 在 `packages/channels/cordis.patch.yml` 加一行（`pnpm channels` 自动识别新渠道）
3. `pnpm build && pnpm typecheck && pnpm test`
4. `pnpm verify packages/channel-<name> --test` 跑契约验证（fixtures + manifest + 测试套件）

### 新增渠道指令

指令以 factory 形式放在 `packages/channel-harness/src/commands/`，加入 `commandFactories` 数组即随 Agent 自动注册（官方 `@deepseek-ai/dsh-commands` 格式，无需改 bridge）：

```ts
// packages/channel-harness/src/commands/reset.ts
export function createResetCommand(deps: ChannelCommandDependencies): CommandDefinition {
  return {
    name: 'reset',
    description: 'Reset the current session',
    async handler(invocation) {
      if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: '用法：/reset' };
      if (invocation.agent.status !== 'idle') return { kind: 'error', text: '当前会话仍在运行，请稍后再试。' };
      // ...调用 deps 提供的 bridge 能力
      return { kind: 'success', text: '已重置会话。' };
    },
  };
}
```

- `commandFactories` 是唯一注册点：`['createNewCommand', createResetCommand]`
- 需要 bridge 新能力时，在 `ChannelCommandDependencies` 加一个方法（平台无关），bridge 侧实现即可

### 提交与发布

- **Commit**：Conventional Commits（`feat(scope): ...` / `fix(scope): ...` / `docs: ...`），scope 用包名（如 `channel-qq`）
- **PR**：过 CI（build + typecheck + test + 契约验证 + live gate 前检）
- **发布**：`pnpm changeset` 记录变更 → CI 合入后 `pnpm release`（Changesets 自动发版，见 [docs/release.md](docs/release.md)）

## 🙏 致谢

本项目基于以下开源项目：

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) —— DeepSeek Harness（`@deepseek-ai/*`）
- [DingTalk-Real-AI/dingtalk-openclaw-connector](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector) —— 钉钉渠道插件（`@dingtalk-real-ai/dingtalk-connector`）
- [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot) —— QQ 机器人渠道插件（`@tencent-connect/openclaw-qqbot`）
- [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark) —— 飞书渠道插件（`@larksuite/openclaw-lark`）
- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) —— 微信渠道插件（`@tencent-weixin/openclaw-weixin`）

## License

[MIT](LICENSE) © 2026 [wsz987](https://github.com/wsz987)
