---
title: QQ Web 权限模型修正版执行方案
status: in-progress
date: 2026-08-27
supersedes: qq-identity-access-web-execution-plan-2026-08-27.md
baseline:
  repository: https://github.com/wsz987/dsh-channels
  branch: main
  commit: bb03191fd509bbbbe97fcd4d4bb1cf4308d91570
  qq_native_interaction_commit: 9d7f6510b89b0721d4e5806c1d23c501c731e7d8
  qq_sdk: "@tencent-connect/qqbot-nodejs@1.0.4"
---

# QQ Web 权限模型修正版执行方案

> **已废弃（2026-09-01）**：真实 QQ Bot 群事件不能稳定提供可用于配置的 QQ
> 群号。本计划中所有“`group_id` 是群号”“手输群号解析为 OpenID”的设计不再采用。
> 当前实现只从入站 `group_openid` 自动发现群，并在 Web 中直接选择该 canonical
> OpenID；以 `docs/security/channel-identity-map.md` 为准。

> 实施状态（工作树，2026-08-30）：P0 的代码、脱敏 fixture、离线契约和 Web API
> 路由均已完成；仅真实 QQ live gate 尚待执行。Directory 已按
> `channelId + accountId + sha256(AppID)` 隔离；同一 account 更换 AppID 后，旧映射
> 不会被解析或展示，必须由新 Bot 再次观察。QQ owner 也已按同一 AppID scope 在首次
> 合法 C2C 入站时自动记录 `senderId/user_openid`，无需发送特殊识别指令；数字 QQ
> 号仍不可从官方 Bot SDK 可靠获取。

## 0. 修正说明

上一版方案中有一个关键判断错误：

```text
QQ ownerDiscovery: platform → claim
```

这个建议撤回。

当前项目接入的是 QQ 官方 Bot / OpenClaw 个人机器人形态。该产品的 C2C 私聊由 QQ 平台限制为机器人所属/创建者账号使用，不应因为腾讯 SDK 提供 `dmPolicy/allowlist` 这类通用能力，就反推当前产品形态允许任意 QQ 用户直接私聊机器人。

因此：

```ts
ownerDiscovery: 'platform'
```

当前方向应保留。

本次真正需要解决的是：

```text
1. Web 不应该要求用户理解 group_openid。
2. QQ 群事件在部分官方事件形态中可返回真实数字 group_id；当前实测
   `GROUP_AT_MESSAGE_CREATE` 可能将 group_id 与 group_openid 都返回为同一个 OpenID，
   因此只有纯数字 group_id 才能作为群号展示。
3. Web 应使用“QQ群号”作为人类可理解的权限配置入口。
4. Runtime / Harness ACL 继续使用 group_openid 作为 canonical id。
5. channel-qq 在 trust boundary 负责提取并维护：
   QQ群号 group_id ↔ canonical group_openid
```

---

# 1. 最终结论

QQ 权限模型推荐明确分成两部分。

## 私聊

```text
QQ 平台：
只有机器人所属/创建者 QQ 可进行 C2C 私聊

项目：
ownerDiscovery = platform

Web：
显示固定状态，不提供“指定 QQ 用户 / 所有人”等无意义配置
```

推荐 UI：

```text
私聊

✓ 仅机器人所属 QQ 可使用
  由 QQ 平台限制，无需额外配置
```

不要显示：

```text
QQ User OpenID
allowlist
指定用户
全部用户
```

至少当前这个 QQ 产品形态不需要。

---

## 群聊

用户认知：

```text
QQ群号
```

官方运行时：

```text
group_openid
```

正确的数据模型：

```text
QQ群号（group_id）
       │
       │ mapping
       ▼
group_openid
       │
       ▼
ChannelAccessPolicy.groups[group_openid]
       │
       ▼
Harness Access Gate
```

即：

> Web 允许用户按 QQ 群号配置；真正授权仍然 exact-match `group_openid`。

---

# 2. 官方 QQ 当前群事件已经存在 group_id

腾讯当前官方 `tencent-connect/openclaw-qqbot` 的 `GroupMessageEvent` 明确定义：

```ts
export interface GroupMessageEvent {
  author: {
    id: string;
    member_openid: string;
    username?: string;
    bot?: boolean;
  };

  content: string;
  id: string;
  timestamp: string;

  group_id: string;
  group_openid: string;
}
```

这里：

```text
group_id      = QQ群号
group_openid  = Bot API canonical group identity
```

这是本次改造最重要的官方依据。

---

# 3. 为什么项目当前只看到了 group_openid

当前 `@tencent-connect/qqbot-nodejs@1.0.4` 的高层 normalized message：

```ts
interface InboundMessage {
  ...
  groupOpenid?: string;
  raw: C2CMessageEvent | GroupMessageEvent | GuildMessageEvent;
}
```

dispatcher 当前 group mapping：

```ts
{
  kind: "group",
  senderId: ev.author.member_openid,
  ...
  groupOpenid: ev.group_openid,
  raw: ev,
}
```

也就是说：

```text
高层 normalized surface
    groupOpenid

原始平台事件
    raw.group_id
    raw.group_openid
```

官方 SDK 本身也明确说明：

> `raw` 用于访问尚未映射到 normalized interface 的新平台字段。

因此本项目无需等待 SDK 再增加：

```ts
groupId
```

字段才能做。

但读取 `raw.group_id` 必须只发生在：

```text
channel-qq trust boundary
```

不能让：

```text
channel-control
channel-web
channel-harness
```

自己解析 QQ raw payload。

---

# 4. 当前 channel-qq canonical mapping 保持不变

当前：

```ts
conversation: {
  id: msg.groupOpenid,
  type: 'group',
}

sender: {
  id: msg.senderId,
}
```

是正确的。

继续保持：

```text
Group conversation.id = group_openid
Group sender.id       = member_openid
```

不要改成：

```text
conversation.id = group_id
```

原因：

1. QQ OpenAPI 发送接口主要以 `group_openid` 为目标。
2. interaction callback 也提供 `group_openid`。
3. 当前 Session / Access Policy 已以 canonical `conversation.id` 为依据。
4. 旧用户 policy 已经可能存了 group_openid。
5. 群号属于人类可读 platform identifier，不应替换 runtime canonical identity。

---

# 5. 不建议直接把 ChannelAccessPolicy 改成存群号

错误方案：

```json
{
  "groups": {
    "123456789": {
      "enabled": true
    }
  }
}
```

然后 Access Gate 收到：

```text
conversation.id = 04EFA...OPENID
```

就无法 exact-match。

如果为了匹配再在 Harness 里做：

```ts
QQ group_openid → group_id
```

就会破坏当前架构：

```text
Harness Bridge 不应理解 QQ 平台字段。
```

所以 ACL truth 继续：

```json
{
  "groups": {
    "GROUP_OPENID": {
      "enabled": true
    }
  }
}
```

Web 只是显示：

```text
QQ群：123456789
```

---

# 6. 推荐新增：Conversation Identity Directory

不需要上一版那么大的 user/group/member Identity Catalog。

本次先做更聚焦的：

```text
Conversation Identity Directory
```

用于把：

```text
human/platform identifier
↔
canonical conversation id
```

关联起来。

推荐通用模型：

```ts
export interface ChannelConversationIdentity {
  channelId: string;
  accountId: string;

  /**
   * Runtime canonical conversation id.
   *
   * QQ group:
   * group_openid
   */
  canonicalId: string;

  type: 'group';

  /**
   * Human/platform-facing identifier.
   *
   * QQ:
   * group_id（QQ群号）
   */
  externalId?: string;

  /**
   * Optional display name.
   * QQ 当前若官方事件没有稳定群名称则为空，
   * 可由本地 alias 提供。
   */
  displayName?: string;

  alias?: string;

  firstSeenAt: number;
  lastSeenAt: number;

  /**
   * Prevent IDs observed under Bot A being reused under Bot B.
   */
  scopeFingerprint?: string;
}
```

---

# 7. 为什么用 generic directory，而不是 QQ 专属 Web 代码

不要：

```tsx
if (channel.id === 'qq') {
  // QQ群号逻辑
}
```

也不要：

```ts
if (channelId === 'qq') {
  const groupOpenid = ...
}
```

放进 channel-control。

推荐由 ChannelDefinition 声明：

```ts
access: {
  ...

  groupIdentity: {
    canonicalLabel: 'QQ Group OpenID',
    externalLabel: 'QQ群号',
    externalInput: true,
  },
}
```

或者更通用：

```ts
identity: {
  conversation: {
    externalIdLabel: 'QQ群号',
    externalIdDiscoverable: true,
  },
}
```

Web 只按 descriptor 渲染。

这样后续其他平台也能用：

```text
Telegram:
  canonical id = -100...
  external id 可能不存在

Lark:
  canonical id = chat_id
  external alias 可来自 chat name

QQ:
  canonical id = group_openid
  external id  = QQ群号
```

---

# 8. channel-core 推荐扩展

当前：

```ts
export interface ConversationRef {
  id: ConversationId;
  type: 'dm' | 'group';
  threadId?: ThreadId;
}
```

可以考虑新增：

```ts
export interface ConversationRef {
  id: ConversationId;
  type: 'dm' | 'group';
  threadId?: ThreadId;

  /**
   * Human/platform-facing identifier discovered by adapter.
   * NEVER used for runtime authorization.
   */
  externalId?: string;

  /**
   * Optional human-readable title.
   * NEVER used for authorization.
   */
  name?: string;
}
```

这里最重要的注释：

```text
externalId / name 只用于控制面展示与 canonical 映射，
Access Gate 永远只使用 conversation.id。
```

---

# 9. QQ mapper 提取 group_id

当前 `mapInbound()` 收到：

```ts
QQBotInboundMessage
```

其：

```ts
msg.raw
```

保留原始平台事件。

在 QQ adapter trust boundary 做严格解析：

```ts
import { z } from 'zod';

const qqGroupIdentitySchema = z.object({
  group_id: z.string().min(1),
  group_openid: z.string().min(1),
}).passthrough();
```

仅 group message：

```ts
function extractGroupExternalId(
  msg: QQBotInboundMessage,
): string | undefined {
  if (msg.kind !== 'group') return undefined;

  const result = qqGroupIdentitySchema.safeParse(msg.raw);
  if (!result.success) return undefined;

  if (result.data.group_openid !== msg.groupOpenid) {
    // 不接受冲突映射
    return undefined;
  }

  return result.data.group_id;
}
```

mapper：

```ts
conversation: {
  id: msg.groupOpenid!,
  type: 'group',

  ...(groupId
    ? { externalId: groupId }
    : {}),
}
```

---

# 10. 为什么要校验 group_openid 一致

不要只读取：

```ts
raw.group_id
```

然后无条件绑定到 normalized：

```text
msg.groupOpenid
```

必须确认：

```text
raw.group_openid === msg.groupOpenid
```

否则 malformed / future payload drift 时可能形成错误的：

```text
QQ群号 A → group_openid B
```

ACL mapping。

这属于 trust-boundary validation。

---

# 11. group_id 缺失时怎么处理

边界：

```text
SDK raw 没有 group_id
旧 fixture
interaction event
未来接口变化
```

都不能导致 group message 被丢弃。

正确降级：

```text
conversation.id = group_openid
externalId = undefined
```

即：

```text
核心消息与权限继续工作
只是 Web 暂时没有可读群号
```

Fail-safe，而不是：

```text
group_id missing → drop message
```

---

# 12. Directory observer

可以放：

```text
packages/channel-control/src/access/conversation-directory.ts
```

监听 canonical events：

```ts
channels.on((event) => {
  service.ownerClaims.observe(event);
  service.conversations.observe(event);
});
```

对：

```text
conversation.type=group
conversation.externalId exists
```

记录：

```text
canonicalId  = group_openid
externalId   = group_id
lastSeenAt
```

---

# 13. Directory 只存 identity metadata

允许：

```text
channelId
accountId
canonicalId
externalId
displayName
alias
firstSeenAt
lastSeenAt
scopeFingerprint
```

禁止：

```text
message content
attachments
raw event
AppSecret
token
Agent session
workspace
```

---

# 14. Web 输入群号时怎么解析

用户输入：

```text
123456789
```

Web 不直接把它塞进：

```ts
policy.groups
```

流程：

```text
QQ群号 123456789
↓
Conversation Directory
↓
找到：
  externalId=123456789
  canonicalId=GROUP_OPENID_A
↓
写入：
  policy.groups[GROUP_OPENID_A]
```

---

# 15. 尚未发现这个群号怎么办

这是重要边界。

QQ API 的运行时目标仍然是：

```text
group_openid
```

仅凭：

```text
QQ群号
```

不应该猜一个 OpenID。

如果目录没有：

```text
123456789 → group_openid
```

映射：

Web 提示：

```text
尚未识别到该QQ群。

请先将机器人加入QQ群 123456789，
然后在群里 @机器人发送任意一条消息。

收到消息后即可完成群号绑定。
```

可以提供：

```text
[刷新]
```

---

# 16. 更好的 UX：发现到的群直接列表选择

相比纯输入：

```text
QQ群号 [________]
```

推荐：

```text
添加QQ群

最近发现：

研发群
QQ群号：123456789
[添加]

QQ群号：987654321
[添加]

────────────
手动输入QQ群号
[__________]
```

如果群名拿不到：

```text
QQ群 123456789
```

已经足够友好。

---

# 17. QQ 群号作为 Web primary label

当前：

```ts
identityLabels: {
  user: 'QQ User OpenID',
  group: 'QQ Group OpenID',
}
```

推荐改成 Web 语义：

```ts
identityLabels: {
  user: 'QQ',
  group: 'QQ群',
}
```

Directory entry：

```text
primary:
  QQ群 123456789

secondary/debug:
  OpenID: 04E...A91
```

OpenID 默认缩略：

```text
04E...A91
```

---

# 18. 私聊 Web 不要配置 QQ OpenID

由于当前官方个人机器人私聊由平台限制：

```text
机器人所属 QQ
```

所以 QQ access descriptor 保持：

```ts
ownerDiscovery: 'platform'
```

Web 对 `platform` 模式：

```text
不要显示 owner claim
不要显示 DM allowlist input
```

但建议把当前单纯“隐藏”升级为明确说明：

```text
私聊权限

✓ 仅机器人所属 QQ
QQ 平台已限制私聊访问，无需额外白名单。
```

否则用户会误以为“项目没做私聊权限”。

---

# 19. 是否需要在 Web 配置自己的 QQ号

不建议把“自己的 QQ号”作为 ACL truth。

原因：

1. 私聊平台已经限制；
2. Runtime C2C event canonical identity 仍是 `user_openid`;
3. 当前没有必要把数字 QQ号参与授权；
4. AppID/AppSecret 也不需要 QQ号参与认证。

如果产品 UX 希望显示：

```text
机器人所属 QQ：123456789
```

只有在官方稳定 API / setup state 明确提供 owner QQ number 时再做。

当前不要用：

```text
author.id
union_openid
```

猜数字 QQ号。

---

# 20. group_id 可以用，user QQ number 不要类推

非常重要：

已经确认：

```text
GroupMessageEvent.group_id
```

是明确的群号字段。

不能因此推断：

```text
C2CMessageEvent.author.id
```

就是数字 QQ号。

当前官方 C2C 仍有：

```text
author.id
author.union_openid
author.user_openid
```

但没有同等明确的：

```text
qq_number
uin
```

契约。

因此本方案只把：

```text
group_id
```

作为 Web 群号。

---

# 21. 旧 policy 兼容

当前旧 policy：

```json
{
  "groupPolicy": "allowlist",
  "groups": {
    "GROUP_OPENID_A": {
      "enabled": true,
      "senderPolicy": "open",
      "allowFrom": [],
      "requireMention": true
    }
  }
}
```

完全保留。

升级后 Directory 观察到：

```text
group_id=123456789
group_openid=GROUP_OPENID_A
```

Web 自动从：

```text
GROUP_OPENID_A
```

显示成：

```text
QQ群 123456789
```

不需要迁移 ACL key。

---

# 22. 旧群未再次发消息

升级后已有：

```text
GROUP_OPENID_A
```

但 Directory 没有映射。

Web fallback：

```text
QQ群
OpenID: GRO...D_A
尚未获取群号
```

提示：

```text
在该群 @机器人一次即可识别QQ群号。
```

不要删除旧权限。

---

# 23. group_id 变化边界

正常 QQ群号应该稳定。

但 Directory 应按 canonical id 保存：

```text
canonicalId = group_openid
externalId = latest group_id
```

若观察到同一：

```text
group_openid
```

对应不同：

```text
group_id
```

不要静默覆盖。

记录 drift：

```text
identity_conflict
```

Web 标记：

```text
⚠ 群身份信息发生变化，请重新确认
```

ACL 继续 canonical fail-closed / existing policy，不自动授权新 mapping。

---

# 24. 相反冲突：同群号出现多个 group_openid

例如：

```text
externalId 123456789
→ OPENID_A

随后
→ OPENID_B
```

可能来自：

- AppID 更换；
- 不同 Bot；
- 平台 scoped identity；
- 数据污染。

必须以：

```text
channelId + accountId + appId fingerprint
```

隔离。

不要跨 Bot 复用 mapping。

---

# 25. AppID scope

Directory key 推荐：

```text
conversation-directory:v1:<channelId>:<accountId>
```

entry 增加：

```text
scopeFingerprint
```

QQ：

```text
sha256(appId) / stable non-secret app scope
```

不需要 hash AppSecret。

AppID 变化：

```text
旧 mapping stale
重新发现
```

---

# 26. Group sender/member 权限

当前项目的 group rule 支持：

```text
senderPolicy=open
senderPolicy=allowlist
```

QQ 群成员 canonical sender：

```text
member_openid
```

这和 QQ群号是两个问题。

本次 P0 聚焦：

```text
哪些群可以访问
```

不要顺手要求用户输入：

```text
member_openid
```

推荐 QQ 新群默认：

```ts
{
  enabled: true,
  senderPolicy: 'open',
  allowFrom: [],
  requireMention: true,
}
```

语义：

```text
这个明确授权的QQ群内，
任何成员只有 @机器人时才能触发。
```

这更符合用户理解。

---

# 27. 如果需要群成员精细白名单

放 P1。

依然不要让用户手填：

```text
member_openid
```

可以观察：

```text
username
member_openid
group_openid
```

做 group member picker。

但：

```text
member_openid
```

仍只做 canonical runtime identity。

---

# 28. 推荐 UI 最终形态

```text
安全访问

私聊
✓ 仅机器人所属 QQ
  QQ 平台已限制私聊访问，无需额外配置。


群聊

● 指定QQ群
○ 禁止群聊
○ 所有QQ群（危险）

已允许：

研发群
QQ群：123456789
必须 @机器人：✓
[移除]

测试群
QQ群：987654321
必须 @机器人：✓
[移除]

[+ 添加QQ群]
```

点击添加：

```text
添加QQ群

最近发现
○ QQ群 123456789
○ QQ群 987654321

或手动输入QQ群号
[__________]

[添加]
```

---

# 29. 手动输入群号但尚未 observed

输入：

```text
123456789
```

目录不存在 mapping。

不要允许保存成 policy。

显示：

```text
未找到这个QQ群的机器人身份。

请先：
1. 将机器人加入群
2. 在群中 @机器人发送一条消息
3. 返回这里刷新

QQ群号：123456789
```

---

# 30. 是否可以通过 API 主动按群号查询 group_openid

除非腾讯官方明确提供：

```text
group_id → group_openid
```

resolver API，否则不要造。

当前可信路径是：

```text
事件同时携带 group_id + group_openid
```

因此 observation mapping 是最稳定的。

---

# 31. 不要直接依赖 unofficial adapter 字段

虽然其他 QQ SDK 也已经显示：

```text
group_id
union_openid
```

本项目执行依据优先使用：

```text
tencent-connect/openclaw-qqbot
```

因为它同样属于腾讯官方组织。

如果 `@tencent-connect/qqbot-nodejs` 后续正式把：

```ts
groupId?: string
```

提升到 normalized `InboundMessage`：

再从：

```ts
msg.raw.group_id
```

切换为：

```ts
msg.groupId
```

即可。

---

# 32. SDK capability seam

为了避免 channel-qq 到处读 raw，推荐集中在：

```text
packages/channel-qq/src/sdk-client.ts
```

或新增：

```text
packages/channel-qq/src/platform-identity.ts
```

例如：

```ts
export interface QQGroupIdentity {
  groupOpenid: string;
  groupNumber?: string;
}

export function resolveQQGroupIdentity(
  msg: QQBotInboundMessage,
): QQGroupIdentity | undefined
```

mapper 只消费这个已验证结果。

---

# 33. 不要把 raw 传到 Control Plane 做解析

禁止：

```ts
// channel-control
const groupId = (event.raw as any).group_id;
```

禁止：

```ts
// channel-web
raw.group_id
```

允许：

```text
channel-qq
  raw → validate → canonical metadata

channel-core
  externalId

channel-control
  generic directory
```

---

# 34. 推荐文件修改

## channel-core

修改：

```text
packages/channel-core/src/events.ts
```

`ConversationRef` 增加：

```ts
externalId?: string;
name?: string;
```

并注明：

```text
not authorization identity
```

测试：

```text
contract event serialization
```

---

## channel-qq

新增/修改：

```text
packages/channel-qq/src/platform-identity.ts
packages/channel-qq/src/mapper.ts
packages/channel-qq/test/mapper.test.ts
packages/channel-qq/test/qq-e2e.test.ts
```

保留：

```text
definition.ts ownerDiscovery=platform
```

但更新 label / comments。

---

## channel-control

新增：

```text
packages/channel-control/src/access/conversation-directory.ts
packages/channel-control/src/access/conversation-directory-store.ts
```

修改：

```text
packages/channel-control/src/plugin.ts
packages/channel-control/src/service.ts
packages/channel-control/src/types.ts
```

---

## channel-web

新增：

```text
packages/channel-web/src/client/components/ConversationPicker.tsx
```

修改：

```text
packages/channel-web/src/client/ChannelAccess.tsx
packages/channel-web/src/client/components/GroupAccessCard.tsx
packages/channel-web/src/client/api.ts
packages/channel-web/src/protocol.ts
packages/channel-web/src/host/routes-v2.ts
packages/channel-web/src/client/locales.ts
```

---

# 35. Generic Control API

推荐：

```http
GET /dsh-channels/api/v2/channels/:channelId/conversations
```

响应：

```ts
interface PublicConversationIdentity {
  type: 'group';
  canonicalId: string;
  externalId?: string;
  displayName?: string;
  alias?: string;
  firstSeenAt: number;
  lastSeenAt: number;
}
```

不做 QQ 专属：

```http
GET /qq/groups
```

---

# 36. Web save 仍保存 canonical policy

用户：

```text
选择 QQ群 123456789
```

client 得到 candidate：

```json
{
  "externalId": "123456789",
  "canonicalId": "GROUP_OPENID_A"
}
```

最终：

```ts
draft.groups[candidate.canonicalId] = ...
```

---

# 37. Web group card 展示顺序

推荐：

```text
alias
↓
displayName
↓
externalId
↓
short canonicalId
```

例如：

```text
研发群
QQ群：123456789
```

如果没有 alias：

```text
QQ群 123456789
```

如果 externalId 也没有：

```text
QQ群 · GRO...D_A
```

---

# 38. 真实 QQ Live Gate

必须真实验证。

## Gate A：C2C 平台限制

用：

```text
机器人所属 QQ
```

私聊 → 可收到。

再用另一个 QQ：

```text
尝试直接私聊机器人
```

验证平台当前确实不允许/不可达。

结果记录到：

```text
docs/security/channel-identity-map.md
```

这才是：

```text
ownerDiscovery=platform
```

的 live evidence。

---

## Gate B：group_id

目标群：

```text
@机器人 hello
```

在 `channel-qq` debug/live fixture 中记录：

```text
raw.group_id
raw.group_openid
msg.groupOpenid
```

Expected：

```text
raw.group_id = 数字QQ群号
raw.group_openid = GROUP_OPENID
msg.groupOpenid = same GROUP_OPENID
```

---

## Gate C：group mapping

观察后：

```text
Directory:
  externalId = QQ群号
  canonicalId = group_openid
```

Web 应显示数字群号。

---

## Gate D：重启

重启 Harness：

```text
group number ↔ groupOpenid
```

映射仍在。

---

## Gate E：旧 policy

已有 group_openid ACL：

重启/升级后未收到新消息：

```text
权限仍有效
```

收到一次群消息后：

```text
Web 自动补齐群号
```

---

## Gate F：native interaction regression

保留刚实现的：

```text
ask_user_question
QQ inline keyboard
interaction ACK
group_openid
group_member_openid
```

不能因为 conversation metadata 改造产生回归。

---

# 39. Fixtures

真实 payload fixture 必须脱敏：

```json
{
  "group_id": "123456789",
  "group_openid": "GROUP_OPENID_FIXTURE",
  "author": {
    "member_openid": "MEMBER_OPENID_FIXTURE"
  }
}
```

不要把个人真实群号提交仓库。

---

# 40. 测试矩阵

## mapper — group_id present

Input：

```ts
msg.kind = 'group'
msg.groupOpenid = 'OPEN_A'
msg.raw = {
  group_id: '123456789',
  group_openid: 'OPEN_A'
}
```

Expected：

```ts
conversation.id = 'OPEN_A'
conversation.externalId = '123456789'
```

---

## mapper — mismatch

```text
msg.groupOpenid=OPEN_A
raw.group_openid=OPEN_B
raw.group_id=123
```

Expected：

```text
conversation.id=OPEN_A
conversation.externalId=undefined
```

不建立错误 mapping。

---

## mapper — missing group_id

Expected：

```text
message still emitted
canonical ACL unaffected
```

---

## directory

同一：

```text
OPEN_A + 123456789
```

多次观察：

```text
one row
lastSeenAt update
```

---

## directory account isolation

```text
account main / app A
account bot2 / app B
```

不可串。

---

## Web add by number

candidate：

```text
123456789 → OPEN_A
```

保存：

```text
groups.OPEN_A
```

不是：

```text
groups.123456789
```

---

# 41. Access policy 的 QQ 默认群规则

推荐 QQ Web 新增群时：

```ts
{
  enabled: true,
  senderPolicy: 'open',
  allowFrom: [],
  requireMention: true,
}
```

理由：

```text
用户已经按真实QQ群号明确授权了这个群；
群内还要求 @bot；
无需再要求一串 member_openid。
```

如果用户需要成员白名单，后续 P1 再做。

---

# 42. 不要新增 QQConfig allowGroups

不要：

```ts
QQConfig {
  groupNumbers: []
}
```

也不要：

```ts
QQConfig {
  groupOpenids: []
}
```

Access truth 已经在：

```text
ChannelAccessPolicy
```

Directory 只是 identity mapping，不是第二份 ACL。

---

# 43. 不要启用 SDK 自己的 accessPolicy

腾讯 standalone `dsh-qqbot` 使用：

```ts
bot.use(accessPolicy(...))
```

对它是合理的。

本项目已经有：

```text
channel-harness Access Gate
```

因此 QQ adapter 不再做第二层 ACL。

---

# 44. 文档修正

更新：

```text
docs/security/channel-identity-map.md
```

QQ 改为：

```text
C2C:
  canonical sender.id = user_openid
  owner discovery = platform
  platform C2C limited to bot owner/self

Group:
  canonical conversation.id = group_openid
  external human id = group_id (QQ群号)
  sender.id = member_openid

ACL:
  runtime exact-match canonical IDs
  Web may use group_id to resolve/display canonical group_openid
```

---

# 45. docs/security/inbound-access-control.md

明确：

```text
externalId 永远不进入 authorize()
```

Access Controller 仍只收：

```ts
{
  conversationId,
  senderId,
  mentionedBot,
  policy,
}
```

不要改：

```ts
authorize({ groupNumber })
```

---

# 46. 最终架构

```text
QQ Group Event

group_id = 123456789
group_openid = OPEN_A
member_openid = MEMBER_X
        │
        ▼
channel-qq
  validate raw.group_id/group_openid
        │
        ▼
ChannelEvent

conversation:
  id         = OPEN_A
  externalId = 123456789
        │
        ├───────────────► Conversation Directory
        │                     │
        │                     ▼
        │                 channel-web
        │                 QQ群 123456789
        │                     │
        │                  [允许]
        │                     │
        │                     ▼
        │              policy.groups[OPEN_A]
        │
        ▼
Harness Access Gate
conversation.id = OPEN_A
exact-match
```

---

# 47. 私聊最终架构

```text
QQ platform
   │
   │ C2C only self/owner
   ▼
channel-qq
sender.id = user_openid
   │
   ▼
platformPrivatePolicy
dmPolicy=open
   │
   │ “open” 是在已经通过平台私聊准入后的本地语义
   ▼
Harness
```

这里无需：

```text
Owner Claim
QQ user picker
DM allowlist editor
```

---

# 48. 对 `platformPrivatePolicy()` 的说明建议

当前名字可以保留。

建议补充注释：

```ts
/**
 * Used only when the channel declares ownerDiscovery='platform':
 * the upstream platform itself restricts the private-chat audience.
 *
 * `dmPolicy='open'` means "accept every DM that the platform can deliver",
 * not "every platform user can start a DM".
 */
```

这样后续不会再次误读：

```text
dmPolicy=open
=
互联网所有 QQ 用户都能用
```

---

# 49. P0 / P1

## P0

- [x] 保留 QQ `ownerDiscovery='platform'`
- [x] 修正文档中的“platform”含义
- [x] QQ group raw 解析 `group_id`
- [x] `ConversationRef.externalId`
- [x] conversation directory
- [x] group number ↔ group_openid durable mapping
- [x] Web 群权限按 QQ群号展示/选择
- [x] policy 仍保存 group_openid
- [x] 旧 policy 无损兼容
- [x] account 隔离（`channelId + accountId`）
- [x] AppID scope 失效化（同一 account 更换 AppID 时不得复用旧 mapping）
- [x] 首次合法 C2C 自动记录 QQ owner canonical `user_openid`
- [ ] live gate

## P1

- [ ] 群 alias
- [ ] 群名（官方稳定可得时）
- [ ] group member picker
- [ ] discovery modal 自动刷新
- [ ] SDK normalized `groupId` 可用后移除 raw compatibility shim

---

# 50. 最终验收标准

必须满足：

### 私聊

- [x] QQ ownerDiscovery 仍为 `platform`
- [x] Web 不要求填写 user_openid
- [x] Web 明确显示“仅机器人所属 QQ”
- [ ] live 验证其他 QQ 无法直接 C2C 使用

### 群

- [x] Web 主要展示 QQ群号
- [x] QQ群号来自官方 `group_id`
- [x] Runtime canonical id 仍为 `group_openid`
- [x] policy.groups key 仍为 group_openid
- [x] 手动群号必须先能 resolve 到 observed group_openid
- [x] 未 resolve 不允许猜测/保存
- [x] old group_openid policies 继续有效

### 架构

- [x] raw.group_id 只在 channel-qq 解析
- [x] channel-control 不理解 QQ raw
- [x] channel-web 无 QQ payload 解析
- [x] Harness Access Gate 不使用 externalId
- [x] 不增加第二套 QQ ACL
- [x] 不修改 canonical identity contract 语义
