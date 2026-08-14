# DeepSeek Harness Channels — QQ 官方 SDK 接入重构最终执行文档

> **文档版本：v1.0 Final**  
> **日期：2026-08-14**  
> **目标仓库：`wsz987/dsh-channels`**  
> **目标包：`@dsh/channel-qq`**  
> **目标上游：`@tencent-connect/qqbot-nodejs`**  
> **结论：保留 DSH QQ Adapter 外壳，彻底替换 QQ 平台实现层，不保留旧 Gateway 双实现。**

---

## 1. 最终决策

当前 `@dsh/channel-qq` **不删除整个包重做**。

### 保留

```text
@dsh/channel-core
@dsh/channel-harness
@dsh/channel-qq 包名
ChannelAdapter Contract
ChannelService
SessionBinding
AgentManager
ReplyRouter
Harness session/event pipeline
```

### 重做

```text
@dsh/channel-qq 内部 QQ 平台实现
```

当前 QQ 实现自行维护：

```text
ws
Token
Gateway
Identify
Heartbeat
RESUME
Reconnect
OpenAPI
Media protocol
```

这些全部退出正式实现。

腾讯当前 `@tencent-connect/qqbot-nodejs` 已经包含 QQ Open Platform 的 Token、REST、WebSocket Gateway、heartbeat/RESUME、Webhook、媒体、大文件上传和 C2C streaming，因此 DSH 不应再复制协议层。

最终边界：

```text
QQ Open Platform
       │
       ▼
@tencent-connect/qqbot-nodejs
       │
       ▼
@dsh/channel-qq
  ├─ SDK Client Port
  ├─ Mapper
  ├─ Outbound
  └─ Streaming Reply
       │
       ▼
ctx.channels
       │
       ▼
channel-harness
       │
       ▼
Harness Agent
```

---

## 2. 明确禁止的方案

不允许：

```text
@dsh/channel-qq
        ↓
@tencent-connect/openclaw-qqbot
        ↓
OpenClaw Runtime
```

`openclaw-qqbot` 本身通过 `openclaw/plugin-sdk` 注册 OpenClaw Channel，是 OpenClaw 插件，不是通用 QQ SDK。

它可以作为：

```text
官方功能参考实现
上游行为参考
QQ 能力基线
```

但运行时真正依赖：

```text
@tencent-connect/qqbot-nodejs
```

这也符合原执行计划的：

```text
不依赖 OpenClaw Runtime
Adapter 不依赖 Harness Agent API
```

---

## 3. 最终目标目录

重构后：

```text
packages/channel-qq/
├─ package.json
├─ src/
│  ├─ index.ts
│  ├─ config.ts
│  ├─ adapter.ts
│  ├─ sdk-client.ts
│  ├─ inbound.ts
│  ├─ mapper.ts
│  ├─ outbound.ts
│  ├─ streaming-reply.ts
│  └─ manifest.ts
│
└─ test/
   ├─ adapter.test.ts
   ├─ mapper.test.ts
   ├─ outbound.test.ts
   ├─ streaming.test.ts
   ├─ lifecycle.test.ts
   ├─ qq-e2e.test.ts
   └─ fixtures.test.ts
```

旧正式实现删除：

```text
qq-gateway-upstream.ts      DELETE
transport.ts                DELETE
旧 upstream.ts              DELETE
旧 auth.ts                  DELETE

直接 ws dependency          DELETE
自实现 Token                DELETE
自实现 Gateway              DELETE
自实现 heartbeat            DELETE
自实现 Identify/Resume      DELETE
自实现 reconnect            DELETE
自实现 OpenAPI              DELETE
```

当前 `QQUpstream` 围绕 `/stream`、`/message/send`、`/message/media`、`/qrcode` 等自建 Gateway 接口设计，应彻底退出正式 QQ 路径。

---

## 4. Package 依赖调整

修改：

```text
packages/channel-qq/package.json
```

正式依赖：

```json
{
  "dependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/schemastery": "^3.18.1",
    "@dsh/channel-core": "workspace:*",
    "@tencent-connect/qqbot-nodejs": "1.0.4"
  }
}
```

删除：

```json
"ws": "^8"
```

首版建议**精确锁 `1.0.4`**，不要直接 `latest`。

后续：

```text
Renovate
   ↓
qqbot-nodejs 新版本 PR
   ↓
compat tests
   ↓
CI
   ↓
人工确认升级
```

腾讯 SDK 自身已经依赖 `ws`，DSH QQ Adapter 不再直接拥有 WebSocket 协议责任。

---

## 5. 最终 QQ Config

### 5.1 删除旧配置

删除：

```yaml
baseUrl:
timeoutMs:
longPollTimeoutMs:

upstream:
  mode: sdk | gateway

auth:
  qrPollIntervalMs:
  qrExpireMs:

reconnect:
  baseDelayMs:
  maxDelayMs:
  maxRetries:
```

这些属于旧 Gateway / 自实现协议生命周期。

Reconnect、Heartbeat、RESUME、Token refresh 交给腾讯 SDK。

### 5.2 新配置

V1：

```yaml
channels-qq:
  enabled: true

  accountId: main

  appId: ${QQBOT_APP_ID}
  appSecret: ${QQBOT_APP_SECRET}

  markdownSupport: false

  streaming:
    enabled: true
    throttleMs: 500

  dedup:
    enabled: true
    windowMs: 5000

  startupTimeoutMs: 15000
```

### 5.3 V1 Transport

V1 **只支持 WebSocket**。

不要现在再设计：

```yaml
transport:
  mode: websocket | webhook
```

腾讯 SDK 虽然原生支持 WebSocket/Webhook，但 DSH 第一版先把：

```text
QQ → Harness → QQ
```

跑稳。

Webhook 留 V2。

---

## 6. 新增 `sdk-client.ts`

不要让整个 Adapter 到处引用 `QQBot`。

建立 DSH 自己的极薄 Port：

```ts
export interface QQSdkClient {
  onReady(handler: () => void): void
  onResumed(handler: () => void): void
  onError(handler: (error: Error) => void): void
  onMessage(handler: (message: QQBotInboundMessage) => void): void

  start(signal: AbortSignal): Promise<void>
  stop(): void

  sendText(
    target: ReplyTarget,
    text: string,
  ): Promise<unknown>

  sendMedia(
    target: ReplyTarget,
    message: OutboundMessage,
  ): Promise<unknown>

  openStream(
    target: ReplyTarget,
  ): StreamSession
}
```

生产：

```text
TencentQQSdkClient
        ↓
QQBot
```

测试：

```text
FakeQQSdkClient
```

这样 Adapter Contract 测试不访问腾讯服务器。

---

## 7. Tencent SDK Client 实现

核心：

```ts
import {
  QQBot,
  type QQBotInboundMessage,
} from '@tencent-connect/qqbot-nodejs'

export class TencentQQSdkClient {
  readonly bot: QQBot

  constructor(config: QQConfig, logger: ChannelLogger) {
    this.bot = new QQBot({
      appId: config.appId,
      appSecret: config.appSecret,

      accountId: config.accountId,

      markdownSupport: config.markdownSupport,

      transport: 'websocket',

      tokenPrefetch: 'sync',

      logger: adaptLogger(logger),
    })
  }
}
```

SDK 的 `QQBot` 是官方高级入口，负责组合 Token、HTTP、媒体和 Gateway。

---

## 8. Adapter 生命周期必须重写

这是本次重构的关键点。

腾讯：

```ts
await bot.start()
```

不是“连接成功就返回”。

它一直运行到：

```text
stop
或
AbortSignal
```

才结束。

所以禁止：

```ts
async start(ctx) {
  await bot.start(ctx.signal)
}
```

否则 Cordis Plugin 初始化会被长生命周期阻塞。

### 正确实现

```ts
async start(ctx: ChannelAdapterContext): Promise<void> {
  if (this.started) return

  this.ctx = ctx

  const ready = createDeferred<void>()

  this.client.onReady(() => {
    this.connected = true

    void ctx.emit({
      type: 'auth.changed',
      channel: 'qq',
      accountId: this.config.accountId,
      state: 'authenticated',
    })

    void ctx.emit({
      type: 'connection.changed',
      channel: 'qq',
      accountId: this.config.accountId,
      state: 'connected',
    })

    ready.resolve()
  })

  this.client.onResumed(() => {
    this.connected = true

    void ctx.emit({
      type: 'connection.changed',
      channel: 'qq',
      accountId: this.config.accountId,
      state: 'connected',
    })
  })

  this.client.onError(error => {
    this.handleSdkError(error)
  })

  this.client.onMessage(message => {
    void this.handleInbound(message)
  })

  this.runPromise = this.client
    .start(ctx.signal)
    .catch(error => {
      this.handleSdkError(error)
    })

  await withTimeout(
    ready.promise,
    this.config.startupTimeoutMs,
  )

  this.started = true
}
```

停止：

```ts
async stop(): Promise<void> {
  if (!this.started) return

  this.started = false

  this.client.stop()

  await this.runPromise?.catch(() => undefined)

  this.connected = false
}
```

---

## 9. 不再做第二套 reconnect

必须删除 Adapter 当前：

```text
runReceiveLoop()
attempt
baseDelay
maxDelay
maxRetries
sleep()
```

腾讯 SDK 自己拥有：

```text
WebSocket
Heartbeat
RESUME
Reconnect
Token refresh
```

禁止：

```text
DSH reconnect
      +
Tencent reconnect
```

否则会出现：

```text
双重 reconnect
重复连接
重复事件
状态竞争
难以正确 stop
```

---

## 10. Inbound Mapper 重写

当前 mapper 输入的是 DSH 自己构造出来的：

```ts
QQRaw
```

全部取消。

新的输入直接是：

```ts
QQBotInboundMessage
```

Tencent SDK 已经统一提供：

```text
kind
senderId
senderName
content
messageId
timestamp
groupOpenid
attachments
mentions
replyTarget
refMsgIdx
msgIdx
raw
```

### 10.1 V1 支持范围

只正式接受：

```text
kind = c2c
kind = group
```

暂不扩大：

```text
guild
guild dm
```

防止本次重构继续膨胀。

### 10.2 C2C

```text
Tencent:

kind = c2c
senderId = user_openid

↓

Channel:

conversation.id = senderId
conversation.type = dm
```

### 10.3 Group

```text
Tencent:

kind = group
groupOpenid

↓

Channel:

conversation.id = groupOpenid
conversation.type = group
```

### 10.4 Mapper 示例

```ts
export function mapInbound(
  msg: QQBotInboundMessage,
  accountId: AccountId,
): MessageReceived {
  const group = msg.kind === 'group'

  return {
    type: 'message.received',

    channel: 'qq' as ChannelId,
    accountId,

    conversation: {
      id: (
        group
          ? msg.groupOpenid!
          : msg.senderId
      ) as ConversationId,

      type: group ? 'group' : 'dm',
    },

    sender: {
      id: msg.senderId as SenderId,
      name: msg.senderName,
    },

    message: {
      id: msg.messageId as MessageId,
      content: mapMessageParts(msg),
      createdAt: Date.parse(msg.timestamp),
    },

    raw: msg.raw,
  }
}
```

---

## 11. 媒体映射

Tencent attachment → Channel MessagePart：

```text
image
  → ImagePart

voice/audio
  → AudioPart

video
  → VideoPart

file
  → FilePart
```

Tencent SDK inbound attachment 已包含：

```text
content_type
url
filename
size
width
height
voice_wav_url
asr_refer_text
```

因此不要再自己猜 QQ payload。

---

## 12. Outbound 重写

当前：

```text
OutboundSender
  ↓
QQUpstream.sendText()
QQUpstream.sendMedia()
```

改成：

```text
OutboundMessage
     ↓
QQ OutboundMapper
     ↓
QQBot API
```

正式支持：

```text
text
image
audio
video
file
```

---

## 13. 必须修 Harness Reply Context

这是此次重构**不能跳过**的一项。

QQ C2C streaming 不是只知道：

```text
user openid
```

就可以。

还必须知道触发当前回复的：

```text
msgId
```

Tencent：

```ts
bot.openStream(...)
```

要求：

```text
scope === c2c
target.msgId 存在
```

否则不能打开 stream。

但当前 SessionBinding 只有：

```text
channelId
accountId
conversationId
threadId
sessionId
```

ReplyRouter 重建 target 时也没有原始 `messageId`。

所以现在直接换 SDK：

```text
仍然无法正确做 QQ C2C streaming
```

---

## 14. 不允许把 `lastMessageId` 写入 SessionBinding

错误：

```ts
SessionBinding {
  sessionId
  ...
  lastMessageId
}
```

SessionBinding 是：

```text
Conversation
 ↔
Harness Session
```

的持久关系。

`messageId` 属于：

```text
一次用户消息
 ↔
一次 Agent Turn
```

是 transient state。

必须分开。

---

## 15. 新增 `ReplyContextStore`

位置：

```text
packages/channel-harness/src/reply-context-store.ts
```

定义：

```ts
export interface ChannelReplyContext {
  conversationType: 'dm' | 'group'

  replyToMessageId?: string

  raw?: unknown
}
```

内部维护：

```text
pending:
sessionId
  ↓
FIFO ReplyContext[]

active:
sessionId + turn
  ↓
ReplyContext
```

---

## 16. Inbound → ReplyContext 流程

当前 Bridge：

```text
ChannelEvent
   ↓
SessionBinding
   ↓
agent.followup()
```

改成：

```text
ChannelEvent
   ↓
SessionBinding
   ↓
enqueue ReplyContext
   ↓
agent.followup()
```

代码：

```ts
replyContextStore.enqueue(binding.sessionId, {
  conversationType: event.conversation.type,
  replyToMessageId: event.message.id,
})

agentRef.followup(userMessage)
```

必须保证：

```text
enqueue
先于
followup
```

避免 `turn/start` 先到。

---

## 17. `turn/start` 绑定 Reply Context

收到：

```text
session/event
turn/start
```

执行：

```text
pending context
      ↓ pop
sessionId + turn
      ↓
active context
```

于是：

```text
QQ msg_123
   ↓
Harness Turn 7
   ↓
ReplyContext(msg_123)
```

从此这个 Turn 的：

```text
assistant/chunk
assistant/message
turn/end
```

都使用同一个 ReplyContext。

---

## 18. ChannelTarget 小扩展

修改：

```ts
export interface ChannelTarget
  extends ChannelConversationKey {

  conversationType?: 'dm' | 'group'

  replyToMessageId?: MessageId

  raw?: unknown
}
```

这是通用能力，不是 QQ 专属字段。

未来：

```text
Telegram reply
Slack thread reply
Lark reply
DingTalk reference
```

同样可以使用。

---

## 19. Streaming capability 改为 target-aware

当前：

```ts
streaming:
  'native'
  | 'edit'
  | 'buffered'
```

是 Adapter 静态属性。

但 QQ 实际：

```text
C2C:
native streaming

Group:
buffered
```

所以给 Adapter 增加可选：

```ts
resolveStreamingMode?(
  target: ChannelTarget
): StreamingMode
```

### QQ

基础能力：

```ts
capabilities.streaming = 'buffered'
```

这是保守默认。

然后：

```ts
resolveStreamingMode(target) {
  if (
    target.conversationType === 'dm' &&
    target.replyToMessageId
  ) {
    return 'native'
  }

  return 'buffered'
}
```

---

## 20. ReplyRouter 修改

当前：

```ts
strategyFor(adapter)
```

修改：

```ts
strategyFor(adapter, target)
```

实现：

```ts
function strategyFor(
  adapter: ChannelAdapter,
  target: ChannelTarget,
): ReplyStrategy {
  const mode =
    adapter.resolveStreamingMode?.(target)
    ?? adapter.capabilities.streaming

  if (adapter.createReply) {
    if (mode === 'native') return 'native'
    if (mode === 'edit') return 'edit'
  }

  return 'buffered'
}
```

---

## 21. QQ C2C Streaming ReplyHandle

新增：

```text
streaming-reply.ts
```

Tencent Stream API 是：

```ts
stream.update(fullText)
stream.complete()
stream.cancel()
```

其中：

> `update()` 接受的是完整累计文本，不是 delta。

同时 SDK 自己实现 throttle、rate-limit retry 和 final DONE frame。

### DSH ReplyHandle

```ts
export class QQStreamingReply
  implements ReplyHandle {

  private text = ''

  constructor(
    private readonly stream: StreamSession,
  ) {}

  async append(delta: string): Promise<void> {
    this.text += delta

    await this.stream.update(this.text)
  }

  async replace(
    message: OutboundMessage,
  ): Promise<void> {
    this.text = message.text ?? ''

    await this.stream.update(this.text)
  }

  async finish(
    message?: OutboundMessage,
  ): Promise<void> {
    if (
      message?.text !== undefined &&
      message.text !== this.text
    ) {
      this.text = message.text

      await this.stream.update(this.text)
    }

    await this.stream.complete()
  }

  async fail(): Promise<void> {
    this.stream.cancel()
  }
}
```

---

## 22. Streaming throttle

腾讯 SDK：

```text
默认 500 ms
最低 300 ms
```

并自动处理：

```text
pending
trailing flush
429
50002
指数退避
DONE frame
```

因此配置：

```yaml
streaming:
  throttleMs: 500
```

Schema：

```text
min = 300
default = 500
```

然后：

```ts
bot.openStream({
  target,
  throttleMs:
    config.streaming.throttleMs,
})
```

Harness 的 `reply.updateIntervalMs` 可以继续存在。

实际平台发送节奏由 Tencent StreamSession 最终限流。

---

## 23. QQ `createReply()`

```ts
async createReply(
  target: ChannelTarget,
): Promise<ReplyHandle> {

  if (
    target.conversationType !== 'dm' ||
    !target.replyToMessageId
  ) {
    throw new ChannelError(
      'CHANNEL_ERROR',
      'QQ native streaming requires a C2C reply target with message id',
    )
  }

  const stream = this.client.openStream({
    scope: 'c2c',
    targetId: target.conversationId,
    msgId: target.replyToMessageId,
  })

  return new QQStreamingReply(stream)
}
```

QQ群永远不会进入这里。

Group：

```text
assistant chunks
     ↓
ReplyRouter buffer
     ↓
turn/end
     ↓
adapter.send()
     ↓
QQ Group
```

---

## 24. 去重策略

腾讯 SDK 自己有 middleware：

```text
messageFilter
dedup
rateLimiter
mentionGate
...
```

V1 **不要启用大量 SDK middleware**。

原因：

```text
DSH Channel Core
已经拥有自己的 dedup 行为
```

所以：

```text
QQ SDK
只负责 platform transport/protocol

DSH
负责跨渠道统一策略
```

保留现有：

```text
InboundProcessor dedup
```

避免：

```text
Tencent dedup
+
DSH dedup
```

双重状态。

---

## 25. Group @ Mention

V1 不引入腾讯：

```text
mentionGate()
```

因为是否：

```text
只响应 @
还是群内自动响应
```

属于：

```text
DSH Channel policy
```

而不是 QQ transport policy。

以后单独增加：

```yaml
group:
  requireMention: true
```

但不属于此次重构阻塞项。

---

## 26. Health 状态

QQ SDK：

```text
READY
  ↓
connected=true
authenticated=true
```

RESUMED：

```text
RESUMED
  ↓
connected=true
```

Error：

```text
error
  ↓
degraded
```

Stop：

```text
closed
```

禁止再通过：

```text
receiveLoop 是否存在
```

判断连接状态。

---

## 27. Manifest 更新

修改：

```text
packages/channel-qq/src/manifest.ts
```

上游改为：

```text
tencent-connect/qqbot-nodejs
```

初始：

```text
testedVersion: 1.0.4
```

Governance：

```text
Renovate
   ↓
SDK update
   ↓
fixtures
   ↓
adapter tests
   ↓
QQ compatibility tests
   ↓
CI
```

---

## 28. QR Onboarding 不阻塞 V1

腾讯 `openclaw-qqbot` 现在还使用：

```text
@tencent-connect/qqbot-connector
```

但扫码配置属于：

```text
credential onboarding
```

不是 QQ runtime transport。

所以本轮：

```text
NOT REQUIRED
```

第一阶段：

```text
AppID + AppSecret
```

启动 QQ。

第二阶段再做：

```text
dsh channels login qq
        ↓
QR
        ↓
credential binding
        ↓
写入 DSH secret/profile
```

不要把扫码逻辑塞进 `QQAdapter.start()`。

---

## 29. 本轮最终执行 Task

### QQ-R0 — 冻结旧 QQ 实现

不再给：

```text
qq-gateway-upstream
HttpQQUpstream
自实现 WS
```

增加功能。

保存现有 tests 作为行为基线。

#### 验收

```text
现有行为测试记录完成
```

---

### QQ-R1 — Core Reply Target Extension

修改：

```text
channel-core/src/adapter.ts
```

增加：

```text
conversationType
replyToMessageId
resolveStreamingMode()
```

#### 验收

现有：

```text
Weixin
DingTalk
Lark
Telegram
FakeAdapter
```

全部无需修改或仅类型适配即可通过。

---

### QQ-R2 — Harness ReplyContext

新增：

```text
reply-context-store.ts
```

修改：

```text
bridge.ts
reply-router.ts
lifecycle.ts
```

完成：

```text
message
→ pending context
→ followup
→ turn/start
→ active context
→ turn/end cleanup
```

#### 验收

两个连续消息：

```text
msg_A
msg_B
```

必须严格绑定：

```text
Turn 1 → msg_A
Turn 2 → msg_B
```

不能串 reply target。

---

### QQ-R3 — Tencent SDK Client

增加：

```text
sdk-client.ts
```

加入：

```text
@tencent-connect/qqbot-nodejs@1.0.4
```

Fake client 可注入。

#### 验收

Adapter tests：

```text
完全离线运行
```

---

### QQ-R4 — Lifecycle

重写：

```text
adapter.start()
adapter.stop()
```

删除自实现 receive/reconnect loop。

#### 验收

```text
READY
RESUMED
ERROR
Abort
Stop
Repeated Stop
Startup timeout
Invalid credentials
```

全部覆盖。

---

### QQ-R5 — Inbound

输入改为：

```text
QQBotInboundMessage
```

完成：

```text
C2C
Group
Text
Image
Voice
Video
File
Unknown
```

#### 验收

真实 SDK fixture → ChannelEvent fixture。

---

### QQ-R6 — Outbound

实现：

```text
text
image
audio
video
file
```

#### 验收

Fake SDK 调用参数与：

```text
ReplyTarget
scope
targetId
msgId
```

全部正确。

---

### QQ-R7 — C2C Streaming

实现：

```text
QQStreamingReply
```

以及：

```text
target-aware streaming
```

#### 验收

输入：

```text
你
好
，
世
界
```

最终 SDK 接收到的完整文本序列必须单调增长：

```text
你
你好
你好，
你好，世界
```

而不是：

```text
你
好
，
世界
```

因为 QQ 使用 replace semantics。

---

### QQ-R8 — Group Buffered

群聊必须：

```text
20 个 assistant chunk
```

最终：

```text
仅一次普通 QQ send
```

不能误用：

```text
stream_messages
```

---

### QQ-R9 — 删除旧实现

全部新测试通过后才删除：

```text
qq-gateway-upstream.ts
transport.ts
旧 upstream.ts
旧 auth.ts
ws dependency
gateway config
reconnect config
QR gateway config
```

这是最后一步。

不要一开始先删。

---

## 30. 测试矩阵

| Case | 期望 |
|---|---|
| C2C text inbound | 正确进入 Harness |
| Group text inbound | 独立 Session |
| 两个 C2C 用户 | 不共享 Session |
| 两个 QQ Group | 不共享 Session |
| repeated msgId | 只处理一次 |
| image inbound | ImagePart |
| voice inbound | AudioPart |
| video inbound | VideoPart |
| file inbound | FilePart |
| C2C reply | 正确绑定 trigger msgId |
| C2C streaming | StreamSession |
| Group streaming output | Buffered |
| stream failure | cancel |
| turn/end | complete |
| READY | health ok |
| RESUMED | health ok |
| invalid credentials | startup fail |
| stop | 无残留 connection |
| repeated stop | 幂等 |
| Harness restart | SessionBinding 继续复用 |
| QQ SDK version fixture | compat pass |

---

## 31. 必做真实 E2E

离线测试全部通过后，还不算 QQ 完成。

必须真实：

```text
QQ 用户
   ↓
Tencent WebSocket
   ↓
qqbot-nodejs
   ↓
channel-qq
   ↓
ChannelService
   ↓
channel-harness
   ↓
Harness Agent
   ↓
session/event
   ↓
QQStreamingReply / send
   ↓
QQ 用户
```

至少验证：

```text
1. C2C 普通消息
2. C2C streaming
3. Group @ message
4. Group buffered reply
5. 图片
6. 文件
7. 断线恢复
8. DSH restart 后再次聊天
```

---

## 32. Release Gate

只有以下全部通过：

```bash
pnpm build
pnpm typecheck
pnpm test
```

并且：

```text
QQ contract tests PASS
Harness regression PASS
Bundle tests PASS
Compatibility tests PASS
真实 QQ E2E PASS
GitHub Actions PASS
```

才允许：

```text
@dsh/channel-qq
0.5.x
  ↓
0.6.0
```

建议作为 **Breaking Release**。

---

## 33. README 必须同步修改

旧文档里：

```text
QQ:
official WebSocket gateway implemented in-source
```

删除。

改成：

```text
QQ:
Tencent official
@tencent-connect/qqbot-nodejs
```

并明确：

```text
Runtime:
QQ SDK → Channel Adapter → Harness

No OpenClaw runtime dependency.
No custom QQ gateway required.
```

---

## 34. 最终用户配置体验

安装：

```bash
dsh plugin --profile default add @dsh/channels
```

配置：

```yaml
plugins:

  channels-harness:
    defaultAgentId: default

  channels-qq:
    enabled: true
    accountId: main

    appId: ${QQBOT_APP_ID}
    appSecret: ${QQBOT_APP_SECRET}

    markdownSupport: false

    streaming:
      enabled: true
      throttleMs: 500
```

启动：

```bash
dsh --profile default
```

之后：

```text
用户 QQ 发消息
      ↓
QQ SDK
      ↓
channel-qq
      ↓
Harness Agent
      ↓
自动回复 QQ
```

用户不需要：

```text
部署 QQ Gateway
维护 WebSocket 服务
维护 Token
处理 heartbeat
处理 reconnect
处理 OpenAPI
```

---

## 35. 最终完成定义（Definition of Done）

只有下面全部成立，才能把 **QQ M3 标记为真正完成**：

```text
✅ @dsh/channel-qq 保留稳定 Channel Contract

✅ Runtime 直接使用
   @tencent-connect/qqbot-nodejs

✅ 不依赖 OpenClaw Runtime

✅ 不直接依赖 ws

✅ 不自己实现 Token

✅ 不自己实现 Gateway heartbeat

✅ 不自己实现 RESUME

✅ 不自己实现 reconnect

✅ 不维护第二套 QQ OpenAPI

✅ C2C / Group 正确隔离 Session

✅ trigger messageId 正确传递到当前 Harness Turn

✅ C2C 使用 QQ native streaming

✅ Group 自动降级 buffered

✅ Text / Image / Audio / Video / File 可映射

✅ Cordis dispose 正确停止 QQ SDK

✅ Tencent SDK 可通过 Renovate + compat CI 升级

✅ Fake E2E 成功

✅ 真实 QQ → Harness → QQ E2E 成功
```

---

## 36. 最终执行原则

> `@dsh/channel-qq` 只负责把 Tencent QQ SDK 的平台语义转换成 DSH Channel Contract；QQ 协议、Token、WebSocket、重连、媒体、流式协议全部交还 Tencent 官方 SDK。不要保留当前自实现 Gateway 作为第二条正式链路。
