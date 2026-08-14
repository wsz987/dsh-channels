# DeepSeek Harness Channels — QQ 官方 SDK 接入重构执行文档

> **文档版本：v1.1 Harness-Verified**  
> **日期：2026-08-14**  
> **目标仓库：`wsz987/dsh-channels`**  
> **目标包：`@dsh/channel-qq`**  
> **目标上游：`@tencent-connect/qqbot-nodejs`**  
> **状态：Final / 可执行**  
>
> 本文档替代此前 v1.0。  
> v1.1 已按 DeepSeek Harness 官方开发文档与当前官方源码核验，并修正：
>
> 1. ReplyContext 不再在 `turn/start` FIFO 绑定；
> 2. 改用 `agent/inbox/claimed` 精确关联 Harness Message → Turn；
> 3. 不再通过错误字符串判断是否需要 `resume → create`；
> 4. `channel-harness` 正式依赖 `sessionPersistence`；
> 5. QQ Secret 改接 Harness `ctx.credentials`；
> 6. Bundle/Profile 示例改为当前 DSH 官方 patch 模型；
> 7. 保留 Tencent QQ SDK 负责 Token / WebSocket / heartbeat / RESUME / reconnect / OpenAPI 的设计。

---

# 1. 最终结论

当前 `@dsh/channel-qq` **不删除整个包重做**。

保留 DSH 已经建立好的跨渠道框架：

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

彻底重做：

```text
@dsh/channel-qq 内部 QQ 平台实现层
```

当前 QQ 自行维护的以下协议实现全部退出正式路径：

```text
ws
Token
Gateway
Identify
Heartbeat
RESUME
Reconnect
QQ OpenAPI
Media protocol
自建 QQ Gateway transport
```

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
  ├─ Inbound Mapper
  ├─ Outbound Mapper
  └─ Streaming Reply
       │
       ▼
ctx.channels
       │
       ▼
@dsh/channel-harness
  ├─ SessionBinding
  ├─ ReplyContextStore
  ├─ AgentManager
  └─ ReplyRouter
       │
       ▼
DeepSeek Harness
  ├─ ctx.agents
  ├─ ctx.sessionPersistence
  ├─ agent/inbox/claimed
  └─ session/event
```

---

# 2. 不使用 OpenClaw Runtime

禁止正式架构：

```text
@dsh/channel-qq
        ↓
@tencent-connect/openclaw-qqbot
        ↓
OpenClaw Runtime
```

`openclaw-qqbot` 可以作为：

```text
腾讯官方功能参考
行为参考
能力基线
```

但 DSH Runtime 不依赖 OpenClaw。

正式依赖：

```text
@tencent-connect/qqbot-nodejs
```

最终定位：

> `@dsh/channel-qq` 只负责把 Tencent QQ SDK 的平台语义转换为 DSH Channel Contract。

QQ 协议层交给 Tencent SDK：

```text
Token
WebSocket
Gateway
Identify
Heartbeat
RESUME
Reconnect
REST/OpenAPI
媒体上传
流式协议
```

---

# 3. Harness 官方契约核验结果

以下设计已确认符合 DeepSeek Harness 官方开发模型。

## 3.1 ChannelService

`ChannelService` 继续：

```ts
class ChannelService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'channels')
  }
}
```

并通过 declaration merging：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    channels: ChannelService
  }
}
```

Adapter：

```ts
export const inject = ['channels']
```

Bridge：

```ts
export const inject = [
  'channels',
  'agents',
  'sessionPersistence',
]
```

Cordis 会在所需 Service 不存在时保持插件 `PENDING`。

---

## 3.2 外部长生命周期资源

QQ SDK WebSocket 属于 Cordis 不自动管理的外部资源。

必须由：

```ts
ctx.effect()
```

持有生命周期。

例如：

```ts
export function apply(
  ctx: Context,
  config: Config,
): void {
  ctx.effect(() => {
    const adapter = createQQAdapter(ctx, config)

    void adapter.start()

    return async () => {
      await adapter.stop()
    }
  })
}
```

原则：

```text
Plugin load
   ↓
start SDK

Plugin unload / HMR / dependency loss
   ↓
stop SDK
   ↓
await cleanup
```

---

## 3.3 Agent ownership

继续遵循：

```text
ctx.agents.get()
   → 借用 live Agent
   → 不拥有 dispose 权

ctx.agents.create()
ctx.agents.resume()
   → 返回 AgentHandle
   → channel-harness 持有 handle
   → unload 时 dispose
```

禁止：

```text
通过 ctx.agents.get() 获得 Agent
然后主动销毁它
```

---

## 3.4 Agent / Session identity

Harness 当前保证：

```text
agent.id === agent.session.id
```

因此 Channel SessionBinding 继续只需要持有：

```ts
interface SessionBinding {
  channelId: string
  accountId: string
  conversationId: string
  threadId?: string

  sessionId: string
}
```

不增加额外 Harness Agent ID 副本。

---

# 4. 最终目标目录

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
   ├─ fixtures.test.ts
   └─ qq-e2e.test.ts
```

旧正式实现删除：

```text
qq-gateway-upstream.ts
transport.ts
旧 upstream.ts
旧 auth.ts

@dsh/channel-qq 对 ws 的直接依赖
自实现 Token
自实现 Gateway
自实现 Identify
自实现 heartbeat
自实现 RESUME
自实现 reconnect
自实现 QQ OpenAPI
旧 Gateway QR auth
```

注意：

> 删除旧文件是最后一步，不是第一步。

---

# 5. Package 依赖

修改：

```text
packages/channel-qq/package.json
```

目标：

```json
{
  "dependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/schemastery": "^3.18.1",
    "@deepseek-ai/dsh-credentials": "^0.1.0-rc.5",
    "@dsh/channel-core": "workspace:*",
    "@tencent-connect/qqbot-nodejs": "1.0.4"
  }
}
```

> DeepSeek Harness RC 依赖版本应与当前项目统一锁定，不允许在单个包内自行漂移。

删除：

```json
"ws": "^8"
```

Tencent SDK 的协议依赖不再暴露为 DSH QQ Adapter 的直接职责。

---

# 6. QQ Config — Harness Native

## 6.1 删除旧配置

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

---

## 6.2 新配置

```yaml
channels-qq:
  accountId: main

  appId: "QQ Bot AppID"

  appSecretRef: QQBOT_APP_SECRET

  markdownSupport: false

  streaming:
    enabled: true
    throttleMs: 500

  dedup:
    enabled: true
    windowMs: 5000

  startupTimeoutMs: 15000
```

重点：

```text
appId
```

不是 Secret，可以存在 config。

```text
appSecretRef
```

只是凭据引用。

真实 AppSecret 不写入：

```text
cordis.patch.yml
profile config
bundle config
git
```

---

# 7. Harness Credentials 接入

QQ Adapter 增加：

```ts
export const inject = [
  'channels',
  'credentials',
]
```

启动时：

```ts
import {
  credentialRef,
} from '@deepseek-ai/dsh-credentials'

const credential =
  await ctx.credentials.resolve(
    credentialRef(config.appSecretRef),
  )

if (!credential) {
  throw new Error(
    `QQ credential "${config.appSecretRef}" is not configured`,
  )
}
```

然后：

```ts
const bot = new QQBot({
  appId: config.appId,
  appSecret: credential.value,
})
```

---

## 7.1 为什么不用 `${QQBOT_APP_SECRET}`

当前 Harness 官方配置示例没有把：

```yaml
${ENV_NAME}
```

定义为标准配置插值语法。

因此本文档不依赖该行为。

Harness 自己已有：

```text
ctx.credentials
```

应优先使用 Credential Seam。

---

# 8. QQ SDK Client Port

不要让 Adapter 全部代码直接访问 `QQBot`。

新增：

```text
sdk-client.ts
```

定义极薄 Port：

```ts
export interface QQSdkClient {
  onReady(handler: () => void): void

  onResumed(handler: () => void): void

  onError(
    handler: (error: Error) => void,
  ): void

  onMessage(
    handler: (
      message: QQBotInboundMessage,
    ) => void,
  ): void

  start(
    signal: AbortSignal,
  ): Promise<void>

  stop(): void

  sendText(
    target: QQReplyTarget,
    text: string,
  ): Promise<unknown>

  sendMedia(
    target: QQReplyTarget,
    message: OutboundMessage,
  ): Promise<unknown>

  openStream(
    target: QQStreamTarget,
    options: {
      throttleMs: number
    },
  ): QQStreamSession
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

---

# 9. QQ Adapter Lifecycle

Tencent SDK 的长生命周期运行不能直接阻塞 Cordis plugin load。

禁止：

```ts
async start(ctx) {
  await bot.start(ctx.signal)
}
```

如果 `start()` 的 Promise 表示整个 WebSocket 生命周期，这会导致插件初始化无法完成。

正确方式：

```ts
async start(
  ctx: ChannelAdapterContext,
): Promise<void> {
  if (this.started) return

  this.ctx = ctx

  const ready = createDeferred<void>()

  this.client.onReady(() => {
    this.connected = true

    void ctx.emit({
      type: 'auth.changed',
      channel: 'qq',
      accountId:
        this.config.accountId,
      state: 'authenticated',
    })

    void ctx.emit({
      type: 'connection.changed',
      channel: 'qq',
      accountId:
        this.config.accountId,
      state: 'connected',
    })

    ready.resolve()
  })

  this.client.onResumed(() => {
    this.connected = true

    void ctx.emit({
      type: 'connection.changed',
      channel: 'qq',
      accountId:
        this.config.accountId,
      state: 'connected',
    })
  })

  this.client.onError(error => {
    this.handleSdkError(error)
  })

  this.client.onMessage(message => {
    void this.handleInbound(message)
  })

  this.runPromise =
    this.client.start(ctx.signal)
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

  await this.runPromise
    ?.catch(() => undefined)

  this.connected = false
}
```

---

# 10. 禁止第二套 reconnect

删除 DSH QQ Adapter 当前：

```text
runReceiveLoop
retry attempts
baseDelay
maxDelay
maxRetries
sleep
heartbeat
RESUME
Identify
```

Tencent SDK 自己负责：

```text
WebSocket
heartbeat
RESUME
Reconnect
Token refresh
```

禁止出现：

```text
Tencent reconnect
       +
DSH reconnect
```

否则会产生：

```text
重复连接
重复事件
重复 retry
状态竞争
stop 不确定性
```

---

# 11. Inbound Mapper

旧输入：

```text
QQRaw
```

退出正式路径。

新输入：

```text
QQBotInboundMessage
```

---

## 11.1 V1 支持范围

正式支持：

```text
C2C
Group
```

V1 不扩展：

```text
Guild
Guild DM
```

---

## 11.2 C2C 映射

```text
QQ:
kind = c2c
senderId = user_openid

↓

Channel:
conversation.id = senderId
conversation.type = dm
```

---

## 11.3 Group 映射

```text
QQ:
kind = group
groupOpenid

↓

Channel:
conversation.id = groupOpenid
conversation.type = group
```

---

## 11.4 Mapper 示例

```ts
export function mapInbound(
  msg: QQBotInboundMessage,
  accountId: AccountId,
): MessageReceived {
  const isGroup =
    msg.kind === 'group'

  return {
    type: 'message.received',

    channel: 'qq',
    accountId,

    conversation: {
      id: (
        isGroup
          ? msg.groupOpenid!
          : msg.senderId
      ) as ConversationId,

      type:
        isGroup
          ? 'group'
          : 'dm',
    },

    sender: {
      id:
        msg.senderId as SenderId,

      name:
        msg.senderName,
    },

    message: {
      id:
        msg.messageId as MessageId,

      content:
        mapQQMessageParts(msg),

      createdAt:
        Date.parse(msg.timestamp),
    },

    raw:
      msg.raw,
  }
}
```

---

# 12. 媒体映射

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

Platform payload 只存在 QQ Adapter 内部。

禁止：

```text
QQ raw object
   ↓
Channel Core
   ↓
Harness Agent
```

跨边界必须先转成统一 Contract。

---

# 13. Outbound

旧：

```text
OutboundSender
   ↓
QQUpstream.sendText
QQUpstream.sendMedia
```

改成：

```text
OutboundMessage
      ↓
QQ Outbound Mapper
      ↓
Tencent QQ SDK
```

V1：

```text
text
image
audio
video
file
```

---

# 14. Harness ReplyContext — v1.1 核心修正

这是相较 v1.0 最重要的改动。

## 14.1 错误方案

禁止：

```text
Channel message
   ↓
enqueue ReplyContext FIFO
   ↓
agent.followup()
   ↓
session/event turn/start
   ↓
FIFO pop
   ↓
绑定 turn
```

原因：

```text
turn/start
```

发生在 Agent 真正从 inbox claim 消息之前。

所以：

```text
turn/start ≠ 某条用户消息已经属于这个 turn
```

---

# 15. 使用 `agent/inbox/claimed`

Harness 已经提供精确事件：

```ts
'agent/inbox/claimed' {
  agent,
  message,
  turn,
}
```

所以 ReplyContext 应通过：

```text
Harness Message ID
      ↓
agent/inbox/claimed
      ↓
Turn
```

建立关联。

最终流程：

```text
QQ msg_abc
    │
    ▼
MessageReceived
    │
    ▼
toHarnessUserMessage()
    │
    ▼
Harness UserMessage
id = harness_msg_xyz
    │
    ├────────────────────────┐
    │                        │
    ▼                        ▼
register ReplyContext   agent.followup()
by message.id                 │
                              ▼
                     agent/inbox/claimed
                     {
                       message.id,
                       turn
                     }
                              │
                              ▼
                   activate ReplyContext
                   session + turn
```

---

# 16. ReplyContextStore

新增：

```text
packages/channel-harness/
src/reply-context-store.ts
```

定义：

```ts
export interface ChannelReplyContext {
  conversationType:
    | 'dm'
    | 'group'

  replyToMessageId?: string

  raw?: unknown
}
```

内部：

```ts
interface PendingReplyContext {
  sessionId: string

  context:
    ChannelReplyContext
}
```

存储：

```ts
pendingByMessageId:
  Map<MessageId, PendingReplyContext>

activeByTurn:
  Map<TurnKey, ChannelReplyContext>
```

其中：

```ts
type TurnKey =
  `${string}:${number}`
```

---

# 17. Register ReplyContext

Inbound Bridge：

```ts
const userMessage =
  toHarnessUserMessage(event)

replyContexts.register(
  userMessage.id,
  {
    sessionId:
      binding.sessionId,

    context: {
      conversationType:
        event.conversation.type,

      replyToMessageId:
        event.message.id,
    },
  },
)

agentRef.followup(
  userMessage,
)
```

顺序必须是：

```text
register context
     ↓
followup
```

禁止倒过来。

---

# 18. Claim ReplyContext

监听：

```ts
ctx.on(
  'agent/inbox/claimed',
  ({
    agent,
    message,
    turn,
  }) => {
    replyContexts.claim({
      sessionId:
        agent.session.id,

      messageId:
        message.id,

      turn,
    })
  },
)
```

执行：

```text
pendingByMessageId[message.id]
       ↓
activeByTurn[sessionId:turn]
```

然后删除 pending。

---

# 19. Discard ReplyContext

Harness 还提供：

```text
agent/inbox/discarded
```

必须监听：

```ts
ctx.on(
  'agent/inbox/discarded',
  ({ message }) => {
    replyContexts.discard(
      message.id,
    )
  },
)
```

否则：

```text
用户消息被 cancel/discard
        ↓
Harness 未进入 turn
        ↓
pending ReplyContext 永久泄漏
```

---

# 20. `turn/end` 清理

ReplyRouter：

```ts
case 'turn/end':
  await this.finishTurn(...)

  replyContexts.releaseTurn(
    session.id,
    event.data.turn,
  )

  break
```

确保：

```text
Pending:
以 Message 为生命周期

Active:
以 Turn 为生命周期
```

---

# 21. 不写 `lastMessageId` 到 SessionBinding

禁止：

```ts
interface SessionBinding {
  ...
  lastMessageId: string
}
```

SessionBinding 描述：

```text
Channel Conversation
       ↔
Harness Session
```

QQ `messageId` 描述：

```text
Platform User Message
       ↔
Harness UserMessage
       ↔
Harness Turn
```

二者生命周期完全不同。

所以：

```text
SessionBinding
  → durable

ReplyContext
  → transient
```

---

# 22. ChannelTarget Extension

Channel Core 增加通用字段：

```ts
export interface ChannelTarget
  extends ChannelConversationKey {

  conversationType?:
    | 'dm'
    | 'group'

  replyToMessageId?:
    MessageId

  raw?: unknown
}
```

不是 QQ 私有字段。

以后：

```text
Telegram reply_to
Slack thread
Lark reply
DingTalk reference
```

都能复用。

---

# 23. Target-aware Streaming

当前：

```ts
capabilities.streaming =
  'native'
  | 'edit'
  | 'buffered'
```

QQ 实际：

```text
C2C
  → native

Group
  → buffered
```

增加：

```ts
resolveStreamingMode?(
  target: ChannelTarget,
): StreamingMode
```

QQ：

```ts
capabilities.streaming =
  'buffered'

resolveStreamingMode(
  target,
) {
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

# 24. ReplyRouter

从：

```ts
strategyFor(adapter)
```

改成：

```ts
strategyFor(
  adapter,
  target,
)
```

示例：

```ts
function strategyFor(
  adapter: ChannelAdapter,
  target: ChannelTarget,
): ReplyStrategy {
  const mode =
    adapter.resolveStreamingMode
      ?.call(adapter, target)
    ?? adapter.capabilities.streaming

  if (
    adapter.createReply &&
    mode === 'native'
  ) {
    return 'native'
  }

  if (
    adapter.createReply &&
    mode === 'edit'
  ) {
    return 'edit'
  }

  return 'buffered'
}
```

---

# 25. ReplyRouter 不在 `turn/start` 建立 ReplyContext

旧逻辑：

```ts
case 'turn/start':
  ensureActive(...)
```

修改为：

```ts
case 'turn/start':
  // Turn existence only.
  // ReplyContext is not derived here.
  break
```

到：

```text
assistant/chunk
assistant/message
```

时：

```ts
const context =
  replyContexts.getTurn(
    session.id,
    event.data.turn,
  )
```

此时对应用户消息已经经过：

```text
agent/inbox/claimed
```

因此关联是确定的。

---

# 26. QQ C2C Streaming

新增：

```text
streaming-reply.ts
```

Tencent Streaming 使用累计全文更新。

因此：

```ts
export class QQStreamingReply
  implements ReplyHandle {

  private text = ''

  constructor(
    private readonly stream:
      QQStreamSession,
  ) {}

  async append(
    delta: string,
  ): Promise<void> {
    this.text += delta

    await this.stream.update(
      this.text,
    )
  }

  async replace(
    message:
      OutboundMessage,
  ): Promise<void> {
    this.text =
      message.text ?? ''

    await this.stream.update(
      this.text,
    )
  }

  async finish(
    message?:
      OutboundMessage,
  ): Promise<void> {
    if (
      message?.text !== undefined &&
      message.text !== this.text
    ) {
      this.text =
        message.text

      await this.stream.update(
        this.text,
      )
    }

    await this.stream.complete()
  }

  async fail(): Promise<void> {
    this.stream.cancel()
  }
}
```

输入 chunks：

```text
你
好
，
世
界
```

SDK 应看到累计序列：

```text
你
你好
你好，
你好，世
你好，世界
```

而不是 delta。

---

# 27. QQ `createReply()`

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
      'QQ native streaming requires a C2C target with replyToMessageId',
    )
  }

  const stream =
    this.client.openStream(
      {
        scope: 'c2c',
        targetId:
          target.conversationId,
        msgId:
          target.replyToMessageId,
      },
      {
        throttleMs:
          this.config.streaming.throttleMs,
      },
    )

  return new QQStreamingReply(
    stream,
  )
}
```

---

# 28. Group Buffered

QQ群不使用 native stream。

流程：

```text
assistant/chunk x N
      ↓
ReplyRouter buffer
      ↓
assistant/message / turn/end
      ↓
adapter.send()
      ↓
Tencent Group API
```

测试必须保证：

```text
20 chunks
```

不会发送：

```text
20 QQ messages
```

而是最终单次普通发送。

---

# 29. Persistence — v1.1 第二个核心修正

旧 `AgentManager` 当前存在：

```ts
isPersistenceError(error) {
  return /persistence|persist/i
    .test(error.message)
}
```

并执行：

```text
resume fail
   ↓
匹配 error message
   ↓
create
```

该设计必须删除。

---

# 30. 为什么不能 regex fallback

`ctx.agents.resume()` 可能因为：

```text
未配置 SessionPersistence
session 不存在
session corruption
unsupported session format
storage I/O failure
setup failure
factory failure
```

失败。

如果通过：

```text
/persistence|persist/i
```

判断：

```text
“没历史，重新 create”
```

可能把真正的数据损坏隐藏掉。

这是错误的数据语义。

---

# 31. channel-harness 正式依赖 `sessionPersistence`

Bundle：

```yaml
- id: channels-harness
  name: '@dsh/channel-harness'
  inject:
    - channels
    - agents
    - sessionPersistence
```

Plugin：

```ts
export const inject = [
  'channels',
  'agents',
  'sessionPersistence',
]
```

理由：

Channel 已经承诺：

```text
conversation → stable Harness Session
restart recovery
```

因此不应该在没有 Harness persistence 时“降级成看似可用”。

---

# 32. Session resolve 流程

不要：

```text
get
 ↓
resume
 ↓ fail
create
```

统一执行。

而应该利用已有 `SessionBinding` 判断：

---

## 32.1 新 Conversation

```text
Channel message
      ↓
BindingStore.lookup()
      ↓
不存在
      ↓
mint new sessionId
      ↓
ctx.agents.create()
      ↓
保存 SessionBinding
```

---

## 32.2 已有 Conversation

```text
Channel message
      ↓
BindingStore.lookup()
      ↓
已有 sessionId
      ↓
ctx.agents.get(sessionId)
      │
   ┌──┴──┐
 live    no
  │       │
  ▼       ▼
 use    ctx.agents.resume()
```

如果 resume 失败：

```text
直接失败
```

不自动 create 新 session。

---

# 33. Binding 保存顺序

新 conversation：

```text
mint sessionId
     ↓
create Agent
     ↓
Agent 创建成功
     ↓
persist Channel SessionBinding
```

避免：

```text
Binding 已经写入
但 Harness create 失败
```

产生悬挂 binding。

如需处理 create 成功后 binding write 失败：

```text
dispose owned AgentHandle
```

回滚这一创建流程。

---

# 34. BindingStore 与 Harness Persistence 是两个不同职责

必须保留：

```text
Channel BindingStore
```

它保存：

```text
QQ conversation
       ↓
Harness sessionId
```

Harness `sessionPersistence` 保存：

```text
Harness sessionId
       ↓
append-only SessionEvent log
```

不是重复。

正确结构：

```text
QQ conversation
      │
      ▼
BindingStore
      │ sessionId
      ▼
Harness SessionPersistence
      │
      ▼
SessionEvent[]
```

---

# 35. QQ dedup

V1 不启用 Tencent SDK 大量额外 middleware。

DSH 继续负责统一：

```text
InboundProcessor dedup
```

Tencent SDK：

```text
只负责平台 transport/protocol
```

避免：

```text
Tencent dedup
   +
DSH dedup
```

形成双状态。

---

# 36. Group @ Mention

本轮不把：

```text
mentionGate
```

放进 SDK transport。

群内是否要求 @：

```text
属于 Channel Policy
```

未来可增加：

```yaml
group:
  requireMention: true
```

但不属于本次 QQ Runtime 重构阻塞项。

---

# 37. Health

READY：

```text
authenticated = true
connected = true
```

RESUMED：

```text
connected = true
```

Error：

```text
degraded
```

Stop：

```text
closed
```

禁止再以：

```text
receiveLoop 是否存活
```

作为连接状态真源。

---

# 38. Bundle — 使用当前 DSH 官方模型

`@dsh/channels` 必须继续作为：

```text
dsh.bundle
```

包。

`package.json`：

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

用户：

```bash
dsh plugin --profile default add @dsh/channels
```

DSH 会把 bundle 加入 profile：

```text
dsh.profile.bundles
```

然后应用：

```text
cordis.patch.yml
```

---

# 39. 正确的 `cordis.patch.yml`

```yaml
- insert:
    - id: channels-service
      name: '@dsh/channel-core/plugin'

    - id: channels-harness
      name: '@dsh/channel-harness'
      inject:
        - channels
        - agents
        - sessionPersistence

    - id: channels-weixin
      name: '@dsh/channel-weixin'
      inject:
        - channels

    - id: channels-qq
      name: '@dsh/channel-qq'
      inject:
        - channels
        - credentials

    - id: channels-dingtalk
      name: '@dsh/channel-dingtalk'
      inject:
        - channels

    - id: channels-lark
      name: '@dsh/channel-lark'
      inject:
        - channels
```

---

# 40. 修复 minimal-profile 示例

当前：

```yaml
plugins:
  channels-qq:
    ...
```

不再作为官方 Bundle/Profile 示例格式。

改成真正的：

```text
apps/example/minimal-profile/
├─ package.json
├─ cordis.patch.yml
└─ README.md
```

其中 `package.json` 展示：

```json
{
  "name":
    "dsh-profile-minimal",

  "private": true,

  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@dsh/channels"
      ]
    }
  }
}
```

用户自定义：

```text
cordis.patch.yml
```

覆盖 bundle 插入的目标行。

---

# 41. Profile 覆盖 QQ 配置示例

用户 profile：

```yaml
- id: channels-qq
  name: '@dsh/channel-qq'
  inject:
    - channels
    - credentials

  config:
    accountId: main

    appId: "YOUR_QQ_APP_ID"

    appSecretRef:
      QQBOT_APP_SECRET

    markdownSupport: false

    streaming:
      enabled: true
      throttleMs: 500

    dedup:
      enabled: true
      windowMs: 5000

    startupTimeoutMs: 15000
```

注意 Harness patch：

```text
覆盖目标行整个 config
```

不是深度 merge。

README 必须明确这一点。

---

# 42. Manifest

修改：

```text
packages/channel-qq/src/manifest.ts
```

上游：

```text
tencent-connect/qqbot-nodejs
```

记录：

```text
testedVersion
upstream repository
protocol mode
last verified date
```

例如：

```ts
export const manifest = {
  channel: 'qq',

  upstream: {
    package:
      '@tencent-connect/qqbot-nodejs',

    testedVersion:
      '1.0.4',
  },
}
```

---

# 43. Compatibility Governance

```text
Renovate
   ↓
Tencent SDK version PR
   ↓
QQ fixtures
   ↓
Adapter Contract tests
   ↓
Harness compatibility tests
   ↓
Bundle tests
   ↓
CI
   ↓
人工确认
```

禁止：

```text
"@tencent-connect/qqbot-nodejs": "latest"
```

进入正式 release。

---

# 44. QR Onboarding

Tencent OpenClaw 侧 QR onboarding 可以作为 V2 参考。

但不塞进：

```text
QQAdapter.start()
```

V1：

```text
AppID
+
AppSecret credential
```

即可。

V2 再做：

```text
dsh channels login qq
       ↓
Tencent connector / QR
       ↓
credential
       ↓
ctx.credentials.set()
```

这属于：

```text
Credential onboarding
```

不是 QQ Runtime Transport。

---

# 45. 最终执行任务顺序

---

## QQ-R0 — 冻结旧实现

不再给：

```text
qq-gateway-upstream
HttpQQUpstream
旧 WS Gateway
旧 QR auth
```

增加能力。

先保留现有 tests 作为迁移行为基线。

### 验收

```text
当前 QQ tests 全部可重复执行
旧行为基线明确
```

---

## QQ-R1 — Core Reply Target Extension

修改：

```text
packages/channel-core/src/adapter.ts
```

增加：

```ts
conversationType?
replyToMessageId?
raw?

resolveStreamingMode?()
```

### 验收

```text
Weixin
DingTalk
Lark
Telegram proof
Fake adapter
```

全部兼容。

---

## QQ-R2 — Harness ReplyContextStore

新增：

```text
packages/channel-harness/
src/reply-context-store.ts
```

实现：

```text
MessageId → Pending Context
Session + Turn → Active Context
```

### 必须新增监听

```text
agent/inbox/claimed
agent/inbox/discarded
session/event turn/end
```

### 验收

连续：

```text
msg_A
msg_B
```

必须：

```text
HarnessMessage_A → Turn_A → QQ msg_A
HarnessMessage_B → Turn_B → QQ msg_B
```

不能串线。

---

## QQ-R3 — 修 AgentManager Persistence 语义

删除：

```text
isPersistenceError()
resume regex fallback
```

改成：

```text
new binding
  → create

existing binding
  → get
  → resume
```

`resume` 真失败则 loudly fail。

### 验收

```text
不存在 binding
  → create

已有 binding + live Agent
  → get

已有 binding + cold session
  → resume

已有 binding + corruption
  → fail loudly

已有 binding + unsupported format
  → fail loudly

禁止偷偷 create 新 session
```

---

## QQ-R4 — `sessionPersistence` 正式依赖

修改：

```text
channel-harness plugin inject
bundle patch
tests
docs
```

目标：

```ts
inject = [
  'channels',
  'agents',
  'sessionPersistence',
]
```

### 验收

没有 SessionPersistence：

```text
channel-harness 保持 PENDING
```

不能启动半持久 Channel runtime。

---

## QQ-R5 — Credentials Seam

QQ Adapter：

```ts
inject = [
  'channels',
  'credentials',
]
```

Config：

```text
appSecret
   DELETE

appSecretRef
   ADD
```

### 验收

```text
credential 存在
  → QQ starts

credential 不存在
  → startup fails loudly

Secret 不出现在 dump config
```

---

## QQ-R6 — Tencent SDK Client

新增：

```text
sdk-client.ts
```

安装：

```text
@tencent-connect/qqbot-nodejs
```

Fake Client 可注入。

### 验收

Adapter tests：

```text
完全离线
```

---

## QQ-R7 — Lifecycle

重写：

```text
adapter.start()
adapter.stop()
```

删除自实现 receive/reconnect loop。

### 覆盖

```text
READY
RESUMED
ERROR
Abort
startup timeout
invalid credentials
stop
repeated stop
HMR dispose
```

---

## QQ-R8 — Inbound

输入改：

```text
QQBotInboundMessage
```

正式映射：

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

### 验收

Tencent SDK fixtures：

```text
→ ChannelEvent snapshot
```

---

## QQ-R9 — Outbound

实现：

```text
text
image
audio
video
file
```

### 验收

Fake SDK 调用参数：

```text
scope
targetId
msgId
media
```

全部正确。

---

## QQ-R10 — C2C Streaming

实现：

```text
QQStreamingReply
target-aware streaming
```

### 验收

Chunks：

```text
你
好
，
世
界
```

SDK update：

```text
你
你好
你好，
你好，世
你好，世界
```

---

## QQ-R11 — Group Buffered

Group：

```text
20 assistant chunks
```

最终：

```text
1 次普通 QQ send
```

禁止使用 C2C stream endpoint。

---

## QQ-R12 — Bundle / Profile 修复

修：

```text
packages/channels/cordis.patch.yml
apps/example/minimal-profile/
packages/channels/README.md
docs/release.md
```

移除：

```text
plugins:
  channels-qq:
```

旧示例模型。

### 验收

```bash
dsh plugin --profile qq-e2e add ./packages/channels

dsh --profile qq-e2e --dump-config
```

必须看到：

```text
channels-service
channels-harness
channels-qq
```

且 inject 正确。

---

## QQ-R13 — 删除旧 QQ Runtime

只有 QQ-R0 ~ QQ-R12 全绿后删除：

```text
qq-gateway-upstream.ts
transport.ts
旧 upstream.ts
旧 auth.ts
ws dependency
baseUrl config
gateway mode
reconnect config
QR gateway config
```

---

# 46. Harness ReplyContext 测试矩阵

| Case | 期望 |
|---|---|
| msg_A → followup | pendingByMessageId[A] |
| inbox claimed A turn=1 | active turn 1 → A |
| msg_B → followup | pendingByMessageId[B] |
| inbox claimed B turn=2 | active turn 2 → B |
| A discarded before claim | A pending 被清除 |
| turn 1 end | active turn 1 被清除 |
| rejected pre-step | 不错误绑定下一条消息 |
| rapid A/B arrival | 不依赖 FIFO turn/start |
| cancellation | 不泄漏 context |
| restart | transient ReplyContext 不错误恢复 |

---

# 47. QQ 测试矩阵

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
| C2C reply | 使用原 trigger QQ msgId |
| C2C streaming | StreamSession |
| Group output | Buffered |
| stream failure | cancel |
| turn/end | complete |
| READY | health ok |
| RESUMED | health ok |
| invalid credential | startup fail |
| missing credential | startup fail |
| stop | 无残留连接 |
| repeated stop | 幂等 |
| HMR | 旧 SDK connection 被关闭 |
| DSH restart | SessionBinding → resume |
| corrupt Harness session | loudly fail，不新建 |
| SDK version fixtures | compat pass |

---

# 48. Fake E2E

必须存在：

```text
FakeQQSdkClient
   ↓
QQ Adapter
   ↓
ChannelService
   ↓
channel-harness
   ↓
Fake / Real Harness Agent test runtime
   ↓
session/event
   ↓
ReplyRouter
   ↓
FakeQQSdkClient send
```

Fake E2E 必须覆盖：

```text
C2C
Group
streaming
restart binding
message→turn correlation
```

---

# 49. 真实 QQ E2E

离线测试全部通过仍不能标 QQ Done。

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

至少：

```text
1. C2C 普通消息
2. C2C streaming
3. 两条快速连续 C2C 消息
4. Group @ message
5. Group buffered reply
6. 图片
7. 文件
8. 网络断开恢复
9. DSH restart
10. restart 后继续同一 QQ conversation
```

---

# 50. Release Gate

必须：

```bash
pnpm build
pnpm typecheck
pnpm test
```

并且：

```text
Channel Core tests PASS
Harness Bridge tests PASS
ReplyContext tests PASS
QQ adapter tests PASS
QQ fixture tests PASS
Fake E2E PASS
Bundle tests PASS
Harness compatibility PASS
真实 QQ E2E PASS
GitHub Actions PASS
```

才允许发布 Breaking Minor。

---

# 51. README 用户安装体验

正式推荐：

```bash
dsh plugin \
  --profile default \
  add @dsh/channels
```

不要把：

```bash
dsh plugin add @dsh/channel-qq
```

描述为完整单包使用方式。

原因：

QQ Adapter 还依赖运行时已有：

```text
ctx.channels
ctx.credentials
```

而消息进入 Agent 还需要：

```text
channel-harness
ctx.agents
ctx.sessionPersistence
```

高级用户如要只启用 QQ，应：

```text
安装 @dsh/channels bundle
+
在 profile patch 禁用其他 adapters
```

而不是让用户手工拼依赖。

---

# 52. 只启用 QQ 的推荐方式

Bundle 仍安装完整能力：

```bash
dsh plugin \
  --profile qq \
  add @dsh/channels
```

然后 profile patch：

```yaml
- id: channels-weixin
  name: '@dsh/channel-weixin'
  disabled: true

- id: channels-dingtalk
  name: '@dsh/channel-dingtalk'
  disabled: true

- id: channels-lark
  name: '@dsh/channel-lark'
  disabled: true

- id: channels-qq
  name: '@dsh/channel-qq'
  inject:
    - channels
    - credentials

  config:
    accountId: main
    appId: "YOUR_QQ_APP_ID"
    appSecretRef: QQBOT_APP_SECRET

    streaming:
      enabled: true
      throttleMs: 500
```

---

# 53. 最终运行数据流

```text
                   Tencent QQ
                       │
                       ▼
            @tencent-connect/qqbot-nodejs
                       │
                       ▼
                 channel-qq
                       │
                       ▼
                 ctx.channels
                       │
                       ▼
               channel-harness
                       │
          ┌────────────┼─────────────┐
          │            │             │
          ▼            ▼             ▼
   BindingStore    ctx.agents    ReplyContextStore
          │            │             │
          │            ▼             │
          │       UserMessage        │
          │          id              │
          │            │             │
          │            └──────┐      │
          │                   ▼      │
          │          agent/inbox/claimed
          │                   │
          │                   ▼
          │             Message → Turn
          │                   │
          │                   ▼
          │             session/event
          │                   │
          │          assistant/chunk
          │                   │
          └──────────────┐    │
                         ▼    ▼
                     ReplyRouter
                         │
                  ┌──────┴──────┐
                  │             │
                  ▼             ▼
             C2C native       Group
              stream          buffer
                  │             │
                  └──────┬──────┘
                         ▼
                    channel-qq
                         │
                         ▼
                    Tencent QQ
```

---

# 54. Definition of Done

只有下面全部成立，QQ 才可以标记为完成：

```text
✅ @dsh/channel-qq 保留稳定 Channel Contract

✅ Runtime 使用 Tencent 官方
   @tencent-connect/qqbot-nodejs

✅ 不依赖 OpenClaw Runtime

✅ @dsh/channel-qq 不直接依赖 ws

✅ 不自己实现 Token

✅ 不自己实现 Gateway heartbeat

✅ 不自己实现 RESUME

✅ 不自己实现 reconnect

✅ 不维护第二套 QQ OpenAPI

✅ C2C / Group 独立 Session

✅ Conversation → Harness SessionBinding 持久化

✅ Harness Session 使用官方 SessionPersistence

✅ 不通过错误字符串判断 resume/create

✅ 历史 session 损坏时 loudly fail

✅ QQ Secret 使用 ctx.credentials

✅ Secret 不直接进入 profile config

✅ Harness UserMessage ID
   → agent/inbox/claimed
   → Turn
   精确绑定

✅ 不在 turn/start FIFO 猜测 ReplyContext

✅ discarded message 清理 pending ReplyContext

✅ turn/end 清理 active ReplyContext

✅ trigger QQ messageId
   正确绑定到当前 Harness Turn

✅ C2C native streaming

✅ Group buffered

✅ Text / Image / Audio / Video / File 可映射

✅ Cordis dispose 正确停止 Tencent SDK

✅ Bundle 使用 dsh.bundle patch

✅ minimal profile 使用官方 profile/patch 模型

✅ Tencent SDK 版本通过 Renovate + compat CI 管理

✅ Fake E2E 成功

✅ 真实 QQ → Harness → QQ E2E 成功

✅ GitHub Actions 成功
```

---

# 55. 最终执行原则

> **平台协议归平台 SDK，Channel Contract 归 `@dsh/channel-core`，Agent/Session 生命周期归 DeepSeek Harness。**

具体来说：

```text
Tencent SDK
负责：
  QQ Token
  WebSocket
  heartbeat
  RESUME
  reconnect
  QQ OpenAPI
  media
  streaming protocol

@dsh/channel-qq
负责：
  QQ SDK Event
      ↔
  Channel Contract

@dsh/channel-harness
负责：
  Channel Conversation
      ↔
  Harness Session

  Channel Message
      ↔
  Harness UserMessage

  Harness Message ID
      ↔
  Harness Turn
      ↔
  Platform Reply Context

DeepSeek Harness
负责：
  Agent lifecycle
  Session lifecycle
  Inbox semantics
  Session persistence
  session/event
```

禁止在任意一层重复实现上一层已经正式拥有的职责。

---

# 56. 官方核验依据

DeepSeek Harness 官方开发资料：

```text
https://deepseek-harness.github.io/deepseek-harness/reference/

https://github.com/deepseek-ai/deepseek-harness
```

重点核验模块：

```text
docs/user/develop/basic/publish.zh.md
docs/user/develop/basic/config.zh.md
docs/user/develop/framework/events.zh.md
docs/cordis-tutorial/02-lifecycle-and-effects.zh.md
docs/cordis-tutorial/03-services.md

packages/core/agent/README.zh.md
packages/core/agent/src/index.ts
packages/core/agent/src/runtime-types.ts

packages/core/session/src/index.ts
docs/subsystems/session.zh.md

packages/session/session-persistence/README.md
packages/credentials/credentials/README.zh.md

packages/bundle/base/cordis.patch.yml
```

Tencent QQ 官方上游：

```text
https://github.com/tencent-connect/openclaw-qqbot
```

运行时目标：

```text
@tencent-connect/qqbot-nodejs
```

---

# 57. 本次 v1.1 相对 v1.0 的 Breaking 修正摘要

```text
v1.0:
turn/start FIFO ReplyContext

v1.1:
MessageId
  → agent/inbox/claimed
  → Turn
```

```text
v1.0:
resume error regex
  → create fallback

v1.1:
new binding
  → create

existing binding
  → get/resume

resume failure
  → loudly fail
```

```text
v1.0:
appSecret in channel config

v1.1:
appSecretRef
  → ctx.credentials.resolve()
```

```text
v1.0:
channel-harness inject:
  channels
  agents

v1.1:
channel-harness inject:
  channels
  agents
  sessionPersistence
```

```text
v1.0:
minimal profile uses
plugins:
  ...

v1.1:
official DSH
bundle/profile patch model
```

---

**本文件是 QQ 官方 SDK 重构的最终执行基线。后续实现与 Code Review 应以 v1.1 为准，v1.0 不再作为验收依据。**
