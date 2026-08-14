# DeepSeek Harness Channels（dsh-channels）

[![CI](https://github.com/wsz987/dsh-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/wsz987/dsh-channels/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-9.15.3-orange.svg)](package.json)

> 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的渠道插件实现
> （社区项目，非 DeepSeek 官方出品）：接入微信 / QQ / 钉钉 / 飞书四个即时通讯平台，
> 并提供一套面向第三方渠道的公共接入规范（Channel Contract）。
>
> 一句话：**DSH Bundle + Channel Core + Adapters** —— 在 Harness 的 Cordis 插件体系里，
> 用统一的 `ctx.channels` API 收发消息，按渠道接入各平台官方 SDK / 协议。

## 简介

`dsh-channels` 是基于 DeepSeek Harness 插件体系（Cordis）实现的渠道插件集。它把四个主流
即时通讯平台接入 Harness 的 Agent 运行时，同时把「渠道适配器」抽象成一个可发布的公共契约，
让任何第三方渠道（如 Telegram、Slack、Discord……）都能在**不改动 core / harness 一行代码**
的前提下接入。

- **四个内置渠道**：微信（Weixin）、QQ、钉钉（DingTalk）、飞书（Lark）——聚合为 `@wsz987/dsh-channels` DSH Bundle，一个 profile 配置即用。
- **公共 Channel SDK**：`defineChannelAdapter` + 契约测试套件 + 适配器脚手架 + 验证 CLI，第三方接入有章可循。
- **兼容性治理**：每个适配器携带上游 manifest（测试版本 / 版本范围 / 接入策略），配合 Renovate 与 CI 闸门，把「上游升级 → 回归验证 → 版本声明」做成闭环。

## 特性

- **统一消息模型**：所有渠道收敛到一套跨渠道 Contract（inbound 纯函数 mapper、outbound sender、reply 只消费 Harness 定义的 `session/event`），Session 按 `channel:account:conversation[:thread]` 隔离。
- **流式回复**：QQ C2C 原生流式、钉钉 AI Card 流式（chunk updates + throttle）、飞书可编辑卡片流式、群聊 buffered 策略。
- **平台官方 SDK 直连**：QQ / 钉钉 / 飞书走各平台官方 SDK，微信直连腾讯 iLink 客户端（QR 登录状态机 + getUpdates 长轮询），无自托管中间层。
- **纯插件架构**：`channel-core` 不依赖任何具体平台，`channel-harness` 不 import 任何平台 SDK；网络/长生命周期资源统一走 `ctx.effect()`，配置全部走 Schemastery。
- **开箱即用的发布产物**：所有包预构建 `lib/` + exports 子路径，消费者安装后无需编译 TypeScript。
- **契约测试 + 治理工具链**：`runChannelAdapterContract`、fixtures 全量 sweep、`channels doctor` 上游兼容性诊断、`pnpm verify` 第三方适配器验证。

## 支持的渠道

| 渠道 | 适配器包 | 接入方式 | 上游 SDK / 协议 | 上游 GitHub | npm | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| **微信** | `@wsz987/channel-weixin` | 直连腾讯 iLink 客户端（`ilinkai.weixin.qq.com`）：QR 登录状态机 + getUpdates 长轮询 + sendmessage，无自托管中间层 | [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（iLink 协议参考） | [GitHub](https://github.com/Tencent/openclaw-weixin) | — | ⚠️ Experimental · Text-only |
| **QQ** | `@wsz987/channel-qq` | 腾讯官方 SDK：C2C 原生流式 + 群聊 buffered + 私聊/群聊 | `@tencent-connect/qqbot-nodejs@1.0.4` | [tencent-connect/bot-node-sdk](https://github.com/tencent-connect/bot-node-sdk) | [npm](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs) | ✅ Tested（离线） |
| **钉钉** | `@wsz987/channel-dingtalk` | 官方 stream 模式 SDK 接入，AI Card 流式（chunk updates / throttle） | `dingtalk-stream@2.1.5` | [open-dingtalk/dingtalk-stream-sdk-nodejs](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs) | [npm](https://www.npmjs.com/package/dingtalk-stream) | ✅ Tested（离线） |
| **飞书 / Lark** | `@wsz987/channel-lark` | 官方 Node SDK：WebSocket 长连接事件 + HTTP 出站，threads → SessionBinding、可编辑卡片流式 | `@larksuiteoapi/node-sdk@1.73.0` | [larksuite/node-sdk](https://github.com/larksuite/node-sdk) | [npm](https://www.npmjs.com/package/@larksuiteoapi/node-sdk) | ✅ Tested（离线） |

> **说明**
>
> - **微信**：直接调用官方 iLink 端点；协议字段（`message_id` / `context_token` / QR 登录状态机等）对齐
>   [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT），见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
>   目前为 **Text-only**（WX5 图片/语音/文件/视频 CDN 路径为类型化脚手架，未接入 active 路径），live 平台验证尚未执行。
> - **QQ**：AppSecret 通过 `ctx.credentials` 接入，config 仅存 `appSecretRef` 引用（不落盘明文）；`channel-harness` 仅注入
>   `channels` + `agents`，`sessionPersistence` 为 use-site 可选服务。
> - **状态含义**：`Tested（离线）` = 契约测试 + fixtures + 离线 SDK 测试全绿；live 平台 E2E 需真实应用凭据（AppKey/AppSecret/ClientSecret），见「已知限制」。

## 规划中的渠道（Roadmap）

目前**正式支持**的渠道为上面四个；以下渠道在规划 / 孵化中：

- **Telegram**：`@wsz987/channel-telegram` 已作为**扩展性证明**存在——仅依赖公开 Channel Contract，
  零修改 core / harness / 内置四渠道，离线 `pnpm verify --test` 通过；**尚未作为正式支持渠道接入**
  （不进入 `@wsz987/dsh-channels` bundle）。
- **Slack / Discord 等**：欢迎按「第三方渠道接入」规范贡献（见 `docs/adapter-authoring.md`）。

## 架构与包结构

```text
apps/example/minimal-profile       ← 用户 DSH profile（bundle 安装 + 配置覆盖）
        │  dsh.profile.bundles + cordis.patch.yml
        ▼
@wsz987/dsh-channels                      ← DSH Bundle（cordis.patch.yml 注入 6 个插件）
        │
        ├── channel-weixin ────────┐
        ├── channel-qq ────────────┤
        ├── channel-dingtalk ──────┼──→ channel-core（Contract + ctx.channels）
        ├── channel-lark ──────────┘
        └── channel-harness（SessionBinding / AgentManager / ReplyRouter）
```

| 包 | 职责 |
| --- | --- |
| `@wsz987/channel-core` | 稳定跨渠道 Contract + `ChannelService`（`ctx.channels`，Cordis Service），零平台依赖 |
| `@wsz987/channel-harness` | **唯一** Harness API 边界：SessionBinding、AgentManager（AgentHandle ownership）、`session/event` → ReplyRouter |
| `@wsz987/channel-testkit` | `runChannelAdapterContract`、FakeAdapter / FakeUpstream / FakeHarness、fixture 加载、E2E |
| `@wsz987/channel-compat` | 上游兼容性治理：manifest 同步校验 / fixture sweep / `channels doctor` / checkAdapterCompatibility |
| `@wsz987/channel-verify` | 第三方适配器验证 CLI（`pnpm verify <dir> [--test]`） |
| `@wsz987/channel-weixin` · `channel-qq` · `channel-dingtalk` · `channel-lark` | 四个内置渠道适配器（见上表） |
| `@wsz987/channel-telegram` | Telegram 扩展性证明 / Roadmap 候选：仅依赖公开 Contract 的第三方适配器范式（未入 bundle，未正式支持） |
| `@wsz987/dsh-channels` | DSH Bundle（`cordis.patch.yml`），聚合内置四渠道 |
| `apps/fake-channel` | E2E 演示应用 |
| `apps/example/minimal-profile` | 示例 DSH profile（bundle 安装 + QQ-only 覆盖） |

## 快速开始

环境要求：**Node.js ≥ 22**、**pnpm 9.15.3**（仓库使用 pnpm workspace + turbo）。

```bash
pnpm install
pnpm build       # turbo 构建所有包（lib/）
pnpm typecheck
pnpm test        # 契约测试 + 各渠道离线测试 + E2E
```

## 在 DSH profile 中使用

本仓库发布的是 **DSH bundle**（不是 dsh CLI）。安装 `@wsz987/dsh-channels` 后，六个插件
（`channels-service`、`channels-harness`、`channels-weixin`、`channels-qq`、
`channels-dingtalk`、`channels-lark`）会通过 `cordis.patch.yml` 自动注入 profile：

```bash
# 1. 创建干净 profile 并安装 bundle
dsh profile create my-profile
dsh plugin --profile my-profile add @wsz987/dsh-channels

# 2. 查看合并后的配置
dsh --profile my-profile --dump-config

# 3. 启动 profile
dsh --profile my-profile
```

- 参考 profile：`apps/example/minimal-profile/`（含 `cordis.patch.yml` 的 QQ-only 覆盖示例）。
- profile patch **整体替换**目标插件的 config（非深合并）。
- 完整发布验证流程见 `docs/release.md`「DSH Bundle Validation」。

## 第三方渠道接入（Channel SDK）

第三方渠道只依赖 `@wsz987/channel-core` 公开 API，无需修改 core / harness / 内置渠道：

```ts
import { defineChannelAdapter } from '@wsz987/channel-core';

export default defineChannelAdapter({
  id: 'my-channel',
  capabilities: { text: true, streaming: 'buffered' /* ... */ },
  async start(ctx) { /* ... */ },
  async stop() { /* ... */ },
  async send(target, message) { /* ... */ },
});
```

- **脚手架**：`templates/channel-adapter/`（package.json / cordis.patch.yml / src / test / fixtures）。
- **验证**：`pnpm verify <dir> [--test]` —— package / adapter surface / manifest / capabilities / fixtures / credentials / contract 七项检查，离线可用。
- **指南**：`docs/adapter-authoring.md`（含 Experimental → Verified 成熟度标准）。
- **范式**：`@wsz987/channel-telegram` 即第三方接入的完整示例——仅依赖公开 Contract，零修改核心代码。

## 兼容性治理

四个内置渠道的 upstream manifest（`packages/channel-*/src/manifest.ts`）与 fixtures 由 `@wsz987/channel-compat` 统一治理：

```bash
pnpm check:fixtures     # fixtures 全量 sweep：解析 + validateFixture + channel/upstreamVersion 校验
pnpm check:manifests    # manifest 同步校验：adapterVersion ↔ package.json、upstream 字段
pnpm doctor             # 四渠道 doctor 表面（diagnose + formatDoctor，CI 直接打印）
pnpm check:upstream     # Renovate 升级闸门：对比上游最新版本与 manifest.testedVersion
pnpm check:bundle       # DSH Bundle 校验：cordis.patch.yml → 插件 shape / exports 子路径 / enabled 配置
```

升级流程：Renovate 检测到上游新版本 → 开 PR → CI（build + typecheck + contract tests +
governance 全绿）→ 人工核验后 bump `manifest.upstream.testedVersion`（必要时收窄 `versionRange`）。
`checkAdapterCompatibility(adapter, { targetVersion, allowUnsupported })` 是治理层单一入口。

## 开发与 CI

```bash
pnpm build && pnpm typecheck && pnpm test   # 本地全量校验
pnpm verify ./packages/channel-telegram --test   # 验证第三方适配器
pnpm changeset            # 记录变更（发布用）
```

GitHub Actions 工作流（`.github/workflows/`）：

| 工作流 | 触发 | 作用 |
| --- | --- | --- |
| `ci.yml` | PR / push main / `v*` tag / manual | 离线全量闸门：build + typecheck + test + governance + verify |
| `upgrade.yml` | 每周一 + manual | 上游漂移检查（`check:upstream`）+ governance |
| `live-weixin.yml` | manual only | 微信 live 平台 E2E；配置 `WEIXIN_LIVE_ENABLED` 前保持 inert |
| `release.yml` | `v*` tag / manual | Changesets 发布到 npm（需配置 `NPM_TOKEN`） |

## 发布

- **版本策略**：Changesets 独立版本（无 fixed / linked 组），`apps/*` 私有不发布。
- **发布流程**：`pnpm changeset` → `pnpm changeset version` → `git tag vX.Y.Z && git push origin vX.Y.Z` → `release.yml` 执行 `changeset publish`。
- **发布产物**：预构建 `lib/` + `exports` 子路径，消费者无需编译 TS；`files` 字段限制 tarball 内容。
- 详见 `docs/release.md`。

## 上游依赖与版本策略

```text
@deepseek-ai/cordis       ^4.0.1
@deepseek-ai/schemastery  ^3.18.1
@deepseek-ai/dsh-agent    ^0.1.0-rc.6
@deepseek-ai/dsh-session  ^0.1.0-rc.6
@deepseek-ai/dsh-llm      ^0.1.0-rc.6
@deepseek-ai/dsh-credentials ^0.1.0-rc.6
```

> ⚠️ **注意**：`@deepseek-ai/dsh-session` / `dsh-brand` / `dsh-llm` / `dsh-credentials` 需固定
> `0.1.0-rc.6` 族（npm `latest` 标签是 `0.0.1-rc.1`，会破坏 rc.6 peer 一致性）；`renovate.json` 通过
> `allowedVersions` 收窄。上游源码仓库：https://github.com/deepseek-ai/deepseek-harness

## 已知限制（Known gaps）

- 框架与离线实现基本完成，但**尚未在真实 Harness runtime 上做过端到端回归**（仅有 pinned-rc.6 契约回归）。
- 四个内置渠道的 **live-platform E2E 需真实凭据**（AppKey / AppSecret / ClientSecret / 微信扫码），尚未执行。
- 微信渠道为 **Text-only**：WX5 媒体路径（图片/语音/文件/视频 CDN）为类型化脚手架，未接入 active 路径。
- **Telegram 等渠道尚未正式支持**：`@wsz987/channel-telegram` 仅为扩展性证明（离线 verify 通过，未入 bundle），见「规划中的渠道」。
- Release Pipeline 已实现，但 GitHub Actions **尚无成功运行记录**（当前仅 `v*` tag 触发，且需配置 `NPM_TOKEN`）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/deepseek-harness-channels-architecture.md](docs/deepseek-harness-channels-architecture.md) | 架构设计（Contract / 红线 / Session 模型） |
| [docs/adapter-authoring.md](docs/adapter-authoring.md) | 第三方渠道接入指南 |
| [docs/release.md](docs/release.md) | 发布流程 / Changesets / Bundle 验证 / Release DoD |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 第三方版权与协议来源声明 |

## 贡献

欢迎 PR 与 Issue！建议流程：

1. Fork 本仓库，从 `main` 开分支；
2. 修改代码并保证 `pnpm build && pnpm typecheck && pnpm test` 全绿；
3. 第三方适配器请附带 `pnpm verify <dir> --test` 通过记录；
4. 运行 `pnpm changeset` 记录变更（发布走 Changesets 独立版本）；
5. 提交 PR，CI（build / typecheck / test / governance）通过后合入。

上游依赖升级请遵循「兼容性治理」流程：升级 PR 需 CI 全绿，并同步 bump 对应渠道 manifest 的
`testedVersion`，不得长期保留 `versionRange: '*'`。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 底层插件运行时（Cordis / Schemastery / dsh-* 家族）。
- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）—— 微信 iLink 协议参考实现。
- [tencent-connect/bot-node-sdk](https://github.com/tencent-connect/bot-node-sdk) —— 腾讯 QQ 官方 Node SDK。
- [open-dingtalk/dingtalk-stream-sdk-nodejs](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs) —— 钉钉官方 stream 模式 SDK。
- [larksuite/node-sdk](https://github.com/larksuite/node-sdk) —— 飞书官方 Node SDK。

本项目为社区实现，与 DeepSeek、腾讯、阿里（钉钉）、字节跳动（飞书）均无隶属关系，非任何官方 SDK / 官方项目。

## License

[MIT](LICENSE) © 2026 [wsz987](https://github.com/wsz987)
