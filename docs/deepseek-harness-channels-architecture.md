# DeepSeek Harness Channels — 架构设计

> 版本：v1.1 Harness-Native  
> 日期：2026-08-13  
> 状态：**最终架构 / 可进入实施**  
> 目标：为 DeepSeek Harness 建立原生、可扩展、可测试、可持续跟随上游更新的 Channel SDK 与首批多渠道实现。

---

## 0. 本版修订说明

v1.1 在原有：

```text
Monorepo
+ Channel Core
+ Harness Bridge
+ Channel Adapter
+ Upstream Driver
+ Testkit
+ Compatibility Layer
```

基础上，按 DeepSeek Harness 官方开发者文档修正为真正 Harness-native 的实现方式：

1. `ChannelService` 明确定义为 **Cordis Service**。
2. `@dsh/channels` 不再只是 npm meta package，而是正式的 **DSH Bundle**。
3. Adapter 的网络连接与长生命周期资源统一交给 `ctx.effect()` 管理。
4. Harness Bridge 必须正确持有 `AgentHandle`，不能创建后丢弃 ownership handle。
5. 模型输出、turn/step/tool 事实统一通过 `session/event` 消费。
6. 插件配置使用 **Schemastery Config + cordis.yml/profile**。
7. `channel-testkit` 增加 Harness compatibility regression。
8. 将 `channel-harness` 设计成极薄的易变边界，以应对 Harness developer preview 阶段的 breaking changes。

官方依据：

```text
https://www.deepseek.com/harness/
https://deepseek-harness.github.io/deepseek-harness/develop/basic/
https://github.com/deepseek-ai/deepseek-harness
```

---

# 1. 项目目标

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

---

# 2. 核心架构原则

## 2.1 不实现 OpenClaw Runtime 兼容层

明确禁止：

```text
FakeOpenClawRuntime
PluginRuntime
OpenClawPluginApi
registerChannel()
ClawdbotConfig
RuntimeEnv
OpenClaw session router
OpenClaw reply dispatcher
OpenClaw gateway host emulation
```

上游 OpenClaw 渠道仓库只允许作为：

- 上游实现参考
- SDK / API 使用参考
- 协议行为参考
- Bugfix / reconnect / media / card 行为参考
- compatibility reference

运行时不依赖 OpenClaw。

---

## 2.2 Harness API 只允许存在于 `channel-harness`

DeepSeek Harness 当前处于 developer preview，公开声明可能存在 breaking changes。

因此：

```text
channel-core        ❌ 不 import Harness Agent API
channel-testkit     ❌ 不依赖 Harness 私有内部实现
channel-weixin      ❌ 不访问 ctx.agents
channel-qq          ❌ 不访问 ctx.agents
channel-dingtalk    ❌ 不访问 ctx.agents
channel-lark        ❌ 不访问 ctx.agents

channel-harness     ✅ 唯一允许直接依赖 dsh-agent / dsh-session
```

目标：

```text
Harness breaking change
       ↓
优先只修改 channel-harness
```

而不引发四个渠道同时跟着重构。

---

## 2.3 产品一体化，代码模块化

最终用户：

```bash
dsh plugin --profile default add @dsh/channels
```

一次安装首批官方渠道。

内部仍拆分：

```text
@dsh/channel-core
@dsh/channel-harness
@dsh/channel-testkit
@dsh/channel-compat

@dsh/channel-weixin
@dsh/channel-qq
@dsh/channel-dingtalk
@dsh/channel-lark

@dsh/channels
```

其中：

```text
@dsh/channels = DSH Bundle
```

不是业务实现集合。

---

# 3. Monorepo 最终结构

```text
deepseek-harness-channels/
│
├─ apps/
│  ├─ playground/
│  │  ├─ channel-debug/
│  │  ├─ harness-debug/
│  │  └─ fixtures-viewer/
│  │
│  └─ example/
│     └─ minimal-profile/
│
├─ packages/
│  │
│  ├─ channel-core/
│  │  └─ src/
│  │     ├─ adapter.ts
│  │     ├─ context.ts
│  │     ├─ service.ts
│  │     ├─ registry.ts
│  │     ├─ events.ts
│  │     ├─ messages.ts
│  │     ├─ capabilities.ts
│  │     ├─ reply.ts
│  │     ├─ auth.ts
│  │     ├─ account.ts
│  │     ├─ storage.ts
│  │     ├─ secrets.ts
│  │     ├─ health.ts
│  │     └─ errors.ts
│  │
│  ├─ channel-harness/
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ config.ts
│  │     ├─ bridge.ts
│  │     ├─ session-router.ts
│  │     ├─ binding-store.ts
│  │     ├─ agent-router.ts
│  │     ├─ agent-manager.ts
│  │     ├─ reply-router.ts
│  │     ├─ message-converter.ts
│  │     └─ lifecycle.ts
│  │
│  ├─ channel-testkit/
│  │  └─ src/
│  │     ├─ contract-tests.ts
│  │     ├─ fake-adapter.ts
│  │     ├─ fake-upstream.ts
│  │     ├─ fake-harness.ts
│  │     ├─ fixture-loader.ts
│  │     ├─ harness-compat.ts
│  │     └─ e2e.ts
│  │
│  ├─ channel-compat/
│  │  └─ src/
│  │     ├─ manifest.ts
│  │     ├─ compatibility.ts
│  │     ├─ version-policy.ts
│  │     └─ doctor.ts
│  │
│  ├─ channel-weixin/
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ config.ts
│  │     ├─ adapter.ts
│  │     ├─ upstream.ts
│  │     ├─ auth.ts
│  │     ├─ inbound.ts
│  │     ├─ outbound.ts
│  │     ├─ media.ts
│  │     ├─ mapper.ts
│  │     └─ capabilities.ts
│  │
│  ├─ channel-qq/
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ config.ts
│  │     ├─ adapter.ts
│  │     ├─ upstream.ts
│  │     ├─ auth.ts
│  │     ├─ gateway.ts
│  │     ├─ inbound.ts
│  │     ├─ outbound.ts
│  │     └─ mapper.ts
│  │
│  ├─ channel-dingtalk/
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ config.ts
│  │     ├─ adapter.ts
│  │     ├─ upstream.ts
│  │     ├─ auth.ts
│  │     ├─ connection.ts
│  │     ├─ inbound.ts
│  │     ├─ outbound.ts
│  │     ├─ ai-card.ts
│  │     └─ mapper.ts
│  │
│  ├─ channel-lark/
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ config.ts
│  │     ├─ adapter.ts
│  │     ├─ upstream.ts
│  │     ├─ auth.ts
│  │     ├─ connection.ts
│  │     ├─ inbound.ts
│  │     ├─ outbound.ts
│  │     ├─ cards.ts
│  │     └─ mapper.ts
│  │
│  └─ channels/
│     ├─ package.json
│     ├─ cordis.patch.yml
│     └─ README.md
│
├─ fixtures/
│  ├─ weixin/
│  ├─ qq/
│  ├─ dingtalk/
│  └─ lark/
│
├─ pnpm-workspace.yaml
├─ package.json
├─ tsconfig.base.json
├─ turbo.json
├─ vitest.workspace.ts
└─ .changeset/
```

---

# 4. Harness-Native 依赖关系

```text
                        DeepSeek Harness
                              │
                          Cordis Runtime
                              │
              ┌───────────────┴───────────────┐
              │                               │
          ctx.agents                    ctx.channels
              │                               │
              │                        ChannelService
              │                               │
              │                      Adapter Registry
              │                   ┌──────┼──────┬──────┐
              │                   │      │      │      │
              │                   ▼      ▼      ▼      ▼
              │                 WX      QQ     DD     Lark
              │                   │      │      │      │
              │                   ▼      ▼      ▼      ▼
              │                Driver Driver Driver Driver
              │
              └──────────── channel-harness ────────────┘
```

严格依赖方向：

```text
channel-adapter -> channel-core
channel-adapter -> upstream driver
upstream driver -> SDK/package/protocol

channel-harness -> channel-core
channel-harness -> Harness public APIs

channels bundle -> plugin configuration only
```

---

# 5. `ChannelService`：正式 Cordis Service

`ChannelService` 是整个 Channel Runtime 的核心能力，应作为 Cordis Service 挂到 `ctx.channels`。

示意：

```ts
import {
  Service,
  type Context,
} from '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Context {
    channels: ChannelService;
  }
}

export class ChannelService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'channels');
  }

  register(adapter: ChannelAdapter): () => void {
    // register and return unregister
  }

  get(id: string): ChannelAdapter | undefined {
    // ...
  }

  list(): ChannelAdapter[] {
    // ...
  }
}
```

优势：

- Harness/Cordis 原生依赖注入
- 插件自动等待所需 Service
- Service 卸载时依赖插件自动 dispose
- Service 恢复后依赖插件可自动重新加载
- 支持 Cordis service isolation
- 不需要自研 Service Locator

---

# 6. Adapter 插件加载方式

每个渠道本身是普通 Cordis 插件：

```ts
export const name = 'channel-dingtalk';
export const inject = ['channels'];

export function apply(
  ctx: Context,
  config: Config,
) {
  const adapter = new DingTalkAdapter(config);

  ctx.effect(() => {
    const unregister =
      ctx.channels.register(adapter);

    return () => unregister();
  });

  ctx.effect(async () => {
    await adapter.start();

    return async () => {
      await adapter.stop();
    };
  });
}
```

规则：

> WebSocket、long-poll、Gateway、heartbeat 等手动资源，统一放在 `ctx.effect()` 生命周期里。

通过 `ctx.on()` 注册的 Cordis 事件监听器由框架自动清理。

---

# 7. 插件配置：Schemastery

所有部署可调参数都必须暴露配置。

示意：

```ts
import Schema from '@deepseek-ai/schemastery';

export interface Config {
  enabled: boolean;
  accountId: string;
  timeoutMs: number;
}

export const Config: Schema<Config> =
  Schema.object({
    enabled: Schema.boolean().default(true),
    accountId: Schema.string().default('default'),
    timeoutMs: Schema.number().default(30000),
  });
```

禁止：

```ts
const TIMEOUT = 30000;
```

如果它可能因部署不同而变化，就必须可在 `cordis.yml` / profile patch 中配置。

---

# 8. ChannelAdapter Contract

```ts
export interface ChannelAdapter {
  readonly id: string;

  readonly capabilities: ChannelCapabilities;

  start(ctx: ChannelAdapterContext): Promise<void>;

  stop(): Promise<void>;

  send(
    target: ChannelTarget,
    message: OutboundMessage,
  ): Promise<SendResult>;

  createReply?(
    target: ChannelTarget,
    options?: CreateReplyOptions,
  ): Promise<ReplyHandle>;

  beginAuth?(): Promise<AuthChallenge>;

  pollAuth?(
    challenge: AuthChallenge,
  ): Promise<AuthState>;

  getHealth?(): Promise<ChannelHealth>;
}
```

AdapterContext：

```ts
export interface ChannelAdapterContext {
  emit(event: ChannelEvent): Promise<void>;

  logger: ChannelLogger;

  secrets: SecretStore;

  storage: ChannelStorage;

  signal: AbortSignal;
}
```

规则：

```text
Adapter = Platform <-> Channel Contract
```

不是：

```text
Adapter = Platform <-> Harness Agent
```

---

# 9. ChannelEvent

第一版 contract：

```ts
export type ChannelEvent =
  | MessageReceived
  | ReactionReceived
  | InteractionReceived
  | MemberJoined
  | MemberLeft
  | ConversationUpdated
  | AuthChanged
  | ConnectionChanged;
```

真正要求首发实现：

```text
message.received
auth.changed
connection.changed
```

其余先稳定类型，为后续渠道生态预留。

---

# 10. MessageReceived

```ts
export interface MessageReceived {
  type: 'message.received';

  channel: string;

  accountId: string;

  conversation: {
    id: string;
    type: 'dm' | 'group';
    threadId?: string;
  };

  sender: {
    id: string;
    name?: string;
  };

  message: {
    id: string;
    content: MessagePart[];
    replyTo?: string;
    createdAt?: number;
  };

  raw?: unknown;
}
```

`raw`：

- 允许调试
- 允许 adapter extension
- 不允许 Core 或 Harness Bridge 直接依赖平台 raw shape

---

# 11. MessagePart

```ts
export type MessagePart =
  | TextPart
  | ImagePart
  | FilePart
  | AudioPart
  | VideoPart
  | LocationPart
  | CardPart
  | UnsupportedPart;
```

原因：

- 图片理解
- ASR
- 文档分析
- 视频理解
- rich interaction

都应该建立在结构化内容上。

禁止把所有平台消息先压成 `text: string`。

---

# 12. ChannelCapabilities

```ts
export interface ChannelCapabilities {
  text: boolean;
  image: boolean;
  file: boolean;
  audio: boolean;
  video: boolean;

  markdown: boolean;
  cards: boolean;
  reactions: boolean;
  threads: boolean;

  streaming:
    | 'native'
    | 'edit'
    | 'buffered';

  maxTextLength?: number;
  maxFileSize?: number;
}
```

禁止在 Core：

```ts
if (channel === 'dingtalk') {}
```

应该使用：

```ts
adapter.capabilities.streaming
```

做 capability negotiation。

---

# 13. ReplyHandle

```ts
export interface ReplyHandle {
  append(delta: string): Promise<void>;

  replace(message: OutboundMessage): Promise<void>;

  finish(message?: OutboundMessage): Promise<void>;

  fail(error: unknown): Promise<void>;
}
```

统一映射：

```text
assistant/chunk
      │
      ▼
ReplyRouter
      │
      ├ native   -> stream
      ├ edit     -> card/message update
      └ buffered -> accumulate + final
```

示例：

```text
DingTalk -> AI Card
Lark     -> editable card/message
Weixin   -> buffered
QQ       -> capability-based
```

---

# 14. Harness Bridge：唯一 Harness API Boundary

`channel-harness` 只负责：

```text
ChannelEvent
    ↓
SessionBinding
    ↓
Agent resolution
    ↓
Agent.followup / steer / inject

session/event
    ↓
ReplyRouter
    ↓
Channel Adapter
```

不负责：

- 微信协议
- QQ Gateway
- 钉钉 Stream
- Lark SDK
- 平台重连策略

---

# 15. Agent 输入语义

普通 IM 用户消息：

```ts
agent.followup(message);
```

用于：

```text
普通聊天
用户新一轮请求
渠道中新消息
```

`steer()` 仅用于明确的执行中纠偏：

```text
Agent 正在运行
用户追加：
“先别处理前端，只看后端”
```

`inject()` 用于不会单独唤醒 Agent 的额外模型上下文：

```text
conversation metadata
tenant context
group policy
platform context
```

不要用 `inject()` 代替普通用户聊天。

---

# 16. AgentManager 与 `AgentHandle` Ownership

这是 v1.1 的关键修正。

Harness：

```text
ctx.agents.get()
```

返回 live `Agent | undefined`。

而：

```text
ctx.agents.create(...)
ctx.agents.resume(...)
```

返回：

```ts
AgentHandle = {
  agent: Agent;
  dispose(): Promise<void>;
}
```

因此 `channel-harness` 需要一个明确的 `AgentManager`：

```text
SessionBinding
    │
    ▼
ctx.agents.get(sessionId)?
    │
    ├ yes -> use live Agent
    │
    └ no
        │
        ├ persisted -> resume() -> AgentHandle
        └ new       -> create() -> AgentHandle
```

Bridge 自己 create/resume 出来的 Handle 必须被持有：

```ts
Map<SessionId, AgentHandle>
```

不能：

```ts
const { agent } = await ctx.agents.create(...);
// 丢弃 handle
```

否则生命周期 ownership 丢失。

---

# 17. Session Binding

```ts
export interface SessionBinding {
  channelId: string;

  accountId: string;

  conversationId: string;

  threadId?: string;

  agentId?: string;

  sessionId: string;

  createdAt: number;

  updatedAt: number;
}
```

建议 identity：

```text
channel:account:conversation[:thread]
```

例如：

```text
weixin:main:user_123
qq:bot01:group_8877
dingtalk:corpA:conversation_x
lark:tenant01:chat_oc_x:thread_y
```

绝不允许：

```text
一个渠道账号 = 一个 Harness Session
```

---

# 18. Session Binding Store

Binding 必须持久化。

优先目标：

```text
Harness-native persistence if suitable
```

如果当前 Harness persistence service 不适合存第三方索引，则提供独立小型 storage adapter。

无论底层使用什么，`channel-harness` 只依赖接口：

```ts
interface SessionBindingStore {
  get(key: ChannelConversationKey): Promise<SessionBinding | undefined>;

  put(binding: SessionBinding): Promise<void>;

  delete(key: ChannelConversationKey): Promise<void>;
}
```

禁止 Adapter 直接读写 Harness persistence。

---

# 19. 输出：只消费官方 `session/event`

Harness 中：

```text
turn/*
step/*
assistant/chunk
assistant/message
tool/call
tool/result
```

属于持久 session event 事实。

因此 ReplyRouter 必须：

```ts
ctx.on('session/event', ...)
```

然后检查：

```ts
event.type
```

首发真正用于 IM 回复：

```text
assistant/chunk
assistant/message
turn/end
```

工具状态：

```text
tool/call
tool/result
```

只作为可选 UX 扩展，不混入基础回复协议。

---

# 20. Cordis Event 与 Channel Event 的关系

Channel 内部业务事件不必全部成为全局 Cordis 事件。

推荐：

```text
Platform
  ↓
Adapter
  ↓
ChannelService.emit(ChannelEvent)
  ↓
Harness Bridge
```

如果未来需要第三方插件观察 Channel Event，可以由 `ChannelService` 再暴露：

```text
channels/event
channels/status
```

但不要第一版把每个平台行为都注册成全局 Cordis 事件。

---

# 21. Upstream Driver

每个 Adapter 内增加独立 Driver 边界：

```text
ChannelAdapter
     │
     ▼
Upstream Driver
     │
     ▼
SDK / package / API / WS
```

示例：

```ts
export interface DingTalkUpstream {
  start(
    handler: DingTalkUpstreamHandler,
  ): Promise<void>;

  stop(): Promise<void>;

  sendText(...): Promise<unknown>;

  createCard?(...): Promise<unknown>;

  updateCard?(...): Promise<unknown>;
}
```

SDK major version 改变时优先只修改 Driver。

---

# 22. Upstream Strategy

允许：

```ts
export type UpstreamStrategy =
  | 'package'
  | 'sdk'
  | 'source';
```

优先级：

```text
package > sdk > source
```

其中：

### package

上游公开 API 本身可独立使用。

### sdk

上游 channel plugin root 与其他 runtime 耦合，但底层官方 SDK 独立。

### source

真正有价值的协议实现只存在于 tagged source。

`source` 是最后手段。

---

# 23. Compatibility Manifest

每个 Adapter：

```ts
export const manifest = {
  id: 'dingtalk',

  adapterVersion: '0.1.0',

  upstream: {
    reference:
      'DingTalk-Real-AI/dingtalk-openclaw-connector',

    testedVersion:
      '0.8.24',

    versionRange:
      '>=0.8.20 <0.9.0',

    strategy:
      'sdk',
  },

  sdk: {
    package:
      'dingtalk-stream',

    testedVersion:
      '2.1.4',
  },
};
```

状态：

```text
tested
compatible
untested
unsupported
```

---

# 24. `channel-testkit`：第一阶段就做

结论不变：

> **必须第一阶段做。**

但 v1 只做：

```text
Contract Tests
Fake Adapter
Fake Upstream
Payload Fixtures
Fake Harness
Harness E2E
Harness Compatibility Regression
```

---

# 25. Adapter Contract Tests

提供：

```ts
runChannelAdapterContract(...)
```

验证：

- start / stop
- repeated stop
- AbortSignal
- register / unregister
- event emit
- send
- capabilities
- cleanup
- error mapping
- health
- duplicate handling

第三方 Adapter 想标记 compatible，必须通过。

---

# 26. Payload Fixtures

```text
fixtures/
├ weixin/
│  ├ inbound-text.json
│  ├ inbound-image.json
│  └ inbound-audio.json
│
├ qq/
├ dingtalk/
└ lark/
```

fixture 建议：

```json
{
  "name": "inbound text",
  "upstreamVersion": "x.y.z",
  "payload": {},
  "expected": {}
}
```

上游升级自动回归。

---

# 27. Harness Compatibility Regression

由于 Harness 当前仍可能 breaking change，CI 要额外验证：

```text
ChannelEvent
    ↓
channel-harness
    ↓
ctx.agents create/resume/get
    ↓
followup
    ↓
session/event
    ↓
ReplyRouter
```

建议 CI 至少包含：

```text
Harness pinned-current
Harness latest-compatible
```

以后 Harness API 稳定后可以减少矩阵。

---

# 28. DSH Bundle：`@dsh/channels`

`packages/channels` 是 Harness 正式 Bundle：

```json
{
  "name": "@dsh/channels",
  "version": "0.1.0",
  "type": "module",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

示意 patch：

```yaml
- insert:
    - id: channels-service
      name: '@dsh/channel-core/plugin'

    - id: channels-harness
      name: '@dsh/channel-harness'
      inject:
        - channels
        - agents

    - id: channels-weixin
      name: '@dsh/channel-weixin'
      inject:
        - channels

    - id: channels-qq
      name: '@dsh/channel-qq'
      inject:
        - channels

    - id: channels-dingtalk
      name: '@dsh/channel-dingtalk'
      inject:
        - channels

    - id: channels-lark
      name: '@dsh/channel-lark'
      inject:
        - channels
```

实际 inject 名称以实现时 Harness 当前 public service 为准。

---

# 29. 安装体验

正式：

```bash
dsh plugin --profile default add @dsh/channels
```

也允许第三方：

```bash
dsh plugin --profile default add @foo/dsh-channel-telegram
```

如果直接从 GitHub 安装 TypeScript package，需要遵守 Harness 官方 bundle/profile 和 prepare/build 安全模型。

正式发布建议优先 npm 预构建产物，减少用户安装时构建授权。

---

# 30. 独立 Adapter 安装

高级用户可以：

```bash
dsh plugin --profile minimal add @dsh/channel-weixin
```

前提：

```text
adapter package 自己提供 dsh.bundle
```

或者安装一个轻量 bundle：

```text
@dsh/channel-weixin-bundle
```

是否把“library + bundle”放同一 package，可在实现时按 package DX 决定。

---

# 31. 发布策略

Monorepo + independent versions：

```text
@dsh/channel-core       0.3.0
@dsh/channel-harness    0.4.2
@dsh/channel-testkit    0.2.0
@dsh/channel-compat     0.2.0

@dsh/channel-weixin     0.8.1
@dsh/channel-qq         0.5.4
@dsh/channel-dingtalk   0.7.0
@dsh/channel-lark       0.6.3

@dsh/channels           0.9.0
```

工具：

- pnpm workspace
- Turbo
- Vitest
- Changesets
- Renovate / Dependabot

---

# 32. 上游更新策略

```text
Upstream new version
       ↓
Renovate PR
       ↓
typecheck
       ↓
adapter contract
       ↓
payload fixtures
       ↓
adapter-specific tests
       ↓
Harness compatibility
       ↓
E2E
       ↓
update testedVersion
```

禁止：

```text
依赖 latest
+
未经测试自动部署
```

---

# 33. 第三方 Channel SDK

对外：

```ts
import {
  defineChannelAdapter,
  type ChannelAdapter,
  type ChannelEvent,
  type ChannelCapabilities,
} from '@dsh/channel-core';

import {
  runChannelAdapterContract,
} from '@dsh/channel-testkit';
```

第三方：

```ts
export default defineChannelAdapter({
  id: 'telegram',

  capabilities: {
    text: true,
    image: true,
    file: true,
    audio: true,
    video: true,
    markdown: true,
    cards: false,
    reactions: true,
    threads: true,
    streaming: 'edit',
  },

  async start(ctx) {
    // ...
  },

  async send(target, message) {
    // ...
  },
});
```

无需修改：

```text
channel-core
channel-harness
DeepSeek Harness source
```

---

# 34. 第三方扩展方向

## Tier 1 — Messaging / Team Chat

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

---

## Tier 2 — 社区 / 社交

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

---

## Tier 3 — 客服

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

---

## Tier 4 — 自有入口

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

---

## Tier 5 — 通知类

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

---

## Tier 6 — Voice / Realtime

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

---

# 35. Channel 与 Tool 的边界

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

---

# 36. 第三方成熟度

建议：

```text
Experimental
Beta
Stable
Verified
```

Verified 要求：

- Contract Tests
- lifecycle
- fixtures
- no plaintext credential
- health
- reconnect/backoff
- duplicate protection
- capabilities
- compatibility manifest
- docs
- example

未来：

```bash
dsh channels verify ./my-adapter
```

---

# 37. 架构红线

出现以下代码即视为架构退化。

## 红线 1

Core：

```ts
if (channel === 'weixin')
```

## 红线 2

Adapter：

```ts
ctx.agents.get(...)
```

## 红线 3

Harness Bridge：

```ts
import 'dingtalk-stream';
```

## 红线 4

Root package 安装所有渠道 SDK。

## 红线 5

上游自动追 `latest` 并直接运行。

## 红线 6

平台 raw payload 直接塞给模型。

## 红线 7

一个账号只有一个 Harness Session。

## 红线 8

`ctx.agents.create()` 后丢弃 `AgentHandle`。

## 红线 9

直接依赖 Harness private/internal source，而不是 public package API。

---

# 38. 最终架构

```text
                         DeepSeek Harness
                               │
                           Cordis Runtime
                               │
             ┌─────────────────┴─────────────────┐
             │                                   │
         Agent Service                      ChannelService
             │                                   │
             │                            Adapter Registry
             │                          ┌────┬────┬────┬────┐
             │                          │    │    │    │    │
             │                         WX   QQ   DD   Lark  ...
             │                          │    │    │    │
             │                         Driver / SDK / Upstream
             │
             └────────────── channel-harness ────────────────┐
                                      │                      │
                              SessionBinding / AgentManager  │
                                      │                      │
                            followup / steer / inject        │
                                                             │
                               session/event ────────────────┘
                                      │
                                  ReplyRouter
                                      │
                                  ReplyHandle
                                      │
                                      ▼
                                  IM Platform
```

---

# 39. 最终决策

正式采用：

> **Harness-native Cordis Service + DSH Bundle + Monorepo + Stable Channel Contract + Thin Harness Bridge + Independent Adapter + Upstream Driver + First-class Testkit + Compatibility Governance**

各层职责：

```text
Channel Core
= 稳定跨渠道 Contract + Cordis ChannelService

Harness Bridge
= Harness public API 的薄适配层

Adapter
= 平台语义 <-> Channel Contract

Upstream Driver
= SDK/package/API 版本隔离

Testkit
= Adapter 与 Harness 双向兼容保护

Compat
= 上游版本治理

DSH Bundle
= 用户安装与组合体验
```

最重要的目标不是完成四个渠道。

而是：

> **第五个、第十个、第三十个渠道加入时，不修改 Channel Core；Harness breaking change 发生时，优先只修改 channel-harness。**
