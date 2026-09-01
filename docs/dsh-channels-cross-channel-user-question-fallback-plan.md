---
title: Harness ask_user_question 跨渠道交互兜底与原生按钮补齐执行方案
summary: 修复 Telegram 之外渠道在 Harness ask_user_question / 选择题场景下无提示、无法回答或会话表现卡住的问题；先在 channel-harness 建立统一文本降级，再按 QQ / DingTalk / Lark 官方能力逐步补齐原生按钮，Weixin 保持文本兜底。
when_to_use: ask_user_question | 用户问题 | 选择题 | 交互按钮 | 微信无响应 | QQ 按钮 | 钉钉卡片 | 飞书卡片 | Telegram ForceReply
status: proposed
baseline_repository: https://github.com/wsz987/dsh-channels
baseline_branch: main
baseline_commit: 7bc064dabb36ccf15d3eb0af06667515ca8c99f0
baseline_date: 2026-08-24
harness_baseline: 0.1.1-rc.2
see_also:
  - docs/architecture.md
  - docs/architecture/common-design.md
  - docs/security/inbound-access-control.md
  - docs/compatibility-matrix.md
  - .agents/skills/dsh-channels-verification/SKILL.md
---

# Harness `ask_user_question` 跨渠道交互兜底与原生按钮补齐执行方案

## 0. 结论先行

当前问题不是 Weixin 单渠道 bug，而是 `channel-harness` 的**问题展示准入条件过窄**：

```ts
const adapter = this.options.getAdapter(binding.channelId);
if (!adapter?.capabilities.interactiveActions) return false;
```

这意味着：

- Telegram：`interactiveActions: true`，能正常接管 Harness `ask_user_question`；
- Weixin / QQ / DingTalk / Lark：当前都没有声明 `interactiveActions: true`，因此问题在真正展示之前就被拒绝；
- 但 `ChannelQuestionPresenter` 后面其实已经具备文本答案处理能力，包括数字选项、选项文本、自定义文本、`跳过`；这些代码对非按钮渠道目前基本不可达；
- Web/ApiProxy 模式下，`ApiProxyQuestionBackend` 对 `questionRequested() === false` 不做取消，因为理论上 Web 仍可回答，因此纯渠道用户看到的是“Agent 正在等问题，但渠道上没有问题可答”；
- headless/direct 模式下则会直接以 `ASK_ABORTED` 结束该问答。

**修复原则：**

> `interactiveActions` 只能决定“展示质量”，不能决定“渠道有没有资格回答 Harness 问题”。只要渠道 `text: true`，就必须至少能通过编号/文字回复完成 `ask_user_question`。

因此推荐分两层落地：

1. **P0：统一文本兜底（必须先做）**
   - 落在 `channel-harness`，一次修复 Weixin / QQ / DingTalk / Lark；
   - Telegram 原生按钮保持不变；
   - 非按钮渠道把选项渲染成 `1. xxx / 2. xxx`，用户回复数字、选项文本或自定义内容；
   - 多选支持 `1,3`；
   - 群聊不能只依赖平台 `replyTo`，增加短关联码兜底；
   - `/stop`、`/new` 等 slash command 继续不被问题回答逻辑吞掉。

2. **P1/P2：按官方 SDK 能力补齐原生按钮**
   - QQ：当前固定的官方 SDK `@tencent-connect/qqbot-nodejs@1.0.4` 已原生支持 inline keyboard + `interaction` 事件，优先补；
   - Lark/Feishu：当前固定的 `@larksuiteoapi/node-sdk@1.73.0` 已包含 `cardAction` / `card.action.trigger` 能力，项目当前 driver 没接；
   - DingTalk：当前官方 `dingtalk-stream` 已提供 `TOPIC_CARD = /v1.0/card/instances/callback`，项目当前只监听 `TOPIC_ROBOT`；
   - Weixin：当前 Tencent `openclaw-weixin` / iLink 2.4.6 路径没有发现可直接映射到项目 `interactiveActions` 的原生按钮契约，**不要造私有协议**，长期使用统一文本兜底即可。

---

# 1. 核验基线与事实等级

本方案按仓库 `.agents/skills/dsh-channels-verification/SKILL.md` 的事实等级区分：

- `CODE-CONFIRMED`：当前 `dsh-channels/main` 代码直接确认；
- `OFFICIAL-CONFIRMED`：渠道官方 SDK / 官方示例确认；
- `LIVE-REQUIRED`：必须真实 Bot / App 验证；
- `DRIFT`：当前项目能力声明与官方 SDK 已具备能力之间存在差距。

核验基线：

```text
dsh-channels main
commit: 7bc064dabb36ccf15d3eb0af06667515ca8c99f0
Harness: 0.1.1-rc.2
date: 2026-08-24
```

架构红线继续保持：

```text
adapter -> channel-core
upstream driver -> official SDK / protocol
channel-harness -> channel-core + Harness public API
bundle -> plugin composition only
```

不得出现：

```ts
if (channelId === 'weixin') ...
if (channelId === 'qq') ...
```

问题展示策略必须继续通过 `adapter.capabilities` 协商。

---

# 2. 当前 Harness 问题链路

当前链路是：

```text
Harness Agent
  -> ask_user_question
  -> @deepseek-ai/dsh-user-questions
  -> QuestionInteractionBackend
       ├─ Web profile: ApiProxyQuestionBackend
       └─ Headless:    DirectQuestionBackend
  -> ChannelQuestionPresenter.questionRequested()
  -> SessionBinding / active ReplyContext
  -> ChannelAdapter.send()
  -> 用户回答
       ├─ interaction.received
       └─ message.received
  -> ChannelQuestionPresenter
  -> backend.resolve()
  -> Harness Agent 继续执行
```

这个分层本身是正确的，不需要推翻。

## 2.1 当前正确的地方

`ChannelQuestionPresenter` 已经遵守项目架构：

- 不读取平台 raw payload；
- 不 import Telegram / QQ / DingTalk / Lark SDK；
- 不按 channel id 分支；
- Harness wire/domain 细节被封装在 `QuestionInteractionBackend`；
- pending state 独立在 `QuestionStateStore`；
- `interaction.received` 和 `message.received` 都能作为回答入口；
- answer 仍使用 Harness 官方 `AskUserQuestionAnswerItem`。

这些都应保留。

## 2.2 当前真正的 P0 缺陷

### 缺陷 A：非按钮渠道在展示前就被拒绝

文件：

```text
packages/channel-harness/src/interactions/question-presenter.ts
```

当前：

```ts
const adapter = this.options.getAdapter(binding.channelId);
if (!adapter?.capabilities.interactiveActions) return false;
```

应改为：

```ts
const adapter = this.options.getAdapter(binding.channelId);
if (!adapter || !adapter.capabilities.text) return false;

const presentationMode =
  adapter.capabilities.interactiveActions === true
    ? 'actions'
    : 'text';
```

即：

```text
text=true              => 至少能回答
interactiveActions=true => 在 text 基础上升级为原生按钮体验
```

### 缺陷 B：现有文本解析逻辑存在，但被准入 gate 挡住

当前 `handleMessage()` 已经能处理：

```text
2        -> 第 2 个选项
pnpm     -> 精确匹配选项 label
跳过     -> skip
任意文本 -> custom
```

所以 P0 不应该另起一套 Weixin 问答系统，而是把现有 generic presenter 补完整。

### 缺陷 C：选项只有带 description 时才会输出编号文本

当前 `renderQuestion()`：

```ts
if (question.options?.some((option) => option.description)) {
  lines.push(...question.options.map(...));
}
```

这在按钮模式尚可，但一旦做文本降级会成为严重 bug：

```text
是否执行？

[options: 执行 / 修改 / 放弃]
```

如果三个选项都没有 description，非按钮渠道会看不到选项列表。

必须改成：

> **只要存在 options，就永远渲染编号列表。description 只是附加说明，不是是否显示选项的条件。**

### 缺陷 D：multiSelect 的纯文本路径当前不正确

当前逻辑对多选文本：

```text
输入 "1"
-> optionFromText 找到 option
-> 因为 multiSelect=true，不进入单选分支
-> 最后把 "1" 当 custom
```

P0 必须新增独立的文本答案解析器。

### 缺陷 E：群聊文字回答目前硬依赖 `promptMessageId + replyTo`

当前：

```ts
if (
  pending.target.conversationType === 'group' &&
  (!pending.promptMessageId || event.message.replyTo !== pending.promptMessageId)
) {
  return false;
}
```

Telegram 有 ForceReply + reply-to 映射，所以这条路径合理；但不能假设 QQ / DingTalk / Lark 或未来 Weixin 群聊都能稳定提供同样的 reply 关联。

因此必须保留 native `replyTo` 快路径，同时增加**平台无关短关联码**作为兜底。

---

# 3. 五渠道当前支持矩阵

| 渠道 | 当前项目 `interactiveActions` | 当前项目问答表现 | 官方平台/SDK能力 | 结论 |
|---|---:|---|---|---|
| Telegram | `true` | 按钮 + callback；文本问题可 ForceReply | Bot API 原生 inline keyboard / callback query / ForceReply | `CODE-CONFIRMED`：完整原生路径，保留 |
| Weixin | 未声明 | `questionRequested()` 直接拒绝，渠道无问题可答 | 当前 Tencent iLink/OpenClaw 参考实现未发现通用按钮回调 contract | `CODE-CONFIRMED` + `OFFICIAL-CURRENT-GAP`：P0 用文本兜底，不造按钮协议 |
| QQ | 未声明 | 当前无法接管选择题 | 固定 SDK 1.0.4 已有 `sendTextWithKeyboard`、`interaction`、`acknowledgeInteraction` | `DRIFT`：项目没把 SDK 已有能力暴露到 Channel Contract |
| DingTalk | 未声明；`cards:true` | 当前无法接管选择题 | `dingtalk-stream` 有 `TOPIC_CARD`，官方互动卡片支持 Stream callback | `DRIFT`：项目有卡片发送/流式，但没接交互回调 |
| Lark/Feishu | 未声明；`cards:true` | 当前无法接管选择题 | 固定 SDK 1.73.0 已有 `cardAction` / `card.action.trigger` / V2 callback button | `DRIFT`：当前 driver 只注册 `im.message.receive_v1` |

## 3.1 Telegram — 当前完整

当前：

```ts
interactiveActions: true
```

`OutboundMessage.actions`：

```text
-> InlineKeyboardMarkup
-> callback_data
-> callback_query
-> interaction.received
```

`OutboundMessage.replyPrompt`：

```text
-> ForceReply
```

因此 Telegram 不需要降级掉原生体验。

P0 改完后应形成：

```text
Telegram options      -> actions mode
Telegram custom/text  -> replyPrompt / ForceReply
```

## 3.2 Weixin — 必须有文本兜底

当前 adapter capability：

```text
text=true
cards=false
threads=false
interactiveActions=undefined
streaming=buffered
```

当前 `send()` 只映射：

```text
text
image
file
video
```

没有 `OutboundMessage.actions -> 平台 callback` 的实现。

Tencent `openclaw-weixin` 当前参考实现同样以 direct text/media 为主，没有发现可以直接复用为 Channel Contract `interactiveActions` 的通用按钮能力。

因此：

> Weixin 不应该为了 `ask_user_question` 阻塞等待 WebUI，也不应该先造一个非官方按钮协议。统一文本问题是正确的生产路径。

目标 UX：

```text
请选择包管理器：

1. npm（推荐）
2. pnpm
3. yarn

回复序号或选项文字；也可以直接输入自定义答案。
回复“跳过”可跳过本题。
```

用户：

```text
2
```

Harness 收到：

```ts
{ id: 'pkg_mgr', selected: ['pnpm'] }
```

## 3.3 QQ — 官方 SDK 已支持，项目没接

项目 manifest 当前固定：

```text
@tencent-connect/qqbot-nodejs@1.0.4
```

官方 SDK 1.0.4 已公开：

```ts
bot.sendTextWithKeyboard(target, text, keyboard)

bot.on('interaction', async (ctx, event) => {
  event.data.resolved.button_id
  event.data.resolved.button_data
  await bot.acknowledgeInteraction(event.id, 0)
})
```

QQ 平台要求 interaction 约 5 秒内 ACK。

但项目当前 `QQSdkClient` seam 只有：

```ts
onReady
onResumed
onError
onMessage
sendText
sendMedia
openStream
```

缺少：

```text
onInteraction
sendTextWithKeyboard
acknowledgeInteraction
```

所以这是非常明确的 adapter implementation gap。

**推荐：P0 文本兜底先覆盖，随后 QQ 作为第一个 native-actions 增强。**

## 3.4 DingTalk — `cards:true` 不等于 `interactiveActions:true`

当前项目已有：

```text
AI Card create/update/streaming
cards=true
```

但当前 Stream driver 只注册：

```ts
registerCallbackListener(TOPIC_ROBOT, ...)
```

官方 `dingtalk-stream` 当前导出：

```ts
TOPIC_ROBOT = '/v1.0/im/bot/messages/get'
TOPIC_CARD  = '/v1.0/card/instances/callback'
```

钉钉官方互动卡片示例使用：

```ts
client
  .registerCallbackListener(TOPIC_ROBOT, onBotMessage)
  .registerCallbackListener(TOPIC_CARD, onCardCallback)
  .connect();
```

并通过：

```ts
client.socketCallBackResponse(event.headers.messageId, response)
```

响应卡片 callback。

所以 DingTalk 的平台能力是存在的，但当前项目还没有把它映射成：

```text
OutboundMessage.actions
<->
interaction.received
```

## 3.5 Lark / Feishu — 固定 SDK 已具备 cardAction

项目固定：

```text
@larksuiteoapi/node-sdk@1.73.0
```

当前项目 `LarkSdkUpstream` 的 `EventDispatcher` 只注册：

```text
im.message.receive_v1
```

而当前官方 SDK 已有：

```text
card.action.trigger
normalizeCardAction
channel.on('cardAction', ...)
```

官方 Channel 文档还明确要求：

```text
卡片按钮不响应：
1. 检查 card.action.trigger 订阅
2. 检查使用 V2 card schema
3. button behaviors 使用 callback value
```

这里不要直接把项目整个替换成 SDK 的高层 `createLarkChannel()`：

> 高层 Channel 还带自己的 safety / policy / normalization；本项目 Access Control 的权威边界在 `channel-harness`，不能把 ACL 语义搬到平台 SDK。

正确做法是：

- 保留现有 `LarkSdkUpstream`；
- 在现有 `EventDispatcher` 上补 `card.action.trigger`；
- 使用 SDK 官方 `normalizeCardAction`（若稳定 export）或以官方类型做窄 zod mapper；
- 输出 canonical `interaction.received`；
- Access Gate 仍由 `channel-harness` 统一执行。

---

# 4. P0 统一文本降级设计

## 4.1 不新增 Harness 私有协议

P0 不改：

```text
@deepseek-ai/dsh-user-questions
ApiProxy mux
UserQuestionProvider
AskUserQuestionAnswer
```

只调整：

```text
Harness question domain
        ↓
ChannelQuestionPresenter
        ↓
capability-driven presentation
        ├─ actions
        └─ text
```

## 4.2 Presentation Mode

新增内部类型即可，不需要把它做成公共 Channel Contract：

```ts
type QuestionPresentationMode = 'actions' | 'text';
```

选择规则：

```ts
function questionPresentationMode(adapter: ChannelAdapter): QuestionPresentationMode {
  return adapter.capabilities.interactiveActions === true
    ? 'actions'
    : 'text';
}
```

准入规则：

```ts
if (!adapter || !adapter.capabilities.text) return false;
```

不要写任何 channel id。

## 4.3 `replyPrompt` 保留为 best-effort，不作为可用性前提

`channel-core` 已经有：

```ts
replyPrompt?: {
  kind: 'text';
  placeholder?: string;
}
```

其设计本来就是：

```text
adapter 有原生能力 -> 映射原生 reply UI
没有              -> 普通文本照常发送
```

因此 P0 **不需要再增加一个微信专用 capability**。

关键改变是：

> 不再把 `result.messageId + replyTo` 当成群聊文本回答的唯一关联手段。

Telegram 可以继续利用 ForceReply；其他渠道即使忽略 `replyPrompt`，文字提示仍完整可用。

## 4.4 文本渲染必须自包含

无论 options 有没有 description，统一输出：

```text
**包管理器**
你希望用哪个包管理器？

1. npm（推荐）
   Node 自带，无需额外安装
2. pnpm
   安装速度快、节省磁盘
3. yarn
   经典选择

回复 1 / 2 / 3，或直接回复选项文字。
也可以直接输入自定义答案。
回复“跳过”可跳过本题。
```

对于没有 description：

```text
是否执行计划？

1. 执行
2. 需要修改
3. 放弃

回复 1 / 2 / 3。
```

对于 `plan-review`：

```text
**计划评审**
...

1. 执行（推荐）
2. 需要修改
3. 放弃
```

注意：

- “推荐”只是 presentation cue；
- answer 编码仍然是 Harness 原始 label；
- 不把 `intent` 改写进协议。

## 4.5 单选文本解析

抽成纯函数，避免 presenter 继续膨胀：

建议新文件：

```text
packages/channel-harness/src/interactions/question-text-answer.ts
```

接口建议：

```ts
type ParsedQuestionTextAnswer =
  | { kind: 'skip' }
  | { kind: 'selected'; labels: string[] }
  | { kind: 'custom'; text: string }
  | { kind: 'invalid'; reason: string };

export function parseQuestionTextAnswer(
  question: AskUserQuestionItem,
  rawText: string,
): ParsedQuestionTextAnswer;
```

单选规则：

```text
"1"          -> options[0]
"pnpm"       -> exact label
"跳过"       -> skip
"跳过本题"   -> skip
其他非空文本   -> custom
```

不要做模糊匹配，防止把普通句子误选成 option。

## 4.6 多选文本解析

P0 最低支持：

```text
1,3
1，3
1 3
```

输出：

```ts
{
  id: question.id,
  selected: [options[0].label, options[2].label],
}
```

规则：

- 去重；
- 按 options 原始顺序输出，不按用户输入顺序；
- 任一序号越界 -> 返回 invalid，并提示重新输入，不直接取消整个 ask；
- 单个精确 label 也允许作为一个选项；
- 未匹配到合法 option 的普通文本 -> custom。

P1 可扩展组合写法：

```text
1,3; 其他: Bun
```

映射成：

```ts
{
  id,
  selected: ['npm', 'yarn'],
  custom: 'Bun',
}
```

但这不是 P0 阻塞项。

---

# 5. 群聊/线程的安全关联设计

## 5.1 为什么不能只靠 `replyTo`

平台能力并不一致：

```text
Telegram -> ForceReply + reply_to_message 很稳定
其他渠道 -> 当前 adapter 未统一保证 outbound messageId + inbound replyTo
```

所以 P0 必须有平台无关关联方式。

## 5.2 为每一道文字问题生成短关联码

在 pending state 增加：

```ts
replyToken?: string;
presentationMode: 'actions' | 'text';
```

建议每一道题重新生成：

```text
Q-A13F7C
```

它不是鉴权 token，只是**用户意图/路由关联码**；真正授权仍由 Access Gate + `allowedSenderId` 完成。

群聊文本展示：

```text
请选择：
1. A
2. B
3. C

请直接回复本消息；如果当前渠道无法关联回复，请发送：
Q-A13F7C 2
```

## 5.3 群聊接受顺序

`handleMessage()`：

```text
1. Access Gate 已通过
2. conversationKey 命中 pending
3. senderId == allowedSenderId
4. slash command -> 不消费
5. 若 DM -> 直接解析
6. 若 group/thread：
   a. event.message.replyTo == pending.promptMessageId -> 接受
   b. 否则找到 pending.replyToken 前缀 -> 接受并剥离 token
   c. 否则 return false
```

支持：

```text
Q-A13F7C 2
Q-A13F7C: 2
@机器人 Q-A13F7C 2
```

不应把关联码当 secret，也不要记录完整用户 answer 到普通日志。

## 5.4 `requireMention` 不要被绕过

当前 bridge 顺序：

```text
normalize
-> Access / Activation Gate
-> questionPresenter.handleChannelEvent()
-> command / ordinary Agent routing
```

保持不变。

也就是说：

- 群策略要求 @bot 时，文字问答仍必须满足现有 activation；
- `replyToken` 只负责 pending question correlation，不负责 Authorization/Activation；
- 不允许 adapter 在 Access Gate 之前直接 resolve Harness question。

---

# 6. P0 文件级执行清单

## P0-1 — 修正 question admission

修改：

```text
packages/channel-harness/src/interactions/question-presenter.ts
```

完成：

- 删除 `!interactiveActions => false`；
- `text !== true` 才视为无法承接；
- 保存 `presentationMode`；
- info 日志增加：

```ts
{
  sessionId,
  channel,
  questionCount,
  presentationMode,
}
```

不要记录问题正文/答案。

## P0-2 — 增加纯文本 answer parser

新增：

```text
packages/channel-harness/src/interactions/question-text-answer.ts
packages/channel-harness/test/question-text-answer.test.ts
```

覆盖：

```text
single numeric
single exact label
single custom
skip
multi 1,3
multi 1，3
multi 1 3
duplicate index
out-of-range
empty
```

## P0-3 — 重构 renderer 为 actions/text 双模式

建议新增纯 rendering helper：

```text
packages/channel-harness/src/interactions/question-renderer.ts
```

职责：

```text
AskUserQuestionItem + presentation state
-> OutboundMessage
```

不要放：

```text
adapter.send
backend.resolve
session lookup
platform-specific payload
```

规则：

- options 永远有编号文本；
- actions mode 附加 `OutboundMessage.actions`；
- text mode 不附 actions；
- 需要纯文本输入时可继续附 `replyPrompt`，它只是 best-effort hint；
- text mode 提供数字/多选/skip 指令；
- Markdown 只是源文本，adapter 自己决定是否渲染/降级。

如果不想额外拆文件，最低可留在 presenter，但从长期维护看 renderer + parser 都是纯逻辑，拆出来更符合当前 `backend / presenter / state` 的分层。

## P0-4 — pending state 加 presentation/correlation

修改：

```text
packages/channel-harness/src/interactions/question-state.ts
```

增加：

```ts
presentationMode: 'actions' | 'text';
replyToken?: string;
```

在每次 `advance()` 后：

```text
selected.clear()
awaitingCustom=false
promptMessageId=undefined
replyToken=重新生成
```

防止上一题延迟回复误答下一题。

## P0-5 — 修正 group text correlation

修改：

```text
packages/channel-harness/src/interactions/question-presenter.ts
```

把当前硬条件：

```text
必须 replyTo promptMessageId
```

改成：

```text
replyTo 命中 OR replyToken 命中
```

DM 不要求 token。

## P0-6 — 无效多选不要取消整个问题

对于：

```text
0
9
1,99
```

推荐行为：

```text
发送："选项无效，请回复 1-3；多选可回复 1,3。"
保持 pending
重置 timeout 或保持原 timeout（二选一，建议保持原 timeout，避免恶意无限续期）
```

不要：

```text
backend.cancel()
```

只有 send/backend 真正失败、timeout、external settlement 才结束。

## P0-7 — 修正文档里的 backend decline 语义

修改：

```text
packages/channel-harness/src/interactions/question-backend.ts
packages/channel-harness/src/interactions/question-direct-backend.ts
```

把文档里的：

```text
non-interactive adapter -> decline
```

改成：

```text
adapter absent / text unsupported -> decline
```

这是重要的“代码即文档”同步。

---

# 7. P0 测试矩阵

## 7.1 `question-presenter.test.ts`

现有测试不要删，新增一个 `TextQuestionAdapter`：

```ts
readonly capabilities = {
  text: true,
  interactiveActions: false,
  ...
};
```

或者把 `QuestionAdapter` 做参数化：

```ts
setupPresenter({ interactiveActions: false })
```

必须新增：

### T1 非交互 adapter 能接管问题

```text
interactiveActions=false
-> questionRequested accepted
-> adapter.sent.length === 1
-> actions === undefined
-> 文本包含全部编号 options
```

### T2 options 无 description 也必须显示

输入：

```text
执行 / 需要修改 / 放弃
```

断言：

```text
1. 执行
2. 需要修改
3. 放弃
```

### T3 Weixin-like DM 数字回答

```text
send question
user -> "2"
backend -> selected=[option2]
```

### T4 label 回答

```text
user -> "pnpm"
```

### T5 custom 回答

```text
user -> "bun"
```

### T6 multi-select

```text
user -> "1,3"
selected=[1,3]
```

### T7 multi-select 越界保持 pending

```text
user -> "1,9"
-> channel 提示无效
-> responses 仍为 0
-> 第二次 "1,2" 可成功
```

### T8 batch questions

```text
Q1 -> 2
Q2 -> custom text
-> 一次完整 AskUserQuestionAnswer
```

### T9 plan-review text fallback

确认：

```text
intent/detail/header 都展示
approve option 不改协议 label
```

### T10 slash command 不被 pending question 吞掉

```text
pending question
user -> /stop
presenter.handleChannelEvent -> false
bridge /stop fast path 仍执行
```

### T11 group native reply correlation

保留当前：

```text
replyTo == promptMessageId
```

### T12 group token correlation

```text
unrelated -> false
"Q-XXXX 2" -> true
```

### T13 wrong sender

```text
allowedSenderId != event.sender.id
-> 不 resolve
```

### T14 external settlement

继续确认：

```text
Web 先回答
-> channel pending 清理
-> 后续数字不被吞
```

### T15 timeout

text mode 同样：

```text
-> cancel
-> 用户看到问题已超时
```

## 7.2 Direct backend

新增验证：

```text
text-only adapter questionRequested=true
-> DirectQuestionBackend 不触发 ASK_ABORTED
-> 用户文本答案 resolve provider promise
```

## 7.3 ApiProxy backend

验证：

```text
text-only adapter
-> mux question/requested 可被渠道展示
-> client-response 回传 answer
```

保留：

```text
真正没有 binding / adapter 时返回 false
-> Web 仍可作为外部回答面
```

---

# 8. P1 — QQ 原生按钮补齐

优先级：**P1，第一个 native adapter**。

原因：当前固定 SDK 已经直接提供需要的 API，改动最小。

## 8.1 扩展 `QQSdkClient` seam

修改：

```text
packages/channel-qq/src/sdk-client.ts
```

新增窄接口：

```ts
onInteraction(handler: (event: QQInteractionLike) => void): void;

sendTextWithKeyboard(
  target: QQReplyTarget,
  text: string,
  keyboard: QQInlineKeyboardLike,
): Promise<unknown>;

acknowledgeInteraction(id: string, code: number): Promise<unknown>;
```

Production wrapper：

```ts
this.bot.on('interaction', ...)
this.bot.sendTextWithKeyboard(...)
this.bot.acknowledgeInteraction(...)
```

Fake 同步补齐测试。

## 8.2 Outbound `actions` -> QQ inline keyboard

修改：

```text
packages/channel-qq/src/outbound.ts
```

新增纯 mapper：

```text
OutboundActionRow[]
-> QQ InlineKeyboard
```

建议映射：

```text
action.id    -> button_id / button_data 中至少一个稳定回传
label        -> render_data.label
style        -> QQ render style（只能映射平台确实支持的 style）
```

不要把 Harness rpcId 直接暴露；继续使用 `QuestionStateStore.bindAction()` 生成的 opaque `uq_*` id。

## 8.3 inbound interaction -> canonical event

在 adapter lifecycle 注册：

```text
onInteraction
-> 先快速 ACK
-> normalize sender / conversation / action
-> ctx.emit({ type: 'interaction.received', ... })
```

ACK 必须在平台时限内完成，不等待 Harness answer resolve。

Access Control 仍由：

```text
channel-harness.enforceInteractionAccessGate()
```

执行。

## 8.4 capability

只有实现 + contract tests 完成后才设置：

```ts
interactiveActions: true
```

## 8.5 QQ intents

项目 verification skill 已提示当前 QQ SDK 默认 `FULL_INTENTS`。

既然要正式消费 interaction，P1 一并明确：

```text
GROUP_AND_C2C
INTERACTION
+ 当前真实需要的其它 intent
```

不要继续依赖 SDK `FULL_INTENTS` 默认值。

这是权限最小化和稳定性的顺手修复。

---

# 9. P1/P2 — Lark / Feishu 原生按钮

建议排在 QQ 之后。

## 9.1 不替换整个 adapter

不要：

```text
直接用 createLarkChannel() 接管整条消息/ACL pipeline
```

原因：项目的统一 Access Gate 是安全红线。

## 9.2 在现有 EventDispatcher 增加 card action

修改：

```text
packages/channel-lark/src/lark-sdk-upstream.ts
```

现有：

```ts
'im.message.receive_v1'
```

增加：

```ts
'card.action.trigger'
```

优先复用官方 SDK export 的：

```text
normalizeCardAction
```

如果该 export 在包发布产物中不稳定，则在本 adapter 用官方类型 + zod 建窄 mapper，不复制整套 high-level Channel。

## 9.3 Outbound actions 使用 V2 card

`OutboundMessage.actions` 映射为官方 V2 interactive card callback buttons。

不要复用“只做 AI streaming 的纯文本卡片”去假装按钮已经实现；需要明确 action card renderer。

## 9.4 callback 即时响应

平台 callback handler 应快速返回/ACK，例如 toast：

```text
已收到
```

Harness resolve 可以异步继续。

## 9.5 平台配置/live gate

必须真实核验：

```text
card.action.trigger event subscription
应用版本发布生效
卡片 V2 schema
机器人发送卡片权限
DM / group 点击
错误/重连后 callback 仍可收到
```

全部通过后才设置：

```ts
interactiveActions: true
```

---

# 10. P1/P2 — DingTalk 原生按钮

## 10.1 复用官方 `TOPIC_CARD`

项目当前已经有 `DingTalkStreamClient.registerCallbackListener()` 这个合适的 seam，无需换 driver。

修改：

```text
packages/channel-dingtalk/src/stream-upstream.ts
```

增加：

```ts
registerCallbackListener(TOPIC_CARD, ...)
```

官方常量：

```text
/v1.0/card/instances/callback
```

## 10.2 卡片创建必须走互动 callback 配置

按官方互动卡片要求核验：

```text
callbackType = STREAM
创建卡片的 client-id == Stream client-id
同一 client-id 不并行跑多个 Stream consumer
```

## 10.3 Callback mapper

平台 callback：

```text
user / conversation / card action params
-> canonical InteractionReceived
```

与 Telegram / QQ 一样：

```text
platform ack first
ctx.emit second
Harness Access Gate third
QuestionPresenter resolve fourth
```

## 10.4 `cards:true` 与 `interactiveActions:true` 分开

不要因为现在已有 `cards:true` 就直接把 `interactiveActions` 改 true。

语义必须保持：

```text
cards=true
  = 能显示/更新 card

interactiveActions=true
  = OutboundMessage.actions 能 round-trip 回 interaction.received
```

只有完整 round-trip + live gate 后再开启。

---

# 11. Weixin 的最终定位

当前阶段明确：

```text
Weixin:
  text fallback = supported
  native interactive actions = not claimed
```

不要做：

- 从 OpenClaw runtime 抄 approval capability；
- 在 `channel-harness` 写 `if (weixin)`；
- 依赖平台 raw 字段做 Harness answer；
- 因为没有按钮就让 `ask_user_question` 退回 Web-only；
- 在没有官方/稳定上游契约前造一套“微信按钮 callback”。

后续 Tencent iLink 如果正式提供结构化 action，再走正常 adapter 升级流程：

```text
官方 contract
-> upstream/port
-> fixture
-> adapter mapper
-> interaction.received
-> interactiveActions=true
-> live verification
```

---

# 12. 失败与降级语义

## 12.1 不支持按钮不是错误

```text
interactiveActions=false
```

必须解释成：

```text
用 text presentation
```

而不是：

```text
reject Harness question
```

## 12.2 真正无法展示才 decline

只有：

```text
active reply context 不存在
binding 不存在
adapter 不存在
adapter text=false
同 conversation 已有另一个 pending question
```

才允许 `questionRequested() -> false`。

## 12.3 send failure

```text
adapter.send(question) throws
-> cancel 当前 question
-> backend.cancel
-> 不杀 question backend/mux loop
```

保留现有策略。

## 12.4 native actions 未来运行期失败

P1 原生按钮上线后，第一版不建议对所有 `CHANNEL_SEND_FAILED` 自动再发一次文本，避免网络错误造成重复消息。

如果后续确有需求，应引入明确错误语义，例如：

```text
CHANNEL_UNSUPPORTED / interaction-unavailable
```

只对“交互能力不可用”降级到 text；认证/网络/限流仍正常报错。

---

# 13. 日志与可观察性

新增结构化日志，但不打答案正文。

展示：

```ts
logger.info('[channel-harness] presenting user question on channel', {
  sessionId,
  channel,
  questionCount,
  presentationMode: 'actions' | 'text',
});
```

文本解析失败：

```ts
logger.debug('[channel-harness] invalid text answer for pending question', {
  channel,
  conversationType,
  reason: 'option-out-of-range',
});
```

严禁：

```text
raw user answer
question detail 全文
platform raw callback
replyToken 当认证凭据记录
```

`replyToken` 不是 secret，但也没必要进普通 info 日志。

---

# 14. 文档同步

P0 完成后同步：

## `docs/architecture/common-design.md`

补：

```text
Harness question presentation：
interactiveActions -> native actions
otherwise text -> numbered fallback
```

并更新 `ChannelEvent` “当前实际实现”描述；Telegram 已经有 `interaction.received`，之后 QQ/Lark/DingTalk 会逐步增加。

## `docs/compatibility-matrix.md`

把当前：

```text
ask_user_question = offline covered
```

细化成渠道矩阵：

```text
Telegram: actions + text
Weixin: text
QQ: text / native pending
DingTalk: text / native pending
Lark: text / native pending
```

## `.agents/skills/dsh-channels-verification/*`

更新能力矩阵，避免后续 Agent 再把：

```text
cards=true
```

误认为：

```text
interactiveActions=true
```

## README

用户向能力表建议写：

```text
Harness 选择题/确认问题：全部内置渠道支持；支持原生按钮的渠道优先显示按钮，其余自动降级为编号文字回复。
```

只有 P0 真正全渠道测试绿后再写。

---

# 15. Changeset / 版本语义

P0 属于行为修复 + 通用能力补齐：

建议：

```text
@wsz987/channel-harness: patch
@wsz987/channel-core: 不需要 bump（若 Contract 无变化）
@wsz987/dsh-channels: patch（按当前 lockstep/runtime release 规则）
```

如果 P1 为 QQ/Lark/DingTalk 增加新的 contract capability 声明但不改变公共类型：

```text
对应 adapter: minor 或 patch 取决于当前项目 changeset 约定
bundle: 同步
```

若实际新增 Channel Contract 字段/错误码，再单独评估 `channel-core` bump；**P0 推荐避免为了这个问题扩大公共 API。**

---

# 16. 推荐实施顺序

```text
P0-A  修 questionRequested admission
P0-B  renderer 永久输出编号 options
P0-C  新增 question-text-answer parser
P0-D  multi-select 文字解析
P0-E  group replyToken fallback
P0-F  presenter/backend tests
P0-G  五 adapter fake/integration smoke
P0-H  docs + changeset

P1-A  QQ native keyboard + interaction + ACK + minimal intents
P1-B  QQ live gate

P2-A  Lark V2 card action + card.action.trigger
P2-B  Lark live gate

P2-C  DingTalk TOPIC_CARD + interactive card callback
P2-D  DingTalk live gate

Weixin native actions：等待官方稳定 contract；文本模式即正式支持方案
```

P0 不应等待 P1/P2。

---

# 17. 发布前 smoke 场景

对五个渠道统一执行 Harness 提示：

```text
我要创建一个 Node.js 项目，如果有多个方案请先问我，不要自行决定。
```

确保 Agent 真正触发：

```text
ask_user_question
```

## Telegram

期望：

```text
[ npm ]
[ pnpm ]
[ yarn ]
```

点击后 Agent 继续。

Custom 时 ForceReply 正常。

## Weixin

期望：

```text
1. npm
2. pnpm
3. yarn
```

回复：

```text
2
```

Agent 继续，**不需要打开 Harness Web**。

再测纯文本问题：

```text
项目放在哪里？
```

回复路径后 Agent 继续。

## QQ

P0：编号文本必须可用。

P1 后：优先按钮；按钮点击 ACK + Agent 继续；人为关闭/不满足 interaction 配置时至少 P0 仍是可验证基线。

## DingTalk

P0：编号文本。

P2 后：互动卡片 callback round-trip。

## Lark

P0：编号文本。

P2 后：V2 card button + `card.action.trigger` round-trip。

## 通用额外测试

每个渠道至少：

```text
单选
多选
自定义文本
跳过
连续两题
超时
/stop while question pending
错误 sender
重新启动/断线后的 stale question 清理
```

---

# 18. Definition of Done

P0 完成必须满足：

- [ ] `ChannelQuestionPresenter` 不再以 `interactiveActions` 作为 question admission 条件
- [ ] 所有 `text:true` adapter 至少得到文字问题
- [ ] options 无 description 也始终显示编号
- [ ] 单选数字回答正常
- [ ] 单选 label 回答正常
- [ ] custom 回答正常
- [ ] multi-select `1,3` 正常
- [ ] `跳过` 正常
- [ ] batch questions 正常
- [ ] `plan-review` 不丢 `intent/detail/header`
- [ ] DM 不需要平台 reply correlation
- [ ] group 支持 `replyTo` 或短 token correlation
- [ ] wrong sender 不能回答
- [ ] `/stop` / slash command 不被 pending question 吞掉
- [ ] timeout / abort / external settlement 正常清理
- [ ] Direct backend 在 text-only adapter 下不再 `ASK_ABORTED`
- [ ] ApiProxy 模式 text-only adapter 可从渠道完成回答
- [ ] Telegram 现有 inline button + ForceReply 回归全绿
- [ ] Weixin fake/live smoke：不打开 WebUI 也能完成选择题
- [ ] QQ / DingTalk / Lark P0 文本 smoke 通过
- [ ] `pnpm build`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm ci:check`
- [ ] docs + changeset 同步

Native actions 只有分别完成 round-trip + live gate 后才允许：

```ts
interactiveActions: true
```

---

# 19. 不建议的替代方案

## 方案 A：给 Weixin 单独写 `ask_user_question`

拒绝。

原因：

- 破坏 Core/Harness channel-neutral 设计；
- QQ/Lark/DingTalk 仍有同一个问题；
- 后续新增渠道还会再踩一次。

## 方案 B：所有渠道都必须先实现按钮才支持 Harness question

拒绝。

原因：

- `ask_user_question` 的业务本质是“获得用户答案”，不是“必须按钮”；
- 纯文本是 IM 最低共同能力；
- 平台按钮权限/事件配置远比纯文本脆弱；
- 会让 Harness domain 能力错误依赖 UI carrier。

## 方案 C：不支持按钮时让用户去 WebUI 回答

不作为默认行为。

Web 可以作为另一个客户端，但 IM channel 自己必须是完整入口；否则用户看到的就是“Agent 没反应”。

## 方案 D：直接在 adapter 内 resolve Harness question

拒绝。

Adapter 不能 import Harness Agent/UserQuestion API；也不能绕过 `channel-harness` Access Gate。

---

# 20. 最终架构形态

目标最终应是：

```text
                         Harness ask_user_question
                                   │
                                   ▼
                        ChannelQuestionPresenter
                                   │
                        capability negotiation
                                   │
                ┌──────────────────┴──────────────────┐
                │                                     │
                ▼                                     ▼
       interactiveActions=true                text=true fallback
                │                                     │
       native action buttons                   numbered plain text
                │                                     │
       interaction.received                    message.received
                │                                     │
                └──────────────────┬──────────────────┘
                                   ▼
                         same pending state machine
                                   │
                                   ▼
                          backend.resolve(answer)
                                   │
                                   ▼
                           Harness Agent resumes
```

渠道层最终矩阵：

```text
Telegram   native actions + text fallback
QQ         native actions + text fallback      (P1)
Lark       native actions + text fallback      (P2)
DingTalk   native actions + text fallback      (P2)
Weixin     text fallback                       (official stable path)
```

这符合当前项目最重要的边界：

> **Harness 决定“为什么要问、答案是什么”；`channel-harness` 决定如何在统一 Channel Contract 上展示/收集；adapter 只负责把 generic message/action 映射成平台能力。**

---

# 21. 核验来源

## dsh-channels 当前实现

- `packages/channel-harness/src/interactions/question-presenter.ts`
- `packages/channel-harness/src/interactions/question-state.ts`
- `packages/channel-harness/src/interactions/question-backend.ts`
- `packages/channel-harness/src/interactions/question-direct-backend.ts`
- `packages/channel-harness/src/interactions/question-apiproxy-backend.ts`
- `packages/channel-harness/test/question-presenter.test.ts`
- `packages/channel-core/src/capabilities.ts`
- `packages/channel-core/src/messages.ts`
- `packages/channel-telegram/src/adapter.ts`
- `packages/channel-telegram/src/outbound.ts`
- `packages/channel-weixin/src/adapter.ts`
- `packages/channel-qq/src/adapter.ts`
- `packages/channel-qq/src/sdk-client.ts`
- `packages/channel-qq/src/outbound.ts`
- `packages/channel-dingtalk/src/adapter.ts`
- `packages/channel-dingtalk/src/stream-upstream.ts`
- `packages/channel-lark/src/adapter.ts`
- `packages/channel-lark/src/lark-sdk-upstream.ts`
- `docs/security/inbound-access-control.md`
- `.agents/skills/dsh-channels-verification/SKILL.md`

## QQ 官方 SDK

- https://github.com/tencent-connect/qqbot-nodejs
- https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md

已核验固定版本：`1.0.4`。

关键能力：

```text
sendTextWithKeyboard
interaction event
acknowledgeInteraction
INTERACTION intent
```

## DingTalk 官方 SDK / 示例

- https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs
- https://github.com/open-dingtalk/dingtalk-card-examples

关键能力：

```text
TOPIC_CARD=/v1.0/card/instances/callback
registerCallbackListener(TOPIC_CARD, ...)
socketCallBackResponse(...)
callbackType=STREAM
```

## Lark / Feishu 官方 SDK

- https://github.com/larksuite/node-sdk
- https://github.com/larksuite/node-sdk/blob/main/docs/channel.md

已核验 package 当前为 `1.73.0`，与项目 manifest pin 一致。

关键能力：

```text
card.action.trigger
cardAction
normalizeCardAction
V2 callback button behaviors
```

## Weixin 当前上游参考

- https://github.com/Tencent/openclaw-weixin
- https://github.com/Tencent/openclaw-weixin/issues/201

Issue #201 也验证了这一类 UX 风险：当渠道不能承接交互/审批而核心在等待外部 UI 时，微信用户会感知为渠道冻结/无响应。对本项目而言，正确修复不是照搬 OpenClaw approval，而是保证 Harness question 在 Channel Contract 上始终存在文本回答通道。
