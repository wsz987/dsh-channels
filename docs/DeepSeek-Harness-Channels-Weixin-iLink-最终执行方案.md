# DeepSeek Harness Channels — Weixin iLink 正确接入重构最终执行方案

> 最终版  
> 核验日期：2026-08-14  
> 适用仓库：`wsz987/dsh-channels`  
> 上游协议参考：`Tencent/openclaw-weixin`  
> Harness 规范基线：`deepseek-ai/deepseek-harness` 官方 Reference / Cordis 生命周期 / Agent / Session 契约

---

## 0. 最终结论

本次不删除整个 `@dsh/channel-weixin`，也不改变 `dsh-channels` 的总体 Channel 架构。

最终决策：

> **保留 `ChannelAdapter → ChannelService → channel-harness → ctx.agents → session/event → ReplyRouter` 这一 Harness-native 主链路；先修正 `channel-harness` 中与最新 Harness 官方契约不完全一致的部分，再删除 Weixin 当前自定义 HTTP Gateway 协议，重做为 Tencent Weixin iLink Direct Client。**

整体策略：

```text
先修 Harness Bridge 合规问题
        ↓
保留 Channel Contract
        ↓
彻底替换 Weixin 协议内核
        ↓
Tencent iLink Direct
        ↓
真实微信 Live E2E
```

不采用：

```text
DeepSeek Harness
    ↓
OpenClaw Runtime
    ↓
@tencent-weixin/openclaw-weixin
```

也不采用：

```text
DeepSeek Harness
    ↓
@dsh/channel-weixin
    ↓
localhost:9000 自建 Weixin Gateway
    ↓
微信
```

最终采用：

```text
Weixin
  ↓
Tencent iLink HTTP / CDN
  ↓
@dsh/channel-weixin
  ↓
ChannelService
  ↓
channel-harness
  ↓
ctx.agents
  ↓
Harness Agent / Session
  ↓
session/event
  ↓
ReplyRouter
  ↓
@dsh/channel-weixin
  ↓
Tencent iLink
  ↓
Weixin
```

---

# 1. 为什么需要同时修 Harness Bridge

原 Weixin 重构方向是正确的，但在对照 DeepSeek Harness 官方开发文档后，发现 `channel-harness` 还存在几处必须先收口的问题。

如果只重做 Weixin 协议而不修这些问题，会出现：

- `agentId` 与 Harness 真正的 Agent identity 混淆；
- `create()` 和 `resume()` 使用不同模型配置；
- persistence 依赖靠异常字符串探测；
- Cordis unload 时 `session/event` listener 与 drain disposer 存在并发清理 race；
- Adapter `start()` 失败时可能残留已注册但未成功启动的 Adapter；
- Channel 对外声明多模态能力，但 Harness 实际只收到文本占位符。

因此最终实施顺序调整为：

```text
H0 — Harness Compliance Baseline
 ↓
WX0 — 删除错误 Gateway Contract
 ↓
WX1 — iLink Core Client
 ↓
WX2 — QR Auth + Credential
 ↓
WX3 — Runtime Receive + Cursor + ContextToken
 ↓
WX4 — Text Send + Harness Live E2E
 ↓
WX5 — Media / Attachment
 ↓
WX6 — Typing / Progress / Advanced
 ↓
WX7 — Compatibility / CI / Release Gate
```

---

# 2. 必须保持不变的架构边界

以下部分经过 Harness 官方 Reference 核验，方向正确，应继续保留。

## 2.1 `ChannelService` 继续作为 Cordis Service

保持：

```ts
export class ChannelService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'channels')
  }
}
```

并继续：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    channels: ChannelService
  }
}
```

职责：

```text
ChannelService
├─ adapter registry
├─ adapter lookup
├─ ChannelEvent dispatch
└─ canonical conversation key
```

不要让各平台 Adapter 直接调用 Harness Agent API。

---

## 2.2 Adapter 不得直接访问 `ctx.agents`

继续保持：

```text
WeixinAdapter
QQAdapter
DingTalkAdapter
LarkAdapter
       ↓
ChannelAdapterContext
       ↓
ctx.channels
```

禁止：

```text
WeixinAdapter
   ↓
ctx.agents
```

Harness-specific 行为只允许存在于：

```text
@dsh/channel-harness
```

这样才能保证：

```text
平台协议
≠
Harness Agent Runtime
```

---

## 2.3 入站继续使用 `agent.followup()`

正确链路：

```text
ChannelEvent.message.received
 ↓
SessionBinding
 ↓
resolve/create/resume Agent
 ↓
createUserMessage(...)
 ↓
agent.followup(message)
```

不绕过 Agent Inbox，不直接写 Session Log。

---

## 2.4 出站继续消费 `session/event`

继续使用：

```ts
ctx.on('session/event', (session, event) => {
  // turn/start
  // assistant/chunk
  // assistant/message
  // turn/end
})
```

原因：

```text
session/event
= durable / replayable facts

agent/*
= live coordination / control / interception
```

ReplyRouter 继续以：

```text
assistant/chunk
assistant/message
turn/end
```

作为回复投影来源。

---

# 3. H0 — Harness Compliance Baseline

H0 必须在 Weixin iLink 重构前完成。

---

## H0.1 删除错误的 `agentId` 抽象

### 当前问题

目前 Channel Routing 使用：

```ts
defaultAgentId: string
```

以及：

```ts
resolve(...) => agentId
```

但 Harness 当前官方 Agent 契约中：

```ts
interface Agent {
  readonly id: SessionId
}
```

也就是说：

```text
Agent identity = Session identity = SessionId
```

并不存在一个与 `SessionId` 平级的运行时 `agentId`。

当前代码甚至可能把：

```text
agentId
```

隐式当成：

```text
model
```

这是需要删除的语义。

---

## H0.2 新增 `AgentRouteSpec`

改为：

```ts
export interface AgentRouteSpec {
  /** Harness Agent preset，而不是 Agent identity。 */
  preset?: string

  /** 可选模型路由。 */
  provider?: string
  model?: string

  /** 可选输出限制。 */
  maxTokens?: number
}
```

Channel Routing 的职责变成：

```text
conversation
 ↓
AgentRouteSpec
 ├─ preset
 ├─ provider
 ├─ model
 └─ maxTokens
```

而真正身份始终为：

```text
SessionBinding.sessionId
```

---

## H0.3 SessionBinding 调整

建议：

```ts
export interface SessionBinding {
  channelId: string
  accountId: string
  conversationId: string
  threadId?: string

  /** 唯一 Agent / Session runtime identity。 */
  sessionId: string

  /** 用于该会话创建/恢复 Agent 的路由快照。 */
  route: AgentRouteSpec

  createdAt: number
  updatedAt: number
}
```

删除：

```ts
agentId
```

如果需要兼容已有 binding 文件：

```text
binding schema version
 ↓
v1 agentId
 ↓ migration
v2 route.preset / route.model
```

必须提供一次性 migration，而不是静默解释旧字段。

---

## H0.4 创建 Agent 的正确映射

创建：

```ts
ctx.agents.create({
  sessionId: SessionId(binding.sessionId),

  meta: binding.route.preset
    ? {
        agentPreset: binding.route.preset,
      }
    : undefined,

  agentOptions: {
    provider: binding.route.provider,
    model: binding.route.model,
    maxTokens: binding.route.maxTokens,
  },
})
```

空字段在构造对象前过滤。

不要：

```ts
model = agentId
```

---

## H0.5 `resume()` 必须与 `create()` 使用相同 AgentOptions

当前风险：

```text
首次消息
→ create(provider/model=A)

重启
→ resume()
→ provider/model 丢失
```

改为：

```ts
ctx.agents.resume({
  resumeSessionId: SessionId(binding.sessionId),

  agentOptions: {
    provider: binding.route.provider,
    model: binding.route.model,
    maxTokens: binding.route.maxTokens,
  },
})
```

`create()` 和 `resume()` 的 route semantics 必须完全一致。

---

## H0.6 persistence 不能靠错误字符串探测

删除：

```ts
/persistence|persist/i
```

这种判断。

正确策略：

### Optional capability

`channel-harness` 的 required inject 仍然只要求：

```ts
export const inject = [
  'channels',
  'agents',
]
```

在使用点查询：

```ts
const persistence = ctx.get('sessionPersistence')
```

Harness 官方 Cordis 语义允许 optional service 在 use-site 查询。

AgentGateway 增加明确能力：

```ts
interface AgentGateway {
  get(sessionId: string): GatewayAgent | undefined

  create(
    sessionId: string,
    route: AgentRouteSpec,
  ): Promise<GatewayAgentHandle>

  resume(
    sessionId: string,
    route: AgentRouteSpec,
  ): Promise<GatewayAgentHandle>

  canResume(): boolean
}
```

判断：

```text
live Agent exists?
 ├─ yes → borrow get()
 │
 └─ no
     ↓
sessionPersistence available?
 ├─ no → create()
 │
 └─ yes → resume()
```

如果 `resume()` 明确确认“该 Session 不存在”，才能 fallback `create()`。

禁止把：

```text
corruption
unsupported format
permission
backend failure
database failure
```

错误误判成“没有 persistence”。

如果当前 Harness 版本没有稳定 typed NotFound error，则增加 `PersistenceProbe`：

```ts
interface PersistenceProbe {
  exists(sessionId: SessionId): Promise<boolean>
}
```

通过官方 persistence service 的可查询能力或受控 inspection/list 接口实现，不通过 `error.message` regex。

---

## H0.7 AgentHandle ownership 保持现状

继续遵循：

```text
ctx.agents.get()
→ borrowed
→ never dispose

ctx.agents.create()
ctx.agents.resume()
→ owned AgentHandle
→ bridge dispose 时必须 dispose
```

`AgentManager.owned` 保留。

---

# 4. H0 — Cordis Lifecycle 修正

这是 H0 中另一个 P0。

---

## 4.1 当前 race

当前 ReplyRouter：

```ts
ctx.on('session/event', ...)
```

自身已经被 Cordis 注册为 Effect。

同时外层：

```ts
ctx.effect(() => {
  const lifecycle = startBridge(...)
  return () => lifecycle.dispose()
})
```

也是另一个 Effect。

Cordis unload 时：

```text
多个 async disposer
→ 可以并发运行
```

因此不能保证：

```text
drain agent
期间
session/event listener 一定仍然存在
```

---

## 4.2 最终原则

不要让“最终回复不丢失”依赖：

```text
unload 时 session/event listener 必须仍然 attached
```

最终正确性必须来自：

```text
Session durable log
```

---

## 4.3 ReplyRouter 增加 reconcile

新增：

```ts
interface ReplyReconciler {
  reconcile(session: Session): Promise<void>
}
```

或者直接：

```ts
ReplyRouter.reconcileSession(session)
```

逻辑：

```text
whenIdle()
 ↓
读取 Session 当前 durable events
 ↓
找到最后一个 active/unfinished turn
 ↓
重建 assistant text
 ↓
对比 ReplyRouter 已发送长度
 ↓
补齐最终文本
 ↓
finish
```

因此 unload：

```text
1. stop inbound
2. await active Agent.whenIdle()
3. reconcile replies from Session log
4. flush/finalize adapters
5. dispose owned AgentHandles
6. clear ReplyRouter timers/state
```

即使 `ctx.on('session/event')` 已被 Cordis 清理，也不掉最终回复。

---

## 4.4 不复制 Harness history

reconcile 只能：

```text
读取 Session Event
→ 投影回复文本
```

禁止在 `channel-harness` 维护第二份“Agent transcript truth”。

Session Log 仍是唯一事实源。

---

# 5. H0 — Adapter mount 必须具备事务回滚

所有平台统一。

当前模式：

```ts
register(adapter)
 ↓
await adapter.start()
```

如果 `start()` 抛错，必须立即 rollback。

新增公共 helper：

```ts
export function mountChannelAdapter(
  ctx: Context,
  adapter: ChannelAdapter,
  createContext: (...) => ChannelAdapterContext,
): void
```

推荐语义：

```ts
ctx.effect(async () => {
  const abort = new AbortController()
  const unregister = ctx.channels.register(adapter)

  try {
    await adapter.start(
      createContext(abort.signal),
    )
  } catch (error) {
    abort.abort()

    try {
      await adapter.stop()
    } catch {
      // rollback best effort
    }

    unregister()
    throw error
  }

  return async () => {
    abort.abort()

    try {
      await adapter.stop()
    } finally {
      unregister()
    }
  }
})
```

QQ / Weixin / DingTalk / Lark / Telegram 都复用。

验收：

```text
Adapter.start() throw
 ↓
registry 中不存在残留 adapter
 ↓
网络资源全部释放
```

---

# 6. H0 — 多模态能力声明修正

当前 Channel Contract 可以表示：

```text
image
audio
video
file
```

但当前 `channel-harness` 会降级为：

```text
[image]
[audio]
[file]
[video]
```

因此：

> 在 Harness attachment 真正打通前，不应把“平台能收媒体”解释成“Agent 能理解该媒体”。

建议把能力分成两层。

```ts
interface ChannelCapabilities {
  inbound: {
    text: boolean
    image: boolean
    audio: boolean
    file: boolean
    video: boolean
  }

  outbound: {
    text: boolean
    image: boolean
    audio: boolean
    file: boolean
    video: boolean
  }

  harnessProjection: {
    text: boolean
    attachment: boolean
  }

  streaming: 'native' | 'edit' | 'buffered'
}
```

如果暂时不想改公共 Contract，则至少文档与测试中明确：

```text
image=true
= Adapter 可接收/发送图片

≠
Harness model 已拿到真正 image attachment
```

WX5 时再完成真实 attachment 投影。

---

# 7. Weixin 重构决策

完成 H0 后开始微信协议重构。

保留：

```text
@dsh/channel-weixin package
ChannelAdapter Contract
ChannelService integration
ChannelEvent
InboundProcessor
Outbound Channel abstraction
Health abstraction
Contract tests
Cordis plugin entry
```

重做：

```text
Weixin upstream
QR auth
credential persistence
getUpdates
sync cursor
context_token
mapper
sendmessage
media CDN
typing
notify lifecycle
protocol fixtures
live tests
```

---

# 8. 为什么不能直接依赖 Tencent OpenClaw 插件

不要：

```bash
pnpm add @tencent-weixin/openclaw-weixin
```

然后把其 OpenClaw plugin 直接挂进 DSH。

因为它的 package/runtime surface 面向：

```text
openclaw/plugin-sdk
```

会产生：

```text
DeepSeek Harness
 ↓
OpenClaw Runtime
 ↓
Weixin Plugin
```

错误依赖。

正确：

```text
Tencent/openclaw-weixin
 ↓
协议参考 / 可依法复用的 iLink 实现片段
 ↓
@dsh/channel-weixin/src/ilink/*
 ↓
ChannelAdapter
```

---

# 9. 最终目标架构

```text
                     Weixin
                        │
                        │ iLink API
                        ▼
          https://ilinkai.weixin.qq.com
                        │
             ┌──────────┴──────────┐
             │                     │
          QR Auth               getUpdates
             │                     │
             ▼                     ▼
       ┌───────────┐         ┌───────────┐
       │ ILinkAuth │         │ILinkClient│
       └─────┬─────┘         └─────┬─────┘
             │                     │
             └──────────┬──────────┘
                        ▼
       ┌─────────────────────────────┐
       │     @dsh/channel-weixin     │
       │                             │
       │ AccountCredentialStore      │
       │ SyncCursorStore             │
       │ ContextTokenStore           │
       │ InboundMapper               │
       │ OutboundSender              │
       │ Media/CDN                   │
       │ Typing                      │
       │ Adapter                     │
       └──────────────┬──────────────┘
                      │
                      ▼
               ChannelService
                      │
                      ▼
               channel-harness
                      │
                      ▼
                SessionBinding
                      │
                      ▼
                 ctx.agents
                      │
                      ▼
                 Harness Agent
                      │
                      ▼
                session/event
                      │
                      ▼
                 ReplyRouter
                      │
                      ▼
               WeixinAdapter
```

不再存在：

```text
localhost:9000
self-hosted Weixin Gateway
/qrcode
/auth/status
/messages/long-poll
/message/send
```

---

# 10. Weixin 新目录结构

```text
packages/channel-weixin/
├─ src/
│  ├─ index.ts
│  ├─ adapter.ts
│  ├─ config.ts
│  ├─ manifest.ts
│  │
│  ├─ ilink/
│  │  ├─ constants.ts
│  │  ├─ types.ts
│  │  ├─ headers.ts
│  │  ├─ base-info.ts
│  │  ├─ client.ts
│  │  └─ errors.ts
│  │
│  ├─ auth/
│  │  ├─ login.ts
│  │  └─ account-store.ts
│  │
│  ├─ storage/
│  │  ├─ sync-cursor.ts
│  │  └─ context-token.ts
│  │
│  ├─ messaging/
│  │  ├─ monitor.ts
│  │  ├─ mapper.ts
│  │  ├─ dedup.ts
│  │  ├─ send.ts
│  │  └─ typing.ts
│  │
│  └─ media/
│     ├─ download.ts
│     ├─ decrypt.ts
│     ├─ encrypt.ts
│     ├─ upload.ts
│     └─ send-media.ts
│
└─ test/
```

不要复制 OpenClaw runtime glue。

只实现：

```text
iLink protocol
auth semantics
cursor semantics
context_token semantics
CDN semantics
```

---

# 11. iLink Client

新增：

```ts
class ILinkClient
```

配置：

```ts
interface ILinkClientOptions {
  baseUrl: string
  cdnBaseUrl: string

  token?: string

  timeoutMs: number
  longPollTimeoutMs: number

  botAgent?: string
}
```

默认：

```ts
const DEFAULT_BASE_URL =
  'https://ilinkai.weixin.qq.com'

const DEFAULT_CDN_BASE_URL =
  'https://novac2c.cdn.weixin.qq.com/c2c'
```

`baseUrl` 必须允许 QR redirect 后按账号更新。

---

# 12. HTTP Headers / BaseInfo

统一实现：

```ts
buildHeaders()
buildBaseInfo()
```

需要支持：

```http
Content-Type: application/json
AuthorizationType: ilink_bot_token
Authorization: Bearer <bot_token>
X-WECHAT-UIN: <random uint32 -> decimal -> base64>
iLink-App-Id: bot
iLink-App-ClientVersion: <encoded version>
```

以及协议需要时：

```text
SKRouteTag
```

禁止每个 endpoint 自己重复拼 header。

---

# 13. QR 登录

## 13.1 获取二维码

```http
POST /ilink/bot/get_bot_qrcode?bot_type=3
```

Body：

```json
{
  "local_token_list": []
}
```

接收：

```json
{
  "qrcode": "...",
  "qrcode_img_content": "..."
}
```

映射：

```ts
beginAuth()
```

返回 Channel Contract：

```ts
{
  id,
  qrUrl,
  expiresAt,
}
```

---

## 13.2 QR 状态

```http
GET /ilink/bot/get_qrcode_status?qrcode=...
```

内部状态必须完整支持：

```text
wait
scaned
confirmed
expired
need_verifycode
verify_code_blocked
scaned_but_redirect
binded_redirect
```

Channel Contract 可以归一为较少状态，但 upstream state machine 不得丢信息。

---

## 13.3 Redirect

当：

```text
scaned_but_redirect
```

读取：

```text
redirect_host
```

后续：

```text
QR status
getUpdates
sendMessage
```

都必须使用该账号最终确认的 baseUrl。

不要继续强制默认 host。

---

## 13.4 Verify code

当：

```text
need_verifycode
```

Auth API 必须允许调用方提交：

```text
verify_code
```

ChannelService / CLI 后续增加：

```ts
submitAuthChallenge(...)
```

不要把验证码流程塞进 Adapter 内部 stdin。

---

# 14. Credential 模型

confirmed 后保存：

```ts
interface WeixinAccountCredential {
  token: string

  ilinkBotId: string
  userId?: string

  baseUrl: string

  savedAt: string
}
```

本地：

```text
accountId = main
```

仍只是 DSH 账号别名。

远端 identity：

```text
remoteBotId = ilinkBotId
```

两者分离。

---

# 15. Secret / Storage 边界

生产环境不再给 Weixin Adapter 固定使用：

```ts
new MemorySecretStore()
new MemoryStorage()
```

最终应由 Channel capability provider 提供真实持久化边界。

建议：

```text
ChannelRuntimeResources
├─ secrets
└─ storage
```

注入 Adapter。

Credential：

```text
SecretStore
```

Cursor / ContextToken / 非敏感状态：

```text
ChannelStorage
```

推荐目录仅作为 File provider 的实现细节：

```text
data/channels/weixin/
├─ accounts/
├─ sync/
└─ context/
```

Token：

- 不进入 Cordis YAML；
- 不进入日志；
- 不进入 `ChannelEvent.raw`；
- 不进入异常 message；
- 不进入 telemetry attributes；
- dump config 时不得显示。

---

# 16. Adapter start

```text
start
 ↓
load credential
 ↓
credential missing?
 ├─ yes → unauthenticated
 │
 └─ no
     ↓
     restore sync cursor
     ↓
     restore context token
     ↓
     notifyStart (best effort)
     ↓
     start getUpdates monitor
```

`start()` 必须支持：

```text
AbortSignal
```

并且由前述 `mountChannelAdapter()` 保证 start failure rollback。

---

# 17. getUpdates

调用：

```http
POST /ilink/bot/getupdates
```

Body：

```json
{
  "get_updates_buf": "...",
  "base_info": {
    "channel_version": "...",
    "bot_agent": "DeepSeekHarness/..."
  }
}
```

响应：

```json
{
  "ret": 0,
  "msgs": [],
  "get_updates_buf": "...",
  "longpolling_timeout_ms": 35000
}
```

下一轮 long poll timeout 允许由服务端动态更新。

---

# 18. Sync Cursor

新增：

```ts
SyncCursorStore
```

流程：

```text
load cursor
 ↓
getUpdates(cursor)
 ↓
receive messages + next cursor
 ↓
处理并确认本轮状态
 ↓
atomic persist next cursor
 ↓
next getUpdates
```

必须定义清楚：

> Cursor 在消息完成进入 Channel inbound pipeline 后才推进，避免 crash 后消息永久丢失。

接受的副作用是：

```text
crash before cursor commit
→ 同一条消息可能再次拉到
```

由 Dedup 层处理。

---

# 19. Dedup

优先：

```text
message_id
```

fallback：

```text
seq
```

最后：

```text
stable hash
```

禁止主要依据：

```text
sender + content
```

否则：

```text
你好
你好
```

会误去重。

Dedup state 至少覆盖 cursor crash replay window。

---

# 20. ContextToken

这是 Weixin 正确回复的核心状态。

收到：

```text
from_user_id
context_token
```

保存：

```text
accountId + peerId
→ context_token
```

流程：

```text
getUpdates
 ↓
ContextTokenStore.set(peer)
 ↓
ChannelEvent.message.received
 ↓
Harness
 ↓
session/event
 ↓
ReplyRouter
 ↓
adapter.send(peer)
 ↓
ContextTokenStore.get(peer)
 ↓
sendmessage(context_token)
```

`channel-harness` 完全不认识 `context_token`。

---

# 21. Inbound Mapper

真实输入：

```ts
WeixinMessage
```

主要映射：

```text
message_id       → message.id
from_user_id     → sender.id
from_user_id     → conversation.id
create_time_ms   → createdAt
item_list        → MessagePart[]
```

当前微信按：

```text
conversation.type = dm
```

实现。

---

# 22. Message Item

## TEXT

```text
TEXT
 ↓
MessagePart.text
```

## IMAGE

```text
CDN media
 ↓
download
 ↓
decrypt
 ↓
Channel attachment/media representation
```

## VOICE

优先保留：

```text
voice transcription
+
audio attachment（如果可获得）
```

## FILE

```text
CDN file
 ↓
download/decrypt
 ↓
attachment
```

## VIDEO

同理。

WX3/WX4 阶段只保证 TEXT。

Media 到 WX5 再逐项打开能力。

---

# 23. Text send

调用：

```http
POST /ilink/bot/sendmessage
```

构造真实 iLink payload，至少包含：

```text
to_user_id
client_id
message_type
message_state
item_list
context_token
run_id
```

`client_id`：

```text
每次 outbound message 唯一
```

`run_id`：

```text
同一 Harness turn / reply scope 可复用同一 run correlation id
```

不要让 ReplyRouter 直接生成微信协议字段。

由 WeixinAdapter 内部负责。

---

# 24. Streaming

Weixin 第一阶段仍然声明：

```text
streaming = buffered
```

Harness：

```text
assistant/chunk
 ↓
ReplyRouter accumulate
 ↓
turn/end
 ↓
WeixinAdapter.send(final text)
```

不在 WX4 前引入：

```text
GENERATING
FINISH
progress update
```

避免同时调试 Harness stream 与微信 progress semantics。

---

# 25. Typing

WX6 增加：

```http
POST /ilink/bot/getconfig
POST /ilink/bot/sendtyping
```

流程：

```text
Agent begins turn
 ↓
typing = active

turn/end / error / cancel
 ↓
typing = stopped
```

Typing 是：

```text
best effort
```

不得导致主消息失败。

---

# 26. Notify Lifecycle

start：

```text
notifystart
```

stop：

```text
abort monitor
 ↓
notifystop
```

两个都：

```text
best effort
```

主 teardown 不因 notify endpoint 失败而卡死。

---

# 27. Media / CDN

WX5 才启用。

Outbound：

```text
source file
 ↓
MD5 / metadata
 ↓
AES-128-ECB encrypt
 ↓
get upload URL / upload param
 ↓
PUT encrypted bytes
 ↓
CDNMedia
 ↓
sendmessage
```

Inbound：

```text
CDNMedia
 ↓
encrypted query / aes key
 ↓
download ciphertext
 ↓
AES decrypt
 ↓
temporary / managed attachment
 ↓
Harness attachment projection
```

---

# 28. Harness Attachment

WX5 不能只做到：

```text
微信图片
→ [image]
```

而应完成：

```text
微信图片
 ↓
Weixin CDN download/decrypt
 ↓
Channel media
 ↓
channel-harness
 ↓
Harness Attachment / supported LLM content block
 ↓
Agent
```

只有完成这一链路后，才能在用户文档中声明：

```text
Agent can see images/files
```

---

# 29. Weixin Config

删除：

```yaml
baseUrl: http://127.0.0.1:9000
```

建议：

```yaml
channels-weixin:
  enabled: true

  accountId: main

  ilink:
    baseUrl: https://ilinkai.weixin.qq.com
    cdnBaseUrl: https://novac2c.cdn.weixin.qq.com/c2c

  network:
    timeoutMs: 15000
    longPollTimeoutMs: 35000

  reconnect:
    enabled: true
    baseDelayMs: 2000
    maxDelayMs: 30000
```

账号 credential 不写入 YAML。

---

# 30. channel-harness Config 最终建议

旧：

```yaml
defaultAgentId: default
```

删除。

改成：

```yaml
agent:
  default:
    preset: default
    provider: deepseek
    model: deepseek-chat

routing:
  overrides:
    channel: {}
    account: {}
    conversation: {}
```

override value：

```yaml
routing:
  overrides:
    conversation:
      weixin:main:user-123:
        preset: coding
        provider: deepseek
        model: deepseek-chat
```

配置应最终解析为：

```ts
AgentRouteSpec
```

---

# 31. 登录 UX

目标：

```bash
dsh channels login weixin
```

输出：

```text
正在连接微信...

[二维码]

请使用微信扫码确认。

✓ 已扫码
✓ 已确认
✓ Credential 已保存
✓ Weixin monitor 已启动
```

如果出现验证码：

```text
需要手机确认验证码：123456
```

由 CLI 调用：

```ts
ctx.channels.submitAuthChallenge(...)
```

不要要求用户：

```text
启动 9000 端口
安装 Gateway
配置 Gateway URL
```

---

# 32. 文件迁移矩阵

## channel-harness

| 文件 | 动作 |
|---|---|
| `agent-router.ts` | 重写为 `AgentRouteSpec` |
| `session-router.ts` | 删除 binding `agentId`，加入 route snapshot |
| `binding-store.ts` | 增加 schema version + migration |
| `agent-manager.ts` | create/resume 都接收 route；删除 regex persistence detection |
| `bridge.ts` | 使用 `binding.route` |
| `config.ts` | 删除 `defaultAgentId`，改 default route |
| `reply-router.ts` | 增加 durable reconcile |
| `lifecycle.ts` | 不再依赖 unload 期间 listener 存活 |
| `plugin.ts` | required inject 维持 `channels`,`agents` |
| tests | 更新 Agent identity / persistence / unload regression |

## channel-core

| 文件 | 动作 |
|---|---|
| Adapter mount helper | 新增 |
| ChannelStorage / SecretStore | 确认可被生产 provider 注入 |
| capabilities | 明确平台媒体 vs Harness attachment 语义 |

## channel-weixin

| 文件 | 动作 |
|---|---|
| `adapter.ts` | 保留外部职责，换 iLink client |
| `index.ts` | 保留 plugin entry，改用公共 mount helper |
| `config.ts` | 重写 |
| `manifest.ts` | 改 Tencent upstream |
| `transport.ts` | 删除旧 contract / 重写基础 fetch |
| `upstream.ts` | 完全重写为 iLink |
| `auth.ts` | 完全重写 |
| `mapper.ts` | 完全重写 |
| `inbound.ts` | 保留框架，更新输入模型 |
| `outbound.ts` | 保留 Channel API，内部重写 |
| fixtures | 全部重录 |
| contract tests | 保留并升级 |

---

# 33. 里程碑

# H0 — Harness Compliance

实现：

```text
AgentRouteSpec
SessionId single identity
binding migration
create/resume route parity
optional persistence capability
remove error regex
ReplyRouter durable reconcile
transactional adapter mount
capability semantics
```

验收：

- [ ] `agentId` 不再作为 Harness runtime identity；
- [ ] 没有 `model ?? agentId`；
- [ ] create/resume 使用相同 `AgentRouteSpec`；
- [ ] persistence unavailable 时不调用 resume；
- [ ] persistence backend error 不会错误 fallback create；
- [ ] unload 时即使 `session/event` listener 先卸载，最终回复仍不丢；
- [ ] Adapter.start() 失败不会残留 registry entry；
- [ ] Harness compatibility tests 全绿。

---

# WX0 — 删除错误 Gateway Contract

删除：

```text
/qrcode
/auth/status
/messages/long-poll
/message/send
localhost:9000
self-hosted Weixin Gateway manifest
```

验收：

- [ ] repo 中不存在旧 endpoint；
- [ ] README 不再要求 Gateway；
- [ ] manifest 指向 Tencent iLink reference。

---

# WX1 — iLink Core

实现：

```text
types
constants
headers
base_info
fetch transport
error normalization
getupdates
sendmessage
getconfig
sendtyping
notifystart
notifystop
```

验收：

- [ ] protocol fixtures 全绿；
- [ ] AbortSignal 可取消 long poll；
- [ ] token 不出现在日志。

---

# WX2 — QR Login

实现：

```text
get_bot_qrcode
get_qrcode_status
scan
confirm
expire
redirect
verify code
already bound
credential store
```

验收：

- [ ] 真微信可以扫描二维码；
- [ ] confirmed 后 token/baseUrl/ilinkBotId 正确保存；
- [ ] redirect host 生效；
- [ ] restart 不要求重新扫码。

---

# WX3 — Receive Runtime

实现：

```text
getUpdates loop
dynamic long-poll timeout
retry/backoff
cursor
dedup
context_token
text mapper
connection health
```

验收：

```text
微信发送文字
→ ChannelEvent.message.received
```

并：

- [ ] crash/restart 不永久丢消息；
- [ ] duplicate 不重复触发 Agent。

---

# WX4 — Text Send + Harness E2E

实现：

```text
Weixin
 ↓
ChannelService
 ↓
channel-harness
 ↓
SessionBinding
 ↓
ctx.agents
 ↓
Agent.followup
 ↓
session/event
 ↓
ReplyRouter
 ↓
WeixinAdapter
 ↓
sendmessage
```

验收必须是真实 live：

```text
微信用户：你好
 ↓
Harness Agent
 ↓
微信收到真实 AI 回复
```

另外：

- [ ] restart 后继续同一 Session；
- [ ] route preset/model 不漂移；
- [ ] turn/end final text 完整；
- [ ] unload 不丢尾部回复。

---

# WX5 — Media / Attachment

逐项：

```text
image
voice
file
video
```

必须同时完成：

```text
Weixin CDN
+
Channel media
+
Harness attachment projection
```

每完成一种再打开相应 capability。

---

# WX6 — Typing / Advanced

实现：

```text
typing_ticket
sendtyping
run correlation
optional progress message
GENERATING / FINISH
```

这些不能影响基本 text E2E 稳定性。

---

# WX7 — Compatibility / CI / Release Gate

必须：

```text
build
typecheck
test
governance
```

在 Pull Request 上真实运行。

同时：

```text
Harness compatibility
Tencent iLink compatibility
```

进入 Upgrade Gate。

Release 前：

- [ ] PR CI 全绿；
- [ ] Harness pinned contract test 全绿；
- [ ] Weixin protocol fixture 全绿；
- [ ] live Weixin smoke test 成功；
- [ ] README 与 manifest 已更新。

---

# 34. Test Matrix

## 34.1 Harness Contract

覆盖：

```text
Agent.id === SessionId semantics
AgentHandle ownership
create route
resume route
session/event names
persistence absent
persistence error
binding migration
unload reconcile
adapter rollback
```

---

## 34.2 Weixin Fixtures

```text
fixtures/weixin/
├─ qr-created.json
├─ qr-wait.json
├─ qr-scanned.json
├─ qr-confirmed.json
├─ qr-expired.json
├─ qr-redirect.json
├─ qr-verify-code.json
├─ qr-already-bound.json
├─ getupdates-empty.json
├─ getupdates-text.json
├─ getupdates-image.json
├─ getupdates-voice.json
├─ sendmessage-ok.json
├─ typing-ticket.json
├─ stale-token.json
└─ protocol-error.json
```

---

## 34.3 Unit Tests

必须覆盖：

```text
headers
X-WECHAT-UIN
base_info
QR state machine
redirect
verify code
credential store
cursor atomicity
cursor crash replay
context token
mapper
dedup
send payload
AbortSignal
retry/backoff
token redaction
```

---

## 34.4 Channel Contract

继续：

```ts
runChannelAdapterContract(...)
```

Weixin 不得以“协议特殊”为理由绕过公共 Contract。

---

## 34.5 Live Test

环境变量：

```text
DSH_WEIXIN_LIVE=1
```

人工/受控环境：

```text
QR login
 ↓
real getUpdates
 ↓
real Harness Agent
 ↓
real sendMessage
```

Live test 不默认放普通 PR CI。

---

# 35. Upstream Manifest

建议：

```ts
export const manifest = {
  id: 'weixin',

  upstream: {
    repository: 'Tencent/openclaw-weixin',

    testedVersion: '<verified-version>',
    testedCommit: '<verified-commit>',

    strategy: 'source-port',
    protocol: 'weixin-ilink',
  },
}
```

不要只记录版本而不记录 commit。

Compatibility job 定期关注：

```text
auth
api
message types
cdn
monitor
typing
```

变更。

---

# 36. License

如果直接迁移 Tencent MIT 代码片段：

```text
THIRD_PARTY_NOTICES.md
```

保留来源和原始版权/许可信息。

不要把“参考协议”写成“腾讯官方支持 DeepSeek Harness”。

准确表述：

```text
Weixin protocol implementation is based on / ported from
Tencent/openclaw-weixin iLink implementation.
```

---

# 37. 最终验收清单

## Harness Compliance

- [ ] Agent runtime identity 只使用 `SessionId`
- [ ] `agentId` 已从 binding/runtime routing 删除
- [ ] routing 使用 `AgentRouteSpec`
- [ ] preset → `meta.agentPreset`
- [ ] provider/model/maxTokens → `agentOptions`
- [ ] create/resume route parity
- [ ] persistence 不靠 error regex
- [ ] borrowed Agent 永不 dispose
- [ ] owned AgentHandle exactly-once dispose
- [ ] session/event 仍是 reply source
- [ ] unload final reply 有 durable reconcile
- [ ] Adapter startup transactional rollback

## Weixin Protocol

- [ ] 不存在 localhost:9000 Gateway 假设
- [ ] QR 直接来自 iLink
- [ ] redirect 支持
- [ ] verify code 支持
- [ ] bot_token 安全持久化
- [ ] baseUrl 按账号持久化
- [ ] `get_updates_buf` 持久化
- [ ] `context_token` 持久化
- [ ] getUpdates 支持 AbortSignal
- [ ] dynamic long-poll timeout
- [ ] sendmessage 使用真实 payload
- [ ] dedup 对 crash replay 有效
- [ ] restart 无需重新扫码
- [ ] token 全日志脱敏

## Harness Live E2E

- [ ] 微信真实消息进入 ChannelService
- [ ] SessionBinding 创建/恢复正确
- [ ] Harness Agent 收到 identified UserMessage
- [ ] session/event 产生真实回复
- [ ] ReplyRouter 返回微信
- [ ] turn final text 不丢
- [ ] restart 保持同一会话
- [ ] unload 不丢最终回复

## Media

- [ ] image CDN
- [ ] voice CDN
- [ ] file CDN
- [ ] video CDN
- [ ] Harness attachment projection
- [ ] capability 不虚报

## Release

- [ ] build
- [ ] typecheck
- [ ] test
- [ ] governance
- [ ] PR CI
- [ ] Harness compat
- [ ] Weixin fixtures
- [ ] live smoke
- [ ] THIRD_PARTY_NOTICES（如适用）

只有上述核心项完成，才能把 Weixin M1 标记为真正完成。

---

# 38. 推荐实施顺序

严格按以下顺序：

```text
Task 1
修 AgentRouteSpec / SessionBinding

Task 2
修 AgentManager create/resume/persistence

Task 3
修 ReplyRouter unload reconcile

Task 4
抽公共 mountChannelAdapter + startup rollback

Task 5
更新 Harness compatibility tests

Task 6
删除 Weixin fake Gateway

Task 7
实现 iLink Client

Task 8
实现 QR Login + Credential

Task 9
实现 getUpdates + Cursor + ContextToken + Dedup

Task 10
实现 Text send

Task 11
完成真实 Weixin → Harness → Weixin E2E

Task 12
实现 Media + Harness Attachment

Task 13
实现 Typing / Progress

Task 14
CI / Compatibility / docs / release
```

不要并行把：

```text
Weixin Media
Typing
Harness routing refactor
```

同时开工。

最先打通：

```text
真实微信文字 E2E
```

再扩媒体。

---

# 39. 最终工程判断

本项目不需要推倒重做。

正确处理比例：

```text
dsh-channels 总体架构
→ 保留

channel-core
→ 小幅修生命周期/能力边界

channel-harness
→ 中等规模合规修正

channel-weixin
→ 保留 Adapter 外壳
→ 协议内核大规模重写
```

最终结构：

```text
Tencent iLink
      ↓
Weixin Provider
      ↓
Channel Contract
      ↓
ChannelService
      ↓
Harness Bridge
      ↓
ctx.agents
      ↓
Session Log
      ↓
ReplyRouter
      ↓
Weixin Provider
```

这是最终应锁定的实现方向。

---

# 40. 核验基线

本最终版在原执行方案基础上修订，重点对齐以下 DeepSeek Harness 官方约束：

```text
Everything is a Cordis plugin
Service mounted on ctx
required dependencies use inject
optional services resolved at use site
Agent identity shares SessionId
ctx.agents.get() is borrowed
ctx.agents.create()/resume() return owned AgentHandle
session/event is durable replay source
agent/* is live coordination surface
ordered async cleanup must not rely on independent Cordis effects
Session log remains source of truth
Bundle uses dsh.bundle.patch
```

原方案中以下主决策继续有效：

```text
保留 @dsh/channel-weixin
保留 ChannelAdapter
保留 ChannelService
保留 channel-harness
保留 SessionBinding / ReplyRouter 思路
移除 self-hosted Weixin Gateway
重写为 Tencent iLink Direct Client
```

本最终版仅对 Harness 合规、生命周期、路由语义、持久化语义、多模态语义和实施顺序进行了必要收口。
