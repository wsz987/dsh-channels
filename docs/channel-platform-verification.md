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
---

# DSH Channels Verification Skill

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
| QQ | `@wsz987/channel-qq` | Tencent 官方 SDK | `@tencent-connect/qqbot-nodejs@1.0.4` | `tested`* | AppID + AppSecret | text/image/file/audio/video；C2C native stream |
| DingTalk | `@wsz987/channel-dingtalk` | 官方 Stream SDK + OpenAPI | `dingtalk-stream@2.1.5` | `tested`* | ClientID + ClientSecret；device/credentials | text/image/file/audio/cards；edit stream |
| Lark/Feishu | `@wsz987/channel-lark` | 官方 Node SDK | `@larksuiteoapi/node-sdk@1.73.0` | `tested`* | AppID + AppSecret；credentials/hybrid | text/image/file/audio/cards/reactions/threads；edit stream |
| Telegram | `@wsz987/channel-telegram` | Bot API HTTP 直连 | manifest `Bot API 7.10` | `experimental` | Bot token | text/image/file/audio/video/threads；edit stream |

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

## 5. channel-web 权限面板：必须正确理解

当前：

```text
packages/channel-web/src/client/channelRegistry.ts
packages/channel-web/src/client/ChannelPermissions.tsx
```

中的 `permissions.items` 是**静态 presentation metadata**。

当前 UI metadata：

| 渠道 | UI permission id |
|---|---|
| Weixin | `message.receive`, `message.send` |
| QQ | `message.receive`, `message.send` |
| DingTalk | `message.receive`, `message.send` |
| Lark | `im.message.read`, `im.message.write` |
| Telegram | `message.receive`, `message.send` |

### 禁止错误推论

看到 UI：

```text
✓ 接收消息（必需）
✓ 发送消息（必需）
```

**不能**推导：

```text
平台权限已经检测成功
平台 scope 已开通
Bot intents 已放行
App 已发布
真实消息一定可以收发
```

当前 `ChannelPermissions.tsx` 没有平台 permission probe。

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
```

当前实现还使用：

```text
im.v1.image.create
im.v1.file.create
im.v1.message.patch
message reaction add/remove（Typing）
```

因此继续核验：

- 图片/文件资源上传权限
- 卡片/消息 patch 所需权限
- `card.typingIndicator=true` 时 reaction 相关权限
- 如果产品需要群聊中“非 @ 消息”，需申请对应的敏感“群组全部消息”权限，而不是只依赖 `group_at_msg`

权限或事件修改后还要核验应用版本是否已发布生效。

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

**当前 DSH 风险点**：

```ts
new QQBot({
  appId,
  appSecret,
  accountId,
  markdownSupport,
  transport: 'websocket',
  tokenPrefetch: 'sync',
  // 没有显式传 intents
})
```

腾讯 SDK 在未指定时默认 `FULL_INTENTS`。

这会导致：

- DSH 实际只监听主要 `message` 事件，却可能申请更多 intents
- App 未被允许这些 intents 时，Gateway 可能返回：
  - `4914 INSUFFICIENT_INTENTS`
  - `4915 DISALLOWED_INTENTS`

**建议 P1 修复**：让 QQ adapter 明确声明最小 intents，或做 DSH-side configurable intent mask，不再依赖 SDK `FULL_INTENTS` 默认值。

另外：

- `markdownSupport=true` 只能在 QQ Bot 已获得 Markdown 平台权限时开启
- C2C 原生 `stream_messages` 只适合当前代码的 C2C + reply message id 场景
- 群聊当前走 buffered send，不应误标为 native streaming

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
- POST /v1.0/card/instances
- POST /v1.0/card/instances/deliver
- PUT  /v1.0/card/streaming
```

核验平台时不能只验证 Stream 可以收消息，还必须逐项验证：

- 主动群消息
- 主动单聊消息
- media upload/download
- AI Card create/deliver/streaming

具体 OpenAPI 权限名称以**当次官方 API 文档的“权限要求”**为准，不要从旧博客或第三方镜像猜名字。

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
getUpdates allowed_updates=['message']
```

因此：

- webhook 与 long poll 不应同时作为 active update receiver
- 群聊如果开启 Privacy Mode，Bot 不会自动看到所有普通群消息
- 如果产品目标是“所有群消息都进入 Agent”，必须显式核验 BotFather privacy / 管理员状态
- 当前 20 MiB inbound download cap 与 Telegram cloud Bot API `getFile` 的 20 MB 下载限制对齐

**DRIFT**：仓库 manifest 仍写 `Telegram Bot API 7.10`，而 2026-07-14 官方已发布 **Bot API 10.2**。当前实现使用的基础 API 仍可能兼容，但发布前必须重新做 API drift + live gate，不应继续把 7.10 当作当前平台版本。

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

### P0 — 不要把静态权限 UI 当成权限检测

`channel-web` 当前 permission ✓ 是静态渲染。

发布文案应避免让用户误以为“已授权”。

推荐 UI 状态至少区分：

```text
Required（需求说明）
Unknown（尚未检测）
Granted（真实检测）
Missing（真实检测失败）
```

### P1 — QQ intents 应最小化

当前 DSH 没传 `intents`，官方 SDK 默认 `FULL_INTENTS`。

建议：

```text
DSH 当前使用什么事件
    ↓
计算最小 intent mask
    ↓
显式传入 QQBot
```

而不是请求所有 intents。

### P1 — Telegram manifest 严重落后于当前 Bot API

```text
DSH manifest: 7.10
官方当前:     10.2 (2026-07-14)
```

优先执行：

1. API breaking/change review
2. fixture 更新
3. offline test
4. real bot live verification
5. 再更新 `testedVersion/versionRange/status`

### P1 — Weixin live pin 尚未完成

当前：

```text
testedVersion = <pending-live-verification>
testedCommit  = <pending-live-verification>
versionRange  = *
status        = experimental
```

Tencent 官方 `openclaw-weixin` 参考协议存在，但 DSH 是 source-port，必须通过真实 iLink gate 后再升级状态。

### P2 — Weixin channel-web docsUrl 不适合作为 iLink 协议核验入口

当前 registry 指向：

```text
https://channels.weixin.qq.com/
```

这不是当前 DSH iLink source-port 的协议/开发参考。

后续应优先链接：

```text
https://github.com/Tencent/openclaw-weixin
```

或腾讯未来发布的正式 host-neutral iLink 开发文档。

### P2 — Lark UI permission ids 过于抽象

当前 registry：

```text
im.message.read
im.message.write
```

平台真实权限至少应映射到：

```text
im:message.p2p_msg:readonly
im:message.group_at_msg:readonly
im:message:send_as_bot
+ im.message.receive_v1
```

如果 UI 继续只做说明，应明确叫“能力需求”；如果未来做检测，则必须保存真实 platform scope/event ids。

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

1. 修正/重命名 `channel-web` 静态 permission 展示语义
2. QQ 显式最小 intents
3. Telegram 从 Bot API 7.10 基线升级核验到当前 10.2
4. Weixin 完成真实 iLink live gate 并 pin version/commit
5. Lark/DingTalk 把真实平台 permission/event/API 要求整理成机器可读 metadata，未来再接真实 permission checker

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
baseUrl = http://127.0.0.1:9300
timeoutMs = 30000
longPollTimeoutMs = 25000
reconnect.enabled = true
reconnect.baseDelayMs = 1000
reconnect.maxDelayMs = 30000
reconnect.maxRetries = 10
dedup.enabled = true
dedup.windowMs = 5000
card.createOnFirstDelta = true
card.typingIndicator = true
upstream.mode = sdk
upstream.appId?
upstream.appSecretRef = DSH_CHANNEL_LARK_MAIN_APP_SECRET
upstream.domain = feishu
```

Deprecated migration-only:

```text
upstream.appSecret
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
| Lark | sdk | `@larksuiteoapi/node-sdk` | `1.73.0` | tested |
| Telegram | source/direct HTTP | Telegram Bot API | `7.10` | experimental |

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
WS long connection:
  im.message.receive_v1

OpenAPI:
  im.v1.message.create
  im.v1.message.patch
  im.v1.image.create
  im.v1.file.create

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
| Event subscription | `im.message.receive_v1` | core |
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

**Current issue**: SDK default is `FULL_INTENTS` because DSH does not pass `intents`.

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
- https://github.com/wsz987/dsh-channels/blob/main/packages/channel-web/src/client/ChannelPermissions.tsx

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
DSH manifest testedVersion: 7.10
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

- [ ] QQ: verify DSH does not accidentally rely on SDK `FULL_INTENTS`.
- [ ] QQ: `markdownSupport=true` only when platform permission exists.
- [ ] Telegram: review drift from manifest 7.10 to official Bot API 10.2.
- [ ] Telegram: verify webhook disabled before long polling.
- [ ] Weixin: keep file outbound unsupported until concrete upstream supports it.
- [ ] Weixin: replace pending live version/commit after real gate.
- [ ] Weixin: do not treat `channels.weixin.qq.com` as iLink protocol documentation.
- [ ] Lark: verify three core scopes + `im.message.receive_v1`.
- [ ] Lark: verify media/reaction permissions when those features are enabled.
- [ ] DingTalk: verify each proactive/media/card OpenAPI permission, not only Stream receive.
- [ ] All: secrets must remain in credential/secrets seam.
