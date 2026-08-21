# dsh-channels → DeepSeek Harness `dsh-v0.1.1-rc.2` 升级执行方案

> 核验基线：2026-08-22  
> 当前 `dsh-channels`: `0.4.2`  
> 当前 Harness 基线：`0.1.0-rc.7`  
> 目标 Harness：`0.1.1-rc.2`

---

# 1. 最终结论

这次建议按一次 **Harness Integration Boundary 重构** 来升级，而不是依赖升级。

推荐结果：

```text
dsh-channels 0.4.x
        │
        └── Harness 0.1.0-rc.7
             进入 legacy maintenance

dsh-channels 0.5.x
        │
        └── Harness 0.1.1-rc.2+
             新架构
             ↓
     尽量只依赖 Harness Public Service/API
```

我建议：

- `0.4.x` 保持支持 `0.1.0-rc.7`
- 新建 `0.5.0-rc.1`
- `0.5.x` 第一版只声明支持 **精确测试过的 `0.1.1-rc.2`**
- 不建议让同一套业务代码长期同时兼容 rc7 和 rc2
- 如果确实需要过渡兼容，只允许集中在一个 `harness-compat` 层，不允许业务代码到处 `if (version >= ...)`

这是目前对这个项目风险最低、后续维护成本最低的方案。

---

# 2. 为什么这不是普通版本升级

你当前 `@wsz987/channel-harness` 对整套 Harness API 都基于 `0.1.0-rc.7`：

```text
dsh-agent
dsh-agent-default-model
dsh-agent-presets
dsh-attachment
dsh-brand
dsh-commands
dsh-home-paths
dsh-invariants
dsh-llm
dsh-scope
dsh-session
dsh-session-persistence
dsh-system-prompt
dsh-tools
dsh-typert-protocol
```

现在 devDependencies 精确使用 `0.1.0-rc.7`，peerDependencies 则是 `^0.1.0-rc.7`。

目标 tag 的根版本已经是：

```json
{
  "version": "0.1.1-rc.2",
  "engines": {
    "node": "^22.19.0 || >=24.0.0"
  }
}
```



而你项目目前仍是：

```json
"engines": {
  "node": ">=22"
}
```



所以第一项实际 breaking change 就已经不是 TypeScript，而是：

**Node 22.0～22.18 现在不再属于官方 Harness rc.2 支持范围。**

---

# 3. 官方新版里最影响 dsh-channels 的变化

| 领域 | rc.2 官方状态 | 对 dsh-channels 的影响 | 动作 |
|---|---|---|---|
| Node Runtime | `^22.19.0 \|\| >=24` | 当前 `>=22` 太宽 | **必须改** |
| Agent 生命周期 | `create/resume/setup/AgentHandle/cancel/whenIdle` 已形成明确公共边界 | 你的 AgentManager 已基本符合 | **保留** |
| Model Selection | 官方 `installModelSelection` + Host session model API | 你已经部分使用，但复制了 Host API 类型 | **收口** |
| User Questions | 正式有 `UserQuestionService`、Provider、intent | 自己维护的 question schema/wire 状态开始重复 | **重构** |
| Image / Attachment | rc.2 已统一 normalized attachment → request projection → Files/inline fallback | `image-model-fallback.ts` 已经重复甚至改变官方语义 | **删除 modern path** |
| Session | event-sourced + surface + request-header reconstruction + structural metadata | ReplyRouter 应继续读官方事件，不能自己发明历史模型 | **小改/加强测试** |
| Commands | 官方 command registry 已支持图片附件、abort、完整生命周期 | 渠道 command plane 可以进一步直接复用 | **增强** |
| Slash command | 官方 Host 未知 `/foo` 返回 `unknown-command` | 你当前会把未知 slash command 发给模型 | **建议统一** |
| Web Client | dynamic package graph / static ui libraries 重构 | `channel-web` 仍是 rc7 loader 假设 | **必须改** |
| ApiProxy Types | `@deepseek-ai/dsh-host-apiproxy/api` 已公开 | 你仍维护本地 RPC interface | **删除重复类型** |
| Persistence | 当前格式仍是 pre-release，兼容升级由 persistence boundary 控制 | 不能承诺跨 Harness rc 自动读取任意旧格式 | **版本线隔离** |

---

# 4. 第一项应该直接砍掉：`image-model-fallback.ts`

这是本轮最明确的删除项。

你现在的实现监听：

```ts
agentCtx.on('agent/pre-step', ...)
```

发现当前模型不支持图片后，把：

```ts
{ type: 'image' }
```

直接换成：

```ts
'[图片：当前模型不支持查看]'
```

而且这些修改后的 messages 会成为 Session 记录的一部分。

## 4.1 rc.2 官方已经自己解决这个问题

新版官方 Image Pipeline 已经明确：

```text
durable normalized attachment
        ↓
session history 保留 attachment reference
        ↓
request projection
        ├── vision model → request image variant
        └── text-only model → deterministic placeholder
```

而且：

> text-only route receives deterministic attachment placeholders ... while append-only session history keeps the original references.

也就是说：

**图片是否给当前模型看，是 request projection 的问题，不应该破坏持久 Session。**

rc.2 同时已经提供：

- 图片正规化
- 尺寸控制
- 编码转换
- request-specific variant
- 缓存
- DeepSeek Files API
- file_id 复用
- 过期重新上传
- stale file id recovery
- quota cleanup
- Files 出错时 bounded inline fallback
- text-only model placeholder
- nested tool-result image
- compaction 与普通 Agent 共用同一套 projection



## 4.2 执行动作

删除现代 rc.2 路径中的：

```text
image-model-fallback.ts
installImageCompatibility()
ImageCompatibilityMode
agent/pre-step image rewrite
ChannelImageUnsupportedError
UNSUPPORTED_IMAGE_PLACEHOLDER
```

`bridge.ts` 中也删除：

```ts
installImageCompatibility(...)
```

### 保留

`message-converter.ts` 里这个方向是正确的：

```text
渠道下载图片
    ↓
AttachmentStore.saveImage
    ↓
ImageAttachmentRef
    ↓
UserMessage ImageBlock
```

你已经在使用官方 `dsh-attachment` 和 `ImageBlock`。

所以这里应该：

**渠道只负责把原始图片交给 Harness Attachment Store。**

之后：

```text
压缩？
缩放？
模型支持图片？
DeepSeek Files？
inline？
text placeholder？
```

全部交还 Harness。

这是典型的“上游已经提供正确抽象 → 下游删 workaround”。

---

# 5. `ask_user_question`：不能简单把现有 Bridge 全删，但应该重构

这部分需要区分两种运行模式。

官方现在已经正式提供：

```ts
ctx.userQuestions.registerProvider(provider)
ctx.userQuestions.ask(request)
```

请求已经包括：

```ts
{
  id,
  question,
  detail?,
  header?,
  options?,
  multiSelect?,
  intent?
}
```

并且支持：

```text
intent: plan-review
```

以及 Agent 身份、AbortSignal、完整 answer model。

而你现在 `ChannelQuestionBridge` 自己维护：

```text
question/requested schema
question/resolved schema
mux envelope
rpcId
pending map
timeout
client-response
respond()
```



这已经出现重复。

但不能直接做成：

```ts
rootCtx.userQuestions.registerProvider(channelProvider)
```

因为 Web profile 中 **ApiProxy 本身就是 UserQuestion provider**，UserQuestionService 一个 Context 不允许随意叠多个 provider。

因此最佳结构是：

```text
                     ChannelQuestionPresenter
                    /                        \
                   /                          \
       DirectQuestionBackend          ApiProxyQuestionBackend
              │                              │
        ctx.userQuestions             ctx.apiProxy.events.mux
       registerProvider()                     │
              │                        官方 MuxFrame 类型
              │                              │
       Headless / 无 Web               Web profile
```

## 5.1 Web 模式

继续使用 ApiProxy mux 是合理的。

但是必须删掉自己定义的：

```ts
QuestionRequestedSchema
QuestionResolvedSchema
MuxEnvelopeSchema
QuestionResponsePayloadSchema
```

改成直接使用官方：

```ts
@deepseek-ai/dsh-host-apiproxy/api
```

官方已经公开：

```text
MuxFrame
EventsApi
QuestionResponsePayload
RpcRequest
RpcId
```

而且官方 `MuxFrame` 明确包含：

```ts
{
  type: 'question/requested',
  sessionId,
  questions
}

{
  type: 'question/resolved',
  sessionId,
  questionRpcId,
  outcome
}
```



Question answer payload 也已经正式定义。

### Web 模式最后只保留你真正应该拥有的代码

```text
session → channel binding
谁可以回答
Telegram/微信/QQ 按钮怎么画
按钮 callback 怎么转换 answer
multi-select 怎么操作
custom answer
timeout
interaction 去重
渠道消息更新
```

这些才是 Channel 层责任。

## 5.2 Headless / 无 ApiProxy 模式

新增：

```ts
class ChannelUserQuestionProvider
```

直接实现官方 UserQuestion Provider。

这样：

```text
ask_user_question
      ↓
UserQuestionService
      ↓
ChannelUserQuestionProvider
      ↓
TG / WX / Lark...
      ↓
Promise resolve
      ↓
Agent 自动继续
```

不需要模拟 ApiProxy。

## 5.3 一个现有缺失必须补

你当前 question schema 没有完整保留新版：

```ts
intent
```

所以 `plan-review` 这类新版交互意图会被你降成普通问题。

现代 backend 应完整透传 `AskUserQuestionItem`，渠道 presenter 再根据：

```ts
question.intent
```

选择 UI。

---

# 6. `AgentManager`：不要砍，这是目前设计正确的一部分

你当前已经把：

```text
ctx.agents.get
ctx.agents.create
ctx.agents.resume
AgentHandle ownership
dispose
single-flight
concurrency
persistence probe
preset composition
```

收口在 `AgentManager`。

新版官方也明确规定：

```text
ctx.agents.create()
ctx.agents.resume()
CreateAgentOptions.setup()
ResumeAgentOptions.setup()
AgentHandle.dispose()
agent.cancel()
agent.whenIdle()
```



这说明你的方向是对的。

## 保留

```text
AgentManager
owned handles
single-flight
maxConcurrency
binding → SessionId
live borrow
durable session missing 时 fail loudly
dispose ownership
```

这些都是 Channel Integration 层需要的。

## 不要退回

不要因为官方升级又改成：

```text
渠道消息
 ↓
模拟 Web RPC
 ↓
ApiProxy
 ↓
Agent
```

对于 same-process channel plugin，这反而是绕远路。

官方新的 headless 实现自己也直接使用：

```text
ctx.agentDefaultModel
ctx.agents.create
agent.whenIdle
ctx.sessions.flush
```

而不经过 Web transport。

所以你的执行主路径：

```text
Channel → direct Harness Core
```

是正确的。

---

# 7. Agent Preset 这部分也不要砍

你现在 `AgentManager.composePreset()` 会：

```text
resolve preset
mount preset
在 unpublished setup 期间装进去
```

这并不是 workaround。

新版官方甚至专门把 Web `ui-user-questions` 的 Node half 留空，因为：

> `ask_user_question` 是否属于一个 Agent，是 preset / agent capability 的问题，而不是 Web UI 全局能力。



所以你现在：

```text
preset → setup(agentCtx) → mount
```

这个方向继续保留。

特别是 `ask_user_question`：

不能因为渠道能画按钮，就全局给所有 Agent 强塞这个 tool。

---

# 8. Model Selection：保留 Controller，删除自定义 RPC 类型

你现在已经正确使用：

```ts
installModelSelection
ModelSelectionRef
AgentDefaultModelConfig
```



问题主要在这里：

```ts
interface ChannelHostApiProxy
interface ChannelHostApiResult
interface HostModelSelection
```

这些实际上是在复制 Harness ApiProxy contract。

而 rc.2 已经明确发布：

```text
@deepseek-ai/dsh-host-apiproxy/api
```

作为类型/API入口。

所以改成：

```ts
import type {
  ApiProxy,
  ModelSelection,
  ...
} from '@deepseek-ai/dsh-host-apiproxy/api'
```

或只导入真正需要的 public type。

### 最终模式继续保持

```text
Web Host 存在
  → session.models / session.selectModel

Headless / 无 Host
  → installModelSelection(agentCtx)
```

这套 owner distinction 是合理的。

---

# 9. Session / ReplyRouter：大体保留，但必须按 rc.2 新契约补测试

rc.2 Session 已经明确变成：

```text
append-only raw event log
       +
Session Surface
       +
request/header reconstruction
       +
identified/frozen messages
```

并加入：

```ts
sourceEventSeqs?
surfaceOp?
ignorable?
```



你的 ReplyRouter 当前只读：

```text
assistant/chunk
assistant/message
turn/end
```

并且直接消费官方：

```ts
session/event
```

这是正确的。

### 不建议重写 ReplyRouter

但新增以下 contract tests：

```text
append-origin assistant message
assistant chunks + final message
turn error
turn aborted
unknown ignorable event
session/projection 等非文本事件
compaction replacement event
tool event
unload before turn/end
resume 后继续输出
```

### 原则

面向渠道“人类已经看到的历史”：

**不要直接把 `session.surface` 当 transcript。**

官方明确规定：

- model-facing → surface
- human transcript → append-origin events

所以以后如果做：

```text
/history
channel conversation restore
消息同步
```

必须遵守这条边界。

---

# 10. Commands：现有架构保留，但有两个新版能力应该接进来

你的 command plane 已经正确使用：

```ts
ctx.commands.register()
ctx.commands.list()
ctx.commands.find()
ctx.commands.execute()
```



不要再做自己的 CommandRegistry。

## 10.1 新增：Command Image Attachments

新版官方 `commands.execute()` 已经支持：

```text
command definition
  input.images = true
        ↓
commands.execute(agent, line, images, signal)
        ↓
AttachmentStore admission
        ↓
invocation.attachments
```



因此 Channel 侧以后 `/xxx` 携带图片时，不应该：

```text
丢图片
或者把图片变普通 prompt
```

而是把渠道图片转成官方 command image inputs。

这可以列为 P1。

## 10.2 修正未知 slash command 行为

你现在明确写的是：

```text
未注册的 /foo
  ↓
fall through
  ↓
作为普通 prompt 发模型
```



而 rc.2 官方 Host 已经定义：

```text
识别到 slash command
  ├── registered → command
  └── unknown → unknown-command
```

不会发模型。

### 推荐

`0.5.x` 对齐官方：

```text
/foo
→ “未知命令 /foo，输入 /help 查看命令”
```

而不是给 Agent。

这是一个小 breaking UX change，但值得统一。

如果确实担心老用户：

```ts
unknownCommandPolicy?: 'reject' | 'prompt'
```

仅过渡一版，默认：

```text
reject
```

后续删 `prompt`。

---

# 11. `/stop` 不要改

你现在：

```ts
agent.cancel({ kind: 'user' })
```



新版官方定义正是：

```ts
agent.cancel(cause, options?)
```

默认：

- abort 当前 driver
- clear inbox
- clear pending steering

所以 `/stop` 当前语义对。

更重要的是你做的：

```text
/stop 不排队
generation bump
立即 cancel live agent
stop barrier
```

属于 **Channel concurrency policy**。

Harness 不可能替你知道 Telegram 同一 conversation 里的排队关系。

所以这部分继续保留。

---

# 12. `channel-web` 是本次第二个真正需要重构的地方

你的 `channel-web` 目前 manifest：

```json
"dsh": {
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-primitives"
    ]
  }
}
```



但 rc.2 已经重新明确 Client package 分类：

```text
static assembly libraries:
  cordis
  ui-primitives
  ui-slots

dynamic client packages:
  runtime
  ui-renderer
  theme
  feature plugins
```

其中：

**`ui-primitives` / `ui-slots` 不应该作为 dynamic graph rows。**



所以当前：

```json
"dsh.client.inject": [
  "...ui-primitives"
]
```

需要删。

---

# 13. `channel-web/build.mjs` 也属于 rc7 技术债

你目前手动：

```text
esbuild CJS
       ↓
window.__ModuleLoader__.load({
  id,
  factory(require)
})
```

并硬编码 external：

```text
react
react/jsx-runtime
dsh-client-ui-primitives
```



rc.2 已经重新定义：

```text
dynamic bundle
static shell identities
module graph
PRELOADED_CLIENT_EXTERNALS
package requests
```

所以不能再假设：

> bare `ui-primitives` 一定由 ModuleLoader 动态注册。

### 推荐改法

不要把整个前端重写。

保留：

```text
ChannelsSection
ChannelAccess
ChannelAuth
ChannelSetup
ChannelRow
channelRegistry
API client
locale
```

只替换 **build / package boundary**。

目标：

```text
channel-web source
     ↓
rc.2 compatible dynamic client artifact
     ↓
lib/client.js
```

优先采用与官方 feature client package 相同的：

```text
tsdown / official dynamic build form
```

如果官方没有把其 build preset 作为公共 package 导出：

**不要复制整个 Harness 内部 build script。**

只维护最小的本地 wrapper，然后给 artifact 做 contract test。

---

# 14. `channel-web` 的依赖最终应类似

概念上：

```json
{
  "peerDependencies": {
    "@deepseek-ai/cordis": "...",
    "@deepseek-ai/dsh-client-runtime": "...",
    "@deepseek-ai/dsh-client-locale": "...",
    "@deepseek-ai/dsh-client-ui-settings": "..."
  },

  "devDependencies": {
    "@deepseek-ai/dsh-client-ui-primitives": "...",
    "@deepseek-ai/dsh-client-ui-slots": "...",
    "react": "..."
  }
}
```

其中：

- dynamic package dependency → peer + dev
- static UI library → dev compilation input
- React → shell-owned static runtime identity
- 不再把 `ui-primitives` 写进 `dsh.client.inject`

官方 `ui-settings` 自己也是类似分层：动态依赖写 `dsh.client.inject`，而 `ui-slots` 仅作为 dev input。

---

# 15. `check:upstream` 目前也应该一起修

你现在：

```text
GET registry.npmjs.org/<pkg>/latest
```

然后用 `latest` 判断 Harness 有没有 drift。

这个策略对成熟 stable dependency 可以。

但对当前 Harness preview 不合适。

官方社区最近已经出现 `@deepseek-ai/dsh-*` 的 npm `latest` dist-tag 停留旧 prerelease wave、导致安装关系异常的问题。

## 改为两个概念

```text
supported baseline
≠
npm latest
```

建议：

```text
HARNESS_TESTED_VERSION = 0.1.1-rc.2
```

CI 检查：

```text
所有 Harness package
     ↓
必须存在 0.1.1-rc.2
     ↓
dev dependency 必须统一
     ↓
peer compatibility 必须包含 tested version
```

另设非阻塞：

```text
check:harness-newer
```

提示：

```text
rc.3 已发布，尚未验证
```

而不是自动认为：

```text
新版本 == 兼容版本
```

---

# 16. Harness peerDependencies 不建议继续用宽 `^`

当前：

```json
"@deepseek-ai/dsh-agent": "^0.1.0-rc.7"
```

在一个明确声明允许 breaking change 的 Developer Preview 项目里，意义并不好。

官方自己就明确写了：

> THERE WILL BE COMPATIBILITY-BREAKING CHANGES.



## `0.5.0-rc.1` 推荐先这样

```json
"peerDependencies": {
  "@deepseek-ai/dsh-agent": "0.1.1-rc.2",
  ...
},

"devDependencies": {
  "@deepseek-ai/dsh-agent": "0.1.1-rc.2",
  ...
}
```

等 `rc.3` 真正跑完你的 compatibility suite 后：

```json
"0.1.1-rc.2 || 0.1.1-rc.3"
```

而不是：

```json
^0.1.1-rc.2
```

这叫：

**tested compatibility band。**

对于快速变化的 pre-release plugin ecosystem，比宽 semver 更可靠。

---

# 17. 旧 Harness 用户怎么兼容

## 推荐方案：版本线兼容，不是运行时兼容

### Legacy

```text
dsh-channels 0.4.x
Harness 0.1.0-rc.7
```

继续可安装，不再加入新 Harness 功能。

只处理：

```text
critical bug
security
channel upstream 紧急兼容
```

### Modern

```text
dsh-channels 0.5.x
Harness 0.1.1-rc.2+
```

所有新开发进入这里。

这是最推荐方案。

---

# 18. 如果你一定要让一个版本同时跑 rc7 + rc2

只允许新增：

```text
packages/channel-harness/src/compat/
```

例如：

```text
compat/
├── index.ts
├── types.ts
├── rc7.ts
└── rc11.ts
```

对业务只暴露：

```ts
interface HarnessCompat {
  questions: QuestionBackend
  modelSelection: ModelSelectionBackend
  images: ImagePolicy
  api: HarnessApiTypes
}
```

启动阶段只做一次 capability detection：

```text
有新的 userQuestions/public API？
  ↓
rc11 adapter

否则
  ↓
rc7 adapter
```

### 严禁

```ts
if (harnessVersion < ...) // bridge.ts

if (harnessVersion < ...) // reply-router.ts

if (...) // model-selection.ts

if (...) // question bridge

if (...) // web
```

一旦版本判断散进去，半年以后这个项目会变成兼容矩阵地狱。

---

# 19. 还有一个值得补的新版功能：Approval

rc.2 官方 ApiProxy mux 不只有：

```text
question/requested
question/resolved
```

还已经正式包含：

```text
approval/requested
approval/resolved
```



所以 Question 重构时不要再命名成只处理 question 的巨大模块。

建议内部逐步抽象：

```text
HumanInteractionBroker
        │
        ├── QuestionInteraction
        │
        └── ApprovalInteraction
```

Telegram：

```text
是否允许执行 xxx？

[允许]
[拒绝]
```

Lark/DingTalk/QQ 同样走 adapter capabilities。

这比以后再建第二套 approval bridge 更合理。

P1 做即可，不阻塞 rc.2 第一版。

---

# 20. 推荐最终架构

```text
                    Channel Adapter
       TG / WX / QQ / Lark / DingTalk
                           │
                           ▼
                    channel-core
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
 Access Gate        Interaction Broker    Message Converter
                           │                  │
                  question / approval         │
                                              ▼
                                      AttachmentStore
                                              │
                                              ▼
Channel Session Factory ───────────────► AgentManager
                                              │
                           ┌──────────────────┼─────────────┐
                           │                  │             │
                           ▼                  ▼             ▼
                     ctx.agents       dsh-commands    ModelSelection
                           │
                           ▼
                     Harness Agent
                           │
                 official Session events
                           │
                           ▼
                      ReplyRouter
                           │
                           ▼
                     Channel Adapter
```

关键原则：

```text
Channel owns:
- identity
- binding
- access
- presentation
- channel delivery
- concurrency
- interaction routing

Harness owns:
- agent lifecycle primitive
- model request
- session semantics
- attachments
- image transforms
- command registry
- model capability
- question domain model
- presets
```

---

# 21. 文件级执行清单

## P0-1 — Harness baseline

修改：

```text
package.json
packages/channel-harness/package.json
packages/channel-web/package.json
其他直接引用 dsh-* 的 package
pnpm-lock.yaml
```

目标：

```text
0.1.1-rc.2
```

同时：

```json
"engines": {
  "node": "^22.19.0 || >=24.0.0"
}
```

---

## P0-2 — 删除旧 image compatibility

删除或 legacy-only：

```text
packages/channel-harness/src/image-model-fallback.ts
```

删除：

```text
bridge.ts installImageCompatibility()
imageCompatibility config
相关 tests
```

新增官方 rc.2 image integration tests。

---

## P0-3 — Question Backend 重构

当前：

```text
ChannelQuestionBridge
```

拆：

```text
interactions/
├── question-presenter.ts
├── question-state.ts
├── question-backend.ts
├── question-apiproxy-backend.ts
└── question-direct-backend.ts
```

Web：

```text
ApiProxy backend
```

Headless：

```text
UserQuestionProvider backend
```

同时完整支持：

```text
detail
header
options
multiSelect
intent
custom
abort
```

---

## P0-4 — 删除 Host RPC 重复类型

修改：

```text
model-selection.ts
channel-question-bridge.ts
其他 ApiProxy consumer
```

统一从：

```text
@deepseek-ai/dsh-host-apiproxy/api
```

获得 contract type。

---

## P0-5 — Session compatibility

保留：

```text
ReplyRouter
AgentManager
binding store
```

新增 rc.2 fixture tests：

```text
surfaceOp
sourceEventSeqs
ignorable
aborted turn
error turn
replacement event
resume
```

---

## P0-6 — channel-web 动态包迁移

修改：

```text
packages/channel-web/package.json
packages/channel-web/build.mjs
packages/channel-web/src/client/index.ts
```

重点：

```text
移除 ui-primitives dynamic inject
按 rc.2 graph 声明真正 dynamic dependencies
static UI dependencies 进入 devDependency
重新验证 lib/client.js artifact
```

---

## P0-7 — Command parity

修改：

```text
bridge.ts
commands/*
```

目标：

```text
unknown slash → reject
known slash → commands.execute
```

不要给模型吃未知 `/command`。

---

## P0-8 — upstream CI 重构

把：

```text
npm latest == target
```

改成：

```text
testedVersion == target
```

增加：

```text
pnpm check:harness-compat
pnpm check:harness-newer
```

---

# 22. P1 新能力

第一版稳定后增加：

### P1-1

Channel command image attachments。

### P1-2

`question.intent = plan-review` 渠道原生 UI。

### P1-3

`approval/requested`：

```text
允许 / 拒绝
```

渠道交互。

### P1-4

基于 Adapter capabilities 的统一：

```text
buttons
multiSelect
edit
native streaming
file/image
approval
question
```

避免 Harness Bridge 判断：

```ts
if (channel === 'telegram')
```

---

# 23. PR 拆分建议

不要一次 PR 改完。

推荐：

```text
PR-1 chore(harness): align rc.2 runtime and dependency baseline

PR-2 refactor(harness): adopt official rc.2 image pipeline

PR-3 refactor(harness): modernize user-question integration

PR-4 refactor(harness): use official ApiProxy public contracts

PR-5 fix(harness): align session and command semantics

PR-6 refactor(web): migrate client package to rc.2 module graph

PR-7 feat(channel): support modern question intents and command images

PR-8 chore(release): add compatibility matrix and 0.5 release line
```

这样每次出现回归都知道是哪一个上游边界造成的。

---

# 24. CI Compatibility Matrix

`0.5.x` 至少跑：

| 场景 | 必测 |
|---|---|
| Harness | `0.1.1-rc.2` |
| Node | `22.19.x` |
| Node | `24.x` |
| Fresh Session | ✓ |
| Persisted Resume | ✓ |
| Missing persisted binding | ✓ |
| `/new` | ✓ |
| `/stop` while streaming | ✓ |
| unknown slash | ✓ |
| `/model` | ✓ |
| reasoning effort | ✓ |
| `ask_user_question` | ✓ |
| question multi select | ✓ |
| question custom answer | ✓ |
| plan-review intent | ✓ |
| image → vision model | ✓ |
| image → text-only model | ✓ |
| DeepSeek Files path | ✓ |
| attachment fallback | ✓ |
| streamed reply | ✓ |
| buffered reply | ✓ |
| edit reply | ✓ |
| Web plugin boot | ✓ |
| Settings → Channels | ✓ |

渠道至少 smoke：

```text
Telegram
Weixin
QQ
Lark
DingTalk
```

---

# 25. 发布策略

建议：

```text
0.4.2
├── legacy
└── Harness rc7

0.5.0-rc.1
├── next
└── Harness 0.1.1-rc.2

0.5.0
└── 等完整 integration suite 通过
```

CHANGELOG 明确写：

```text
BREAKING:
- Minimum Harness: 0.1.1-rc.2
- Minimum Node: 22.19
- Unknown slash commands are no longer sent to the model
- Legacy image compatibility hook removed
- Web client requires rc.2 client module graph
```

---

# 26. 哪些现有代码最后应该留下

## 明确保留

```text
AgentManager
ChannelSessionFactory
SessionBindingStore
ReplyRouter
ReplyContextStore
Access Gate
ChannelWorkspaceResolver
Channel Outbox
send_channel_message
adapter capability model
per-conversation serialization
/stop fast path
command factories
channel file private storage
message → official UserMessage conversion
```

## 重构后保留

```text
ChannelQuestionBridge
→ Interaction Presenter + backends

ChannelModelSelectionController
→ 使用官方 ApiProxy types

channel-web
→ 业务 UI 保留，build boundary 更换
```

## modern path 删除

```text
image-model-fallback.ts
自定义 text-only image rewrite
Question RPC Zod protocol clone
ChannelHostApiProxy 手写类型
旧 client inject 假设
对 npm latest 的 Harness 兼容判断
```

---

# 27. 不建议做的方案

### 不要

```text
直接 pnpm update
修到能编译
发布
```

因为最危险的问题都不会是编译错误。

例如：

```text
图片 durable history 被你提前降级
question intent 被 schema 静默剥离
旧 client graph 能 build 但 runtime fail
unknown slash 行为和官方不一致
npm latest 指错版本
```

都可能 TS 全绿。

### 也不要

为了“兼容用户”写：

```text
几十个 runtime version branches
```

长期来看比让用户停留 `0.4.x` 更差。

---

# 28. 最终推荐等级

| 方案 | 评价 |
|---|---|
| 直接 bump rc.2 | ❌ |
| rc7/rc2 全业务双兼容 | ❌ |
| 永久维护 compatibility shim | ❌ |
| `0.4 legacy + 0.5 rc2` | **✅ 最佳** |
| rc.2 优先官方 public API | **✅** |
| 删除 image workaround | **✅ 强烈建议** |
| Question Web 仍走官方 ApiProxy transport | **✅** |
| Question Headless 直接 Provider | **✅** |
| AgentManager 改成 ApiProxy 驱动 | ❌ |
| 保留 AgentManager direct core integration | **✅** |
| client-web 按新版 package graph 改 | **✅ 必须** |
| 精确测试 Harness prerelease | **✅** |

---

# 29. 完成定义

只有满足下面条件才算这次升级完成：

- [ ] 所有 Harness dev dependency 对齐 `0.1.1-rc.2`
- [ ] peer compatibility 不再声称未经验证的 rc
- [ ] Node runtime 与官方 rc.2 对齐
- [ ] 删除 modern `image-model-fallback`
- [ ] text-only 图片行为由 Harness 官方 pipeline 控制
- [ ] DeepSeek vision/Files 路径无需 channel 特判
- [ ] Question 使用官方 domain model
- [ ] Web question backend 不再复制官方 schema
- [ ] Headless 可直接提供 UserQuestion provider
- [ ] 支持 `intent`
- [ ] ModelSelection 使用官方 ApiProxy API 类型
- [ ] Unknown slash 不再进入 LLM
- [ ] ReplyRouter 通过 rc.2 Session fixtures
- [ ] `channel-web` 按 rc.2 module graph 启动
- [ ] `ui-primitives` 不再作为 dynamic inject
- [ ] `check:upstream` 不再把 npm `latest` 当 Harness compatibility truth
- [ ] rc7 用户继续可使用 `0.4.x`
- [ ] 新版发布为 `0.5.x`
- [ ] CHANGELOG 明确列出 breaking changes

---

# 30. 架构判断

升级之后，`dsh-channels` 最合理的定位不是：

> “给 Harness 补缺失功能的一套兼容框架”

而应该收缩成：

> **DeepSeek Harness 的 multi-channel transport / presentation integration layer。**

Harness 负责 Agent、Session、LLM、Attachment、Command、Question domain。

你负责：

```text
IM identity
channel binding
access control
channel-native interaction
stream rendering
media intake
delivery
channel lifecycle
```

这样 Harness 后面再迭代时，你需要跟进的只剩少数几个 public integration seam，而不是继续追它内部实现。

这也是我认为这次 `0.5.x` 最重要的目标。