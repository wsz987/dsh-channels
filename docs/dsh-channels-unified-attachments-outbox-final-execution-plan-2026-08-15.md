# dsh-channels 统一附件、文件理解与主动消息最终执行方案

> 项目：`wsz987/dsh-channels`  
> 仓库：<https://github.com/wsz987/dsh-channels>  
> 核验基线：`main@eb1a828af459dd8d944a692dd0ab285e8cc82b19`  
> 核验日期：2026-08-15  
> 状态：**Final / Execution Ready**  
> 首发：Weixin；复用：QQ / DingTalk / Lark / Telegram / 后续渠道  
> Host：DeepSeek Harness

---

# 1. 核验结论

上一版方案**需要实质性调整**。当前 main 已明确了四个会直接影响附件设计的事实：

1. `ChannelCapabilities.image/file/audio/video` 表达的是**平台传输能力**，不代表 Harness 模型已经获得真实附件。
2. 默认 Workspace 是 `channel-account`：同一渠道账号下的多个 Conversation / Session 可能共享一个 cwd，因此 **cwd 不能作为附件 Session ACL 边界**。
3. DeepSeek Harness 当前 `ctx.fs` 有有界 `readBytes()`，但没有 binary-safe `writeBytes()`；`writeText/editText` 是文本接口，所以不能把“任意 PDF/DOCX 原件写入 Harness FS”当成通用官方方案。
4. `ReplyRouter` 已经把 `SessionBinding=WHERE` 与 `ReplyContext=SHOULD AUTO-ROUTE` 分开。主动发送必须新增显式 Outbox，不能改成“只要 SessionBinding 存在就自动回渠道”。

因此最终架构调整为：

```text
Platform Adapter
  └─ 下载 / 鉴权 / 解密
       ↓
统一 MessagePart.localData
       ↓
channel-harness Attachment Pipeline
       ├─ Image → 官方 ctx.attachments → ImageBlock
       └─ File/Audio/Video → dsh-channels Private Asset Store
                                ↓
                             Extractor
                                ↓
                     read_channel_attachment Tool
```

主动发送：

```text
Agent / Job / Scheduler / Trusted Plugin
       ↓
ChannelOutboxService
       ↓
Current SessionBinding
       ↓
OutboundAttachmentResolver
       ↓
OutboundMessage
       ↓
Platform Adapter
```

---

# 2. 当前源码基线

核验时 `main`：

```text
eb1a828af459dd8d944a692dd0ab285e8cc82b19
改为 zod 校验
```

最近与本方案直接相关的提交：

```text
eb1a828  Zod contract validation
992e9ae  Web channel setup control plane
7ee0595  stabilize channel session creation
50f83b1  channel workspace integration
cd514bd  official dsh-commands command plane + /new
```

当前已经存在且应继续保留：

```text
Channel Contract
ChannelService
ChannelAdapter
ChannelHarnessBridge
AgentManager
SessionBinding
ReplyContextStore
ReplyRouter
ChannelWorkspaceResolver
official dsh-commands command plane
Weixin image real attachment path
Zod trust-boundary validation
```

本轮不是重做渠道架构，只新增统一附件生命周期与显式 Outbox。

---

# 3. 最终架构边界

允许：

```text
channel-weixin   ─┐
channel-qq       ─┤
channel-lark     ─┤
channel-dingtalk ─┤
channel-telegram ─┘
        ↓
   channel-core

channel-harness
        ↓
   channel-core
        +
DeepSeek Harness public APIs
```

禁止：

```text
channel-weixin -> channel-harness
channel-core -> DeepSeek Harness
channel-harness -> channel-weixin
channel-harness -> Tencent/Lark/QQ/DingTalk SDK
```

平台包只负责平台协议；Harness 包只负责 Session、模型投影、附件私有生命周期、工具与 Outbox。

---

# 4. Channel Core：统一 Binary Contract

当前：

```text
ImagePart.localData ✅
FilePart.localData  ✅
AudioPart.localData ❌
VideoPart.localData ❌
```

做 additive refactor：

```ts
export interface BinaryPartBase {
  /** 平台临时/远程地址，不是持久引用。 */
  url?: string

  /** 小对象或既有 provider 输出可用。 */
  dataUri?: string

  /** Adapter 已完成下载、鉴权、解密后的真实字节。 */
  localData?: Uint8Array

  /** Adapter hint；进入 Harness trust boundary 后仍需验证。 */
  mimeType?: string

  /** 用户可见名称，绝不能直接解释成本地路径。 */
  name?: string

  /** 已知明文字节数。 */
  size?: number
}

export interface ImagePart extends BinaryPartBase {
  type: 'image'
  alt?: string
}

export interface FilePart extends BinaryPartBase {
  type: 'file'
}

export interface AudioPart extends BinaryPartBase {
  type: 'audio'
  durationMs?: number
}

export interface VideoPart extends BinaryPartBase {
  type: 'video'
  durationMs?: number
}
```

保持已有调用兼容，不改变 `MessagePart` 的核心 discriminated union。

最新代码已经统一使用 Zod 做 trust-boundary schema；任何新增持久化附件 metadata、Web API、manifest/doctor 数据都继续走 Zod。不要为了 schema 把 `Uint8Array` Base64 化后塞进 ChannelEvent JSON。

---

# 5. 保持 ChannelCapabilities 现有语义

现有 `ChannelCapabilities` 不改定义：

```text
image/file/audio/video
= Adapter + Platform transport capability
```

不是：

```text
Harness native model attachment capability
```

因此后续：

```text
Weixin file inbound/outbound transport 完成
→ capabilities.file = true
```

即使 Harness 官方还没有 native Generic FileBlock，也完全合理。

另外增加**非 Core 的模型投影状态**：

```ts
export interface ModelIngressCapabilities {
  nativeImage: boolean
  extractedFile: boolean
  audioTranscript: boolean
  videoTranscript: boolean
}
```

推荐放：

```text
channel-harness diagnostics
channel-compat / manifest
channels doctor
README capability matrix
```

不要把它塞进现有 `ChannelCapabilities`。

---

# 6. Platform Adapter 统一职责

每个平台入站链路必须固定为：

```text
Raw Event
→ Pure Mapper
→ MessagePart(url/resource metadata)
→ Platform Media Hydrator
→ bounded download
→ platform auth/decrypt
→ localData
→ ctx.emit(message.received)
```

规则：

- Mapper 不做 I/O。
- Adapter 不调用 Harness API。
- Harness 不认识平台 AES key / file_key / bearer token。
- 媒体失败是 attachment-level failure，不能吞用户正文。
- 下载必须 bounded，不能先完整 `arrayBuffer()` 后检查大小。

平台示例：

```text
Weixin  iLink CDN + AES   → localData
Lark    image_key/file_key → official resource download → localData
QQ      SDK attachment URL → bounded authorized download → localData
DingTalk media resource    → official SDK/OpenAPI → localData
```

---

# 7. Bounded Download

当前 Weixin `downloadMedia()` 使用：

```ts
Buffer.from(await response.arrayBuffer())
```

文件能力上线前必须改成有界读取。

建议公共 helper：

```ts
export async function readResponseBytesBounded(
  response: Response,
  options: {
    maxBytes: number
    signal?: AbortSignal
  },
): Promise<Uint8Array>
```

规则：

```text
Content-Length > maxBytes
→ 请求体不再读取，立即拒绝

未知 Content-Length
→ ReadableStream reader
→ 累计 bytes
→ 超限 abort
```

禁止：

```text
500MB arrayBuffer
→ 然后才检查大小
```

平台上限、项目 policy、Harness 图片上限取有效最小值。

---

# 8. Private Channel Asset Store

这是最终版最重要的修订。

## 8.1 为什么不能默认放 Workspace

当前默认：

```text
workspace.mode = channel-account
```

目录：

```text
<DSH_HOME>/workspaces/channels/<channel>/<account-key>
```

一个 bot/account 下多个 Conversation/Session 可能共用 cwd。

所以：

```text
cwd containment
≠ conversation/session authorization
```

不能把：

```text
<cw d>/.dsh-channel/inbox/
```

当成私密 Session inbox。

## 8.2 新增私有 Store

放：

```text
packages/channel-harness/src/attachments/store.ts
```

接口名：

```ts
ChannelInboundAssetStore
```

故意不叫 `AttachmentStore`，避免与官方 `ctx.attachments` 混淆。

默认根：

```text
<DSH_HOME>/channels/attachments/v1/
```

目录：

```text
<DSH_HOME>/channels/attachments/v1/
  sessions/
    <sessionId>/
      <messageId>/
        <attachmentId>/
          meta.json
          raw.bin
          extracted.md
```

`sessionId` 是授权边界。

---

# 9. Asset Metadata

建议 opaque ID：

```text
cha_<random>
```

内部 metadata：

```ts
export interface StoredChannelAsset {
  schemaVersion: 1

  attachmentId: string

  sessionId: string
  channelId: string
  accountId: string
  conversationId: string
  threadId?: string

  messageId: string

  kind: 'file' | 'audio' | 'video'

  name: string
  mimeType?: string
  bytes: number
  sha256: string

  rawStored: boolean

  extraction: {
    status:
      | 'not-needed'
      | 'ready'
      | 'unsupported'
      | 'failed'
      | 'too-large'

    format?: 'text' | 'markdown'
    bytes?: number
    errorCode?: string
  }

  createdAt: number
}
```

`meta.json` 必须用 Zod 校验。

不得写：

```text
AES key
context token
provider bearer URL
bot secret
SDK raw payload
```

---

# 10. 文件名安全

统一 sanitizer：

```text
../../secret.txt     → secret.txt
C:\Users\x\a.pdf     → a.pdf
..                   → attachment.bin
空文件名              → attachment.bin
重复名                → opaque asset dir 避免碰撞
控制字符              → 删除
超长名称              → 截断，尽量保留扩展名
```

平台 `name` 永远只是 display name，不是 path。

---

# 11. 图片继续走官方 Harness AttachmentStore

图片不要被 generic asset 路线替代。

```text
ImagePart.localData
→ MIME/format validation
→ ctx.attachments.saveImage()
→ ImageAttachmentRef
→ ImageBlock
→ Harness UserMessage
```

现有微信真实图片路径保留。

第一版不需要把同一份图片 raw bytes 再复制到 `ChannelInboundAssetStore`；如果需要 provenance，只保存轻量 metadata/官方 `ImageAttachmentRef`。

没有 `ctx.attachments` 或 save 失败时降级成 placeholder，不能让整条消息失败。

---

# 12. Generic File 不伪造 Harness FileBlock

DeepSeek Harness 当前官方：

```text
ctx.attachments V1 = PNG/JPEG/WebP/GIF
Generic files/audio/video = deferred
```

所以禁止自造：

```ts
{
  type: 'file',
  attachment: ...
}
```

并假装是 Harness 官方 ContentBlock。

最终模型入口：

```text
Generic File
→ ChannelInboundAssetStore
→ Extractor
→ read_channel_attachment Tool
```

以后 Harness 官方提供 generic file lifecycle 时，只替换 Projection 层即可，Adapter 与统一 `localData` 不需要重写。

---

# 13. Extractor Registry

目录：

```text
packages/channel-harness/src/attachments/
  extractors/
    types.ts
    registry.ts
    text.ts
    pdf.ts
    docx.ts
    xlsx.ts
    pptx.ts   # P1
```

接口：

```ts
export interface ChannelDocumentExtractor {
  readonly id: string

  supports(input: {
    name?: string
    mimeType?: string
  }): boolean

  extract(input: {
    bytes: Uint8Array
    name: string
    mimeType?: string
    maxOutputBytes: number
    signal?: AbortSignal
  }): Promise<{
    format: 'text' | 'markdown'
    text: string
  }>
}
```

首期：

```text
TXT / MD / JSON / YAML / XML / CSV / LOG / source code
PDF（可复制文本）
DOCX
XLSX
```

P1：

```text
PPTX
scanned PDF OCR
audio ASR
video ASR/keyframes
```

不要把 OCR/ASR 写进 Channel Core。

---

# 14. 类型处理

### 文本 / 代码

不只看扩展名，结合：

```text
MIME hint
UTF-8 strict decode
NUL-byte detection
binary heuristic
```

### PDF

```text
raw.bin
→ extractor
→ extracted.md
```

首期不强制 OCR。

### DOCX

保留：

```text
heading
paragraph
list
table text
```

### XLSX

按 Sheet 输出 bounded Markdown/CSV 语义，限制：

```text
sheet count
rows
cell length
total extracted bytes
```

### ZIP/RAR/7z

V1：

```text
raw stored
extraction=unsupported
```

不自动解压。

### EXE/DLL/未知 binary

保存原件，不执行、不自动解析。

---

# 15. `read_channel_attachment` Tool

使用 DeepSeek Harness 官方 Tool API：

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(
  defineTool({
    name: 'read_channel_attachment',
    ...
  }),
)
```

不要自建 Agent JSON RPC 或命令解析器。

参数：

```ts
{
  attachment_id: string
  offset?: number
  limit?: number
}
```

建议：

```text
offset: 1-based
limit: default 200
limit max: 1000
result byte cap: hard bounded
```

关键 ACL：

```ts
async execute(args, exec) {
  const sessionId = String(exec.agent.id)
  const asset = await store.get(args.attachment_id)

  if (!asset) throw ...
  if (asset.sessionId !== sessionId) throw ...

  ...
}
```

**不用 cwd 做 ACL。**

规范返回：

```ts
{
  attachmentId: string
  name: string
  mimeType?: string
  offset: number
  lines: Array<{
    number: number
    text: string
  }>
  hasMore: boolean
  nextOffset?: number
}
```

---

# 16. UserMessage 只放 Descriptor

不要把大文档全文塞进消息。

PDF 示例：

```text
用户随消息发送了附件：
- 附件 ID：cha_a1b2c3
- 文件名：合同.pdf
- 类型：application/pdf
- 大小：1.8 MB
- 已提取可读文本：是

如需查看内容，请使用 read_channel_attachment，
传入 attachment_id="cha_a1b2c3"。
不要根据文件名猜测内容。
```

失败：

```text
用户发送了附件“report.pdf”，但下载/解密失败，内容不可用。
```

不支持：

```text
附件 archive.zip 已接收，但当前没有可读取文本。
```

---

# 17. Attachment Pipeline

目录：

```text
packages/channel-harness/src/attachments/
  types.ts
  schema.ts
  policy.ts
  filename.ts
  mime.ts
  hash.ts
  store.ts
  pipeline.ts
  render.ts
  tool-read.ts
  extractors/*
  index.ts
```

输入：

```ts
export interface PrepareChannelAttachmentsInput {
  sessionId: string

  channelId: string
  accountId: string
  conversationId: string
  threadId?: string

  messageId: string

  parts: readonly MessagePart[]

  signal?: AbortSignal
}
```

输出：

```ts
export interface PreparedChannelAttachment {
  sourcePartIndex: number

  kind: 'image' | 'file' | 'audio' | 'video'

  name?: string
  mimeType?: string
  bytes?: number

  status:
    | 'native-image'
    | 'extracted'
    | 'stored'
    | 'metadata-only'
    | 'too-large'
    | 'failed'

  imageAttachment?: ImageAttachmentRef
  channelAttachmentId?: string
  extractionAvailable?: boolean
  warning?: string
}
```

---

# 18. Bridge 插入点

当前：

```text
resolve/create binding + agent
→ toHarnessUserMessage
→ ReplyContext.register
→ agent.followup
```

改成：

```text
resolve/create binding + agent
→ AttachmentPipeline.prepare(sessionId...)
→ toHarnessUserMessage(preparedAttachments)
→ ReplyContext.register
→ agent.followup
```

附件必须在知道 `binding.sessionId` 后才持久化。

---

# 19. Message Converter 收口

当前 converter 通过 `saveImage` hook 做图片 I/O。

最终职责：

```text
AttachmentPipeline
= I/O / validation / persistence / extraction

MessageConverter
= PreparedAttachment → ContentBlock representation
```

建议：

```ts
export interface MessageConvertOptions {
  includeMetadataPrefix?: boolean
  preparedAttachments?: readonly PreparedChannelAttachment[]
}
```

`saveImage` 可保留一个 release 作为 deprecated compatibility seam，后续移除。

---

# 20. `/new` 与附件

当前 `/new`：

```text
Session A
→ new Session B
→ binding switch
→ retire Session A agent
```

所以默认：

```text
Session A attachment cha_A

/new

Session B:
read_channel_attachment(cha_A)
→ DENY
```

这与“新会话”语义一致。

如未来需要继承，必须显式：

```text
import/copy attachment into current session
```

不能隐式共享。

Slash command 携附件第一版建议不 ingestion，例如：

```text
/new + PDF
```

返回：

```text
已开启新会话；请重新发送附件。
```

避免附件究竟属于旧 Session 还是新 Session 的歧义。

---

# 21. Agent Setup

当前已有 Agent-scoped `commandSetup`。

演进成：

```ts
private channelAgentSetup =
  async (agentCtx: Context) => {
    await installChannelCommands(
      agentCtx,
      this.options.commandDeps,
    )

    await installChannelTools(
      agentCtx,
      this.options.toolDeps,
    )
  }
```

统一安装：

```text
/new
read_channel_attachment
send_channel_message
```

复用 AgentManager 当前对 fresh/resume/borrowed agent 的 one-time setup 机制。

---

# 22. Plugin Injection

当前：

```ts
inject = [
  'channels',
  'agents',
  'agentDefaultModel',
  'commands',
]
```

新增官方 Tool 后推荐：

```ts
inject = [
  'channels',
  'agents',
  'agentDefaultModel',
  'commands',
  'tools',
]
```

`packages/channel-harness/package.json` 增加：

```text
@deepseek-ai/dsh-tools
```

版本与项目现有 DSH family pin 保持一致。

`ctx.attachments` 继续 optional resolve；没有时只影响 native image。

`ctx.fs` 不作为 V1 Outbox/Attachment 的 required injection，只有可选 `file_path` 发送才需要。

---

# 23. Channel Outbox

新增：

```text
packages/channel-harness/src/outbox/
  types.ts
  target.ts
  binding-resolver.ts
  attachment-resolver.ts
  service.ts
  tool-send.ts
  index.ts
```

接口：

```ts
export interface ChannelOutboundRequest {
  text?: string

  /** 推荐 V1 文件发送方式。 */
  attachmentId?: string

  /** 高级能力，默认 policy 关闭。 */
  filePath?: string
}

export interface ChannelOutboxService {
  sendToSession(
    sessionId: string,
    request: ChannelOutboundRequest,
    signal?: AbortSignal,
  ): Promise<SendResult>
}
```

---

# 24. Outbox 不改 ReplyRouter

ReplyRouter 保持：

```text
Channel inbound turn
+
ReplyContext
→ automatic reply
```

Outbox：

```text
explicit tool/job/plugin trigger
→ proactive send
```

严禁：

```ts
if (binding) {
  autoSendEveryAssistantTurn()
}
```

否则 Web UI/CLI/其他插件驱动的 channel-bound session 会误发到外部渠道。

---

# 25. 持久 Session → Binding 反查

当前：

```ts
AgentManager.bindingFor(sessionId)
```

只是 live memory fast path。

`SessionBindingStore` 当前只有：

```text
get(conversationKey)
put
delete
```

为了进程重启后明确恢复主动发送路由，增加：

```ts
export interface SessionBindingStore {
  get(key: string): Promise<SessionBinding | undefined>

  findBySessionId(
    sessionId: string,
  ): Promise<SessionBinding | undefined>

  put(binding: SessionBinding): Promise<void>
  delete(key: string): Promise<void>
}
```

FileBindingStore 直接扫描缓存 values，无需第二份数据库。

Outbox：

```text
AgentManager.bindingFor(sessionId)
→ fast path

miss
→ BindingStore.findBySessionId(sessionId)
```

---

# 26. `/new` 后旧 Session 不再有 Outbox Authority

Binding switch：

```text
conversation → Session B
```

旧 Session A：

```text
Outbox.sendToSession(A)
→ OUTBOX_NO_ACTIVE_BINDING
```

Session B：

```text
→ allowed
```

这避免旧后台任务完成后向已经 reset 的外部对话推送过期结果。

如果未来需要 stale-job delivery，单独设计显式策略，不默认允许。

---

# 27. `send_channel_message` Tool

官方 `defineTool`。

V1 schema：

```ts
{
  text?: string
  attachment_id?: string
}
```

禁止：

```text
channel_id
account_id
conversation_id
user_id
openid
```

Tool：

```ts
async execute(args, exec) {
  return outbox.sendToSession(
    String(exec.agent.id),
    {
      text: args.text,
      attachmentId: args.attachment_id,
    },
    exec.signal,
  )
}
```

模型只能向**当前 Session 当前有效 Binding**发送。

---

# 28. 发送收到过的文件

推荐：

```text
attachment_id
```

Resolver：

```text
cha_123
→ ChannelInboundAssetStore
→ assert sessionId === current session
→ bounded raw read
→ FilePart/ImagePart.localData
→ adapter.send()
```

优点：

```text
不暴露 Host 路径
不依赖 shared Workspace ACL
不允许跨 Session 文件泄漏
```

---

# 29. `file_path` 默认关闭

未来需求：

```text
Agent 生成 report.pdf
→ 发微信
```

当前默认 `channel-account` cwd 是共享工作区，所以：

```text
path is under cwd
```

不等于：

```text
path belongs to current conversation
```

因此默认：

```yaml
attachments:
  outbound:
    allowStoredAttachment: true
    allowWorkspaceFilePath: false
```

若以后开启 `file_path`，必须用 Harness `ctx.fs`：

```text
ctx.fs.resolve(path, { cwd: session.header.cwd })
→ stat regular file
→ readBytes(maxBytes)
```

不要直接 `node:fs.readFile(modelPath)`。

即便如此，`channel-account` 下仍只是 Workspace-level trust。建议未来三选一：

1. 部署方明确接受同 account Workspace 互信；
2. 新增 `workspace.mode=channel-conversation`；
3. 增加显式 Channel Export Root / publish step。

V1 优先做好：

```text
attachment_id ✅
file_path      disabled
```

---

# 30. Attachment Policy

`channel-harness/src/config.ts` 新增：

```ts
export interface AttachmentConfig {
  enabled: boolean

  maxInboundBytes: number
  maxAttachmentsPerMessage: number
  maxExtractedBytes: number

  keepOriginals: boolean

  extract: {
    text: boolean
    pdf: boolean
    docx: boolean
    xlsx: boolean
    pptx: boolean
  }

  outbound: {
    maxBytes: number
    allowStoredAttachment: boolean
    allowWorkspaceFilePath: boolean
  }
}
```

建议默认：

```yaml
attachments:
  enabled: true
  maxInboundBytes: 104857600
  maxAttachmentsPerMessage: 10
  maxExtractedBytes: 5242880
  keepOriginals: true

  extract:
    text: true
    pdf: true
    docx: true
    xlsx: true
    pptx: false

  outbound:
    maxBytes: 104857600
    allowStoredAttachment: true
    allowWorkspaceFilePath: false
```

100MB 是项目 policy 示例；实际 effective limit 必须和平台限制取最小值。

---

# 31. Weixin 当前协议 Drift：必须 M0 修复

当前 `packages/channel-weixin/src/media/upload.ts` 仍有：

```ts
export const WX5_MEDIA_TYPE_IMAGE = 2
```

Tencent 当前 upstream：

```ts
UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
}
```

所以先改：

```ts
export const WEIXIN_UPLOAD_MEDIA_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const
```

禁止 magic number。

---

# 32. Weixin `filesize` 修复

当前：

```ts
rawsize: file.length,
filesize: file.length,
```

正确 upstream 语义：

```text
rawsize = plaintext bytes
filesize = AES-128-ECB + PKCS7 ciphertext bytes
```

必须：

```ts
const rawsize = plaintext.length
const filesize = aesEcbPaddedSize(rawsize)
```

---

# 33. Weixin AES Key 顺序

当前：

```text
getuploadurl
→ random AES key
→ encrypt
```

正确：

```text
random AES key
→ getuploadurl(... aeskey ...)
→ encrypt/upload
```

AES key 必须在 `getuploadurl` 前生成并提交。

`UploadedMedia` 改成成功后关键字段必有：

```ts
export interface UploadedMedia {
  filekey: string
  downloadEncryptedQueryParam: string
  aeskey: string

  /** plaintext */
  fileSize: number

  /** AES ciphertext */
  fileSizeCiphertext: number
}
```

---

# 34. Weixin FILE Inbound

当前 mapper 已经能映射：

```text
MESSAGE_ITEM_TYPE_FILE
→ FilePart(url, name)
```

所以核心工作是把 `adapter.enrichInboundMedia()` 从 image-only 泛化。

```text
ILinkFileItem.media
→ bounded download
→ AES decrypt
→ len validation
→ md5 validation
→ MIME sniff
→ FilePart.localData
→ ctx.emit
```

填：

```ts
part.localData
part.name
part.mimeType
part.size
```

`len` 是 string，必须安全解析；`md5` 存在时对明文校验。

任何错误只让附件失败，不丢文本。

---

# 35. Weixin FILE Outbound

当前：

```text
text ✅
image ✅
file ❌
```

新增 generic upload：

```ts
uploadMedia(file, {
  mediaType: WEIXIN_UPLOAD_MEDIA_TYPE.FILE,
  ...
})
```

File item：

```ts
{
  type: MESSAGE_ITEM_TYPE_FILE,

  file_item: {
    media: {
      encrypt_query_param:
        uploaded.downloadEncryptedQueryParam,

      aes_key:
        Buffer.from(
          uploaded.aeskey,
          'hex',
        ).toString('base64'),

      encrypt_type: 1,
    },

    file_name: fileName,

    len: String(
      uploaded.fileSize,
    ),
  },
}
```

`text + file` 按 Tencent upstream 拆成两个 `sendmessage` 请求，每个 `item_list` 一个 item，共享：

```text
run_id
context_token
```

拆包逻辑属于 Weixin Adapter，不属于 Outbox。

完成真实 inbound+outbound transport 后：

```ts
capabilities.file = true
```

符合当前 ChannelCapabilities 语义。

---

# 36. 其他渠道复用

### QQ

当前 SDK attachment 已映射到 Image/File/Audio/Video Part，但主要是 URL。

补：

```text
authorized URL
→ bounded download
→ localData
→ shared AttachmentPipeline
```

### Lark

当前 image_key/file_key 尚未真正进入 localData。

补：

```text
official SDK/OpenAPI resource download
→ localData
→ shared pipeline
```

### DingTalk

同样只实现平台资源 hydration 和 outbound upload/send。

禁止新增：

```text
QQFileStore
LarkDocumentParser
DingTalkOutbox
WeixinPDFExtractor
```

---

# 37. 推荐 Model Ingress Matrix

保留 transport capability，同时增加 diagnostics：

| Channel | Transport Image | Native Image | Transport File | Extracted File |
|---|---:|---:|---:|---:|
| Weixin 当前 | ✅ | ✅ | ❌ | ❌ |
| Weixin 完成本方案 | ✅ | ✅ | ✅ | ✅ |
| QQ 当前 | ✅ | ❌ | ✅ | ❌ |
| Lark 当前 | ✅ | ❌ | ✅ | ❌ |
| DingTalk 当前 | ✅ | ❌ | ✅ | ❌ |

后续 hydration 接入后独立更新 `Native Image / Extracted File`，不改 transport 语义。

---

# 38. 错误语义

建议：

```text
ATTACHMENT_TOO_LARGE
ATTACHMENT_DOWNLOAD_FAILED
ATTACHMENT_DECRYPT_FAILED
ATTACHMENT_INTEGRITY_FAILED
ATTACHMENT_MIME_MISMATCH
ATTACHMENT_STORE_FAILED
ATTACHMENT_EXTRACT_FAILED
ATTACHMENT_NOT_READABLE
ATTACHMENT_NOT_FOUND
ATTACHMENT_ACCESS_DENIED

OUTBOX_NO_ACTIVE_BINDING
OUTBOX_CHANNEL_NOT_AVAILABLE
OUTBOX_ATTACHMENT_NOT_FOUND
OUTBOX_ATTACHMENT_ACCESS_DENIED
OUTBOX_FILE_PATH_DISABLED
OUTBOX_FILE_TOO_LARGE
OUTBOX_FILE_NOT_REGULAR
```

不要把 ingestion error 一律包装成 `CHANNEL_SEND_FAILED`。

---

# 39. Observability

结构化 telemetry：

```ts
{
  channelId,
  attachmentId,
  direction: 'inbound' | 'outbound',
  kind: 'image' | 'file' | 'audio' | 'video',
  bytes,
  mimeType,

  phase:
    | 'download'
    | 'decrypt'
    | 'store'
    | 'extract'
    | 'upload'
    | 'send',

  outcome,
  durationMs,
}
```

永不记录：

```text
file body
AES key
context token
bot token
AppSecret
bearer URL
```

---

# 40. 代码目录

新增：

```text
packages/channel-harness/src/
  attachments/
    types.ts
    schema.ts
    policy.ts
    filename.ts
    mime.ts
    hash.ts
    store.ts
    pipeline.ts
    render.ts
    tool-read.ts
    extractors/
      types.ts
      registry.ts
      text.ts
      pdf.ts
      docx.ts
      xlsx.ts
    index.ts

  outbox/
    types.ts
    target.ts
    binding-resolver.ts
    attachment-resolver.ts
    service.ts
    tool-send.ts
    index.ts
```

修改：

```text
channel-core/src/messages.ts

channel-harness/src/config.ts
channel-harness/src/plugin.ts
channel-harness/src/lifecycle.ts
channel-harness/src/bridge.ts
channel-harness/src/message-converter.ts
channel-harness/src/binding-store.ts
channel-harness/src/index.ts
channel-harness/package.json

channel-weixin/src/ilink/types.ts
channel-weixin/src/media/upload.ts
channel-weixin/src/media/download.ts
channel-weixin/src/media/send-media.ts
channel-weixin/src/messaging/mapper.ts
channel-weixin/src/messaging/send.ts
channel-weixin/src/adapter.ts
```

---

# 41. Milestone M0 — Weixin Protocol Sync

- [ ] 锁定当前 source baseline。
- [ ] IMAGE=1 / VIDEO=2 / FILE=3 / VOICE=4。
- [ ] `filesize` 改 ciphertext padded size。
- [ ] AES key 在 getuploadurl 前生成。
- [ ] getuploadurl 请求带 aeskey。
- [ ] `UploadedMedia.fileSize`。
- [ ] image outbound regression。
- [ ] contract tests 对齐 Tencent upstream。

**M0 必须先于 FILE outbound。**

---

# 42. Milestone M1 — Unified Binary Contract + Bounded Hydration

- [ ] `BinaryPartBase`。
- [ ] Audio/Video `localData/name/size`。
- [ ] bounded response reader。
- [ ] platform download cap。
- [ ] testkit fixtures。
- [ ] Core Zod/contract tests 不回归。

验收：

```text
existing adapters compile
text/image behavior unchanged
```

---

# 43. Milestone M2 — Private Channel Asset Store

- [ ] `<DSH_HOME>/channels/attachments/v1`。
- [ ] opaque attachment ID。
- [ ] Session ACL。
- [ ] Zod metadata。
- [ ] safe filename。
- [ ] SHA-256。
- [ ] atomic raw/meta/extracted persistence。
- [ ] retention/store-size observability。

最重要验收：

```text
Session A.cwd === Session B.cwd

Session A asset
→ A read PASS
→ B read DENY
```

---

# 44. Milestone M3 — Extractors + Tool

- [ ] text extractor。
- [ ] PDF extractor。
- [ ] DOCX extractor。
- [ ] XLSX extractor。
- [ ] max extracted bytes。
- [ ] `ExtractorRegistry`。
- [ ] official `read_channel_attachment` Tool。
- [ ] Agent-scoped install。
- [ ] line pagination。
- [ ] Session ACL。
- [ ] UserMessage descriptor。

验收：

```text
PDF
→ cha_xxx
→ Agent calls read_channel_attachment
→ reads real extracted content
```

---

# 45. Milestone M4 — Bridge + Weixin FILE 双向

Inbound：

- [ ] Weixin FILE hydrate。
- [ ] AES decrypt。
- [ ] bounded download。
- [ ] len/md5。
- [ ] MIME。
- [ ] FilePart.localData。
- [ ] AttachmentPipeline.prepare。
- [ ] Bridge integration。

Outbound：

- [ ] FILE CDN upload。
- [ ] media_type=3。
- [ ] FILE item。
- [ ] text + file split。
- [ ] runId/contextToken continuity。
- [ ] `capabilities.file=true`。

E2E：

```text
微信 PDF → Harness 真实分析
Harness stored PDF → 微信真实文件
```

---

# 46. Milestone M5 — Explicit Outbox

- [ ] `SessionBindingStore.findBySessionId`。
- [ ] live binding fast path + durable fallback。
- [ ] `ChannelOutboxService`。
- [ ] current active binding validation。
- [ ] `/new` stale Session reject。
- [ ] attachmentId resolver。
- [ ] official `send_channel_message` Tool。
- [ ] no recipient args。
- [ ] `file_path` default disabled。

验收：

```text
无 inbound turn
→ trusted trigger
→ sendToSession()
→ 微信主动收到文本
```

及：

```text
Agent
→ send_channel_message(attachment_id=...)
→ 微信收到真实文件
```

---

# 47. Milestone M6 — Cross-channel Reuse

顺序建议：

```text
Lark
→ QQ
→ DingTalk
```

每个平台只实现：

```text
media/resource hydration
platform outbound upload/send
```

不得重新实现：

```text
asset store
extractors
read tool
outbox
session ACL
```

完成标准：

```text
Lark PDF / QQ PDF
→ 同一 AttachmentPipeline
→ 同一 read_channel_attachment
```

---

# 48. Milestone M7 — Hardening / Live Verification

- [ ] Weixin live FILE inbound。
- [ ] Weixin live FILE outbound。
- [ ] proactive send live。
- [ ] upper-size boundary。
- [ ] corrupted AES。
- [ ] md5 mismatch。
- [ ] oversized stream abort。
- [ ] malformed filename。
- [ ] duplicate media。
- [ ] Session ACL。
- [ ] `/new` ACL。
- [ ] restart binding lookup。
- [ ] README ingress matrix。
- [ ] doctor attachment diagnostics。
- [ ] release notes。
- [ ] upstream compatibility reference。

---

# 49. 关键测试矩阵

## Asset ACL

```text
A reads A                    PASS
B reads A                    DENY
A/B same cwd, B reads A      DENY
/new B reads old A asset     DENY
```

## Tool

```text
current attachment           PASS
unknown id                   NOT FOUND
foreign session              DENY
offset/limit                 PASS
output cap                   ENFORCED
abort signal                 PASS
```

## Weixin protocol

```text
IMAGE media_type             1
VIDEO media_type             2
FILE media_type              3
VOICE media_type             4
rawsize                      plaintext
filesize                     AES ciphertext padded
aeskey in getuploadurl       PASS
file len                     plaintext size
file aes_key                 base64
encrypt_type                 1
```

## Weixin inbound

```text
text                         PASS
image                        ImageBlock
PDF                          asset + extraction
TXT                          asset + extraction
wrong AES                    file fails, text survives
bad md5                      file fails, text survives
oversized                    file fails, text survives
```

## Outbox

```text
current binding              PASS
durable binding after restart PASS
unknown session              REJECT
old session after /new       REJECT
stored attachment            PASS
foreign attachment           DENY
recipient argument           DOES NOT EXIST
file_path default            DISABLED
```

---

# 50. E2E 链路

## A. 微信发 PDF

```text
Weixin FILE item
→ bounded CDN download
→ AES decrypt
→ FilePart.localData
→ SessionBinding
→ ChannelInboundAssetStore
→ PDF Extractor
→ cha_123 + extracted.md
→ UserMessage descriptor
→ Agent
→ read_channel_attachment(cha_123)
→ answer
→ ReplyRouter
→ Weixin
```

## B. 微信图片

```text
ImagePart.localData
→ ctx.attachments.saveImage
→ ImageBlock
→ Agent
```

## C. Agent 主动重发用户附件

```text
send_channel_message(
  attachment_id="cha_123"
)
→ session ACL
→ raw.bin
→ FilePart.localData
→ Outbox
→ Weixin FILE upload/send
```

## D. 后台任务完成通知

```text
Job complete
→ trusted plugin
→ outbox.sendToSession(sessionId, { text })
→ current binding
→ adapter.send
```

不伪造 ReplyContext。

## E. Lark 复用

```text
Lark file_key
→ official download
→ FilePart.localData
---------------- common boundary ----------------
→ AttachmentPipeline
→ private store
→ extractor
→ read_channel_attachment
```

---

# 51. 明确不做

```text
自造 Harness Generic FileBlock
把 PDF 伪装成 Image Attachment
修改 Harness AttachmentStore
依赖不存在的 ctx.fs.writeBytes

把所有 bound Session 输出自动发渠道
放宽 ReplyContext gate

模型指定 arbitrary recipient
默认 arbitrary file_path
读取 Host 任意文件

ZIP 自动展开
EXE/脚本自动执行

每个渠道各写一套文件 Store/Parser/Outbox
```

---

# 52. 安全红线

1. Adapter 不调用 Harness Agent API。
2. Core 不依赖 Harness。
3. Harness bridge 不依赖平台 SDK。
4. Secret/AES/CDN bearer 信息不进入模型。
5. Generic binary 不伪装成 Harness native attachment。
6. 附件 ACL 不依赖 shared cwd。
7. 每个 private asset 必须绑定 Session。
8. `read_channel_attachment` 校验 `exec.agent`。
9. `send_channel_message` 不接收 recipient。
10. ReplyRouter ReplyContext gate 不得放宽。
11. Outbox 只允许 current active binding。
12. `/new` 后旧 Session 默认失去 Outbox authority。
13. 下载/读取必须 bounded。
14. extracted output 必须 bounded。
15. 文件名必须 sanitize。
16. 内容不得进入日志。
17. `file_path` 默认关闭。
18. 开启 `file_path` 时用 `ctx.fs.resolve/stat/readBytes`。
19. 图片继续使用官方 `ctx.attachments`。
20. Generic native File/Audio/Video 等 Harness 官方 Contract。

---

# 53. PR 拆分

```text
PR-1  fix(weixin): sync iLink upload contract with Tencent upstream
PR-2  feat(core): unify binary message part fields
PR-3  feat(harness): add private channel asset store
PR-4  feat(harness): add document extractors and read_channel_attachment
PR-5  feat(harness): integrate attachment pipeline into channel bridge
PR-6  feat(weixin): support inbound and outbound file transport
PR-7  feat(harness): add durable channel outbox and send_channel_message
PR-8  feat(lark): hydrate inbound media into shared pipeline
PR-9  feat(qq): hydrate inbound media into shared pipeline
PR-10 test(channels): harden attachment ACL and cross-channel contracts
```

不要一个 PR 同时大改全部平台。

---

# 54. Definition of Done

### Architecture

- [ ] Attachment Pipeline 不 import platform package。
- [ ] Platform Adapter 不 import `channel-harness`。
- [ ] Core 不 import Harness。
- [ ] ReplyRouter gate 不变。
- [ ] ChannelCapabilities 仍然只表示 transport。

### Image

- [ ] 微信图片不回归。
- [ ] 图片仍 `ctx.attachments.saveImage()`。
- [ ] 模型收到真实 ImageBlock。

### File

- [ ] 微信 FILE 下载/AES/完整性成功。
- [ ] Generic binary 进入 Private Asset Store。
- [ ] PDF/TXT/DOCX/XLSX 首期支持。
- [ ] Agent 用 `read_channel_attachment` 读取真实内容。
- [ ] 不存在自造 FileBlock。

### Security

- [ ] A/B 同 cwd 时仍不能跨 Session 读附件。
- [ ] `/new` 不继承旧附件。
- [ ] Tool 不能指定外部 recipient。
- [ ] 默认不能发送 arbitrary host file。
- [ ] oversized stream 及时 abort。

### Weixin

- [ ] upload contract 与 Tencent upstream 对齐。
- [ ] FILE `media_type=3`。
- [ ] FILE send item 正确。
- [ ] text + file runId/contextToken 正确。
- [ ] `capabilities.file=true` 与真实 transport 一致。

### Active Send

- [ ] `ChannelOutboxService.sendToSession()`。
- [ ] restart 后 current binding 可反查。
- [ ] old `/new` Session 拒绝。
- [ ] Tool 主动发送文本。
- [ ] Tool 主动发送 current Session stored attachment。

### Reuse

- [ ] 至少第二个渠道复用同一 Pipeline。
- [ ] 第二个渠道没有第二套 Store/Extractor/Read Tool/Outbox。

---

# 55. Source of Truth

## dsh-channels

- 当前核验 commit：  
  <https://github.com/wsz987/dsh-channels/tree/eb1a828af459dd8d944a692dd0ab285e8cc82b19>
- Core messages：  
  <https://github.com/wsz987/dsh-channels/blob/main/packages/channel-core/src/messages.ts>
- Capabilities：  
  <https://github.com/wsz987/dsh-channels/blob/main/packages/channel-core/src/capabilities.ts>
- Zod schemas：  
  <https://github.com/wsz987/dsh-channels/blob/main/packages/channel-core/src/schema.ts>
- Harness Bridge：  
  <https://github.com/wsz987/dsh-channels/blob/main/packages/channel-harness/src/bridge.ts>
- Message Converter：  
  <https://github.com/wsz987/dsh-channels/blob/main/packages/channel-harness/src/message-converter.ts>
- ReplyRouter：  
  <https://github.com/wsz987/dsh-channels/blob/main/packages/channel-harness/src/reply-router.ts>
- SessionBinding：  
  <https://github.com/wsz987/dsh-channels/blob/main/packages/channel-harness/src/session-router.ts>
- Binding Store：  
  <https://github.com/wsz987/dsh-channels/blob/main/packages/channel-harness/src/binding-store.ts>
- Workspace Resolver：  
  <https://github.com/wsz987/dsh-channels/blob/main/packages/channel-harness/src/workspace-resolver.ts>
- Weixin Adapter：  
  <https://github.com/wsz987/dsh-channels/blob/main/packages/channel-weixin/src/adapter.ts>
- Weixin upload：  
  <https://github.com/wsz987/dsh-channels/blob/main/packages/channel-weixin/src/media/upload.ts>

## Tencent Weixin

- Types：  
  <https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts>
- CDN upload：  
  <https://github.com/Tencent/openclaw-weixin/blob/main/src/cdn/upload.ts>
- Media download：  
  <https://github.com/Tencent/openclaw-weixin/blob/main/src/media/media-download.ts>
- Media send：  
  <https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/send.ts>

## DeepSeek Harness

- Repository：  
  <https://github.com/deepseek-ai/deepseek-harness>
- Reference：  
  <https://deepseek-harness.github.io/deepseek-harness/reference/>
- Image attachment：  
  <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.zh.md>
- Attachment package：  
  <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/attachment/README.md>
- FS provider：  
  <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/fs/README.md>
- FS tools：  
  <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs/README.md>
- Tool development：  
  <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.zh.md>

---

# 56. 最终开工顺序

```text
M0  Weixin protocol drift
 ↓
M1  Binary Contract + bounded download
 ↓
M2  Private Channel Asset Store
 ↓
M3  Extractors + read_channel_attachment
 ↓
M4  Bridge + Weixin FILE inbound/outbound
 ↓
M5  Outbox + send_channel_message
 ↓
M6  Lark / QQ / DingTalk reuse
 ↓
M7  Security + Live E2E + Release
```

---

# 57. 最终一句话原则

> **平台 Adapter 负责把“平台附件”变成可信统一字节；`channel-harness` 用 Session ACL 管理这些字节，图片投影到 Harness 官方 Image Attachment，普通文档通过私有 Asset Store + 官方 Tool API 提供可分页理解；主动发送始终走显式 Outbox，绝不放宽 ReplyRouter。**

这套设计与当前 `dsh-channels main@eb1a828`、DeepSeek Harness 现有 Attachment/FS/Tool 边界一致，也能让 Weixin、QQ、飞书、钉钉真正复用同一附件主链路。
