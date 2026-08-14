# DeepSeek Harness Channels — Weixin iLink 修正执行方案

目标不是重新设计，而是基于当前实现，把已经发现的缺口收口，使 `DeepSeek-Harness-Channels-Weixin-iLink-最终执行方案.md` 真正达到可验收状态。

## 总体顺序

```text
R0 生产持久化
 ↓
R1 Cursor / Dedup 一致性
 ↓
R2 全平台 transactional mount
 ↓
R3 WX4 真微信 Text E2E
 ↓
R4 WX5 Media / Harness Attachment
 ↓
R5 WX6 Typing / Progress
 ↓
R6 WX7 CI / Compatibility / Release Gate
```

优先级：

```text
P0：R0 + R1
P1：R2 + R3
P2：R4 + R5
P1：R6（发布前必须完成）
```

---

# R0 — 修正 Weixin 生产持久化

## 当前问题

`packages/channel-weixin/src/index.ts` 目前固定：

```ts
secrets: new MemorySecretStore(),
storage: new MemoryStorage(),
```

导致：

```text
QR credential
sync cursor
context_token
```

全部只存在于当前进程。

这直接破坏：

```text
restart 不重新扫码
restart 后从原 cursor 继续
restart 后仍能使用 context_token 回复
```

## 修正目标

公共层增加真正的运行时资源：

```ts
export interface ChannelRuntimeResources {
  secrets: SecretStore
  storage: ChannelStorage
}
```

建议由：

```text
ChannelService
```

统一持有或解析，而不是每个 Adapter 自己 new。

推荐：

```ts
interface ChannelServiceOptions {
  resources?: {
    secrets?: SecretStore
    storage?: ChannelStorage
  }
}
```

或者增加 Cordis service：

```text
channelSecrets
channelStorage
```

我更建议第一阶段直接做：

```text
ChannelService
└── runtimeResources
    ├── secrets
    └── storage
```

减少新的 Cordis Service 数量。

## 生产实现

新增：

```text
packages/channel-core/src/runtime-resources.ts
packages/channel-core/src/file-storage.ts
packages/channel-core/src/file-secret-store.ts
```

目录：

```text
data/channels/
├─ secrets/
│  └─ weixin-main.json
├─ weixin/
│  ├─ sync/
│  └─ context/
└─ bindings.json
```

但敏感 token 最好不要和普通 storage 混在一个 JSON。

Windows 第一阶段可以使用：

```text
FileSecretStore
```

文件权限尽可能限制。

后续可以替换：

```text
Windows Credential Manager
DPAPI
系统 Secret Provider
```

而不修改 WeixinAdapter。

## Weixin 修改

把：

```ts
secrets: new MemorySecretStore(),
storage: new MemoryStorage(),
```

改成：

```ts
secrets: ctx.channels.resources.secrets,
storage: ctx.channels.resources.storage,
```

或者通过 mount helper：

```ts
mountChannelAdapter(ctx, adapter, (signal) =>
  ctx.channels.createAdapterContext({
    channelId: 'weixin',
    signal,
  }),
)
```

进一步推荐抽象：

```ts
ctx.channels.createAdapterContext(...)
```

这样 QQ / Lark / DingTalk / Weixin 不再重复构造：

```text
emit
logger
storage
secrets
signal
```

## 必须新增测试

```text
credential survives adapter restart
cursor survives adapter restart
context_token survives adapter restart
```

真正测试：

```text
adapter A
→ QR credential save
→ stop

adapter B
→ 同一个 persistent resource
→ start
→ 不重新扫码
```

### R0 验收

- [ ] Weixin plugin 不再直接 `new MemorySecretStore()`
- [ ] Weixin plugin 不再直接 `new MemoryStorage()`
- [ ] credential restart 后仍存在
- [ ] cursor restart 后仍存在
- [ ] context_token restart 后仍存在
- [ ] token 不进入普通日志/config/raw event

---

# R1 — 重做 Cursor / Dedup 一致性

这是当前最重要的运行时正确性问题。

## 当前错误模型

现在近似：

```text
dedup.mark
 ↓
emit
 ↓
cursor.commit
```

如果：

```text
dedup.mark 成功
emit 失败
```

下一轮 replay 会被 dedup 丢掉。

## 正确模型

改成两阶段：

```text
dedup.seen?
 ↓ no
emit
 ↓ success
dedup.commit
 ↓
cursor.commit
```

也就是说：

> **消息只有在成功进入 Channel pipeline 后，才允许成为 committed dedup entry。**

## 修改 Dedup API

不要：

```ts
check(key): boolean
```

改为：

```ts
interface DedupStore {
  has(key: string): Promise<boolean>
  commit(key: string): Promise<void>
}
```

Monitor：

```ts
const key = dedupKey(msg)

if (await dedup.has(key)) {
  return
}

await captureContextToken(msg)

await emit(mapInbound(msg))

await dedup.commit(key)
```

然后整轮消息全部成功之后：

```ts
await cursor.set(nextCursor)
```

## 更严格的顺序

```text
getUpdates(cursor=N)
 ↓
M1
 ↓
dedup.has(M1)
 ↓ false
contextToken.set()
 ↓
emit(M1)
 ↓ success
dedup.commit(M1)
 ↓
M2 ...
 ↓
全部成功
 ↓
cursor.commit(N+1)
```

如果 M2 失败：

```text
cursor 仍然 N
```

下一轮：

```text
M1 → persistent dedup → skip
M2 → 未 commit dedup → retry
```

这样才正确。

## Dedup 必须持久化

不要只用：

```ts
Map<string, number>
```

新增：

```text
PersistentDedupStore
```

至少持久化最近：

```text
1000～5000 message ids
```

或者：

```text
24h replay window
```

推荐：

```ts
interface DedupRecord {
  key: string
  committedAt: number
}
```

storage key：

```text
weixin:dedup:<accountId>
```

可以定期压缩。

## ContextToken 顺序

`context_token` 可以在 emit 前保存。

因为它属于：

```text
latest peer reply context
```

即使消息随后 retry，也不会造成消息永久丢失。

但如果想做到更严格，可以在：

```text
emit 成功后
```

再 commit context token。

我建议：

```text
先放 pending
emit success
commit context_token
```

第一版没必要做复杂 transaction，优先保证消息不丢。

## Cursor commit 失败

现在 cursor `.set()` 失败后只是 log。

建议改成：

```ts
await cursor.set(nextCursor)
```

失败：

```text
必须进入 monitor retry
```

而不是继续下一轮。

否则内存 cursor 和 durable cursor 会分叉。

即：

```ts
try {
  await cursor.set(next)
  cursor = next
} catch (error) {
  throw new CursorCommitError(...)
}
```

### R1 必须新增故障测试

#### Case A

```text
emit(M1) throw
→ dedup 不 commit
→ cursor 不推进
→ 下一轮 M1 再次 emit
```

#### Case B

```text
emit M1 success
→ dedup commit
→ crash before cursor commit
→ restart
→ M1 replay
→ dedup skip
→ 不重复触发 Harness
```

#### Case C

```text
M1 success
M2 fail
→ cursor 不推进
→ retry
→ M1 skip
→ M2 再处理
```

#### Case D

```text
cursor storage write failure
→ monitor retry
→ 不更新 local cursor
```

### R1 验收

- [ ] Dedup 不再是 check-and-mark
- [ ] Dedup durable
- [ ] emit 失败不会把消息永久标记完成
- [ ] cursor 只在整轮成功后推进
- [ ] cursor 持久化失败必须 retry
- [ ] crash replay 不重复触发 Agent

---

# R2 — 所有 Adapter 统一 transactional mount

当前公共 helper：

```ts
mountChannelAdapter()
```

方向已经正确。

下一步把：

```text
QQ
DingTalk
Lark
Telegram
Weixin
```

全部统一。

删除各插件中的：

```ts
const unregister = ctx.channels.register(adapter)
await adapter.start(...)
```

改成：

```ts
mountChannelAdapter(
  ctx,
  adapter,
  (signal) => ctx.channels.createAdapterContext(...),
)
```

QQ 的 credential resolve 放在创建 adapter 之前。

例如：

```ts
ctx.effect(async () => {
  const credential = await resolveCredential()

  const adapter = new QQAdapter(...)

  return mount...
})
```

或者扩展 mount：

```ts
mountChannelAdapterAsync(...)
```

但我更建议：

> 不再新增第二个 helper。

credential resolve 可以独立 Effect，然后普通 mount。

### R2 新增测试

每个平台至少一条：

```text
adapter.start throws
→ registry 中没有 adapter
→ stop called
→ signal aborted
```

### R2 验收

- [ ] 五个平台没有手写 register/start/unregister 生命周期
- [ ] start failure 全部 rollback
- [ ] unload 全部 abort → stop → unregister

---

# R3 — 完成 WX4 真微信 Text E2E

这里不要再继续加功能。

先证明：

```text
真实微信
 ↓
getUpdates
 ↓
ChannelEvent
 ↓
channel-harness
 ↓
Agent.followup
 ↓
真实 Harness model
 ↓
session/event
 ↓
ReplyRouter
 ↓
sendmessage
 ↓
真实微信
```

## 增加 live test

建议：

```text
packages/channel-weixin/test/live/
└─ weixin-live.test.ts
```

仅：

```bash
DSH_WEIXIN_LIVE=1
```

时执行。

不要进入普通 PR 自动测试。

## 必须验证四个场景

### E2E-1 首次登录

```text
QR
→ scan
→ confirmed
→ credential persisted
```

### E2E-2 Text

```text
微信发送：你好
→ Harness 收到
→ 微信收到 AI 回复
```

### E2E-3 Restart

```text
关闭 DSH
→ 重启
→ 不重新扫码
→ 微信再发一条
→ 继续同一个 Session
```

### E2E-4 Graceful unload

在 Agent 生成尾部回复期间：

```text
dispose
→ whenIdle
→ durable reconcile
→ 微信最终回复完整
```

## 顺便修 README

删除所有：

```text
Weixin self-hosted gateway
localhost:9000
```

残留说明。

### R3 验收

- [ ] real QR
- [ ] real inbound text
- [ ] real Harness response
- [ ] real sendmessage
- [ ] restart 无需重新扫码
- [ ] Session 不漂移
- [ ] unload 不丢尾部回复

做到这里，可以正式宣布：

> **Weixin Text Channel Stable**

---

# R4 — 完成 WX5 Media

只有 WX4 稳定后再做。

不要一次打开四种 capability。

顺序：

```text
WX5.1 Image
 ↓
WX5.2 Voice
 ↓
WX5.3 File
 ↓
WX5.4 Video
```

## WX5.1 Image

完成：

```text
CDN metadata
→ download encrypted body
→ AES decrypt
→ managed temp file / Buffer
→ Channel attachment
→ Harness multimodal content
```

关键不是：

```text
MessagePart.image
```

而是：

```text
Harness 真正拿到 image attachment
```

需要修改：

```text
packages/channel-harness/src/message-converter.ts
```

从：

```text
[image]
```

变为 Harness 官方支持的 attachment/content block。

每种媒体只有真正打通后才打开：

```ts
capabilities.image = true
```

## Outbound Image

再实现：

```text
encrypt
→ CDN upload
→ sendmessage
```

## 删除 scaffold

最终不能再存在：

```ts
wx5NotImplemented(...)
```

### R4 验收

每种 media 都必须：

```text
真实微信 → Harness model 能理解
Harness outbound → 微信真实收到
```

而不是只测 mapper。

---

# R5 — WX6 Typing / Progress

当前 `TypingController` 已有，不重写。

把它接入实际 turn 生命周期：

```text
agent/inbox/claimed
或 turn/start
 ↓
TypingController.start(peer)

turn/end
agent error
cancel
 ↓
TypingController.stop(peer)
```

Typing ticket：

```text
getconfig
→ cache per peer/account
```

错误必须：

```text
best effort
```

永远不能让：

```text
sendmessage
```

失败。

## run_id

建议增加 Reply scope：

```ts
interface ReplyExecutionContext {
  runId: string
}
```

一个 Harness turn：

```text
同一个 run_id
```

而不是每次 sender 调用都 random UUID。

以后如果实现：

```text
GENERATING
FINISH
```

可以复用。

### R5 验收

- [ ] turn 开始显示 typing
- [ ] turn 完成停止 typing
- [ ] typing API 失败不影响正文
- [ ] 同一 turn 保持 run_id correlation

---

# R6 — WX7 CI / Compatibility / Release Gate

## CI 必须改

当前：

```yaml
on:
  push:
    tags: ['v*']
  workflow_dispatch:
```

改为至少：

```yaml
on:
  pull_request:
  push:
    branches:
      - main
    tags:
      - 'v*'
  workflow_dispatch:
```

普通 PR 必须跑：

```text
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm check:fixtures
pnpm check:manifests
pnpm doctor
pnpm check:bundle
```

## Live 测试不要放普通 PR

拆为：

```text
Offline CI
Live Platform Gate
```

Live：

```yaml
workflow_dispatch:
```

或者 release protected environment。

## Manifest 修正

当前：

```ts
testedVersion: '<pending-live-verification>',
testedCommit: '<pending-live-verification>',
status: 'tested',
```

不合理。

Live 验收前：

```ts
status: 'experimental'
```

Live 验收后填写真实：

```ts
testedVersion: '...'
testedCommit: '真实 Tencent/openclaw-weixin SHA'
status: 'tested'
```

不要保留：

```text
versionRange: '*'
```

长期建议锁一个已经验证的范围或 commit。

## Release Gate

正式发布条件：

```text
Offline CI ✓
Harness compatibility ✓
iLink fixtures ✓
persistent restart test ✓
real Weixin Text smoke ✓
manifest pinned ✓
README ✓
```

WX5 没完成时，可以发布 Text-only 版本，但必须明确：

```ts
image: false
audio: false
file: false
video: false
```

而不能宣称完整 Weixin Channel。

---

# 建议的提交拆分

不要一个大 commit 再全部一起修。

建议：

```text
fix(channel-core): add persistent channel runtime resources
fix(channel-weixin): persist credentials cursor and context state

fix(channel-weixin): make dedup commit-aware and crash-safe
test(channel-weixin): add cursor replay failure matrix

refactor(channels): use transactional adapter mount everywhere

test(channel-weixin): add live text E2E harness

feat(channel-weixin): implement image CDN + Harness attachment
feat(channel-weixin): add voice/file/video media paths

feat(channel-weixin): wire typing lifecycle and run correlation

ci: enforce PR compatibility and release gates
docs: mark verified iLink commit and actual support matrix
```

---

# 最关键的完成定义

不要再以：

```text
文件存在
测试文件存在
fixture 存在
```

判断里程碑完成。

以后每个里程碑分成三种状态：

```text
IMPLEMENTED
= 代码路径已经接通

OFFLINE_VERIFIED
= unit / contract / fixture 全绿

LIVE_VERIFIED
= 真实 Harness + 真实平台成功
```

例如当前：

```text
H0
IMPLEMENTED ✓
OFFLINE_VERIFIED ✓
LIVE_VERIFIED △

WX4
IMPLEMENTED ≈
OFFLINE_VERIFIED ✓
LIVE_VERIFIED ✗

WX5
IMPLEMENTED ✗

WX6
IMPLEMENTED △

WX7
IMPLEMENTED ✗
```

只有最终要求 Live 的阶段达到：

```text
LIVE_VERIFIED
```

才允许文档打 `[x]`。

---

# 推荐当前立即执行范围

第一批只做下面四件：

```text
Task 1
ChannelRuntimeResources + persistent SecretStore / Storage

Task 2
Weixin credential/cursor/context_token 接生产持久化

Task 3
Dedup 改为 has → emit → commit，并持久化

Task 4
Cursor commit failure / crash replay fault-injection tests
```

**这四项完成后，再跑真实 WX4 E2E。**

不要现在先做 WX5。

因为当前最大的风险不是“不能发图片”，而是：

```text
扫码后重启登录丢失
消息失败重试可能永久丢
crash replay 可能重复调用 Agent
```

把这三件解决，Weixin Text 链路才真正具备生产级基础。