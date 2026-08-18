# dsh-channels Slash Commands 最终执行文档

> 适用项目：`wsz987/dsh-channels`  
> 目标包：`packages/channel-harness`  
> 当前 Harness 基线：`0.1.0-rc.6`  
> 目标：补齐渠道侧 Human Command Plane，同时尽量完全复用 DeepSeek Harness 官方机制，不自造第二套命令、模型或 Session 控制体系。

---

## 1. 最终设计结论

本轮只新增 5 个渠道核心指令，加上已有 `/new`：

| 指令 | 行为 | 是否 Channel 自己实现 |
|---|---|---|
| `/stop` | **立即终止当前执行，优先级最高** | 是 |
| `/new` | 新建当前渠道会话 | 已实现 |
| `/help [command]` | 查看当前 Agent 实际生效的命令 | 是 |
| `/status` | 查看当前 Session / Agent / Model 状态 | 是 |
| `/models [provider]` | 查看 Harness 当前注册 Provider / Model | 是 |
| `/model [provider model [effort]]` | 查看或切换当前 Session 模型 | 是 |

Harness 插件已经提供的：

```text
/compact
/goal
/feedback
/plan
...
```

**不重新实现。**

只要宿主加载相应插件，并注册进同一个 `ctx.commands`，渠道自动获得这些命令。

官方 `CommandRuntime` 本身就是“global command + agent scoped command”的统一注册表。Agent scope 会 shadow global，同 scope 同名注册直接报 duplicate，因此不需要 reserved-name、数字 priority 或额外的防覆盖系统。

---

## 2. 最终消息分发模型

正常消息：

```text
Channel Adapter
      │
      ▼
ChannelBridge
      │
      ├─ /stop ? ────────────────► STOP FAST PATH
      │
      ▼
conversation serial chain
      │
      ▼
parseCommand(text)
      │
      ├─ 注册命令
      │      │
      │      ▼
      │  commands.execute()
      │      │
      │      └─ CommandResult → 直接回复渠道
      │
      └─ 未注册 / 普通文本
             │
             ▼
         agent.followup()
             │
             ▼
            Model
```

核心原则：

> **注册命令走 Human Command Plane；未注册 slash command 不再被渠道插件拦截，而是作为普通用户输入交给模型。**

官方 `commands.execute()` 对语法不匹配或未知名称返回 `undefined`，不会把它误认为一次已经执行的 command。

---

## 3. `/stop`：最高执行优先级

这是本次最重要的改动。

### 3.1 正确的 Harness 停止 API

直接使用官方：

```ts
agent.cancel({ kind: 'user' })
```

不要：

```ts
agent.cancel({ kind: 'user' }, { keepInbox: true })
```

`cancel()` 默认会：

- 中止当前 active turn；
- AbortSignal 传递到 model request；
- 传递到 tool execution；
- 传递到 prompt assembly / hook 等支持取消的环节；
- 清空 Agent inbox；
- 清空 pending steering。

官方取消属于 cooperative cancellation：支持 AbortSignal 的 LLM、工具、hook 能迅速停止；完全忽略 signal 的进程内工作可能仍需自行结算。

---

## 4. 为什么 `/stop` 不能只注册成普通 Command

你当前 Bridge 对同 conversation 使用串行 Promise chain。

假设：

```text
消息 A
消息 B
/stop
```

如果三个消息都进入普通 chain：

```text
A
↓
B
↓
/stop
```

那么 `/stop` 根本不能做到立即停止。

因此：

> `/stop` 的**命令语义**仍属于 Harness CommandRuntime，但 `/stop` 的**调度时机**必须由 ChannelBridge 做 Fast Path。

两件事不要混在一起。

---

## 5. `/stop` Fast Path

在进入普通 conversation chain **之前**检查：

```ts
const parsed = parseCommand(text)

if (parsed?.name === 'stop') {
  return this.handleImmediateStop(event, text)
}
```

注意不要：

```ts
parseCommand(text.trim())
```

要保持 Harness 官方 slash-command parser 语义。

官方 parser 要求 `/` 从第一个字符开始，并保留后续原始 `rawInput`。

---

## 6. `/stop` 还需要 Generation Barrier

仅仅绕过 chain 调用：

```ts
agent.cancel()
```

还不够。

例如：

```text
A 已经进入 Agent
B 还停留在 Bridge chain
C 还停留在 Bridge chain

/stop
```

`agent.cancel()` 可以终止 A。

但 B / C 之后如果继续执行：

```ts
agent.followup(...)
```

它们会重新唤醒 Agent。

因此 ChannelBridge 增加：

```ts
private readonly conversationGenerations = new Map<string, number>()
```

辅助函数：

```ts
private generationOf(key: string): number {
  return this.conversationGenerations.get(key) ?? 0
}

private bumpGeneration(key: string): number {
  const next = this.generationOf(key) + 1
  this.conversationGenerations.set(key, next)
  return next
}

private isGenerationCurrent(key: string, generation: number): boolean {
  return this.generationOf(key) === generation
}
```

---

## 7. 普通消息进入 chain 时捕获 generation

例如：

```ts
const key = conversationKey(...)
const generation = this.generationOf(key)

this.enqueueConversation(key, async () => {
  if (!this.isGenerationCurrent(key, generation)) {
    return
  }

  // resolve binding
  // resolve/create agent
  // execute command ...

  if (!this.isGenerationCurrent(key, generation)) {
    return
  }

  agent.followup(message)
})
```

至少检查：

### 第一次

刚进入 chain callback。

用于快速丢弃已经被 `/stop` 作废的排队任务。

### 第二次

真正调用：

```ts
agent.followup()
```

之前。

用于处理执行过程中 `/stop` 到达的竞态。

---

## 8. `/stop` 到达后的处理

收到：

```text
/stop
```

立即：

```ts
this.bumpGeneration(key)
```

这一步应该在任何 await 之前完成。

然后：

```ts
const binding = await bindingStore.get(key)

if (binding) {
  const agent = agentManager.getLiveAgent(binding.sessionId)

  if (agent) {
    agent.cancel({ kind: 'user' })
  }
}
```

然后尽快返回用户：

```text
已停止当前任务。
```

**不要等待：**

```ts
await agent.whenIdle()
```

以后才回复用户。

`whenIdle()` 可以用于内部 drain / disposal，但不是 `/stop` 用户反馈的前置条件。

---

## 9. Stop Barrier：处理 `/new` 等竞态

还有一个特殊竞态：

```text
/new 正在执行
      ↓
/stop 到达
      ↓
旧 binding 被 cancel
      ↓
/new 创建了新 session
      ↓
新 session 继续存在
```

因此 `/stop` 除了 Immediate Cancel，还应往原 conversation chain 尾部插入一个内部 barrier。

形式：

```ts
void this.enqueueConversation(key, async () => {
  const latestBinding = await bindingStore.get(key)

  if (!latestBinding) return

  const latestAgent =
    agentManager.getLiveAgent(latestBinding.sessionId)

  latestAgent?.cancel({ kind: 'user' })
})
```

最终：

```text
/stop
 │
 ├─ bump generation
 │
 ├─ immediate cancel
 │
 ├─ immediate acknowledgement
 │
 └─ stop barrier
       │
       ▼
  当前已有 chain work 收敛
       │
       ▼
  再读取最新 binding
       │
       ▼
  必要时再次 cancel
```

这样 `/stop` 才能覆盖：

- 正在回答；
- 正在调用 Tool；
- 已经 queue 的消息；
- Bridge 内尚未投递的旧消息；
- `/new` 与 `/stop` 竞争产生的新 Agent。

---

## 10. `/stop` 仍然正式注册为 Harness Command

新增：

```text
packages/channel-harness/src/commands/stop.ts
```

建议：

```ts
import type {
  CommandDefinition,
} from '@deepseek-ai/dsh-commands'

export function createStopCommand(): CommandDefinition {
  return {
    name: 'stop',
    description: 'Stop the current task immediately',

    handler(invocation) {
      if (invocation.rawInput.trim().length > 0) {
        return {
          kind: 'error',
          text: 'Usage: /stop',
        }
      }

      invocation.agent.cancel({ kind: 'user' })

      return {
        kind: 'success',
        text: '已停止当前任务。',
      }
    },
  }
}
```

Fast Path 在拿得到 Agent 时，优先通过：

```ts
ctx.commands.execute(agent, text, signal)
```

执行正式 `/stop` command。

这样：

- `/help` 能发现；
- command lifecycle 正常记录；
- 行为仍由 command handler 定义；
- Bridge 只负责“提前执行”。

---

## 11. 不增加额外“防插件覆盖”设计

最终版删除之前的：

```ts
CHANNEL_RESERVED_COMMANDS
```

删除：

```text
numeric priority
reserved name guard
自定义覆盖检查
```

Channel 自有 command 继续注册在：

```text
agent.ctx
```

即可。

官方规则：

```text
Agent scoped command
        ↓ shadow
Global command
```

同一 Agent scope 同名：

```text
duplicate registration
        ↓
throw
```

不会悄悄覆盖。

因此这里只需要补两个测试：

```text
global /stop + channel agent-scoped /stop
→ channel /stop 生效

同 agent scope 再注册 /stop
→ duplicate error
```

没有必要增加任何运行时代码。

---

## 12. 未注册指令不再拦截

当前逻辑如果类似：

```ts
const execution =
  await ctx.commands.execute(agent, text, signal)

if (execution === undefined) {
  await sendNotice(`未知指令`)
  return
}
```

改掉。

正确逻辑：

```ts
const parsed = parseCommand(text)

if (parsed) {
  const execution =
    await ctx.commands.execute(agent, text, signal)

  if (execution !== undefined) {
    await renderCommandResult(execution.result)
    return
  }
}

// 继续正常模型消息逻辑
agent.followup(
  createUserMessage({
    content: [
      {
        type: 'text',
        text,
      },
    ],
    source: {
      kind: 'user',
    },
  }),
)
```

最终语义：

| 输入 | 行为 |
|---|---|
| `/stop` | Channel command |
| `/new` | Channel command |
| `/compact` 已注册 | Harness plugin command |
| `/goal ...` 已注册 | Harness plugin command |
| `/foo` 未注册 | **原样发给模型** |
| `/foo abc` 未注册 | **完整原样发给模型** |
| 普通文字 | 发给模型 |

官方 TUI 当前选择对未知 slash command 直接警告，这是 TUI 自己的 adapter policy；CommandRuntime 自身通过 `undefined` 明确允许消费端决定如何处理 unknown command。

因此 Channel 选择 fallback-to-model 不需要改 Harness。

---

## 13. `/help`

新增：

```text
packages/channel-harness/src/commands/help.ts
```

不要维护：

```ts
const COMMANDS = [...]
```

直接：

```ts
const commands =
  ctx.commands.list(invocation.agent)
```

这是已经经过：

```text
global
+
agent scope shadow
```

后的最终 effective command view。

### `/help`

输出例如：

```text
可用指令：

/compact
/feedback <text>
/goal [<objective>|clear|edit ...]
/help [command]
/model [provider model [effort]]
/models [provider]
/new
/plan [off|message]
/status
/stop
```

这样 Harness 后面增加插件：

```text
/foo
```

渠道端无需升级，`/help` 自动出现。

### `/help <command>`

建议顺便支持：

```text
/help model
/help compact
/help goal
```

调用：

```ts
ctx.commands.find(
  invocation.agent,
  commandName,
)
```

输出：

```text
/model

查看或切换当前模型。

Usage:
/model
/model <provider> <model> [reasoningEffort]
```

`input.hint` 可以直接利用 Harness command metadata。

---

## 14. `/status`

新增：

```text
packages/channel-harness/src/commands/status.ts
```

输出控制在短消息：

```text
Session
ID: xxx
Status: running

Model
Provider: openai
Model: gpt-5.6
Reasoning: high
```

数据：

```ts
invocation.agent.id
invocation.agent.status
modelSelection.current
```

不要展示：

```text
API key
access token
webhook
平台密钥
reply-context
```

`/status` 必须完全是 Human Plane，不产生模型调用。

---

## 15. 模型列表：`/models`

新增：

```text
packages/channel-harness/src/commands/models.ts
```

Harness rc.6 已经提供：

```ts
ctx.llm.listProviders()
ctx.llm.listModels(provider)
```

所以不需要自己访问：

```text
OpenAI /models
DeepSeek /models
Anthropic endpoint
```

也不要让 Channel 知道 Provider 的 HTTP API。

统一走 Harness LLM adapter。

### `/models`

逻辑：

```ts
const providers = ctx.llm.listProviders()

const results = await Promise.allSettled(
  providers.map(async provider => ({
    provider,
    models:
      await ctx.llm.listModels(provider.id),
  })),
)
```

一个 provider 获取失败不能导致全部失败。

例如：

```text
OpenAI (openai)
- gpt-5.6
- gpt-5.6-mini

DeepSeek (deepseek)
- deepseek-chat
- deepseek-reasoner

custom-provider
模型目录获取失败
```

---

## 16. `/models <provider>`

支持：

```text
/models openai
```

避免多个 Provider 时刷出过长消息。

不存在 Provider：

```text
未找到 Provider: foo

可用：
openai
deepseek
...
```

---

## 17. Model catalog 只是 advisory

这一点实现时必须注意。

官方明确规定：

> `listModels()` 只是模型发现目录；model 不在列表里，不代表 adapter 不能使用这个 model id。

因此不能写：

```ts
if (!models.some(x => x.id === model)) {
  throw new Error('invalid model')
}
```

`/model` 切换需要走 exact model resolution。

---

## 18. `/model` 必须使用官方 ModelSelection

新增：

```text
packages/channel-harness/src/model-selection.ts
packages/channel-harness/src/commands/model.ts
```

不要：

```ts
agent.options.model = model
```

也不要为了换模型：

```text
dispose Agent
→ resume Agent
```

Harness rc.6 已经公开：

```ts
installModelSelection()
ModelSelection
ModelSelectionRef
```

并从 `@deepseek-ai/dsh-agent` 根入口导出。

---

## 19. 为什么使用 `installModelSelection`

官方实现会同时接管：

```text
system-prompt/assemble
+
agent/request
```

一个 step 开始时 snapshot 当前 selection。

所以即使用户在运行过程中执行：

```text
/model openai gpt-5.6
```

当前已经 assembly 的 step 不会出现：

```text
Prompt:
model = deepseek

实际 HTTP:
model = gpt-5.6
```

下一 step 才统一切换。

这是官方专门解决 runtime model switch 的机制。

---

## 20. `ChannelModelSelectionManager`

建议：

```ts
class ChannelModelSelectionManager {
  private readonly refs =
    new WeakMap<Agent, ChannelModelSelectionRef>()

  install(
    agent: Agent,
    initial: ModelSelection,
  ): void

  current(
    agent: Agent,
  ): ModelSelection

  select(
    agent: Agent,
    selection: ModelSelection,
  ): void
}
```

内部：

```ts
type ChannelModelSelectionRef =
  ModelSelectionRef & {
    current: ModelSelection
  }
```

---

## 21. 模型 selection 的读取优先级

Channel 版本建议：

```text
① 当前进程用户刚通过 /model 选择的 picked
                ↓
② session.requestHeader() 最近一次真正使用的 config
                ↓
③ 当前 Session 创建/恢复时的 AgentRouteSpec
```

不要统一退回一个 global default，因为你的 `AgentRouter` 已经支持：

```text
conversation override
    >
account override
    >
channel override
    >
agent.default
```

---

## 22. create / resume 都必须安装 selection

现在 `AgentManager` 创建 Agent 时已经有 setup 机制。

最终：

```text
create agent
    ↓
agent setup
    ├─ install channel commands
    └─ install model selection
```

以及：

```text
resume agent
    ↓
agent setup
    ├─ install channel commands
    └─ install model selection
```

必须统一。

不能只有新 Session 能 `/model`，resume 后失效。

---

## 23. `/model` 不要修改 `binding.route`

当前 `SessionBinding.route` 定义的是：

> Agent create/resume 的 routing snapshot。

而 Bridge 会重新通过：

```ts
agentRouter.resolve(...)
```

计算配置，并检测 route drift。

因此不要：

```ts
binding.route.model = selectedModel
```

否则下一次 routing reconciliation 很可能又覆盖回配置值。

---

## 24. 模型切换正确持久化路径

采用官方模式：

```text
/model
  ↓
selection.current = next
  ↓
下一个真正进入的 model step
  ↓
agent/request 使用 next
  ↓
Harness 写 request/header
  ↓
Session persistence
  ↓
进程重启 / resume
  ↓
session.requestHeader()
  ↓
恢复选择
```

因此不增加：

```text
channel/model-selected event
binding.selectedModel
独立 JSON model store
```

---

## 25. `/model` 语法

最终建议：

```text
/model
/model <provider> <model>
/model <provider> <model> <reasoningEffort>
```

例如：

```text
/model
/model deepseek deepseek-chat
/model openai gpt-5.6 high
```

不用：

```text
/model openai/gpt-5.6
```

因为 model id 自身理论上可以包含 `/`。

---

## 26. `/model` 无参数

输出：

```text
当前模型

Provider: openai
Model: gpt-5.6
Reasoning: high
```

---

## 27. `/model provider model`

步骤：

```text
1. 验证 provider 当前存在
2. exact resolve model metadata
3. 验证 reasoning effort（如果指定）
4. selection.current = next
5. 返回成功
```

输出：

```text
模型已切换：

Provider: openai
Model: gpt-5.6
Reasoning: high

从下一次模型执行步骤开始生效。
```

---

## 28. Provider 校验

Provider 必须来自：

```ts
ctx.llm.listProviders()
```

不存在直接报错。

---

## 29. Model 校验

不要用：

```ts
listModels()
```

做硬校验。

应调用官方 exact-model metadata resolution。

官方 Session model switch 本身也是：

- exact model metadata 验证 reasoning effort；
- catalog membership 只用于发现；
- 不把“不在 catalog”等价成“不允许调用”。

---

## 30. Official plugin commands 的处理

以下不属于 channel-harness：

### `/compact`

官方已有完整 command producer。

### `/goal`

官方支持：

```text
/goal
/goal <objective>
/goal edit <objective>
/goal pause
/goal resume
/goal clear
```

### `/feedback`

官方已有。

### `/plan`

PlanMode 插件本身在 command service 存在时注册 `/plan`。

因此渠道层只负责：

```ts
ctx.commands.execute(...)
```

不要 import 这些具体 command 包来手动识别命令名。

---

## 31. `/export` 暂不加入

官方现有 `/export` 是：

> Web Session-log ZIP download command。

它明显绑定浏览器下载行为。

Telegram / QQ / 微信等后续如果要导出 Session：

```text
Session export
      ↓
Channel attachment abstraction
      ↓
平台文件上传
```

应该单独设计。

本轮不碰。

---

## 32. 暂不增加这些指令

本轮不要加：

```text
/clear
/reset
/retry
/undo
/sessions
/switch
/history
/export
```

尤其 `/sessions` / `/switch` 涉及：

- Session persistence；
- cold session；
- conversation binding；
- session ownership；
- preset；
- resume；
- 跨 conversation session 接管。

不能仅靠 BindingStore 做个列表就算正确。

后续真正有需求再对 Harness session query / persistence seam 设计。

---

## 33. 渠道 Adapter 不实现命令逻辑

最终所有渠道：

```text
Telegram
QQ
DingTalk
Feishu
WeChat
Web
```

都应该保持：

```text
平台事件
   ↓
ChannelInboundEvent
   ↓
ChannelBridge
   ↓
统一 Commands
```

不要出现：

```ts
// telegram
if (message.text === '/stop')

// qq
if (content.startsWith('/model'))

// wechat
switch (command)
```

平台 adapter 最多提供：

- Telegram command menu；
- 飞书按钮；
- QQ 快捷命令；
- Web autocomplete。

这些都是展示层。

真正 command authority 仍然是：

```ts
ctx.commands
```

---

## 34. 文件修改清单

### 新增

```text
packages/channel-harness/src/commands/stop.ts
packages/channel-harness/src/commands/help.ts
packages/channel-harness/src/commands/status.ts
packages/channel-harness/src/commands/models.ts
packages/channel-harness/src/commands/model.ts
packages/channel-harness/src/model-selection.ts
```

### 修改

```text
packages/channel-harness/src/commands/index.ts
packages/channel-harness/src/bridge.ts
packages/channel-harness/src/agent-manager.ts
packages/channel-harness/src/index.ts
```

以及对应测试。

---

## 35. `commands/index.ts`

最终职责：

```ts
export function installChannelCommands(...) {
  register(stop)
  register(new)
  register(help)
  register(status)
  register(models)
  register(model)
}
```

这里只负责 Agent scoped registration。

**不实现优先级系统。**

---

## 36. `bridge.ts`

这是本轮核心。

最终职责增加：

```text
① /stop Fast Path
② conversation generation
③ stop barrier
④ registered command dispatch
⑤ unknown command fallthrough
```

大致流程：

```ts
async onMessage(event) {
  const key = conversationKey(event)
  const text = extractText(event)

  const parsed = parseCommand(text)

  // P0
  if (parsed?.name === 'stop') {
    await this.handleImmediateStop(
      key,
      event,
      text,
    )
    return
  }

  const generation =
    this.generationOf(key)

  return this.enqueueConversation(
    key,
    async () => {
      if (!this.isGenerationCurrent(
        key,
        generation,
      )) return

      const {
        binding,
        agent,
      } = await this.resolveConversation(...)

      if (!this.isGenerationCurrent(
        key,
        generation,
      )) return

      if (parsed) {
        const execution =
          await this.ctx.commands.execute(
            agent,
            text,
            signal,
          )

        if (execution !== undefined) {
          await this.renderCommandResult(
            event,
            execution.result,
          )
          return
        }
      }

      if (!this.isGenerationCurrent(
        key,
        generation,
      )) return

      agent.followup(
        createUserMessage(...),
      )
    },
  )
}
```

---

## 37. `/new` 保持原有特殊 bootstrap

如果当前 conversation 没有 binding：

```text
/new
```

仍然应该能直接创建新 Session。

因此 Bootstrap command 顺序建议：

```text
/stop
   ↓
永远不创建 Session

/new + no binding
   ↓
bootstrap new session

其他文本 / command
   ↓
normal resolve/create
```

---

## 38. 第一次消息就是 `/help` 怎么办

建议支持。

即：

```text
新的 QQ 对话
用户：/help
```

可以：

```text
创建正常 session/agent
↓
执行 /help
↓
不发送给模型
```

同理：

```text
/status
/models
/model
```

第一次输入也应该可用。

---

## 39. `/stop` 在没有 Session 时

不要为了：

```text
/stop
```

创建一个空 Session。

直接返回：

```text
当前没有正在运行的任务。
```

或者：

```text
当前没有可停止的任务。
```

并结束。

---

## 40. 测试：`/stop`

必须覆盖：

```text
running model stream
→ /stop
→ signal aborted
```

```text
running tool
→ /stop
→ tool signal aborted
```

```text
Agent inbox 有待处理消息
→ /stop
→ inbox cleared
```

```text
Bridge chain:
A
B
C

/stop
→ B/C 不得之后进入 agent.followup
```

```text
/stop
随后用户发送 D
→ D 属于新 generation
→ 可以正常执行
```

```text
/new 正在进行
同时 /stop
→ stop barrier 最终取消最新 session agent
```

```text
idle agent
→ /stop
→ 不报错
```

```text
no binding
→ /stop
→ 不创建 session
```

---

## 41. 测试：Unknown slash

旧测试如果是：

```text
/unknown
→ 未知指令
```

需要删除/修改。

改成：

```text
/unknown
→ commands.execute === undefined
→ agent.followup("/unknown")
```

以及：

```text
/unknown foo bar
```

必须完整保留：

```text
/unknown foo bar
```

不能变成：

```text
unknown foo bar
```

也不能 trim 参数。

---

## 42. 测试：Registered command 不得 fallthrough

例如：

```text
/model invalid
```

即使命令返回：

```ts
{ kind: 'error' }
```

也已经是 **registered command**。

所以：

```text
CommandResult.error
≠
unknown command
```

必须：

```text
直接回复用户错误
不进入模型
```

---

## 43. 测试：Command scope

只需要官方语义测试：

```text
global /stop
+
channel agent-scoped /stop

→ channel /stop
```

和：

```text
agent-scoped /stop
+
同 scope 再注册 /stop

→ duplicate throws
```

不新增 production code。

---

## 44. 测试：`/help`

覆盖：

```text
Channel 自有命令出现
Harness global plugin command 出现
scope shadow 后同名只出现一次
动态 register 后立即出现
dispose 后立即消失
```

---

## 45. 测试：`/models`

覆盖：

```text
多个 provider
```

```text
某 provider listModels() failure
→ 其他 provider 正常展示
```

```text
provider model list 为空
```

```text
/models foo
→ provider not found
```

---

## 46. 测试：`/model`

必须覆盖：

```text
/model
→ 当前选择
```

```text
/model p m
→ selection.current 修改
```

```text
当前 step 已经 assemble
期间切模型
→ 当前 request 继续旧模型
```

```text
下一 step
→ 使用新模型
```

还需要：

```text
新 model request
→ request/header 记录新的 provider/model
```

```text
dispose
resume
→ selection 从 latest request/header 恢复
```

---

## 47. Harness 版本策略

你当前 `channel-harness` 是 `0.4.2`，Harness peer/dev deps 还是 `0.1.0-rc.6`。

本轮：

**不要求升级 rc.7。**

因为 rc.6 已经包含：

```text
installModelSelection
ModelSelectionRef
listProviders
listModels
```

所以这次功能可以继续以：

```json
"@deepseek-ai/dsh-agent": "^0.1.0-rc.6"
```

这条兼容线实现。

不要为了这次 command 功能顺手升级整个 Harness family，避免把版本升级和行为改造混在一个变更里。

---

## 48. 推荐提交拆分

建议最终拆成 4 个 commit。

### Commit 1

```text
feat(channel-harness): add immediate stop command
```

包含：

```text
/stop
generation barrier
stop barrier
```

### Commit 2

```text
fix(channel-harness): pass unknown slash commands to agent
```

包含：

```text
unknown slash fallback
对应测试修改
```

### Commit 3

```text
feat(channel-harness): add help and status commands
```

### Commit 4

```text
feat(channel-harness): add model discovery and selection commands
```

包含：

```text
/models
/model
ModelSelectionManager
create/resume integration
```

这样 PR 审查时比较容易判断行为改变。

---

## 49. 最终验收场景

实际运行一次：

```text
用户：
帮我分析这个大项目

AI：
开始调用工具……
```

此时：

```text
用户：
/stop
```

要求：

```text
① 不等前面 Bridge chain
② 当前 Agent 立即 cancel
③ pending inbox 被清除
④ Bridge 旧 generation 消息作废
⑤ 用户迅速收到“已停止”
```

然后：

```text
用户：
/models openai
```

正常返回模型列表。

再：

```text
/model openai gpt-5.6
```

返回：

```text
模型已切换。
从下一次模型执行步骤开始生效。
```

然后：

```text
用户：
继续刚才的问题
```

下一 model step 使用：

```text
openai / gpt-5.6
```

再输入：

```text
/foo 做点什么
```

如果没有插件注册 `/foo`：

```text
不显示“未知指令”
不吞消息
直接原样发送给模型
```

再：

```text
/compact
```

如果宿主已经加载官方 compaction command：

```text
由 Harness 官方 command handler 执行
channel-harness 不包含 /compact 特殊代码
```

这就是最终应达到的状态。

---

## 最终核心原则

这一版可以压缩成四条工程原则：

```text
/stop 的最高优先级
→ Bridge 调度层解决

command 的名称优先级
→ 完全交给 Harness scope

未知 /xxx
→ Harness 不接管就交给模型

模型切换
→ 完全使用 Harness ModelSelection
```

这样 `dsh-channels` 仍然只是一个 **Harness-native Channel Bridge**，而不是逐渐发展成一套平行于 Harness 的 Session / Commands / Model runtime。
