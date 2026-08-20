# Inbound Access Control

> 权威 as-built 安全参考。实现依据：`docs/dsh-channels-final-design-execution-plan.md`
> （final-proposed）。本文档在实现完成后成为长期权威来源。

## 目标与不变量

本机 Agent 是**个人入口**：能私聊 Bot 的人 ≠ 有权驱动 Agent 的人。

安全不变量：

1. **No valid policy = DENY**（缺失/损坏 policy 一律拒绝）。
2. **Empty allowlist != open**（空 `allowFrom` 表示拒绝所有人，绝不表示开放）。
3. **Unknown sender = DENY**。
4. **Groups 默认 disabled**。
5. **群范围与群成员范围分离**：所有群模式必须携带明确的默认成员规则。
6. **Authorization 先于 /stop、Command、Binding、Workspace、Session、Agent**。
7. **Adapter 产出 identity / activation facts；Harness 执行授权**。
8. **Harness 永不解析平台 raw payload 做 ACL**。
9. **requireMention 是 Activation，不是 Authorization**。
10. **Open 只在最小明确维度显式出现**。
11. **Owner identity 绝不猜测**（`needs-owner` 而非臆测）。
12. **Access policy 变更无需重启 adapter**（每次 inbound 直读）。
13. **Owner Claim 永不进入 Agent / Session / Binding / Command plane**。
14. **channel-harness 必须注入 Access Policy Resolver**；未接线不得进入放行路径。

## Policy Schema

见 `packages/channel-core/src/access.ts`（`ChannelAccessPolicy` + zod schema），
存储 key：`access:policy:v1:<encoded-channelId>:<encoded-accountId>`；两个 ID 分量
独立使用 `encodeURIComponent` 编码，避免 opaque ID 中的 `:` 造成 key 碰撞。

- `version: 1`；未知版本视为 invalid → DENY。
- `preset`（owner-only / allowlist / custom）是持久化兼容分类；Web 直接编辑真实的
  DM/group 规则，保存时再归类 preset，**运行时不按 preset 分支**。
- `dmPolicy`: disabled | allowlist | open。
- `groupPolicy`: disabled | allowlist | open。
- `groups[conversationId]`: `{ enabled, senderPolicy(allowlist|open), allowFrom[], requireMention }`。
- `groupPolicy=open` 时必须设置启用的 `defaultGroupRule`，且 `groups` 必须为空；该规则应用于 Bot 能接收消息的每个群。
- `ownerId`: canonical sender.id（可暂缺，claim 前）。

## Fail-Closed 枚举

| 情形 | 结果 |
| --- | --- |
| 缺 policy | DENY（missing_policy） |
| 损坏/未知版本 policy | DENY（invalid_policy） |
| sender.id 缺失/空/"unknown" | DENY（unidentified_sender） |
| conversation.id 空 | DENY（invalid_conversation） |
| dmPolicy=disabled | DENY（dm_disabled） |
| dm allowlist 不包含 sender | DENY（user_not_allowed） |
| groupPolicy=disabled | DENY（group_disabled） |
| 指定群模式下群未在 allowlist | DENY（group_not_allowed） |
| 群 sender allowlist 不包含 sender | DENY（group_user_not_allowed） |
| requireMention=true 且无可靠 mention | NOT_ACTIVATED（mention_required） |

拒绝 = silent drop + 结构化 channel-access 日志，**不向攻击者返回任何提示**。

## 授权顺序

见计划 §32。核心：

1. Reserved claim 检查（`/dsh-claim` 由 Control Plane 观察，Harness 吞掉）
2. Identity validation
3. Load policy（missing/invalid → DROP）
4. Security Authorization（DM/group/sender）
5. Activation Gate（requireMention）
6. 之后才进入 conversation key / parseCommand / /stop / Session / Binding / Agent

> `/stop` 的 admission 点移到 Access Gate 之后：未授权用户绝对不能 cancel 本机 Agent，
> 同时已授权 `/stop` 的 fast-path scheduling 语义保持不变。

## Owner

- `ownerDiscovery`：`account`（微信可自动识别）| `claim`（其余四种）| `manual`。
- Weixin：`resolveOwnerIdentity(accountId)` 读取扫码 `userId`，机制封装在
  `channel-weixin` 内部，Control/Harness 不看 `weixin:credential:*`。
- 无 policy + `ownerDiscovery=account` + resolveOwnerIdentity 有值 → 安全 materialize
  `owner-only`（微信升级迁移）。
- 无 policy + `ownerDiscovery=claim` → `needs-owner`，普通 inbound DENY，
  仅 `/dsh-claim` 被 Claim Manager 观察。

### 首次配置期间的精确语义

- Web 在没有已保存 policy 时会以“私聊仅自己”初始化本地编辑草稿；这只是推荐选项，**不是已生效的授权策略**。
- 所有者尚未识别时，`owner-only` 不能保存：Control validation 要求有效的 `ownerId`。
- `needs-owner` / `missing-policy` / `invalid-policy` 均保持 fail-closed。渠道连接可以继续运行，但普通消息、`/stop`、其他命令以及任何 Session / Binding / Workspace / Agent 副作用都被拒绝。
- 本地用户主动开始 Owner Claim 后，只有形如 `/dsh-claim <challengeCode>` 的保留控制消息可以被 Claim Manager 观察；它始终由 Harness 吞掉，不进入 Agent。候选账号仍需在本地 Web 确认后才成为 owner。
- 确认 claim 且此前没有 policy 时，Control 写入标准 `owner-only` policy：`dmPolicy=allowlist`、`allowFrom=[ownerId]`、`groupPolicy=disabled`。

### Web 映射不变量

- 私聊访问直接映射为 `disabled` / owner allowlist / explicit allowlist / `open`，不通过可见的“自定义”二次选择。
- `ownerDiscovery=account`（当前为微信）的私聊访问固定显示 owner-only，不提供可编辑的 DM 选项；上述四选项仅用于 `claim/manual` 渠道。
- 当 `ownerDiscovery=account` 且渠道不支持 groups 时，Access 区域是完全只读状态，不显示无群聊占位文案或保存按钮。
- 私聊与 named-group 规则彼此独立；修改私聊规则不得清空群规则。
- 群内“仅自己”必须写成 `senderPolicy=allowlist` + `allowFrom=[ownerId]`。
- 空 `allowFrom` 在 DM 和 group 中都表示 DENY ALL，UI 不得把它标成 owner-only。
- “所有人”只允许出现在明确维度：DM 的 `dmPolicy=open`，或群规则的 `senderPolicy=open`。`groupPolicy=open` 只表示所有群匹配 `defaultGroupRule`，不隐含群内所有成员开放。

## Owner Claim

保留命令 `/dsh-claim <challengeCode>`（channel-core 提供常量/解析器）。

- 只能由本地 Web/API 主动 begin；16 random bytes 挑战码；5 分钟 TTL；single-use；
  同一 channel/account 同时最多一个 active claim，重复 begin 恢复该会话而不替换 challenge；只接受 DM；必须有有效 canonical sender.id；
  收到 candidate 后停止接受新 candidate；candidate 不自动成为 owner；本地 confirm 后才写 owner；
  owner 变化写审计日志。
- Claim 消息不进入 Agent / Session / Binding / Command plane（Harness 保留并吞掉）。

## Logging

- namespace：`channel-access`（已加入 `channel-harness/src/debug-logger.ts` 白名单）。
- 记录：channel、account、conversationType、reason。
- 禁止记录：message body、claim challenge、platform token、credential、media、raw payload、signed URL。
- sender / conversation id：debug 完整，普通日志最小化。

## Migration

- 升级前已有连接但无 policy → 不能自动 open。
- Weixin：已有 `credential.userId` + 缺 policy → 自动 owner-only。
- QQ / DingTalk / Lark / Telegram：无已验证 owner → `needs-owner`，网络连接可继续以便接收 claim，
  但 Harness 普通 inbound DENY，Web 提示完成「识别我的账号」。

## 边界

- Platform permission（Bot/API 需要什么能力）与 Agent Access（谁能驱动本机 Agent）**概念分离**。
  Web 当前只展示真实的 `ChannelAccess`；在没有平台 permission probe 前，不展示静态平台权限状态。
- 未来任何能触发 Agent/Command/Session/Binding/Workspace/本地副作用的 inbound 事件，
  都必须复用同一 Access Controller（红线 13）。
