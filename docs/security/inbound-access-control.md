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
5. **V1 groups 必须显式 named**（无「所有群全局 open」）。
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
- `preset`（owner-only / allowlist / custom）仅用于 Web UX / materialization，
  **运行时不再按 preset 分支**。
- `dmPolicy`: disabled | allowlist | open。
- `groupPolicy`: disabled | allowlist（V1 无全局 open）。
- `groups[conversationId]`: `{ enabled, senderPolicy(allowlist|open), allowFrom[], requireMention }`。
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
| 群未在 allowlist | DENY（group_not_allowed） |
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

## Owner Claim

保留命令 `/dsh-claim <challengeCode>`（channel-core 提供常量/解析器）。

- 只能由本地 Web/API 主动 begin；16 random bytes 挑战码；5 分钟 TTL；single-use；
  同一 channel/account 同时最多一个 active claim；只接受 DM；必须有有效 canonical sender.id；
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

- Platform permission（Bot/API 需要什么能力）与 Agent Access（谁能驱动本机 Agent）**概念分离**，
  见 `docs/architecture/common-design.md` 与 Web `ChannelPermissions` / `ChannelAccess` 两区。
- 未来任何能触发 Agent/Command/Session/Binding/Workspace/本地副作用的 inbound 事件，
  都必须复用同一 Access Controller（红线 13）。
