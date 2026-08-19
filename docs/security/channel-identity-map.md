# Channel Identity Map

按渠道记录 canonical identity、dm/group 判定、thread 语义、owner discovery 与
mention 支持。所有 ID 一律作为 **opaque string** 处理（trim 两端空白后 exact compare；
禁止 lowercase / username / fuzzy / raw fallback 参与 ACL）。

## Weixin

- canonical sender.id：`raw.from_user_id`
- canonical conversation.id：`from_user_id`（C2C，= sender.id）
- conversation.type：恒为 `dm`
- thread：无（`threadId` 不参与）
- owner discovery：`account`（`resolveOwnerIdentity` 读取扫码 `userId`）
- mention：`groups=false`，无群 mention
- 事实：mapper `from_user_id -> sender.id`；缺字段有 `"unknown"` fallback（由 Access Gate 拒绝）

## QQ

- canonical sender.id：C2C `senderId`；Group `senderId`
- canonical conversation.id：C2C `senderId`（= sender.id）；Group `groupOpenid`
- dm/group：C2C → dm；Group → group
- owner discovery：`claim`
- mention：descriptor 先 `false`，完成 activation contract 后再置 `true`
- fact：映射稳定；按 plan §11

## DingTalk

- canonical sender.id：`senderId`
- canonical conversation.id：`conversationId`
- dm/group：`conversationType === '2'` → group；否则 dm
- owner discovery：`claim`
- mention：descriptor 先 `false`
- fact：缺 sender 有 `"unknown"` fallback → 必须由 Access Gate 拒绝（`senderId missing -> DENY`）

## Lark / Feishu

- canonical sender.id：`senderId`
- canonical conversation.id：`conversationId`；`oc_*` → group
- dm/group：`oc_*` 前缀 → group；否则 dm
- thread：`threadId` 只参与 Session routing，**不参与 group ACL identity**
- owner discovery：`claim`
- mention：descriptor 先 `false`

## Telegram

- canonical sender.id：`message.from.id`
- canonical conversation.id：`message.chat.id`（`private` → dm；`group`/`supergroup` → group）
- dm/group：chat.type
- group id：保留原始字符串（含 `-100...`），不丢符号
- owner discovery：`claim`
- mention：descriptor 先 `false`

## 证据 / 测试状态

- 每个渠道必须通过 `runInboundIdentityContract()`：sender.id 非空且 `!= "unknown"`、
  conversation.id 非空、conversation.type ∈ {dm, group}、同一远程主体映射稳定、
  group 中 sender.id 与 conversation.id 语义独立。
- mention 启用的渠道必须通过 `activation-contract`：`mentionedBot === true` / `=== false`
  各有 fixture + 断言（不能只测 `undefined`）。
- 更改 ID 语义 / 启用 mention / 修改 manifest 时按需加载
  `.agents/skills/dsh-channels-verification/SKILL.md`。
