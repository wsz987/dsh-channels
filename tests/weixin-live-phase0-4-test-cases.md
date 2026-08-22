# 测试用例：Weixin Phase 0-4 Live 验证

## 概述

- **功能**：Weixin QR/会话可靠性、入站媒体、引用消息、出站图片/文件/视频
- **需求来源**：`docs/dsh-channels-weixin-gap-execution-plan.md` Phase 0-4
- **上游基线**：`Tencent/openclaw-weixin@2.4.6`，commit `cef0bfc390393f716903e16d50408118047f87e0`
- **测试环境**：真实微信账号、手机、生产 iLink endpoint
- **最后更新**：2026-08-23

## 准备工作

### 环境

测试前记录以下值：

```powershell
node --version
pnpm --version
dsh --version
git rev-parse HEAD
git status --short
```

构建并安装工作区中的 Weixin 渠道，然后启动 Harness 并显示渠道日志：

```powershell
pnpm build
pnpm channels weixin
pnpm web:debug
```

在 Harness Web 中：

1. 打开 **设置 -> 渠道 -> 微信**。
2. 启用微信，使用测试账号扫描 QR 码。
3. 在手机上确认登录。
4. 确认 **安全访问** 已将扫码账号识别为所有者，并保持“仅所有者”访问。

### 测试素材

准备以下文件，不得使用任何机密内容。

| 素材 | 建议内容 | 约束 |
| --- | --- | --- |
| 图片 | 包含清晰文字 `WX-IMAGE-246` 的照片 | JPEG 或 PNG，小于 2 MiB |
| 文件 | 内容为 `WX-FILE-CONTENT-246` 的 `wx-live-246.txt` | 小于 1 MiB |
| 视频 | 显示 `WX-VIDEO-246` 的 3-5 秒 MP4 | 小于 10 MiB |
| 语音 | 清晰说出 `微信语音验收二四六` | 3-5 秒 |

### 证据规则

每个用例均需记录：测试 ID、时间、PASS/FAIL、微信截图，以及对应的 `[channel-weixin]` 日志摘要。严禁截图或粘贴 QR payload、bot token、`aes_key`、签名 CDN URL、完整 raw payload 或凭据文件。

不得截取 QR 页面本身。自动测试套件会将 QR 保存到本地临时 HTML 文件，只记录该文件路径，并在认证完成后立即删除。GitHub-hosted runner 不适合执行这个交互式 gate，因为通过远程日志或 artifact 展示 QR 会造成泄漏。

## A. 微信窗口测试

### WX-LIVE-001：首次 QR 登录与所有者识别

- **需求**：QR 登录、凭据持久化、所有者身份
- **优先级**：高
- **前置条件**：Weixin 不存在有效的本地凭据。
- **步骤**：
  1. 在 Harness Web 中开始 QR 授权。
  2. 使用测试账号扫码，并在手机上确认。
  3. 等待渠道状态变为 connected/authenticated。
  4. 打开“安全访问”。
- **预期结果**：
  - QR 状态在过期前变为 authenticated。
  - 扫码账号被识别为所有者。
  - DM 仅允许所有者访问；群聊仍不受支持。
  - 浏览器响应和日志中不出现 token 或 QR payload。

### WX-LIVE-002：文本往返

- **需求**：入站与出站文本
- **优先级**：高
- **步骤**：
  1. 在微信中发送 `WX-TEXT-246 请原样回复这段编号`。
  2. 等待 Agent 回复。
- **预期结果**：
  - 只处理一条入站消息。
  - 回复包含 `WX-TEXT-246`，并到达同一聊天。
  - 日志包含稳定的 message/conversation id，以及 `parts: [{ type: 'text' }]`。
  - 等待至少 40 秒后仍未出现重复回复。

### WX-LIVE-003：入站图片 hydration

- **需求**：图片下载、AES 解密、`localData`
- **优先级**：高
- **步骤**：
  1. 发送准备好的图片，并附带文本 `请读取图片中的验收编号`。
  2. 等待 Agent 回复。
- **预期结果**：
  - Agent 识别出 `WX-IMAGE-246`。
  - 图片日志摘要包含 `mimeType=image/jpeg` 或 `image/png`，且 `localDataBytes > 0`。
  - 不存在 `ingressFailure`。
  - 不打印签名 URL、AES key 或图片字节。

### WX-LIVE-004：入站文件 hydration 与读取

- **需求**：文件下载、AES 解密、私有附件存储
- **优先级**：高
- **步骤**：
  1. 发送 `wx-live-246.txt`。
  2. 发送 `读取我刚发的文件，并原样回复其中的验收编号`。
- **预期结果**：
  - Agent 回复 `WX-FILE-CONTENT-246`。
  - 文件日志摘要包含 `name=wx-live-246.txt`、文本 MIME type、正确的非零 size，以及 `localDataBytes > 0`。
  - 面向模型的消息包含私有附件 descriptor，而不是 CDN URL。

### WX-LIVE-005：入站语音与转写

- **需求**：语音下载/解密、SILK 解码降级、保留平台转写
- **优先级**：高
- **步骤**：
  1. 录制微信语音并说出 `微信语音验收二四六`，然后发送。
  2. 发送 `复述上一条语音中的内容`。
- **预期结果**：
  - 如果 iLink 提供 `voice_item.text`，Agent 能复述 `微信语音验收二四六`。
  - 音频日志包含 `localDataBytes > 0`。
  - SILK 解码成功时 MIME 为 `audio/wav`，否则为 `audio/silk`。
  - 解码器失败不会丢弃消息，也不会中断接收循环。
- **说明**：平台未提供转写与二进制 hydration 结果必须分别记录；二进制处理成功本身不能证明 ASR 可用。

### WX-LIVE-006：入站视频 hydration

- **需求**：将视频下载/解密为 MP4
- **优先级**：高
- **步骤**：
  1. 发送准备好的 MP4。
  2. 发送 `确认你收到的上一条附件类型和大小`。
- **预期结果**：
  - Agent 收到视频附件 descriptor，而不只是 `[video]`。
  - 日志包含 `type=video`、`mimeType=video/mp4`，且 `localDataBytes > 0`。
  - 不存在 `ingressFailure`。
- **说明**：这里只验证传输/存储，不验证所选模型对视频内容的理解能力。

### WX-LIVE-007：引用文本上下文

- **需求**：保留 `ref_msg`，且不伪造 `replyTo`
- **优先级**：高
- **步骤**：
  1. 发送 `引用源内容 WX-QUOTE-246`。
  2. 使用微信的引用/回复功能引用该消息。
  3. 发送 `我引用的内容是什么？`。
- **预期结果**：
  - Agent 回答 `引用源内容 WX-QUOTE-246`。
  - 当前消息文本和引用上下文各出现一次。
  - 加密 URL 和 raw `ref_msg` 不会暴露给模型。

### WX-LIVE-008：引用媒体上下文

- **需求**：安全的引用媒体占位符
- **优先级**：中
- **步骤**：
  1. 引用准备好的图片或视频消息。
  2. 发送 `我引用了哪种媒体？`。
- **预期结果**：
  - Agent 将引用类型识别为图片或视频。
  - 引用上下文使用有界占位符，且不包含 CDN URL 或 AES 数据。

### WX-LIVE-009：通过 `send_channel_message` 回传出站文件

- **需求**：出站 FILE 上传与发送
- **优先级**：高
- **前置条件**：已启用 `channel-files`，且 WX-LIVE-004 已生成 attachment id。
- **步骤**：
  1. 发送 `请调用 send_channel_message，把我刚才的 wx-live-246.txt 附件原样发回，并附言 WX-FILE-ECHO-246`。
  2. 在微信中下载/打开返回的附件。
- **预期结果**：
  - 工具报告 `delivered=true`。
  - 微信收到名为 `wx-live-246.txt` 的文件。
  - 文件内容仍为 `WX-FILE-CONTENT-246`。
  - 如果 Agent 提供了附言，随附文本包含 `WX-FILE-ECHO-246`。

### WX-LIVE-010：已有凭据与 `binded_redirect`

- **需求**：`local_token_list` 入口路径与已绑定恢复
- **优先级**：高
- **步骤**：
  1. 完成 WX-LIVE-001 后，在不删除凭据的情况下停止并重启 Harness。
  2. 确认渠道无需重新扫码即可重连。
  3. 在已保存凭据仍然存在时再次开始 QR 授权。
- **预期结果**：
  - 重启会重新加载已有凭据并恢复接收。
  - QR 请求在内部包含本地 token 状态，但 token 值不会出现在日志中。
  - 如果平台返回 `binded_redirect`，adapter 保持 authenticated，monitor 恢复运行。
  - 状态转换后发送新的文本消息仍能收到回复。

### WX-LIVE-011：正在输入指示器冒烟测试

- **需求**：按 peer 获取/缓存 typing ticket
- **优先级**：中
- **步骤**：
  1. 发送一个通常需要至少 5 秒才能回答的问题。
  2. 在最终回复到达前观察微信会话。
  3. 在同一聊天中再重复一次。
- **预期结果**：
  - 当前 iLink 账号/客户端支持时，微信显示正在输入状态。
  - typing config 缺失或获取失败时，最终回复不受影响。
  - 重复发送不会造成明显的 getconfig 请求风暴。

### WX-LIVE-012：重启连续性与去重

- **需求**：凭据/cursor/context 持久化与两阶段去重
- **优先级**：高
- **步骤**：
  1. 发送 `WX-BEFORE-RESTART-246` 并等待回复。
  2. 正常重启 Harness。
  3. 不要再次扫码。
  4. 发送 `WX-AFTER-RESTART-246`。
- **预期结果**：
  - 渠道无需 QR 授权即可重连。
  - 第二条消息在同一逻辑会话中收到一次回复。
  - 第一条消息不会被重放或再次回复。

## B. Adapter-Direct Live Probe

验证 Weixin wire payload 本身时，应将这些用例与 Harness 工具路径隔离。当前 outbox 会保留 `channel-files` 中 file/audio/video 资产的存储类型，并根据 capability 执行 gate；入站图片使用独立的 Harness 原生 image seam，不会由该 resolver 存储。仓库 live suite 包含 `E2E-5`，它使用本地 image/file/video 字节直接调用 `adapter.send()`，避免把工具或附件存储故障误判为 iLink wire 故障。

### WX-LIVE-013：原生出站图片与 AES key 编码 gate

- **需求**：IMAGE 上传、`encrypt_type=1`、`mid_size`、key 编码兼容性
- **优先级**：发布阻断项
- **方法**：运行自动化 `E2E-5`，将 `DSH_WEIXIN_LIVE_IMAGE_PATH` 指向准备好的图片。
- **预期结果**：
  - 微信将结果渲染为图片，而不是普通文件。
  - 发送返回 `delivered=true`。
  - Payload 使用 `encrypt_type=1` 和非零 `mid_size`。
  - `aes_key` 表达方式与已锁定的 Tencent 2.4.6 fixture 一致。
- **Gate**：记录被测 commit 和 payload fixture revision，严禁打印实际 key。如果需要 A/B 候选测试，应从相互隔离的源码 revision 分别运行各编码，只记录 PASS/FAIL；不得增加运行时 fallback，向用户重复发送同一媒体。

### WX-LIVE-014：原生出站视频

- **需求**：使用 `media_type=2` 和 `video_size` 上传 VIDEO
- **优先级**：发布阻断项
- **方法**：运行自动化 `E2E-5`，将 `DSH_WEIXIN_LIVE_VIDEO_PATH` 指向准备好的 MP4。
- **预期结果**：
  - 微信将结果渲染为可播放视频，而不是普通文件。
  - 发送返回 `delivered=true`。
  - 上传使用 `media_type=2`；发送 item 包含 `encrypt_type=1` 和非零 `video_size`。

### WX-LIVE-015：原生出站文件

- **需求**：使用 `media_type=3`、文件名和长度上传 FILE
- **优先级**：高
- **方法**：运行自动化 `E2E-5` 并设置 `DSH_WEIXIN_LIVE_FILE_PATH`，同时另行执行 WX-LIVE-009 验证 Harness 工具路径。
- **预期结果**：
  - 微信收到文件名/内容均保持不变的可下载文件。
  - 上传使用 `media_type=3`；发送 item 包含 `encrypt_type=1`、`file_name` 和非零 `len`。

## C. 受控错误与状态测试

### WX-LIVE-016：媒体 hydration 失败时安全降级

- **需求**：单个附件失败不得丢弃整条消息
- **优先级**：中
- **前置条件**：可以在不阻断 iLink API 流量的情况下阻断 CDN 访问的受控测试网络。
- **步骤**：
  1. 解析并记录当前 iLink API host 和 CDN host，不得记录签名 URL。
  2. 在隔离测试机器上，仅为 `novac2c.cdn.weixin.qq.com` 添加临时 firewall/DNS 规则；不得阻断 `ilinkai.weixin.qq.com` 或任何重定向后的 iLink host。
  3. 验证普通文本往返仍然成功，以证明 API 路径仍然可用。
  4. 发送图片或文件，只收集脱敏后的入站摘要。
  5. 删除刚才添加的准确临时规则，并确认 DNS/网络恢复。
  6. 发送 `WX-CDN-RECOVERY-246` 并等待一次回复。
- **预期结果**：
  - 失败的媒体 part 记录 `ingressFailure=download-failed`，且不含 secret 数据。
  - 接收循环保持运行。
  - 网络恢复后发送的文本被正常处理。
- **自动化限制**：不同操作系统/账号重定向下的 host firewall/DNS 语法和实际 CDN host 可能不同。仓库不会自动修改开发者或 CI 的网络。应在仓库外记录准确且可逆的规则，并确认规则已删除。

### WX-LIVE-017：Stale token 必须终止，不得形成重连风暴

- **需求**：服务端 `errcode=-14` 使认证过期并停止重试
- **优先级**：发布阻断项
- **前置条件**：一次性/测试账号，以及使当前 iLink token 失效的受控方法。没有恢复方案时，不得在主账号上执行。
- **步骤**：
  1. 完成一次普通文本往返并记录时间戳。
  2. 只能通过测试账号可用的 Tencent/微信官方账号操作使活跃登录失效，例如在平台提供对应控制项时撤销/退出 bot session。如果账号没有提供受支持的失效控制，应将本用例标记为 `BLOCKED-LIVE`，不得通过编辑凭据文件或伪造响应代替。
  3. 观察渠道状态和脱敏日志至少 2 分钟。
  4. 重新开始 QR 授权，并使用同一个一次性账号完成认证。
  5. 发送 `WX-STALE-RECOVERY-246` 并等待一次回复。
- **预期结果**：
  - 只发生一次终止性的 stale-token 状态转换。
  - `auth.changed` 变为 `expired`；连接变为 disconnected。
  - 不会继续使用 stale token 执行指数退避的 `getUpdates` 重连循环。
  - 重新认证前，发送操作快速失败。
  - QR 重新认证后，接收/回复恢复正常。
- **自动化限制**：删除或破坏本地凭据只能证明本地凭据缺失/无效，不能证明 Tencent 返回了 `ret=-14` 或 `errcode=-14`。严禁为自动化本用例而把真实 token 存入测试环境变量。

## 自动化 Gate

仓库 live suite 会执行一次 QR 登录，在后续顺序执行的文本/重启/停止场景中复用同一份真实内存 credential/storage，并可选执行原生媒体 probe：

```powershell
$env:DSH_WEIXIN_LIVE = '1'
$env:DSH_WEIXIN_LIVE_IMAGE_PATH = 'C:\weixin-live\wx-image-246.jpg'
$env:DSH_WEIXIN_LIVE_FILE_PATH = 'C:\weixin-live\wx-live-246.txt'
$env:DSH_WEIXIN_LIVE_VIDEO_PATH = 'C:\weixin-live\wx-video-246.mp4'
$env:DSH_WEIXIN_REQUIRE_MEDIA = '1'
pnpm --filter @wsz987/channel-weixin test:live
```

运行期间，发送 `E2E-2`、`E2E-3` 和 `E2E-4` 分别要求的精确文本。`E2E-5` 会报告传输是否 delivered；维护者仍必须在微信中确认三个结果分别渲染为图片、可下载文件和可播放视频。

该 suite 明确不接受 `DSH_WEIXIN_TOKEN`，也没有 fake 默认 token。`DSH_WEIXIN_BASE_URL` 为空时回退到生产默认值。`E2E-4` 仅覆盖进行中的 adapter direct send 与 monitor shutdown 重叠，不覆盖 Harness Agent `whenIdle` 或尾部生成 reconcile。

不得仅凭该 suite 判定 Phase 0-4 完成：入站语音/视频、引用消息、ACL/Harness 附件处理、CDN 故障和真实平台 stale-token 响应仍需手工验证。

live 执行前，在 manifest 保持 experimental 的情况下运行离线 gate。所有发布阻断用例通过后，使用真实验证过的 version/commit/range 更新 manifest，然后运行：

```powershell
pnpm check:manifests
pnpm doctor
pnpm check:upstream
pnpm ci:check
```

## 覆盖矩阵

| 需求 | 测试用例 | 执行前状态 |
| --- | --- | --- |
| QR 登录与本地 token | WX-LIVE-001, 010 | LIVE-REQUIRED |
| 文本与重启连续性 | WX-LIVE-002, 012 | LIVE-REQUIRED |
| 入站图片/文件/音频/视频 | WX-LIVE-003 to 006 | LIVE-REQUIRED |
| 引用上下文 | WX-LIVE-007, 008 | LIVE-REQUIRED |
| 出站文件 | WX-LIVE-009, 015 | LIVE-REQUIRED |
| 原生出站图片/视频 | WX-LIVE-013, 014 | LIVE-REQUIRED |
| Typing config | WX-LIVE-011 | LIVE-REQUIRED |
| 媒体失败降级 | WX-LIVE-016 | LIVE-REQUIRED |
| Stale token 终止状态 | WX-LIVE-017 | LIVE-REQUIRED |

## 通过标准

最低发布 gate：

- 所有高优先级和发布阻断用例均通过。
- 日志中不泄漏 credential、QR payload、AES key、签名 URL、文件内容或 raw payload。
- 成功用例中的入站图片/文件/音频/视频均显示非零 `localDataBytes`。
- 原生出站图片/文件/视频均已验证为对应的微信消息类型。
- `WX-LIVE-013` 已记录通过验证的 AES key 编码。
- 任何失败记录均包含准确的测试 ID、时间戳、脱敏错误、预期结果和实际结果。
