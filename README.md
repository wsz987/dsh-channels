# DeepSeek Harness Channels（dsh-channels）

[![CI](https://github.com/wsz987/dsh-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/wsz987/dsh-channels/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 实现的即时通讯渠道插件（社区项目，非官方）：内置 **微信 / QQ / 钉钉 / 飞书**，用统一的 `ctx.channels` API 收发消息。渠道集不固定——另有 [Telegram 扩展示例](packages/channel-telegram)，新渠道随时可接入（见文末二次开发规范）。

## ✨ 特性

- **内置渠道 + Web 可视化，一个 Bundle 装完**：聚合为 `@wsz987/dsh-channels`，含 Harness Web「设置 → 渠道」面板
- **官方 SDK / 协议直连**：QQ / 钉钉 / 飞书走各平台官方 SDK，微信直连腾讯 iLink（扫码登录 + 长轮询）
- **流式回复**：QQ C2C 原生流式、钉钉 / 飞书卡片流式（edit）、群聊 buffered
- **微信图片**：入站图片 CDN 下载解密 + 出站上传，附 typing 生命周期（不再只是 Text-only）
- **模型路由**：按 channel / account / conversation 分发不同模型，`agent.default` 兜底
- **渠道指令**：会话内斜杠指令（`/new`），官方命令注册器承载，未知指令不下发模型
- **凭据安全**：密钥走 `ctx.credentials`（不落盘、不入 git）；微信扫码凭据持久化，重启免登录
- **零改动扩展**：公开 Channel Contract，第三方渠道（如 Telegram / Slack / Discord）接入不改核心

## 🚀 快速开始

前提：能运行 DeepSeek Harness CLI（`npx @deepseek-ai/dsh`，官方推荐用法，详见 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）。

```bash
# 1. 安装 bundle 到 web profile（首次自动初始化 profile，装完自动合并 cordis.patch.yml）
npx @deepseek-ai/dsh plugin --profile web add @wsz987/dsh-channels

# 2. 确认合并：应看到 channels-service / channels-harness / channels-web /
#    channels-weixin / channels-qq / channels-dingtalk / channels-lark
npx @deepseek-ai/dsh --profile web --dump-config

# 3. 启动 Harness（等价于 --profile web）
npx @deepseek-ai/dsh web
```

装一个包即挂上完整链路：

```text
DSH profile（web） → @wsz987/dsh-channels bundle → ChannelService（ctx.channels）
      → Harness Bridge（channel-harness） → Weixin / QQ / DingTalk / Lark Adapter
```

不配置也能启动，完成对应渠道登录后即可收发消息。也可按需只装单渠道（`@wsz987/channel-weixin`、`-qq`、`-dingtalk`、`-lark`）。

### 本机开发（bundle 未发布时）

在**仓库根目录**用 dev 脚本链接本地构建产物（symlink 直连源码，改代码后 `pnpm build` + 重启即生效）：

```bash
pnpm build                    # 构建所有包
pnpm channels                 # 全部渠道（默认 profile: web）
pnpm channels weixin          # 只装微信，其余渠道自动禁用
pnpm channels qq dingtalk     # 多选
pnpm channels --profile dev qq
npx @deepseek-ai/dsh web      # 启动
```

- **渠道名自动发现**：来自 `packages/channels/cordis.patch.yml` 的行 id，新增渠道行即被识别；别名 `wx` → weixin、`feishu` → lark
- **单装语义**：脚本在 profile 的 `cordis.patch.yml` 中 `GENERATED` 标记后生成 `disabled: true` 禁用其余渠道；手写配置请放在标记之前（不会被覆盖）

## 🔌 渠道配置与登录

| 渠道 | 必需配置 | 登录方式 |
| --- | --- | --- |
| **微信** | 无需配置 | 通过 Web 面板或 `beginAuth()` 触发**扫码**登录（启动不会自动弹码），凭据持久化免登录 |
| **QQ** | `appId` + `appSecretRef` | [QQ 开放平台](https://q.qq.com/) 创建机器人；AppSecret 存 `ctx.credentials` |
| **钉钉** | `upstream.clientId` + `clientSecret` | [钉钉开放平台](https://open.dingtalk.com/) 创建应用，取 AppKey / AppSecret |
| **飞书** | `upstream.appId` + `appSecret` | [飞书开放平台](https://open.feishu.cn/) 创建应用，取 AppId / AppSecret |

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

**钉钉 / 飞书（SDK 模式）：**

```yaml
- id: channels-dingtalk
  name: '@wsz987/channel-dingtalk'
  config:
    upstream:
      mode: sdk
      clientId: "ding-xxx"        # AppKey
      clientSecret: "SECRET"      # AppSecret

- id: channels-lark
  name: '@wsz987/channel-lark'
  config:
    upstream:
      mode: sdk
      appId: "cli_xxx"
      appSecret: "SECRET"
      domain: feishu              # feishu（国内）| lark（海外）
```

## 📊 Web 可视化（新增）

`channel-web` 为 Harness Web 提供「设置 → 渠道」仪表盘（随 bundle 自动启用），并在 `/dsh-channels/api/v1` 暴露本地 API：

| 路由 | 说明 |
| --- | --- |
| `GET /channels` | 渠道状态总览（状态 / 健康 / 能力） |
| `GET /channels/:id` | 单渠道详情 |
| `POST /channels/:id/auth/start` | 发起登录挑战（微信出二维码） |
| `POST /channels/:id/auth/poll` | 轮询扫码状态 |
| `POST /channels/:id/auth/input` | 提交验证码等输入 |

状态变更请求仅限 loopback（403 保护），凭据与适配器内部 payload 永不出进程。

## 🧭 渠道总览

内置渠道（均通过契约 / fixtures / SDK 模拟离线测试；live 平台 E2E 需真实应用凭据，尚未执行）：

| 渠道 | 适配器包 | 接入方式 | 能力（已核验） | 状态 |
| --- | --- | --- | --- | --- |
| 微信 | `@wsz987/channel-weixin` | 直连腾讯 iLink（扫码 + 长轮询） | text / image · buffered | ⚠️ Experimental |
| QQ | `@wsz987/channel-qq` | 官方 SDK | text / image / file / audio / video / markdown* · native(C2C) / buffered | ✅ |
| 钉钉 | `@wsz987/channel-dingtalk` | 官方 stream SDK | text / image / file / audio / markdown / cards · edit | ✅ |
| 飞书 | `@wsz987/channel-lark` | 官方 Node SDK | text / image / file / audio / markdown / cards / threads · edit | ✅ |

`*` markdown 由 `markdownSupport` 配置开启。

**更多渠道**：`@wsz987/channel-telegram` 已作为扩展性证明存在（未正式支持）；Slack / Discord 等欢迎贡献，接入不改核心。

## 🧠 模型路由（新增）

`channel-harness` 支持按对话粒度分发模型，配置在 `channels-harness` 插件上：

```yaml
- id: channels-harness
  name: '@wsz987/channel-harness'
  config:
    agent:
      default: { preset: ..., provider: ..., model: ..., maxTokens: ... }  # 全局兜底
    routing:
      mode: conversation        # global | channel | account | conversation
      overrides:
        channel: { qq: { model: ... } }
        account: { main: { model: ... } }
        conversation: { "c2c:123": { model: ... } }
```

解析优先级：**conversation > account > channel > `agent.default`**。`mode: global` 只用兜底。

## ⌨️ 渠道指令

任意渠道会话里可直接发斜杠指令，由 Harness 官方 `@deepseek-ai/dsh-commands` 解析执行；**语法合法但未注册的指令会被拦截（"未知指令"），绝不下发模型**：

| 指令 | 说明 | 用法 |
| --- | --- | --- |
| `/new` | 为当前会话开启**全新 Harness 会话**（旧会话由 bridge 自动回收） | 直接发送 `/new`，无参数 |

- 首个会话前直接发 `/new` 可跳过普通首条消息的建会话流程
- 会话运行中执行 `/new` 会被拒绝（"当前会话仍在运行"）
- 指令注册在 Agent 作用域，随 Agent 生命周期自动装卸；**新增指令**只需在 `packages/channel-harness/src/commands/` 加一个 factory（见文末二次开发规范）

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
| `packages/channel-{weixin,qq,dingtalk,lark}` | 内置渠道适配器（`channel-telegram` 为扩展性示例） |
| `packages/channel-{compat,testkit,verify,web}` | 契约验证 / 测试工具 / Web 可视化 |
| `templates/channel-adapter` | 新渠道脚手架 |

### 使用核心包（channel-core）

适配器只需实现 `ChannelAdapter` 契约，核心自动完成注册 / 挂载 / 回执 / 健康检查：

```ts
import { defineChannelAdapter } from '@wsz987/channel-core';

export default defineChannelAdapter({
  id: 'my-channel',
  capabilities: { text: true, image: true, streaming: 'buffered' },
  async start(ctx) { /* 连接平台、ctx.emit('message', ...) */ },
  async stop() { /* 幂等清理 */ },
  async send(target, message) { /* 发送 */ },
  // 可选：createReply 流式 / beginAuth+pollAuth 扫码 / getHealth 健康
});
```

三条红线（详见 [docs/adapter-authoring.md](docs/adapter-authoring.md)）：

1. 适配器**禁止** import Harness Agent API（`ctx.agents...`）
2. 平台原始 payload 必须映射为结构化 `MessagePart`，**禁止**直塞给模型
3. 契约表达不了的需求 → 上报 contract gap，**禁止**改 channel-core / channel-harness

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
