# Channel Identity Map

按渠道记录 canonical identity、dm/group 判定、thread 语义、owner discovery 与
mention 支持。所有 ID 一律作为 **opaque string** 处理（在 Harness admission 前 trim 两端空白后 exact compare；
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

- canonical sender.id：C2C `senderId`；Group `senderId`（`member_openid`）
- canonical conversation.id：C2C `senderId`（= sender.id）；Group `groupOpenid`（`group_openid`）
- group discovery：QQ 群权限配置只使用 `groupOpenid` / `group_openid`。不把
  `raw.group_id` 当作 QQ 群号或映射来源，因为真实群事件不能稳定提供可配置的群号。
  Web 从入站事件的 canonical OpenID 列出最近发现的群；**永不参与授权的派生或
  猜测**，policy 始终保存 group_openid
- dm/group：C2C → dm；Group → group
- owner discovery：`platform`（QQ 平台限制私聊仅机器人所属/创建者；收到首个合法 C2C
  入站时自动保存其 canonical `user_openid`，不需要发送特殊识别指令；Web 显示
  「仅机器人所属 QQ 可私聊」固定状态）
- mention：新版 Gateway 的 `GROUP_AT_MESSAGE_CREATE`，或 SDK 结构化
  `mentions[].is_you === true` → `mentionedBot=true`；其他 `GROUP_MESSAGE_CREATE` →
  `false`。descriptor 为 `true`，新群规则默认要求 @
- fact：映射稳定；缺 `group_id` 时 externalId 缺失、消息不丢弃（fail-safe，
  canonical ACL 不受影响）

## DingTalk

- canonical sender.id：`senderId`
- canonical conversation.id：`conversationId`
- dm/group：`conversationType === '2'` → group；否则 dm
- owner discovery：`claim`；钉钉没有 QQ 式“只能创建者私聊”的平台保证，需通过一次
  私聊识别 sender canonical id
- mention：官方机器人回调 `isInAtList` 经 stream upstream 校验后映射为严格布尔
  `message.activation.mentionedBot`；descriptor 为 `true`，新群规则默认要求 @。
  缺失该字段时保持 `undefined`，Access Gate 对 `requireMention` fail-closed。
- fact：缺 sender 有 `"unknown"` fallback → 必须由 Access Gate 拒绝（`senderId missing -> DENY`）

## Lark / Feishu

- canonical sender.id：`senderId`（事件 `sender.sender_id.open_id`）
- canonical conversation.id：`conversationId`（事件 `message.chat_id`）；私聊和群聊都可能是 `oc_*`
- dm/group：使用事件 `message.chat_type`：`p2p` → dm，`group` → group；不得根据 `chat_id` 前缀推断
- thread：`threadId` 只参与 Session routing，**不参与 group ACL identity**
- owner discovery：`claim`；飞书应用机器人可被授权范围内用户私聊，不能假设只有创建者，
  需通过一次私聊识别 sender canonical id
- mention：官方 `im.message.receive_v1` 包含 `message.mentions[]`，但当前 upstream
  尚未注入可信的机器人自身 `open_id`，因此不能安全判定是否 @ 本机器人；descriptor
  保持 `false`，待 bot identity 注入与 fixture/live gate 后再启用。

## Telegram

- canonical sender.id：`message.from.id`
- canonical conversation.id：`message.chat.id`（`private` → dm；`group`/`supergroup` → group）
- dm/group：chat.type
- group id：保留原始字符串（含 `-100...`），不丢符号
- owner discovery：`claim`
- mention：`getMe` 提供当前 Bot ID/username；mapper 按 Telegram `MessageEntity`
  的 UTF-16 offset/length 识别 `mention`、`text_mention` 与定向 `bot_command`，
  对群消息产出严格布尔 `activation.mentionedBot`；descriptor 为 `true`，新群规则默认
  `requireMention=true`

## 证据 / 测试状态

- 每个渠道必须通过 `runInboundIdentityContract()`：sender.id 非空且 `!= "unknown"`、
  conversation.id 非空、conversation.type ∈ {dm, group}、同一远程主体映射稳定、
  group 中 sender.id 与 conversation.id 语义独立。
- mention 启用的渠道必须通过 `activation-contract`：`mentionedBot === true` / `=== false`
  各有 fixture + 断言（不能只测 `undefined`）。
- 更改 ID 语义 / 启用 mention / 修改 manifest 时按需加载
  `.agents/skills/dsh-channels-verification/SKILL.md`。
