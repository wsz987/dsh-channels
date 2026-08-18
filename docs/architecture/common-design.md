---
title: 公共/统一代码设计
summary: Channel Contract、ChannelService、Harness Bridge、通用控制面、DSH Bundle 的已落地设计。
when_to_use: 改共享代码 | Contract | Bridge | 控制面 | Bundle | channel-core | channel-harness
authoritative: 统一 Contract（Adapter/Event/MessagePart/Capabilities/Reply）、Bridge、控制面、Bundle、已落地补充。
see_also: [../architecture.md, ../adapter-authoring.md, adr/0002-image-model-fallback.md]
status: as-built
---

# 公共 / 统一代码设计

> 本文档描述跨渠道共享代码（`channel-core` / `channel-harness` / `channel-control` /
> `channel-web` / `channel-files` / `channel-testkit` / `channel-compat`）的**已落地**设计。
> 总览与红线见 [architecture.md](../architecture.md)；第三方接入指南见
> [adapter-authoring.md](../adapter-authoring.md)。

## ChannelService：正式 Cordis Service

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

## Adapter 插件加载方式

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

---

## 通用 Channel Control Plane（`channel-control`）

多渠道配置与 Harness Web 接入的最终形态：不按渠道各写一套
Web 业务代码。Weixin、钉钉、飞书/Lark 使用真实 Auth Session；QQ 使用 AppID/AppSecret 凭证表单和官方控制台入口。钉钉可直接扫码注册并回填凭证；飞书/Lark 必须先保存应用凭证，再扫码完成增量授权。

### 职责分层

```text
channel-core     稳定 Channel Contract（Adapter / Event / Message / Health）
channel-control  配置 · Credential · Auth Session · Runtime mount（ctx.channelControl）
channel-web      HTTP API（/api/v1 兼容 + /api/v2 控制面）· Harness Settings UI
channel-harness  ChannelEvent → Session Binding → Agent → ReplyRouter（不参与扫码）
```

- `ChannelDefinition`：平台差异的密封点。每个渠道插件在 `apply()` 里向
  `ctx.channelControl.definitions` 注册自己的 Definition（QQ / DingTalk / Lark / Weixin），
  控制面通过 `createAdapter()` 决定何时 mount，而不是插件一加载就必须连接。
- 未配置的 channel 不会使 Harness Profile 启动失败：`autoStartAll()` 跳过
  `configured=false` 的定义，失败只记日志。
- headless 能力保留：预先在 profile config + `ctx.credentials` 配好的渠道仍然开机自动挂载。

### Auth Session 模型

```text
AuthMethod = qr | device | portal-login | credentials | hybrid
AuthPhase  = preparing | waiting-scan | scanned | waiting-confirm
           | verification-required | credentials-required | authorized
           | expired | failed | cancelled
AuthState  = pending | authenticated | expired | failed
```

- 浏览器只拿 `PublicAuthSession`（id / channelId / state / phase / qr / expiresAt / prompt），
  Secret、token、internal challenge 永不出进程。
- `AuthSessionManager`：一个 channel/account/method 默认最多一个 active session；新 session
  会 cancel 旧 pending session；session id 用 `crypto.randomUUID()`。
- 轮询节流由 Host 控制：`nextPollAt` 之前不真正访问 Provider。
- QR 是结构化对象 `{ kind: 'content' | 'data-url' | 'external-url', value, expiresAt }`。
- Auth Session 只用于平台确实提供、且 Host 能轮询验证的授权流程。当前内置渠道的
  Weixin、DingTalk、Lark 均有对应的 Host `beginAuth()` / `pollAuth()` 实现；QQ 使用
  AppID/AppSecret 凭证设置，不创建 Auth Session。各渠道的前置条件和完成语义不同，
  不能把扫码成功统一解释为 Channel 已连接。
  官方控制台 URL 仍通过 `setupUrl` 作为普通链接展示，不冒充 provider 授权二维码。

### Runtime 生命周期

- `mountChannelAdapter`（channel-core）现在返回 `ChannelMountHandle`（Cordis effect disposer，
  幂等；父 fiber unload 仍自动清理）。
- `ChannelRuntimeManager`：`Map<ChannelAccountKey, ChannelMountHandle>`，内部支持 start / stop / restart；
  restart = resolve config → resolve secrets → build candidate adapter → dispose old mount →
  mount → start → getHealth。
- Web 通过一次 `PUT /channels/:id/setup` 提交普通配置与 Secret；Host 分流保存后自动重挂并读取 health。
- start / stop / restart 不作为 Web 用户操作或公开控制面 API 暴露。
- 授权完成 ≠ 已连接：最终必须 `adapter.getHealth()` 才算 runtime connected（见下文「已落地设计补充」）。

### 凭据边界

- 配置只携带对机密的**引用**，绝不携带机密本身：`ctx.credentials.resolve/describe/set/unset`。
- QQ `appSecretRef`、钉钉 `clientSecretRef`（默认 `DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET`）、
  飞书 `appSecretRef`（默认 `DSH_CHANNEL_LARK_MAIN_APP_SECRET`）。
- 旧明文 `clientSecret` / `appSecret` 配置一次性迁移到凭据存储并删除明文。
- Web 永远读不到 Secret 原值或 credential ref；`GET setup` 只返回动态
  `{ configured, writable }`，统一保存响应也不 echo Secret。
- Weixin 的 bot token 仍走 Channel SecretStore（平台运行期产生的账号凭据），不与部署级
  AppSecret 混淆。

通过 `ctx.on()` 注册的 Cordis 事件监听器由框架自动清理。

---

## 插件配置：Schemastery

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

## ChannelAdapter Contract

```ts
export interface ChannelAdapter {
  readonly id: string;

  readonly capabilities: ChannelCapabilities;

  /** 流式模式可按 target 覆写（如 QQ：C2C native / group buffered）。 */
  resolveStreamingMode?(target: ChannelTarget): StreamingMode;

  start(ctx: ChannelAdapterContext): Promise<void>;

  stop(): Promise<void>;

  send(
    target: ChannelTarget,
    message: OutboundMessage,
  ): Promise<SendResult>;

  /** 可选「正在输入」指示；失败不得中断回复投递。 */
  startTyping?(conversationId: string): Promise<void>;
  stopTyping?(conversationId: string): Promise<void>;
  startTypingForTarget?(target: ChannelTarget): Promise<void>;
  stopTypingForTarget?(target: ChannelTarget): Promise<void>;

  createReply?(
    target: ChannelTarget,
    options?: CreateReplyOptions,
  ): Promise<ReplyHandle>;

  beginAuth?(): Promise<AuthChallenge>;

  pollAuth?(
    challenge: AuthChallenge,
  ): Promise<AuthStatePoll>;

  submitAuthInput?(challenge: AuthChallenge, input: AuthInput): Promise<void> | void;

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

## ChannelEvent

Contract：

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

当前实际实现：

```text
message.received
auth.changed
connection.changed
```

其余类型已稳定，为后续渠道生态预留。

---

## MessageReceived

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

## MessagePart

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

二进制 part（Image / File / Audio / Video）共享 `BinaryPartBase`，字节载体四选一：

- `url` —— 仅真实 `http(s)` URL（安全远程抓取器唯一接受的载体）
- `resourceRef` —— 平台不透明句柄（Lark image_key / Telegram file_id / DingTalk mediaId），只由平台上游解析为字节
- `dataUri` —— 内联 data URL
- `localData` —— 适配器已下载/解密的受信字节（优先）；Core 不解码不落盘，由 Harness bridge 转成真实附件

二进制元数据分为两个信任等级：

- **MIME hint**：平台字段、HTTP `Content-Type` 或文件名扩展名提供的提示。各适配器
  使用 `@wsz987/channel-core` 导出的 `normalizeMimeHint` / `mimeHintFromFilename`，不要维护
  渠道私有扩展名表。`application/octet-stream` 等泛型值视为“未知”，继续尝试下一来源。
- **Verified MIME**：基于实际字节签名得到的结果。通用文件进入 `channel-files` 后由
  magic-signature 嗅探重新验证；扩展名、响应头和平台字段都不能作为解析或安全判断的事实。

`mime-types` 只负责维护“文件名 → MIME hint”数据库，不做内容验证。平台专属 SDK/API
下载仍归适配器；内容验证、落盘和文档解析仍归公共附件层。

原因：

- 图片理解
- ASR
- 文档分析
- 视频理解
- rich interaction

都应该建立在结构化内容上。

禁止把所有平台消息先压成 `text: string`。

---

## ChannelCapabilities

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

## ReplyHandle

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

## Harness Bridge：唯一 Harness API Boundary

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

## Agent 输入语义

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

## AgentManager 与 `AgentHandle` Ownership

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

## Session Binding

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

## Session Binding Store

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

## 已有 Binding 的 Session 恢复顺序（对齐官方 Host resolver）

已有 binding 的入站消息按官方 Host resolver 的顺序解析：**live Agent 是第一优先级**，
先查 `ctx.agents`，命中即借用，**绝不先扫持久化 Session 索引**（几千/几万 Session 后
每条入站的 `persistence.list()` 会成为热点）。

```text
binding 存在
  → live?（ctx.agents.get）
      ├─ yes → borrow（不碰 persistence）
      └─ no
           → atomic persistence probe
                ├─ unavailable + durable binding  → 抛 persistence-unavailable
                ├─ unavailable + ephemeral binding → recreate
                ├─ present                         → resume
                └─ missing + durable binding       → 抛 session-not-found
                   missing + ephemeral binding     → recreate
```

- **durability policy 与 capability availability 分离**：新 binding 记录稳定的
  `durability: ephemeral | durable`；旧 binding 缺失该字段时按 durable fail closed。
  `unavailable` 只表示 persistence 当前不可用，不能把 deployment 动态改判为
  ephemeral。
- **ephemeral binding**：允许按 recorded id recreate。`ChannelSessionFactory.recreate`
  会重跑 `workspaceResolver`（落到 channel workspace cwd，而不是 host cwd）、软
  attach workspace、保留 durable binding（仅刷新 `updatedAt` 与 route 快照）。
- **有 persistence 时，binding 指向的 persisted session 缺失** = binding/session
  durability 不一致（通常不是「第一次创建」），抛 `SessionNotFoundError`
  fail loud，**绝不**静默用同 ID 空 Session 顶替 —— 对齐官方
  「persisted identity missing → session-not-found」。
- **`/new` = 显式 stale-binding repair，不是普通 session recovery**：旧 Session 已
  不可恢复（持久化数据缺失）时，只有 `/new` 允许用户**显式授权**废弃旧引用并创建
  新会话 —— 直接 bootstrap 新 Session 并覆盖 binding（复用
  `ChannelSessionFactory.create` 事务，失败仍回滚）。普通消息 / `/model` /
  `/status` / 其他命令一律 fail loud，不一致**绝不**自动修复；`/new` 与
  `session-not-found` 语义不冲突（一个是用户授权重建，一个是自动恢复失败），
  未来维护者不应把它理解成普通恢复规则的组成部分。
- 恢复路径集中在 `channel-harness`：`AgentManager.borrowIfLive` /
  `resolve` + `ChannelSessionFactory.recreate`，bridge 只编排顺序，不引入
  error-regex 兜底。

---

## 输出：只消费官方 `session/event`

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

实际用于 IM 回复：

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

## Cordis Event 与 Channel Event 的关系

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

但不要把每个平台行为都注册成全局 Cordis 事件。

---

## Upstream Driver

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

## Upstream Strategy

每个渠道 Adapter 的上游接入策略（见 [ADR 0001](adr/0001-upstream-first-channel-platform-boundary.md) 与
`packages/channel-compat/src/upstream-manifest.ts` 的固定基线）：

```ts
export type UpstreamStrategy =
  | 'official-sdk'                  // 直接消费官方 SDK
  | 'official-host-neutral-subpath' // 通过单一 vendor-compat 深导入消费官方 host-neutral 原语
  | 'minimal-official-api-port'     // 只 port 官方最小 API
  | 'source-port';                  // 上游插件与宿主耦合、无 host-neutral 分发时的显式 source port
```

优先级：

```text
official-sdk > official-host-neutral-subpath > minimal-official-api-port > source-port
```

其中：

- `official-sdk`：上游提供独立可用的官方 SDK（QQ `qqbot-nodejs`、Lark `node-sdk`）。
- `official-host-neutral-subpath`：上游 channel plugin root 与 OpenClaw runtime 耦合，
  但其底层官方原语可经单一 vendor-compat 深导入边界消费。
- `minimal-official-api-port`：只 port 官方最小 API 面（DingTalk：`dingtalk-stream`
  inbound + 最小 OAPI port）。
- `source-port`：真正有价值的协议实现只存在于 tagged source（Weixin iLink）。这是
  最后手段，只在官方没有 host-neutral 分发时使用。

---

## Compatibility Manifest

每个 Adapter 暴露一个结构性的 `manifest`（`AdapterManifest`：`id` / `adapterVersion` /
`upstream`（reference / testedVersion / 可选 testedCommit / versionRange / strategy）/
可选 `sdk` / `status`）。`status` 枚举为 `tested | compatible | untested | unsupported |
experimental`。

完整的字段示例、状态语义与校验规则见 [adapter-authoring.md §7](../adapter-authoring.md)
（`getAdapterManifest` / `validateManifest` 由 `channel-compat` 结构性读取，不 import 适配器包）。

---

## 测试与上游治理

- `channel-testkit` 提供：Contract Tests、Fake Adapter、Fake Upstream、Payload Fixtures、
  Fake Harness、Harness E2E、Harness Compatibility Regression。第三方 Adapter 的契约测试
  （`runChannelAdapterContract`）与 fixtures 用法见 [adapter-authoring.md](../adapter-authoring.md)。
- `channel-compat`：上游版本治理（`doctor` / `check:fixtures` / `check:manifests`）、
  固定上游基线（`upstream-manifest.ts`）与兼容状态判定。
- `channel-verify`：`pnpm verify` 的仓库内实现（package / adapter surface / manifest /
  capabilities / fixtures / credentials / contract 七项）。

### Harness Compatibility Regression

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

## DSH Bundle：`@wsz987/dsh-channels`

`packages/channels` 是 Harness 正式 Bundle：

```json
{
  "name": "@wsz987/dsh-channels",
  "version": "0.4.0",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./service": "./lib/service.js",
    "./files": "./lib/files.js",
    "./harness": "./lib/harness.js",
    "./control": "./lib/control.js",
    "./weixin": "./lib/weixin.js",
    "./qq": "./lib/qq.js",
    "./dingtalk": "./lib/dingtalk.js",
    "./lark": "./lib/lark.js",
    "./client": "./lib/client.js"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web"
    }
  }
}
```

patch 只引用该 bundle 自己的 exports；实现包是 bundle 的内部依赖，不要求
pnpm 将传递依赖提升到 profile 根目录。根入口同时承载 Web host 插件，
`./client` 是同一包的 Harness Web 客户端产物。

实际 patch（`packages/channels/cordis.patch.yml`，共 9 个插件，可逐项在 profile patch 中删除/禁用）：

```yaml
- insert:
    - id: channels-service
      name: '@wsz987/dsh-channels/service'

    # 可选通用文件扩展；删除此行则仅保留文本占位符
    - id: channels-files
      name: '@wsz987/dsh-channels/files'

    - id: channels-harness
      name: '@wsz987/dsh-channels/harness'
      inject: [channels, agents, agentDefaultModel, llm, commands]

    - id: channels-control
      name: '@wsz987/dsh-channels/control'
      inject: [channels, credentials]

    - id: channels-weixin
      name: '@wsz987/dsh-channels/weixin'
      inject: [channels, channelControl]

    - id: channels-qq
      name: '@wsz987/dsh-channels/qq'
      inject: [channels, credentials, channelControl]

    - id: channels-dingtalk
      name: '@wsz987/dsh-channels/dingtalk'
      inject: [channels, credentials, channelControl]

    - id: channels-lark
      name: '@wsz987/dsh-channels/lark'
      inject: [channels, credentials, channelControl]

    - id: channels-web
      name: '@wsz987/dsh-channels'
```

`inject` 名称以 Harness 当前 public service 面为准（已在 `channel-harness` 收敛）。

---

## Harness 集成约束（速查）

以下为共享代码接入 Harness 时的硬性用法约定（AGENTS.md §5.2 指向此处）：

- **DSH Bundle**：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`；patch 行只引用 bundle 自己的 exports，实现包作内部依赖，不要求 pnpm 提升传递依赖到 profile 根。
- **patch 语义**：`cordis.patch.yml` / profile patch 是**整体替换**目标插件 `config`，不是深度合并；覆盖时必须保留该插件完整字段。
- **Cordis 插件形态**：`export const name` / `export const inject` / `export function apply(ctx, config)`；WS、long-poll、Gateway、heartbeat 等手动资源放 `ctx.effect()`；事件监听走 `ctx.on()` 由框架自动清理。
- **inject 名称**：只用 Harness public service 名（`channels`、`channelControl`、`agents`、`credentials`、`llm`、`commands`、`agentDefaultModel`），禁止私造 key。
- **命令**：统一走 `commandFactories` / `ctx.commands.register`；命令名 lowercase、以 `/` 开头；handler 返回 `{ kind: 'success' | 'error', text }`；未注册命令不再被拦截（作为普通用户输入交给模型）；命令结果不进模型历史。
- **Agent 输入语义**：普通聊天 `agent.followup()`；执行中纠偏才用 `agent.steer()`；额外上下文用 `agent.inject()`（不得代替聊天）。
- **回复只消费官方 `session/event`**：`assistant/chunk`、`assistant/message`、`turn/end`；`tool/call` / `tool/result` 只作可选 UX，不混入回复协议。
- **配置与凭据**：部署可调参数进 Schemastery 配置，禁止写死常量；凭据只经 `ctx.credentials` 引用（如 `appSecretRef`），配置/patch 禁止明文 Secret。

---

## 已落地设计补充

以下设计已随实现落地，补充记录于此，避免后续维护者误判为未设计。

### 工作区隔离（channel-account workspace）

`channel-harness` 内置 workspace resolver：默认 `mode: 'channel-account'`，为每个**渠道 / 账号**对分配一个独立 Harness Workspace，路径 `<dsh-home>/workspaces/channels/<channel>/<account-key>`，缺失时自动创建。各渠道会话的 cwd 与文件互不串扰。

配置位于 `channels-harness` 的 `config.workspace`：

```yaml
workspace:
  mode: channel-account   # channel-account（默认）| host-cwd | disabled
  root: <可选，默认 <dsh-home>/workspaces/channels>
  autoCreate: true        # 默认 true
```

- `channel-account`：每渠道 / 账号一对独立 Workspace（默认）
- `host-cwd`：复用宿主当前工作目录，仅当该目录已注册时关联
- `disabled`：不接入 WorkspaceRegistry，cwd 回退 `config.cwd ?? process.cwd()`

### 图片管道（Harness 原生 attachment）

各渠道的图片适配器统一产出 `ImagePart.localData + mimeType`，随后走 Harness 官方附件能力：

```
渠道官方 SDK / API 下载 → ImagePart.localData（明文字节）
        → channel-harness message-converter → ctx.attachments.saveImage
        → { type: 'image', attachment: ref }（真实 ImageBlock）
```

适配器负责各平台的下载/解密和上传，`channel-harness` 不复制平台 SDK 实现。
文本-only 模型的图片兼容策略（`imageCompatibility.mode`：`degrade` 默认 /
`reject`，属显式 Channel 策略而非 Web host parity）见
[ADR 0002](adr/0002-image-model-fallback.md)（产品策略）与
[ADR 0003](adr/0003-image-compatibility-pre-step.md)（实现 seam：`agent/pre-step`
logged surface replace，按官方 Model-visible ⇔ durably referenced 不变式；
当前 `llm/stream` 改写仍是 shipped 实现，迁移未落地前不得扩展）。

### 入站日志与媒体诊断规范

适配器必须在媒体 hydration 完成后、`ctx.emit(event)` 前输出一条结构化入站摘要。
日志使用 `ctx.logger('channel-<name>')` 取得的适配器专属 namespace；`web:debug`
通过 `DSH_CHANNELS_DEBUG=1` exporter 输出这些 namespace。

推荐格式：

```ts
ctx.logger.info(
  `[channel-telegram] inbound message ${event.message.id} ` +
    `from ${event.sender.id} in ${event.conversation.id}`,
  {
    parts: event.message.content.map((part) => partSummary(part)),
  },
);
```

二进制 part 的摘要只记录诊断字段，不记录秘密和内容：

```ts
{
  type: 'image',
  resourceRef: part.resourceRef,
  mimeType: part.mimeType,
  localDataBytes: part.localData?.byteLength,
  ingressFailure: part.ingressFailure,
}
// file: name, mimeType, size, localDataBytes, ingressFailure
```

`localDataBytes` 是媒体链路的关键断点：没有它时，`message-converter` 无法调用
`ctx.attachments.saveImage` 生成真实 `ImageBlock`，只能降级成 `[image]`；文件则只能
降级成文件占位符。日志摘要不得包含 bot token、签名 URL、文件正文或完整 `event.raw`。

每新增一个适配器 logger namespace，必须同步：

1. 在 `packages/channel-harness/src/debug-logger.ts` 的 exporter `levels` 中加入 `channel-<name>: 3`。
2. 在 `packages/channel-harness/test/debug-logger.test.ts` 增加 namespace 可见性测试。
3. 在适配器入站测试中断言 hydration 后的 `localDataBytes` / `ingressFailure`，并验证日志摘要覆盖图片和文件。

这样 `pnpm web:debug` 只负责展示诊断，不改变消息语义；真正的图片/附件转换仍统一由
`channel-harness` 的公共管道完成。

连接与认证状态事件（`connection.changed` / `auth.changed`）属于控制面，不属于 Agent
入站消息。`channel-harness` bridge 对这两类事件必须静默返回，避免启动和重连期间把正常
状态变化刷成大量 `ignoring channel event`；状态详情由 `channel-control` / `channel-web`
的状态订阅和健康检查展示。只有未知的未来事件才应由 bridge 记录 debug 日志。

### 通用文件是可替换扩展

Harness `0.1.0-rc.7` 的 `ctx.attachments` 只提供栅格图片的验证、保存和读取，
当前 `ContentBlock` 也没有通用 `FileBlock`。因此 PDF / DOCX / XLSX / 文本
暂由 `@wsz987/channel-files` 补充：

```text
各渠道 FilePart.localData
  → channel-harness 的可选 ChannelFileProvider 端口
  → channel-files 私有存储 + 成熟解析库 + read_channel_attachment
```

`channel-core` 与五个适配器不知道解析格式；`channel-harness` 也不依赖扩展包，
只通过 `ctx.get('channelFiles')` 尝试获取 provider。bundle 默认加载该扩展，但可
删除 `channels-files` 配置行。未来 Harness 提供官方通用文件能力时，只替换或移除
provider，不修改适配器、Channel Contract 和会话路由。

PDF 解析使用 `unpdf`（PDF.js），DOCX 使用 `mammoth`，XLSX 使用 `xlsx`；这些
依赖全部归属 `channel-files`，禁止重新加入 `channel-harness`。

### 媒体安全硬化 + 主动外发 + 命令面

- **媒体安全硬化**（`channel-core/src/media/`）：`secure-fetcher` 只接受真实
  `http(s)` URL 的远程媒体，`remote-policy` 做 host / 大小 / MIME 约束，
  `bounded-response` 限制下载字节上限；适配器下载到 `ImagePart.localData`
  后走上文「图片管道」原生图片链路。微信入站图片与通用文件统一限制 **100 MiB**。
- **主动外发（outbox）**（`channel-harness/src/outbox/`）：`send_channel_message`
  Harness 工具支持主动文本/媒体外发，能力由 `outbox/capabilities` 按渠道协商
  （飞书 / QQ 全量，钉钉仅 SDK 模式，微信按上游能力暴露）。
- **命令面**（`channel-harness/src/commands/`）：以官方 `@deepseek-ai/dsh-commands`
  格式注册斜杠指令（`/stop` `/new` `/help` `/status` `/models` `/model`），`commandFactories`
  是唯一注册点，随 Agent 自动注册。`/stop` 由 Bridge Fast Path 调度（立即终止、不等渠道
  排队消息），并配合 per-conversation generation barrier 与 stop barrier 覆盖 `/new` 竞态；
  `/model` 通过官方 Host `session.selectModel` 或 headless
  `installModelSelection` 切换模型，绝不改写 `binding.route`。
  **未注册的斜杠指令不再被拦截**：`commands.execute()` 对未知指令返回 `undefined`，
  渠道回退为普通用户输入交给模型；Agent scope 会 shadow 同名 global（同 scope 重名注册直接报错）。
- **通用控制面 + Web 设置**（`channel-control` + `channel-web`，见上文「通用 Channel
  Control Plane」）：扫码 / 设备授权 / 凭证表单统一为 `AuthSession` 模型，浏览器只
  消费净化的 `PublicAuthSession`，Secret 永不离开进程。

#### 命令面：服务访问规范（易错点）{#command-plane-service-access}

核心：`invocation.agent.ctx` 是 agent-loop 的作用域 ctx，**只用于注册 agent-local 贡献**
（`agentCtx.inject(['commands'], …)` 注册命令 / tools / prompt 片段，随 agent 生命周期回收），
**不是读 Harness 服务的入口**。

- **命令 handler 禁止 `invocation.agent.ctx.X` 读服务**（`commands` / `llm` 等）：agent-loop 作用域
  未注入这些服务，Cordis 属性访问直接抛 `cannot get property "X" without inject`（官方
  `CommandInvocation` 只有 `{ commandId, agent, rawInput, signal }`，没有 ctx）。要访问服务走
  `deps` 窄能力注入（同 `/new` 的 `deps.startNewSession` 模式）：`startNewSession` / `modelSelection`
  / `listCommands` / `findCommand` / `llm`，bridge 在构造时从插件 ctx 惰性桥接。示例：
  `packages/channel-harness/src/commands/help.ts`、`src/commands/model.ts`、`src/bridge.ts` 的
  `commandDeps` 归一化。
- **插件 ctx（`options.ctx`）属性访问服务合法**：channel-harness 的 `inject` 列表已声明
  `commands` / `llm` / `agentDefaultModel`，所以 bridge 里 `options.ctx.commands.…` 可用；但
  **未经注入的作用域**（agent.ctx）属性访问会抛 without inject。
- **`ctx.get(name)` 是官方探测 API**：直接查根 store、任何作用域（含 agent.ctx）都安全、未提供
  返回 `undefined`。可选 seam（`sessionPersistence` / `attachments` / `channelFiles` /
  `agentDefaultModel`）一律用 `get`；`agentDefaultModel` 使用官方
  `@deepseek-ai/dsh-agent-default-model` 的 `AgentDefaultModelConfig` 类型（禁止本地结构体 port）。
- **模型选择遵循 Harness 的两层语义**：Harness 在创建/恢复 Session 时读取
  `session.requestHeader`、显式 `agentOptions`，或共享的 `agentDefaultModel`。当前 Session
  的 `/model` 切换则直接委托官方 Host `session.selectModel` RPC；无 Web Host 的 headless
  渠道使用官方 `installModelSelection` hook。两条路径都保存 `agentDefaultModel`，因此
  当前 Session 与未来新 Session 仍由同一套 Harness 语义衔接。
- **channel 不维护竞争 owner**：每个 Agent setup 时只记录一次 `host` 或 `local` 策略，
  不缓存 `apiProxy` 身份，也不在首条消息前调用 `session.models` 做 `prepare()`。已有 Agent
  不会因为 Host 后挂载而动态增加第二个 waterfall；Host 策略仍每次解析当前的 `apiProxy`
  实例，以支持 HMR 替换后的恢复。图片 `agent/pre-step` 读取该 Agent 当前策略对应的
  Session 模型视图。
- **回归测试验证边界**：`commands-model.test.ts` 覆盖当前 Session 切换、默认保存、
  reasoning 校验、header/options 优先级，并断言不需要 first-turn RPC。
- **测试易错**：fake agent 用 `createScope(rootCtx, agent)` 会继承根服务、掩盖真实环境 agent
  作用域未注入的差异；凡 handler 读服务的用例，用无注入的裸 `new Context()` 替换 fake `agent.ctx`
  模拟真实环境，并（改代码前）断言旧写法确实失败。参考
  `packages/channel-harness/test/commands-help-status-models.test.ts` 的「real-env agent scoped
  context」用例。
