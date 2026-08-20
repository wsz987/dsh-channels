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
