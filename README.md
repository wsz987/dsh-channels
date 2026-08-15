# DeepSeek Harness Channels（dsh-channels）

[![CI](https://github.com/wsz987/dsh-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/wsz987/dsh-channels/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

将 微信 / QQ / 钉钉 / 飞书 的 OpenClaw 接入插件移植到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，统一通过 `ctx.channels` API 收发消息（社区项目，非官方）。

**目录**

- [✨ 特性](#-特性)
- [🚀 快速开始](#-快速开始)
  - [📸 效果预览](#-效果预览)
  - [⌨️ 渠道指令](#-渠道指令)
- [🔌 渠道配置与登录](#-渠道配置与登录)
- [🧭 渠道总览](#-渠道总览)
- [🧭 工作区隔离](#-工作区隔离)
- [🛠 开发](#-开发)
- [📚 文档](#-文档)
- [🤝 二次开发规范](#-二次开发规范)

## ✨ 特性

- **一个包接入多渠道**：内置微信 / QQ / 钉钉 / 飞书，装完即在 Harness Web「设置 → 渠道」统一配置与扫码授权
- **扫码即登录**：微信扫码免配置，钉钉 / 飞书支持扫码授权或填写平台凭证，QQ 填写 AppID / AppSecret 即可
- **流式回复**：QQ / 钉钉 / 飞书支持边生成边输出
- **附件**：微信已支持收发图片，其余渠道待接入
- **工作区隔离**：各渠道 / 账号会话空间相互独立，互不串扰
- **渠道指令**：会话内支持 `/new` 等斜杠指令
- **凭据安全**：基于 DeepSeek Harness 凭据服务（`ctx.credentials`）存储密钥，扫码凭据持久化、重启免登录

## 🚀 快速开始

前提：能运行 DeepSeek Harness CLI（`npx @deepseek-ai/dsh`，官方推荐用法，详见 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）。

```bash
# 1. 安装 bundle 到 web profile（首次自动初始化 profile，装完自动合并 cordis.patch.yml）
npx @deepseek-ai/dsh plugin --profile web add @wsz987/dsh-channels

# 2. 确认合并：应看到 channels-service / channels-harness / channels-control /
#    channels-web / channels-weixin / channels-qq / channels-dingtalk / channels-lark
npx @deepseek-ai/dsh --profile web --dump-config

# 3. 启动 Harness（等价于 --profile web）
npx @deepseek-ai/dsh web
```

装一个包即集成微信 / QQ / 钉钉 / 飞书等，各渠道在 Harness Web「设置 → 渠道」面板完成登录：

- **微信**：扫码即登录
- **钉钉 / 飞书**：扫码授权，或填写平台凭证
- **QQ**：填写 AppID / AppSecret 即可收发

按需可只装单渠道（`@wsz987/channel-weixin`、`-qq`、`-dingtalk`、`-lark`），详细配置见下文。

### 📸 效果预览

接入后，在 Harness Web「设置 → 渠道」面板统一配置与扫码授权，并在各平台对话框中直接与 Agent 对话（图片来源：[docs/ScreenShot](docs/ScreenShot)）：

**Harness Web · 渠道设置面板**

<p align="center">
  <img src="docs/ScreenShot/dsh-channels-setting.png" alt="Harness Web 渠道设置面板" width="560"/>
</p>

**各平台对话框**

<p align="center">
  <img src="docs/ScreenShot/weixin.jpg" alt="微信对话" width="24%"/>
  <img src="docs/ScreenShot/qq.jpg" alt="QQ 对话" width="24%"/>
  <img src="docs/ScreenShot/dingding.jpg" alt="钉钉对话" width="24%"/>
  <img src="docs/ScreenShot/feishu.jpg" alt="飞书对话" width="24%"/>
</p>


### ⌨️ 渠道指令

任意渠道会话内可直接发斜杠指令，由 Harness 官方命令系统解析执行：

| 指令 | 说明 |
| --- | --- |
| `/new` | 开启全新会话 |

未注册的指令会被拦截（"未知指令"），不会发给模型。

### 从源码运行（Run from source）

```bash
git clone https://github.com/wsz987/dsh-channels.git
cd dsh-channels
pnpm install
pnpm build
pnpm channels              # 构建产物直链到 dsh profile（symlink 指源码）
pnpm web:debug             # 启动 dsh web
```

- `pnpm channels` 不带参 = 全装；可指定渠道（`pnpm channels weixin`、`pnpm channels weixin qq`），渠道名自动识别（别名 `wx` → weixin、`feishu` → lark），未选渠道自动禁用
- 改完代码 `pnpm build` + 重启即生效
- `web:debug`：`dsh web` + 调试日志，落盘 `dsh-web.log`

## 🔌 渠道配置与登录

| 渠道 | 配置 | 配置方式 |
| --- | --- | --- |
| **微信** | 无 | **扫一扫**：扫码即登录，凭据持久化免登录，无其他配置 |
| **QQ** | **AppID** + **AppSecret** | [QQ 开放平台](https://q.qq.com/qqbot/openclaw/) 创建机器人 → 填写 **AppID** / **AppSecret** |
| **钉钉** | `clientId` + `clientSecret`（可选） | **扫一扫**，或手动到 [钉钉开放平台](https://open-dev.dingtalk.com/) 创建应用，配置 `clientId` / `clientSecret` |
| **飞书** | **AppId** + **AppSecret** | 到 [飞书开放平台](https://open.feishu.cn/) 创建应用，配置 **AppId** / **AppSecret**，然后扫一扫创建智能体 |


配置通过 profile patch（`cordis.patch.yml`）下发，patch 会**整体替换**目标插件配置，需写全字段；完整示例见 [apps/example/minimal-profile/](apps/example/minimal-profile/)。

**QQ：**

```yaml
- id: channels-qq
  name: '@wsz987/channel-qq'
  inject: [channels, credentials]
  config:
    accountId: main
    appId: "102345678"               # QQ 开放平台 AppId
    appSecretRef: QQBOT_APP_SECRET   # 真实 AppSecret 只存 ctx.credentials
    markdownSupport: false
    streaming: { enabled: true, throttleMs: 500 }
    dedup: { enabled: true, windowMs: 5000 }
```

**钉钉（SDK 模式）：**

```yaml
- id: channels-dingtalk
  name: '@wsz987/channel-dingtalk'
  config:
    upstream:
      mode: sdk
      clientId: "ding-xxx"        # AppKey（非机密，可写 config）
      # clientSecretRef 默认 DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET
      # 真实 AppSecret 只存 ctx.credentials
```

**飞书（SDK 模式）：**

```yaml
- id: channels-lark
  name: '@wsz987/channel-lark'
  config:
    upstream:
      mode: sdk
      appId: "cli_xxx"            # AppId（非机密，可写 config）
      domain: feishu              # feishu（国内）| lark（海外）
      # appSecretRef 默认 DSH_CHANNEL_LARK_MAIN_APP_SECRET
      # 真实 AppSecret 只存 ctx.credentials
```

钉钉 / 飞书的 AppSecret 无需写进配置文件：在 Harness Web「设置 → 渠道」直接填写，或用环境变量 `DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET` / `DSH_CHANNEL_LARK_MAIN_APP_SECRET` 提供即可。

## 🧭 渠道总览

| 渠道 | 现在能做什么 | 状态 |
| --- | --- | --- |
| 微信 | 文本对话 · 图片收发 | ✅ |
| QQ | 文本对话 · 流式回复 | ✅ |
| 钉钉 | 文本对话 · 流式回复 | ✅ |
| 飞书 | 文本对话 · 流式回复 | ✅ |

> 入站媒体（图片 / 文件 / 音频 / 视频）尚未接入 Harness 真实附件——除微信图片外，其余渠道进入模型时仍为文本占位符；file / audio / video 需等 Harness 官方扩展（见 [接入计划](docs/dsh-channels-release-verification-execution-plan.md)）。

**第三方渠道**：如 Telegram 等，待接入。

## 🧭 工作区隔离

按渠道开辟独立会话空间：默认每个**渠道 / 账号**对应一个独立 Harness Workspace（`<dsh-home>/workspaces/channels/<渠道>/<账号>`，自动创建），各渠道的会话、文件互不串扰。默认配置即可用，无需手动设置；如需自定义，配置在 `channels-harness` 插件上：

```yaml
- id: channels-harness
  name: '@wsz987/channel-harness'
  config:
    workspace:
      mode: channel-account   # channel-account（默认）| host-cwd | disabled
```

## 🛠 开发

```bash
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

常用校验：`pnpm doctor`（渠道诊断 + 发布门禁）、`pnpm verify <dir> [--test]`（适配器契约验证）、`pnpm check:fixtures` / `check:manifests` / `check:upstream`。

## 📚 文档

- [架构设计](docs/deepseek-harness-channels-architecture.md)
- [第三方渠道接入指南](docs/adapter-authoring.md)
- [发布流程](docs/release.md)
- [微信 live 验证手册](docs/weixin-live-verification-runbook.md)
- [第三方版权声明](THIRD_PARTY_NOTICES.md)

---

## 🤝 二次开发规范

参考主流开源项目（Koishi / Wechaty 风格）的分层约定：**适配器层零侵入核心，核心层不感知平台**。

### 仓库结构

| 目录 | 职责 |
| --- | --- |
| `packages/channels` | 对外 bundle `@wsz987/dsh-channels`（聚合 patch） |
| `packages/channel-core` | **Channel Contract**：类型 + `ctx.channels` Service + `defineChannelAdapter` |
| `packages/channel-harness` | 渠道 ↔ Harness 桥（唯一允许 import Harness API 的地方） |
| `packages/channel-control` | 控制面：配置 / 凭据 / 扫码授权 / 运行时生命周期 |
| `packages/channel-{weixin,qq,dingtalk,lark}` | 内置渠道适配器 |
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

## License

[MIT](LICENSE) © 2026 [wsz987](https://github.com/wsz987)
