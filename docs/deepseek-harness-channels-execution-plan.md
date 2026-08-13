# DeepSeek Harness Channels — 最终执行计划

> 版本：v1.1 Harness-Native  
> 日期：2026-08-13  
> 状态：**最终执行版 / 可直接拆 Task 开发**

---

# 0. 执行目标

构建 DeepSeek Harness 原生 Channel Framework，并首批完成：

1. Weixin
2. DingTalk
3. QQ
4. Lark / Feishu

最终用户能够：

```bash
dsh plugin --profile default add @dsh/channels
```

并通过 DeepSeek Harness profile 启用渠道。

核心要求：

- 不依赖 OpenClaw Runtime
- Channel Core 不依赖任何具体平台
- Adapter 不依赖 Harness Agent API
- Harness Bridge 极薄
- Cordis Service 原生集成
- 网络生命周期使用 `ctx.effect()`
- Harness Session 隔离
- 正确处理 AgentHandle ownership
- 回复从 `session/event` 驱动
- Schemastery 配置
- 上游持续升级
- `channel-testkit` 从第一阶段建立
- 支持未来第三方 Adapter

---

# 1. 技术栈

```text
Node.js >= 22
TypeScript
pnpm workspace
Turbo
Vitest
Changesets
Schemastery
Cordis
Renovate / Dependabot
```

Harness 侧只在 `channel-harness` 中依赖官方公开 package API，例如：

```text
@deepseek-ai/cordis
@deepseek-ai/dsh-agent
@deepseek-ai/dsh-session
```

具体依赖名称和版本在实施时以当前 Harness package exports 为准。

禁止依赖 Harness 私有源码路径。

---

# 2. Phase 0 — Monorepo Bootstrap

## Task 0.1 Workspace

建立：

```text
apps/
packages/
fixtures/
```

配置：

```text
pnpm-workspace.yaml
tsconfig.base.json
turbo.json
vitest.workspace.ts
.changeset/
```

根依赖只放：

```text
workspace tooling
typescript
vitest
turbo
changesets
```

禁止把：

```text
dingtalk-stream
lark sdk
qq sdk
weixin implementation
```

装到 root。

---

## Task 0.2 Package Skeleton

创建：

```text
channel-core
channel-harness
channel-testkit
channel-compat

channel-weixin
channel-qq
channel-dingtalk
channel-lark

channels
```

验收：

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

全部成功。

---

# 3. Phase 1 — Channel Core

> 必须先于任何真实渠道。

---

## Task 1.1 基础 Identity Types

实现：

```text
ChannelId
AccountId
ConversationId
ThreadId
MessageId
SenderId
```

建议 branded type 或 readonly wrapper，减少不同 ID 混用。

---

## Task 1.2 MessagePart

实现：

```text
TextPart
ImagePart
FilePart
AudioPart
VideoPart
LocationPart
CardPart
UnsupportedPart
```

验收：

四个渠道未来都能映射为：

```ts
MessagePart[]
```

---

## Task 1.3 ChannelEvent

稳定定义：

```text
message.received
reaction.received
interaction.received
member.joined
member.left
conversation.updated
auth.changed
connection.changed
```

首批真正实现：

```text
message.received
auth.changed
connection.changed
```

---

## Task 1.4 Capabilities

实现：

```text
text
image
file
audio
video
markdown
cards
reactions
threads
streaming
maxTextLength
maxFileSize
```

`streaming`：

```text
native
edit
buffered
```

---

## Task 1.5 ReplyHandle

定义：

```text
append
replace
finish
fail
```

此时不写任何 DingTalk/Lark 判断。

---

## Task 1.6 ChannelAdapter

稳定接口：

```text
start
stop
send
createReply?
beginAuth?
pollAuth?
getHealth?
```

特殊平台能力不得继续往主接口随意加方法。

未来使用 optional extension capability。

---

# 4. Phase 2 — Cordis `ChannelService`

> v1.1 新增 Harness-native 要求。

---

## Task 2.1 Service

`ChannelService` 继承：

```ts
Service
```

并挂载：

```ts
ctx.channels
```

通过 TypeScript module augmentation 提供类型。

---

## Task 2.2 Registry

实现：

```text
register(adapter)
unregister(adapter)
get(id)
list()
```

要求：

- duplicate id loudly fail
- registration returns disposer
- adapter registration 与 Cordis effect 对齐
- 单 Adapter 错误可诊断

---

## Task 2.3 Optional Events

先只在 ChannelService 内部提供 typed subscription。

如果确实需要跨插件观察，再增加最小 Cordis surface：

```text
channels/event
channels/status
```

不要一开始设计几十个全局事件。

---

# 5. Phase 3 — `channel-testkit`

> **必须在第一个真实 Adapter 前完成。**

---

## Task 3.1 FakeChannelAdapter

支持：

```ts
fake.receive(...)
fake.sentMessages
fake.authState
fake.connectionState
```

---

## Task 3.2 FakeUpstream

用于验证：

```text
Adapter
  ↓
Upstream Driver
```

无需真实网络。

---

## Task 3.3 Contract Tests

提供：

```ts
runChannelAdapterContract(...)
```

验证：

- register
- start
- stop
- repeated stop
- AbortSignal
- send
- event emit
- cleanup
- error mapping
- capabilities
- health
- dedup behavior

---

## Task 3.4 Fixture Loader

规范：

```text
fixtures/<channel>/<case>.json
```

结构：

```json
{
  "name": "...",
  "upstreamVersion": "...",
  "payload": {},
  "expected": {}
}
```

---

## Task 3.5 Fake Harness Boundary

不要复制 Harness Runtime。

只模拟我们自己定义的最小 bridge port：

```text
resolveAgent
followup
stream session events
```

这样 testkit 不会反向依赖 Harness 内部。

---

# 6. Phase 4 — `channel-harness`

> 唯一 Harness public API boundary。

---

## Task 4.1 Harness Plugin

实现普通 Cordis 插件：

```ts
export const name = 'channel-harness';
export const inject = [
  'channels',
  'agents',
];
```

如果 resume 必须依赖 persistence service，则按当前 Harness public contract 增加 required / optional dependency。

---

## Task 4.2 Config

使用 Schemastery：

```text
defaultAgent
routing
session binding storage
reply throttle
max concurrency
```

所有部署相关参数必须配置化。

---

## Task 4.3 SessionBinding Key

输入：

```text
channelId
accountId
conversationId
threadId
```

输出：

```text
SessionBinding
```

key：

```text
channel:account:conversation[:thread]
```

---

## Task 4.4 Binding Store

接口：

```ts
get(key)
put(binding)
delete(key)
```

第一版可以提供一个官方默认持久实现。

具体选：

```text
Harness persistence extension
或独立 SQLite
```

以实施时 public API 适配性为准。

禁止 Adapter 自己操作该存储。

---

## Task 4.5 Agent Router

V1：

```text
global default
channel
account
conversation
```

优先级：

```text
conversation
> account
> channel
> global
```

V2 再加 classifier routing。

---

# 7. Phase 5 — `AgentManager`

> v1.1 的关键执行项。

---

## Task 5.1 Resolve Live Agent

先：

```ts
ctx.agents.get(sessionId)
```

如果 live：

```text
直接使用
```

---

## Task 5.2 Resume Persisted Agent

如果 Session 已存在但不 live：

```ts
ctx.agents.resume({
  resumeSessionId: sessionId,
})
```

返回：

```text
AgentHandle
```

---

## Task 5.3 Create New Agent

新会话：

```ts
ctx.agents.create({
  sessionId,
  ...
})
```

返回：

```text
AgentHandle
```

---

## Task 5.4 Handle Ownership

`channel-harness` 必须持有自己 create/resume 的 Handle：

```ts
Map<SessionId, AgentHandle>
```

Cordis 插件 dispose 时：

```text
停止新入站
等待必要 drain
dispose owned AgentHandles
清理 map
```

不要 dispose `ctx.agents.get()` 返回但并非自己拥有的 Agent。

---

## Task 5.5 Concurrency

防止相同 Session 同时：

```text
resume + resume
create + create
resume + create
```

需要 per-session single-flight：

```text
Map<SessionId, Promise<Agent>>
```

或 keyed mutex。

---

# 8. Phase 6 — Inbound -> Agent

---

## Task 6.1 Convert Message

```text
MessageReceived
  ↓
toHarnessUserMessage()
```

保留：

```text
channel source
sender id
message id
conversation metadata
structured content
```

不把平台 raw JSON 原样塞进 prompt。

---

## Task 6.2 Followup

普通渠道消息：

```ts
agent.followup(userMessage);
```

---

## Task 6.3 Steering Policy

第一版默认：

```text
每条用户消息 = followup
```

不要自动把“Agent 正在运行时的新消息”全部变成 `steer()`。

后续如果 UX 明确定义：

```text
interrupt / modify-current-task
```

才增加显式 steering mode。

---

## Task 6.4 Inject

只给：

```text
silent context
platform context
group policy
tenant context
```

不唤醒 Agent。

---

# 9. Phase 7 — `session/event` Reply Pipeline

---

## Task 7.1 监听官方 Session Event

使用：

```ts
ctx.on('session/event', ...)
```

检查：

```text
assistant/chunk
assistant/message
turn/end
```

第一版回复只依赖这些事件。

---

## Task 7.2 Route by Session

必须通过：

```text
sessionId
   ↓
SessionBinding
   ↓
channel/account/conversation/thread
```

找到 Reply target。

---

## Task 7.3 ReplyHandle Strategy

```text
native
edit
buffered
```

---

## Task 7.4 Coalesce / Throttle

默认配置化：

```text
replyUpdateIntervalMs
```

建议初始值：

```text
150~250ms
```

但必须来自 Config，不硬编码为无法修改的常量。

---

## Task 7.5 Message Split

处理：

```text
maxTextLength
```

支持：

```text
paragraph-aware split
code-block-aware split
final flush
```

---

# 10. Phase 8 — DSH Bundle

> 不再把 `channels` 当纯 npm meta package。

---

## Task 8.1 `package.json`

声明：

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

---

## Task 8.2 `cordis.patch.yml`

默认插入：

```text
ChannelService
Harness Bridge
Weixin Adapter
QQ Adapter
DingTalk Adapter
Lark Adapter
```

所有渠道可通过 config 关闭。

---

## Task 8.3 安装验证

验证：

```bash
dsh plugin --profile test add ./packages/channels
dsh --profile test --dump-config
dsh --profile test
```

---

## Task 8.4 npm / GitHub 安装

优先正式发布预构建 npm package。

GitHub source install 仅作为开发/测试路径，并遵循 Harness 的 `prepare` / pnpm allowBuilds 安全要求。

---

# 11. Phase 9 — Weixin Adapter

推荐作为第一个真实 Adapter。

---

## Task 9.1 Config

Schemastery：

```text
enabled
accountId
auth state path
baseUrl
timeoutMs
longPollTimeoutMs
reconnect
```

---

## Task 9.2 Upstream Driver

实现：

```text
login QR
poll auth
receive / long poll
send text
media basic
```

HTTP endpoint 只存在 Driver。

---

## Task 9.3 Adapter

```text
raw payload
  ↓
mapper
  ↓
ChannelEvent
```

以及：

```text
OutboundMessage
  ↓
upstream driver
```

---

## Task 9.4 Fixtures

至少：

```text
text
image
audio
unknown
duplicate
auth success
auth expired
```

---

## Task 9.5 E2E

真实：

```text
Weixin
  ↓
Harness
  ↓
Weixin reply
```

同时保留 Fake E2E。

---

# 12. Phase 10 — DingTalk Adapter

第二个真实渠道，用于验证 streaming abstraction。

---

## Task 10.1 Driver

优先：

```text
dingtalk-stream
```

隔离：

```text
auth
connection
heartbeat
reconnect
send
card
```

---

## Task 10.2 Adapter

实现：

```text
message receive
dedup
connection state
send text
basic media
AI Card
```

---

## Task 10.3 ReplyHandle

重点：

```text
assistant/chunk
   ↓
AI Card update
```

验证：

```text
edit/native-like streaming
throttle
finalize
failure state
```

---

# 13. Phase 11 — QQ Adapter

---

## Task 11.1 Driver Strategy

优先顺序：

```text
independent package API
→ official SDK
→ isolated source
```

不要加载要求 OpenClaw host 的 root plugin entry。

---

## Task 11.2 Gateway

实现：

```text
connection
reconnect
dedup
direct/group messages
health
```

---

## Task 11.3 Outbound

```text
text
image/basic media
```

---

## Task 11.4 Auth

把 QQ 平台认证流程映射成：

```text
AuthChallenge
AuthState
```

不要把终端二维码渲染写死在 Adapter。

---

# 14. Phase 12 — Lark / Feishu Adapter

---

## Task 12.1 Driver

基于官方 Lark SDK：

```text
WebSocket
event dispatcher
send
media
card
edit
```

---

## Task 12.2 Threads

重点验证：

```text
conversationId + threadId
```

正确映射 Harness Session。

---

## Task 12.3 Rich Reply

实现：

```text
card
edit
interactive callback
```

首版交互 callback 可以先只映射为 `InteractionReceived`。

---

# 15. Phase 13 — Compatibility Layer

---

## Task 13.1 Manifest

每个 Adapter 声明：

```text
adapterVersion
upstream reference
testedVersion
versionRange
strategy
sdk package
sdk testedVersion
```

---

## Task 13.2 `channels doctor`

提供插件服务或 CLI surface，输出：

```text
adapter
upstream/sdk
compatibility
connection
auth
health
Harness version
```

示例：

```text
DingTalk
Adapter: 0.7.0
SDK: dingtalk-stream 2.1.4
Compatibility: tested
Connection: online
```

---

## Task 13.3 Version States

```text
tested
compatible
untested
unsupported
```

默认：

```text
untested -> warning
unsupported -> fail unless override
```

---

# 16. Phase 14 — Harness Compatibility Tests

> v1.1 新增正式 milestone。

---

## Task 14.1 Agent API Contract

验证当前 Harness：

```text
ctx.agents.get
ctx.agents.create
ctx.agents.resume
AgentHandle
followup
steer
inject
whenIdle
```

Bridge 只针对 public API。

---

## Task 14.2 Session Event Contract

验证：

```text
assistant/chunk
assistant/message
turn/end
```

仍可从：

```text
session/event
```

消费。

---

## Task 14.3 CI Matrix

初期：

```text
Harness pinned-current
Harness latest-compatible
```

breaking 发生时：

```text
只修改 channel-harness + compat tests
```

若 Core/Adapter 也必须变化，要说明原因并视为架构警报。

---

# 17. Phase 15 — Upstream Update Automation

Renovate / Dependabot：

```text
new dependency
   ↓
PR
   ↓
build
typecheck
contract tests
fixtures
adapter tests
Harness compat
E2E
```

全部通过后：

```text
更新 manifest.testedVersion
```

---

# 18. Phase 16 — Release Pipeline

---

## Task 16.1 Changesets

独立版本：

```text
core
harness
testkit
compat
weixin
qq
dingtalk
lark
channels
```

---

## Task 16.2 Build

每个发布 package：

```text
prebuilt JS
types
package exports
```

避免要求普通用户安装时编译 TypeScript。

---

## Task 16.3 DSH Bundle Validation

发布前：

```text
install clean profile
dump config
start
load all plugins
disable individual channels
```

---

# 19. Phase 17 — Third-party SDK

首批四渠道稳定后再正式对外。

---

## Task 17.1 `defineChannelAdapter`

提供 helper：

```ts
defineChannelAdapter(...)
```

---

## Task 17.2 Adapter Template

```text
templates/channel-adapter/
├ package.json
├ cordis.patch.yml
├ src/
│  ├ index.ts
│  ├ config.ts
│  ├ adapter.ts
│  └ upstream.ts
├ test/
│  └ adapter.test.ts
└ fixtures/
```

---

## Task 17.3 `verify`

未来：

```bash
dsh channels verify ./my-adapter
```

验证：

```text
manifest
contract
lifecycle
capabilities
fixtures
credentials
package exports
bundle manifest
```

---

# 20. Phase 18 — Telegram Proof of Extensibility

这是架构验收，不只是多一个渠道。

目标：

```text
实现 Telegram Adapter
```

要求：

```text
不修改 channel-core
不修改 channel-harness
不修改已有四个 Adapter
```

如果做不到，说明 Channel Contract 仍有平台泄漏。

---

# 21. 第三方扩展优先级

## Wave 1

```text
Telegram
Discord
Slack
Teams
```

用于验证：

```text
DM
group
thread
streaming/edit
reaction
```

---

## Wave 2

```text
WhatsApp Business
LINE
Matrix
Mattermost
Rocket.Chat
```

---

## Wave 3

自有入口：

```text
Web Chat
Tauri
Browser Extension
Mobile
CLI
```

---

## Wave 4

客服：

```text
Intercom
Zendesk
Freshdesk
企业微信客服
```

增加可选 extension：

```text
ticket
handoff
assignment
status
```

---

## Wave 5

Realtime：

```text
SIP
Twilio
WebRTC
```

单独：

```text
RealtimeChannelExtension
```

---

# 22. Testkit 范围控制

V1 只允许：

```text
Contract Tests
Fake Adapter
Fake Upstream
Fixture Loader
Fake Harness Port
Harness E2E
Harness Compatibility
```

暂不做：

```text
大型 mock platform
真实账号 farm
流量录制平台
UI automation framework
跨平台压力测试平台
```

---

# 23. Security Baseline

每个 Adapter：

- credential 不写日志
- secret 不进入 fixture
- raw payload fixture 必须匿名化
- 二维码 auth token 不长期缓存
- third-party package install 不自动信任构建脚本
- Git source 安装建议 pin commit
- rate limit / reconnect 有 backoff
- untrusted card/input 不直接变成系统 prompt

---

# 24. Observability

统一：

```text
channel
accountId
conversationId
sessionId
messageId
adapterVersion
upstreamVersion
latency
retryCount
connectionState
```

但日志中：

```text
禁止 credential
禁止完整 private message 默认落盘
```

可配置 debug raw event，默认关闭。

---

# 25. Definition of Done

## Framework

- [ ] ChannelService 是 Cordis Service
- [ ] Core 不依赖具体平台
- [ ] Adapter 不依赖 Harness Agent API
- [ ] Harness Bridge 不依赖具体渠道 SDK
- [ ] `@dsh/channels` 是 DSH Bundle
- [ ] Config 使用 Schemastery
- [ ] 网络生命周期使用 `ctx.effect()`
- [ ] Session Binding 持久化
- [ ] AgentHandle ownership 正确
- [ ] 回复来自 `session/event`
- [ ] capability negotiation
- [ ] doctor
- [ ] compatibility tests

## 每个 Adapter

- [ ] config schema
- [ ] auth
- [ ] receive text
- [ ] send text
- [ ] basic media
- [ ] reconnect
- [ ] health
- [ ] dedup
- [ ] fixtures
- [ ] contract tests
- [ ] compatibility manifest
- [ ] no plaintext credentials

## Release

- [ ] independent versions
- [ ] Changesets
- [ ] dependency update PR
- [ ] clean-profile DSH install
- [ ] all-in-one bundle
- [ ] example profile
- [ ] architecture docs
- [ ] adapter authoring docs

---

# 26. 架构红线

## 红线 1

```ts
channel-core:
if (channel === 'weixin')
```

## 红线 2

```ts
channel-weixin:
ctx.agents.get(...)
```

## 红线 3

```ts
channel-harness:
import 'dingtalk-stream'
```

## 红线 4

根 package 持有四个渠道 SDK。

## 红线 5

上游依赖直接 `latest`。

## 红线 6

raw platform JSON 直接进入模型输入。

## 红线 7

一个账号共用一个 Harness Session。

## 红线 8

create/resume 后丢弃 AgentHandle。

## 红线 9

依赖 Harness repository private file path。

## 红线 10

Cordis 可清理资源却自行做另一套全局生命周期管理器。

---

# 27. 推荐真实 Task 顺序

```text
Task 01  bootstrap monorepo
Task 02  channel-core identity/message/event/capability
Task 03  ReplyHandle + ChannelAdapter
Task 04  Cordis ChannelService
Task 05  channel-testkit minimum
Task 06  Fake Channel end-to-end skeleton

Task 07  channel-harness plugin/config
Task 08  SessionBinding store
Task 09  AgentManager + AgentHandle ownership
Task 10  inbound -> followup
Task 11  session/event -> ReplyRouter
Task 12  DSH Bundle + clean profile install

Task 13  Weixin Driver
Task 14  Weixin Adapter/Auth
Task 15  Weixin fixtures/E2E

Task 16  DingTalk Driver
Task 17  DingTalk Adapter
Task 18  DingTalk AI Card streaming

Task 19  QQ Driver/Adapter/Auth
Task 20  Lark Driver/Adapter/Threads/Card

Task 21  compatibility manifest
Task 22  channels doctor
Task 23  Harness compatibility tests
Task 24  Renovate/Dependabot pipeline

Task 25  Changesets/release
Task 26  public testkit/template
Task 27  Telegram extensibility proof
```

---

# 28. 推荐 Milestones

## M0 — Harness-native Framework

完成：

```text
Monorepo
Channel Core
Cordis ChannelService
Testkit
Harness Bridge skeleton
DSH Bundle skeleton
Fake E2E
```

验收：

```text
Fake Channel
→ Harness Agent
→ session/event
→ Fake Channel
```

---

## M1 — First Real Channel

Weixin：

```text
Auth
Receive
Harness reply
Persistent session
Restart recovery
```

---

## M2 — Rich Streaming

DingTalk：

```text
AI Card
chunk updates
throttle
reconnect
dedup
```

---

## M3 — Four Official Channels

```text
Weixin
DingTalk
QQ
Lark
```

统一：

```text
health
doctor
session binding
routing
auth
```

---

## M4 — Compatibility Governance

```text
upstream manifests
Harness compat
Renovate
fixtures
upgrade CI
```

---

## M5 — Public Channel SDK

```text
defineChannelAdapter
testkit
template
verify
docs
Telegram proof
```

---

# 29. `channel-testkit` 最终结论

**第一阶段就做。**

理由有两个：

### 上游平台侧

```text
Tencent
DingTalk
Lark
QQ
```

都会持续变化。

### Harness 侧

DeepSeek Harness 当前仍处于快速开发阶段，Bridge API 也可能变化。

所以 Testkit 同时保护：

```text
Upstream Compatibility
+
Harness Compatibility
```

第一版只做：

```text
Contract
Fake
Fixtures
E2E
Harness Regression
```

这已经足够，不需要重型测试平台。

---

# 30. 最终执行决策

实施顺序正式敲定：

```text
Monorepo
   ↓
Channel Contract
   ↓
Cordis ChannelService
   ↓
Testkit
   ↓
Harness Bridge
   ↓
AgentHandle / SessionBinding
   ↓
session/event Reply Pipeline
   ↓
DSH Bundle
   ↓
Weixin
   ↓
DingTalk
   ↓
QQ
   ↓
Lark
   ↓
Compatibility Governance
   ↓
Third-party SDK
   ↓
Telegram Proof
```

最终目标：

> **让渠道扩展遵循 DeepSeek Harness 官方插件与 Cordis Service 模型，而不是在 Harness 外面再造一套 Runtime。**

同时保持：

> **Harness API 变化只收敛在 `channel-harness`；渠道 SDK/API 变化只收敛在各自 Upstream Driver。**
