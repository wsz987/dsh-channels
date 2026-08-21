---
title: Telegram Bot API 10.2 富文本与 IM User Questions 执行方案
summary: 基于 dsh-channels HEAD 2781f7a、DeepSeek Harness 0.1.0-rc.7/rc.8 UserQuestionService 官方实现与 Telegram Bot API 10.2，对 Issue #1 / #2 的架构核验、目标设计、分阶段改造；强化 timeout/fallback、buffered/streaming、代码块/表格与半成品 Markdown Release Gate。
when_to_use: Telegram | Rich Messages | ask_user_question | interaction.received | channel-harness | Bot API 10.2
authoritative: 本文是 Issue #1 / #2 的目标执行方案；实现时仍以 DeepSeek Harness 与 Telegram 官方最新 contract 为最终依据。
see_also: [architecture.md, architecture/common-design.md, adapter-authoring.md, channel-platform-verification.md, security/inbound-access-control.md]
status: implementation-in-progress
baseline:
  repo_head: 2781f7a1b83613ea0c5675731bb6afbcb3ce4e12
  dsh_project: 0.1.0-rc.7
  dsh_cross_check: 0.1.0-rc.8
  telegram_bot_api: "10.2"
---

# Telegram Bot API 10.2 富文本与 IM User Questions 执行方案

> 建议落库路径：`docs/telegram-rich-interaction-execution-plan.md`
>
> 对应 Issues：
> - `#1 feat(channel-telegram): support Telegram parse_mode (HTML / MarkdownV2) for outbound messages`
> - `#2 feat(channels): interactive user questions over IM (ask_user_question) are dropped on Telegram`

## 1. 结论

### Issue #1

**有效，接受，但不按“给 `sendMessage` 加一个 `parse_mode`”的窄方案实现。**

目标应升级为：

> **Telegram Bot API 10.2 Rich Messages + 安全普通格式 fallback + 富文本流式输出**

原因：

1. 当前 Telegram adapter 明确声明 `markdown: false`。
2. `sendMessage` / `editMessageText` / media caption 目前均未发送 `parse_mode` / `entities`。
3. 当前 `TelegramStreamingReply` 按 4096 code point 生切，不能保证 MarkdownV2 / HTML / entity 边界。
4. 当前实现以 Bot API `10.2` 为最低官方基线，不维护旧 Bot API server。
5. Telegram Bot API 10.1 已加入面向结构化文本和 AI 流式生成的 Rich Messages：
   - `sendRichMessage`
   - `sendRichMessageDraft`
   - `editMessageText.rich_message`
6. Bot API 10.2 又补齐 Rich Message media / block 类型，因此对 Agent Markdown 的长期适配价值明显高于 MarkdownV2。

**默认路线：Rich Markdown。**

MarkdownV2 仍可作为兼容模式，但**不应成为默认输出格式**。

---

### Issue #2

**用户现象有效，但 Issue 原始“让各 Telegram/IM adapter 接 ask_user_question”的架构落点不正确。**

正确归属：

```text
DeepSeek Harness UserQuestionService
            │
            │  Host public ApiProxy mux (`question/requested`)
            ▼
      channel-harness
            │
            │  Channel Contract
            ▼
       channel adapter
            │
            ▼
    Telegram / QQ / Lark / ...
```

必须坚持当前项目红线：

```text
channel-telegram   ❌ 不访问 ctx.userQuestions / ctx.agents
channel-qq         ❌ 不实现 Harness ask_user_question 语义
channel-lark       ❌ 不实现 Harness ask_user_question 语义
...
channel-harness    ✅ 唯一承接 Harness 人机交互语义
channel-core       ✅ 只定义平台无关 interaction/action contract
```

官方源码复核后的实现结论：

- DSH rc.7 `UserQuestionService` 只允许一个 Provider。
- DSH rc.8 仍是同一份实现。
- 第二个 `registerProvider()` 会触发 `DUPLICATE_PROVIDER`。
- `ask()` 本身没有 timeout policy，仅依赖调用方 `AbortSignal`。
- Web Host 已经把请求转换为公共 `ctx.apiProxy.events.mux()` 上的 `question/requested`，并通过公共 `ctx.apiProxy.respond()` 接收答案。

因此：

> **不要注册第二个 Provider。`channel-harness` 作为另一个官方 client shape，消费公共 ApiProxy Mux，并只匹配拥有 active ReplyContext 的渠道来源 turn。**

Issue #2 的下游实现分成两层：

- **Track A：channel-core 通用 actions + Telegram callback / reply transport。**
- **Track B：channel-harness 的 ApiProxy question bridge + pending/security/timeout。**

Web 与 Telegram 都可能看到渠道来源问题；官方 RPC 以首个 accepted response 为准，随后 `question/resolved` 清理另一端的陈旧按钮。

---

## 2. 本次核验基线

### 2.1 dsh-channels

当前核验基线：

```text
wsz987/dsh-channels
HEAD = 2781f7a1b83613ea0c5675731bb6afbcb3ce4e12
```

项目当前架构已经明确：

```text
Channel Core
    ↓
Channel Adapter
    ↓
Upstream Driver

DeepSeek Harness
    ↓
channel-harness
    ↓
Channel Core / Adapter
```

核心红线已经正确：

- Adapter 不接触 Harness Agent APIs。
- Harness Agent / Session API 只允许在 `channel-harness`。
- `SessionBinding` 负责“回复到哪里”。
- `ReplyContext` 负责“这个 turn 是否应该回 IM”。
- Web / CLI / 其他插件驱动的 turn，即使 Session 已绑定 Channel，也不能自动回 IM。

这个设计必须原样延续到 `ask_user_question`。

---

### 2.2 DeepSeek Harness

项目当前 package 基线是：

```text
@deepseek-ai/dsh-* = 0.1.0-rc.7
```

rc.7 官方 `UserQuestionService`：

```ts
interface UserQuestionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

class UserQuestionService {
  private provider?: UserQuestionProvider

  registerProvider(provider): () => void

  async ask(request): Promise<AskUserQuestionAnswer>
}
```

当前 contract 的关键语义：

```text
只有一个 active provider
第二个 Provider -> DUPLICATE_PROVIDER

AskUserQuestionRequest
├─ questions[]
├─ agent?
└─ signal?
```

rc.8 交叉核验后，这部分实现没有改变，因此 **rc.8 也没有提供 IM/Web 多 Provider 路由 seam**。

---

### 2.3 Telegram Bot API

当前官方 Bot API：

```text
10.2 — 2026-07-14
```

与本项目最相关的新能力：

#### Bot API 10.1

```text
Rich Messages
├─ sendRichMessage
├─ sendRichMessageDraft
└─ editMessageText.rich_message
```

其中 `sendRichMessageDraft` 官方明确用于：

```text
stream a partial rich message while the message is being generated
```

这是当前 Telegram adapter “LLM edit streaming”的更原生方案。

#### Bot API 10.2

补充：

```text
InputRichMessageMedia
InputRichBlock*
RichBlock*
Ephemeral Messages
```

Ephemeral Messages 可以让群组中的 Bot 向**指定用户**发送仅该用户和 Bot 可见的临时消息，这对群聊中的 `ask_user_question` 很有价值。

但官方同时明确：

```text
receiver_user_id 的消息并不保证用户一定收到，特别是用户离线时
```

所以 ephemeral 只能是增强层，不能成为唯一可靠路径。

---

## 3. 当前代码的关键缺口

## 3.1 Telegram 富文本缺口

当前：

```ts
capabilities.markdown = false
```

而 `HttpTelegramUpstream`：

```text
sendMessage       -> plain text
editMessageText   -> plain text
sendMedia.caption -> plain text
```

没有：

```text
parse_mode
entities
caption_entities
rich_message
sendRichMessage
sendRichMessageDraft
```

### 额外发现：sendMessage 错误信息不足

当前 `sendMessage` 在：

```text
envelope.success === true
envelope.data.ok === false
```

时仍归类成：

```text
telegram sendMessage returned an invalid response
```

这会丢掉 Telegram 的：

```text
error_code
description
parameters
```

结果是无法可靠判断：

```text
富文本解析失败 -> 可降级纯文本
401/403          -> 不应降级
429              -> rate limit
5xx/network      -> 重试策略
```

必须先建立结构化 Telegram API Error。

---

## 3.2 当前 streaming 超过 4096 后 preview 会“冻结”

当前 `TelegramStreamingReply`：

```ts
const chunks = splitText(this.text, 4096)
const preview = chunks[0]
```

当模型累计输出超过 4096 后：

```text
chunks[0] 不再变化
```

因此 Telegram 中首条 preview 会看起来停止更新，直到 `finish()` 再发送后续 chunk。

这不是 Issue #1 的直接内容，但升级 Rich Streaming 时应一起修正。

---

## 3.3 当前分段不适合富文本

当前：

```text
Array.from(text)
每 4096 个 code point 直接切
```

会切断：

```text
Markdown code fence
list
table
blockquote
link
HTML tag
Telegram entity
grapheme cluster
```

因此不能在现有 splitter 上直接加：

```ts
parse_mode: 'MarkdownV2'
```

---

## 3.4 Telegram inbound 只订阅 message

当前 `getUpdates`：

```ts
allowed_updates: ['message']
```

因此：

```text
callback_query
message_reaction
edited_message
...
```

都不会进入 adapter。

Issue #2 要使用 Inline Keyboard，最低限度必须加入：

```text
callback_query
```

---

## 3.5 `interaction.received` 已经存在

`channel-core` 当前已经有：

```ts
interface InteractionReceived {
  type: 'interaction.received'
  channel
  accountId
  conversation
  sender
  interactionId
  action
  value?
  raw?
}
```

所以**无需新增 Harness 专属 question callback event**。

应直接复用：

```text
Telegram callback_query
       ↓
interaction.received
       ↓
channel-harness PendingQuestionRouter
```

这是当前项目设计中非常好的预留点。

---

## 3.6 还缺 outbound action contract

当前 `OutboundMessage` 只有：

```ts
text?
parts?
replyTo?
metadata?
```

没有平台无关 button/action。

因此建议补一个很窄的通用 contract：

```ts
export interface OutboundAction {
  id: string
  label: string
  style?: 'default' | 'primary' | 'success' | 'danger'
}

export interface OutboundActionRow {
  actions: OutboundAction[]
}

export interface OutboundMessage {
  text?: string
  parts?: MessagePart[]
  replyTo?: string
  actions?: OutboundActionRow[]
  metadata?: Record<string, unknown>
}
```

Telegram 映射：

```text
OutboundActionRow[]
     ↓
InlineKeyboardMarkup.inline_keyboard
```

其他 adapter 后续可以：

```text
Lark      -> card actions
DingTalk  -> card buttons
QQ        -> keyboard/button（若官方能力允许）
...
```

Core 不知道：

```text
Telegram callback_data
Lark action value
DingTalk callback schema
```

---

## 3.7 Release Gate 必须同时覆盖 buffered 与 streaming

本方案不把“格式正确”定义成只验证最终完整 Markdown。

真实 Agent 输出必须同时覆盖：

```text
Buffered
DM Streaming
Group Streaming
```

而 streaming 阶段必须验证**未闭合、半成品 Markdown**，包括：

```text
半截 fenced code block
半截 Markdown table
半截 link
半截 emphasis/entity
半截 HTML（兼容模式）
emoji / ZWJ grapheme 边界
```

原因：

```text
完整 Markdown 能成功渲染
≠
流式 partial Markdown 可以安全发送
```

因此实现上必须保持：

```text
preview transport
≠
final rich renderer
```

允许：

```text
DM    -> Rich Draft preview + Rich final
Group -> Plain edit preview + Rich final edit
```

禁止把每个 delta 直接当成完整 MarkdownV2 / HTML 文档解析后发送。

---

## 3.8 Timeout 与 fallback 是协议行为，不只是测试

两类 fallback 必须明确区分。

### User Question timeout

```text
pending
  ↓ timeout / AbortSignal / lifecycle dispose
expired | aborted
  ↓
禁止后续 consume
清理按钮/交互状态
返回稳定错误给 ask_user_question
```

不得：

```text
超时后选择默认第一项
超时后把迟到的回复当成新的 question answer
```

### Telegram formatting fallback

仅当确认属于：

```text
format/entity/rich-message parsing failure
```

时：

```text
rich/formatted -> plain
```

不得将：

```text
401 / 403 / 429 / network / 5xx
```

错误伪装成格式 fallback。

这要求 `TelegramApiError` 保留 Telegram 原始：

```text
error_code
description
parameters
```

并由统一 classifier 决定 retry / fallback / fail。

---

# 4. 目标架构

```text
                               DeepSeek Harness
                                      │
                         ctx.userQuestions.ask()
                                      │
                              Host ApiProxy
                    ┌─────────────────┴─────────────────┐
                    │                                   │
               Web client                    ChannelQuestionBridge
                                                        │
                                                channel-harness
                                                        │
                                      ┌─────────────────┴──────────────────┐
                                      │                                    │
                              ReplyContextStore                    PendingQuestionStore
                                      │                                    │
                               origin / sender                    request correlation
                                      │                                    │
                                      └─────────────────┬──────────────────┘
                                                        │
                                                ChannelAdapter
                                                        │
                                    ┌───────────────────┴───────────────────┐
                                    │                                       │
                              Outbound actions                       InteractionReceived
                                    │                                       │
                                    ▼                                       ▲
                             Telegram inline                       callback_query / reply
                               keyboard                                  message
```

---

# 5. Issue #1 最终设计

## 5.1 格式能力分层

新增 Telegram 配置：

```ts
interface TelegramFormattingConfig {
  mode:
    | 'auto'
    | 'rich-markdown'
    | 'html'
    | 'markdown-v2'
    | 'plain'

  fallback: 'plain'
}
```

推荐默认：

```yaml
formatting:
  mode: auto
  fallback: plain
```

语义：

```text
auto
  -> Rich Markdown（最低支持 Bot API 10.2）

rich-markdown
  -> sendRichMessage / sendRichMessageDraft

html
  -> 普通 sendMessage(parse_mode=HTML)
     必须经过 Markdown -> Telegram-safe HTML renderer

markdown-v2
  -> 专家兼容模式
     必须完整转义，不允许直接把 Agent Markdown 当 MarkdownV2

plain
  -> 不解析格式
```

---

## 5.2 显式使用 Rich Markdown

实现修正：`auto` 统一使用 Rich Markdown，adapter 的最低上游版本为 Bot API 10.2。
不再按 URL 猜测能力，也不维护旧版或自建旧 Bot API server 的自动降级。`plain` 仅是
显式展示模式和确认属于 formatting error 时的单次 fallback。完整 live gate 前状态仍
保持 `experimental`。

推荐：

```text
Agent Markdown
     ↓
normalize / validate
     ↓
Telegram InputRichMessage.markdown
```

原因：

- Rich Markdown 与 GitHub Flavored Markdown 尽可能兼容。
- 原生支持 heading / list / table / quote / code / details 等结构。
- 单条 Rich Message 上限比普通消息更高。
- 更符合 Agent 输出。
- 不需要把普通 Markdown 硬转换成 Telegram MarkdownV2。

不要默认：

```text
Agent Markdown -> MarkdownV2
```

---

## 5.3 普通 HTML / MarkdownV2 仍保留

用途：

```text
用户显式配置
排查 Rich Message formatting 问题
特定媒体 caption
```

但两者都必须经过 renderer。

禁止：

```ts
parse_mode: 'MarkdownV2',
text: agentMarkdown // ❌
```

---

## 5.4 引入 Telegram API Error

建议新增：

```ts
export class TelegramApiError extends ChannelError {
  readonly method: string
  readonly errorCode?: number
  readonly description?: string
  readonly parameters?: {
    retryAfter?: number
    migrateToChatId?: number
  }
}
```

统一在 `post()` / envelope boundary 构造。

错误分类：

```ts
type TelegramErrorKind =
  | 'format'
  | 'rate-limit'
  | 'auth'
  | 'permission'
  | 'network'
  | 'upstream'
```

fallback 规则：

```text
format error
  -> 同一内容仅降级一次 plain

401 / 403
  -> 不降级

429
  -> 走 retry_after / 上层重试

network / 5xx
  -> 不伪装成格式错误
```

不得：

```text
任何 400 都 fallback plain
```

---

# 6. Telegram Rich Streaming

## 6.1 Private DM

Bot API 10.1：

```text
sendRichMessageDraft
```

只面向 private chat，非常适合 DSH。

建议：

```ts
resolveStreamingMode(target) {
  if (
    config.streaming.enabled &&
    formatting.supportsRich &&
    target.conversationType === 'dm'
  ) {
    return 'native'
  }

  return 'edit'
}
```

新增：

```text
TelegramRichStreamingReply
```

生命周期：

```text
start
  -> sendRichMessageDraft(placeholder / thinking)

append(delta)
  -> 内部累计完整 markdown
  -> 按 ReplyRouter 节流
  -> sendRichMessageDraft(same draft_id, current full preview)

finish(final)
  -> sendRichMessage(final)
  -> draft 自动作为临时 preview 消失 / 被最终结果取代

fail(error)
  -> 最终发送简短安全错误，或停止 draft
```

注意：

```text
sendRichMessageDraft 只是 30 秒临时 preview
最终必须 sendRichMessage
```

---

## 6.2 Group / Supergroup / Forum

`sendRichMessageDraft` 不支持普通 group target。

建议保留：

```text
streaming = edit
```

但升级流程：

```text
start
  -> sendMessage("…")

replace
  -> editMessageText(plain preview)

finish
  -> editMessageText(rich_message=finalRichMessage)
```

好处：

- 流式过程中不要求 partial Markdown 始终闭合。
- 最终消息才开启富格式。
- 不新增孤立“最终消息”。
- final rich 失败时可直接把同一条消息降级为 plain。

---

## 6.3 超长 preview

不要继续使用：

```text
永远显示 first 4096
```

建议：

```text
<= limit
  -> 显示完整 preview

> limit
  -> 显示开头摘要 + 最新尾部
  或
  -> 显示最后 N 字符并加 “…” 前缀
```

目标：

```text
用户始终能看到模型仍在继续输出
```

最终结果再做稳定分段。

---

# 7. 富文本安全分段

## 7.1 普通消息

Telegram 普通文本：

```text
4096 characters after entities parsing
```

media caption：

```text
1024 characters after entities parsing
```

不能用 raw substring 对 HTML / MarkdownV2 生切。

---

## 7.2 Rich Message

Bot API 10.2 Rich Message 当前限制包括：

```text
32768 UTF-8 characters
500 blocks
16 nesting levels
50 media attachments
20 table columns
```

建议 renderer 输出逻辑块后再 segment：

```text
Markdown source
    ↓
Markdown AST / block tokenizer
    ↓
logical blocks
    ↓
Telegram rich segmenter
    ↓
InputRichMessage[]
```

优先切分顺序：

```text
paragraph
heading
list item / whole list
blockquote
table
code fence
```

对于单个超长 code fence：

```text
保留 language
把内部 code 按安全边界切成多个 fenced code blocks
```

Unicode：

```text
优先 Intl.Segmenter(grapheme)
不要截断 emoji ZWJ / variation sequence
```

---

# 8. Issue #2：官方 ApiProxy client seam

官方 `ctx.apiProxy` 是供不同 client shape 共用的公共 Host Service。当前实现直接使用其
`events.mux()` / `respond()` 窄端口，不依赖 Host 实现包，也不注册第二个
`UserQuestionProvider`。下方 routed-provider 设计保留为历史备选，不是当前 blocker。

## 8.1 已否决的替代方案：修改默认 Provider 语义

上游现在：

```text
registerProvider(provider)
```

已有 Web Host 依赖其“唯一 fallback provider”语义。

建议对 DeepSeek Harness 提最小兼容扩展，而不是直接把现有 API 改成任意多 Provider。

推荐 contract：

```ts
interface UserQuestionProviderRoute {
  match(request: AskUserQuestionRequest): boolean
  priority?: number
}

registerProvider(
  provider: UserQuestionProvider,
  route?: UserQuestionProviderRoute
): () => void
```

语义：

```text
registerProvider(provider)
  -> 保持现有唯一 fallback provider
  -> 第二个无 route provider 仍 DUPLICATE_PROVIDER

registerProvider(provider, { match, priority })
  -> 注册 routed provider
  -> 允许多个

ask(request)
  -> 找到 match=true 的 routed providers
  -> priority 高者优先
  -> 若无 routed provider 命中，回退到原 fallback provider
```

这样：

```text
Web Host
  -> 代码基本无需改动
  -> 继续 registerProvider(webProvider)

channel-harness
  -> registerProvider(channelProvider, {
       match: request => isActiveChannelOrigin(request.agent),
       priority: 100
     })
```

这是最小侵入方案。

---

## 8.2 为什么不能只按 SessionBinding 路由

错误设计：

```text
request.agent.session.id
  -> 找到 SessionBinding
  -> 认为一定来自 IM
```

这是不安全的。

当前项目已经明确：

```text
SessionBinding = WHERE
ReplyContext   = SHOULD
```

例如：

```text
Telegram 曾经创建了 session A
Web UI 后来打开 session A
Web UI 发起一个 turn
这个 turn 调用 ask_user_question
```

此时：

```text
SessionBinding 仍然指向 Telegram
```

但问题必须显示在 Web，而不是 Telegram。

因此 `ChannelQuestionBridge` 的 frame match 必须基于：

```text
当前 live turn 是否拥有 active ReplyContext
```

---

# 9. 扩展 ReplyContextStore

当前 `ReplyContextStore` 已经在：

```text
agent/inbox/claimed
```

时完成：

```text
message id -> session + turn
```

这正好能作为 question routing provenance。

建议增加：

```ts
interface ActiveChannelTurn {
  sessionId: string
  turn: number
  context: ChannelReplyContext
}

getActiveForSession(sessionId: string): ActiveChannelTurn | undefined
```

同时建议给 `ChannelReplyContext` 增加：

```ts
senderId: string
```

原因：

```text
conversationId 不足以证明回答者就是原始用户
```

尤其 group 中必须校验：

```text
senderId === pending.allowedSenderId
```

新增后：

```ts
interface ChannelReplyContext {
  conversationType: 'dm' | 'group'
  senderId: string
  replyToMessageId?: string
  raw?: unknown
  runId?: string
}
```

这仍是 turn-scoped transient state，不应该写入 durable SessionBinding。

---

# 10. ChannelQuestionBridge

新增建议文件：

```text
packages/channel-harness/src/channel-question-bridge.ts
```

Bridge：

```ts
class ChannelQuestionBridge {
  start(): void // subscribe apiProxy.events.mux()
  handleChannelEvent(event: ChannelEvent): Promise<boolean>
}
```

匹配条件：

```text
question/requested.sessionId 存在 active Channel ReplyContext
binding 存在
adapter 存在
adapter.capabilities.interactiveActions = true
```

否则：

```text
忽略该 frame，不向渠道发消息
```

Web client 独立消费同一 Mux；渠道桥不接管 Web 来源 turn。

---

# 11. PendingQuestionStore

推荐 key 不直接使用 option 文本。

Telegram `callback_data` 当前限制：

```text
1-64 bytes
```

所以生成短 opaque token：

```text
dshq:<token>:<questionIndex>:<actionIndex>
```

不要塞：

```text
sessionId
conversationId
完整 option label
用户输入
```

建议状态：

```ts
interface PendingQuestion {
  id: string

  sessionId: string
  turn: number

  channelId: string
  accountId: string
  conversationId: string
  threadId?: string
  allowedSenderId: string

  request: AskUserQuestionRequest
  answers: Map<string, AskUserQuestionAnswerItem>

  sentMessageIds: Map<string, string>

  createdAt: number
  expiresAt: number

  state:
    | 'pending'
    | 'resolved'
    | 'expired'
    | 'aborted'
}
```

必须支持：

```text
one-shot consume
timeout cleanup
AbortSignal cleanup
adapter stop/unload cleanup
duplicate callback replay rejection
```

---

# 12. question inbound 路由顺序

## 12.1 普通 reply

正确顺序：

```text
message.received
      ↓
现有 Access Gate
      ↓
PendingQuestionRouter.tryConsumeReply()
      │
      ├─ consumed -> 作为 ask_user_question answer，不进入 Agent inbox
      │
      └─ not consumed
              ↓
         正常 Channel -> Agent 路由
```

不要：

```text
先进入 Agent
再判断是不是 question answer
```

否则用户回答会被当成新的 prompt。

---

## 12.2 callback_query

Telegram：

```text
callback_query
    ↓
adapter 立即 best-effort answerCallbackQuery()
    ↓
map -> interaction.received
    ↓
channel-harness Access Gate
    ↓
PendingQuestionRouter
```

Telegram 官方要求：

```text
用户点击 inline keyboard 后，客户端会显示 progress bar，
直到 Bot 调用 answerCallbackQuery。
```

因此 ACK 不应该等待 Agent 或 provider resolve。

---

# 13. Access Gate

Interaction 不能绕过当前 inbound access policy。

需要把 Access Controller 的语义扩展为：

```text
Message:
  Security Gate + Activation Gate

Interaction:
  Security Gate
  + interaction 本身视为显式 activation
  + PendingQuestion exact-match gate
```

建议新增：

```ts
authorizeInteraction({
  conversationType,
  senderId,
  conversationId,
  policy,
})
```

而不是在代码中偷偷传：

```ts
mentionedBot: true
```

这样语义更清楚。

interaction 最终必须同时满足：

```text
channel/account match
conversation match
thread match（若有）
sender match
pending token match
pending state == pending
not expired
```

任何一个失败：

```text
fail closed
```

---

# 14. Telegram Inline Keyboard

`OutboundMessage.actions` -> Telegram：

```ts
{
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: action.label,
          callback_data: action.id,
          style: action.style
        }
      ]
    ]
  }
}
```

Bot API 10.2 button style 已支持：

```text
primary
success
danger
```

Core 只保留通用 style，不携带 Telegram-specific 字段。

---

# 15. ask_user_question 呈现策略

## 15.1 Single-select

首选：

```text
Inline Keyboard
```

流程：

```text
Question
[ Option A ] [ Option B ]
[ Other... ]
```

点击后：

```text
PendingQuestionStore resolve
```

如果需要 `custom`：

```text
点 Other...
  -> 进入 free-text pending state
  -> Telegram ForceReply
```

---

## 15.2 Free-text

使用：

```text
ForceReply
```

要求回复必须关联：

```text
reply_to_message_id == questionMessageId
```

第一版不建议把“同一个 DM 中下一条任意消息”自动当成答案。

原因：

```text
用户可能只是开始了一个新的任务
```

---

## 15.3 Multi-select

完整方案：

```text
[✓ A] [  B]
[✓ C]
[ Done ]
[ Other... ]
```

每次 callback：

```text
toggle pending selection
edit message reply_markup / message
```

点击 Done 后 resolve。

这要求新增通用可选编辑能力：

```ts
edit?(
  target: ChannelTarget,
  messageId: string,
  message: OutboundMessage,
): Promise<SendResult>
```

建议作为 `ChannelAdapter` optional method，不强迫所有 adapter 一次实现。

如果某 adapter：

```text
interactiveActions = true
edit = false
```

则 multi-select 自动降级为：

```text
编号文本 + ForceReply
```

---

# 16. Telegram 10.2 Ephemeral Questions

Bot API 10.2 在 group/supergroup 支持：

```text
receiver_user_id
```

可以将 question 只展示给触发 Agent 的用户。

这是 group user-question 的优秀增强能力：

```text
Group
  User A -> Agent
  Agent -> ask_user_question
  Bot -> ephemeral question only visible to User A
```

但由于 Telegram 官方明确“不保证离线用户一定收到”，建议策略：

```yaml
questions:
  groupPresentation: auto
```

`auto`：

```text
能使用 ephemeral
  -> 优先 ephemeral

无法确认发送/交互
  -> regular group reply + selective/ForceReply
```

不要把 ephemeral 作为唯一 reliable transport。

P0 可以先不使用 ephemeral；
P1 再接入，避免把 Issue #2 和 Bot API 10.2 新特性一次耦合过深。

---

# 17. Timeout Policy

新增 `channel-harness` 配置：

```ts
interface UserQuestionConfig {
  enabled: boolean
  timeoutMs: number
}
```

推荐默认：

```yaml
userQuestions:
  enabled: true
  timeoutMs: 300000
```

即 5 分钟。

Provider：

```text
Promise.race(
  pendingAnswer,
  abortSignal,
  timeout
)
```

timeout 后：

```text
PendingQuestionStore -> expired
移除 inline keyboard / 标记已超时
拒绝后续 callback/reply
throw UserQuestionError(..., 'QUESTION_TIMEOUT')
```

不要默认：

```text
超时后自动选择第一个 option
```

除非未来 AskUserQuestion contract 显式增加 default policy。

---

# 18. Telegram “完整支持”的边界

本文所说“完整能力”是：

> **DSH Agent Channel 所需要的 Telegram 完整能力**

不是实现 Telegram Bot API 的每一个业务 endpoint。

## P0 — 必须

### Text / AI Output

```text
sendMessage
editMessageText
parse_mode / entities
Rich Markdown
sendRichMessage
sendRichMessageDraft
Rich final edit
安全 fallback
长文本分段
```

### Media

```text
photo
document
audio
voice inbound
video
caption formatting
getFile
reply
forum thread
```

### Interaction

```text
InlineKeyboardMarkup
callback_query
answerCallbackQuery
ForceReply
interaction.received
```

### Reliability

```text
structured API error
429 retry_after recognition
dedup
polling cursor
callback replay protection
timeout
abort
```

### Security

```text
Access Gate
sender/conversation exact match
pending token correlation
```

---

## P1 — 推荐

```text
Telegram Ephemeral Messages
video_note
sticker
animation
location
media groups
message edit/delete abstraction
reaction.received
typing/chat action
 richer rich-message media blocks
```

---

## 非目标

除非产品明确需要，否则不进入本次 scope：

```text
payments / Stars commerce
games
Mini Apps
Telegram Business automation
admin / moderation suite
inline-query product
communities management
poll/checklist business workflow
```

否则会把一个 Agent Channel adapter 变成 Telegram SDK 的重复实现。

---

# 19. 文件级执行计划

## Phase 0 — 上游与基线

### dsh-channels

新增本文：

```text
docs/telegram-rich-interaction-execution-plan.md
```

更新：

```text
docs/channel-platform-verification.md
```

记录：

```text
Telegram Bot API tested target = 10.2
DSH userQuestions rc.7 / rc.8 gap
```

manifest 与 fixtures 同步迁移到 10.2；`experimental` 保留到 live gate 完成。

---

## Phase 1 — Telegram 10.2 upstream primitives

修改：

```text
packages/channel-telegram/src/upstream.ts
packages/channel-telegram/src/manifest.ts
packages/channel-telegram/src/config.ts
```

新增建议：

```text
packages/channel-telegram/src/api-error.ts
packages/channel-telegram/src/rich-message.ts
```

实现：

```text
TelegramApiError
sendRichMessage()
sendRichMessageDraft()
editMessageRich()
sendMessage formatting options
media caption formatting options
reply_markup
answerCallbackQuery()
getUpdates allowed_updates = ['message', 'callback_query']
```

manifest 最低基线：

```text
testedVersion: 10.2
versionRange: '>=10.2'
```

---

## Phase 2 — Rich renderer

新增：

```text
packages/channel-telegram/src/render/
├─ index.ts
├─ markdown.ts
├─ html.ts
├─ plain.ts
└─ segment.ts
```

责任：

```text
source markdown
-> Telegram output
-> safe segment
-> fallback source
```

不要把 renderer 塞进：

```text
upstream.ts
outbound.ts
streaming-reply.ts
```

Upstream 只负责 Telegram HTTP contract。

---

## Phase 3 — Rich streaming

修改：

```text
packages/channel-telegram/src/adapter.ts
packages/channel-telegram/src/streaming-reply.ts
```

建议拆：

```text
streaming-reply.ts
rich-streaming-reply.ts
```

行为：

```text
DM + rich
  -> native / sendRichMessageDraft

group
  -> edit plain preview
  -> rich final edit

plain config
  -> 现有 edit path，但修复 >4096 preview freeze
```

完成后：

```ts
capabilities.markdown = true
```

应代表 adapter 已经具备真实可靠的 Markdown 渲染能力，而不是只因为请求体多了 `parse_mode`。

---

## Phase 4 — Core generic actions

修改：

```text
packages/channel-core/src/messages.ts
packages/channel-core/src/capabilities.ts
packages/channel-core/src/adapter.ts
packages/channel-core/src/schema.ts   // 若 shape/runtime schema 需要
```

新增：

```text
OutboundAction
OutboundActionRow
OutboundMessage.actions
capabilities.interactiveActions?
ChannelAdapter.edit?()
```

`interaction.received` 已存在，不新增 Harness-specific event。

更新：

```text
channel-testkit
contract fixtures
adapter-authoring.md
```

---

## Phase 5 — Telegram interaction mapper

修改：

```text
packages/channel-telegram/src/upstream.ts
packages/channel-telegram/src/mapper.ts
packages/channel-telegram/src/inbound.ts
packages/channel-telegram/src/outbound.ts
packages/channel-telegram/src/adapter.ts
```

新增：

```text
callback_query -> InteractionReceived
actions -> InlineKeyboardMarkup
answerCallbackQuery best-effort ACK
edit() -> editMessageText / editMessageReplyMarkup
```

注意：

```text
callback_query.data 是不可信输入
```

不要让 adapter 把它解释成 Harness question。

adapter 只输出：

```text
interaction.action = callback_data
```

---

## Phase 6 — 官方 ApiProxy seam 核验（已完成）

向：

```text
deepseek-ai/deepseek-harness
```

核验发布包与官方源码。

目标：

```text
events.mux() 暴露 question/requested + question/resolved
respond() 接受原 question rpcId 的结构化答案
```

验收：

```text
不注册第二个 UserQuestionProvider
Web client 继续工作
channel-harness 只匹配 active ReplyContext
首个 accepted response 获胜
question/resolved 清理另一端陈旧控件
```

当前约束：

```text
只消费公共 ApiProxy client contract，不 import Host 私有源码或实现模块
```

---

## Phase 7 — ChannelQuestionBridge（已完成 offline gate）

修改：

```text
packages/channel-harness/src/plugin.ts
packages/channel-harness/src/lifecycle.ts
packages/channel-harness/src/reply-context-store.ts
packages/channel-harness/src/config.ts
```

新增：

```text
packages/channel-harness/src/channel-question-bridge.ts
packages/channel-harness/test/channel-question-bridge.test.ts
```

Bridge 只对：

```text
active Channel ReplyContext
```

创建 pending question 并发送通用 actions。

---

## Phase 8 — Security integration

修改 Access Controller：

```text
packages/channel-harness/src/access/controller.ts
```

增加：

```text
authorizeInteraction()
```

处理顺序：

```text
Access Gate
-> PendingQuestion exact-match
-> consume
```

同时扩展：

```text
ChannelReplyContext.senderId
```

---

## Phase 9 — Telegram ephemeral question（P1）

完成普通 inline/reply question live gate 后再做：

```text
receiver_user_id
editEphemeralMessageText
editEphemeralMessageReplyMarkup
deleteEphemeralMessage
```

不要阻塞 P0 发布。

---

# 20. 测试计划与强制 Release Gate

以下不是普通“建议测试”，而是 Issue #1 / #2 关闭前的**强制 Release Gate**。

原则：

```text
Buffered 与 Streaming 必须独立验证
完整 Markdown 与 partial Markdown 必须独立验证
格式 fallback 与网络/权限/rate-limit 错误必须独立验证
timeout 与 AbortSignal 必须独立验证
```

---

## 20.1 核心矩阵

| 场景 | Buffered | DM Streaming | Group Streaming |
| --- | --- | --- | --- |
| plain text | MUST | MUST | MUST |
| bold / italic | MUST | MUST | MUST |
| nested list | MUST | MUST | MUST |
| blockquote | MUST | MUST | MUST |
| link | MUST | MUST | MUST |
| fenced code block | MUST | MUST | MUST |
| **unfinished code fence** | N/A | MUST | MUST |
| Markdown table | MUST | MUST | MUST |
| **unfinished table** | N/A | MUST | MUST |
| unfinished link/entity | N/A | MUST | MUST |
| CJK | MUST | MUST | MUST |
| emoji / ZWJ grapheme | MUST | MUST | MUST |
| >4096 | MUST | MUST | MUST |
| >32768 | MUST | MUST | MUST |
| media caption | MUST | N/A | MUST |
| format fallback | MUST | MUST | MUST |
| 429 classification | MUST | MUST | MUST |
| network failure classification | MUST | MUST | MUST |
| final flush | MUST | MUST | MUST |
| abort | MUST | MUST | MUST |

任一 MUST 未通过：

```text
不得把 Issue #1 标记完成
不得升级 Telegram manifest testedVersion
```

---

## 20.2 channel-telegram unit

必须覆盖：

```text
Rich Markdown payload
HTML payload
MarkdownV2 escaping
plain fallback
format error classifier
401/403 不 fallback
429 retry_after
network/5xx 不进入 plain fallback
callback_query mapper
answerCallbackQuery
InlineKeyboardMarkup
callback_data <= 64 bytes
caption formatting
rich 32768 segmentation
regular 4096 segmentation
caption 1024 segmentation
emoji / grapheme
code fence
table
nested list
links
```

额外要求：

```text
fallback 最多执行一次
fallback 后仍失败 -> 返回真实失败
不能产生无限 rich -> plain -> rich 重试循环
```

---

## 20.3 Buffered path

必须单独测试，不允许只通过 Streaming 测试间接覆盖。

链路：

```text
assistant/chunk*
      ↓
ReplyRouter buffer
      ↓
turn/end
      ↓
完整 Markdown
      ↓
renderer
      ↓
safe segment
      ↓
send
```

测试：

```text
无 chunk，仅 assistant/message fallback
大量 chunk 后 turn/end
最终文本为空
代码块
超长代码块
表格
超长表格
列表
引用
链接
CJK
emoji
>4096
>32768
media caption
format failure -> plain
```

重点验证：

```text
turn/end finalFlush 不丢最后一个 throttle window 的内容
```

---

## 20.4 DM Streaming path

目标：

```text
sendRichMessageDraft
      ↓
same draft_id 持续更新
      ↓
sendRichMessage(final)
```

必须覆盖：

```text
每个 delta flush
节流 flush
连续并发 delta
同一 draft_id
30 秒以上 generation
final persist
abort
failure
```

### Partial Markdown Gate

必须刻意构造：

````text
```typescript
function test() {
````

未闭合 code fence。

必须构造：

```text
| A | B |
|---|---
```

未完成 table。

还必须覆盖：

```text
[link](
**bold
<code
emoji ZWJ sequence 的中间 delta
```

验收标准：

```text
任何 partial 状态都不能导致 reply pipeline 永久失败
final 完整内容仍必须正确 Rich render
```

---

## 20.5 Group Streaming path

目标：

```text
placeholder
   ↓
plain edit preview
   ↓
plain edit preview
   ↓
...
   ↓
final complete markdown
   ↓
rich final edit
```

必须验证：

```text
partial code 不触发 Telegram rich parse
partial table 不触发 Telegram rich parse
partial link 不触发 Telegram rich parse
final Rich 成功替换 preview
final Rich 解析失败 -> 同一 message plain final
```

同时修复现有：

```text
>4096 后只显示 chunks[0]
```

导致 preview 看似冻结的问题。

### Rate-limit cooldown gate

`editMessageText` 返回 `429` 不得中断整轮 Agent 回复。必须读取
`parameters.retry_after`，暂停 preview edit，并在内存中只保留 latest full
preview（禁止积压历史 edit）。cooldown 到期时仅 flush 最新值；若 turn 在
cooldown 中结束，则等待后直接 flush final。

验收：

```text
- cooldown 内不得继续撞 edit API
- 不得补发 cooldown 期间的历史 preview
- 不得把 rate-limit Warning 发给最终用户
- Agent generation 继续，最终内容无重复/丢失
```

验收：

```text
模型持续输出时，Telegram preview 必须持续出现可观察变化
```

---

## 20.6 Code Block Gate

普通字符切分：

```text
禁止
```

逻辑：

```text
Markdown AST/tokenizer
      ↓
识别 fenced code block
      ↓
尽量整块保留
```

若单 code block 本身超过平台上限：

````text
```typescript
part 1
```

```typescript
part 2
```
````

要求保留：

```text
language
newline
indentation
fence balance
```

必须测试：

```text
``` inside code content
超长单行代码
CJK comment
emoji comment
无结尾换行
```

---

## 20.7 Table Gate

表格不得 raw substring 生切。

优先：

```text
Markdown table
   ↓
Rich table block
```

超限时：

```text
按完整 row 切分
```

若 Telegram rich/table 限制无法可靠满足：

```text
降级 preformatted/plain table
```

必须保证：

```text
header 不被切断
separator 不被切断
row 不被切成两条消息
```

测试：

```text
普通表格
宽表格
长表格
CJK 表格
代码内容 cell
链接 cell
超出 rich table column limit
```

---

## 20.8 Unicode / grapheme Gate

不能只依赖：

```ts
Array.from(text)
```

作为最终安全分段保证。

测试至少覆盖：

```text
👨‍👩‍👧‍👦
👩🏽‍💻
🇯🇵
variation selector
combining mark
CJK extension characters
```

目标：

```text
不得在用户可见字符中间产生破碎 glyph
```

推荐：

```text
Intl.Segmenter(..., { granularity: 'grapheme' })
```

用于 fallback segmentation。

---

## 20.9 Formatting fallback Gate

必须使用可注入 fake upstream 精确模拟：

```text
rich parse error
HTML entity error
MarkdownV2 parse error
401
403
429
500
network exception
```

验收：

```text
format error -> plain fallback
401         -> fail
403         -> fail
429         -> rate-limit classification
500         -> upstream/retry path
network     -> network/retry path
```

不能出现：

```text
所有 400 -> plain
```

对于 streaming，`429` 还必须通过 Group Streaming 的 cooldown gate；仅完成
错误分类不构成 streaming release gate 通过。

---

## 20.10 User Question timeout / fallback Gate

必须覆盖：

```text
single-select timeout
multi-select timeout
free-text timeout
batched questions timeout
tool AbortSignal
agent cancel
bridge dispose
adapter stop
late callback
late text reply
duplicate callback
```

状态机：

```text
pending
  ├─ answer  -> resolved
  ├─ timeout -> expired
  └─ abort   -> aborted
```

`resolved / expired / aborted` 都是 terminal。

之后的 input：

```text
必须 reject / ignore
不得重新打开 pending
```

timeout 后 UI：

```text
移除按钮
或
标记“已超时”
```

但 UI cleanup 失败不得掩盖原始 `QUESTION_TIMEOUT`。

---

## 20.11 channel-core contract

新增覆盖：

```text
actions serialization
interactiveActions capability
interaction.received fixture
optional edit() contract
```

确保其它 adapter：

```text
不需要实现 Telegram-specific 字段
```

---

## 20.12 channel-harness integration

### Origin routing

最重要的架构回归：

```text
IM-origin turn + ask
  -> Channel Provider

Web-origin turn on same SessionBinding + ask
  -> Web Provider
```

只要第二条被错误发回 IM：

```text
Release Gate FAIL
```

### Identity

```text
正确 sender       -> accept
同群其他 sender   -> reject
其他 conversation -> reject
其他 thread       -> reject
过期 callback     -> reject
重放 callback     -> reject
```

### Question shape

```text
single select
multi select
custom text
free text
batched questions
skip item
plan-review intent
```

### Lifecycle

```text
timeout
tool abort
agent cancel
adapter stop
bridge dispose
session turn end
```

---

# 21. Telegram Live Gate

必须使用真实 Bot 验证，offline fixture 不能替代。

## Rich output

```text
private DM
group
supergroup
forum topic
code block
nested list
table
links
emoji
long CJK
>4096
>32768
media caption
```

## Streaming

```text
private rich draft animation
30 秒以上 generation
final persist
group preview
group final rich edit
>4096 preview 持续变化
```

必须用真实模型式 delta 验证 partial Markdown：

````text
未闭合 ``` code fence
未完成 table
未完成 link
未完成 emphasis
emoji / grapheme 跨 delta
````

目标：

```text
partial preview 不把整条 reply pipeline 打死
final Rich 仍正确
```

## Interaction

```text
single-select inline keyboard
custom ForceReply
multi-select
callback ACK
group sender isolation
timeout
expired button
```

## Failure

```text
故意构造 malformed formatting
验证只在 format error 时降级
429
invalid token
bot removed from group
network interruption
```

---

# 22. Manifest 升级条件

只有满足：

```text
offline contract tests
+ Buffered Gate
+ DM Streaming Gate
+ Group Streaming Gate
+ partial Markdown Gate
+ code block / table Gate
+ timeout / abort Gate
+ Telegram live gate
+ Rich streaming live
+ callback live
+ format fallback classifier live
```

后才修改：

```ts
testedVersion: '10.2'
versionRange: '10.2'
```

并继续保持：

```text
status: experimental
```

直到完整 Telegram live verification gate 被项目 release policy 判定通过。

不要因为“代码用了 10.2 API”就直接把状态改 stable。

---

# 23. Release 切分建议

不要把 #1 / #2 全部塞进一个巨大 PR。

推荐：

### PR 1

```text
chore(channel-telegram): audit Bot API 10.2 and preserve structured errors
```

内容：

```text
manifest audit
TelegramApiError
allowed update primitives
fixtures
```

### PR 2

```text
feat(channel-telegram): add Rich Message rendering and streaming
```

关闭 / 解决 Issue #1 主体。

### PR 3

```text
feat(channel-core): add generic outbound actions
```

只做稳定 contract。

### PR 4

```text
feat(channel-telegram): add inline callback interactions
```

让 Telegram 完成通用 interaction transport。

### Upstream PR（当前不需要）

```text
feat(user-questions): support routed providers with fallback
```

公共 ApiProxy seam 已满足当前需求；仅当上游未来移除/收紧该 client contract 时再评估。

### PR 5

```text
feat(channel-harness): route ask_user_question to channel-origin turns
```

已通过公共 ApiProxy Mux 落地，不注册第二个 Provider。

### PR 6（可选）

```text
feat(channel-telegram): use ephemeral group questions
```

---

# 24. Issue 状态建议

## Issue #1

建议保留原 Issue，但 implementation summary 改为：

```text
Accepted.

Rather than directly forwarding Agent Markdown through Telegram MarkdownV2,
the implementation will target Bot API 10.2 Rich Messages first, with
safe regular-format/plain fallbacks. Streaming, media captions and long-message
segmentation will be covered by the same renderer.
```

完成 PR 2 + live gate 后关闭。

---

## Issue #2

建议更准确地理解为：

```text
ask_user_question is currently owned by the single Web user-question provider,
so IM-origin agent turns have no routed human interaction surface.
```

Issue 不应要求：

```text
每个 adapter 自己接 Harness ask_user_question
```

实现 checklist 应注明：

```text
[x] public ApiProxy question mux
[x] channel-core outbound actions
[x] Telegram callback_query
[x] ChannelQuestionBridge
[x] pending request security
[x] timeout / lifecycle cancel
[ ] live gate
```

---

# 25. 最终目标状态

完成后，整个链路应是：

## Telegram 普通 Agent 回复

```text
Telegram inbound
  -> Channel Contract
  -> Access Gate
  -> Agent
  -> assistant chunks
  -> ReplyRouter
  -> Telegram Rich Draft / Edit
  -> Rich final
```

## Telegram ask_user_question

```text
Telegram inbound
  -> Access Gate
  -> ReplyContext(sender + conversation + turn)
  -> Agent
  -> ask_user_question
  -> UserQuestionService
  -> Host ApiProxy question/requested
  -> ChannelQuestionBridge active ReplyContext match
  -> PendingQuestionStore
  -> Telegram Inline Keyboard / ForceReply
  -> callback_query / reply
  -> InteractionReceived / MessageReceived
  -> Access Gate
  -> exact pending match
  -> AskUserQuestionAnswer
  -> Agent resumes
```

## Web ask_user_question on same bound session

```text
Web turn
  -> no active Channel ReplyContext
  -> ChannelQuestionBridge ignores frame
  -> Web client remains available
```

这条是整个设计是否正确的最终判据。

---

# 26. 架构红线

实现过程中发现以下代码，应直接视为设计退化：

```ts
// ❌ Telegram adapter
ctx.userQuestions.ask(...)

// ❌ Telegram adapter
ctx.agents.get(...)

// ❌ channel-harness
if (channelId === 'telegram') {
  // ask_user_question semantics
}

// ❌ Core
interface TelegramInlineKeyboardButton { ... }

// ❌ callback
JSON.parse(callback_data) // 直接信任客户端 payload

// ❌ route
if (sessionBinding) {
  sendQuestionToChannel()
}

// ❌ formatting
parse_mode: 'MarkdownV2',
text: agentMarkdown
```

正确形式：

```text
Harness semantics     -> channel-harness
generic interaction   -> channel-core
Telegram presentation -> channel-telegram
Bot API HTTP           -> Telegram upstream
```

---

# 27. 执行优先级

建议立即执行顺序：

```text
P0-1  TelegramApiError + Bot API 10.2 drift audit
P0-2  Rich Message renderer
P0-3  DM Rich Draft + Group Rich Final
P0-4  callback_query + generic actions
P0-5  public ApiProxy ChannelQuestionBridge
P0-6  first-response-wins + stale-control cleanup
P0-7  security / timeout / live gate
P1    ephemeral / extra Telegram media & reaction
```

其中：

```text
Issue #1 不依赖 DSH 上游，可先完成。
Issue #2 不需要第二个 Provider 或上游 routed-provider seam；
通过官方 ApiProxy client contract 接入，真实 Bot live gate 仍必须完成。
```

---

# 28. 文档修订记录

## 2026-08-21 — Gate 强化版

相对上一版新增/强化：

```text
1. timeout 从普通测试提升为状态机 Release Gate
2. formatting fallback 增加错误分类 Gate
3. Buffered path 独立验收
4. DM Streaming path 独立验收
5. Group Streaming path 独立验收
6. partial / unfinished Markdown 强制测试
7. fenced code block 强制安全切分
8. Markdown table 强制安全切分/降级
9. Unicode grapheme Gate
10. >4096 streaming preview freeze 修复进入验收
11. finalFlush / AbortSignal / lifecycle cleanup 强制验收
12. Manifest 10.2 升级条件同步收紧
```

这意味着：

```text
“完整代码块最终能发出去”
```

不再足够。

必须证明：

```text
模型正在输出半个代码块/半张表格时也不会破坏 streaming；
最终完成后仍能得到正确 Rich Message。
```

---

# 29. 核验来源

## dsh-channels

- https://github.com/wsz987/dsh-channels
- https://github.com/wsz987/dsh-channels/issues/1
- https://github.com/wsz987/dsh-channels/issues/2
- `packages/channel-telegram/src/adapter.ts`
- `packages/channel-telegram/src/upstream.ts`
- `packages/channel-telegram/src/streaming-reply.ts`
- `packages/channel-telegram/src/mapper.ts`
- `packages/channel-telegram/src/manifest.ts`
- `packages/channel-core/src/adapter.ts`
- `packages/channel-core/src/messages.ts`
- `packages/channel-core/src/events.ts`
- `packages/channel-core/src/capabilities.ts`
- `packages/channel-harness/src/reply-router.ts`
- `packages/channel-harness/src/reply-context-store.ts`
- `packages/channel-harness/src/access/controller.ts`
- `packages/channel-harness/src/plugin.ts`

## DeepSeek Harness 官方

- https://deepseek-harness.github.io/deepseek-harness/reference/
- https://github.com/deepseek-ai/deepseek-harness
- `dsh-v0.1.0-rc.7/packages/interaction/user-questions/src/index.ts`
- `dsh-v0.1.0-rc.7/packages/interaction/tool-ask-user/src/index.ts`
- `dsh-v0.1.0-rc.7/packages/host/apiproxy/tests/api-proxy-question.spec.ts`
- `dsh-v0.1.0-rc.8/packages/interaction/user-questions/src/index.ts`

## Telegram 官方

- https://core.telegram.org/bots/api
- Bot API 10.1 Rich Messages
- Bot API 10.2 Rich Message blocks/media + Ephemeral Messages

---

# 30. 验证声明

本次结论基于：

```text
GitHub 当前 HEAD 源码核验
DeepSeek Harness rc.7 / rc.8 官方源码与文档核验
Telegram Bot API 10.2 官方文档核验
```

本次没有在本地重新运行：

```text
channel-telegram tests
channel-harness tests
真实 Telegram Bot live flow
```

因此：

```text
代码结构 / contract / 必然行为 = 已核验
真实 Bot 网络行为               = 仍需 LIVE-REQUIRED gate
```

实施过程中必须以第 20～22 节测试与 Live Gate 作为关闭 Issue 的条件。
