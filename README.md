# DeepSeek Harness Channels (dsh-channels)

Harness-native Channel SDK for [DeepSeek Harness](https://www.deepseek.com/harness/).

## 状态：M0 — Harness-native Framework ✅

按《deepseek-harness-channels-execution-plan.md》M0 里程碑完成：

```text
Monorepo
Channel Core
Cordis ChannelService
Testkit
Harness Bridge（AgentManager / SessionBinding / ReplyRouter）
DSH Bundle 骨架
Fake E2E  ✅ Fake Channel → Harness Agent → session/event → Fake Channel
```

## 结构

| 包 | 职责 |
| --- | --- |
| `@dsh/channel-core` | 稳定跨渠道 Contract + `ChannelService`（`ctx.channels`，Cordis Service） |
| `@dsh/channel-harness` | **唯一** Harness API boundary：SessionBinding、AgentManager（AgentHandle ownership）、`session/event` → ReplyRouter |
| `@dsh/channel-testkit` | `runChannelAdapterContract`、FakeAdapter/FakeUpstream/FakeHarness、fixture loader、E2E |
| `@dsh/channel-compat` | 上游兼容性治理（Phase 13+ 实现） |
| `@dsh/channel-weixin/qq/dingtalk/lark` | 四个官方渠道 adapter 骨架（M1+ 实现） |
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

## 后续 Milestones

- M1 Weixin Adapter（Auth/Receive/Reply/持久会话/重启恢复）
- M2 DingTalk Adapter（AI Card 流式）
- M3 四官方渠道统一（health/doctor/routing/auth）
- M4 兼容性治理（manifest/Renovate/Harness compat CI）
- M5 公开 SDK（defineChannelAdapter/testkit/template/verify/Telegram proof）

详见 `docs/deepseek-harness-channels-architecture.md` 与 `docs/deepseek-harness-channels-execution-plan.md`。
