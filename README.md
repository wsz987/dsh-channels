# DeepSeek Harness Channels (dsh-channels)

Harness-native Channel SDK for [DeepSeek Harness](https://www.deepseek.com/harness/).

## 状态

**M0 — Harness-native Framework ✅**（已提交 `fd0ac46`）

```text
Monorepo
Channel Core
Cordis ChannelService
Testkit
Harness Bridge（AgentManager / SessionBinding / ReplyRouter）
DSH Bundle 骨架
Fake E2E  ✅ Fake Channel → Harness Agent → session/event → Fake Channel
```

**M1 — Weixin Adapter ✅**

```text
Config (Schemastery)
Upstream Driver（HTTP long-poll / auth / send，fetch transport 可注入）
Auth 状态机 + 持久化
Mapper（text/image/audio/video/file/location/unknown → MessagePart[]）
Inbound dedup + Outbound send
Reconnect 指数退避
Contract Tests 通过（runChannelAdapterContract）
fixtures/weixin/（text/image/audio/unknown/duplicate/auth-success/auth-expired）
```

> 网络交互通过可注入的 `HttpTransport` 抽象——真实部署指向自托管微信 HTTP 网关，测试用 fake transport 全离线验证。

**M2 — DingTalk Adapter ✅**

```text
DingTalk Driver / Adapter
AI Card 流式（chunk updates / throttle，ReplyRouter 泛型化）
Reconnect 指数退避 + Inbound dedup
配置（Schemastery）+ 上游兼容性 manifest
fixtures/dingtalk/
```

**M3 — 四官方渠道统一 ✅**

```text
QQ（buffered 流式 + dm/group + QR auth）与 Lark（threads → SessionBinding、可编辑卡片）
统一 health / doctor / routing / auth
channels doctor（Task 13.2，上游兼容性诊断）
fixtures/qq/ + fixtures/lark/
```

**M4 — 兼容性治理 ✅**（当前，本变更）

```text
checkAdapterCompatibility 聚合检查（Task 13.1–13.3）
manifest 同步校验：adapterVersion ↔ package.json、upstream 字段（check:manifests）
fixtures 全量 sweep（check:fixtures）
四渠道 doctor 表面（pnpm doctor）
Renovate + CI 升级闸门（check:upstream）
```

## 结构

| 包 | 职责 |
| --- | --- |
| `@dsh/channel-core` | 稳定跨渠道 Contract + `ChannelService`（`ctx.channels`，Cordis Service） |
| `@dsh/channel-harness` | **唯一** Harness API boundary：SessionBinding、AgentManager（AgentHandle ownership）、`session/event` → ReplyRouter |
| `@dsh/channel-testkit` | `runChannelAdapterContract`、FakeAdapter/FakeUpstream/FakeHarness、fixture loader、E2E |
| `@dsh/channel-compat` | 上游兼容性治理（manifest 同步校验 / fixture sweep / doctor / checkAdapterCompatibility） |
| `@dsh/channel-weixin/qq/dingtalk/lark` | 四个官方渠道 adapter（M1–M3 实现，M4 纳入治理） |
| `@dsh/channels` | DSH Bundle（`cordis.patch.yml`） |
| `apps/fake-channel` | M0 E2E 演示 |

## 快速开始

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## 架构红线（已实现部分）

- `channel-core` 不依赖任何具体平台、不 import Harness Agent API
- `channel-harness` 不 import 任何平台 SDK（dingtalk-stream 等）
- `ctx.agents.create/resume` 返回的 `AgentHandle` 由 `AgentManager` 持有，卸载时 dispose（红线 8）
- Session 按 `channel:account:conversation[:thread]` 隔离（红线 7）
- 回复只消费官方 `session/event`（assistant/chunk、assistant/message、turn/end）
- 网络/长生命周期资源统一走 `ctx.effect()`
- 配置使用 Schemastery，部署参数全部可配置

## 上游版本快照（M0 已核验）

```text
@deepseek-ai/cordis       ^4.0.1
@deepseek-ai/schemastery  ^3.18.1
@deepseek-ai/dsh-agent    ^0.1.0-rc.6
@deepseek-ai/dsh-session  ^0.1.0-rc.6
@deepseek-ai/dsh-llm      ^0.1.0-rc.6
```

> 注意：`@deepseek-ai/dsh-session` / `dsh-brand` / `dsh-llm` 等需固定 `0.1.0-rc.6`（npm `latest` 标签是 `0.0.1-rc.1`，会破坏 rc.6 族 peer 一致性）。

## M4 兼容性治理

四个官方渠道的 upstream manifest（`packages/channel-*/src/manifest.ts`）与 fixtures 由 `channel-compat` 统一治理，四个入口：

```bash
pnpm check:fixtures     # fixtures 全量 sweep：解析 + validateFixture + channel/upstreamVersion 校验
pnpm check:manifests    # manifest 同步校验：validateManifest / status=tested / adapterVersion ↔ package.json
pnpm doctor             # 四渠道 doctor 表面（diagnose + formatDoctor，CI 直接打印）
pnpm check:upstream     # Renovate 升级闸门：对比上游最新版本与 manifest.testedVersion / versionRange
```

> 以上根命令委托给 `@dsh/channel-compat` 的对应脚本；依赖升级 PR 的 CI 会执行全部四道检查。

升级流程（Renovate PR → CI 闸门 → bump testedVersion）：

```text
Renovate 检测到上游新版本并开 PR
   ↓
CI：build + typecheck + contract tests + check:fixtures + check:manifests + doctor 全绿
   ↓
人工核验通过后 bump 对应渠道 manifest.upstream.testedVersion（必要时收窄 versionRange）
```

`checkAdapterCompatibility(adapter, { targetVersion, allowUnsupported })` 是治理层的单一入口：读取结构性 manifest → `validateManifest` → `versionState`/`manifestVerdict`，返回 `{ manifest, validationErrors, state, verdict, reason }`。

## 后续 Milestones

- M5 公开 SDK（defineChannelAdapter/testkit/template/verify/Telegram proof）

详见 `docs/deepseek-harness-channels-architecture.md` 与 `docs/deepseek-harness-channels-execution-plan.md`。
