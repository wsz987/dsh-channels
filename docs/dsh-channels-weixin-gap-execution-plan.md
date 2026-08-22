# dsh-channels × Tencent/openclaw-weixin 2.4.6 功能差距核验与补齐执行方案

> 核验日期：2026-08-22  
> 目标仓库：`wsz987/dsh-channels`  
> 对照上游：`Tencent/openclaw-weixin`  
> 重点包：`packages/channel-weixin` / `packages/channel-core`  
> 本文目标：只补当前项目真正缺失、且适合 DeepSeek Harness Channel 架构的能力；不把 OpenClaw 宿主耦合逻辑搬进 DSH。

---

## 1. 核验基线

### dsh-channels

- 核验 HEAD：`213fd5c30a63670978c57c0bdd9615ae05c69608`
- HEAD 时间：2026-08-21
- 当前主线已进入 0.5.x 兼容基线工作，Harness 最低基线为 `0.1.1-rc.2`。
- `packages/channel-weixin/package.json` 源码中版本仍为 `0.4.2`，这不影响本次源码能力核验。

### Tencent/openclaw-weixin

- 核验 HEAD：`cef0bfc390393f716903e16d50408118047f87e0`
- 对应发布：`v2.4.6`
- npm 包：`@tencent-weixin/openclaw-weixin@2.4.6`
- OpenClaw peer：`>=2026.5.12`

### “底层库”结论

Tencent 当前并没有提供一个可直接被 DSH 引用的、host-neutral 的独立 iLink SDK。

`openclaw-weixin` 自己同时承担：

- `src/api/*`：iLink HTTP API / wire types
- `src/cdn/*`：AES-128-ECB、上传、下载
- `src/media/*`：MIME、SILK 转码
- `src/auth/*`：二维码登录
- `src/monitor/*`：长轮询
- `src/messaging/*`：消息映射、发送、Markdown、进度消息

它真正的第三方运行依赖主要是 `qrcode-terminal` / `zod`；`silk-wasm` 用于语音 SILK 解码，源码采用动态 import + 失败回退。OpenClaw 本身是 peer host，而不是独立协议 SDK。

**因此你现在的 `source-port + WeixinUpstream port` 方向是正确的。不要直接依赖 `@tencent-weixin/openclaw-weixin` 的内部 dist 路径，更不要把 OpenClaw runtime 拉进 DSH。**

只有未来 Tencent 抽出稳定的 host-neutral package/subpath 后，才适合把 `strategy: source-port` 改为官方 SDK/host-neutral primitive。

---

## 2. 当前架构判断

你现在微信包的分层是合理的：

```text
packages/channel-weixin/src/
├─ adapter.ts              # Channel Contract 生命周期 / 能力声明
├─ auth/                   # 登录和凭证
├─ ilink/                  # wire types / client / headers / errors
├─ media/                  # AES / CDN upload-download / payload
├─ messaging/              # mapper / monitor / sender / typing / dedup
├─ storage/                # cursor / context token
├─ upstream/               # WeixinUpstream port + Tencent source-port
├─ transport.ts            # 通用 HTTP transport
└─ manifest.ts             # 上游兼容声明
```

这个边界比直接模仿 OpenClaw 插件更适合 Harness：

```text
Harness / ChannelService
        │
        ▼
ChannelAdapter
        │  只依赖稳定 port
        ▼
WeixinUpstream
        │
        ├─ auth
        ├─ messaging
        ├─ media
        └─ iLink client
                │
                ▼
          Tencent iLink API/CDN
```

继续遵守两个原则：

1. `adapter.ts` 不知道 AES、CDN、iLink endpoint。
2. `channel-weixin` 不直接调用 Harness Agent API；Agent/turn/tool 生命周期只能由 Channel Core/Bridge 通过通用接口传下来。

---

## 3. 已经支持，不要重复造轮子的部分

以下能力已经存在，**不要因为 Tencent 也有同名模块就重写**：

| 能力 | 当前状态 | 结论 |
|---|---|---|
| QR 登录 | 已支持 | 保留 |
| `wait / scaned / confirmed / expired` | 已支持 | 保留 |
| `need_verifycode / verify_code_blocked` | 已支持 | 保留 |
| `scaned_but_redirect / binded_redirect` 状态机 | 已支持 | 仅补 local token 输入 |
| `bot_agent` | 已支持 | 保留 |
| `getUpdates` 长轮询 | 已支持 | 保留 |
| 服务端动态 `longpolling_timeout_ms` | 已支持 | 保留 |
| 外部 AbortSignal | 已支持 | 保留 |
| cursor 持久化 | 已支持 | 保留 |
| context_token 持久化 | 已支持 | 保留 |
| 两阶段 dedup | 已支持，而且设计更稳 | 保留 |
| sendMessage `ret != 0` 校验 | 已支持 | 保留 |
| stale token typed error | 已有 `StaleTokenError` | 只补状态处理 |
| `notifyStart / notifyStop` | 已支持 | 保留 |
| typing API | 已支持 | 只补 ticket cache 策略 |
| 图片入站 CDN 下载 + AES 解密 | 已支持 | 保留 |
| 文件入站 CDN 下载 + AES 解密 | 已支持 | 保留 |
| 图片出站 CDN 上传 | 已支持 | 补 payload fidelity |
| AES-128-ECB | 已支持 | 保留 |
| 安全 remote media fetch boundary | 已支持 | 继续复用 |
| Harness `localData` 附件链路 | 已支持 | 扩展给音频/视频 |

特别是你当前的 cursor/dedup 提交顺序是好的：消息 emit 成功后才提交 dedup，整轮完成后再持久化 cursor，不应该改成 OpenClaw 的实现方式。

---

# 4. 真正缺失的能力总表

## 4.1 必补差距

| 优先级 | 差距 | 你当前状态 | Tencent 2.4.6 | 建议 |
|---|---|---|---|---|
| P0 | 入站语音二进制 | mapper 有 `audio`，但 upstream 不下载/解密 | 下载 + AES 解密 + SILK→WAV，失败退回 raw SILK | 补 |
| P0 | 入站视频二进制 | mapper 有 `video`，但 upstream 不 hydrate `localData` | 下载 + AES 解密为 MP4 | 补 |
| P0 | 出站文件 | Adapter 明确拒绝；`sendFile()` 仍直接抛 capability error | 已支持 FILE upload + FileItem send | 补 |
| P0 | 出站视频 | Adapter 明确拒绝 | 已支持 VIDEO upload + VideoItem send | 补 |
| P0 | stale token 运行态 | 已能识别 `-14`，但 monitor 当普通网络错误无限重试 | 有 session guard | 用 DSH 原生 auth-state 方式补 |
| P0 | 当前图片出站 wire fidelity | 只发 media ref | Tencent 还发 `encrypt_type=1`、`mid_size` | 对齐，但需 live gate |
| P1 | QR `local_token_list` | 当前硬编码 `[]` | 最近 token 最多 10 个，用于识别已绑定 bot | 补 |
| P1 | `ref_msg` 引用消息 | wire type 有，但 mapper 完全忽略 | Tencent 会保留引用上下文 | 补 |
| P1 | typing config cache | 当前 Map 永久缓存 | 24h 随机刷新 + 失败指数退避 | 补 |
| P1 | Markdown 降级 | capability=false，但文本原样发 Markdown | StreamingMarkdownFilter 部分保留/降级 | 补纯平台 formatter |
| P1 | wire type 完整度 | 只覆盖 item 0~5 等基础字段 | 新增 tool item 11/12、item timestamps、is_completed 等 | 补类型/fixture |
| P2 | Tool-call progress | 无 host→adapter 进度接口 | TOOL_CALL_START/RESULT | 先扩通用 core seam，再接微信 |
| P2 | 网络错误分类 | timeout/abort/general | dns/tcp/tls/timeout/unknown | 补 observability |
| P2 | manifest/live compatibility | `pending` + `versionRange: '*'` | 已知上游 2.4.6 | 完成 live gate 后收口 |

---

# 5. 一个容易漏掉的现有图片出站差异

当前 DSH：

```ts
item_list: [
  {
    type: IMAGE,
    image_item: {
      media: {
        encrypt_query_param,
        aes_key,
      },
    },
  },
]
```

Tencent 2.4.6 当前发送形状额外包含：

```ts
image_item: {
  media: {
    encrypt_query_param,
    aes_key,
    encrypt_type: 1,
  },
  mid_size: uploaded.fileSizeCiphertext,
}
```

同时还发现一个需要 **live A/B 验证而不能拍脑袋改** 的差异：

- DSH 当前：`Buffer.from(hex, 'hex').toString('base64')`
- Tencent 当前：`Buffer.from(hexString).toString('base64')`

后者实际是“32 字符 ASCII hex → base64”，前者是“16 raw bytes → base64”。你当前入站解密代码已经兼容两种形式。

### 处理原则

不要直接因为官方源码不同就立即改掉当前图片 AES key wire 编码。

Phase 0 先加两个 outbound fixture + live gate：

```text
A: raw-16-byte base64
B: ascii-hex-string base64
```

验证服务端实际接受形态，再固定 contract fixture。

这一点应作为 `WX-LIVE-IMAGE-KEY-ENCODING` 阻断项。

---

# 6. Phase 0 — 先锁定上游契约，不先写功能

你仓库已经有：

```text
fixtures/upstream/weixin/2.4.6/README.md
```

但 README 自己写明：当前只是 skeleton，真正 payload fixture 还没放进去。

所以第一步不是重构，而是把 2.4.6 的契约固定下来。

## 新增 fixture

```text
fixtures/upstream/weixin/2.4.6/
├─ raw-inbound/
│  ├─ text.json
│  ├─ quoted-text.json
│  ├─ voice-silk.json
│  ├─ file.json
│  ├─ video.json
│  ├─ tool-call-start.json
│  └─ tool-call-result.json
├─ platform-errors/
│  ├─ stale-token--14.json
│  └─ send-ret-nonzero.json
├─ auth/
│  ├─ binded-redirect.json
│  └─ need-verify-code.json
└─ upload-send-expected-shape/
   ├─ image.json
   ├─ file.json
   ├─ video.json
   └─ tool-progress.json
```

只保存脱敏后的结构，不保存真实 token / userid / signed URL。

## 同时新增 source snapshot metadata

```json
{
  "package": "@tencent-weixin/openclaw-weixin",
  "version": "2.4.6",
  "commit": "cef0bfc390393f716903e16d50408118047f87e0"
}
```

目的：以后 Tencent 2.5/3.x 更新时可以自动判断“协议形状变了，还是只是 OpenClaw glue 变了”。

---

# 7. Phase 1 — stale-token、QR local token、typing cache

这是可靠性阶段，优先于新增炫技功能。

## 7.1 stale token：不要照抄 Tencent 的“一小时内存暂停”

Tencent 的 `session-guard.ts` 在 `-14` 后把 account pause 1 小时。

你的架构已经有：

```ts
StaleTokenError extends ChannelError
```

但 monitor 当前把所有异常都走：

```text
error
→ connection=reconnecting
→ exponential backoff
→ getUpdates 再试
```

这会导致已失效 token 持续请求。

### DSH 更合适的方案

遇到 `StaleTokenError`：

```text
getUpdates -> StaleTokenError
        │
        ├─ monitor 结束当前 receive loop
        ├─ upstream.authenticated = false
        ├─ connection -> disconnected
        ├─ emit auth.changed(state='expired')
        ├─ 清空 typing/config runtime cache
        └─ 等待用户重新 QR 登录
```

不要自动删掉 credential 文件；保留用于诊断和重新绑定识别，但发送/接收都要 fast-fail。

### 修改文件

```text
packages/channel-weixin/src/messaging/monitor.ts
packages/channel-weixin/src/upstream/tencent-upstream.ts
packages/channel-weixin/src/ilink/errors.ts
packages/channel-weixin/src/adapter.ts
```

### 可选新增

```text
packages/channel-weixin/src/upstream/session-state.ts
```

只存：

```ts
type WeixinSessionState =
  | { status: 'active' }
  | { status: 'stale'; detectedAt: number };
```

不需要复刻 OpenClaw 的 1 小时 Map。

### 验收

- `-14` 后不会进入无限 reconnect。
- `getHealth()` 返回 authenticated=false / down 或明确 stale detail。
- Web 控制面显示需要重新扫码。
- 新 QR credential 落盘后可恢复 monitor。

---

## 7.2 QR `local_token_list`

现在 `ILinkClient.getBotQrcode()` 是：

```ts
{ local_token_list: [] }
```

Tencent 2.3.1+ 会带最近本地 token，最多 10 个，用来让服务端识别“这个 bot 已经绑定过”，从而返回 `binded_redirect`。

你已经实现 `binded_redirect` 状态机，所以现在是 **后半段有、入口没喂数据**。

### 不要让 iLink client 自己读 credential store

正确依赖方向：

```text
AccountCredentialStore
      │
TencentWeixinUpstream.beginQrAuth()
      │ localTokens
WeixinQrAuth.beginAuth()
      │
ILinkClient.getBotQrcode({ localTokens })
```

### 建议签名

```ts
interface GetBotQrcodeOptions {
  localTokens?: readonly string[];
}

ILinkClient.getBotQrcode(opts?: GetBotQrcodeOptions)
```

调用前：

```text
filter empty
→ dedupe
→ max 10
→ 永不日志打印 token 值
```

当前阶段至少传本 account 已保存 token；如果将来 AccountCredentialStore 支持枚举同渠道多 account，再补最近 10 个。

---

## 7.3 typing ticket cache

当前：

```ts
private readonly typingTickets = new Map<string, string>();
```

拿到后永久不刷新。

Tencent 当前策略：

- per-user cache
- 最多 24h 内随机刷新
- 初始 retry 2s
- 失败指数退避
- 最大 1h

### 新增

```text
packages/channel-weixin/src/upstream/config-manager.ts
```

建议形状：

```ts
interface CachedPeerConfig {
  typingTicket?: string;
  nextFetchAt: number;
  retryDelayMs: number;
  everSucceeded: boolean;
}
```

`TencentWeixinUpstream.resolveTypingTicket()` 改成委托 ConfigManager。

Credential/baseUrl 改变时 clear cache。

---

# 8. Phase 2 — 入站媒体补完整

## 当前真实问题

`mapper.ts` 能产生：

```text
image / audio / file / video
```

但是 `TencentWeixinUpstream.enrichInboundMedia()` 当前只处理：

```ts
if (part.type !== 'image' && part.type !== 'file') continue;
```

因此：

- 图片：能进入 Harness 图片附件
- 文件：能进入 Harness 文件附件
- 语音：只有 encrypted CDN URL/metadata，没有可消费 `localData`
- 视频：同上

这属于“类型看起来支持，但实际模型入口没完整打通”。

---

## 8.1 入站视频

最小变更：

### `upstream/port.ts`

新增：

```ts
downloadVideo(ref: WeixinMediaRef): Promise<WeixinDownloadResult>;
```

### `tencent-upstream.ts`

复用已有：

```text
SecureRemoteMediaFetcher
→ AES key resolve
→ AES-128-ECB decrypt
→ localData
```

视频 mime 固定优先 `video/mp4`。

### `enrichInboundMedia()`

允许：

```text
image
file
audio
video
```

视频成功：

```ts
part.localData = downloaded.data;
part.mimeType = 'video/mp4';
```

失败仍只设置：

```ts
part.ingressFailure = 'download-failed';
```

不丢整条消息。

---

## 8.2 入站语音 + SILK

Tencent 当前微信语音常见 `encode_type=6` = SILK。

### 新增文件

```text
packages/channel-weixin/src/media/silk-transcode.ts
```

行为严格做 graceful degradation：

```text
AES decrypt
   │
   ├─ 非 SILK / 已知可直接用格式 -> 原数据
   │
   └─ SILK
       │
       ├─ silk-wasm decode success -> PCM -> WAV -> audio/wav
       └─ unavailable/fail          -> raw SILK -> audio/silk
```

### package.json

建议把 `silk-wasm` 做成 **optionalDependency**，而不是强依赖整个微信 channel：

```json
{
  "optionalDependencies": {
    "silk-wasm": "^3.7.1"
  }
}
```

代码仍用：

```ts
await import('silk-wasm')
```

并 catch fallback。

原因：不应该因为一个音频 codec 缺失导致微信文字/图片渠道无法启动。

### Port

新增：

```ts
downloadAudio(
  ref: WeixinMediaRef,
  options?: { encodeType?: number; sampleRate?: number }
): Promise<WeixinDownloadResult>;
```

### mapper 改进

当前 voice 有 media 时只产出 audio，导致 `voice_item.text` 的 ASR 文本被忽略。

建议把：

```ts
mapItem(item): MessagePart
```

升级为内部：

```ts
mapItemParts(item): MessagePart[]
```

voice 可以同时输出：

```text
[text: 微信已给出的 voice transcription]
[audio: 原始/转码后的附件]
```

这样 Harness 既可直接读现成转写，也仍保留声音素材。

保留原 `mapItem()` export 可作为兼容 wrapper，避免外部 API 一次破坏。

---

# 9. Phase 3 — 引用消息 `ref_msg`

你的 wire type 已经有：

```ts
ref_msg?: ILinkRefMessage
```

但 `mapper.ts` 完全没有使用。

Tencent 会把引用文字整理为类似：

```text
[引用: 摘要 | 原文]
当前正文
```

### 不建议错误地映射到 `MessageRef.replyTo`

因为当前 iLink `RefMessage` 并不可靠提供一个可直接映射成 Channel `MessageId` 的 referenced message id。

所以不要伪造 replyTo ID。

### 建议

新增纯映射 helper：

```text
packages/channel-weixin/src/messaging/quote.ts
```

```ts
formatQuotedContext(ref: ILinkRefMessage): MessagePart[]
```

规则：

1. quoted text：形成显式 text context。
2. quoted voice transcription：作为 quoted text。
3. quoted media：至少保留 `[引用了图片/视频/文件/语音]` 占位，不把 encrypted URL 暴露给模型。
4. raw 继续保留原始 ref_msg 方便未来升级。

这属于 DSH 纯 mapper，不属于 upstream protocol 逻辑。

---

# 10. Phase 4 — 出站文件 / 视频，并补图片 payload

你其实已经完成最难的 80%：

`media/upload.ts` 已经支持：

```ts
WX5_MEDIA_TYPE_IMAGE = 1
WX5_MEDIA_TYPE_VIDEO = 2
WX5_MEDIA_TYPE_FILE = 3
WX5_MEDIA_TYPE_VOICE = 4
```

且 `UploadMediaOptions` 已有 `mediaType`。

所以不要再写第二套 upload pipeline。

---

## 10.1 重构 `media/send-media.ts`

当前它是 image-only。

建议改成三个纯 builder：

```ts
buildSendImagePayload(...)
buildSendFilePayload(...)
buildSendVideoPayload(...)
```

然后一个共用：

```ts
sendMediaItem(client, payload)
```

### ImageItem

对齐：

```ts
{
  type: IMAGE,
  image_item: {
    media: {
      encrypt_query_param,
      aes_key,
      encrypt_type: 1,
    },
    mid_size: fileSizeCiphertext,
  },
}
```

### FileItem

```ts
{
  type: FILE,
  file_item: {
    media: {
      encrypt_query_param,
      aes_key,
      encrypt_type: 1,
    },
    file_name: fileName,
    len: String(fileSize),
  },
}
```

### VideoItem

```ts
{
  type: VIDEO,
  video_item: {
    media: {
      encrypt_query_param,
      aes_key,
      encrypt_type: 1,
    },
    video_size: fileSizeCiphertext,
  },
}
```

Tencent 2.4.6 的通用 upload pipeline 当前给 image/video/file 都传 `no_need_thumb: true`，所以这个里程碑**不要额外引入 ffmpeg 生成缩略图**；只按当前 2.4.6 真实行为实现。

---

## 10.2 `OutboundSender`

当前：

```text
image -> upload/send
file/audio/video -> CHANNEL_UNSUPPORTED
```

改成：

```text
image -> mediaType=IMAGE -> send image
file  -> mediaType=FILE  -> send file
video -> mediaType=VIDEO -> send video
audio -> 保持 unsupported
```

### 为什么先不支持“语音出站”

虽然 wire enum 里有 `VOICE=4`，但 Tencent 当前 2.4.6 的 `send-media.ts` 只把：

```text
video/* -> video
image/* -> image
其他     -> file attachment
```

它并没有提供成熟的 outbound voice send path。

因此本轮不要把“协议枚举存在”误判为“官方能力已经可用”。

---

## 10.3 `WeixinUpstream port`

当前已有 `sendFile()` 签名但实现是假 capability。

改为真实实现，并新增：

```ts
sendVideo(params: WeixinVideoParams): Promise<WeixinSendResult>;
```

不要新增 `sendVoice()`。

---

## 10.4 `adapter.ts`

完成 live gate 后改 capability：

```ts
readonly capabilities = {
  text: true,
  image: true,
  file: true,
  audio: false,
  video: true,
  markdown: false,
  ...
}
```

注意：

- 入站能收音频 ≠ adapter 的 outbound `audio` capability 应该 true。
- 现有 `ChannelCapabilities.audio` 若代表双向综合能力，则需要先确认项目全局约定；若当前语义是“发送支持”，保持 false。

---

# 11. Phase 5 — Markdown 平台降级

现在微信：

```ts
markdown: false
```

但 `sendText()` 仍把 Harness 输出原样发给微信。

所以模型输出：

```md
### 标题
**粗体**
![image](url)
~~删除~~
```

可能直接以不理想的 Markdown 符号显示。

Tencent 当前使用 `StreamingMarkdownFilter`：

- 保留 code fence / inline code / table / horizontal rule / bold 等可用部分
- 对部分 CJK italic 等做 marker stripping
- 移除 markdown image syntax

### DSH 不需要复制 OpenClaw 的 streaming reply 架构

你微信当前是：

```ts
streaming: 'buffered'
```

所以可以新增：

```text
packages/channel-weixin/src/messaging/markdown-filter.ts
```

对最终整段文本做：

```ts
filterWeixinMarkdown(text): string
```

内部可以复用与 Tencent 相同的状态机规则，但暴露 buffered API。

调用点只放在 `OutboundSender.sendText()` 前。

### capability

仍建议保持：

```ts
markdown: false
```

因为“做兼容过滤”不等于“平台完整支持 Markdown”。

---

# 12. Phase 6 — Tool Call Progress：可以补，但必须先过 Core

Tencent 2.4.4 新增了微信原生：

```text
TOOL_CALL_START  = 11
TOOL_CALL_RESULT = 12
```

用于在模型调用工具时，微信侧显示执行进度。

这个功能很适合 Harness，但 **不能直接照搬 `WeixinReplyProgressSender` 到 adapter**。

原因：你自己的 `ChannelAdapter` contract 已经明确：

> Adapters never call Harness Agent APIs.

当前 Core 也没有一个 host → adapter 的 tool-progress 接口。

## 正确架构

先在 `channel-core` 加通用下行事件：

```ts
export interface ChannelProgressEvent {
  kind: 'tool';
  phase: 'start' | 'end';
  itemId?: string;
  name?: string;
  title?: string;
  status?: 'completed' | 'failed' | 'blocked' | 'unknown';
}
```

ChannelAdapter 可选：

```ts
sendProgress?(
  target: ChannelTarget,
  event: ChannelProgressEvent,
): Promise<void>;
```

链路：

```text
Harness turn/tool event
        │
        ▼
Channel Bridge / ReplyRouter
        │ generic ChannelProgressEvent
        ▼
ChannelAdapter.sendProgress?
        │
        ├─ Telegram: 可忽略/typing/未来 mapping
        ├─ Web: 可映射原生 progress
        └─ Weixin: TOOL_CALL_START/RESULT
```

## 微信实现

新增：

```text
packages/channel-weixin/src/messaging/progress.ts
```

需要先在 `ilink/types.ts` 补：

```ts
MESSAGE_ITEM_TYPE_TOOL_CALL_START = 11
MESSAGE_ITEM_TYPE_TOOL_CALL_RESULT = 12

interface ILinkToolCallStartItem {
  tool_name?: string;
  tool_call_id?: string;
}

interface ILinkToolCallResultItem {
  tool_name?: string;
  tool_call_id?: string;
  status?: string;
}
```

发送时必须沿用：

- 同一个 turn 的 `runId`
- peer 的 `context_token`
- 串行发送链，保证 start/result 顺序
- best-effort；进度发送失败不能让最终 answer 失败

### 配置

```ts
progress: {
  toolCalls: true
}
```

默认可设 true，但只在 adapter 实现 + host 有事件时生效。

### 为什么 P2

这不是微信包局部改动，而是一个值得全渠道复用的 Channel Contract 能力。先把 Core 设计对，再接微信。

---

# 13. Phase 7 — wire type parity

当前 `ilink/types.ts` 建议补齐腾讯 2.4.6 已出现的字段，哪怕部分暂时不映射：

```text
MessageItemType:
  11 TOOL_CALL_START
  12 TOOL_CALL_RESULT

MessageItem:
  create_time_ms
  update_time_ms
  is_completed
  tool_call_start_item
  tool_call_result_item

WeixinMessage:
  delete_time_ms

ImageItem:
  thumb_height
  thumb_width
  hd_size

VideoItem:
  thumb_height
  thumb_width
```

原则：

- wire type 镜像要尽量完整。
- Channel mapper 只映射 Harness 真正需要的字段。
- 不因为 wire 里有字段就扩张 Channel Core。

---

# 14. Phase 8 — 网络错误分类与 abort/timeout 语义修复

Tencent 2.4.5 增加：

```text
dns / tcp / tls / timeout / unknown
```

你现在 transport 做了 query redaction，这很好；但错误分类仍偏粗。

另外当前实现中：

```text
request timeout -> controller.abort()
external signal -> controller.abort()
```

最后都可能呈现为 AbortError，`normalizeILinkError()` 不容易知道究竟是：

- 用户/宿主主动 stop
- 长轮询正常 client timeout
- 真正网络 connect timeout

### 建议在 `transport.ts` 源头分类

新增内部错误：

```ts
type TransportFailureKind =
  | 'abort'
  | 'timeout'
  | 'dns'
  | 'tcp'
  | 'tls'
  | 'http'
  | 'parse'
  | 'unknown';
```

单独记录：

```ts
let timeoutTriggered = false;
let externalAbortTriggered = false;
```

再构造明确 typed error。

日志只输出：

```text
operation
safe URL path
kind
errno/code
http status
```

不要输出：

```text
token
context_token
aes_key
signed query
```

---

# 15. 不应该搬过来的 OpenClaw 功能

下面这些即使 Tencent 仓库里有，也不属于 `channel-weixin` 的协议 parity：

| Tencent 模块/行为 | 处理 |
|---|---|
| `outbound-hooks.ts` 的 OpenClaw `message_sending/message_sent` hooks | 不搬；由 DSH 自己的发送管线治理 |
| OpenClaw command authorization | 不搬；由 Channel Access Gate 处理 |
| `debug-mode.ts` | 不搬；使用 DSH logger/diagnostics |
| OpenClaw `error-notice.ts` | 不原样搬；错误应该走 ChannelError/运行态/UI |
| OpenClaw plugin registration/runtime glue | 不搬 |
| OpenClaw state directory布局 | 不搬；继续 SecretStore/ChannelStorage |
| OpenClaw session key/router | 不搬；继续 ChannelTarget / Harness session |
| OpenClaw CLI login UX | 不搬；继续 ChannelDefinition/control-plane auth flow |

---

# 16. 暂时不要宣称支持的能力

## 微信群组

wire 结构存在 `group_id`，但 Tencent 当前 `weixinMessageToMsgContext()` 明确还是：

```text
ChatType: direct
To: from_user_id
```

因此不能因为 protocol type 有 `group_id` 就宣称 Tencent 当前已经提供成熟群组 channel 语义。

本轮不补 group。

## Voice outbound

同理，存在 `UploadMediaType.VOICE=4` 不代表当前官方发送链已完善。

本轮不补 outbound voice。

## reactions / cards / threads / edit

当前 Tencent iLink channel 没有对应成熟能力，不做假支持。

---

# 17. 推荐的最终文件改动

## 必改

```text
packages/channel-weixin/src/adapter.ts
packages/channel-weixin/src/config.ts
packages/channel-weixin/src/ilink/client.ts
packages/channel-weixin/src/ilink/types.ts
packages/channel-weixin/src/ilink/errors.ts
packages/channel-weixin/src/messaging/mapper.ts
packages/channel-weixin/src/messaging/monitor.ts
packages/channel-weixin/src/messaging/send.ts
packages/channel-weixin/src/media/send-media.ts
packages/channel-weixin/src/upstream/port.ts
packages/channel-weixin/src/upstream/tencent-upstream.ts
packages/channel-weixin/src/manifest.ts
packages/channel-weixin/package.json
```

## 建议新增

```text
packages/channel-weixin/src/media/silk-transcode.ts
packages/channel-weixin/src/messaging/quote.ts
packages/channel-weixin/src/messaging/markdown-filter.ts
packages/channel-weixin/src/upstream/config-manager.ts
packages/channel-weixin/src/upstream/session-state.ts
```

## Tool Progress 阶段再新增

```text
packages/channel-core/src/progress.ts
packages/channel-weixin/src/messaging/progress.ts
```

并在 ChannelAdapter contract 增加 optional `sendProgress()`。

---

# 18. 测试计划

## 18.1 Offline contract tests

### Auth

- QR request 无 token
- QR request 带 1 token
- token dedupe
- 最多 10 token
- token 不进入日志
- `binded_redirect`
- verify code flow

### Session

- `ret != 0`
- `errcode=-14`
- stale token 不 reconnect storm
- 新 credential 后可恢复

### Inbound media

- JPEG
- PNG
- generic file
- SILK voice → WAV
- SILK decoder unavailable → `audio/silk`
- video → `video/mp4`
- encrypted media key: raw 16-byte base64
- encrypted media key: ascii-hex base64
- 100MB cap
- malformed AES key

### Mapper

- voice transcription + audio 同时保留
- `ref_msg` quoted text
- quoted media placeholder
- unknown item → unsupported
- tool item inbound 不误当普通正文

### Outbound

- image request shape
- image `encrypt_type`
- image `mid_size`
- file upload uses media_type=3
- file payload `file_name / len`
- video upload uses media_type=2
- video payload `video_size`
- caption + media 顺序
- context_token 保留
- run_id 保留

### Markdown

覆盖 Tencent filter 的关键 corpus：

- code fence
- inline code
- table
- heading
- CJK italic
- bold
- markdown image
- strike-through
- chunk boundary（即使 DSH 当前 buffered，也确保未来可复用）

### Transport

- DNS
- TCP refused
- TLS
- timeout
- external abort
- HTTP non-2xx
- invalid JSON
- URL query redaction

---

## 18.2 Live 微信测试矩阵

需要真实微信账号 gate，建议 `test/live/weixin-live.test.ts` 扩成以下场景：

| 场景 | 必测 |
|---|---|
| 新 QR 登录 | ✅ |
| 已绑定 bot 再扫码 | ✅ |
| local_token_list → binded_redirect | ✅ |
| 文本收 | ✅ |
| 文本发 | ✅ |
| 图片收 | ✅ |
| 图片发 | ✅ |
| 文件收 | ✅ |
| 文件发 | ✅ |
| SILK 语音收 | ✅ |
| 视频收 | ✅ |
| 视频发 | ✅ |
| quoted message | ✅ |
| typing start/cancel | ✅ |
| Markdown 中文/代码块/表格 | ✅ |
| process stop 时 abort long-poll | ✅ |
| Tool Call Start/Result | Tool Progress 阶段后 ✅ |

### 图片 AES key 编码必须单列

执行：

```text
A. raw 16 bytes -> base64
B. 32-char hex ASCII -> base64
```

记录：

```text
upload success?
sendmessage ret?
微信客户端能否打开原图?
收到后能否再次解密?
```

再决定 contract 标准。

---

# 19. Manifest 收口

现在：

```ts
testedVersion: '<pending-live-verification>'
testedCommit: '<pending-live-verification>'
versionRange: '*'
status: 'experimental'
```

源码核验结束后可以先在 fixture metadata 记录：

```text
2.4.6
cef0bfc390393f716903e16d50408118047f87e0
```

但 **不要只凭代码审计就把 manifest status 改成 tested**。

必须等上面的 live matrix 通过。

通过后建议：

```ts
upstream: {
  testedVersion: '2.4.6',
  testedCommit: 'cef0bfc390393f716903e16d50408118047f87e0',
  versionRange: '>=2.4.6 <2.5.0',
  strategy: 'source-port',
}
status: 'tested'
```

如果你希望更保守，`versionRange` 直接固定为 `2.4.6`，等下一个 Tencent release 再升级。

---

# 20. 推荐实现顺序 / commit 切分

不要一次大 PR 全塞进去，建议按可回滚边界切：

```text
1. test(weixin): capture 2.4.6 protocol fixtures

2. fix(weixin): stop stale-token reconnect loop
3. feat(weixin): pass local tokens into qr login
4. feat(weixin): add refreshable peer config cache

5. feat(weixin): hydrate inbound video media
6. feat(weixin): decode inbound silk voice with fallback
7. feat(weixin): preserve quoted-message context

8. refactor(weixin): generalize media send payload builders
9. feat(weixin): support outbound file attachments
10. feat(weixin): support outbound video
11. fix(weixin): align outbound image metadata with upstream fixtures

12. feat(weixin): filter unsupported markdown syntax
13. fix(weixin): classify transport failures

14. feat(core): add generic channel progress sink
15. feat(weixin): map tool progress to native iLink items

16. test(weixin): expand live parity matrix
17. chore(weixin): pin verified upstream manifest
```

这样每一步都能单独测试/回滚，也不会把 Core contract 改动和媒体协议改动混成一个巨大 PR。

---

# 21. Definition of Done

完成后应满足：

- [ ] `channel-weixin` 不依赖 OpenClaw runtime。
- [ ] `adapter.ts` 不出现 AES/CDN/endpoint 细节。
- [ ] QR 能带 local token，已绑定场景正确处理。
- [ ] stale token 后停止无意义 reconnect。
- [ ] typing ticket 不永久缓存。
- [ ] 入站 image/file/audio/video 都能得到可信 `localData`。
- [ ] SILK 有 WAV 转码，codec 缺失时 graceful fallback。
- [ ] `ref_msg` 不再丢失。
- [ ] 出站 text/image/file/video 可用。
- [ ] outbound voice 仍明确 unsupported，不做假能力。
- [ ] 图片/file/video send payload 有 2.4.6 fixture。
- [ ] Markdown 输出不会把明显不兼容语法原样污染客户端。
- [ ] Tool Progress 只通过通用 Channel Core seam 接入，不从 adapter 反向依赖 Agent。
- [ ] transport 能区分 external abort / timeout / dns / tcp / tls。
- [ ] 所有 token、AES key、context token、signed query 日志脱敏。
- [ ] live matrix 通过后再将 manifest 标成 tested。

---

# 22. 最终结论

你的微信渠道现在不是“缺整个实现”，而是已经完成了一个正确的 DSH-native iLink source-port，基础面大约已经齐了：登录、凭证、长轮询、cursor、dedup、context token、typing、图片、文件入站和图片出站都已经有基础。

剩余工作不应该推倒重来，而应沿现有结构补齐四组缺口：

1. **媒体闭环**：入站语音/视频 + 出站文件/视频 + 图片 payload fidelity。
2. **会话可靠性**：stale token terminal state、QR local token、typing config refresh。
3. **消息语义**：`ref_msg`、Markdown 降级、完整 wire type。
4. **Agent 可视化能力**：通过 Channel Core 通用 progress seam 再接微信 TOOL_CALL_START/RESULT。

最重要的架构决定仍然是：

> **继续保留 `WeixinUpstream` 边界，Tencent/openclaw-weixin 作为协议/行为 source of truth，而不是作为运行时依赖。**

这在 Tencent 还没有发布 host-neutral iLink SDK 的情况下，是当前最稳妥、也最符合你整个 dsh-channels 多渠道架构的做法。

---

## 核验源码入口

- `https://github.com/wsz987/dsh-channels/tree/213fd5c30a63670978c57c0bdd9615ae05c69608/packages/channel-weixin`
- `https://github.com/Tencent/openclaw-weixin/tree/cef0bfc390393f716903e16d50408118047f87e0`
- `https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts`
- `https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/cdn/upload.ts`
- `https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/media-download.ts`
- `https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/media/silk-transcode.ts`
- `https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts`
- `https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/markdown-filter.ts`
- `https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/reply-progress-sender.ts`
- `https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/session-guard.ts`
- `https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/config-cache.ts`
