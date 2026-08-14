# @wsz987/dsh-channels

DeepSeek Harness **DSH Bundle** — official messaging channels:

- Weixin / 微信
- QQ Bot
- DingTalk / 钉钉
- Lark / Feishu / 飞书

## Install

```bash
dsh plugin --profile default add @wsz987/dsh-channels
```

The bundle patch (`cordis.patch.yml`) inserts the `ChannelService`
(`@wsz987/channel-core`), the Harness bridge (`@wsz987/channel-harness`) and the
four channel adapters. Every channel can be disabled through its plugin
config.

## Individual adapters

Advanced users may install a single adapter:

```bash
dsh plugin --profile minimal add @wsz987/channel-weixin
```

## Architecture

```
Messaging Platform
      │
      ▼
Upstream Driver
      │
      ▼
Channel Adapter (channel-weixin/qq/dingtalk/lark)
      │
      ▼
ChannelService (Cordis Service, ctx.channels)
      │
      ▼
Harness Bridge (channel-harness)
      │
      ▼
DeepSeek Harness Agent / Session
```

- Adapters never touch `ctx.agents`.
- The Harness bridge is the only place allowed to import Harness public APIs.
- Replies flow from `session/event` back through the bridge to the adapters.
