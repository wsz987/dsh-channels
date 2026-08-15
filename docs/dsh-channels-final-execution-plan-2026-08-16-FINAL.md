# dsh-channels 最终执行文档：Upstream-First、原生图片附件、通用文件理解与主动消息

> 项目：`wsz987/dsh-channels`  
> 仓库：`https://github.com/wsz987/dsh-channels`  
> 核验基线：`main@eddab2996ab47a7559f6c1135b3e40be9e5cc68b`  
> 核验日期：2026-08-16  
> Host：DeepSeek Harness  
> 状态：**FINAL / Execution Ready / 开工基线**  
> 最终修订：2026-08-16  
> 本文取代此前所有 `unified-attachments/outbox`、Upstream-First 草案与 2026-08-16 第一版执行文档。

---

# 0. 最终原则

本项目的目标不是重新实现微信、QQ、飞书、钉钉渠道插件。

最终定位必须固定为：

> **`dsh-channels` = DeepSeek Harness 对官方渠道实现的 Adapter / Bridge。**

因此：

```text
DeepSeek Harness 专属能力
        +
官方渠道 SDK / host-neutral upstream
        ↓
极薄 Channel Adapter
```

而不是：

```text
看官方 OpenClaw 插件源码
        ↓
在 dsh-channels 再实现一套平台协议
```

最终红线：

> **DSH 自己做宿主适配，不重新实现平台协议。**

---

# 1. 最终结论

此前方案中以下设计继续保留：

```text
Channel Contract
SessionBinding
ReplyContext / ReplyRouter
Harness Native Image Attachment（现有能力，继续复用）
Generic File Private Asset Store（新增补充能力）
read_channel_attachment
ChannelOutboxService
send_channel_message
Session ACL
/new 后旧 Session 失权
resourceRef
localData
SSRF / bounded hydration
```

以下部分必须修正：

```text
❌ 不再扩大自研平台协议实现
❌ 不再为四个渠道分别写完整 media SDK
❌ 不再在 DSH 内复制官方插件的 token/upload/download/send 算法
❌ 不再把官方 OpenClaw 插件仅作为“代码参考”

✅ 官方 SDK / host-neutral upstream 是平台行为 Source of Truth
✅ DSH Adapter 只做映射、生命周期、能力声明和 Harness 接线
✅ 官方插件没有稳定公共 API 时，使用隔离 Compatibility Facade
✅ Compatibility Facade 不得复制协议算法
```

---

# 1A. 当前 Attachment 基线：图片链路已经完成，禁止重复建设

这是本最终版相对上一版最重要的状态修正。

截至本执行基线：

```text
DeepSeek Harness 官方 Attachment v1
= Durable Image Attachments
= PNG / JPEG / WebP / GIF
= validateImage / saveImage / readImage
```

`dsh-channels` 当前已经完成公共 Harness 图片桥接：

```text
ImagePart.localData
        ↓
channel-harness/message-converter.ts
        ↓
ctx.attachments.saveImage()
        ↓
ImageAttachmentRef
        ↓
Harness ImageBlock
        ↓
模型真实看到图片
```

现有代码状态：

```text
channel-core/ImagePart.localData                ✅ 已存在
channel-core/FilePart.localData                 ✅ 已存在
channel-harness SaveImageHook                   ✅ 已存在
channel-harness ctx.get('attachments') 注入      ✅ 已存在
channel-harness ImageBlock 转换                  ✅ 已存在
Weixin inbound image → localData                ✅ 已接通
QQ inbound image → localData                    ⏳ 未接通
Lark inbound image → localData                  ⏳ 未接通
DingTalk inbound image → localData              ⏳ 未接通
```

因此本项目**不再设计第二套 Harness 图片附件系统**，也不再把“接图片”绑定到 Generic File Asset Store。

准确边界：

```text
Native Image Attachment
= Harness 官方能力
= dsh-channels 公共桥已完成
= 剩余工作只是平台图片字节 hydration

Generic File Asset Pipeline
= dsh-channels 自有 Harness 集成能力
= 用于 PDF / DOCX / XLSX / Text 等文件
= 因 Harness v1 没有 FileAttachment/FileBlock 而存在
```

### 当前能力矩阵

| 能力 | Harness | Weixin | QQ | Lark | DingTalk |
|---|---|---:|---:|---:|---:|
| Text | ✅ | ✅ | ✅ | ✅ | ✅ |
| Native `ImageBlock` | ✅ | ✅ | ⏳ | ⏳ | ⏳ |
| Image `localData` 消费 | ✅ | ✅ | ❌ | ❌ | ❌ |
| Generic File Attachment | ❌ | — | — | — | — |
| DSH Private File Asset Store | 非官方 | ⏳ | ⏳ | ⏳ | ⏳ |
| PDF/DOCX/XLSX 理解 | 非官方 | ⏳ | ⏳ | ⏳ | ⏳ |
| Native AudioBlock | ❌ | ❌ | ❌ | ❌ | ❌ |
| Native VideoBlock | ❌ | ❌ | ❌ | ❌ | ❌ |

硬性结论：

> **QQ / Lark / DingTalk 图片接入是一个小型 Adapter/Upstream 任务，不是附件架构任务。**

> **为了接通这三个渠道的图片，不修改 `channel-harness` 图片公共链路。**

---

# 2. 当前真实依赖状态

当前 `dsh-channels` 并没有直接依赖四个 OpenClaw 渠道插件本身。

## QQ

当前：

```json
"@tencent-connect/qqbot-nodejs": "1.0.4"
```

官方 OpenClaw QQ 插件：

```text
@tencent-connect/openclaw-qqbot
```

其底层同样依赖：

```text
@tencent-connect/qqbot-nodejs
```

结论：

```text
QQ 当前方向正确。
不用接整包 OpenClaw plugin。
继续直接复用 qqbot-nodejs。
```

---

## Lark / Feishu

当前：

```json
"@larksuiteoapi/node-sdk": "1.73.0"
```

官方 OpenClaw 飞书插件：

```text
@larksuite/openclaw-lark
```

其底层同样使用：

```text
@larksuiteoapi/node-sdk
```

官方插件已经实现并验证：

```text
client.im.messageResource.get()
client.im.image.create()
client.im.file.create()
client.im.message.create()
client.im.message.reply()
```

结论：

```text
Lark 当前方向正确。
不要接整包 OpenClaw plugin runtime。
直接通过 node-sdk 实现薄 Port。
```

---

## DingTalk

当前：

```json
"dingtalk-stream": "2.1.5"
```

官方：

```text
@dingtalk-real-ai/dingtalk-connector@0.8.24
```

官方 connector 同样依赖：

```text
dingtalk-stream
axios
form-data
```

结论：

```text
Stream 层继续直接复用 dingtalk-stream。
OpenAPI / media / card 行为严格对齐官方 connector。
不要把 dsh 的 DingTalkOfficialUpstream 扩成第二套 DingTalk SDK。
```

---

## Weixin

当前：

```text
channel-weixin
自己实现：
- iLink client
- QR auth
- getUpdates
- sendMessage
- getuploadurl
- CDN upload/download
- AES
- context token
```

官方：

```text
@tencent-weixin/openclaw-weixin@2.4.6
```

该包本身就是 Tencent 当前 iLink 实现，并没有独立：

```text
@tencent-weixin/ilink-sdk
```

结论：

```text
Weixin 是当前重复实现最重的渠道。
必须优先进行 Upstream Consolidation。
```

---

# 3. Source of Truth

最终按以下优先级执行。

## 3.1 DeepSeek Harness 层

第一优先级：

```text
项目实际安装的 @deepseek-ai/* package
项目 lockfile
项目 typecheck / compatibility tests
```

当前项目 family：

```text
^0.1.0-rc.6
```

所有新增 Harness package：

```text
@deepseek-ai/dsh-tools
@deepseek-ai/dsh-fs（如需要）
```

必须与项目 DSH family 保持同一版本策略。

---

## 3.2 平台层

平台行为优先级：

```text
官方 SDK / 官方 host-neutral module
        ↓
官方 OpenClaw channel plugin
        ↓
官方平台 API 文档
        ↓
dsh compatibility fixture
```

禁止：

```text
dsh 自己设计平台 payload
然后让测试去证明它“差不多能工作”
```

应该：

```text
官方 upstream 的行为
→ 固化成 compatibility contract
→ DSH Adapter 只转换 shape
```

---

# 4. 官方上游版本基线

执行开始时固定 compatibility manifest：

```yaml
upstreams:
  weixin:
    package: "@tencent-weixin/openclaw-weixin"
    version: "2.4.6"
    repository: "Tencent/openclaw-weixin"

  qq:
    pluginPackage: "@tencent-connect/openclaw-qqbot"
    pluginVersion: "2.0.1"
    sdkPackage: "@tencent-connect/qqbot-nodejs"
    sdkVersion: "1.0.4"
    repository: "tencent-connect/openclaw-qqbot"

  lark:
    pluginPackage: "@larksuite/openclaw-lark"
    pluginVersion: "2026.7.9"
    sdkPackage: "@larksuiteoapi/node-sdk"
    dshCurrentSdkVersion: "1.73.0"
    repository: "larksuite/openclaw-lark"

  dingtalk:
    pluginPackage: "@dingtalk-real-ai/dingtalk-connector"
    pluginVersion: "0.8.24"
    streamPackage: "dingtalk-stream"
    dshCurrentStreamVersion: "2.1.5"
    repository: "DingTalk-Real-AI/dingtalk-openclaw-connector"
```

注意：

```text
官方插件版本是 compatibility oracle，
不是要求把 OpenClaw runtime 装进 DSH。
```

---

# 5. 总体架构

```text
┌─────────────────────────────────────────────┐
│              DeepSeek Harness               │
│                                             │
│ Agent / Session / Tool / Attachment / FS    │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│             @wsz987/channel-harness         │
│                                             │
│ SessionBinding                              │
│ AttachmentPipeline                          │
│ ChannelInboundAssetStore                    │
│ read_channel_attachment                     │
│ ChannelOutboxService                        │
│ send_channel_message                        │
└──────────────────────┬──────────────────────┘
                       │ Channel Contract
                       ▼
┌─────────────────────────────────────────────┐
│              Channel Adapters               │
│                                             │
│ WeixinAdapter                               │
│ QQAdapter                                   │
│ LarkAdapter                                 │
│ DingTalkAdapter                             │
│ TelegramAdapter                             │
│                                             │
│ 职责：                                      │
│ - 生命周期                                  │
│ - Raw ↔ MessagePart                         │
│ - Target 映射                               │
│ - upstream capability bridge                │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│            Official Upstream Layer          │
│                                             │
│ Weixin → Tencent iLink implementation       │
│ QQ     → qqbot-nodejs                       │
│ Lark   → @larksuiteoapi/node-sdk            │
│ Ding   → dingtalk-stream + official OAPI    │
└─────────────────────────────────────────────┘
```

---

# 6. 包依赖红线

允许：

```text
channel-harness
  → channel-core
  → DeepSeek Harness APIs

channel-qq
  → channel-core
  → qqbot-nodejs

channel-lark
  → channel-core
  → @larksuiteoapi/node-sdk

channel-dingtalk
  → channel-core
  → dingtalk-stream
  → DingTalk minimal OAPI client

channel-weixin
  → channel-core
  → WeixinUpstreamPort
```

禁止：

```text
channel-core → Harness
channel-core → Tencent/Lark/DingTalk SDK

channel-harness → platform SDK

QQAdapter → OpenClaw runtime
LarkAdapter → OpenClaw runtime
DingTalkAdapter → OpenClaw runtime
WeixinAdapter → OpenClaw runtime

Adapter → 自己实现平台加密/协议算法
```

---

# 7. Upstream Port 规则

每个渠道允许有一个薄 Port。

示例：

```ts
interface ChannelMediaPort {
  downloadResource(...): Promise<Uint8Array>
  uploadResource(...): Promise<PlatformResourceRef>
}
```

Port 的目标不是重新抽象一个“万能 SDK”。

Port 只解决：

```text
官方 API shape
        ↓
DSH Adapter 可测试的最小接口
```

规则：

```text
1. Port 方法数量必须小。
2. 一个平台 API 方法只封装一层。
3. 不重新定义官方协议。
4. 不自行维护 token/retry/reconnect，除非 SDK 不提供。
5. 不自行实现官方已有的 AES/streaming/upload 算法。
6. tests fake Port，而不是 fake 网络协议。
```

---

# 8. Channel Core Binary Contract

统一：

```ts
export type BinaryIngressFailureCode =
  | 'too-large'
  | 'download-failed'
  | 'decrypt-failed'
  | 'integrity-failed'
  | 'mime-invalid'
  | 'resource-unavailable'

export interface BinaryPartBase {
  /**
   * 只有真正的 http(s) URL 才放这里。
   */
  url?: string

  /**
   * 平台 opaque handle。
   *
   * 例如：
   * Lark image_key
   * Lark file_key
   * Telegram file_id
   * DingTalk mediaId
   */
  resourceRef?: string

  dataUri?: string

  /**
   * upstream 解析完成后的可信字节。
   */
  localData?: Uint8Array

  mimeType?: string
  name?: string
  size?: number

  ingressFailure?: BinaryIngressFailureCode
}
```

---

# 9. `url` 与 `resourceRef`

固定：

```text
https://...               → url
http://...                → url（是否允许由安全策略决定）

image_key                 → resourceRef
file_key                  → resourceRef
file_id                   → resourceRef
mediaId                   → resourceRef
encrypt_query_param       → upstream private state，不进入 Core
AES key                   → upstream private state，不进入 Core
```

禁止：

```text
resourceRef
→ generic fetch(resourceRef)
```

必须：

```text
resourceRef
→ platform upstream
→ bytes
```

---

# 10. Pure Mapper

所有 Adapter 固定：

```text
Raw Platform Event
        ↓
Pure Mapper
        ↓
MessagePart
```

Mapper：

```text
无网络
无磁盘
无 Harness API
无 secrets
无 token refresh
无 media download
无 AES
```

---

# 11. Media Hydration

Mapper 后：

```text
MessagePart
        ↓
PlatformMediaHydrator
        ↓
official upstream
        ↓
localData
        ↓
ctx.emit()
```

Hydrator 本身仍然属于渠道 Adapter 层。

但是：

```text
Hydrator 不实现平台协议。
Hydrator 只调用 Upstream Port。
```

---

# 12. Secure Remote URL

当平台官方 upstream 返回真正 URL，而不是 opaque handle 时：

```text
url
→ SecureRemoteMediaFetcher
```

公共安全约束：

```text
https 默认
DNS private IP reject
loopback reject
link-local reject
redirect every hop re-check
max redirects
Content-Length pre-check
streaming byte cap
response header timeout
read idle timeout
AbortSignal
cross-origin auth header stripping
```

---

# 13. 为什么 SecureRemoteMediaFetcher 不算造轮子

它不是：

```text
QQ media downloader
Lark downloader
DingTalk downloader
```

它是：

```text
DSH host 的通用不可信远程二进制安全边界
```

官方平台插件即使有下载函数：

```text
也可能假设 OpenClaw 自己的 media runtime。
```

DSH 需要自己的 host security seam 是合理的。

但是：

```text
如果 upstream SDK 自己已经安全地返回 Buffer/stream，
DSH 不再额外 HTTP 下载。
```

---

# 14. Weixin 最终策略

## 14.1 判断

当前 Weixin 重复最多。

所以第一阶段不是：

```text
修自己写的协议直到跟 Tencent 一致
```

而是：

```text
最大化复用 Tencent iLink implementation
```

---

# 15. Weixin Upstream Consolidation

新增：

```text
packages/channel-weixin/src/upstream/
  port.ts
  tencent-upstream.ts
  compat.ts
  index.ts
```

接口只保留 DSH 真正需要的：

```ts
export interface WeixinUpstream {
  beginQrAuth(...): Promise<...>
  pollQrAuth(...): Promise<...>

  startMonitor(...): Promise<void>
  stopMonitor(): Promise<void>

  sendText(...): Promise<...>

  downloadImage(...): Promise<...>
  downloadFile(...): Promise<...>

  sendImage(...): Promise<...>
  sendFile(...): Promise<...>
}
```

---

# 16. Tencent Weixin 包复用规则

目标包：

```text
@tencent-weixin/openclaw-weixin@2.4.6
```

不允许导入：

```text
root plugin entry
OpenClawPluginApi
api.registerChannel
```

优先寻找：

```text
dist/api/*
dist/auth/*
dist/cdn/*
dist/media/*
dist/messaging/*
```

host-neutral module。

如果这些路径：

```text
可以直接 import
且不 import openclaw/plugin-sdk
```

则：

```text
WeixinTencentUpstream
→ 直接调用
```

---

# 17. Weixin 内部 subpath 不稳定时

Tencent 当前没有承诺：

```text
"./cdn"
"./media"
"./api"
```

这种稳定 npm exports。

因此如果消费内部路径：

```text
必须 exact pin
```

禁止：

```json
"@tencent-weixin/openclaw-weixin": "^2.4.6"
```

使用：

```json
"@tencent-weixin/openclaw-weixin": "2.4.6"
```

并增加 CI：

```text
weixin-upstream-import-smoke
weixin-upstream-contract
weixin-package-shape-check
```

升级流程：

```text
Dependabot/manual update
        ↓
package-shape smoke
        ↓
contract fixtures
        ↓
live optional test
        ↓
merge
```

---

# 18. 如果 Tencent internal module 仍强依赖 OpenClaw

此时不把 OpenClaw runtime 带进 DSH。

优先级：

```text
1. 看 Tencent 包是否存在更底层 host-neutral module。
2. 向 Tencent upstream 提 issue/PR 暴露 public core API。
3. 在 DSH 保留最薄 Compatibility Shim。
```

Compatibility Shim 只允许：

```text
构造官方请求对象所需的最小 glue
```

不允许：

```text
重新实现一套完整 iLink SDK。
```

---

# 19. Weixin 现有自产代码处理

当前：

```text
ilink/
media/
messaging/
auth/
```

逐模块分类：

```text
A. Tencent 可直接复用
   → 删除自产实现

B. Tencent 内部 module 可用但 API 不稳定
   → tencent-upstream.ts 封装
   → 删除重复实现

C. Tencent 与 OpenClaw runtime 强耦合
   → 暂保留 minimal shim
   → 标记 upstream-gap
```

禁止一次性大删。

必须按模块迁移并做行为对照。

---

# 20. Weixin 必须删除的重复逻辑目标

最终应尽可能删除/收缩：

```text
自己维护 media type enum
自己维护 AES padding 算法
自己维护 CDN query 组装
自己维护 getuploadurl payload
自己维护 sendmessage media payload
自己维护 protocol endpoint table
```

这些应该来自 Tencent upstream。

DSH 保留：

```text
WeixinAdapter
WeixinUpstream interface
Core mapper
Session metadata mapping
DSH lifecycle integration
```

---

# 21. QQ 最终策略

QQ 继续：

```text
@tencent-connect/qqbot-nodejs
```

不直接加载：

```text
@tencent-connect/openclaw-qqbot root plugin
```

原因：

```text
root plugin 依赖 OpenClawPluginApi。
```

官方 OpenClaw 插件仍作为：

```text
behavior oracle
compatibility fixture source
```

---

# 22. QQ Upstream Port

当前 `TencentQQSdkClient` 已经基本符合最终结构。

保留并收缩：

```ts
interface QQSdkClient {
  start(...)
  stop()

  onMessage(...)
  onReady(...)
  onResumed(...)
  onError(...)

  sendText(...)
  sendMedia(...)
  openStream(...)
}
```

这是良好边界。

---

# 23. QQ Media

QQ 图片 inbound 属于 **M2A Native Image Ingress**，不等待 Generic File Pipeline。

Inbound image：

```text
QQ SDK attachment.url
→ pure mapper 保留真实 URL
→ shared SecureRemoteMediaFetcher
→ Uint8Array
→ ImagePart.localData + mimeType
→ 现有 channel-harness saveImage()
→ Harness ImageBlock
```

Generic file/audio/video hydration 则按后续对应能力里程碑推进，不为了“类型对称”提前下载所有媒体。

Outbound：

```text
localData
→ Buffer.toString('base64')
→ qqbot-nodejs sendMedia(fileData)
```

不允许：

```text
自己调用 QQ upload endpoint
自己实现 QQ token refresh
自己实现 websocket gateway
```

这些全部属于 `qqbot-nodejs`。

---

# 24. QQ 官方插件复用边界

官方 `@tencent-connect/openclaw-qqbot` 已公开：

```text
sendText
sendMedia
QQBotGateway
StreamingController
...
```

但根模块仍 import OpenClaw runtime。

因此当前不建议：

```text
import { sendMedia } from '@tencent-connect/openclaw-qqbot'
```

除非以后官方提供：

```text
@tencent-connect/openclaw-qqbot/core
```

且不依赖 OpenClaw host。

到那时再替换 `QQSdkClient` 内部实现即可。

---

# 25. Lark 最终策略

Lark 直接使用：

```text
@larksuiteoapi/node-sdk
```

当前版本：

```text
1.73.0
```

不直接加载：

```text
@larksuite/openclaw-lark
```

---

# 26. LarkMediaPort

`downloadMessageResource()` 的 image 分支属于 **M2A Native Image Ingress**；upload/file 能力留在后续 Generic Media/Outbox 里程碑。

新增：

```text
packages/channel-lark/src/upstream/
  media-port.ts
```

接口：

```ts
export interface LarkMediaPort {
  downloadMessageResource(input: {
    messageId: string
    resourceKey: string
    type: 'image' | 'file'
    signal?: AbortSignal
  }): Promise<{
    data: Uint8Array
    mimeType?: string
    name?: string
  }>

  uploadImage(input: {
    data: Uint8Array
    signal?: AbortSignal
  }): Promise<{
    imageKey: string
  }>

  uploadFile(input: {
    data: Uint8Array
    name: string
    fileType: string
    durationMs?: number
    signal?: AbortSignal
  }): Promise<{
    fileKey: string
  }>
}
```

实现内部：

```text
node-sdk
```

---

# 27. Lark 官方行为

严格使用：

```text
client.im.messageResource.get()
client.im.image.create()
client.im.file.create()
client.im.message.create()
client.im.message.reply()
```

禁止：

```text
自己拼 /open-apis/im/v1/... URL
自己实现 tenant token
自己实现 Feishu retry/token cache
```

---

# 28. Lark Mapper 修正

当前：

```text
image_key → picUrl
file_key → mediaUrl
→ MessagePart.url
```

最终：

```text
image_key → resourceRef
file_key  → resourceRef
```

并保留：

```text
messageId
```

供：

```text
messageResource.get(message_id, file_key)
```

解析。

因此必要时为 binary part 增加：

```ts
resourceContext?: {
  messageId?: string
}
```

更推荐：

```text
把 messageId 放 Hydrator invocation context
而不是持久化到通用 BinaryPart。
```

---

# 29. Lark 不复制官方插件 parser/store

官方飞书插件有大量：

```text
doc/wiki/drive/task/calendar
media helpers
OpenClaw-specific tools
```

本项目当前附件目标不需要全部搬进来。

禁止：

```text
复制 larksuite/openclaw-lark/src/tools/*
复制它的 OpenClaw Session/runtime abstraction
```

只复用：

```text
正确官方 API 方法与平台行为。
```

---

# 30. DingTalk 最终策略

分成两层：

```text
DingTalkStreamPort
DingTalkOpenApiPort
```

---

# 31. DingTalk Stream

直接使用：

```text
dingtalk-stream
```

负责：

```text
连接
Stream callback
reconnect（SDK 能力范围内）
event receive
```

禁止：

```text
自研 DingTalk Stream websocket protocol。
```

---

# 32. DingTalk OpenAPI

官方 connector：

```text
@dingtalk-real-ai/dingtalk-connector@0.8.24
```

是 payload / media / card 行为 oracle。

当前其 npm exports 只有：

```text
"."
"./bundled"
```

根入口依赖 OpenClaw。

因此现阶段：

```text
不能把整包当 host-neutral SDK 直接用。
```

---

# 32A. DingTalk Native Image Ingress

DingTalk 图片同样提前到 **M2A**。

处理原则：

```text
真实可下载 picUrl/mediaUrl
→ shared SecureRemoteMediaFetcher
→ ImagePart.localData
→ 现有 Harness ImageBlock
```

如果平台事件给的是 `mediaId`/opaque handle：

```text
mediaId
→ ImagePart.resourceRef
→ DingTalkOpenApiPort.resolveMedia(...)
→ Uint8Array
→ ImagePart.localData
```

这里禁止为了图片另写一套 DingTalk HTTP SDK；必须复用 `dingtalk-stream` / 官方 connector 行为与最薄 OpenAPI Port。

---

# 33. DingTalkOpenApiPort

必须保持小：

```ts
interface DingTalkOpenApiPort {
  getAccessToken(...): Promise<string>

  sendProactiveText(...): Promise<...>

  uploadMedia(...): Promise<...>

  sendMedia(...): Promise<...>

  createCard(...): Promise<...>
  updateCard(...): Promise<...>
  finishCard(...): Promise<...>
}
```

但实现规则：

```text
每个方法必须链接/记录对应官方 connector 实现位置。
payload contract 来自官方 connector。
```

---

# 34. 当前 DingTalkOfficialUpstream 处理

当前已经自己实现：

```text
access token
sessionWebhook text
AI Card create/update
```

不立即删除。

先改名/定位为：

```text
DingTalkOpenApiPortImpl
```

然后：

```text
逐方法对齐官方 connector
删除任何无官方行为依据的自定义协议
```

以后官方 connector 若暴露：

```text
./media
./messaging
./openapi
```

host-neutral subpath：

```text
立即替换内部实现。
```

Adapter 无需改。

---

# 35. DingTalk sessionWebhook

sessionWebhook：

```text
只属于当前 inbound reply。
```

不能作为 Outbox durable route。

因此：

```text
ReplyRouter
→ sessionWebhook
```

可以。

但是：

```text
ChannelOutboxService
→ old sessionWebhook
```

禁止。

主动消息：

```text
必须走官方 proactive API。
```

---

# 36. 不把 OpenClaw 插件当 DSH Runtime

四个插件共同问题：

```text
root entry
→ OpenClawPluginApi
→ api.registerChannel()
→ OpenClaw runtime
```

因此：

```text
不能把插件 root 直接作为 DeepSeek Harness ChannelAdapter。
```

这样做反而会产生：

```text
DSH Host
  嵌 OpenClaw Host semantics
```

这是错误方向。

---

# 37. 允许使用官方插件 internal module 吗

规则：

## Public host-neutral export

```text
✅ 直接使用
```

## Internal module，但 npm 包稳定包含

```text
⚠️ 可以通过隔离 Facade 使用
```

要求：

```text
exact pin
package-shape smoke
contract test
单一 import 文件
禁止项目各处散落 deep import
```

## Internal module import OpenClaw runtime

```text
❌ 不使用
```

---

# 38. Compatibility Facade

如果必须 deep import，只允许：

```text
packages/channel-xxx/src/upstream/vendor-compat.ts
```

一个文件。

禁止：

```text
adapter.ts deep import
mapper.ts deep import
outbound.ts deep import
10 个文件分别依赖官方 internal path
```

这样未来官方 package 改目录：

```text
只改 vendor-compat.ts
```

---

# 39. Upstream Compatibility Manifest

每个渠道提供：

```ts
interface UpstreamManifest {
  channel: string

  packageName: string
  testedVersion: string

  strategy:
    | 'official-sdk'
    | 'official-host-neutral-subpath'
    | 'minimal-official-api-port'

  sourceRepository: string

  contractFixtures: readonly string[]
}
```

`channels doctor` 输出：

```text
QQ
upstream = @tencent-connect/qqbot-nodejs@1.0.4
strategy = official-sdk
status = compatible

Lark
upstream = @larksuiteoapi/node-sdk@1.73.0
strategy = official-sdk
status = compatible

Weixin
upstream = @tencent-weixin/openclaw-weixin@2.4.6
strategy = official-host-neutral-subpath
status = compatible

DingTalk
upstream = dingtalk-stream@2.1.5 + official-api-port
oracle = @dingtalk-real-ai/dingtalk-connector@0.8.24
status = compatible
```

---

# 40. Harness Native Image Attachment：Existing / Completed

这部分不是本计划的新建设项。

当前公共链路已经存在：

```text
ImagePart.localData
→ ctx.attachments.saveImage()
→ ImageAttachmentRef
→ ImageBlock
```

DeepSeek Harness 当前官方 Attachment v1 是 raster-image seam：

```text
image/png
image/jpeg
image/webp
image/gif
```

官方核心 API：

```text
ctx.attachments.validateImage()
ctx.attachments.saveImage()
ctx.attachments.readImage()
```

`dsh-channels` 已完成：

```text
message-converter.ts
  localData + mimeType
  → saveImage()
  → { type: 'image', attachment: ref }

lifecycle.ts
  ctx.get('attachments')
  → SaveImageHook 注入 bridge
```

微信当前也已完成：

```text
Weixin CDN media
→ download/decrypt
→ part.localData
→ Harness saveImage()
→ ImageBlock
```

因此：

```text
❌ 不新建第二套 Image Asset Store
❌ 不为 QQ/Lark/DingTalk 图片改造 channel-harness
❌ 不把 Native Image 依赖到 Generic File Extractor

✅ 只补平台 image locator → Uint8Array/localData
✅ 失败时继续沿用现有 [image: ...] 文本 fallback
✅ 微信 upstream consolidation 必须保证此链路零回归
```

不创造：

```text
Generic Harness FileBlock
AudioBlock
VideoBlock
```

这些当前都不是 Harness v1 官方附件能力。

---

# 41. Generic File

```text
FilePart.localData
→ ChannelInboundAssetStore
→ Extractor
→ Descriptor
→ read_channel_attachment
```

这属于 Harness 集成层。

不是平台轮子。

---

# 42. Private Asset Store

路径：

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

ACL：

```text
sessionId
```

不是：

```text
cwd
filename
conversation folder
```

---

# 43. Asset Store 接口

```ts
export interface ChannelInboundAssetStore {
  put(
    input: PutChannelAssetInput,
  ): Promise<StoredChannelAsset>

  get(
    attachmentId: string,
  ): Promise<StoredChannelAsset | undefined>

  readRaw(
    attachmentId: string,
    options: {
      maxBytes: number
      signal?: AbortSignal
    },
  ): Promise<Uint8Array>

  readExtracted(
    attachmentId: string,
    options: {
      maxBytes: number
      signal?: AbortSignal
    },
  ): Promise<string | undefined>
}
```

---

# 44. Store Atomic Publish

```text
.staging/<uuid>/
        ↓
raw.bin
meta.json
extracted.md
        ↓
atomic rename
        ↓
final attachment dir
```

reader 永远不看见半成品。

---

# 45. Asset Metadata

```ts
interface StoredChannelAsset {
  schemaVersion: 1

  attachmentId: string
  sessionId: string

  channelId: string
  accountId: string
  conversationId: string
  threadId?: string

  messageId: string

  kind:
    | 'file'
    | 'audio'
    | 'video'

  name: string
  mimeType?: string

  bytes: number
  sha256: string

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

---

# 46. 禁止持久化的平台状态

Asset metadata 不得出现：

```text
resourceRef
provider URL
AES key
access token
contextToken
sessionWebhook
Authorization
AppSecret
bot token
raw SDK payload
```

---

# 47. Filename / MIME

继续：

```text
filename sanitize
MIME sniff
magic signature
SHA-256
```

Adapter 的 `mimeType` 只是 hint。

Harness trust boundary：

```text
重新验证。
```

---

# 48. Extractor

首期：

```text
TXT
MD
JSON
YAML
XML
CSV
LOG
source code
PDF text
DOCX
XLSX
```

P1：

```text
PPTX
OCR
Audio ASR
Video ASR
```

---

# 49. Parser 安全

分离：

```text
transport max bytes
parser max input bytes
extracted max output bytes
```

默认建议：

```yaml
attachments:
  maxInboundBytes: 104857600

  extract:
    maxInputBytes: 33554432
    maxOutputBytes: 5242880
```

---

# 50. Attachment Pipeline

```text
binding.sessionId
        ↓
AttachmentPipeline.prepare()
        ↓
Image
  → Harness Attachment

File
  → Private Store
  → Extractor
        ↓
PreparedAttachment[]
        ↓
MessageConverter
```

---

# 51. Bridge 插入点

```text
resolve/create binding
        ↓
AttachmentPipeline.prepare
        ↓
toHarnessUserMessage
        ↓
ReplyContext.register
        ↓
agent.followup
```

I/O 不放进纯 converter。

---

# 52. `read_channel_attachment`

必须使用：

```text
@deepseek-ai/dsh-tools
```

并有：

```text
parameters
output.schema
output.render
execute
```

---

# 53. Tool ACL

```ts
const currentSessionId =
  String(exec.agent.id)

const asset =
  await store.get(args.attachment_id)

if (!asset)
  throw ATTACHMENT_NOT_FOUND

if (asset.sessionId !== currentSessionId)
  throw ATTACHMENT_ACCESS_DENIED
```

Tool 不接受：

```text
session_id
path
channel_id
conversation_id
```

---

# 54. UserMessage Descriptor

只写：

```text
附件 ID
文件名
MIME
大小
是否可读取
```

不塞完整 extracted text。

---

# 55. SessionBinding v3

当前 v2 不足以稳定支持主动发送。

最终：

```ts
export interface SessionBinding {
  channelId: string
  accountId: string

  conversationId: string
  conversationType: 'dm' | 'group'

  threadId?: string

  senderId?: string

  sessionId: string

  route: AgentRouteSpec

  schemaVersion: 3

  createdAt: number
  updatedAt: number
}
```

---

# 56. Binding 只保存稳定身份

允许：

```text
channelId
accountId
conversationId
conversationType
threadId
senderId
sessionId
route
```

禁止：

```text
sessionWebhook
replyToMessageId
runId
contextToken
media URL
AES key
```

---

# 57. `/new`

```text
Session A
/new
Session B
```

完成顺序：

```text
create B
→ durable binding put(B)
→ switch
→ retire A
```

从 Binding 更新完成开始：

```text
A Outbox 已失权。
```

---

# 58. Durable Binding Authority

Outbox authorization：

```text
SessionBindingStore
```

不是：

```text
AgentManager cache
```

`AgentManager.bindingFor()`：

```text
只能 hint。
```

---

# 59. `findBySessionId`

新增：

```ts
findBySessionId(
  sessionId: string,
): Promise<SessionBinding | undefined>
```

如果出现：

```text
一个 sessionId
对应多个 current binding
```

则：

```text
OUTBOX_AMBIGUOUS_BINDING
```

fail closed。

---

# 60. Channel Outbox

```ts
interface ChannelOutboundRequest {
  text?: string
  attachmentId?: string

  /**
   * trusted API only
   */
  filePath?: string
}
```

---

# 61. Outbox Target

```ts
function targetFromBinding(
  binding: SessionBinding,
): ChannelTarget {
  return {
    channelId: binding.channelId,
    accountId: binding.accountId,

    conversationId:
      binding.conversationId,

    conversationType:
      binding.conversationType,

    ...(binding.threadId
      ? { threadId: binding.threadId }
      : {}),
  }
}
```

---

# 62. `send_channel_message`

模型参数只允许：

```text
text
attachment_id
```

不存在：

```text
recipient
channel
account
conversation
user_id
openid
file_path
```

---

# 63. Outbound Attachment

```text
attachment_id
→ store
→ Session ACL
→ bounded raw bytes
→ OutboundMessage.localData
→ Adapter
→ official upstream upload/send
```

---

# 64. Outbound `file_path`

V1 模型 Tool：

```text
不提供。
```

trusted plugin/service 将来可以开启。

但必须：

```text
ctx.fs.resolve
ctx.fs.contains
ctx.fs.stat
ctx.fs.readBytes(maxBytes)
```

不能直接：

```text
node:fs.readFile(modelPath)
```

---

# 65. Adapter Outbound 最终红线

Adapter 可以：

```text
localData
→ official SDK input
```

例如：

```text
QQ:
localData
→ base64
→ qqbot-nodejs

Lark:
localData
→ Readable
→ node-sdk im.file.create

DingTalk:
localData
→ official media upload endpoint

Weixin:
localData
→ Tencent upstream media send
```

Adapter 不可以：

```text
重新设计 upload protocol。
```

---

# 66. Weixin Outbox

主动发送要调用：

```text
Tencent upstream send API
```

不要：

```text
DSH 自己拼 iLink sendmessage payload
```

如果 Tencent host-neutral subpath 当前不足：

```text
Compatibility Facade
```

暂时隔离。

---

# 67. QQ Outbox

```text
current binding
→ ChannelTarget
→ QQAdapter.send
→ TencentQQSdkClient
→ qqbot-nodejs
```

符合现有方向。

---

# 68. Lark Outbox

```text
binding
→ chat target
→ LarkMediaPort / outbound port
→ node-sdk
```

不要依赖：

```text
OpenClaw sessionKey
OpenClaw runtime
```

---

# 69. DingTalk Outbox

当前 reply：

```text
sessionWebhook
```

主动消息：

```text
official proactive API
```

必须是两条显式路径。

如果 proactive 尚未完成：

```text
capability = false
```

不能伪装支持。

---

# 70. Control Plane 与 Data Plane

现有最新代码已经形成：

```text
channel-control
channel-web
setup/auth flow
```

保持。

禁止：

```text
把附件 bytes
放 channel-control

把 Outbox job
放 auth setup

把 media store
放 channel-web
```

---

# 71. Capability 语义

现有：

```text
image
file
audio
video
```

继续表示：

```text
platform transport capability
```

新增 diagnostics：

```ts
interface ModelIngressCapabilities {
  nativeImage: boolean
  extractedFile: boolean
  audioTranscript: boolean
  videoTranscript: boolean
}

interface OutboxCapabilities {
  proactiveText: boolean
  proactiveMedia: boolean
}
```

---

# 72. 版本升级原则

官方 upstream 不能使用：

```text
无测试自动浮动
```

推荐：

QQ：

```text
qqbot-nodejs 可 semver range
但升级必须 contract tests
```

Lark：

```text
node-sdk semver range
但升级必须 contract tests
```

Weixin internal subpath：

```text
exact pin
```

DingTalk connector oracle：

```text
record exact tested version
```

---

# 73. Contract Fixtures

每个渠道保留：

```text
fixtures/upstream/<channel>/<version>/
```

例如：

```text
fixtures/upstream/weixin/2.4.6/
fixtures/upstream/qq/2.0.1/
fixtures/upstream/lark/2026.7.9/
fixtures/upstream/dingtalk/0.8.24/
```

内容：

```text
raw inbound samples
normalized media metadata
target mapping
platform errors
upload/send expected shape
```

不得包含：

```text
真实 token
真实 URL bearer
真实用户 id
```

---

# 74. Upstream Diff Workflow

升级官方插件前：

```text
old tested version
vs
new version
```

重点看：

```text
auth
transport
media
send
reply
target
resource download
streaming
```

输出：

```text
upstream compatibility report
```

再决定是否升级。

---

# 75. 不复制上游测试实现

可以复制：

```text
test scenario
behavior assertion
fixture shape
```

不要复制：

```text
整个 OpenClaw runtime mock framework
```

DSH 自己的测试：

```text
fake Port
→ Channel Adapter
→ Channel Contract
```

---

# 76. 目录最终调整

## channel-core

```text
packages/channel-core/src/
  messages.ts
  adapter.ts
  capabilities.ts
  media/
    bounded-response.ts
    remote-policy.ts
```

---

## channel-harness

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

  outbox/
    types.ts
    target.ts
    binding-resolver.ts
    attachment-resolver.ts
    service.ts
    tool-send.ts

  session-router.ts
  binding-store.ts
  bridge.ts
  message-converter.ts
```

---

## channel-weixin

目标：

```text
packages/channel-weixin/src/
  adapter.ts
  mapper.ts

  upstream/
    port.ts
    tencent-upstream.ts
    vendor-compat.ts
    compat.ts

  auth/
    # 仅保留 DSH-specific state glue
```

迁移结束后尽量删除：

```text
自产 protocol client
自产 AES/CDN implementation
自产 endpoint table
```

---

## channel-qq

```text
packages/channel-qq/src/
  adapter.ts
  mapper.ts
  inbound.ts
  outbound.ts

  upstream/
    qq-sdk-client.ts
```

现有 `sdk-client.ts` 可直接迁名/保留。

---

## channel-lark

```text
packages/channel-lark/src/
  adapter.ts
  mapper.ts

  upstream/
    connection.ts
    outbound.ts
    media-port.ts
```

内部全部调用：

```text
@larksuiteoapi/node-sdk
```

---

## channel-dingtalk

```text
packages/channel-dingtalk/src/
  adapter.ts
  mapper.ts

  upstream/
    stream-port.ts
    openapi-port.ts
    official-contract.ts
```

---

# 77. Milestone M0 — Upstream Boundary Lock

这是第一步。

- [ ] 记录 `dsh-channels@eddab299...`。
- [ ] 固定四个 upstream compatibility versions。
- [ ] 建 `UpstreamManifest`。
- [ ] 建 fixture 目录。
- [ ] 四渠道 package dependency audit。
- [ ] 标出所有自产平台协议代码。
- [ ] 为每段代码分类：
  - DSH glue
  - official SDK wrapper
  - duplicate protocol implementation
- [ ] 添加 no-protocol-reimplementation ADR。

输出：

```text
docs/architecture/upstream-first.md
```

---

# 78. Milestone M1 — Weixin Upstream Consolidation

优先处理微信，但**这是协议所有权收敛，不是重新实现图片附件**。

- [ ] exact pin Tencent package。
- [ ] 检查 dist/src host-neutral modules。
- [ ] 建 `WeixinUpstream`。
- [ ] 建单一 `vendor-compat.ts`。
- [ ] root OpenClaw entry 禁止 import。
- [ ] QR auth 对接 upstream。
- [ ] monitor 对接 upstream。
- [ ] image download 对接 upstream。
- [ ] image send 对接 upstream。
- [ ] file download/send 能力探测。
- [ ] current duplicate code 标记 deprecated。
- [ ] 一段一段删重复实现。
- [ ] compatibility smoke。
- [ ] 现有微信图片 `localData` regression test。
- [ ] Harness `ImageBlock` regression test。
- [ ] live Weixin 图片识别回归。

强制不退化基线：

```text
重构前：
Weixin image → localData → saveImage() → ImageBlock  = PASS

重构后：
Weixin image → localData → saveImage() → ImageBlock  = PASS
```

DoD：

```text
1. Adapter 不知道 AES/getuploadurl 细节。
2. message-converter.ts 图片逻辑无需为 M1 重写。
3. lifecycle.ts attachment 注入无需为 M1 重写。
4. 微信真实图片到 Harness ImageBlock 零回归。
```

---

# 79. Milestone M2 — Core Binary Contract + Secure Host Boundary

先承认现状：

```text
ImagePart.localData  ✅ 已存在
FilePart.localData   ✅ 已存在
AudioPart.localData  当前不存在
VideoPart.localData  当前不存在
```

本里程碑只做真正需要的契约补充：

- [ ] `resourceRef`：承载 image_key/file_key/file_id/mediaId 等 opaque platform handle。
- [ ] `ingressFailure`：脱敏、稳定错误码，便于降级与诊断。
- [ ] 明确 `url` 只允许真实 `http(s)` URL。
- [ ] shared bounded stream reader。
- [ ] SSRF policy。
- [ ] DNS/IP revalidation。
- [ ] redirect policy。
- [ ] cross-origin redirect auth stripping。
- [ ] timeout / abort policy。
- [ ] streaming cumulative maxBytes。
- [ ] URL vs resourceRef tests。
- [ ] mapper purity tests。

当前不做：

```text
❌ 为了类型整齐给 AudioPart/VideoPart 强行增加 localData
```

只有 ASR / 视频理解里程碑真正出现消费端时再增加，避免 YAGNI。

---

# 79A. Milestone M2A — QQ / Lark / DingTalk Native Image Ingress

这是最终版新增的高优先级、小范围里程碑。

目标只有一个：

> **让三个渠道的图片进入已经存在的 `ImagePart.localData → saveImage() → ImageBlock` 管道。**

## QQ

- [ ] mapper 继续只做纯映射，保留 attachment URL。
- [ ] Adapter/InboundProcessor 在 emit 前 hydrate image。
- [ ] 使用 shared `SecureRemoteMediaFetcher`。
- [ ] 填 `ImagePart.localData`。
- [ ] 填/规范 `mimeType`。
- [ ] 下载失败保留原 part，继续文本 fallback。
- [ ] 不实现 QQ token/gateway/upload 协议。

验收：

```text
QQ image
→ qqbot-nodejs event
→ secure hydration
→ localData
→ Harness saveImage()
→ ImageBlock
```

## Lark

- [ ] `image_key` 不再伪装成 URL，写入 `resourceRef`。
- [ ] 保留/传入 messageId 作为 resource resolution context。
- [ ] `LarkMediaPort.downloadMessageResource()`。
- [ ] 内部严格使用 `@larksuiteoapi/node-sdk` 的 `client.im.messageResource.get()`。
- [ ] response normalize → `Uint8Array`。
- [ ] 填 `ImagePart.localData` + `mimeType`。
- [ ] 不手写 `/open-apis/im/v1/...`。

验收：

```text
Lark image_key + message_id
→ node-sdk messageResource.get
→ localData
→ Harness saveImage()
→ ImageBlock
```

## DingTalk

- [ ] 若 inbound 是真实 picUrl/mediaUrl：走 shared SecureRemoteMediaFetcher。
- [ ] 若 inbound 是 opaque mediaId：写 `resourceRef`，经最薄 DingTalkOpenApiPort 解析。
- [ ] 填 `ImagePart.localData` + `mimeType`。
- [ ] 失败保留 locator 并 fallback。
- [ ] 不新增第二套 DingTalk SDK。

验收：

```text
DingTalk image locator
→ official SDK/OpenAPI boundary
→ localData
→ Harness saveImage()
→ ImageBlock
```

## M2A 总 DoD

```text
[ ] channel-harness/message-converter.ts 不需要平台分支。
[ ] channel-harness/lifecycle.ts 不需要平台分支。
[ ] QQ/Lark/DingTalk 的真实图片都产生 Harness ImageBlock。
[ ] Weixin 原有 ImageBlock 仍 PASS。
[ ] 任一平台下载失败不阻断文本消息投递。
[ ] 没有新增平台协议重复实现。
```

---

# 80. Milestone M3 — SessionBinding v3 + Private Asset Store

- [ ] schema v3。
- [ ] conversationType。
- [ ] senderId optional。
- [ ] v1/v2 migration。
- [ ] durable findBySessionId。
- [ ] Private Asset Store。
- [ ] staging publish。
- [ ] Session ACL。
- [ ] filename sanitize。
- [ ] MIME sniff。
- [ ] SHA-256。

---

# 81. Milestone M4 — Extractor + Harness Tool

- [ ] text extractor。
- [ ] PDF。
- [ ] DOCX。
- [ ] XLSX。
- [ ] parser caps。
- [ ] extracted caps。
- [ ] `read_channel_attachment`。
- [ ] `output.schema`。
- [ ] `output.render`。
- [ ] Agent-scoped registration。
- [ ] pagination。
- [ ] ACL tests。

---

# 82. Milestone M5 — Weixin FILE End-to-End

注意：

```text
不是自己实现 FILE 协议。
```

任务：

- [ ] Tencent upstream FILE capability。
- [ ] upstream File → `FilePart.localData`。
- [ ] Harness private store。
- [ ] PDF extraction。
- [ ] same attachment outbound。
- [ ] Tencent upstream file send。
- [ ] live E2E。

若 Tencent package 没有现成 FILE helper：

```text
只在 WeixinUpstream compatibility 层补最薄 missing operation，
并逐字段照 upstream source。
```

此 shim 必须标记：

```text
temporary-upstream-gap
```

---

# 83. Milestone M6 — Durable Outbox

- [ ] durable Binding authority。
- [ ] AgentManager only hint。
- [ ] active binding。
- [ ] `/new` old session reject。
- [ ] attachment resolver。
- [ ] `ChannelOutboxService`。
- [ ] `send_channel_message`。
- [ ] no recipient。
- [ ] no model file_path。
- [ ] platform proactive capability。
- [ ] restart test。

---

# 84. Milestone M7A — Lark Generic File / Outbound Media

Native inbound image 已在 M2A 完成，本阶段不重复。

- [ ] `file_key → resourceRef`。
- [ ] node-sdk generic file resource download。
- [ ] `FilePart.localData → Private Asset Store`。
- [ ] node-sdk image/file upload。
- [ ] node-sdk send/reply。
- [ ] same attachment resend。
- [ ] proactive attachment send。
- [ ] no raw HTTP API assembly。
- [ ] shared AttachmentPipeline。
- [ ] PDF E2E。

DoD：

```text
channel-lark 中平台网络行为全部经 node-sdk；
Native image 不另起第二条 Harness bridge。
```

---

# 85. Milestone M7B — QQ Generic File / Outbound Media

Native inbound image 已在 M2A 完成，本阶段处理真正较重的 generic media/outbound。

- [ ] generic file inbound hydration（仅在能力需要时）。
- [ ] `FilePart.localData → Private Asset Store`。
- [ ] localData → SDK fileData。
- [ ] no QQ upload protocol。
- [ ] shared Pipeline。
- [ ] proactive send。
- [ ] file resend E2E。

DoD：

```text
network/gateway/token/upload
全部 qqbot-nodejs；
图片不重复实现 attachment bridge。
```

---

# 86. Milestone M7C — DingTalk Generic File / Outbound / Proactive

Native inbound image 已在 M2A 完成。

- [ ] StreamPort 使用 dingtalk-stream。
- [ ] OpenApiPort method inventory。
- [ ] 每个 payload 对应官方 connector source。
- [ ] generic media download（若平台需要 mediaId resolution）。
- [ ] media upload。
- [ ] media send。
- [ ] proactive send。
- [ ] sessionWebhook reply-only。
- [ ] no second DingTalk SDK。
- [ ] shared Pipeline。
- [ ] live file/outbound E2E。

---

# 87. Milestone M8 — Hardening / Doctor / Release

- [ ] upstream manifest doctor。
- [ ] package-shape smoke。
- [ ] dependency upgrade gates。
- [ ] SSRF。
- [ ] byte caps。
- [ ] redirect auth stripping。
- [ ] attachment ACL。
- [ ] `/new` race。
- [ ] binding restart。
- [ ] extraction caps。
- [ ] all live tests。
- [ ] README capability matrix。
- [ ] release notes。

---

# 88. PR 拆分

推荐按依赖顺序拆，不把 M2A 与 Generic File 混成一个大 PR：

```text
PR-1
docs(architecture): lock upstream-first channel boundary

PR-2
refactor(weixin): introduce Tencent upstream compatibility facade

PR-3
refactor(weixin): remove duplicated iLink media protocol paths without image regression

PR-4
feat(core): add resourceRef and ingress failure contract

PR-5
feat(core): add bounded secure remote-media boundary

PR-6
feat(images): hydrate QQ/Lark/DingTalk inbound images into existing Harness ImageBlock pipeline

PR-7
feat(harness): migrate session bindings to v3

PR-8
feat(harness): add private channel file asset store

PR-9
feat(harness): add extractors and read_channel_attachment

PR-10
feat(weixin): add upstream-backed file ingress/egress

PR-11
feat(harness): add durable outbox and send_channel_message

PR-12
feat(lark): add generic file/outbound media through official node-sdk

PR-13
feat(qq): add generic file/outbound media through qqbot-nodejs

PR-14
refactor(dingtalk): isolate stream and official OpenAPI generic-media/proactive ports

PR-15
test(channels): upstream compatibility and live E2E hardening
```

---

# 89. Code Review Checklist — 平台轮子检查

任何 Channel PR 必问：

```text
[ ] 这段代码是不是平台协议？
[ ] 官方 SDK 已经有没有？
[ ] 官方插件有没有 host-neutral helper？
[ ] 能否调用官方 SDK 而不是自己拼 HTTP？
[ ] 是否复制了 token/retry/reconnect？
[ ] 是否复制了 AES/upload/download？
[ ] 是否把 OpenClaw runtime 带进 DSH？
[ ] 这段逻辑究竟是 DSH glue 还是平台逻辑？
```

如果答案是：

```text
“官方已有，但我们重新写了一遍”
```

默认：

```text
reject review
```

---

# 90. Weixin 特别 Review Gate

出现以下关键词：

```text
AES
ECB
PKCS7
getuploadurl
encrypt_query_param
X-WECHAT
iLink endpoint
```

必须说明：

```text
为什么没有直接复用 Tencent upstream。
```

没有合理 upstream-gap：

```text
不得 merge。
```

---

# 91. QQ 特别 Review Gate

出现：

```text
access token HTTP
gateway websocket
heartbeat
resume
QQ media upload endpoint
```

直接检查：

```text
为什么没用 qqbot-nodejs。
```

---

# 92. Lark 特别 Review Gate

出现：

```text
/open-apis/
tenant_access_token
Authorization Bearer
手写 messageResource URL
```

默认认为架构错误。

应使用：

```text
@larksuiteoapi/node-sdk
```

---

# 93. DingTalk 特别 Review Gate

出现：

```text
Stream websocket protocol
自定义 reconnect protocol
```

默认错误。

应使用：

```text
dingtalk-stream
```

OpenAPI payload：

```text
必须有官方 connector/source 对照。
```

---

# 94. Harness Tool Tests

`read_channel_attachment`：

```text
own session asset        PASS
other session            DENY
unknown id               NOT_FOUND
same cwd other session   DENY
offset                    PASS
limit                     PASS
output max                PASS
abort                     PASS
schema                    PASS
render                    PASS
```

---

# 95. Outbox Tests

```text
current durable binding  PASS
restart                   PASS
old session /new          DENY
ambiguous binding         DENY
foreign attachment        DENY
recipient param           DOES NOT EXIST
model file_path           DOES NOT EXIST
```

---

# 96. Upstream Tests

QQ：

```text
Adapter
→ FakeQQSdkClient
→ assert sendMedia called
```

Lark：

```text
Adapter
→ FakeLarkMediaPort
→ assert official method mapping
```

DingTalk：

```text
Adapter
→ FakeStreamPort/OpenApiPort
```

Weixin：

```text
Adapter
→ FakeWeixinUpstream
```

测试 Adapter，不 fake 平台 HTTP 细节。

---

# 97. Live Tests

最低：

```text
Weixin:
QR auth
text inbound/outbound
image inbound/outbound
file inbound/outbound

QQ:
text
image
file
C2C streaming
proactive

Lark:
text
thread
image
PDF
card streaming
proactive

DingTalk:
Stream receive
reply
AI Card
file
proactive
```

---

# 98. Capability 开启规则

任何能力：

```text
代码写完
≠ capability=true
```

必须：

```text
offline contract
+
live proof
```

之后：

```text
capability=true
```

---

# 99. Doctor 输出

示例：

```text
Channel: weixin

Adapter:
  @wsz987/channel-weixin

Platform upstream:
  @tencent-weixin/openclaw-weixin
  tested: 2.4.6
  strategy: host-neutral-subpath

Protocol ownership:
  Tencent upstream

Harness attachment ingress:
  image: native
  file: extracted

Outbox:
  text: verified
  media: verified
```

---

# 100. 不做

最终明确不做：

```text
不把 OpenClaw runtime 嵌入 DeepSeek Harness

不重新实现 QQ SDK
不重新实现 Lark OpenAPI SDK
不重新实现 DingTalk Stream SDK
不长期维护第二套 Weixin iLink SDK

不把官方插件所有功能搬过来
不复制 OpenClaw Session/Tool runtime

不自造 Harness FileBlock
不把 generic file 当 Image Attachment

不把 platform resource handle 当 URL

不让模型指定 recipient
不让模型 V1 指定 file_path

不放宽 ReplyContext
不让所有 assistant output 自动外发
```

---

# 101. 最终职责分工

## 官方渠道上游

负责：

```text
协议
鉴权
Token
连接
官方 API
媒体上传
媒体下载
平台 payload
平台 streaming
平台 retry/reconnect
```

具体按 SDK 能力范围。

---

## channel adapter

负责：

```text
生命周期接 DeepSeek Harness channel runtime
平台对象 → Channel Contract
ChannelTarget → upstream target
resourceRef → upstream resolver
localData → upstream input
capability
health
```

---

## channel-core

负责：

```text
跨平台稳定类型
MessagePart
ChannelTarget
ChannelAdapter
resourceRef/localData
errors
```

---

## channel-harness

负责：

```text
SessionBinding
Agent routing
Harness Image Attachment
Private generic asset store
Extractor
Tool
Outbox
Session ACL
/new security
```

---

# 102. Definition of Done

## Upstream Ownership

- [ ] QQ protocol owned by qqbot-nodejs。
- [ ] Lark protocol owned by node-sdk。
- [ ] DingTalk Stream owned by dingtalk-stream。
- [ ] DingTalk OAPI payload mirrors official connector。
- [ ] Weixin protocol maximally owned by Tencent upstream。
- [ ] no OpenClaw runtime imported into channel adapters。
- [ ] no platform protocol duplicated without upstream-gap ADR。

## Weixin

- [ ] exact upstream pin。
- [ ] single vendor compat boundary。
- [ ] current duplicate protocol inventory completed。
- [ ] AES/CDN/getuploadurl no longer spread across Adapter layer。
- [ ] file ingress/egress live verified。

## Core

- [ ] resourceRef。
- [ ] localData。
- [ ] ingressFailure。
- [ ] URL security boundary。

## Harness

- [ ] Binding v3。
- [ ] Session ACL Store。
- [ ] Extractors。
- [ ] official Tool contract。
- [ ] Outbox。
- [ ] `/new` immediate deny。

## Reuse

- [ ] Lark no custom REST。
- [ ] QQ no custom gateway/upload。
- [ ] DingTalk no custom Stream。
- [ ] no per-channel Store。
- [ ] no per-channel Extractor。
- [ ] no per-channel Harness Tool。

---

# 103. 最终执行顺序

```text
M0
Upstream Boundary Lock
        ↓
M1
Weixin Upstream Consolidation
★ 保证现有微信 ImageBlock 零回归
        ↓
M2
resourceRef + ingressFailure + Secure Remote Boundary
        ↓
M2A
QQ / Lark / DingTalk Native Image Ingress
★ 直接复用现有 Harness saveImage()/ImageBlock
        ↓
M3
Binding v3 + Private File Asset Store
        ↓
M4
Extractors + read_channel_attachment
        ↓
M5
Weixin Generic FILE E2E through Tencent upstream
        ↓
M6
Durable Outbox + send_channel_message
        ↓
M7A
Lark Generic File / Outbound Media through node-sdk
        ↓
M7B
QQ Generic File / Outbound Media through qqbot-nodejs
        ↓
M7C
DingTalk Generic File / Outbound / Proactive
        ↓
M8
Hardening / Doctor / Live / Release
```

并行建议：

```text
M2 完成 resourceRef + secure boundary 后，
M2A 三个平台可以并行开发；
M3/M4 不需要等待 M7 generic media 完成。
```

---

# 104. 开工前阻断检查

以下必须全部 YES：

```text
[ ] 当前 main commit 已固定。
[ ] upstream tested versions 已固定。
[ ] 已区分 DSH glue 与 platform protocol。
[ ] Weixin 有 consolidation plan。
[ ] QQ 不实现 SDK 已有能力。
[ ] Lark 不手写 OpenAPI。
[ ] DingTalk 不手写 Stream。
[ ] root OpenClaw plugins 不进入 DSH runtime。
[ ] Harness Native Image Attachment 已标记 Existing，不重复建设。
[ ] Weixin 现有 image → localData → ImageBlock 已建立 regression baseline。
[ ] QQ/Lark/DingTalk 图片已单列 M2A，不等待 Generic File。
[ ] resourceRef 已纳入 Core。
[ ] Session ACL 不基于 cwd。
[ ] Binding v3 conversationType 已设计。
[ ] Tool 有 output.schema/render。
[ ] Outbox durable Binding 是 authority。
[ ] Tool 无 recipient。
[ ] Tool 无 file_path。
```

---

# 105. ADR：No Protocol Reimplementation

建议在仓库增加：

```text
docs/architecture/adr/
  0001-upstream-first-channel-platform-boundary.md
```

正文核心：

```text
Decision:

dsh-channels treats official platform SDKs and official channel implementations
as the owners of platform protocol semantics.

dsh-channels implements only the minimum adapter layer required to expose those
semantics through the Channel Contract and DeepSeek Harness.

Platform protocol behavior must not be reimplemented locally when an official
host-neutral implementation exists.
```

---

# 105A. 最终状态定义：以后不要再说“附件还没做”

项目对外/README/Issue/PR 中统一使用下面的表述：

> **附件接入：DeepSeek Harness 官方 v1 已支持真实栅格图片附件；`dsh-channels` 的公共 Harness 图片附件链路已经完成，微信图片已接通。QQ / DingTalk / Lark 当前待补各自官方 upstream 的图片字节解析并填充 `ImagePart.localData`。Generic file / audio / video 因 Harness v1 没有对应原生 Attachment/ContentBlock，其中 generic file 由 dsh-channels Private Asset Store + Extractor + Tool 补充，audio/video 暂继续降级或等待专门处理能力。**

该表述是本最终执行文档的能力基线。

---

# 106. 官方来源

## dsh-channels

```text
https://github.com/wsz987/dsh-channels
main@eddab2996ab47a7559f6c1135b3e40be9e5cc68b
```

---

## Weixin

```text
https://github.com/Tencent/openclaw-weixin

npm:
@tencent-weixin/openclaw-weixin

tested upstream:
2.4.6
```

用途：

```text
iLink protocol owner
QR auth behavior
message receive/send
media/CDN behavior
```

---

## QQ

```text
https://github.com/tencent-connect/openclaw-qqbot

OpenClaw plugin:
@tencent-connect/openclaw-qqbot

official SDK:
@tencent-connect/qqbot-nodejs
```

最终运行依赖优先：

```text
@tencent-connect/qqbot-nodejs
```

---

## Lark

```text
https://github.com/larksuite/openclaw-lark

OpenClaw plugin:
@larksuite/openclaw-lark

official SDK:
@larksuiteoapi/node-sdk
```

最终运行依赖优先：

```text
@larksuiteoapi/node-sdk
```

---

## DingTalk

```text
https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector

plugin:
@dingtalk-real-ai/dingtalk-connector

Stream SDK:
dingtalk-stream
```

最终：

```text
Stream:
dingtalk-stream

OAPI behavior:
official connector compatibility contract
```

---

## DeepSeek Harness

```text
https://github.com/deepseek-ai/deepseek-harness

https://deepseek-harness.github.io/deepseek-harness/reference/
```

重点：

```text
AttachmentStore
Tools
FS
Session
Agent
Cordis
```

Attachment v1 官方文档：

```text
https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.md
```

本仓库现有图片桥：

```text
packages/channel-harness/src/message-converter.ts
packages/channel-harness/src/lifecycle.ts
packages/channel-weixin/src/adapter.ts
```

---

# 107. 最终一句话

> **dsh-channels 只负责把 DeepSeek Harness 与官方渠道能力接起来：Harness 原生图片附件桥已经存在，QQ/Lark/DingTalk 只需通过官方 upstream 把图片变成 `localData`；Generic File 再由 DSH 私有资产/Extractor/Tool 补充。官方上游拥有平台协议，Channel Adapter 负责映射，channel-harness 负责 Session、文件理解与 Outbox；任何已经由 Tencent / Lark / DingTalk 官方 SDK 或官方渠道实现解决的协议问题，都不在 DSH 内重新实现。**
