# dsh-channels 通用指令能力与 `/new` 最终执行方案

> 项目：`wsz987/dsh-channels`  
> 基线：`main` commit `746293d83541d227dde41428955e50ae339dcd58`  
> Harness 目标契约：项目当前 pinned `0.1.0-rc.6`；设计依据使用 DeepSeek Harness 官方 `dsh-commands`、`AgentRegistry.create/resume/setup`、Agent scoped context 语义。  
> 状态：Final Execution Plan

---

## 1. 目标

在 `dsh-channels` 中建立一套**通用、可扩展、Harness-native 的人类指令能力**：

```text
微信 / QQ / 钉钉 / 飞书 / 后续其它渠道
                │
                │  /new /compact /plan /...
                ▼
          channel-harness
                │
                ▼
   @deepseek-ai/dsh-commands
                │
                ├── 官方全局/Agent-scoped commands
                └── dsh-channels 自己提供的 commands
```

第一条自定义指令实现 `/new`：

- 当前渠道会话切换到一个全新的 Harness Session。
- 旧 Session 不删除，仍保留历史。
- `/new` 本身不作为普通用户消息发送给模型。
- 新 Session 复用项目已经完成的 Harness default-model fallback、`cwd: process.cwd()`、route/provider/model/maxTokens/preset 规则。
- 微信、QQ、钉钉、飞书共用同一份 `/new` 实现。
- 后续新增 `/status`、`/sessions`、`/switch` 等时，不修改各个平台 Adapter。

---

## 2. 官方技术边界

### 2.1 必须使用官方 `@deepseek-ai/dsh-commands`

DeepSeek Harness 官方已经定义 `@deepseek-ai/dsh-commands`，负责：

- command 注册与 discovery；
- slash command 解析；
- Agent-scoped command；
- `command/run` / `command/done`；
- cancellation；
- handler result；
- unknown command admission boundary。

因此本项目禁止再实现：

```text
ChannelCommandRegistry
CommandMap
SlashCommandParser
CommandService
PlatformCommandRouter
```

必须使用：

```ts
import {
  parseCommand,
  type CommandDefinition,
} from '@deepseek-ai/dsh-commands';
```

禁止自己：

```ts
text.startsWith('/')
text.split(' ')
/^\/new/
```

也不要在 parse 前做 `text.trim()`，因为官方 `parseCommand()` 要求 `/` 位于 byte zero，并保留完整 `rawInput`。

### 2.2 Command 是 Human UI Plane，不是 Model Plane

已注册 command：

```text
/new
/compact
/plan
...
```

必须走：

```text
Channel message
      ↓
commands.execute()
```

而不是：

```text
Channel message
      ↓
UserMessage
      ↓
agent.followup()
      ↓
LLM
```

Command lifecycle 由官方记录：

```text
command/run
    ↓
handler
    ↓
command/done
```

CommandResult 由渠道直接发送给用户，不进入模型上下文。

### 2.3 Agent 生命周期继续使用官方 AgentRegistry

创建：

```ts
ctx.agents.create(...)
```

恢复：

```ts
ctx.agents.resume(...)
```

官方 `create/resume` 都支持 `setup(agentCtx)`，本方案使用它为渠道 Agent 安装 Agent-scoped commands。

---

## 3. 最终架构

```text
┌──────────────────────────────────────────────┐
│ 微信 / QQ / 钉钉 / 飞书 / Future Adapter     │
└──────────────────────┬───────────────────────┘
                       │ ChannelEvent
                       ▼
┌──────────────────────────────────────────────┐
│ ChannelService                               │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ ChannelHarnessBridge                         │
│                                              │
│  1. conversation serialization              │
│  2. SessionBinding resolve                  │
│  3. Agent resolve/create/resume              │
│  4. parseCommand()                           │
│                                              │
│      command → ctx.commands.execute()        │
│      ordinary → agent.followup()             │
└──────────────────────┬───────────────────────┘
                       ▼
                 Harness Session
```

核心原则：

```text
Platform Adapter 负责“消息怎么进来、回复怎么出去”
channel-harness 负责“这是普通消息还是人类指令”
dsh-commands 负责“指令如何解析和执行”
具体 command 模块负责“这个指令改变什么业务状态”
```

---

## 4. 扩展性规范

### 4.1 新 command 只放在 `channel-harness`

建议目录：

```text
packages/channel-harness/src/
├── commands/
│   ├── index.ts
│   └── new.ts
├── bridge.ts
├── agent-manager.ts
├── binding-store.ts
└── ...
```

第一阶段只新增 `commands/index.ts`、`commands/new.ts`，不要为了一个 `/new` 创建新 package。

### 4.2 一个 command 一个模块

未来：

```text
commands/
├── new.ts
├── status.ts
├── sessions.ts
├── switch.ts
└── index.ts
```

每个文件只负责生成官方 `CommandDefinition`：

```ts
export function createNewCommand(
  deps: ChannelCommandDependencies,
): CommandDefinition {
  return {
    name: 'new',
    description: 'Start a new channel session',
    async handler(invocation) {
      // command-specific logic
    },
  };
}
```

`commands/index.ts` 只负责组合：

```ts
const factories = [
  createNewCommand,
];

export function installChannelCommands(
  agentCtx: Context,
  deps: ChannelCommandDependencies,
): void {
  agentCtx.effect(function* () {
    for (const factory of factories) {
      yield agentCtx.commands.register(factory(deps));
    }
  }, 'channel commands');
}
```

这里的 `factories` 不是自定义 Registry；真正 Registry 始终只有 `@deepseek-ai/dsh-commands`。

### 4.3 Command 不得依赖具体平台

禁止：

```ts
if (channelId === 'weixin') ...
if (channelId === 'qq') ...
```

禁止：

```text
commands/weixin-new.ts
commands/qq-new.ts
```

正确关系：

```text
/new
  ↓
Channel SessionBinding
  ↓
创建新 Harness Session
```

未来新增 Telegram/Slack/Discord，只要接入现有 `ChannelAdapter`，自动获得同样的 command plane。

### 4.4 Platform Adapter 不得解析 slash command

`channel-weixin`、`channel-qq`、`channel-dingtalk`、`channel-lark` 都不应该出现：

```ts
if (text === '/new')
```

平台 Adapter 仍只做：

```text
Platform Protocol ↔ Channel Contract
```

### 4.5 不扩张 `channel-core`

此次不要向 `ChannelAdapter` 增加：

```ts
commands
registerCommand
executeCommand
onCommand
```

command 是 Harness human interaction capability，不属于平台协议层。

---

## 5. 指令注册作用域

dsh-channels 自定义 command 使用 Agent scope，不做 root-global `/new`。

最终：

```text
Channel Agent
    └── agent.ctx
            └── scoped /new
```

而 Harness 官方全局 command 仍可进入该 Agent 的 effective view：

```text
effective commands for channel agent
├── 官方 global commands
├── 其它插件 global commands
└── dsh-channels scoped commands
    └── /new
```

---

## 6. Agent setup 规范

当前 `HarnessAgentGateway.create()` 已经解决：

- `resolveRoute(route, agentDefaultModel.currentSelection())`
- `cwd: process.cwd()`
- `agentPreset`
- `agentOptions`

这些不要重写，只扩展官方 `setup`：

```ts
ctx.agents.create({
  sessionId,
  meta,
  agentOptions,
  setup(agentCtx) {
    installChannelCommands(agentCtx, commandDeps);
  },
});
```

resume 同理：

```ts
ctx.agents.resume({
  resumeSessionId,
  agentOptions,
  setup(agentCtx) {
    installChannelCommands(agentCtx, commandDeps);
  },
});
```

这样 command 在 Agent publication 前安装，并与 Agent scope 一起销毁。

---

## 7. AgentManager 接口调整

当前：

```ts
create(sessionId, route)
resolve(sessionId, route)
resolveOrCreate(sessionId, route)
```

扩展为：

```ts
create(sessionId, route, setup?)
resolve(sessionId, route, setup?)
resolveOrCreate(sessionId, route, setup?)
```

其中：

```ts
setup?: AgentSetup
```

Gateway 同样把 setup 原样传给官方 `ctx.agents.create/resume`。

### 7.1 borrowed Agent

保持 ownership：

```text
ctx.agents.get()        → borrowed
ctx.agents.create()     → owned
ctx.agents.resume()     → owned
```

borrowed Agent 不能 dispose。

如果已存在 live borrowed Agent，create/resume setup 已来不及执行，因此 AgentManager 增加一次性 scoped setup：

```ts
private configuredAgents = new WeakSet<Agent>();
```

规则：

- 每个 Agent 最多安装一次 channel commands；
- setup 失败则本次消息失败；
- 不产生 duplicate command；
- disposer 归 Agent scope；
- borrowed Agent 仍不能由 channel-harness dispose。

---

## 8. Bridge Command Admission

当前普通消息：

```text
binding
→ agent
→ toHarnessUserMessage()
→ agent.followup()
```

改为：

```text
binding
→ agent
→ parseCommand(raw text)
        ├── command
        │      ↓
        │  commands.execute()
        │      ↓
        │  direct adapter.send()
        │
        └── ordinary
               ↓
       toHarnessUserMessage()
               ↓
          agent.followup()
```

伪代码：

```ts
const parsed = parseCommand(text);

if (parsed) {
  const execution = await ctx.commands.execute(
    agentRef.agent,
    text,
    signal,
  );

  if (!execution) {
    await sendCommandNotice(
      event,
      `未知指令：/${parsed.name}`,
    );
    return;
  }

  await renderCommandResult(event, execution.result);
  return;
}

const userMessage = await toHarnessUserMessage(...);
agentRef.followup(userMessage);
```

---

## 9. Unknown command 规则

语法有效但未注册的：

```text
/foo
```

必须直接返回“未知指令”。

禁止：

```text
/foo → agent.followup() → 模型自行理解
```

未来 `/help` 可直接用 `ctx.commands.list(agent)` 生成 effective command catalog，不维护第二份帮助列表。

---

## 10. Command Result 输出

CommandResult 不经过 ReplyRouter。

原因：

```text
CommandResult = Human UI result
Assistant output = Model/session reply
```

Bridge 增加内部 helper：

```ts
sendCommandNotice(event, text)
```

统一调用当前 Adapter：

```ts
adapter.send(target, { text })
```

target 复用 account/conversation/thread/replyToMessageId。

不要产生 `assistant/message`。

---

## 11. `/new` 精确定义

当前：

```text
Binding → Session A
```

用户发送：

```text
/new
```

成功后：

```text
Binding → Session B
```

同时 Session A 继续保留历史，后续普通消息全部进入 B。

---

## 12. `/new` handler

```ts
export function createNewCommand(
  deps: ChannelCommandDependencies,
): CommandDefinition {
  return {
    name: 'new',
    description: 'Start a new channel session',

    async handler(invocation) {
      if (invocation.rawInput.trim().length > 0) {
        return {
          kind: 'error',
          text: '用法：/new',
        };
      }

      if (invocation.agent.status !== 'idle') {
        return {
          kind: 'error',
          text: '当前会话仍在运行，请稍后再执行 /new。',
        };
      }

      await deps.startNewSession(invocation.agent);

      return {
        kind: 'success',
        text: '已开启新会话。',
      };
    },
  };
}
```

handler 本身不直接 dispose Session A。

---

## 13. handler 内不能 dispose A

官方执行顺序：

```text
Session A
  ↓
command/run
  ↓
/new handler
  ↓
handler return
  ↓
command/done
```

正确顺序：

```text
handler
  ↓
创建 B
  ↓
切 binding 到 B
  ↓
return
  ↓
官方写完 command/done(A)
  ↓
commands.execute() resolve
  ↓
Bridge 再 retire A
```

---

## 14. 通用 post-command cleanup

不要写：

```ts
if (command.name === 'new') {
  retireOldSession();
}
```

执行 command 前记录：

```ts
const beforeSessionId = binding.sessionId;
```

执行完成后重新读取 binding：

```ts
const currentBinding = await bindingStore.get(key);
```

若：

```text
currentBinding.sessionId !== beforeSessionId
```

说明任何 command 已切换 active binding，统一：

```ts
await agentManager.retireSession(beforeSessionId);
```

未来 `/switch`、`/fork` 都自动复用。

---

## 15. `retireSession()` 语义

新增：

```ts
retireSession(sessionId)
```

行为：

```text
owned Agent
  → remove refs
  → remove reverse binding
  → handle.dispose()

borrowed Agent
  → remove local refs/reverse binding
  → NEVER dispose underlying Agent
```

`retire != delete persisted history`。

旧 Session 历史仍然保留。

---

## 16. Fresh Session 创建只有一个实现

禁止 `/new` 复制：

```text
randomUUID
resolveRoute
agents.create
bindingStore.put
registerBinding
```

Bridge 抽出：

```ts
createFreshSession(...)
```

普通首次消息与 `/new` 共用，统一完成：

```text
1. mint SessionId
2. resolve AgentRoute
3. default-model fallback
4. cwd
5. preset
6. official ctx.agents.create()
7. Agent-scoped command setup
8. write SessionBinding
9. register reverse binding
```

---

## 17. `/new` 的 Binding 事务

原状态：

```text
Binding → A
```

执行：

```text
create B
  ↓
put Binding → B
  ↓
register B
```

失败规则：

- B create 失败：保持 A。
- binding 写失败：dispose B，恢复 A。
- 不要先删除 A binding。

伪代码：

```ts
const oldBinding = await bindingStore.get(key);
const fresh = await createAgentB();

try {
  await bindingStore.put(fresh.binding);
} catch (error) {
  await agentManager.disposeSession(fresh.sessionId);

  if (oldBinding) {
    await bindingStore.put(oldBinding);
  }

  throw error;
}

agentManager.registerBinding(fresh.binding);
```

---

## 18. Per-conversation 串行化

必须解决：

```text
消息1：/new
消息2：继续刚才的问题
```

同一个 `channel + account + conversation + thread` 增加轻量 Promise chain：

```text
Conversation A: msg1 → msg2 → msg3
Conversation B: msg1 → msg2
Conversation C: msg1
```

只串行同一个 conversation，不使用 global mutex。

这是 ChannelBinding mutation 的长期一致性边界，不是 `/new` 临时补丁。

---

## 19. 第一条消息就是 `/new`

当 Binding 不存在时，没有 receiving Agent，官方 `commands.execute(agent, ...)` 尚无合法 target。

V1：

```text
无 Binding + /new
      ↓
直接 fresh-session bootstrap
      ↓
建立第一个 Session
      ↓
回复“已开启新会话”
```

不要：

```text
先创建 A
→ 在 A 上执行 /new
→ 又创建 B
```

bootstrap 是 Agent 尚不存在前的 adapter admission 特例；一旦 binding/Agent 存在，所有 command 必须走官方 `commands.execute()`。

---

## 20. `/new` running 状态

V1 不实现 `/new --force`。

如果：

```ts
invocation.agent.status === 'running'
```

返回：

```text
当前会话仍在运行，请稍后再执行 /new。
```

不隐式 cancel 当前 turn。

---

## 21. Package / Bundle 改动

### `packages/channel-harness/package.json`

增加：

```json
"@deepseek-ai/dsh-commands": "^0.1.0-rc.6"
```

### `plugin.ts`

当前：

```ts
['channels', 'agents', 'agentDefaultModel']
```

改为：

```ts
export const inject = [
  'channels',
  'agents',
  'agentDefaultModel',
  'commands',
];
```

`commands` 是 required capability，不做 optional fallback。

### `packages/channels/cordis.patch.yml`

```yaml
- id: channels-harness
  name: '@wsz987/channel-harness'
  inject:
    - channels
    - agents
    - agentDefaultModel
    - commands
```

其它四个 Adapter 不变。

---

## 22. 具体文件改动

新增：

```text
packages/channel-harness/src/commands/index.ts
packages/channel-harness/src/commands/new.ts
```

修改：

```text
packages/channel-harness/package.json
packages/channel-harness/src/plugin.ts
packages/channel-harness/src/agent-manager.ts
packages/channel-harness/src/bridge.ts
packages/channel-harness/src/lifecycle.ts
packages/channels/cordis.patch.yml

packages/channel-harness/test/channel-harness.test.ts
packages/channel-harness/test/harness-compat.test.ts
```

必要时新增：

```text
packages/channel-harness/test/commands.test.ts
```

---

## 23. `commands/index.ts` 最终职责

只做：

```text
1. 定义 ChannelCommandDependencies
2. 组合 command factories
3. 安装到 Agent scope
```

例如：

```ts
export interface ChannelCommandDependencies {
  startNewSession(agent: Agent): Promise<void>;
}

const commandFactories = [
  createNewCommand,
];

export function installChannelCommands(
  agentCtx: Context,
  deps: ChannelCommandDependencies,
): void {
  agentCtx.effect(function* () {
    for (const createCommand of commandFactories) {
      yield agentCtx.commands.register(createCommand(deps));
    }
  }, 'channel command registrations');
}
```

未来只扩展 `commandFactories`。

---

## 24. 后续 command 扩展模板

新增 `/status`：

```text
1. 新建 commands/status.ts
2. export createStatusCommand()
3. 加入 commandFactories
4. 写 tests
```

不修改：

```text
channel-weixin
channel-qq
channel-dingtalk
channel-lark
channel-core
ReplyRouter
```

---

## 25. 推荐未来指令

本次只实现 `/new`，预留：

```text
/status
/sessions
/switch <session>
/help
```

其中 `/switch` 必须限制 Session 归属当前 channel/account/conversation/thread，不能凭任意 SessionId 跨用户恢复。

`/help` 应直接基于 `ctx.commands.list(agent)`，不维护第二份命令列表。

---

## 26. Command 开发规范

以后每个 command 必须遵守：

1. **lowercase command name**：`/new`、`/status`、`/switch`。
2. **不自己解析 slash name**：统一 Harness `parseCommand()`。
3. **参数 grammar 归 command 自己**：使用官方 `rawInput`。
4. **不偷偷送进模型**：需要模型工作时才显式调用 Agent。
5. **Expected error 返回 CommandResult**，不要 throw 普通校验错误。
6. **尊重 `AbortSignal`**。
7. **不依赖平台 SDK**。
8. **Durable state 由所属 domain 持久化**；`dsh-commands` 只记录 command lifecycle。
9. **active-binding mutation 必须经过 conversation serialization**。
10. **渠道 command 默认 Agent-scoped**；global 必须有明确理由。

---

## 27. 测试计划

### A. 官方 command compatibility

- `parseCommand('/new')` 可识别。
- 缺少 `commands` capability 时 composition 失败，不 silent fallback。
- create/resume 的 `setup` 都被传递。

### B. 普通消息回归

- `hello` 仍走 `toHarnessUserMessage → followup`。
- 含 `/` 但不符合官方 command syntax 的文本按官方规则处理。

### C. `/new`

- A 上 `/new` 生成 B，`B !== A`。
- Binding 从 A → B。
- 下一条普通消息进入 B。
- A 不再是当前 binding。
- A 的 `command/run → command/done` 完整。
- `/new` 不产生普通 user message。
- B 的 `cwd === process.cwd()`。
- route 未指定 model 时 B 使用 Harness default model。
- explicit model 不被覆盖。
- preset 继续进入 `meta.agentPreset`。

### D. busy

A running 时 `/new`：

```text
error
binding 仍然 A
没有 B
```

### E. rollback

- B create 失败：binding 仍 A。
- Binding B persist 失败：B dispose，A restore。
- rollback 失败必须 log error。

### F. Command Result

- success/error text 直接 Adapter send。
- 结果不进入 assistant/model history。

### G. Unknown command

`/not-exist`：

- 返回未知指令；
- `followup` 未调用。

### H. 官方已有 commands

如果 composition 注册 `/compact`，渠道发送 `/compact` 应使用官方 handler。

这是证明“通用 command adapter”完成的关键测试。

### I. 多渠道共用

fake adapters 验证 weixin/qq/dingtalk/lark 的 `/new` 都进入同一个 `commands/new.ts`，没有四份实现。

### J. concurrency

```text
T0    /new
T0+ε  hello
```

必须：

```text
/new 完成 Binding → B
hello 读取 B
```

不同 conversation 可并行。

### K. repeated new

```text
A
/new → B
/new → C
/new → D
```

最终 Binding → D，A/B/C 历史仍存在，但不残留 channel-owned live Agent handle。

### L. bootstrap

无 binding 时第一条 `/new` 只创建一个 fresh Session。

---

## 28. 实施里程碑

### M0 — 官方 command capability 接入

改：

```text
package.json
plugin.ts
cordis.patch.yml
```

完成：

- `dsh-commands` dependency；
- required `commands` injection；
- compatibility tests。

### M1 — Agent scoped command composition

改：

```text
agent-manager.ts
commands/index.ts
```

完成：

- create/resume setup parity；
- Agent-scoped command installer；
- borrowed Agent 幂等 setup。

### M2 — 通用 command admission

改 `bridge.ts`：

- official `parseCommand()`；
- official `commands.execute()`；
- unknown command rejection；
- direct CommandResult rendering；
- command 不进入 model。

验收：`/compact` 等其它注册 command 也能走渠道。

### M3 — `/new`

新增 `commands/new.ts`，重构 `createFreshSession()`：

- fresh Session；
- binding switch；
- rollback；
- busy guard；
- bootstrap；
- post-command retire。

### M4 — Conversation serialization

完成 per-conversation Promise chain。

### M5 — 回归与 compliance

至少运行：

```bash
pnpm --filter @wsz987/channel-harness typecheck
pnpm --filter @wsz987/channel-harness test
pnpm turbo run typecheck test build
```

并保持现有 `h0-compliance`、`harness-compat` 全部 PASS。

---

## 29. 明确不做

本次不实现：

```text
/sessions
/switch
/help
/model
/cancel
```

只预留结构。

不要：

- 修改四个平台协议；
- 新建 `channel-command-core` package；
- 自建 command registry；
- 新建 command database；
- 给 `ChannelAdapter` 添加 command API；
- 自动把 unknown slash prompt 发给模型；
- 在 `/new` 中复制 Agent create 逻辑；
- 在 handler 返回前 dispose old Agent；
- 给每个渠道各写一份 command。

---

## 30. 最终设计红线

```text
Platform SDK
    │
    ▼
Channel Adapter
    │
    ▼
ChannelService
    │
    ▼
channel-harness
    │
    ├── Human command plane
    │       ↓
    │   dsh-commands
    │
    └── Model message plane
            ↓
          Agent
```

两条 Plane 不混：

```text
/new          ≠ UserMessage
CommandResult ≠ AssistantMessage
```

---

## 31. 新增一个指令的标准成本

理想状态下新增 `/status`：

```text
1 个 command 文件
1 行 index registration
对应 tests
```

而：

```text
微信 Adapter      0 change
QQ Adapter        0 change
钉钉 Adapter      0 change
飞书 Adapter      0 change
channel-core      0 change
ReplyRouter       0 change
```

这是长期扩展性的验收标准。

---

## 32. 官方依据

实现时以官方源码/技术说明为准，不从 UI 行为猜 API。

重点依据：

```text
deepseek-ai/deepseek-harness

packages/interaction/commands/README.md
packages/interaction/commands/src/index.ts
packages/interaction/commands/src/types.ts

.agents/notes/implemented/feature/
2026-07-19-plugin-command-registration.md

packages/core/agent/src/index.ts
packages/core/agent/src/runtime-types.ts
```

关键官方语义：

```text
dsh-commands
→ product command registry

parseCommand()
→ official slash syntax

commands.execute(agent, line, signal)
→ command dispatch

Agent scoped registration
→ command visibility follows Agent scope

ctx.agents.create({ setup })
ctx.agents.resume({ setup })
→ unpublished Agent composition

AgentHandle
→ only owner may dispose

ctx.agents.get()
→ borrowed Agent, not owned
```

---

## 33. Definition of Done

- [ ] `/new` 微信可用。
- [ ] `/new` QQ 可用。
- [ ] `/new` 钉钉可用。
- [ ] `/new` 飞书可用。
- [ ] 四个平台没有 `/new` 专属逻辑。
- [ ] 使用官方 `dsh-commands`。
- [ ] 使用官方 `parseCommand()`。
- [ ] 使用官方 `commands.execute()`。
- [ ] command 不进入模型 prompt。
- [ ] unknown slash 不进入模型。
- [ ] `/new` 创建真正新的 Harness Session。
- [ ] 新 Session 继承现有 default-model/cwd/preset 规则。
- [ ] Session A command lifecycle 完整后才 retire。
- [ ] old owned Agent 不泄漏。
- [ ] borrowed Agent 不被错误 dispose。
- [ ] binding write 失败可 rollback。
- [ ] 同 conversation 无 `/new` race。
- [ ] `/compact` 等其它注册 command 能通过同一渠道 command plane 执行。
- [ ] 新增下一个 command 不需要修改平台 Adapter。
- [ ] channel-harness typecheck/test PASS。
- [ ] full turbo build/test PASS。

---

## 最终结论

本项目的长期设计不是：

```text
“给微信加一个 /new”
```

而是：

```text
“让 channel-harness 成为 DeepSeek Harness 官方 Command Plane 的一个 interactive adapter”
```

`/new` 只是 dsh-channels 提供的第一个 Agent-scoped command。

```text
                   @deepseek-ai/dsh-commands
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
     官方 command       第三方 command      dsh-channels
                                                │
                                  ┌─────────────┼─────────────┐
                                  │             │             │
                                /new         /status       /switch
                                  │
                                  ▼
                         SessionBinding / Agent
                                  │
               ┌──────────────────┼──────────────────┐
               │                  │                  │
             微信                QQ             钉钉/飞书/未来
```

平台数量增加，不复制 command；command 数量增加，不修改平台。

这就是最终通用设计。
