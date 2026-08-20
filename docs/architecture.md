---
title: 架构总览
summary: 分层、依赖方向、monorepo 结构、架构红线与最终架构。
when_to_use: 架构 | 依赖方向 | 红线 | 分层 | 依赖关系
authoritative: 架构原则、monorepo 结构、依赖方向、架构红线（13 条）。
see_also: [architecture/common-design.md, architecture/channel-roadmap.md, architecture/adr/]
status: as-built
---

# DeepSeek Harness Channels — 架构总览

> 状态：**已实现（as-built）** —— 与当前代码保持一致，随实现持续更新。

这是架构的**总览入口**。具体设计拆分到专题文档，按需跳转：

| 专题 | 文件 | 内容 |
| --- | --- | --- |
| 公共/统一代码设计 | [common-design.md](architecture/common-design.md) | Channel Contract、ChannelService、Harness Bridge、通用控制面、DSH Bundle、已落地补充 |
| 多渠道规划 | [channel-roadmap.md](architecture/channel-roadmap.md) | 项目目标、扩展方向、Channel/Tool 边界、成熟度 |
| 第三方接入指南 | [adapter-authoring.md](adapter-authoring.md) | `defineChannelAdapter`、contract tests、fixtures、manifest、verify |
| 发布流程 | [release.md](release.md) | Changesets 发版、上游更新策略、release gate |
| 微信 live 验证 | [weixin-live-verification-runbook.md](weixin-live-verification-runbook.md) | Weixin live gate 操作手册 |
| 架构决策记录 | [architecture/adr/](architecture/adr/) | ADR 0001（上游边界）、ADR 0002（图片模型降级策略）、ADR 0003（图片兼容实现 seam） |

## 分层

```text
Monorepo
+ Channel Core（稳定 Channel Contract）
+ Harness Bridge（唯一 Harness API 边界）
+ Channel Adapter（平台语义 ↔ Contract）
+ Upstream Driver（SDK / package / 协议隔离）
+ Channel Control / Web / Files（通用控制面 / Web 设置 / 文件扩展）
+ Testkit / Compat / Verify（测试与上游治理）
```

官方依据：

```text
https://deepseek-harness.github.io/deepseek-harness/develop/basic/
https://github.com/deepseek-ai/deepseek-harness
```

---

## 核心架构原则

### 不实现 OpenClaw Runtime 兼容层

明确禁止：

```text
FakeOpenClawRuntime
PluginRuntime
OpenClawPluginApi
registerChannel()
ClawdbotConfig
RuntimeEnv
OpenClaw session router
OpenClaw reply dispatcher
OpenClaw gateway host emulation
```

上游 OpenClaw 渠道仓库只允许作为：

- 上游实现参考
- SDK / API 使用参考
- 协议行为参考
- Bugfix / reconnect / media / card 行为参考
- compatibility reference

运行时不依赖 OpenClaw。

### Harness Agent / Session API 只允许存在于 `channel-harness`

DeepSeek Harness 当前处于 developer preview，公开声明可能存在 breaking changes。

因此：

```text
channel-core        ❌ 不 import Harness Agent API
channel-testkit     ❌ 不依赖 Harness 私有内部实现
channel-weixin      ❌ 不访问 ctx.agents
channel-qq          ❌ 不访问 ctx.agents
channel-dingtalk    ❌ 不访问 ctx.agents
channel-lark        ❌ 不访问 ctx.agents

channel-harness     ✅ 唯一允许直接依赖 dsh-agent / dsh-session
channel-files       ✅ 可选扩展，仅依赖公开 Cordis / Tool API
```

目标：

```text
Harness breaking change
       ↓
优先只修改 channel-harness
```

而不引发其他渠道同时跟着重构。

### 产品一体化，代码模块化

最终用户：

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest
```

一次安装首批官方渠道。

内部仍拆分：

```text
@wsz987/channel-core
@wsz987/channel-harness
@wsz987/channel-control     # 通用控制面
@wsz987/channel-files       # 可选通用文件扩展
@wsz987/channel-web         # Web 设置面板
@wsz987/channel-testkit
@wsz987/channel-compat
@wsz987/channel-verify

@wsz987/channel-weixin
@wsz987/channel-qq
@wsz987/channel-dingtalk
@wsz987/channel-lark
@wsz987/channel-telegram    # 内置渠道适配器（Bot API 长轮询 + edit streaming + getFile 下载）

@wsz987/dsh-channels
```

其中：

```text
@wsz987/dsh-channels = DSH Bundle
```

不是业务实现集合。

---

## Monorepo 结构

```text
deepseek-harness-channels/
│
├─ apps/
│  ├─ example/
│  │  └─ minimal-profile/
│  └─ fake-channel/
│
├─ packages/
│  ├─ channel-core/        # Channel Contract + ChannelService（ctx.channels）
│  ├─ channel-harness/     # 渠道 ↔ Harness 桥（唯一允许 import Harness API）
│  ├─ channel-control/     # 控制面：配置 / 凭据 / Auth Session / 运行时挂载
│  ├─ channel-files/       # 可选通用文件扩展（存储 / 解析 / read_channel_attachment）
│  ├─ channel-web/         # Web「设置 → 渠道」面板 + HTTP API（/api/v1 + /api/v2）
│  ├─ channel-weixin/      # 微信适配器（source-port，官方 iLink 协议）
│  ├─ channel-qq/          # QQ 适配器（official-sdk）
│  ├─ channel-dingtalk/    # 钉钉适配器（dingtalk-stream + 官方 OpenAPI port）
│  ├─ channel-lark/        # 飞书适配器（official-sdk + 官方 OpenAPI）
│  ├─ channel-telegram/    # 内置渠道适配器（Bot API 长轮询 + edit streaming + getFile 下载）
│  ├─ channel-testkit/     # 契约测试 / fakes / fixture loader
│  ├─ channel-compat/      # 上游版本治理 / doctor / manifest
│  ├─ channel-verify/      # 适配器契约验证（pnpm verify）
│  └─ channels/            # 对外 DSH bundle @wsz987/dsh-channels
│
├─ fixtures/
│  ├─ weixin/              # 微信 iLink inbound/outbound/QR fixtures
│  ├─ qq/
│  ├─ dingtalk/
│  ├─ lark/
│  ├─ telegram/            # 内置渠道 fixtures
│  └─ upstream/            # 各渠道上游版本基线（SDK 渠道；Telegram 协议直连，基线在 channel-telegram/src/manifest.ts）
│
├─ pnpm-workspace.yaml
├─ package.json
├─ tsconfig.base.json
├─ turbo.json
├─ vitest.workspace.ts
└─ .changeset/
```

---

## Harness-Native 依赖关系

```text
                        DeepSeek Harness
                              │
                          Cordis Runtime
                              │
              ┌───────────────┴───────────────┐
              │                               │
          ctx.agents                    ctx.channels
              │                               │
              │                        ChannelService
              │                               │
              │                      Adapter Registry
              │                   ┌──────┼──────┬──────┬──────┐
              │                   │      │      │      │      │
              │                   ▼      ▼      ▼      ▼      ▼
              │                 WX      QQ     DD     Lark    TG
              │                   │      │      │      │      │
              │                   ▼      ▼      ▼      ▼      ▼
              │                Driver  Driver  Driver  Driver  Driver
              │
              └──────────── channel-harness ────────────┘
```

严格依赖方向：

```text
channel-adapter implementation -> channel-core
channel-adapter implementation -> upstream driver
upstream driver -> SDK/package/protocol

adapter plugin composition -> channel-core + channel-control

channel-harness -> channel-core
channel-harness -> Harness public APIs

channels bundle -> plugin configuration only
```

这里的 `adapter plugin composition` 仅指包入口的 `apply()` 与
`ChannelDefinition` 注册，用于把凭据、设置和 runtime mount 接入通用控制面。
纯 Adapter / mapper / upstream 不得反向依赖 `channel-control`，也不得访问 Harness
Agent / Session API。

---

## 架构红线

出现以下代码即视为架构退化。

### 红线 1

Core：

```ts
if (channel === 'weixin')
```

### 红线 2

Adapter：

```ts
ctx.agents.get(...)
```

### 红线 3

Harness Bridge：

```ts
import 'dingtalk-stream';
```

### 红线 4

Root Bundle 直接实现或直接调用任何平台 SDK：

```ts
// channels bundle 的 src 里
import '@larksuiteoapi/node-sdk'
```

平台 SDK 的依赖和使用必须被隔离在对应 `channel-*` 子包。Root Bundle 可以通过依赖这些子包完成一次性产品安装（`@wsz987/dsh-channels -> channel-lark -> Lark SDK`），但不得自己直接接触平台 SDK。

### 红线 5

上游自动追 `latest` 并直接运行。

### 红线 6

平台 raw payload 直接塞给模型。

### 红线 7

一个账号只有一个 Harness Session。

### 红线 8

`ctx.agents.create()` 后丢弃 `AgentHandle`。

### 红线 9

`channel-web` 直接调用 Harness Agent API（Agent/Session 只允许走 `channel-harness`）。

### 红线 10

浏览器业务层直接接触平台 Secret / deviceCode / token（Web 只允许消费 PublicAuthSession 等净化 DTO）。

### 红线 11

直接依赖 Harness private/internal source，而不是 public package API。

### 红线 12

适配器直接读写 Harness persistence（SessionBinding 等持久化只允许由 `channel-harness` 的 store 接口负责）。

### 红线 13

外部主体未授权就产生本地副作用。

任一能够触发 Agent、Command、Session、Binding、Workspace、Interaction 或其他本地特权行为的外部入站事件，必须首先通过 `channel-harness` 的统一 Access Gate。缺失 policy、损坏 policy、未知 sender、未知 group 均 Fail-Closed。Adapter 只负责 canonical identity 与 activation facts，不得实现渠道私有 ACL engine。`requireMention` 是 Activation，不是 Authorization。

见 `docs/security/inbound-access-control.md` 与 `docs/security/channel-identity-map.md`。

---

## 最终架构

```text
                         DeepSeek Harness
                               │
                           Cordis Runtime
                               │
             ┌─────────────────┴─────────────────┐
             │                                   │
         Agent Service                      ChannelService
             │                                   │
             │                            Adapter Registry
             │                                   │
             │                        ChannelControlService
             │                        （channel-control）
             │                        │ 配置 / Credential
             │                        │ Auth Session / Runtime
             │                        │
             │                        ▼
             │                  ChannelDefinitions
             │                  WX / QQ / DingTalk / Lark / Telegram
             │                        │
             │                        ▼
             │                          ┌────┬────┬────┬────┐
             │                          │    │    │    │    │
             │                         WX   QQ   DD   Lark   TG   ...
             │                          │    │    │    │
             │                         Driver / SDK / Upstream
             │
             └────────────── channel-harness ────────────────┐
                                      │                      │
                              SessionBinding / AgentManager  │
                                      │                      │
                            followup / steer / inject        │
                                                             │
                               session/event ────────────────┘
                                      │
                                  ReplyRouter
                                      │
                                  ReplyHandle
                                      │
                                      ▼
                                  IM Platform
```

---

## 最终决策

正式采用：

> **Harness-native Cordis Service + DSH Bundle + Monorepo + Stable Channel Contract + Thin Harness Bridge + Independent Adapter + Upstream Driver + First-class Testkit + Compatibility Governance**

各层职责：

```text
Channel Core
= 稳定跨渠道 Contract + Cordis ChannelService

Harness Bridge
= Harness public API 的薄适配层

Adapter
= 平台语义 <-> Channel Contract

Upstream Driver
= SDK/package/API 版本隔离

Testkit
= Adapter 与 Harness 双向兼容保护

Compat
= 上游版本治理

DSH Bundle
= 用户安装与组合体验
```

最重要的目标不是完成某几个渠道。

而是：

> **第五个、第十个、第三十个渠道加入时，不修改 Channel Core；Harness breaking change 发生时，优先只修改 channel-harness。**
