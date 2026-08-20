---
title: DSH Channels 最终架构与入站访问控制执行方案
summary: >
  基于 wsz987/dsh-channels main@78655a40 的当前代码与既有规划，
  收敛 Channel Web 已落地架构，并为所有外部入站消息建立统一、
  Fail-Closed、Owner-aware 的访问控制与激活机制。
status: implemented-offline-verified
repository: https://github.com/wsz987/dsh-channels
branch: main
baseline_commit: 78655a40a266c4122ecd0c030b0a882fdb92f2df
baseline_date: 2026-08-19
plan_date: 2026-08-20
supersedes:
  - 旧版 Channel Inbound Access Control & Activation 方案
  - docs/dsh-channels-channel-web-refactor-plan.md 中尚未实现的 Access Control 规划部分
authoritative_after_implementation:
  - docs/architecture.md
  - docs/security/inbound-access-control.md
  - docs/security/channel-identity-map.md
see_also:
  - docs/architecture/common-design.md
  - docs/adapter-authoring.md
  - docs/dsh-channels-channel-web-refactor-plan.md
---

# DSH Channels 最终架构与入站访问控制执行方案

> 本文是已落地实现的执行与核验记录；真实平台权限与 live gate 仍按渠道分别验证。
>
> 代码事实以当前工作树和对应提交为准；长期安全语义同步维护于
> `docs/architecture.md` 与 `docs/security/*`。

---

# 1. 最终结论

项目继续坚持现有总方向：

> **产品一体化，代码模块化；平台事实在 Adapter，平台管理在 Control，
> Harness 特权操作只在 channel-harness，Web 只做通用管理 UI。**

不新增 `channel-access` 包，不重构已经落地的 Channel Web，不把访问策略塞入
`ChannelSetupField`，不让五个 Adapter 各自维护一套 ACL。

本次新增能力收敛为：

```text
Platform
   │
   ▼
Channel Adapter
   │  canonical identity / activation facts
   ▼
ChannelEvent
   │
   ▼
channel-harness
   │
   ├─ Reserved Control Message Gate
   ├─ Identity Validation
   ├─ Security Authorization Gate
   ├─ Activation Gate
   │
   ▼
Command / Binding / Workspace / Session / Agent
```

管理侧：

```text
channel-web
    │
    ▼
channel-control
    │
    ├─ Access Descriptor
    ├─ Access Policy
    ├─ Owner Discovery
    ├─ Owner Claim
    └─ Validation
    │
    ▼
ChannelStorage-backed Access Policy Store
```

最重要的安全不变量：

```text
No valid policy = DENY
Unknown sender = DENY
Group disabled by default
Authorization before /stop, commands, binding, workspace, session and Agent
Open access is always explicit and narrowly scoped
```

---

# 2. 当前代码核验：哪些已经完成

## 2.1 总体分层已经正确，不推翻

当前 as-built 架构已经形成：

```text
channel-core
channel-harness
channel-control
channel-files
channel-web

channel-weixin
channel-qq
channel-dingtalk
channel-lark
channel-telegram

channel-testkit
channel-compat
channel-verify
channels bundle
```

继续保持严格依赖方向：

```text
adapter implementation -> channel-core
adapter implementation -> upstream driver
upstream driver -> SDK / protocol

adapter plugin composition -> channel-core + channel-control

channel-harness -> channel-core + Harness public API

channel-web -> channel-control structural surface

channels bundle -> plugin composition only
```

本次 Access Control 不得破坏这条边界。

---

## 2.2 Channel Web 集中化重构已经基本落地

旧规划中的以下事项已经完成，不再列入待实现：

```text
✅ 渠道列表由 Host GET /channels 驱动
✅ 未知未来渠道有 generic fallback
✅ channelRegistry.ts 集中维护平台展示 metadata
✅ 页面级永久 3 秒轮询已删除
✅ 刷新改为事件驱动
✅ 配置主入口不再是旧 Dialog
✅ ChannelRow 使用整行 Disclosure
✅ 每次仅展开一个渠道
✅ collapsed row 不发 setup/auth/access 请求
✅ 行内已有直接启用/停用 Switch
✅ Setup/Auth/Access 已拆为通用组件
✅ authRequiresConfigured 等平台 UI 差异集中到 registry
```

当前展开结构为：

```text
ChannelRow
  ├─ ChannelSetup
  ├─ ChannelAuth
  └─ ChannelAccess
```

其中 `ChannelAccess` 表示谁可以驱动本机 Agent。平台侧 Bot/API 权限仍与本地
Agent Access 保持概念分离，但 Web 当前没有真实 permission probe，因此不展示
静态“权限与事件”状态。

---

## 2.3 channel-control 已是正确的动态 Control Plane

当前 `ChannelControlService` 已拥有：

```text
ChannelDefinitionRegistry
CredentialManager
AuthSessionManager
ChannelRuntimeManager

listChannels()
getSetup()
setEnabled()
applySetup()
beginAuth()
pollAuth()
...
```

并且没有：

```ts
if (channelId === 'telegram') {}
if (channelId === 'lark') {}
```

本次直接扩展它，不新建第二套平台管理服务。

---

## 2.4 Harness Bridge 仍缺少入站安全闸门

当前 `ChannelHarnessBridge.handleChannelEvent()` 的关键顺序仍是：

```text
message.received
    ↓
conversation key
    ↓
拼接 text
    ↓
parseCommand(text)
    ↓
/stop fast path
    ↓
per-conversation queue
    ↓
Command / Session / Agent
```

当前没有统一的：

```text
sender authorization
group authorization
owner authorization
activation gate
```

这意味着本次安全改造的核心不是 Adapter，而是：

> **在当前 `/stop` fast path 和所有 Command / Session / Agent side effect 之前插入统一授权。**

特别是 `/stop`：

```text
未授权用户
    ↓
绝对不能 cancel live Agent
```

所以 Access Gate 必须位于 `/stop` 判断之前。

---

## 2.5 当前 Channel Contract 已有 Identity，但没有 Activation Fact

当前 `MessageReceived` 已统一：

```ts
channel
accountId
conversation.id
conversation.type
sender.id
message.id
message.content
raw
```

但 `MessageRef` 还没有：

```ts
activation.mentionedBot
```

因此：

```text
Authorization
```

可以先基于 canonical sender / conversation 落地；

```text
requireMention
```

必须等 Contract 和各 Adapter 提供可靠 activation fact 后才能启用。

---

# 3. 对旧方案的最终修订

旧方案的大方向保留：

```text
Fail Closed
Owner identity
DM policy
Group policy
Group sender policy
Authorization / Activation 分离
Owner Claim
Canonical ID only
```

但以下设计正式修改。

---

## 3.1 修订一：不让 channel-harness 依赖 channel-control

不要形成：

```text
channel-harness
    ↓
channel-control
```

当前 `channel-harness` 只有 `channel-core` 作为本项目运行依赖，这个边界非常好。

最终做法：

```text
channel-core
    └─ 只定义跨包共享的 Access Policy 类型 / schema / storage key

channel-control
    └─ 写 policy

channel-harness
    └─ 读 policy + 执行授权
```

二者都依赖：

```text
channel-core
```

而不是互相依赖。

---

## 3.2 修订二：Policy Store 复用共享 ChannelStorage，但不泄漏平台私有 key

当前 `ctx.channels.resources.storage` 已经是 Channel 域的共享 durable KV seam。

Access Policy 使用独立 namespace：

```text
access:policy:v1:<encoded-channelId>:<encoded-accountId>
```

例如：

```text
access:policy:v1:telegram:main
access:policy:v1:lark:main
access:policy:v1:weixin:main
```

禁止：

```text
channel-control 直接读取 weixin:credential:main
channel-harness 直接读取 weixin:* / qq:* 等平台 key
```

平台私有状态只能由对应 channel package 理解。

---

## 3.3 修订三：微信 Owner 通过 ChannelDefinition hook 解析

微信当前 credential 已保存扫码用户 `userId`。

但 Control 不应该知道：

```text
weixin:credential:<accountId>
```

因此新增统一 hook：

```ts
resolveOwnerIdentity?(accountId: string): Promise<string | undefined>
```

微信自己实现：

```text
channel-weixin
    ↓
AccountCredentialStore
    ↓
credential.userId
    ↓
resolveOwnerIdentity()
```

Control 只看到：

```text
canonical owner id
```

不看到微信存储格式。

---

## 3.4 修订四：所有群必须携带默认群规则

仅增加 `groupPolicy=open` 会造成危险且语义模糊的问题：

```text
所有群 open 后
未知群的 senderPolicy 是什么？
requireMention 默认是什么？
如何表达例外？
```

最终表达为：

```ts
type GroupPolicy =
  | 'disabled'
  | 'allowlist'
  | 'open'
```

`allowlist` 按 conversation.id 显式添加；`open` 必须携带启用的
`defaultGroupRule`，并保持 `groups={}`。群内是否开放所有成员始终由规则表达：

```ts
senderPolicy: 'allowlist' | 'open'
```

因此 `groupPolicy=open` 只表示所有群匹配 `defaultGroupRule`，绝不隐式表示群内所有成员开放。

---

## 3.5 修订五：V1 不保留顶层 open preset

Preset 保留为持久化兼容分类，不再作为 Web 中可直接选择的“访问模式”：

```ts
type AccessPreset =
  | 'owner-only'
  | 'allowlist'
  | 'custom'
```

Web 直接编辑 `dmPolicy` / `allowFrom` / named groups，保存时再按实际规则归类
`preset`。需要开放时必须在具体维度显式表达：

```text
DM 对所有人开放
    -> dmPolicy = open

指定群对群内所有成员开放
    -> groups[id].senderPolicy = open
```

这样不会让一个：

```text
preset = open
```

同时隐式改变 DM、Group、Mention 多个安全维度。

---

## 3.6 修订六：Mention capability 以“当前代码事实”为准

旧方案直接把 QQ / DingTalk / Lark / Telegram 的：

```text
mentions = true
```

写入最终 descriptor。

当前代码实际上还没有统一 `activation.mentionedBot`。

最终规则：

> **没有完成 mapper + fixture + contract test 的渠道，mentions 必须为 false。**

先安全落地 ACL，再逐渠道启用 mention。

---

# 4. 最终模块职责

## 4.1 channel-core

新增的职责仅限跨包稳定语义：

```text
ChannelAccessPolicy types
ChannelAccessPolicy schema
Access storage key codec
MessageActivation fact
Reserved owner-claim command parser/constant
```

不负责：

```text
Web
Owner Claim session lifecycle
Policy persistence orchestration
Authorization decision
Platform identity parsing
```

建议新增：

```text
packages/channel-core/src/access.ts
```

并从：

```text
packages/channel-core/src/index.ts
```

导出。

---

## 4.2 channel-harness

继续作为唯一 Harness 特权边界。

新增：

```text
InboundAccessController
StoredChannelAccessPolicyResolver
Access decision logging
Reserved claim message suppression
```

负责：

```text
Identity Gate
DM authorization
Group authorization
Activation Gate
```

并保证它们发生在：

```text
/stop
parse/execute command
binding mutation
workspace resolution
session create/resume
agent create/attach
agent.followup
```

之前。

---

## 4.3 channel-control

新增逻辑管理面：

```text
ChannelAccessDescriptor
ChannelAccessState
ChannelAccessPolicyStore
OwnerClaimSessionManager
Owner discovery/bootstrap
Policy validation/materialization
Access readiness
```

Control 不执行最终 Agent authorization。

它负责：

```text
管理和保存“应该允许谁”
```

Harness 负责：

```text
对每个 inbound 真正执行“允许/拒绝”
```

---

## 4.4 channel-*

每个渠道继续只负责平台事实。

新增职责：

```text
声明访问能力 descriptor
保证 canonical sender/conversation identity
可选解析 activation.mentionedBot
可选提供 account owner identity
```

禁止：

```text
adapter 内自己判断 allowlist
adapter 内自己维护 ACL
adapter 内调用 Harness Agent
```

---

## 4.5 channel-web

保持当前集中化架构。

新增：

```text
ChannelAccess.tsx
Owner Claim UI
DM access controls
Named Group controls
Danger warning
Access readiness display
```

Web 不执行授权算法。

---

# 5. 最终 Access Policy Contract

建议放：

```text
packages/channel-core/src/access.ts
```

```ts
export type AccessPreset =
  | 'owner-only'
  | 'allowlist'
  | 'custom';

export type DirectMessagePolicy =
  | 'disabled'
  | 'allowlist'
  | 'open';

export type GroupPolicy =
  | 'disabled'
  | 'allowlist'
  | 'open';

export type GroupSenderPolicy =
  | 'allowlist'
  | 'open';

export interface GroupAccessRule {
  enabled: boolean;

  /**
   * allowlist:
   *   sender.id 必须存在于 allowFrom
   *
   * open:
   *   此“已经显式允许的群”中的任意 sender 均可通过主体授权
   */
  senderPolicy: GroupSenderPolicy;

  /**
   * canonical sender.id exact-match allowlist
   */
  allowFrom: string[];

  /**
   * 只有 descriptor.mentions=true 才允许配置 true
   */
  requireMention: boolean;
}

export interface ChannelAccessPolicy {
  /**
   * 持久化 schema version。
   * 未来改变语义时新增 version，不静默重解释旧 JSON。
   */
  version: 1;

  /**
   * 仅用于 Web UX / materialization 来源。
   * Runtime enforcement 不允许依赖 preset 分支。
   */
  preset: AccessPreset;

  /**
   * 本机 operator 对应的 canonical sender.id。
   */
  ownerId?: string;

  /**
   * 私聊规则。
   */
  dmPolicy: DirectMessagePolicy;

  /**
   * DM canonical sender.id allowlist。
   */
  allowFrom: string[];

  /**
   * disabled / named-group allowlist / all-groups default rule。
   */
  groupPolicy: GroupPolicy;

  /**
   * canonical conversation.id -> rule
   */
  groups: Record<string, GroupAccessRule>;

  /** groupPolicy=open 时必填，其他模式禁止出现。 */
  defaultGroupRule?: GroupAccessRule;
}
```

---

# 6. Preset compatibility classification

Runtime 不判断：

```ts
if (preset === 'owner-only')
```

Web 也不让用户直接选择 preset。它根据实际的私聊与群聊规则保存 policy，随后按以下规则生成兼容分类：

```text
仅 owner 私聊 + 群聊关闭 -> owner-only
指定用户私聊 + 群聊关闭 -> allowlist
其他组合                     -> custom
```

其中 `custom` 是内部分类，不是用户可见的重复入口。简单分类仍可由 Control 在保存时 materialize，
但必须与当前实际规则一致，不能清空用户刚编辑的群规则。

## owner-only

```yaml
version: 1
preset: owner-only
ownerId: "123"

dmPolicy: allowlist
allowFrom:
  - "123"

groupPolicy: disabled
groups: {}
```

## allowlist

```yaml
version: 1
preset: allowlist
ownerId: "123"

dmPolicy: allowlist
allowFrom:
  - "123"
  - "456"

groupPolicy: disabled
groups: {}
```

## custom

所有底层规则由用户明确编辑：

```yaml
version: 1
preset: custom

ownerId: "123"

dmPolicy: allowlist
allowFrom:
  - "123"

groupPolicy: allowlist

groups:
  "-100123456":
    enabled: true
    senderPolicy: allowlist
    allowFrom:
      - "123"
    requireMention: true
```

---

# 7. Open 的最终语义

V1 中不存在魔法值：

```text
"*"
"all"
allowFrom: []
```

表达开放。

## 开放 DM

必须：

```yaml
preset: custom
dmPolicy: open
```

Web 显示：

```text
危险：任何能够私聊该 Bot 的远程用户都可以驱动本机 Agent。
```

## 指定群内所有成员开放

必须先显式添加群：

```yaml
groupPolicy: allowlist

groups:
  "-100123456":
    enabled: true
    senderPolicy: open
    allowFrom: []
    requireMention: true
```

Web 显示：

```text
危险：这个指定群中的任意成员都可以驱动本机 Agent。
```

仍然不会自动授权其他群。

---

# 8. Canonical Identity 不变量

Harness 只认：

```text
event.sender.id
event.conversation.id
event.conversation.type
```

禁止参与 ACL：

```text
display name
nickname
username
mutable handle
fuzzy match
case folding
platform raw fallback
```

所有 ID 都当作 opaque string。

允许的唯一输入规范化：

```text
trim leading/trailing whitespace
```

之后 exact compare：

```ts
configuredId === canonicalId
```

---

# 9. Identity Validation

Access Controller 在策略判断前先验证 identity。

## Sender

以下必须 DENY：

```text
undefined
empty
"unknown"
```

当前部分 mapper 会使用 `"unknown"` fallback，因此 Harness 必须显式拒绝。

## DM conversation

如果 adapter 规范明确：

```text
conversation.id = sender.id
```

则允许，例如当前 Weixin / QQ C2C。

## Group conversation

必须有稳定、非空的 canonical group id。

禁止把：

```text
unknown sender fallback
```

误当成 group conversation。

---

# 10. Channel Access Descriptor

该能力属于：

```text
channel-control ChannelDefinition
```

而不是 Web registry。

```ts
export type OwnerDiscoveryMode =
  | 'account'
  | 'claim'
  | 'manual';

export interface ChannelAccessDescriptor {
  directMessages: boolean;
  groups: boolean;
  mentions: boolean;

  ownerDiscovery: OwnerDiscoveryMode;

  identityLabels: {
    user: string;
    group?: string;
  };

  defaults?: {
    requireMention?: boolean;
  };
}
```

`ChannelDefinition` 增加：

```ts
export interface ChannelDefinition {
  // existing ...

  access: ChannelAccessDescriptor;

  /**
   * 仅 ownerDiscovery='account' 的渠道实现。
   * 返回 canonical sender.id。
   */
  resolveOwnerIdentity?(
    accountId: string
  ): Promise<string | undefined>;
}
```

最终将 `access` 设为 required。

如果需要分两步迁移：

```text
先 optional + runtime fail-closed
完成五个 built-in definition 后改 required
```

但发布版本内必须完成 required 收口。

---

# 11. 五个渠道的 descriptor：按当前代码事实启动

第一版不要伪造 mention 支持。

## Weixin

```ts
{
  directMessages: true,
  groups: false,
  mentions: false,
  ownerDiscovery: 'account',
  identityLabels: {
    user: 'Weixin User ID',
  },
}
```

当前事实：

```text
from_user_id -> sender.id
from_user_id -> conversation.id
conversation.type = dm
QR credential 可保存 scanning userId
```

---

## QQ

```ts
{
  directMessages: true,
  groups: true,
  mentions: false, // 先 false，完成 activation contract 后再改 true
  ownerDiscovery: 'claim',
  identityLabels: {
    user: 'QQ User OpenID',
    group: 'QQ Group OpenID',
  },
}
```

当前 identity：

```text
C2C
senderId -> sender.id
senderId -> conversation.id

Group
senderId    -> sender.id
groupOpenid -> conversation.id
```

---

## DingTalk

```ts
{
  directMessages: true,
  groups: true,
  mentions: false,
  ownerDiscovery: 'claim',
  identityLabels: {
    user: 'DingTalk Sender ID',
    group: 'DingTalk Conversation ID',
  },
}
```

当前 mapper 已有：

```text
senderId
conversationId
conversationType === '2' -> group
```

但缺失 sender 时存在 `unknown` fallback，必须由 Access Gate 拒绝。

---

## Lark / Feishu

```ts
{
  directMessages: true,
  groups: true,
  mentions: false,
  ownerDiscovery: 'claim',
  identityLabels: {
    user: 'Lark User ID',
    group: 'Lark Chat ID',
  },
}
```

当前 mapper：

```text
senderId -> sender.id
conversationId -> conversation.id
oc_* -> group
threadId 独立用于 Session routing
```

`threadId` 不作为 Access Policy 的 conversation identity。

---

## Telegram

```ts
{
  directMessages: true,
  groups: true,
  mentions: false,
  ownerDiscovery: 'claim',
  identityLabels: {
    user: 'Telegram User ID',
    group: 'Telegram Chat ID',
  },
}
```

当前 mapper：

```text
message.from.id -> sender.id
message.chat.id -> conversation.id

private -> dm
group/supergroup -> group
```

群 ID 保留原始字符串，包括：

```text
-100...
```

---

# 12. Message Activation Contract

新增：

```ts
export interface MessageActivation {
  /**
   * 当前消息是否可靠地显式 mention 当前 Bot。
   */
  mentionedBot?: boolean;

  /**
   * 保留给未来 activation policy，V1 不参与授权。
   */
  repliedToBot?: boolean;
}

export interface MessageRef {
  id: MessageId;
  content: MessagePart[];
  replyTo?: MessageId;
  createdAt?: number;

  activation?: MessageActivation;
}
```

Adapter 负责：

```text
platform raw
    ↓
platform-specific mention parsing
    ↓
message.activation.mentionedBot
```

Harness 永远不读取：

```text
event.raw
```

来做 ACL 或 mention 判断。

---

# 13. Mention capability rollout

不要让 Security Core 阻塞在四个平台的 mention 解析上。

执行顺序：

```text
Access Policy + sender/group auth
    ↓
先上线

各平台 mention normalization
    ↓
逐渠道完成
    ↓
descriptor.mentions = true
```

只有同时满足：

```text
mapper implemented
fixture with mention
fixture without mention
contract test
live/official payload verified
```

才允许把：

```ts
mentions: false
```

改成：

```ts
mentions: true
```

---

# 14. requireMention 最终语义

只在：

```text
conversation.type === 'group'
```

应用。

```ts
if (
  rule.requireMention &&
  event.message.activation?.mentionedBot !== true
) {
  return {
    authorized: true,
    activated: false,
    reason: 'mention_required',
  };
}
```

关键：

```text
undefined != true
```

如果用户配置 `requireMention=true`，但 Adapter 没有可靠事实：

```text
NOT ACTIVATED
```

不能 fail open。

Control 保存策略时，如果：

```text
descriptor.mentions === false
```

则直接拒绝：

```text
requireMention = true
```

避免创建一个永远不会激活的配置。

---

# 15. Access Policy Store

新增：

```text
packages/channel-control/src/access/policy-store.ts
```

接口：

```ts
export interface ChannelAccessPolicyStore {
  get(
    channelId: string,
    accountId: string
  ): Promise<ChannelAccessPolicy | undefined>;

  set(
    channelId: string,
    accountId: string,
    policy: ChannelAccessPolicy
  ): Promise<void>;

  delete(
    channelId: string,
    accountId: string
  ): Promise<void>;
}
```

实现：

```text
ChannelStorageAccessPolicyStore
```

底层：

```text
ctx.channels.resources.storage
```

key：

```ts
accessPolicyStorageKey(channelId, accountId)
```

结果：

```text
access:policy:v1:telegram:main
```

读取规则：

```text
missing JSON      -> missing policy
malformed JSON    -> invalid policy
unknown version   -> invalid policy
```

Harness 对后两者全部：

```text
DENY
```

---

# 16. 为什么不缓存 Policy（V1）

V1 Harness 每次 inbound 直接读取一次 policy。

优点：

```text
Web 保存后立即生效
撤销权限立即生效
不需要 runtime restart
不需要跨包 invalidation event
没有 stale ACL cache
```

项目当前是本地 Agent 渠道，不需要提前做复杂缓存。

以后如果性能数据证明需要缓存：

```text
必须同时设计 revision + invalidation
```

禁止只有 TTL cache。

---

# 17. Harness-side Policy Resolver

新增：

```text
packages/channel-harness/src/access/resolver.ts
```

它不依赖 `channel-control`。

```ts
export interface ChannelAccessPolicyResolver {
  resolve(
    channelId: string,
    accountId: string
  ): Promise<
    | { state: 'present'; policy: ChannelAccessPolicy }
    | { state: 'missing' }
    | { state: 'invalid'; error: string }
  >;
}
```

默认实现直接使用：

```text
ctx.channels.resources.storage
+
channel-core access schema
```

---

# 18. InboundAccessController

新增：

```text
packages/channel-harness/src/access/
  controller.ts
  decision.ts
  resolver.ts
```

建议：

```ts
export type AccessDecisionReason =
  | 'allowed'
  | 'missing_policy'
  | 'invalid_policy'
  | 'unidentified_sender'
  | 'invalid_conversation'
  | 'dm_disabled'
  | 'user_not_allowed'
  | 'group_disabled'
  | 'group_not_allowed'
  | 'group_user_not_allowed'
  | 'mention_required';

export interface InboundAccessDecision {
  authorized: boolean;
  activated: boolean;
  reason: AccessDecisionReason;
}
```

---

# 19. 最终授权算法

## 19.1 DM

```ts
if (policy.dmPolicy === 'disabled') {
  DENY('dm_disabled');
}

if (policy.dmPolicy === 'open') {
  ALLOW;
}

if (policy.dmPolicy === 'allowlist') {
  if (policy.allowFrom.includes(senderId)) {
    ALLOW;
  }

  DENY('user_not_allowed');
}
```

关键：

```text
allowFrom = []
```

表示：

```text
DENY ALL
```

永远不表示 open。

---

## 19.2 Group

第一步：

```text
groupPolicy === disabled
    -> DENY
```

第二步：

```text
groupPolicy === allowlist
    ↓
必须存在 groups[conversation.id]

groupPolicy === open
    ↓
使用 defaultGroupRule
```

不存在：

```text
group_not_allowed
```

第三步：

```text
rule.enabled === true
```

第四步检查 sender：

```text
senderPolicy=allowlist
    -> sender.id 必须在 rule.allowFrom

senderPolicy=open
    -> 允许这个“已显式允许的群”中的任意 sender
```

第五步：

```text
requireMention
```

这是 Activation，不是 Authorization。

---

# 20. Reserved Owner Claim 消息

Owner Claim 是唯一允许在缺少 Access Policy 时被 Control Plane 观察的入站消息。

统一保留命令：

```text
/dsh-claim <challengeCode>
```

在 `channel-core/access.ts` 提供共享常量/解析 helper，
避免 Control 与 Harness 各自维护不同字符串。

Harness 规则：

```text
只要消息看起来是 /dsh-claim ...
    ↓
永远不进入模型
永远不进入普通 command dispatcher
永远不创建 Session
永远不更新 Binding
```

即使当前没有 active claim，也静默吞掉。

这样不会把 claim code 写入 Agent 会话。

---

# 21. Owner Claim Manager

新增：

```text
packages/channel-control/src/access/owner-claim.ts
```

内存态即可，不持久化 challenge。

```ts
export type OwnerClaimPhase =
  | 'waiting-message'
  | 'candidate'
  | 'confirmed'
  | 'expired'
  | 'cancelled';

export interface PublicOwnerClaimSession {
  id: string;
  channelId: string;
  accountId: string;
  phase: OwnerClaimPhase;

  /**
   * 本地浏览器需要展示给 operator 的短期 challenge。
   * 不是平台 credential。
   */
  challengeCode?: string;

  expiresAt: number;

  candidate?: {
    senderId: string;
  };
}
```

安全规则：

```text
1. 只能由本地 Web/API 主动 begin
2. 16 random bytes / >=128-bit challenge
3. 5 分钟 TTL
4. single-use
5. 同 channel/account 同时最多一个 active claim
6. 只接受 DM
7. 必须有有效 canonical sender.id
8. exact command match
9. 收到 candidate 后停止接受新的 candidate
10. candidate 不自动成为 owner
11. 本地 Web confirm 后才写 owner
12. claim message 不进入 Agent / Session / Binding
13. owner 变化写审计日志
```

---

# 22. Owner Claim Event Listener

`channel-control` 已经 inject `channels`。

在 plugin lifecycle 中注册：

```ts
const stop = ctx.channels.on((event) => {
  void service.ownerClaims.observe(event).catch((error) => {
    logger.warn(...)
  });
});
```

注意：

> `OwnerClaimSessionManager.observe()` 的错误不能向 `ChannelService.emit()` 抛出。

原因：

```text
Control Plane 的 claim 管理失败
```

不应该让 Adapter 的 inbound loop 认为整条平台消息处理失败。

---

# 23. 微信 Owner 自动发现

微信不走 Owner Claim。

在 `channel-weixin` 内部实现：

```text
resolveOwnerIdentity(accountId)
```

内部才允许理解：

```text
AccountCredentialStore
credential.userId
```

建议在 `createWeixinDefinition()` 增加 option：

```ts
resolveOwnerIdentity?: (
  accountId: string
) => Promise<string | undefined>
```

由 `channel-weixin/src/index.ts` 注入实际 closure。

Control 不读取：

```text
weixin:credential:*
```

---

# 24. Owner bootstrap 规则

## 首次读取 Access

如果：

```text
policy missing
+
ownerDiscovery=account
+
resolveOwnerIdentity() 有值
```

则安全创建：

```text
owner-only
```

适用于已有微信 credential 的升级迁移。

## ownerDiscovery=claim

如果：

```text
policy missing
```

返回：

```text
needs-owner
```

期间普通 inbound：

```text
DENY
```

只有 `/dsh-claim` control message 被 Claim Manager 观察。

---

# 25. Owner 重新绑定

Owner Claim confirm 后：

## 没有 policy

创建：

```text
owner-only
```

## preset = owner-only

重新 materialize：

```text
ownerId = newOwner
allowFrom = [newOwner]
groupPolicy = disabled
```

## preset = allowlist/custom

只更新：

```text
ownerId
```

不静默覆盖用户已有：

```text
allowFrom
groups
```

如果 owner 当前不在 custom allowlist，
Web 明确展示提示，由用户决定是否添加。

---

# 26. 微信重新扫码 Owner 行为

微信成功本地 QR 登录后：

## policy missing

自动 owner-only。

## preset=owner-only

允许自动切换到新的 scanning `userId`。

## allowlist/custom

不自动重写 allowlist/groups。

只更新 owner identity 是否要自动同步，建议 V1 保守处理：

```text
显示“检测到账号变化”
+
要求本地确认
```

避免一次重新扫码意外重写复杂安全策略。

---

# 27. ChannelAccessState

Control 对 Web 提供：

```ts
export type ChannelAccessReadiness =
  | 'ready'
  | 'needs-owner'
  | 'missing-policy'
  | 'invalid-policy';

export interface ChannelAccessState {
  descriptor: ChannelAccessDescriptor;

  readiness: ChannelAccessReadiness;

  policy?: ChannelAccessPolicy;

  owner: {
    configured: boolean;
    id?: string;
    source?: 'account' | 'claim' | 'manual';
  };
}
```

Policy 不包含任何 secret。

Browser 可以看到 canonical owner/sender/group ID，
因为这些就是用户要编辑的 ACL identity。

---

# 28. ChannelSummary 增加 Access readiness

当前 collapsed row 已显示：

```text
enabled/runtime/connection
```

安全 cutover 后，如果 Bot 已连接但因 missing policy 被静默拒绝，
用户必须在未展开前就能知道原因。

因此 `ChannelSummary` 增加：

```ts
access: ChannelAccessReadiness;
```

例如：

```text
Telegram
● 已连接
⚠ 需要识别你的账号
```

或：

```text
Lark
● 已连接
⚠ 访问权限未配置
```

`listChannels()` 最多读取当前已注册几个渠道的一次小 KV，
当前规模可接受。

---

# 29. Control Service API

新增：

```ts
getAccess(
  channelId: string,
  accountId?: string
): Promise<ChannelAccessState>;

saveAccess(
  channelId: string,
  policy: ChannelAccessPolicy,
  accountId?: string
): Promise<ChannelAccessState>;

beginOwnerClaim(
  channelId: string,
  accountId?: string
): Promise<PublicOwnerClaimSession>;

getOwnerClaim(
  channelId: string,
  claimId: string
): Promise<PublicOwnerClaimSession>;

confirmOwnerClaim(
  channelId: string,
  claimId: string
): Promise<ChannelAccessState>;

cancelOwnerClaim(
  channelId: string,
  claimId: string
): Promise<void>;
```

V1 Web 仍默认：

```text
accountId = main
```

Store 和内部接口从第一天保留 accountId。

不要为了这次安全改造同时把整个 Web API 重构成多账号 UI。

---

# 30. v2 HTTP API 扩展

继续复用当前：

```text
/dsh-channels/api/v2
```

不新开 v3。

新增：

```text
GET
/channels/:channelId/access

PUT
/channels/:channelId/access

POST
/channels/:channelId/access/owner-claims

GET
/channels/:channelId/access/owner-claims/:claimId

POST
/channels/:channelId/access/owner-claims/:claimId/confirm

DELETE
/channels/:channelId/access/owner-claims/:claimId
```

继续遵循当前 routes-v2 原则：

```text
HTTP
  ↓
strict zod validation
  ↓
ChannelControlLike
  ↓
public DTO only
```

不让 Web 看到：

```text
platform token
credential ref
providerState
deviceCode
SecretStore value
```

---

# 31. Access Policy validation

`saveAccess()` 必须拒绝：

```text
unknown schema version
owner-only but no ownerId
invalid canonical ID
duplicate empty ID
groupPolicy=allowlist with malformed groups
group.enabled not boolean
senderPolicy invalid
requireMention=true while descriptor.mentions=false
groups configured while descriptor.groups=false
dmPolicy != disabled while descriptor.directMessages=false
```

允许：

```text
allowFrom=[]
```

但语义必须是：

```text
DENY ALL
```

Control 可以对输入：

```text
trim
exact duplicate removal
```

但不能：

```text
lowercase
username resolution
fuzzy matching
```

---

# 32. 最终 Harness 入站顺序

这是本方案最关键的代码顺序。

```text
ChannelEvent
   │
   ├─ connection.changed / auth.changed
   │       -> bridge ignore
   │
   ├─ non-message event
   │       -> current v1 behavior
   │
   ▼
message.received
   │
   ▼
Reserved Claim Message Check
   │
   ├─ /dsh-claim ... -> DROP FROM HARNESS
   │
   ▼
Identity Validation
   │
   ├─ invalid -> DROP
   │
   ▼
Load Access Policy
   │
   ├─ missing -> DROP
   │
   ├─ invalid -> DROP
   │
   ▼
Security Authorization
   │
   ├─ DM denied -> DROP
   │
   ├─ group denied -> DROP
   │
   ├─ sender denied -> DROP
   │
   ▼
Activation Gate
   │
   ├─ mention required but absent -> DROP
   │
   ▼
conversation key
   │
   ▼
raw text concat
   │
   ▼
parseCommand
   │
   ├─ /stop fast path
   │
   ▼
per-conversation serialization
   │
   ▼
Command / Routing
   │
   ▼
Workspace / Binding / Session / Agent
```

绝对禁止：

```text
parseCommand
/stop
Session lookup/create
Binding write
Workspace attach
Agent borrow/create
```

发生在 authorization 前。

---

# 33. /stop 安全回归

当前 `/stop` 是一个特殊 fast path。

安全 cutover 后必须验证：

```text
Unauthorized /stop
    ↓
agent.cancel() = 0
generation bump = 0
stop barrier = 0
```

Authorized `/stop`：

```text
保持当前 fast-path scheduling 语义完全不变
```

Access Control 只移动它的 admission point，
不重构 `/stop` 本身。

---

# 34. Claim command 不属于普通 Command Plane

不要把：

```text
/dsh-claim
```

注册成 Harness Agent command。

它属于：

```text
Channel Control Plane Protocol
```

原因：

```text
没有 Access Policy 时也必须能完成 owner claim
但又绝不能进入 Agent/Session
```

所以它在 Harness command dispatcher 之前被保留并吞掉。

---

# 35. Security Gate 与 Activation Gate

必须继续分开。

## Security Gate

回答：

```text
这个远程主体有没有资格？
```

包括：

```text
DM enabled?
sender allowed?
group allowed?
group sender allowed?
```

## Activation Gate

回答：

```text
有资格，但当前这条消息是否应该触发 Agent？
```

V1：

```text
requireMention
```

未来可以扩展：

```text
reply-to-bot
explicit command
wake word
```

不要把这些混进 ACL。

---

# 36. Platform Permission 与 Agent Access 必须保持概念分离

平台权限表示 Bot/应用在 QQ / Lark / DingTalk / Telegram / Weixin 平台上需要的
能力；安全访问表示哪些远程 human identity 能驱动本机 Agent。二者仍然是独立概念。

当前 Web **不展示**平台权限状态。原 `ChannelPermissions.tsx` 只渲染 registry 中
写死的“消息接收 / 消息发送 / 必需”和绿色勾，没有调用平台 permission probe，
容易让用户误认为权限已经开通，因此已删除。

平台所需配置继续由 README、平台核验文档和官方平台文档说明。设置页仅在“应用配置”
标题旁提供官方文档入口；无配置字段但有交互授权的渠道（当前为微信）在“授权”标题旁
显示。该链接不表示实时状态，更不能把平台权限当成本地 Agent ACL。

未来如果实现 platform permission probe，
使用独立 DTO：

```ts
interface ChannelPermissionStatus {
  id: string;
  state: 'granted' | 'missing' | 'unknown' | 'not-applicable';
  required: boolean;
  source?: 'platform-api' | 'runtime-probe' | 'static';
  detail?: string;
}
```

与本次 Access Control 无耦合。

---

# 37. Web 最终 UX

当前 ChannelRow 展开内容中新增：

```text
安全访问
```

推荐顺序：

```text
1. 应用配置 / 连接
2. 登录 / 授权
3. 安全访问
4. 平台权限
```

---

# 38. Web：Owner 状态

## Weixin

```text
安全访问

所有者
当前扫码微信账号
已自动识别
```

## QQ / DingTalk / Lark / Telegram 未绑定

```text
安全访问

访问模式
● 仅自己使用（推荐）

所有者
尚未识别你的聊天账号

[识别我的账号]
```

这里必须明确区分 UI 草稿和已生效 policy：

```text
页面预选“仅自己使用”
    ≠ 已保存 owner-only policy
    ≠ 当前消息已获授权

owner 尚未识别
    -> owner-only 保存校验失败
    -> ordinary inbound DENY
    -> 不创建 Session / Binding，不执行 Command / /stop，不驱动 Agent
```

渠道仍可保持连接，以便完成下面的 Owner Claim。唯一可在缺少 policy 时被观察的入站内容是
`/dsh-claim <challengeCode>` 保留控制消息；该消息由 Harness 吞掉，不进入 Agent。

点击后：

```text
请私聊 Bot 发送：

/dsh-claim xxxxxxxxxxxxxxxxxxxxxx

等待消息...
```

收到 candidate：

```text
检测到：
Telegram User ID 8734062810

[确认这是我]
[取消]
```

---

# 39. Web：私聊访问

对于 `ownerDiscovery=claim/manual` 的渠道，Web 不再显示 `owner-only / allowlist / custom`
preset chooser，直接显示私聊的真实授权结果：

```text
私聊访问
○ 禁用
● 仅自己
○ 指定用户
○ 所有人（危险）
```

`仅自己`：

```text
dmPolicy = allowlist
allowFrom = [ownerId]
```

owner 尚未识别时保持该推荐项，但禁用保存，先完成 Owner Claim。

`指定用户`：

```text
允许用户
[123]
[456]
[+ 添加]
```

`所有人（危险）`：

```text
dmPolicy=open
```

必须出现 warning。

私聊选择与群聊规则是两个独立维度。切换私聊选项不得清空、禁用或改写已配置的 named groups。

---

# 40. Web：Group 设置

只有：

```text
descriptor.groups === true
```

才显示。

默认：

```text
群聊
[ ] 启用
```

群聊访问支持：

```text
禁用 / 指定群组 / 所有群组
```

“所有群组”必须继续显示默认成员规则，不得把群范围开放等同于群成员全部开放。

每个指定群的“仅自己”必须 materialize 为：

```text
senderPolicy = allowlist
allowFrom = [ownerId]
```

`allowFrom=[]` 始终表示拒绝所有成员，绝不能在 UI 中显示为“仅自己”。owner 尚未识别时，
群内“仅自己”不可选择。

添加群：

```text
Group ID
[________________]

允许成员
● 仅自己
○ 指定成员
○ 群内所有成员（危险）

触发方式
[✓] 必须 @机器人
```

`必须 @机器人` 仅在：

```text
descriptor.mentions === true
```

显示。

---

# 41. Weixin Web

因为：

```text
groups=false
mentions=false
ownerDiscovery=account
```

只显示：

```text
安全访问

所有者
当前扫码微信账号
已识别

私聊访问
✓ 仅自己
```

微信的 `ownerDiscovery=account` 决定其私聊访问固定为当前扫码账号。这里是只读状态，
不显示“禁用 / 仅自己 / 指定用户 / 所有人”的可编辑单选项。由于微信没有其他 Access
Policy 可编辑项，也不显示“不支持群聊”的占位说明和“保存访问配置”按钮。

不显示：

```text
Group ID
Group member allowlist
requireMention
Owner Claim
当前渠道不支持群聊
保存访问配置
```

---

# 42. 日志

新增 logger namespace：

```text
channel-access
```

拒绝事件示例：

```text
[channel-access]
channel=telegram
account=main
conversationType=group
reason=group_user_not_allowed
```

默认不记录 message body。

禁止记录：

```text
platform token
credential
claim challenge
message body
media
raw payload
signed URL
```

sender / conversation ID：

```text
debug 模式可完整
普通日志 hash/mask
```

拒绝默认：

```text
silent drop
+
local structured log
```

不向攻击者返回：

```text
Unauthorized
```

---

# 43. Reaction / Interaction 的边界

当前 Bridge v1 只处理 `message.received`。

但 Contract 已经有：

```text
reaction.received
interaction.received
```

Lark mapper 也已经能够产生 interaction event。

最终红线必须写成：

> 任何未来能够触发 Agent、Command、Session、Binding、Workspace
> 或其他本地副作用的外部 actor event，都必须复用同一个 Access Controller。

本阶段不需要让 reaction/interaction 驱动 Agent。

但以后新增处理器时不能绕过 gate。

---

# 44. Adapter Authoring 新要求

每个新 Adapter 必须在文档与 contract test 中回答：

```text
1. canonical sender.id 是什么？
2. canonical conversation.id 是什么？
3. dm/group 如何判断？
4. sender identity 是否稳定？
5. group identity 是否稳定？
6. 是否支持 mention？
7. mentionedBot 如何可靠解析？
8. ownerDiscovery 是 account / claim / manual 哪一种？
```

没有 identity 定义：

```text
不得合并。
```

---

# 45. Identity Contract Test

在 `channel-testkit` 增加：

```text
runInboundIdentityContract()
```

最少验证：

```text
sender.id 非空
sender.id != "unknown"
conversation.id 非空
conversation.type ∈ dm|group

同一远程主体映射稳定

group:
  sender.id 与 conversation.id 语义独立

dm:
  identity 符合 adapter 自己声明的 contract
```

注意：

当前 legacy fixture 如果确实包含缺字段的错误 payload，
可以测试 mapper 产出 `unknown`，
但 Access Controller 必须拒绝它。

---

# 46. Mention Contract Test

支持 mention 的 Adapter 增加：

```text
group-message-with-mention
group-message-without-mention
```

验证：

```ts
activation.mentionedBot === true
activation.mentionedBot === false
```

不要只测试：

```text
undefined
```

然后宣称支持 mention。

---

# 47. Migration 策略

这是 breaking security change。

升级前：

```text
已有连接渠道
+
没有 access policy
```

升级后不能自动：

```text
open
```

---

# 48. Weixin migration

如果：

```text
已有 Weixin credential
+
credential.userId 存在
+
policy missing
```

允许自动创建：

```yaml
version: 1
preset: owner-only

ownerId: "<userId>"

dmPolicy: allowlist
allowFrom:
  - "<userId>"

groupPolicy: disabled
groups: {}
```

这是唯一可以无人工 claim 自动完成 owner bootstrap 的内置渠道。

---

# 49. QQ / DingTalk / Lark / Telegram migration

如果没有已验证 human owner identity：

```text
do not guess
```

状态：

```text
needs-owner
```

网络连接可以继续运行以接收 claim。

但 Harness 普通 inbound：

```text
DENY
```

Web 明确提示：

```text
渠道已连接，但尚未授权任何用户。
完成“识别我的账号”后开始处理消息。
```

---

# 50. Access Policy 变更不重启 Adapter

保存 ACL：

```text
PUT /access
    ↓
validate
    ↓
storage.set
    ↓
next inbound 立即读取新 policy
```

不做：

```text
runtime.restart(channelId)
```

理由：

```text
网络连接状态
!=
本地 Agent 访问策略
```

权限撤销必须快且无连接抖动。

---

# 51. 实施阶段

整个实现建议分 5 个阶段。

重要发布规则：

> **Phase 1 / Phase 2 可以独立开发和合并，但不能在 Security Cutover
> 尚未完成时把“半成品安全模型”作为正式版本对外发布。**
>
> 对最终用户而言，Owner onboarding + Fail-Closed enforcement 必须作为同一次安全版本完整交付。

---

# Phase 1 — Shared Contract & Policy Foundation

目标：

```text
先建立稳定数据模型，不改变当前 Agent admission 行为。
```

修改：

```text
channel-core
  + access.ts
  + access schema
  + versioned storage key
  + MessageActivation

channel-control
  + ChannelAccessDescriptor
  + ChannelAccessPolicyStore
  + getAccess/saveAccess
  + readiness
```

五个 built-in `ChannelDefinition` 增加真实 descriptor。

此阶段：

```text
Harness gate 尚未 cut over
```

但所有数据结构和管理 API 已可测试。

---

# Phase 2 — Owner Bootstrap & Web Access UX

实现：

```text
Weixin resolveOwnerIdentity
OwnerClaimSessionManager
/dsh-claim observation
Control v2 access endpoints
ChannelSummary.access
ChannelAccess.tsx
Owner Claim UI
DM/group named rules UI
danger warnings
```

完成后用户可以在 cutover 前先配置安全策略。

---

# Phase 3 — Security Enforcement Cutover

这是核心安全 PR。

实现：

```text
channel-harness/access/resolver.ts
channel-harness/access/controller.ts

bridge:
  reserved claim suppression
  identity gate
  policy load
  authorization
  activation
```

必须保证：

```text
Access Gate BEFORE /stop
Access Gate BEFORE parse/execute command side effect
Access Gate BEFORE Binding/Workspace/Session/Agent
```

开启：

```text
No policy = DENY
Invalid policy = DENY
Unknown sender = DENY
```

同一 release 中完成 migration UX。

---

# Phase 4 — Mention Activation by Channel

逐渠道实现，不要求一次四个平台同时完成。

推荐：

```text
Telegram
QQ
Lark
DingTalk
```

每个渠道独立满足：

```text
official payload verification
mapper
fixtures
contract tests
descriptor.mentions=true
```

Weixin 不做 group mention。

---

# Phase 5 — Hardening / Documentation / Release Gate

完成：

```text
identity contract
claim abuse tests
logging
migration tests
AGENTS navigation
architecture red line
security docs
release notes
```

并跑完整：

```bash
pnpm ci:check
```

---

# 52. 推荐文件修改清单

## channel-core

```text
packages/channel-core/src/access.ts                 # new
packages/channel-core/src/events.ts                 # MessageActivation
packages/channel-core/src/index.ts
packages/channel-core/src/storage.ts                # 注释明确 shared channel-domain KV
```

测试：

```text
packages/channel-core/test/access.test.ts
```

---

## channel-harness

新增：

```text
packages/channel-harness/src/access/controller.ts
packages/channel-harness/src/access/decision.ts
packages/channel-harness/src/access/resolver.ts
```

修改：

```text
packages/channel-harness/src/bridge.ts
packages/channel-harness/src/lifecycle.ts
packages/channel-harness/src/index.ts
```

测试：

```text
packages/channel-harness/test/access-control.test.ts
packages/channel-harness/test/channel-harness.test.ts
packages/channel-harness/test/commands.test.ts
```

不要修改现有：

```text
AgentManager / SessionFactory
```

的核心生命周期，除非测试证明 gate 无法前置。

---

## channel-control

新增：

```text
packages/channel-control/src/access/policy-store.ts
packages/channel-control/src/access/owner-claim.ts
packages/channel-control/src/access/validation.ts
packages/channel-control/src/access/materialize.ts
```

修改：

```text
packages/channel-control/src/types.ts
packages/channel-control/src/service.ts
packages/channel-control/src/plugin.ts
packages/channel-control/src/index.ts
```

测试：

```text
packages/channel-control/test/access/policy-store.test.ts
packages/channel-control/test/access/owner-claim.test.ts
packages/channel-control/test/service.test.ts
```

---

## channel-web

新增：

```text
packages/channel-web/src/client/ChannelAccess.tsx
packages/channel-web/src/client/components/AccessWarning.tsx
packages/channel-web/src/client/components/IdentityListEditor.tsx
packages/channel-web/src/client/components/GroupAccessCard.tsx
```

修改：

```text
packages/channel-web/src/client/ChannelRow.tsx
packages/channel-web/src/client/api.ts
packages/channel-web/src/client/locales.ts

packages/channel-web/src/host/routes-v2.ts
```

测试：

```text
packages/channel-web/test/routes-v2.test.ts
packages/channel-web/test/channel-access.test.ts
packages/channel-web/test/channel-registry.test.ts
```

不要重新引入：

```text
per-channel React client
Dialog as primary setup UI
page polling
channelId branches in generic components
```

---

## Weixin

修改：

```text
packages/channel-weixin/src/definition.ts
packages/channel-weixin/src/index.ts
```

复用：

```text
packages/channel-weixin/src/auth/account-store.ts
```

目标：

```text
credential.userId
    ↓
resolveOwnerIdentity()
```

不把 Weixin storage key 暴露到 Control。

---

## QQ

修改：

```text
packages/channel-qq/src/definition.ts
packages/channel-qq/src/mapper.ts        # Phase 4 mention
```

Identity contract：

```text
senderId / groupOpenid
```

---

## DingTalk

修改：

```text
packages/channel-dingtalk/src/definition.ts
packages/channel-dingtalk/src/mapper.ts  # Phase 4 mention
```

Access 测试必须覆盖：

```text
senderId missing -> DENY
group conversation missing -> DENY
```

---

## Lark

修改：

```text
packages/channel-lark/src/definition.ts
packages/channel-lark/src/mapper.ts      # Phase 4 mention
```

保持：

```text
threadId 只参与 Session routing
不参与 group ACL identity
```

---

## Telegram

修改：

```text
packages/channel-telegram/src/definition.ts
packages/channel-telegram/src/mapper.ts  # Phase 4 mention
```

保持：

```text
chat.id string exact identity
-100... 不丢符号
```

---

## channel-testkit

新增：

```text
packages/channel-testkit/src/inbound-identity-contract.ts
packages/channel-testkit/src/activation-contract.ts
```

---

# 53. Access Controller 单元测试

必须覆盖：

```text
missing policy
  -> DENY

invalid policy
  -> DENY

unknown sender
  -> DENY

dm disabled
  -> DENY

dm allowlist []
  -> DENY

allowed DM sender
  -> ALLOW

unknown DM sender
  -> DENY

dm open
  -> ALLOW

group disabled
  -> DENY

group allowlist but unknown group
  -> DENY

named group disabled
  -> DENY

named group + sender allowlist + allowed sender
  -> ALLOW

named group + denied sender
  -> DENY

named group + senderPolicy=open
  -> ALLOW authorization

requireMention=true + mentioned=true
  -> ACTIVATED

requireMention=true + mentioned=false
  -> NOT_ACTIVATED

requireMention=true + mentioned=undefined
  -> NOT_ACTIVATED
```

---

# 54. Harness Integration Tests

重点不是只看返回值，而是验证**没有副作用**。

未授权普通消息：

```text
agent.followup = 0
```

未授权 `/new`：

```text
session create = 0
binding write = 0
workspace attach = 0
```

未授权 `/agent`：

```text
agent switch/create = 0
```

未授权 `/stop`：

```text
agent.cancel = 0
conversation generation unchanged
```

缺失/损坏 policy：

```text
no Agent side effect
```

Authorized：

```text
原有 command / session / reply 行为不变
```

---

# 55. Owner Claim Tests

至少：

```text
begin claim
wrong code
expired code
reused code
group claim rejected
unknown sender rejected
first candidate captured
second candidate ignored
local reject/cancel
local confirm
concurrent claim replaces/rejects according to chosen API contract
claim message never reaches Agent
claim message never creates Session
claim message never mutates Binding
owner replacement
challenge never logged
```

---

# 56. Web API Tests

扩展现有 `routes-v2.test.ts`：

```text
GET access
PUT valid access
PUT malformed access -> 400
PUT requireMention while mentions=false -> 400
unknown channel -> 404

begin owner claim -> 201
get claim
confirm candidate
confirm before candidate -> 400
expired claim -> 410
cancel -> 204

response never includes platform secret/provider state
```

---

# 57. Web UX Tests

至少：

```text
expanded row only loads access when open
collapsed row zero access request

needs-owner 显示警告
Weixin 不显示 owner claim
groups=false 不显示 group controls
mentions=false 不显示 requireMention
dmPolicy=open 显示 danger warning
group senderPolicy=open 显示 danger warning
空 group allowFrom 不显示为 owner-only
私聊模式切换不丢失 named groups
```

保持现有：

```text
no page-level polling
one row open
direct enable switch
```

---

# 58. Migration Tests

## Weixin

```text
existing credential.userId
+
missing policy
    ↓
owner-only materialized
```

## 其他渠道

```text
missing policy
    ↓
needs-owner
    ↓
ordinary inbound DENY
    ↓
claim still works
```

绝不能存在：

```text
missing policy -> open
```

---

# 59. Architecture Red Line 新增

当前 `docs/architecture.md` 有 12 条红线。

实现后新增正式红线：

> **红线 13 — 外部主体必须先授权，再产生本地副作用。**
>
> 任一能够触发 Agent、Command、Session、Binding、Workspace、
> Interaction 或其他本地特权行为的外部入站事件，
> 必须首先通过 `channel-harness` 的统一 Access Gate。
>
> 缺失 policy、损坏 policy、未知 sender、未知 group 均 Fail-Closed。
>
> Adapter 只负责 canonical identity 与 activation facts，
> 不得实现渠道私有 ACL engine。
>
> `requireMention` 是 Activation，不是 Authorization。

---

# 60. 文档落库

实现完成后建立两个 canonical security reference。

## docs/security/inbound-access-control.md

只记录最终 as-built 运行语义：

```text
Policy schema
Fail Closed
Owner
DM
Group
Authorization order
Activation
Owner Claim
Migration
Logging
```

## docs/security/channel-identity-map.md

按渠道记录：

```text
canonical sender.id
canonical conversation.id
dm/group rule
thread semantics
owner discovery
mention support
evidence/test status
```

---

# 61. AGENTS.md 更新

AGENTS 不复制整套规则。

只增加导航：

```md
### 入站访问控制

涉及以下内容时：

- inbound / message.received
- sender / conversation identity
- owner / owner claim
- dmPolicy / groupPolicy
- allowFrom
- requireMention
- interaction security

必须先阅读：

1. docs/security/inbound-access-control.md
2. docs/security/channel-identity-map.md
3. docs/architecture.md（涉及依赖/职责变化时）

Adapter 不得自行定义不同于 channel-harness 的 ACL 语义。
```

如果仓库安装项目级 Skill：

```text
.agents/skills/dsh-channels-verification/SKILL.md
```

AGENTS 只补充：

```text
涉及渠道 SDK / API / permission / identity 核验时按需加载该 Skill。
```

---

# 62. Release 策略

这是安全语义变更。

建议发版说明明确标记：

```text
BREAKING SECURITY CHANGE
```

即使当前 `0.x` 版本允许 minor breaking change，也必须让用户知道：

```text
升级后 QQ / DingTalk / Lark / Telegram
在完成 Owner Claim 前不会再把普通消息送入 Agent。
```

Weixin 如果已有可验证扫码 `userId`：

```text
自动迁移 owner-only
```

发布前必须完成：

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm verify packages/channel-weixin --test
pnpm verify packages/channel-qq --test
pnpm verify packages/channel-dingtalk --test
pnpm verify packages/channel-lark --test
pnpm verify packages/channel-telegram --test
pnpm check:fixtures
pnpm check:manifests
pnpm doctor
pnpm check:bundle
pnpm ci:check
```

以仓库当前实际 script 为准；不存在的单项命令不要硬造，
最终以 `pnpm ci:check` 为 release gate。

---

# 63. PR / Commit 拆分建议

建议按行为边界拆，而不是按包拆。

## PR 1 — Access contract + control state

```text
feat(channel-control): add channel access policy foundation
```

包含：

```text
core access schema
definition descriptor
policy store
control state/api
five built-in descriptors
```

无 Harness enforcement。

---

## PR 2 — Owner onboarding + Web

```text
feat(channel-control): add owner discovery and claim flow
feat(channel-web): add channel access settings
```

包含：

```text
Weixin owner resolver
claim manager
v2 endpoints
ChannelAccess UI
readiness
```

---

## PR 3 — Enforcement cutover

```text
feat(channel-harness): enforce fail-closed inbound access
```

包含：

```text
resolver
controller
bridge gate
reserved claim suppression
/stop regression
migration behavior
```

这是安全 cutover。

---

## PR 4+ — Mention support per channel

例如：

```text
feat(channel-telegram): normalize bot mention activation
feat(channel-qq): normalize bot mention activation
...
```

一个渠道一个可验证 PR。

---

## PR 5 — Canonical docs / release

```text
docs(security): document inbound access control
```

---

# 64. 明确不做

本阶段不做：

```text
RBAC roles
admin/operator/member
time-based policy
IP ACL
rate limit ACL
regex sender matching
username ACL
cross-channel user identity federation
all-groups global open
policy inheritance
remote ACL management
unauthorized auto reply
generic external policy engine
separate channel-access package
per-channel React frontend
runtime restart on ACL change
```

---

# 65. 最终安全不变量

## Invariant 1

```text
No valid policy = DENY
```

## Invariant 2

```text
Empty allowlist != open
```

## Invariant 3

```text
Unknown sender = DENY
```

## Invariant 4

```text
Groups are disabled by default
```

## Invariant 5

```text
V1 groups are named explicitly
```

## Invariant 6

```text
Authorization happens before /stop, commands and sessions
```

## Invariant 7

```text
Adapter produces identity / activation facts;
Harness executes authorization.
```

## Invariant 8

```text
Harness never parses platform raw payload for ACL.
```

## Invariant 9

```text
requireMention is activation, not authorization.
```

## Invariant 10

```text
Open is explicit at the narrowest policy dimension.
```

## Invariant 11

```text
Owner identity is never guessed.
```

## Invariant 12

```text
Access policy changes take effect without adapter restart.
```

## Invariant 13

```text
Owner Claim never reaches Agent / Session / Binding.
```

---

# 66. 最终架构图

```text
┌──────────────────────────────────────────────────────────────┐
│                         Platforms                            │
│ Weixin / QQ / DingTalk / Lark / Telegram                    │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     Channel Adapter                          │
│                                                              │
│ canonical sender.id                                          │
│ canonical conversation.id                                    │
│ conversation.type                                            │
│ message.activation.mentionedBot?                             │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                  channel-core Contract                       │
│                                                              │
│ ChannelEvent                                                 │
│ ChannelAccessPolicy schema                                   │
│ versioned storage key                                        │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     channel-harness                          │
│                                                              │
│ Reserved Claim Gate                                          │
│ Identity Validation                                          │
│ Policy Resolver                                              │
│ Principal Authorization                                      │
│ Group Authorization                                          │
│ Activation Gate                                              │
└──────────────────────────────┬───────────────────────────────┘
                               │ ALLOW + ACTIVATED
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                  Harness privileged path                     │
│                                                              │
│ /stop / Commands                                              │
│ Workspace / Binding / Session                                │
│ Agent / followup                                             │
└──────────────────────────────────────────────────────────────┘


                   Management / Policy Plane

┌──────────────────────────────────────────────────────────────┐
│                        channel-web                           │
│                                                              │
│ Current ChannelRow / Setup / Auth                            │
│ + ChannelAccess                                              │
│ + Owner Claim                                                │
│ + Named Group rules                                          │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                       channel-control                        │
│                                                              │
│ ChannelDefinition.access                                     │
│ Policy validation/materialization                            │
│ Owner discovery                                              │
│ OwnerClaimSessionManager                                     │
│ Access readiness                                             │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│        ctx.channels.resources.storage                        │
│                                                              │
│ access:policy:v1:<encoded-channel>:<encoded-account>         │
└──────────────────────────────────────────────────────────────┘
```

---

# 67. 最终产品默认

连接任一渠道后，产品语义统一：

```text
这个 Bot 默认是你的私人本机 Agent 入口。
```

系统永远不假设：

```text
能找到 Bot 的人
=
有权驱动 Agent 的人
```

默认：

```text
新渠道
   │
   ▼
owner-only intent
   │
   ├─ 能自动识别 owner（Weixin）
   │      -> materialize owner-only
   │
   └─ 不能自动识别
          -> needs-owner
          -> ordinary inbound DENY
          -> local Owner Claim
```

群聊：

```text
disabled by default
```

开启群聊：

```text
必须显式添加 conversation.id
```

开放某个群给所有成员：

```text
只开放这个已命名的群
```

而不是开放所有群。

---

# 68. Definition of Done

只有同时满足以下条件，本次改造才算完成：

```text
[ ] 五个 built-in ChannelDefinition 都声明 access descriptor
[ ] Access Policy schema 有 version=1
[ ] Access policy 存储使用独立 namespace
[ ] channel-harness 不新增对 channel-control 的 package 依赖
[ ] No policy / invalid policy fail closed
[ ] unknown sender fail closed
[ ] authorization 在 /stop 之前
[ ] unauthorized /new 无 Session side effect
[ ] unauthorized /agent 无 Agent side effect
[ ] owner claim 不进 Agent / Session / Binding
[ ] Weixin 可以从扫码 userId 安全 bootstrap owner
[ ] QQ / DingTalk / Lark / Telegram 需要 Owner Claim
[ ] groups 默认 disabled
[ ] V1 只允许 named groups
[ ] senderPolicy=open 只影响已允许的指定群
[ ] requireMention 只在可靠 activation fact 存在时开放
[ ] Access 保存无需 restart adapter
[ ] ChannelSummary 能显示 access readiness
[ ] Web 不展示未经真实检测的平台权限状态
[ ] docs/security 两份 canonical 文档落库
[ ] architecture 新增外部主体先授权红线
[ ] pnpm ci:check 通过
```

---

# 69. 最终执行优先级

实际开始编码时按以下顺序：

```text
P0
Access schema / store / owner onboarding / fail-closed harness gate

P0
/stop、/new、/agent 等 command bypass 回归测试

P0
migration + needs-owner UX

P1
Weixin owner auto-bootstrap

P1
named group + group sender allowlist

P1
ChannelAccess Web

P1
identity contract

P2
Telegram mention

P2
QQ / Lark / DingTalk mention

P2
platform permission real probe（独立项目，不与 Access Control 混做）
```

如果资源有限：

> **先把 P0 安全边界完整交付，再做 mention 和平台 permission probe。**

---

# 70. 最终决策一句话

> **保持现有 `Core → Adapter / Control → Harness → Web` 分层不变，
> 以 `channel-core` 共享版本化 Access Contract，
> `channel-control` 管理 Owner 与 Policy，
> `channel-harness` 在 `/stop`、Command、Session、Binding、Workspace、Agent
> 之前执行统一 Fail-Closed Gate；
> 群聊 V1 只允许显式 named group，开放权限只发生在最小明确维度，
> Web 在现有 ChannelRow 内增加独立“安全访问”区，而不重做已完成的 Web 架构。**
