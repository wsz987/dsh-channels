# dsh-channels 发布前修正与最终验收执行计划

> 项目：`https://github.com/wsz987/dsh-channels`  
> 目标：在现有 M0–M5 已完成基础上，完成发布前架构收口、官方渠道链路校正、CI 门禁闭环与真实平台验收，使项目状态从 **Implementation Complete** 提升为 **Release Verified**。  
> 基准：DeepSeek Harness 官方开发文档与当前官方仓库实现、各渠道官方 SDK / 官方插件实现。  
> 日期：2026-08-14

---

## 1. 当前结论

当前项目主体架构已经完成，以下核心设计可继续保留，不需要大规模重构：

- `Channel Contract`
- `ChannelService`
- `ChannelAdapter`
- `channel-harness`
- `AgentManager`
- `HarnessAgentGateway`
- `ReplyRouter`
- `SessionBinding`
- `ReplyContext`
- transactional adapter mount
- compatibility manifest
- `channels doctor`
- `channel-testkit`
- `channel-verify`
- DSH bundle / `cordis.patch.yml`
- QQ / Weixin / DingTalk / Lark 四个渠道主体实现

当前剩余问题主要集中在：

1. CI 的 `channel-verify` 门禁没有真正闭环。
2. DingTalk Stream 模式缺少官方 ACK。
3. QQ 没有完全使用统一 Channel runtime resources。
4. Lark 仍是低层 SDK + 自建 outbound gateway，且媒体未真正进入 Harness attachment。
5. DingTalk / Lark 的 `sdk` 模式仍然依赖本地 HTTP gateway 做出站。
6. Weixin 真实 live verification 尚未完成。
7. compatibility manifest 中部分 `versionRange: '*'` 过宽。

本计划不重新设计架构，只做 **发布前收口**。

---

# 2. 最终目标

完成后应达到以下状态：

```text
Messaging Platform
        ↓
Official SDK / Official Protocol
        ↓
Platform Driver
        ↓
ChannelAdapter
        ↓
ChannelService
        ↓
channel-harness
        ↓
ctx.agents
        ↓
Harness Session / Agent
        ↓
session/event
        ↓
ReplyRouter
        ↓
ReplyHandle
        ↓
Official SDK / Official OpenAPI
        ↓
Messaging Platform
```

并满足：

```text
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm check:fixtures
pnpm check:manifests
pnpm doctor
pnpm check:bundle
pnpm verify ./packages/channel-telegram --test
pnpm verify ./packages/channel-weixin --test
```

全部通过。

最终 `main`：

```text
Build + typecheck   PASS
Test                PASS
Governance          PASS
Live gates          PASS / 明确标记 Experimental
```

---

# 3. 优先级

| 优先级 | 项目 | 是否阻断发布 |
|---|---|---|
| P0 | 修复 CI verify CLI 构建链 | 是 |
| P0 | DingTalk Stream ACK | 是 |
| P0 | Weixin live verification / 明确实验状态 | 是 |
| P1 | QQ 统一 AdapterContext | 否，但必须收口 |
| P1 | Lark media → Harness attachment | 建议 |
| P1 | Lark domain 配置化 | 建议 |
| P1 | DingTalk/Lark sdk 模式消除隐式 localhost gateway | 建议 |
| P2 | Lark 高层 Channel SDK 评估/迁移 | 否 |
| P2 | Weixin source-port drift 对齐 | 否 |
| P2 | compatibility versionRange 收紧 | 发布前建议完成 |

---

# 4. Phase R0 — 固定验收基线

## R0.1 固定当前依赖版本

确认以下依赖继续被 lockfile 固定：

```text
@tencent-connect/qqbot-nodejs
dingtalk-stream
@larksuiteoapi/node-sdk

@deepseek-ai/cordis
@deepseek-ai/dsh-agent
@deepseek-ai/dsh-session
@deepseek-ai/dsh-llm
@deepseek-ai/dsh-attachment
...
```

要求：

- 不在本轮顺手升级 Harness。
- 不同时做大版本升级与渠道修复。
- 保持当前 Harness pinned contract。
- 修复完成后再单独做 dependency upgrade PR。

### 验收

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
```

全部通过。

---

# 5. Phase R1 — 修复 CI 发布门禁

## 问题

当前 CI：

```yaml
- run: pnpm test
- run: pnpm verify ./packages/channel-telegram --test
```

但是 `@dsh/channel-verify` 的执行入口是：

```json
"verify": "node lib/cli.js"
```

`pnpm test` 不保证：

```text
packages/channel-verify/lib/cli.js
```

存在。

因此当前 `main` CI 红灯属于 CI 编排问题。

---

## R1.1 显式构建 channel-verify

推荐修改：

```yaml
- name: Build verify CLI
  run: pnpm --filter @dsh/channel-verify build

- name: Verify Telegram adapter
  run: pnpm verify ./packages/channel-telegram --test

- name: Verify Weixin adapter
  run: pnpm verify ./packages/channel-weixin --test
```

不要依赖 turbo 的隐式依赖构建副作用。

---

## R1.2 增加 CLI 自身 smoke test

新增：

```text
packages/channel-verify/test/cli-built.test.ts
```

至少覆盖：

```text
lib/cli.js exists after build
CLI can boot
healthy adapter returns 0
broken adapter returns 1
```

---

## R1.3 CI 顺序固定

建议 Test job：

```text
pnpm install --frozen-lockfile
        ↓
pnpm test
        ↓
pnpm --filter @dsh/channel-verify build
        ↓
pnpm verify telegram
        ↓
pnpm verify weixin
```

### 验收

GitHub Actions：

```text
Build + typecheck                  PASS
Test                               PASS
Governance                         PASS
Verify Telegram adapter            PASS
Verify Weixin adapter              PASS
```

---

# 6. Phase R2 — DingTalk Stream ACK 修复

## 问题

当前：

```text
DWClient
  ↓
registerCallbackListener(TOPIC_ROBOT)
  ↓
onMessage
  ↓
Channel inbound
```

但是没有调用：

```ts
client.socketCallBackResponse(...)
```

官方 SDK 的 Robot Stream 模式需要在处理后对 `messageId` 做 callback response。

否则平台可能重投。

当前 dedup 默认约：

```text
5 秒
```

平台重试可能远晚于 dedup window，因此同一消息可能再次进入 Harness。

---

## R2.1 扩展 DingTalkStreamClient port

当前接口增加：

```ts
export interface DingTalkStreamClient {
  connect(): Promise<void>;
  disconnect(): void;

  registerCallbackListener(
    topic: string,
    callback: (message: DingTalkStreamMessage) => void | Promise<void>,
  ): unknown;

  socketCallBackResponse(
    messageId: string,
    response: unknown,
  ): void;
}
```

Fake client 同时实现。

---

## R2.2 callback 改为 async

从：

```ts
registerCallbackListener(TOPIC_ROBOT, (message) => {
  ...
})
```

调整为：

```ts
registerCallbackListener(TOPIC_ROBOT, async (message) => {
  ...
})
```

---

## R2.3 ACK 时机

建议语义：

```text
平台收到消息
    ↓
解析成功
    ↓
成功提交到 Channel inbound pipeline
    ↓
ACK
```

不要等待整个 LLM turn 完成再 ACK。

ACK 代表：

```text
“消息已被本地系统可靠接收”
```

不是：

```text
“LLM 已经回答完成”
```

---

## R2.4 ACK response

封装：

```ts
function ackRobotMessage(
  client: DingTalkStreamClient,
  message: DingTalkStreamMessage,
): void {
  const messageId = message.headers?.messageId;
  if (!messageId) return;

  client.socketCallBackResponse(messageId, {
    success: true,
  });
}
```

具体 response shape 以当前官方 SDK 版本实际类型为准。

---

## R2.5 ACK 测试

新增：

```text
stream-upstream.test.ts
```

覆盖：

### Case 1

```text
valid robot message
→ inbound exactly once
→ ACK exactly once
```

### Case 2

```text
invalid JSON
→ no inbound
→ ACK policy 明确
```

推荐：

```text
格式完全非法：
不 ACK，让平台重试 / 进入错误观测
```

或者如果确定属于不可恢复 payload：

```text
ACK + structured error log
```

必须明确一种策略。

### Case 3

```text
same message delivered twice
→ dedup remains second layer
```

---

## R2.6 明确 SDK 与 Adapter 的重连责任

注意官方 `DWClient` 自己已经具备 auto reconnect。

当前 Adapter 又有：

```text
runReceiveLoop()
exponential backoff
```

需要避免：

```text
SDK auto reconnect
+
Adapter reconnect
```

形成双重重连状态机。

推荐二选一：

### 方案 A：官方 SDK 拥有 WS 重连

```text
DWClient.autoReconnect = true
Adapter 不重复做 WS 级 reconnect
```

推荐。

### 方案 B：Adapter 拥有重连

```text
DWClient.autoReconnect = false
Adapter reconnect loop
```

不要双层同时工作。

---

## R2 验收

必须新增真实行为测试：

```text
message received
→ ChannelEvent emitted
→ callback ACK sent
→ repeated delivery does not create duplicate turn
```

---

# 7. Phase R3 — QQ runtime resources 收口

## 问题

`channel-core` 已提供：

```ts
ctx.channels.createAdapterContext(...)
```

统一生成：

```text
logger
emit
secrets
storage
signal
```

其他 Adapter 已采用。

QQ 当前仍手工：

```ts
{
  emit,
  logger,
  secrets: new MemorySecretStore(),
  storage: new MemoryStorage(),
  signal,
}
```

这会绕过统一持久化资源。

---

## R3.1 修改 QQ mount

改为：

```ts
mountChannelAdapter(
  ctx,
  adapter,
  (signal) =>
    ctx.channels.createAdapterContext({
      channelId: 'qq',
      signal,
    }),
);
```

QQ `appSecret` 继续通过：

```text
ctx.credentials.resolve(...)
```

获取。

不要把平台 AppSecret 移入 `ChannelSecretStore`。

这里两类 secret 要区分：

```text
Harness Credential
→ ctx.credentials

Channel runtime auth/session state
→ ctx.channels.resources.secrets
```

---

## R3.2 测试

新增：

```text
QQ adapter context uses ChannelService resources
```

确保：

```ts
ctx.channels.resources.storage
ctx.channels.resources.secrets
```

与 AdapterContext 中的是同一实例。

---

# 8. Phase R4 — Lark domain 配置化

## 问题

当前：

```ts
domain: Domain.Feishu
```

写死。

包名却是：

```text
channel-lark
```

需要支持：

```text
Feishu
Lark
custom domain
```

---

## R4.1 Config

增加：

```ts
export interface LarkUpstreamConfig {
  mode: 'sdk' | 'gateway';
  appId?: string;
  appSecret?: string;

  domain?: 'feishu' | 'lark' | string;
}
```

Schema：

```ts
domain: Schema.string().default('feishu')
```

---

## R4.2 domain resolver

```ts
function resolveDomain(value: string) {
  if (value === 'feishu') return Domain.Feishu;
  if (value === 'lark') return Domain.Lark;
  return value;
}
```

---

## R4.3 创建 client

```ts
new WSClient({
  appId,
  appSecret,
  domain: resolveDomain(config.upstream.domain),
})
```

---

## R4 验收

覆盖：

```text
feishu
lark
custom
```

三种配置。

---

# 9. Phase R5 — Lark 图片/媒体真正进入 Harness

## 问题

飞书 inbound：

```text
image_key
file_key
```

不是 URL。

当前流程：

```text
image_key
→ raw.picUrl
→ MessagePart.url
→ Harness converter
→ [image: img_xxx]
```

因此模型并没有真正收到图片。

---

## R5.1 Driver 层下载资源

SDK inbound 收到：

```text
image_key
file_key
```

后不要伪装成 URL。

建议扩充 internal raw：

```ts
{
  type: 'image',
  resourceKey: 'img_xxx',
  resourceType: 'image'
}
```

---

## R5.2 使用官方 SDK 获取媒体

优先考虑官方 Channel 模块：

```ts
channel.downloadResource(fileKey, 'image')
```

如果暂时不迁移高层 Channel，则使用官方 OpenAPI Client 下载。

---

## R5.3 映射为 localData

最终：

```ts
{
  type: 'image',
  localData: buffer,
  mimeType: 'image/png'
}
```

交给：

```text
channel-harness
→ saveImage()
→ Harness AttachmentStore
→ ImageBlock
```

---

## R5.4 文件 / 音频 / 视频

当前 Harness converter 对：

```text
file
audio
video
```

仍是文本 placeholder。

本轮至少要求：

```text
image 真正多模态
```

其余媒体：

```text
capability 必须与真实能力一致
```

如果仍不支持：

```ts
file/audio/video capability
```

不要过度宣称。

---

## R5 验收

真实 pipeline 测试：

```text
Lark image event
→ official resource download
→ MessagePart.localData
→ saveImage
→ Harness UserMessage ImageBlock
```

最终断言不能是：

```text
[image: img_xxx]
```

而要存在：

```ts
{
  type: 'image',
  attachment: ...
}
```

---

# 10. Phase R6 — Lark 官方 Channel 模块评估

这不是本轮强制阻断项，但建议立即做一个短期评估。

官方 SDK 当前已有：

```ts
createLarkChannel()
```

它已经负责：

```text
WS
Webhook
消息归一化
去重
stale 检测
策略
发送
media
streaming
card
reaction
资源下载
重连
```

当前项目自己维护：

```text
LarkSdkUpstream
mapper
InboundProcessor
dedup
HTTP gateway outbound
card streaming
```

存在重复实现。

---

## R6.1 不改 Channel Contract

必须保留：

```text
ChannelAdapter
ChannelService
channel-harness
ReplyRouter
```

只替换：

```text
Lark Platform Driver
```

---

## R6.2 新 Driver 形态

建议探索：

```text
LarkChannelDriver
    ↓
createLarkChannel()
```

Adapter 接收：

```text
message
cardAction
reaction
reconnecting
reconnected
error
```

再转成 Channel Contract。

---

## R6.3 迁移原则

只有满足以下条件才替换：

```text
现有 contract tests 全部复用
官方 Channel 可以完整覆盖现有能力
不会让 Channel Contract 反向依赖 Lark SDK 类型
```

否则暂时保留当前低层 SDK。

---

# 11. Phase R7 — DingTalk / Lark outbound 官方化

## 当前问题

两个 SDK 模式目前都是：

```text
Inbound → official SDK
Outbound → localhost gateway
```

配置默认甚至类似：

```text
http://127.0.0.1:xxxx
```

这样：

```text
upstream.mode = sdk
```

并不代表完整官方 SDK/OpenAPI 模式。

---

# 12. R7A — DingTalk outbound

目标：

```text
DingTalkStreamUpstream
    ↓ inbound
official dingtalk-stream

DingTalkOpenApiOutbound
    ↓ outbound
DingTalk official OpenAPI
```

不再默认依赖：

```text
/message/send
/card/create
/card/update
/card/finish
/card/fail
```

自建 gateway endpoint。

---

## R7A.1 Driver 分离

```ts
interface DingTalkInbound {}
interface DingTalkOutbound {}
```

或者保持现有 `DingTalkUpstream`，内部组合：

```ts
new DingTalkSdkUpstream({
  inbound: streamClient,
  outbound: openApiClient,
})
```

---

## R7A.2 gateway 保留方式

legacy gateway 可以保留：

```yaml
upstream:
  mode: gateway
```

但：

```yaml
upstream:
  mode: sdk
```

必须做到：

```text
无需 localhost gateway 即可运行
```

---

# 13. R7B — Lark outbound

建议官方化为：

```text
official Lark Channel
```

或：

```text
official Client OpenAPI
```

至少替换：

```text
/message/send
/card/create
/card/update
/card/finish
/card/fail
```

---

## R7B 验收

SDK 模式下启动时：

```text
不启动任何本地 gateway
不配置 baseUrl
```

仍可以完成：

```text
receive
send text
send image
stream reply
card
```

如果暂时不能完成，则配置语义必须改名，例如：

```text
mode: hybrid
```

不要继续叫纯 `sdk`。

---

# 14. Phase R8 — Weixin source-port drift 收口

## R8.1 X-WECHAT-UIN

当前默认使用：

```ts
Math.random()
```

建议跟腾讯官方实现对齐：

```ts
crypto.randomBytes(4).readUInt32BE(0)
```

测试继续保留可注入随机源。

推荐：

```ts
interface RandomUint32 {
  (): number;
}
```

production：

```ts
crypto.randomBytes(...)
```

test：

```ts
() => fixedValue
```

---

## R8.2 iLink-App-ClientVersion

当前：

```ts
clientVersionFromString('0.8.1')
```

改为从：

```text
package.json.version
```

动态得到。

例如：

```ts
import pkg from '../../package.json' with { type: 'json' };

clientVersionFromString(pkg.version)
```

---

## R8.3 bot_agent

对照腾讯官方：

```text
package version
bot_agent sanitize
长度限制
```

决定是否同步。

至少保证：

```text
DSH 自己的 bot_agent
```

不会产生协议非法值。

---

# 15. Phase R9 — Weixin Live Verification

这是 Weixin 从：

```text
experimental
```

升级到：

```text
tested
```

的唯一合法路径。

---

## R9.1 Live gate 必须验证

至少覆盖：

### 登录

```text
get_bot_qrcode
get_qrcode_status
token/baseurl persistence
```

### 消息接收

```text
getupdates
cursor persistence
restart replay
dedup
```

### 文本发送

```text
sendmessage
```

### 图片

```text
download
decrypt
Harness attachment
upload
send
```

### typing

```text
getconfig
sendtyping
start
stop
turn/end cleanup
```

### shutdown

```text
notifystop
abort long-poll
cursor saved
```

---

## R9.2 Manifest 更新

只有 live gate 完整通过后：

```ts
status: 'tested'
```

并写入真实值：

```ts
testedVersion: '<real version>'
testedCommit: '<real Tencent/openclaw-weixin commit SHA>'
versionRange: '<verified range>'
```

禁止保留：

```text
<pending-live-verification>
*
```

然后打 release。

---

# 16. Phase R10 — Compatibility manifest 收紧

当前建议：

## QQ

保持：

```text
testedVersion = 1.0.4
versionRange = 1.0.4
```

---

## DingTalk

当前：

```text
testedVersion = 2.1.5
versionRange = *
```

修为：

```text
versionRange = 2.1.5
```

等升级测试建立后再扩大。

---

## Lark

当前：

```text
testedVersion = 1.73.0
versionRange = *
```

修为：

```text
versionRange = 1.73.0
```

---

## Weixin

live gate 前：

```text
experimental
pending
```

live gate 后：

```text
testedCommit = exact SHA
versionRange = exact / verified range
```

---

# 17. Phase R11 — Capability Truthfulness

逐渠道核验：

```text
text
image
file
audio
video
markdown
cards
reactions
threads
streaming
```

规则：

> capability 表示“真实 E2E 可用”，不是“mapper 里认识这种类型”。

例如：

```text
Lark image
```

只有真正完成：

```text
file_key
→ download
→ attachment
→ model
```

才可以认为 inbound image E2E verified。

---

# 18. Phase R12 — Harness Boundary Scan

最终重新执行边界检查。

## Channel Adapter 禁止直接 import

```text
@deepseek-ai/dsh-agent
@deepseek-ai/dsh-session
@deepseek-ai/dsh-llm
```

这些只能存在于：

```text
channel-harness
```

或者明确允许的 bridge layer。

---

## Harness Bridge 禁止依赖平台 SDK

`channel-harness` 不应该 import：

```text
qqbot-nodejs
dingtalk-stream
larksuite sdk
weixin protocol
telegram
```

---

## Core 禁止平台知识

`channel-core` 不得出现：

```text
qq
weixin
lark
dingtalk
telegram
```

专有 payload shape。

---

# 19. Phase R13 — 测试矩阵

最终要求每个 Adapter 至少覆盖：

```text
Config
Mapper
Inbound
Outbound
Lifecycle
Auth
Health
Dedup
Error normalization
Credential leakage
Abort
Reconnect
Streaming
Mount rollback
Contract suite
Fixtures
E2E fake upstream
```

---

## DingTalk 追加

```text
ACK
duplicate after long interval
SDK reconnect ownership
```

---

## Lark 追加

```text
Feishu domain
Lark domain
custom domain
real image attachment
thread
card
```

---

## Weixin 追加

```text
live text
live QR
live image
cursor crash recovery
auth persistence
```

---

## QQ 追加

```text
shared runtime resources
```

---

# 20. Phase R14 — 最终 CI 结构

推荐：

```yaml
jobs:

  build:
    - install
    - build
    - typecheck

  test:
    - install
    - test
    - build channel-verify
    - verify telegram
    - verify weixin

  governance:
    - install
    - build bundle graph
    - check fixtures
    - check manifests
    - doctor
    - check bundle

  live-weixin:
    workflow_dispatch only
    secret gated

  live-dingtalk:
    workflow_dispatch only
    optional

  live-lark:
    workflow_dispatch only
    optional

  live-qq:
    workflow_dispatch only
    optional
```

---

# 21. 最终发布门禁

## Gate A — Static

```text
pnpm build
pnpm typecheck
```

PASS。

---

## Gate B — Offline

```text
pnpm test
```

PASS。

---

## Gate C — Compatibility

```text
pnpm check:fixtures
pnpm check:manifests
pnpm doctor
```

PASS。

---

## Gate D — Bundle

```text
pnpm check:bundle
```

PASS。

---

## Gate E — Extensibility

```text
pnpm verify ./packages/channel-telegram --test
```

PASS。

---

## Gate F — Official adapter

```text
pnpm verify ./packages/channel-weixin --test
```

PASS。

---

## Gate G — Platform reality

至少：

```text
Weixin live gate
```

PASS。

建议补：

```text
QQ
DingTalk
Lark
```

manual live smoke。

---

# 22. 最终完成定义

只有以下条件全部满足，才把项目标记为：

```text
Release Verified
```

而不是：

```text
Implementation Complete
```

要求：

- [ ] `main` CI 全绿
- [ ] verify CLI gate 全绿
- [ ] DingTalk ACK 已实现
- [ ] DingTalk 重复投递测试通过
- [ ] QQ 使用统一 `createAdapterContext`
- [ ] Lark domain 可配置
- [ ] Lark inbound image 真正进入 Harness ImageBlock
- [ ] SDK 模式不再隐式依赖 localhost gateway，或明确重命名为 hybrid
- [ ] Weixin live gate 通过
- [ ] Weixin manifest 写入真实 testedVersion / testedCommit
- [ ] DingTalk / Lark `versionRange: '*'` 收紧
- [ ] `channels doctor` 输出真实 compatibility 状态
- [ ] build / typecheck / test / governance / bundle / verify 全绿

---

# 23. 推荐实际执行顺序

不要并行乱改。

严格按以下顺序：

```text
R0 固定基线
 ↓
R1 CI verify 修复
 ↓
R2 DingTalk ACK
 ↓
R3 QQ AdapterContext 收口
 ↓
R4 Lark domain
 ↓
R5 Lark image attachment
 ↓
R8 Weixin source-port drift
 ↓
R9 Weixin live gate
 ↓
R10 manifest 收紧
 ↓
R7 DingTalk / Lark outbound 官方化
 ↓
R6 评估 Lark 高层 Channel 模块
 ↓
R12 边界扫描
 ↓
R13 全测试
 ↓
R14 CI
 ↓
Release Verified
```

其中：

```text
R1 + R2 + R9
```

属于发布最关键路径。

---

# 24. 建议拆分提交

建议保持每个问题单独 commit。

```text
fix(ci): build channel-verify before adapter verification

fix(channel-dingtalk): ack stream robot callbacks

test(channel-dingtalk): cover callback ack and delayed retry dedup

refactor(channel-qq): use shared channel adapter context

feat(channel-lark): make api domain configurable

feat(channel-lark): resolve inbound images into harness attachments

fix(channel-weixin): align ilink headers with official source

test(channel-weixin): complete live verification gate

chore(channel-compat): pin verified upstream ranges

refactor(channel-dingtalk): use official outbound openapi in sdk mode

refactor(channel-lark): replace gateway outbound with official sdk
```

不要合成一个超大 commit。

---

# 25. 不建议做的事情

本轮不要：

- 重写 Channel Contract。
- 删除 `channel-harness`。
- 让 Adapter 直接调用 `ctx.agents`。
- 把平台 payload 直接塞进 Harness UserMessage。
- 把平台 SDK 类型泄漏到 `channel-core`。
- 为了 Lark Channel SDK 重构整个框架。
- 同时升级 Harness 主版本。
- 在没有 live verification 的情况下把 Weixin 标成 `tested`。
- 用延长 dedup window 代替 DingTalk ACK。
- 让 `sdk` 模式继续隐式依赖 `localhost` 却不在文档说明。

---

# 26. 本轮执行完成后的目标状态

```text
@dsh/channel-core
        ↑
        │ stable contract
        │
 ┌──────┼────────┬───────────┬──────────┐
 │      │        │           │          │
QQ   Weixin   DingTalk      Lark     Telegram
 │      │        │           │
 │      │        │           │
official source official    official
SDK      port    SDK/API     SDK/API
 │      │        │           │
 └──────┴────────┴───────────┴──────────┘
        ↓
@dsh/channel-harness
        ↓
DeepSeek Harness
```

平台升级：

```text
只影响对应 Driver / Adapter
```

Harness 升级：

```text
主要影响 channel-harness
```

Channel Contract：

```text
保持稳定
```

这就是最终希望保住的架构边界。

---

# 27. 最终判定标准

完成本计划后可以发布以下结论：

> `dsh-channels` 已完成 DeepSeek Harness 渠道扩展架构、Harness Agent/Session 桥接、四个官方渠道适配、兼容治理、验证 CLI 与 DSH Bundle，并通过当前 Harness pinned contract、离线测试、官方 SDK 对照和真实平台 live gate。项目具备可持续升级、第三方渠道扩展和正式发布条件。

当前阶段则仍应表述为：

> 主体实现完成，发布前 verification 收口进行中。
