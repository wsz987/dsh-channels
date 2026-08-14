# DeepSeek Harness Channels（dsh-channels）

[![CI](https://github.com/wsz987/dsh-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/wsz987/dsh-channels/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 实现的即时通讯渠道插件（社区项目，非官方）：**微信 / QQ / 钉钉 / 飞书**，用统一的 `ctx.channels` API 收发消息。

## 特性

- **四个内置渠道**，聚合为一个 DSH Bundle，装一个包即可接入
- **官方 SDK / 协议直连**：QQ / 钉钉 / 飞书走各平台官方 SDK，微信直连腾讯 iLink
- **流式回复**：QQ C2C 原生流式、钉钉 / 飞书卡片流式、群聊 buffered
- **凭据安全**：密钥走 `ctx.credentials`（不落盘、不入 git）；微信扫码登录后凭据持久化，重启免登录
- **可扩展**：公开 Channel Contract，第三方渠道（如 Telegram）零改动核心接入

## 安装

前提：已安装 DeepSeek Harness CLI（`dsh`），安装方式见 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。

```bash
# 1. 把 channels bundle 装进 Harness 的 web profile
#    （`dsh plugin` 首次使用会自动初始化 profile；bundle 声明了 dsh.bundle，
#      装完自动加入该 profile 的 dsh.profile.bundles 层并应用其 cordis.patch.yml）
dsh plugin --profile web add @wsz987/dsh-channels

# 2. 确认 bundle 已合并：dump-config 里应能看到 channels-service /
#    channels-harness / channels-weixin / channels-qq / channels-dingtalk / channels-lark
dsh --profile web --dump-config

# 3. 启动 Harness（`dsh web` 等价于 `dsh --profile web`）
dsh web
```

装这一个包即挂上完整链路：

```text
DSH profile（web）
  ↓
@wsz987/dsh-channels bundle
  ↓
ChannelService（channels-service）
  ↓
Harness Bridge（channels-harness）
  ↓
Weixin / QQ / DingTalk / Lark Adapter
```

不配置也能启动；完成对应渠道的登录后即可收发消息（见下）。

> 说明：`dsh plugin --profile <name> add <pkg>` 就是在该 profile 内执行 pnpm 安装，
> 首次使用自动初始化 profile——**没有 `dsh profile create` 这一步**。
> 装到哪个 profile 由 `--profile` 决定（`web` 为 Harness 内置模板，也可用其他名称）。

按需也可只装某个渠道（同样通过 `dsh plugin --profile <name> add`）：`@wsz987/channel-weixin`、`@wsz987/channel-qq`、`@wsz987/channel-dingtalk`、`@wsz987/channel-lark`。

## 渠道配置与登录

| 渠道 | 必需配置 | 登录方式 |
| --- | --- | --- |
| **微信** | 无需配置 | 通过 `beginAuth()` / `pollAuth()` 触发**扫码**登录（启动不会自动弹二维码），凭据持久化，重启免登录 |
| **QQ** | `appId` + `appSecretRef` | [QQ 开放平台](https://q.qq.com/) 创建机器人；AppSecret 存 `ctx.credentials`（如环境变量 `QQBOT_APP_SECRET`） |
| **钉钉** | `upstream.clientId` + `clientSecret` | [钉钉开放平台](https://open.dingtalk.com/) 创建应用，取 AppKey / AppSecret |
| **飞书** | `upstream.appId` + `appSecret` | [飞书开放平台](https://open.feishu.cn/) 创建应用，取 AppId / AppSecret |

配置通过 profile patch（`cordis.patch.yml`）下发。patch 会**整体替换**目标插件配置，需写全所需字段；完整示例见 [apps/example/minimal-profile/](apps/example/minimal-profile/)。

**QQ（完整 patch 示例）**：

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

**钉钉 / 飞书（SDK 模式）**：

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

**微信**：无需配置密钥。扫码登录由 `beginAuth()` / `pollAuth()` 触发（QR 状态机：等待扫码 → 确认 → 绑定）——启动后**不会自动弹出二维码**，看不到二维码不代表插件未加载。凭据写入 SecretStore，重启自动恢复。当前为 **Text-only**（图片/语音/文件/视频媒体路径开发中）。

## 渠道总览

| 渠道 | 适配器包 | 接入方式 | 上游 GitHub | 状态 |
| --- | --- | --- | --- | --- |
| 微信 | `@wsz987/channel-weixin` | 直连腾讯 iLink（扫码登录 + 长轮询） | [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) | ⚠️ Experimental · Text-only |
| QQ | `@wsz987/channel-qq` | 官方 SDK（C2C 流式 + 群聊 buffered） | [tencent-connect/bot-node-sdk](https://github.com/tencent-connect/bot-node-sdk) | ✅ |
| 钉钉 | `@wsz987/channel-dingtalk` | 官方 stream SDK + AI Card 流式 | [open-dingtalk/dingtalk-stream-sdk-nodejs](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs) | ✅ |
| 飞书 | `@wsz987/channel-lark` | 官方 Node SDK（可编辑卡片流式） | [larksuite/node-sdk](https://github.com/larksuite/node-sdk) | ✅ |

✅ = 离线测试（契约 / fixtures / SDK 模拟）通过；live 平台 E2E 需真实应用凭据，尚未执行。

## 规划中

- **Telegram**：`@wsz987/channel-telegram` 已作为扩展性证明存在，尚未正式支持
- **Slack / Discord 等**：欢迎贡献（见下方第三方接入指南）

## 第三方渠道接入

```ts
import { defineChannelAdapter } from '@wsz987/channel-core';

export default defineChannelAdapter({
  id: 'my-channel',
  capabilities: { text: true, streaming: 'buffered' },
  async start(ctx) { /* ... */ },
  async send(target, message) { /* ... */ },
});
```

脚手架 `templates/channel-adapter/`，验证命令 `pnpm verify <dir> [--test]`，指南见 [docs/adapter-authoring.md](docs/adapter-authoring.md)。

## 开发

```bash
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

## 文档

- [架构设计](docs/deepseek-harness-channels-architecture.md)
- [第三方渠道接入指南](docs/adapter-authoring.md)
- [发布流程](docs/release.md)
- [第三方版权声明](THIRD_PARTY_NOTICES.md)

## License

[MIT](LICENSE) © 2026 [wsz987](https://github.com/wsz987)
