---
name: dsh-channels-verification
description: 核验 wsz987/dsh-channels 当前代码架构、各渠道插件/上游、配置与凭据字段、实际接口、平台权限和官方文档，并识别代码/文档/平台能力漂移。用于新增渠道、升级 SDK、发布前检查、排查权限问题、维护 channel-web 渠道设置页。
title: DSH Channels 渠道核验 Skill
summary: 以当前代码为实现事实，以官方平台文档为权限事实，核验 Weixin / QQ / DingTalk / Lark / Telegram。
when_to_use: 渠道核验 | SDK 升级 | 权限核验 | 插件升级 | channel-web | 发布检查 | live verification
authoritative: 核验流程、事实优先级、渠道字段与接口映射、权限核验规则、已知漂移项。
see_also: [references/channel-matrix.md, references/official-sources.md, references/audit-checklist.md]
status: snapshot
metadata:
  repository: https://github.com/wsz987/dsh-channels
  branch: main
  snapshot_commit: 78655a40a266c4122ecd0c030b0a882fdb92f2df
  snapshot_date: 2026-08-19
  synced_date: 2026-09-12
---

# DSH Channels Verification Skill

> **定位：** 本文与 `.agents/skills/dsh-channels-verification/`（`SKILL.md` +
> `references/*`）**配套并存**，两者交叉核对以**防止平台权限/能力漂移**——Skill 目录是
> 可被 agent 加载的可执行指引，本文是同一核验内容的持久化快照，用于跨会话检索与
> 权限基线对照。发现二者不一致时以当前代码 + 官方平台文档为准。

> **同步记录（2026-09-12）**：初版快照为 `78655a40`（2026-08-19）。本次把快照同步到
> 当前代码：补 Lark CardKit 2.0 接口与 L1-L5 live gate、QQ 内联键盘、DingTalk 问答卡片
> opt-in 口径，并记录两条 P0 核验发现（answerer 顺序契约、能力声明 ≠ 平台事实）。
> 快照基线 SHA 保持初版，便于判断哪些结论早于该 SHA。

> **快照基线**：`main@78655a40a266c4122ecd0c030b0a882fdb92f2df`（2026-08-19）。
>
> 这个 Skill 的目的不是描述“理想设计”，而是让 AI 在后续维护时能区分：
>
> 1. **当前代码真的做了什么**
> 2. **仓库 manifest 声称验证到了什么**
> 3. **channel-web 当前展示了什么**
> 4. **平台官方实际上要求什么**
> 5. **哪些仍必须 live verification**

## 1. 必须遵循的事实优先级

核验时不要把所有来源混成一个“事实”。

### 1.1 DSH 实现事实

按以下顺序读取：

1. `packages/channel-*/src/definition.ts`
   - Web/Control Plane 暴露哪些 setup 字段
   - 哪些字段是 secret
   - auth method 是 credentials / device / hybrid / qr
2. `packages/channel-*/src/config.ts`
   - 完整配置结构、默认值、credential ref
3. `packages/channel-*/src/adapter.ts`
   - 对 Channel Contract 声明的真实 capability
4. `packages/channel-*/src/upstream*` / `sdk-client.ts` / `official-upstream.ts`
   - 真实调用的平台接口
5. `packages/channel-*/src/manifest.ts`
   - 上游 reference、testedVersion、strategy、status
6. `packages/channel-web/src/client/channelRegistry.ts`
   - **仅视为 UI presentation metadata**
   - 绝不能把这里的 permissions 当作平台已授权/已检测事实

### 1.2 平台权限事实

平台权限、scope、intent、管理员权限以**当前官方平台文档/官方 SDK**为准。

> **代码调用什么 API** 与 **平台允许这个 App/Bot 调什么 API** 是两件事。

### 1.3 验证等级

每个结论必须标记成以下一种：

- `CODE-CONFIRMED`：当前 DSH 代码直接确认
- `OFFICIAL-CONFIRMED`：当前平台官方文档/官方 SDK 确认
- `LIVE-REQUIRED`：必须真实账号/真实应用验证
- `DRIFT`：代码、manifest、UI 或官方平台之间已出现版本/能力漂移
- `UNKNOWN`：没有足够权威证据，禁止猜

---

## 2. 当前架构基线

当前 monorepo 的核心分层：

```text
DeepSeek Harness / Cordis
        │
        ├─ channel-harness       # 唯一 Harness Agent / Session API 边界
        │
        └─ channel-core          # 稳定 Channel Contract + ChannelService
                 │
                 ├─ channel-control   # setup / credential / auth / runtime mount
                 ├─ channel-web       # 通用 Web 设置面板
                 ├─ channel-files     # 通用附件扩展
                 │
                 └─ channel adapters
                    ├─ channel-weixin
                    ├─ channel-qq
                    ├─ channel-dingtalk
                    ├─ channel-lark
                    └─ channel-telegram
                              │
                              └─ SDK / OpenAPI / source-port / protocol

@wsz987/dsh-channels = 产品 Bundle，只负责一次性安装/组合，不直接实现平台协议。
```

### 架构红线

后续 AI 修改时必须保持：

- `channel-core` 不得出现 `if (channel === 'xxx')`
- adapter 不得访问 `ctx.agents`
- `channel-harness` 不得 import 平台 SDK
- root bundle 不得直接调用平台 SDK
- 不得自动追 SDK / upstream `latest`
- raw platform payload 不得直接进入模型
- 浏览器不得接触 secret / token / deviceCode / providerState
- adapter 不得直接读写 Harness persistence
- `channel-web` 不得维护平台业务分支；平台差异只允许落在 registry presentation metadata 或 ChannelDefinition

---

## 3. 当前渠道总览

详细字段见 [`references/channel-matrix.md`](references/channel-matrix.md)。

| 渠道 | DSH 包 | 上游策略 | 当前基线 | manifest 状态 | Setup/Auth | 主要能力 |
|---|---|---|---|---|---|---|
| Weixin | `@wsz987/channel-weixin` | Tencent iLink `source-port` | upstream fixture `2.4.6`，manifest live pin 待完成 | `experimental` | 无 setup 字段；QR | text/image；buffered |
| QQ | `@wsz987/channel-qq` | Tencent 官方 SDK | `@tencent-connect/qqbot-nodejs@1.0.4` | `tested`* | AppID + AppSecret | text/image/file/audio/video；C2C native stream；内联键盘 |
| DingTalk | `@wsz987/channel-dingtalk` | 官方 Stream SDK + OpenAPI | `dingtalk-stream@2.1.5` | `tested`* | ClientID + ClientSecret；device/credentials | text/image/file/audio/cards；edit stream；问答按钮 opt-in |
| Lark/Feishu | `@wsz987/channel-lark` | 官方 Node SDK | `@larksuiteoapi/node-sdk@1.73.1` | `tested`* | AppID + AppSecret；credentials/hybrid | text/image/file/audio/cards/reactions/threads/interactive actions；edit stream |
| Telegram | `@wsz987/channel-telegram` | Bot API HTTP 直连 | manifest `Bot API >=10.2` | `experimental` | Bot token | text/image/file/audio/video/threads；Rich Markdown + streaming |

\* `tested` 当前主要指 contract/fixture/offline SDK tests 已通过；**不等于真实平台权限与账号 live gate 已通过**。

---

## 4. Secret 与配置规则

### 通用规则

AI 修改任何渠道时：

1. Secret **不能**写入 profile/YAML/git fixture/log/error/browser DTO。
2. config 只保存 credential reference。
3. secret 由 credentials/secrets seam 在 runtime resolve。
4. `ConfiguredState` 只能返回：
   - secret 是否 configured
   - writable/source
   - **不能返回 secret value**
5. 老 plaintext 字段只能用于一次性 migration，不得成为新配置写入路径。

### 当前 secret ref

| 渠道 | Web setup secret | Config ref | 默认 credential ref |
|---|---|---|---|
| DingTalk | `clientSecret` | `upstream.clientSecretRef` | `DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET` |
| Lark | `appSecret` | `upstream.appSecretRef` | `DSH_CHANNEL_LARK_MAIN_APP_SECRET` |
| QQ | `appSecret` | `appSecretRef` | `QQBOT_APP_SECRET` |
| Telegram | `token` | `tokenRef` | `TELEGRAM_BOT_TOKEN` |
| Weixin | 无 Web secret 字段 | QR 登录后写 SecretStore | `weixin:token:<accountId>` |

Weixin 的非 secret 登录元数据单独存储为：

```text
weixin:credential:<accountId>
  - ilinkBotId
  - userId?
  - baseUrl
  - savedAt
```

---

## 5. channel-web 平台权限展示

当前 Web 不展示平台权限状态。原 `ChannelPermissions.tsx` 与
`channelRegistry.permissions` 只包含静态 presentation metadata，没有平台
permission probe，已从 UI 和 registry 删除。

设置页因此不会用绿色勾暗示平台 scope、Bot intent、事件订阅、应用发布或真实消息
收发已经验证。平台配置要求仍记录在本核验文档、README 和各平台官方文档中；
`channelRegistry.docsUrl` 只提供官方资料入口，不表示任何授权状态。

### 建议后续架构

如果未来要做到真实检测，应该引入通用 contract，例如：

```ts
interface ChannelPermissionStatus {
  id: string;
  state: 'granted' | 'missing' | 'unknown' | 'not-applicable';
  required: boolean;
  source?: 'platform-api' | 'runtime-probe' | 'static';
  detail?: string;
}
```

由各 `ChannelDefinition` / provider-specific permission checker 返回，Web 只渲染通用 DTO。

**不要**在 `channel-web` 写：

```ts
if (channelId === 'lark') ...
if (channelId === 'qq') ...
```

---

## 6. 各平台权限模型

### 6.1 Lark / Feishu

这是最明确的 scope + event subscription 模型。

当前 DSH 核心消息链路至少应核验：

```text
应用能力：
- 机器人

Tenant / 应用身份权限：
- im:message.p2p_msg:readonly
- im:message.group_at_msg:readonly
- im:message:send_as_bot

事件：
- im.message.receive_v1
- card.action.trigger（原生卡片按钮）
```

当前实现还使用（全量走官方 Node SDK）：

```text
im.v1.image.create
im.v1.file.create
im.v1.messageResource.get        # 入站资源下载
im.v1.chat.get（卡片按钮回调的会话类型确认）
message reaction add/remove（Typing）
im.v1.message.patch              # 重写已发送的交互卡片（非流式）
cardkit.v1.card.create           # Card JSON 2.0 卡片实体
cardkit.v1.card.settings         # 关闭 streaming_mode + summary
cardkit.v1.cardElement.content   # 原生流式打字机更新
```

> 卡片/流式已收敛为官方 CardKit 2.0 生命周期：创建卡片实体 → 发送卡片引用 →
> `cardElement.content`（单调 sequence + 稳定 uuid）→ `card.settings` 关闭流式。
> 不得用 `im.v1.message.patch` 高频全量替换冒充原生打字机流式，也不用
> `cardkit.v1.card.idConvert` 作为主路径（官方已不推荐）。

因此继续核验：

- 图片/文件资源上传权限
- 卡片/消息 patch 所需权限
- CardKit 对应权限（应用身份必须与创建卡片实体者一致）
- `im.v1.chat.get` 所需的当前群信息读取权限（卡片按钮启用时，无法读取则 fail-closed）
- `card.typingIndicator=true` 时 reaction 相关权限
- 如果产品需要群聊中“非 @ 消息”，需申请对应的敏感“群组全部消息”权限，而不是只依赖 `group_at_msg`

权限或事件修改后还要核验应用版本是否已发布生效。

#### Feishu live gate 清单（LIVE-REQUIRED，离线通过 ≠ 平台通过）

用专用测试租户与测试群，逐项记录：应用版本、租户、chat_id、message_id、时间、结果、平台错误码。

| Gate | 必须验证 |
| --- | --- |
| L1 连接与入站 | WS 握手成功并收到 `im.message.receive_v1`；P2P 文本进入 canonical mapper；群聊 @ 文本可达（非 @ 需按产品策略单独验证，不得默认宣称支持）；`thread_id/root_id/parent_id` 映射正确 |
| L2 普通出站与媒体 | 文本发送返回 `message_id`；图片上传/发送/入站下载；文件上传/发送/入站下载；音频/视频入站可下载（出站仍标 unsupported） |
| L3 Card JSON 2.0 | 新建卡片实体返回 `card_id`；发送 card reference 成功；`cardElement.content` 连续更新 ≥20 次且 sequence 无乱序；结束 `streaming_mode=false` 且会话预览不再显示生成中；触发 30,000 字符 rollover 后续卡片仍可生成；错误路径可见且不泄露 secret/raw payload |
| L4 交互与反应 | Card 2.0 button 回调收到 `card.action.trigger`；callback value 的 action 通过统一 interaction gate；`im.v1.chat.get` 失败时 interaction 被丢弃且无本地副作用；Typing reaction add/remove 成功，权限不足只产生可诊断错误 |
| L5 安全与运维 | 浏览器 DTO / 配置 / 日志 / 错误不含 AppSecret、token、providerState；重启后 credentials ref 仍能构造 SDK client；WS 重连重复投递不产生重复 Harness session；应用未发布或 scope 缺失时 health/日志能区分连接失败与权限失败 |

未完成 L1-L5 前，manifest 不得声称 live-tested。

### 6.2 QQ

QQ 不是 Lark 那种 scope 表，核心是：

```text
AppID + AppSecret
+ Bot 平台能力
+ Gateway intents
+ 部分能力资格（例如 Markdown）
```

腾讯官方 SDK 当前定义的 intents：

```text
GUILDS
GUILD_MEMBERS
PUBLIC_GUILD_MESSAGES
DIRECT_MESSAGE
GROUP_AND_C2C
INTERACTION
```

**CODE-CONFIRMED**：当前 DSH 已显式传入最小 intent mask：

```ts
new QQBot({
  appId,
  appSecret,
  accountId,
  markdownSupport,
  transport: 'websocket',
  tokenPrefetch: 'sync',
  intents: QQ_MINIMAL_INTENTS,
})
```

`QQ_MINIMAL_INTENTS = GROUP_AND_C2C | INTERACTION`，不再依赖 SDK 的
`FULL_INTENTS` 默认值。真实 QQ live gate 仍需确认目标 App 已获准这两项，否则 Gateway
可能返回 `4914 INSUFFICIENT_INTENTS` / `4915 DISALLOWED_INTENTS`。

另外：

- `markdownSupport=true` 只能在 QQ Bot 已获得 Markdown 平台权限时开启
- C2C 原生 `stream_messages` 只适合当前代码的 C2C + reply message id 场景
- 群聊当前走 buffered send，不应误标为 native streaming

**CODE-CONFIRMED**：QQ 声明 `interactiveActions: true`，`OutboundMessage.actions` 走新版
QQ Markdown 内联键盘（`msg_type=2` + `markdown.content` + `keyboard`，callback action type
`1`），按钮回调产生 canonical `interaction.received` 供 Harness 问题展示使用。该能力依赖
QQ Bot 已获 Markdown/内联键盘资格，属 **LIVE-REQUIRED**。

### 6.3 DingTalk

主要模型：

```text
企业内部应用
+ ClientID(AppKey)
+ ClientSecret(AppSecret)
+ 机器人能力
+ Stream 模式 / 事件接收
+ 各 OpenAPI 对应应用权限
```

当前实际接口包括：

```text
Inbound
- DingTalk Stream SDK
- bot message callback / Stream connection

Auth
- POST /v1.0/oauth2/accessToken

Reply
- inbound sessionWebhook

Proactive
- POST /v1.0/robot/groupMessages/send
- POST /v1.0/robot/oToMessages/batchSend

Media
- POST https://oapi.dingtalk.com/media/upload
- POST /v1.0/robot/messageFiles/download

AI Card
- POST /v1.0/card/instances          # 流式 AI Card（callbackType: STREAM）
- POST /v1.0/card/instances/deliver
- PUT  /v1.0/card/streaming

问答卡片按钮（OPT-IN，需 card.interactiveTemplateId）
- POST /v1.0/im/interactiveCards/send
- PUT  /v1.0/im/interactiveCards
- Stream 回调 topic /v1.0/card/instances/callback（dingtalk-stream TOPIC_CARD）
```

核验平台时不能只验证 Stream 可以收消息，还必须逐项验证：

- 主动群消息
- 主动单聊消息
- media upload/download
- AI Card create/deliver/streaming

具体 OpenAPI 权限名称以**当次官方 API 文档的“权限要求”**为准，不要从旧博客或第三方镜像猜名字。

**问答按钮是 opt-in 能力（CODE-CONFIRMED，重要纠错）**：协议支持卡片「回传请求」按钮 +
STREAM 回调（官方要求创建卡片带 `callbackType="STREAM"` 且注册
`/v1.0/card/instances/callback`），但按钮**要求卡片模板已在本组织卡片平台发布**且含
`text`/`actions` 变量。因此 `capabilities.interactiveActions` **不再**由内置第三方模板默认
开启：`card.interactiveTemplateId` 无默认值，未显式配置即 `false`，问题走编号文字回复
（与微信一致）；配置了但卡片发送失败时，`channel-harness` 会把该批问题降级为文字而非取消。
**LIVE-REQUIRED**：`POST /v1.0/im/interactiveCards/send` 是否接受 `callbackType`，以及卡片
点击能否真的回到 STREAM 回调 topic。

群消息 @ 激活：官方机器人回调提供 `isInAtList`。当前 DSH stream upstream 在 zod
信任边界校验该字段，并映射为 `message.activation.mentionedBot`；缺失字段不作猜测。
因此 DingTalk descriptor 声明 `mentions: true`，新群规则默认 `requireMention: true`。
这只证明离线代码链路，真实应用仍需 live gate 验证回调在目标群中的取值。

### 6.4 Telegram

Telegram Bot API 没有 Lark 风格 OAuth scope 表。

主要权限/可见性来自：

```text
BotFather token
Bot 是否在目标 chat 中
Group Privacy Mode
Bot 管理员权限（按操作）
目标 chat 是否允许 Bot 发送对应消息
```

当前 DSH 使用 long polling：

```text
deleteWebhook
getUpdates allowed_updates=['message', 'callback_query']
```

因此：

- `deleteWebhook` 不是只读探测：adapter 启动时会移除该 Bot 已配置的 webhook，并接管
  update receiver；同一 Bot 不得同时交给其他 webhook consumer
- 群聊如果开启 Privacy Mode，Bot 不会自动看到所有普通群消息
- 如果产品目标是“所有群消息都进入 Agent”，必须显式核验 BotFather privacy / 管理员状态
- 当前 20 MiB inbound download cap 与 Telegram cloud Bot API `getFile` 的 20 MB 下载限制对齐

**CODE-CONFIRMED**：仓库 manifest 与 fixtures 已迁移到 **Bot API 10.2**，`auto` 使用 Rich Markdown；最低支持版本为 10.2，不维护旧 Bot API server。状态仍为 `experimental`，Rich output、draft streaming、callback 与 429 recovery 仍需真实 Bot live gate。

**CODE-CONFIRMED**：`sendMedia()` 已校验 Bot API `ok` envelope；普通 message/update 与
callback payload 已经过 zod trust-boundary schema；缺少 `message.chat` 的 callback query
会 fail closed。剩余工作是真实 Bot live gate，不再有这三项离线 release blocker。

### 6.5 Weixin iLink

当前 Tencent iLink / `openclaw-weixin` 参考实现不是公开 OAuth scope 模型，而是：

```text
QR 登录
  ↓
获得 ilink bot token
  ↓
AuthorizationType: ilink_bot_token
Authorization: Bearer <token>
  ↓
getupdates / sendmessage / getuploadurl / getconfig / sendtyping
```

当前 DSH：

- Web setup fields = `[]`
- auth method = `qr`
- token 保存到 SecretStore
- iLink identity/base URL 保存到 ChannelStorage
- source-port 隔离协议/AES/CDN 细节
- `file` capability 当前为 `false`
- concrete upstream 的 `sendFile()` 当前明确抛 `UpstreamCapabilityError`

因此：

- **不要**因为 Tencent reference README 的 `sendMessage` 协议可描述 file，就把 DSH `file` capability 改成 true
- 必须以 DSH concrete upstream 是否真正支持为准
- 当前 manifest 仍是：
  - `testedVersion: <pending-live-verification>`
  - `testedCommit: <pending-live-verification>`
  - `versionRange: '*'`
  - `status: experimental`
- live gate 通过后必须 pin upstream version/commit，不能长期保留 `*`

---

## 7. 当前优先级最高的核验发现

### P0 — answerer 顺序是契约（渠道问答曾经全渠道失效）

官方问题域是 `user-questions/request` **waterfall**：Cordis waterfall **串行、先认领者胜**，
第一个返回答案的 listener 否决其后全部 listener，只有 `next()` 才委托。`dsh-scope` 只保证
「未打 tag 的根 listener 一定被准入」，**不保证顺序**。官方 `@deepseek-ai/dsh-api-remotes`
（web profile 开机即注册）早于 `channels-harness`，因此渠道 answerer 必须用
`ctx.on('user-questions/request', h, { prepend: true })` 注册，否则：

- 有浏览器连接：问题被 Web UI 认领并挂起，渠道（含微信文字兜底）收不到；
- 无浏览器连接：请求 park 在 `pendingRemoteEvents`（无自动 `next()`），渠道同样收不到。

渠道无法展示（无 binding / 无 active reply context / `text: false` / 该会话已有 pending）
时仍 `next()` 委托 Web answerer；无人认领由官方以 `NO_PROVIDER` 拒绝。
回归测试：`packages/channel-harness/test/question-waterfall-backend.test.ts`。

### P0 — 能力声明 ≠ 平台事实（按钮发不出去必须降级）

`capabilities` 是适配器静态声明，真实平台仍可能拒绝（钉钉卡片模板未在本组织发布、缺权限，
QQ 内联键盘未获资格……）。因此：

- 适配器**不得**用操作者无法控制的默认值声明按钮能力（钉钉 `card.interactiveTemplateId`
  已取消内置默认，fail closed）；
- `channel-harness` 在 actions 模式发送失败时，把该批问题降级为 `text` 并重新渲染发送
  （带上「回复 1/2/3」说明与群聊关联码），只有文字也失败才取消问题。

### P0 — 平台权限状态必须来自真实检测

`channel-web` 已删除静态 permission ✓。未来恢复平台权限 UI 时，状态至少区分：

```text
Required（需求说明）
Unknown（尚未检测）
Granted（真实检测）
Missing（真实检测失败）
```

### CODE-CONFIRMED — QQ intents 已最小化

当前 DSH 已按实际事件面显式传入：

```text
GROUP_AND_C2C | INTERACTION
    ↓
QQ_MINIMAL_INTENTS
    ↓
显式传入 QQBot；live gate 核验 App 权限
```

而不是请求所有 intents。

### P1 — Telegram Bot API 10.2 live gate

```text
DSH minimum:  >=10.2
官方当前:     10.2 (2026-07-14)
```

离线 release blockers 已修复；进入 live gate 时确认：

1. media response envelope 的结构化错误行为符合真实 Bot API
2. message/update 与 callback schema 覆盖真实 payload
3. 无 `message.chat` 的 callback query 保持 fail closed
4. 明确接受 polling 启动会删除已有 webhook 的运维语义

随后执行：

1. Rich Markdown / table / code / link live verification
2. DM draft 与 group final edit live verification
3. 8K / 32K+ 与 429 cooldown live verification
4. live gate 完成后再评估将 status 从 `experimental` 升级

### P1 — Weixin live pin 尚未完成

当前：

```text
testedVersion = <pending-live-verification>
testedCommit  = <pending-live-verification>
versionRange  = *
status        = experimental
```

Tencent 官方 `openclaw-weixin` 参考协议存在，但 DSH 是 source-port，必须通过真实 iLink gate 后再升级状态。

### Web 官方文档入口

`channelRegistry.docsUrl` 与权限状态完全分离：有配置字段的渠道在“应用配置”标题旁显示，
微信等无配置字段但有交互授权的渠道在“授权”标题旁显示。微信当前指向腾讯官方
`https://github.com/Tencent/openclaw-weixin`，不再使用无关的视频号入口。

未来若实现真实检测，Lark 等渠道必须使用准确的 platform scope/event id，不能复用
抽象的展示 id。

---

## 8. AI 后续执行流程

每次用户说“核验某渠道”或“升级某 SDK”时，按以下顺序执行。

### Step 1 — 锁定代码快照

```text
repo
branch
HEAD SHA
HEAD date
```

如果 HEAD 与本 Skill 的 snapshot commit 不同，先标记：

```text
DRIFT: repository changed after skill snapshot
```

### Step 2 — 读取实现四件套

目标渠道最少读取：

```text
definition.ts
config.ts
adapter.ts
manifest.ts
```

再读取真实平台边界：

```text
sdk-client.ts
official-upstream.ts
openapi-outbound.ts
upstream.ts
source-port implementation
```

### Step 3 — 列出真实 API

禁止只读 README。

从代码列出：

```text
Inbound
Outbound
Media upload
Media download
Streaming
Typing/reaction
Auth
Proactive send
```

### Step 4 — 对照当前官方文档

只使用：

- 平台官方文档
- 平台官方 GitHub
- 平台官方 SDK
- 官方 npm package metadata

第三方项目只能作为参考，不能用来宣布权限事实。

### Step 5 — 建立 permission matrix

每个 API 都回答：

```text
API/能力
DSH 是否调用
平台权限/intent
是否必需
是否可静态确认
是否必须 live verify
```

### Step 6 — 对照 channel-web

检查：

- setup fields 是否与 ChannelDefinition 一致
- secret 是否仅由 credentials endpoint 写入
- permission copy 是否准确
- docsUrl 是否仍有效
- 是否误显示“已授权”
- auth prerequisite 是否匹配

### Step 7 — 对照 manifest

检查：

```text
reference
strategy
sdk package
testedVersion
versionRange
status
lastVerifiedDate
```

禁止：

```text
看到 upstream 有最新版 → 直接升级 latest
```

### Step 8 — 输出差异

固定输出：

```text
Architecture
Setup/Credentials
API Surface
Permissions
Upstream Drift
Web UI Drift
Live Verification
Recommended Changes
```

---

## 9. 发布/升级判断规则

### 可以标 `tested` 的最低标准

不能只因为 unit tests 通过。

至少应区分：

```text
offline-tested
live-tested
```

如果 manifest schema 暂时只有 `tested/experimental`，文档必须写明 live gate 状态。

### 不允许自动升级 upstream

任何升级都要：

```text
pin candidate version
→ compare upstream changelog/source
→ update fixtures
→ contract tests
→ adapter tests
→ live platform gate
→ update manifest
```

---

## 10. 输出模板

后续 AI 核验渠道时建议使用：

```markdown
## <Channel> verification

Snapshot:
- DSH: <sha>
- Upstream: <version>
- Official docs checked: <date>

### Architecture
...

### Setup / credentials
...

### Actual APIs
...

### Required platform permissions
| API | permission / intent | required | evidence | live |
|---|---|---|---|---|

### Drift
- ...

### Result
- CODE-CONFIRMED:
- OFFICIAL-CONFIRMED:
- LIVE-REQUIRED:
- DRIFT:

### Changes
- P0:
- P1:
- P2:
```

---

## 11. 本快照结论

当前架构方向是合理且已经比较收敛的：

```text
Stable Core
+ generic Control Plane
+ generic Web
+ per-channel Definition
+ isolated upstream driver
+ credential seam
+ compatibility manifest
```

这次核验最重要的不是再拆包，而是把 **“权限与 live verification”** 做成真正的一等治理对象。

优先顺序：

1. 保持 `channel-web` 不展示静态 permission 状态；恢复前先实现真实 permission checker
2. QQ 用真实 App 完成最小 intents live gate
3. Telegram 完成 Bot API 10.2 Rich Message 真实 live gate
4. Weixin 完成真实 iLink live gate 并 pin version/commit
5. Lark 把真实平台 permission/event/API 要求整理成机器可读 metadata，未来再接真实 permission checker；DingTalk mention activation 已接入但仍需 live gate

详细矩阵与官方来源见 `references/`。


---

# Reference: Channel Matrix

# Channel Matrix — dsh-channels

Snapshot: `main@78655a40a266c4122ecd0c030b0a882fdb92f2df` (2026-08-19)

## 1. Capability matrix

| Capability | Weixin | QQ | DingTalk | Lark | Telegram |
|---|---:|---:|---:|---:|---:|
| text | ✅ | ✅ | ✅ | ✅ | ✅ |
| image | ✅ | ✅ | ✅ | ✅ | ✅ |
| file | ❌ outbound | ✅ | ✅ | ✅ | ✅ |
| audio | ❌ | ✅ | ✅ | ✅ | ✅ |
| video | ❌ | ✅ | ❌ | ❌ | ✅ |
| markdown | ❌ | conditional | ✅ | ✅ | ❌ |
| cards | ❌ | ❌ | ✅ | ✅ | ❌ |
| reactions | ❌ | ❌ | ❌ | ✅ | ❌ |
| threads | ❌ | ❌ | ❌ | ✅ | ✅ |
| group @ activation | ❌ (no groups) | ✅ | ✅ (`isInAtList`) | ⚠️ raw `mentions[]`, bot identity pending | ✅ |
| streaming | buffered | C2C native / else buffered | edit | edit | edit |

> Capability 以 `adapter.ts` 为实现事实。协议参考能做但 DSH 没实现的能力不能写成支持。

## 2. Setup / auth matrix

### Weixin

**ChannelDefinition**

```text
fields: []
authMethods: [qr]
autoStart: true
```

**Config**

```text
enabled
accountId
ilink.baseUrl
ilink.cdnBaseUrl
ilink.botAgent?
network.timeoutMs
network.longPollTimeoutMs
reconnect.enabled
reconnect.baseDelayMs
reconnect.maxDelayMs
```

**Credential**

```text
SecretStore:
  weixin:token:<accountId>

ChannelStorage:
  weixin:credential:<accountId>
    ilinkBotId
    userId?
    baseUrl
    savedAt
```

**Auth flow**

```text
begin QR
→ waiting scan
→ optional verification code
→ confirm
→ persist ilink token + metadata
→ start monitor
```

### QQ

**ChannelDefinition**

```text
appId       text
appSecret   secret
authMethods: [credentials]
```

**Config**

```text
enabled
accountId
appId
appSecretRef = QQBOT_APP_SECRET
markdownSupport = false
streaming.enabled = true
streaming.throttleMs = 500 (min 300)
dedup.enabled = true
dedup.windowMs = 5000
startupTimeoutMs = 15000
```

### DingTalk

**ChannelDefinition**

```text
clientId      text
clientSecret  secret
authMethods: [device, credentials]
```

**Config**

```text
enabled = true
accountId = main
baseUrl = http://127.0.0.1:9100
timeoutMs = 30000
longPollTimeoutMs = 25000
reconnect.enabled = true
reconnect.baseDelayMs = 1000
reconnect.maxDelayMs = 30000
reconnect.maxRetries = 10
dedup.enabled = true
dedup.windowMs = 5000
card.createOnFirstDelta = true
upstream.mode = sdk
upstream.clientId?
upstream.clientSecretRef = DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET
```

Deprecated migration-only:

```text
upstream.clientSecret
```

### Lark / Feishu

**ChannelDefinition**

```text
appId       text
appSecret   secret
authMethods: [credentials, hybrid]
```

`hybrid` 当前要求先配置 `appId + appSecret`。

**Config**

```text
enabled = true
accountId = main
timeoutMs = 30000
reconnect.enabled = true
reconnect.baseDelayMs = 1000
reconnect.maxDelayMs = 30000
reconnect.maxRetries = 10
dedup.enabled = true
dedup.windowMs = 5000
card.createOnFirstDelta = true
card.typingIndicator = true
upstream.mode = sdk          # fixed literal — the official SDK is the only upstream driver
upstream.appId?
upstream.appSecretRef = DSH_CHANNEL_LARK_MAIN_APP_SECRET
upstream.domain = feishu
```

Fail-closed config governance:

```text
upstream.mode: 'gateway'    → rejected (fails config validation, mode is a fixed 'sdk' literal)
upstream.appSecret          → not part of the config schema; the secret is resolved only via
                              upstream.appSecretRef from ctx.credentials (no plaintext field,
                              no runtime migration)
```

### Telegram

**ChannelDefinition**

```text
token  secret
authMethods: [credentials]
setupUrl: https://t.me/BotFather
```

**Config**

```text
enabled = true
accountId = main
baseUrl = https://api.telegram.org
tokenRef = TELEGRAM_BOT_TOKEN
timeoutMs = 30000
longPollTimeoutMs = 25000
reconnect.enabled = true
reconnect.baseDelayMs = 1000
reconnect.maxDelayMs = 30000
reconnect.maxRetries = 10
dedup.enabled = true
dedup.windowMs = 5000
streaming.enabled = true
streaming.placeholder = …
maxDownloadBytes = 20 MiB
```

Deprecated migration-only:

```text
token
```

## 3. Upstream / plugin matrix

| Channel | Strategy | Upstream / SDK | DSH tested baseline | DSH status |
|---|---|---|---|---|
| Weixin | source-port | `Tencent/openclaw-weixin` / `@tencent-weixin/openclaw-weixin` | live pin pending; fixtures `2.4.6` | experimental |
| QQ | sdk | `@tencent-connect/qqbot-nodejs` | `1.0.4` | tested |
| DingTalk | sdk | `dingtalk-stream` | `2.1.5` | tested |
| Lark | sdk | `@larksuiteoapi/node-sdk` | `1.73.1` | tested |
| Telegram | source/direct HTTP | Telegram Bot API | `>=10.2` | experimental |

## 4. Actual interface surface

### Weixin

```text
QR:
  beginQrAuth
  pollQrAuth
  submitVerifyCode

Protocol:
  ilink/bot/getupdates
  ilink/bot/sendmessage
  ilink/bot/getuploadurl
  getconfig
  sendtyping

DSH port:
  startMonitor
  stopMonitor
  sendText
  sendImage
  sendFile       # concrete implementation currently unsupported
  downloadImage
  downloadFile
```

### QQ

DSH wrapper calls official SDK:

```text
QQBot.start / stop
on ready
on resumed
on error
on message
sendText
sendMedia
openStream
```

SDK auth/platform:

```text
AppID
AppSecret
WebSocket default
Token prefetch sync
```

### DingTalk

```text
Stream SDK inbound

POST /v1.0/oauth2/accessToken
sessionWebhook reply
POST /v1.0/robot/groupMessages/send
POST /v1.0/robot/oToMessages/batchSend
POST https://oapi.dingtalk.com/media/upload
POST /v1.0/robot/messageFiles/download
POST /v1.0/card/instances
POST /v1.0/card/instances/deliver
PUT  /v1.0/card/streaming
```

### Lark

```text
WS long connection (official SDK WSClient + EventDispatcher):
  im.message.receive_v1
  card.action.trigger

OpenAPI (official SDK Client):
  im.v1.message.create
  im.v1.message.patch            # rewrite an already-sent interactive card
  im.v1.chat.get                 # card-action chat mode confirmation
  im.v1.image.create
  im.v1.file.create
  im.v1.messageResource.get      # inbound resource download (media port)

CardKit 2.0 (native streaming + card entities):
  cardkit.v1.card.create         # Card JSON 2.0 entity
  cardkit.v1.card.settings       # close streaming_mode + summary
  cardkit.v1.cardElement.content # native "typewriter" stream update

Optional typing:
  addReaction
  removeReaction
```

### Telegram

```text
getMe
deleteWebhook
getUpdates
sendMessage
editMessageText
getFile
/file/bot<token>/<file_path>
sendPhoto
sendDocument
sendAudio
sendVideo
```

## 5. Permission matrix

### Lark

| Need | Platform id / action | Required |
|---|---|---|
| P2P receive | `im:message.p2p_msg:readonly` | core |
| Group @ receive | `im:message.group_at_msg:readonly` | core |
| Send as bot | `im:message:send_as_bot` | core |
| Event subscription | `im.message.receive_v1` + `card.action.trigger` | core + native buttons |
| Card action chat mode | `im.v1.chat.get` + current chat-read permission | native buttons, LIVE-REQUIRED |
| Image/file resources | current image/file resource upload permission | if media enabled |
| Message reaction | reaction permission | if typingIndicator enabled |
| All group messages | sensitive all-group-message permission | only if product requires non-@ messages |

### QQ

| Need | Permission / capability |
|---|---|
| Credentials | AppID + AppSecret |
| Group/C2C receive | `GROUP_AND_C2C` intent |
| Guild receive | `GUILDS` / `PUBLIC_GUILD_MESSAGES` as actually required |
| DM receive | `DIRECT_MESSAGE` as actually required |
| Interaction | `INTERACTION` only if used |
| Markdown | platform Markdown entitlement; `markdownSupport=true` only after granted |

**Current status**: DSH explicitly passes `GROUP_AND_C2C | INTERACTION` through
`QQ_MINIMAL_INTENTS`; live verification must confirm the target App is entitled to both.

### DingTalk

No generic scope id should be invented. Verify per current official API docs:

| Feature | Must verify |
|---|---|
| Stream receive | Robot capability + Stream mode/message callback |
| App token | ClientID/ClientSecret valid |
| reply | sessionWebhook usable |
| proactive group | robot group message API permission |
| proactive DM | robot O2O batch send API permission |
| media | media upload + messageFiles/download |
| card | card instance/delivery/streaming API permission |

### Telegram

No OAuth scope list.

| Feature | Must verify |
|---|---|
| auth | BotFather token valid |
| receive direct | bot can receive private chat |
| receive group | privacy mode / mention / command semantics |
| receive all group | bot privacy/admin configuration |
| send | bot is allowed in target chat |
| channel admin actions | corresponding admin right |
| long polling | webhook not active |

### Weixin

No reviewed official OAuth-style scope list.

| Feature | Must verify |
|---|---|
| auth | QR login returns iLink token |
| receive | real `getupdates` live |
| send text | real `sendmessage` live |
| image | `getuploadurl` + CDN + encrypted send live |
| typing | getconfig / sendtyping |
| file outbound | **DSH currently unsupported** |



---

# Reference: Official Sources

# Official / Authoritative Source Index

Snapshot checked: 2026-08-19.

## DSH repository

Repository:

- https://github.com/wsz987/dsh-channels
- Snapshot commit:
  https://github.com/wsz987/dsh-channels/commit/78655a40a266c4122ecd0c030b0a882fdb92f2df

Architecture/docs:

- https://github.com/wsz987/dsh-channels/blob/main/docs/architecture.md
- https://github.com/wsz987/dsh-channels/blob/main/docs/adapter-authoring.md

Control/Web:

- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-control/src/types.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-web/src/client/channelRegistry.ts

## DingTalk

DSH:

- https://github.com/wsz987/dsh-channels/tree/main/packages/channel-dingtalk
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-dingtalk/src/definition.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-dingtalk/src/config.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-dingtalk/src/manifest.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-dingtalk/src/official-upstream.ts

Official:

- DingTalk developer docs: https://open.dingtalk.com/document/
- DingTalk developer console: https://open-dev.dingtalk.com/
- Official Stream SDK:
  https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs

Verification rule:

- use official API page for the exact OpenAPI permission required by each endpoint
- do not use a third-party API mirror as permission truth

## Lark / Feishu

DSH:

- https://github.com/wsz987/dsh-channels/tree/main/packages/channel-lark
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-lark/src/definition.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-lark/src/config.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-lark/src/manifest.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-lark/src/openapi-outbound.ts

Official:

- Feishu Open Platform docs: https://open.feishu.cn/document/
- Feishu app console: https://open.feishu.cn/app
- Lark app console: https://open.larksuite.com/app
- Echo bot permission/event setup:
  https://open.feishu.cn/document/develop-an-echo-bot/faq
- Official Node SDK:
  https://github.com/larksuite/node-sdk

Known exact core permissions:

```text
im:message.p2p_msg:readonly
im:message.group_at_msg:readonly
im:message:send_as_bot
im.message.receive_v1
card.action.trigger
```

## QQ

DSH:

- https://github.com/wsz987/dsh-channels/tree/main/packages/channel-qq
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-qq/src/definition.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-qq/src/config.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-qq/src/manifest.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-qq/src/sdk-client.ts

Official Tencent SDK:

- https://github.com/tencent-connect/qqbot-nodejs
- QQBot options:
  https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/QQBot.ts
- Gateway intents:
  https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/gateway/constants.ts

Platform:

- https://q.qq.com/qqbot/
- DSH current setup deep-link base:
  https://q.qq.com/qqbot/openclaw/

Intent constants currently exposed by official SDK:

```text
GUILDS
GUILD_MEMBERS
PUBLIC_GUILD_MESSAGES
DIRECT_MESSAGE
GROUP_AND_C2C
INTERACTION
```

## Telegram

DSH:

- https://github.com/wsz987/dsh-channels/tree/main/packages/channel-telegram
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-telegram/src/definition.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-telegram/src/config.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-telegram/src/manifest.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-telegram/src/upstream.ts

Official:

- Bot API: https://core.telegram.org/bots/api
- Bots introduction: https://core.telegram.org/bots
- Bot FAQ: https://core.telegram.org/bots/faq
- Bot creation/config: https://t.me/BotFather

Current platform drift observed:

```text
DSH manifest testedVersion: 10.2
DSH minimum versionRange: >=10.2
Telegram Bot API current as of 2026-07-14: 10.2
```

## Weixin

DSH:

- https://github.com/wsz987/dsh-channels/tree/main/packages/channel-weixin
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-weixin/src/definition.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-weixin/src/config.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-weixin/src/manifest.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-weixin/src/upstream/port.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-weixin/src/upstream/tencent-upstream.ts
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-weixin/src/auth/account-store.ts

Tencent official source reference:

- https://github.com/Tencent/openclaw-weixin
- Backend API implementation:
  https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts
- Protocol types:
  https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts

Protocol auth observed in Tencent reference:

```text
AuthorizationType: ilink_bot_token
Authorization: Bearer <token>
X-WECHAT-UIN: <base64 random uint32>
```

Protocol endpoints documented by Tencent:

```text
getupdates
sendmessage
getuploadurl
getconfig
sendtyping
```

Important:

- DSH runtime does NOT depend on OpenClaw.
- `Tencent/openclaw-weixin` is source/behavior reference for the DSH source-port.
- DSH `sendFile` is still unsupported even if Tencent's reference protocol can represent a file.


---

# Reference: Audit Checklist

# Audit Checklist

Use this as a deterministic verification checklist.

## A. Repository snapshot

- [ ] Confirm repo URL.
- [ ] Confirm default/target branch.
- [ ] Record current HEAD SHA.
- [ ] Record commit date.
- [ ] Compare HEAD with Skill snapshot.
- [ ] Read latest architecture docs.

## B. ChannelDefinition

For each target channel:

- [ ] Read `definition.ts`.
- [ ] Enumerate setup fields.
- [ ] Mark text vs secret.
- [ ] Record authMethods.
- [ ] Record setupUrl.
- [ ] Record autoStart.
- [ ] Confirm secret refs never cross browser boundary.
- [ ] Confirm configured state never returns secret values.

## C. Config

- [ ] Read `config.ts`.
- [ ] Enumerate every user-facing field.
- [ ] Record defaults.
- [ ] Record hidden/deprecated plaintext migration fields.
- [ ] Record credential ref defaults.
- [ ] Confirm saveConfig cannot write real secret values.

## D. Adapter capability

- [ ] Read `adapter.ts`.
- [ ] Record text/image/file/audio/video.
- [ ] Record markdown/cards/reactions/threads.
- [ ] Record streaming mode.
- [ ] Check target-dependent capability overrides.
- [ ] Ensure protocol capability is not mistaken for DSH implemented capability.

## E. Actual platform interface

- [ ] Trace inbound API.
- [ ] Trace outbound text API.
- [ ] Trace media upload/download.
- [ ] Trace card/edit/streaming.
- [ ] Trace typing/reaction.
- [ ] Trace proactive send.
- [ ] Trace auth/token acquisition.

## F. Platform permission

- [ ] Open current official docs.
- [ ] Identify exact scope/intent/admin right for every used API.
- [ ] Identify event subscriptions separately from API permissions.
- [ ] Identify bot/app capabilities separately from scopes.
- [ ] Mark sensitive permissions.
- [ ] Mark permissions that require app publish/review.
- [ ] Mark runtime-only/live checks.

## G. Web UI

- [ ] Compare `channelRegistry.ts`.
- [ ] Compare ChannelDefinition setup fields.
- [ ] Validate docsUrl.
- [ ] Validate field labels.
- [ ] Validate auth prerequisites.
- [ ] Ensure static requirement UI is not displayed as a live “granted” result.
- [ ] Unknown channel must still use generic fallback.

## H. Manifest/upstream

- [ ] Read `manifest.ts`.
- [ ] Compare upstream reference.
- [ ] Compare SDK package.
- [ ] Compare testedVersion.
- [ ] Compare versionRange.
- [ ] Compare current official package/protocol version.
- [ ] Review changelog/source before bump.
- [ ] Do not auto-upgrade latest.
- [ ] Update fixtures.
- [ ] Run offline tests.
- [ ] Run live gate.
- [ ] Update status only after evidence exists.

## I. Mandatory known checks (snapshot 2026-08-19)

- [x] QQ: DSH explicitly uses `QQ_MINIMAL_INTENTS`; it does not rely on SDK `FULL_INTENTS`.
- [ ] QQ: `markdownSupport=true` only when platform permission exists.
- [ ] QQ: verify the inline-keyboard (`msg_type=2` + `keyboard`) click round-trip on a real App.
- [x] Telegram: align manifest and fixtures to Bot API 10.2; live gate remains pending.
- [x] Telegram: document that polling startup deletes an existing webhook.
- [x] Telegram: validate media Bot API envelopes before reporting delivery.
- [x] Telegram: replace raw message/update casts with zod trust-boundary parsing.
- [x] Telegram: fail closed for callback queries without `message.chat`.
- [ ] Weixin: keep file outbound unsupported until concrete upstream supports it.
- [ ] Weixin: replace pending live version/commit after real gate.
- [ ] Weixin: do not treat `channels.weixin.qq.com` as iLink protocol documentation.
- [ ] Lark: verify three core scopes + `im.message.receive_v1`.
- [ ] Lark: verify media/reaction permissions when those features are enabled.
- [ ] Lark: run the L1-L5 live gate in §6.1 before claiming live-tested.
- [x] DingTalk: `interactiveActions` is fail-closed (no default template id); a failed card send degrades to numbered text.
- [ ] DingTalk: verify each proactive/media/card OpenAPI permission, not only Stream receive.
- [ ] DingTalk: verify whether `interactiveCards/send` honors `callbackType` and whether a card click returns on the STREAM callback topic.
- [ ] All: secrets must remain in credential/secrets seam.
