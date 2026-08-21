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
| Telegram | source/direct HTTP + official types | Telegram Bot API / `@grammyjs/types` | `>=10.2` | experimental |

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
