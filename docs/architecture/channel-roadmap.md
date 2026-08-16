---
title: 多渠道规划
summary: 项目目标、渠道状态、第三方扩展方向与 Channel/Tool 边界。
when_to_use: 新渠道 | 扩展方向 | Channel vs Tool | 规划 | 成熟度
authoritative: 项目目标、扩展方向 Tiers、Channel/Tool 边界、成熟度指针。
see_also: [../architecture.md, ../adapter-authoring.md, ../README.md]
status: planning
---

# 多渠道规划

> 项目目标、渠道状态与扩展方向。总览见 [architecture.md](../architecture.md)；
> 统一代码设计见 [common-design.md](common-design.md)；第三方接入见
> [adapter-authoring.md](../adapter-authoring.md)。

## 项目目标

首批支持：

- Weixin / 微信
- QQ Bot
- DingTalk / 钉钉
- Lark / Feishu / 飞书

目标不是复制或重写四个平台全部实现，也不是兼容 OpenClaw Runtime，而是：

> **把官方 SDK、独立上游 package、协议实现隔离在 Upstream Driver 后面，由 Channel Adapter 统一成稳定 Channel Contract，再通过极薄的 Harness Bridge 接入 DeepSeek Harness。**

最终结构：

```text
Messaging Platform
       │
       ▼
Official SDK / Upstream Package / Protocol
       │
       ▼
Upstream Driver
       │
       ▼
Channel Adapter
       │
       ▼
ChannelService (Cordis Service)
       │
       ▼
Harness Bridge
       │
       ▼
DeepSeek Harness Agent / Session
```

## 渠道状态

当前四渠道的能力矩阵（文本 / 图片 / 文件 / 流式 / 状态）见 [README「能力总览」](../README.md)。
规划口径：

- QQ、钉钉、飞书：`tested`（通过 offline contract + fixtures）。
- 微信：`experimental`，在真实平台 live gate 通过前不得标 `tested`（见
  [weixin-live-verification-runbook.md](../weixin-live-verification-runbook.md)）。
- 音频 / 视频当前降级处理；通用文件支持 PDF、DOCX、XLSX 和文本。

## 独立 Adapter 安装（未来能力）

当前内置 adapter package 不携带 `dsh.bundle`，因此不能只执行
`plugin add @wsz987/channel-weixin` 就完成 Harness 配置。正式入口仍是
`@wsz987/dsh-channels`，按需启停通过 profile patch 完成。

未来若支持独立安装，前提是：

```text
adapter package 自己提供 dsh.bundle
```

或者安装一个轻量 bundle：

```text
@wsz987/channel-weixin-bundle
```

是否把“library + bundle”放同一 package，可在实现时按 package DX 决定。

## 第三方扩展方向

### Tier 1 — Messaging / Team Chat

```text
Telegram
Discord
Slack
Microsoft Teams
WhatsApp Business
LINE
Matrix
Mattermost
Rocket.Chat
```

### Tier 2 — 社区 / 社交

```text
Reddit
X DM
Facebook Messenger
Instagram Messaging
Discord Forum
Telegram Channel
```

可通过 extension capability 增加：

```text
post
comment
thread
moderation
reaction
rate-limit
```

### Tier 3 — 客服

```text
Zendesk
Intercom
Freshdesk
Salesforce Service Cloud
企业微信客服
网站客服
```

建议增加可选：

```text
TicketExtension
HumanHandoffExtension
AssignmentExtension
```

不要污染基础 Message Contract。

### Tier 4 — 自有入口

```text
Web Chat
Tauri Desktop
Mobile App
Browser Extension
CLI
```

这些也可以成为 Channel。

最终：

```text
所有用户入口
      ↓
Channel Core
      ↓
Harness
```

### Tier 5 — 通知类

```text
Email
SMS
Push
Webhook
RSS
GitHub Notifications
PagerDuty
```

如果其交互模型明显不是实时 IM，使用：

```text
Delivery Capability
```

而不是硬塞成聊天。

### Tier 6 — Voice / Realtime

```text
SIP
Twilio Voice
WebRTC
电话 Agent
```

未来单独：

```text
RealtimeChannelExtension
```

包括：

```text
audio input stream
audio output stream
interrupt
VAD
barge-in
```

不要在 V1 预先做完整实现。

## Channel 与 Tool 的边界

Channel：

> 用户通过它发送消息并接收 Agent 回复。

Tool / MCP：

> Agent 为完成任务调用的外部能力。

所以：

```text
Telegram   = Channel
Slack Chat = Channel
Web Chat   = Channel

GitHub API = Tool
Calendar   = Tool
Drive      = Tool
Browser    = Tool
Database   = Tool
Shell      = Tool
```

不要把 Channel Core 做成万能 Integration Framework。

## 第三方成熟度

生命周期（`Experimental → Beta → Stable → Verified`）与 Verified 的完整要求、以及
`pnpm verify` 验证门禁，见 [adapter-authoring.md](../adapter-authoring.md)（§9 Maturity
levels、§8 Verification）。
