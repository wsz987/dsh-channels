---
title: 微信 live 验证手册
summary: Weixin 从 experimental 升到 tested 前的真实平台 live gate 操作手册。
when_to_use: 微信 | live gate | 验证 | tested
authoritative: Weixin live gate 前置条件、执行步骤、manifest 写值与状态口径。
see_also: [release.md]
status: runbook
---

# Weixin Live Verification Runbook

微信使用真实账号 QR 登录，live gate 必须由维护者交互执行。离线测试或一次文本往返均不能
单独把 manifest 从 `experimental` 提升为 `tested`。

## 0. 前置条件

- 独立测试微信账号和手机，不建议用主账号执行 stale-token 场景。
- Node 22、pnpm 9.15.3，以及可运行的 `dsh 0.1.1-rc.2` 或兼容版本。
- 已知 Tencent `openclaw-weixin` 的精确 npm package version 和 40 位 commit SHA。
- 三个不含敏感信息的本地素材：JPEG/PNG、普通文件、MP4。
- 执行 GitHub workflow 时，准备受保护的 Linux self-hosted runner，并添加
  `weixin-live` label；repository environment `weixin-live` 应启用人工审批。

QR 图片只写入 runner 的系统临时目录并尝试用默认浏览器打开。日志只显示临时文件路径，
不显示 QR 内容；扫码结束后测试会删除临时目录。不得上传该目录或将 QR 截图作为 CI artifact。
进程正常退出时也会尝试清理；若机器被强制断电，维护者应删除日志中显示的那一个临时目录。

## 1. 先跑离线门禁

```powershell
pnpm build
pnpm typecheck
pnpm test
pnpm check:fixtures
pnpm verify packages/channel-weixin --test
pnpm check:manifests
pnpm doctor
pnpm check:bundle
```

此时 manifest 仍应保持 `experimental`。`pnpm doctor` 的 Weixin
`live verification: PENDING` / `release status: BLOCKED` 是正确结果，不是离线门禁失败。

## 2. 本地执行连续 live suite

PowerShell：

```powershell
$env:DSH_WEIXIN_LIVE = '1'
$env:DSH_WEIXIN_LIVE_IMAGE_PATH = 'C:\weixin-live\wx-image-246.jpg'
$env:DSH_WEIXIN_LIVE_FILE_PATH = 'C:\weixin-live\wx-live-246.txt'
$env:DSH_WEIXIN_LIVE_VIDEO_PATH = 'C:\weixin-live\wx-video-246.mp4'
$env:DSH_WEIXIN_REQUIRE_MEDIA = '1'
pnpm --filter @wsz987/channel-weixin test:live
```

若需指定 endpoint，设置 `DSH_WEIXIN_BASE_URL`；未设置或设置为空字符串时自动使用
`https://ilinkai.weixin.qq.com`。

测试按顺序使用同一份内存 SecretStore/Storage：

1. `E2E-1`：打开本地 QR 文件，扫码确认并持久化真实 credential。
2. `E2E-2`：在微信发送 `WX-E2E-2`，确认收到 `WX-E2E-2-REPLY`。
3. `E2E-3`：不重新扫码，在微信发送 `WX-E2E-3`，验证新 adapter 复用 credential/cursor。
4. `E2E-4`：发送 `WX-E2E-4`，验证 monitor 停止期间已发起的 adapter direct reply 完成。
5. `E2E-5`：直接调用 `adapter.send()` 发送原生图片、文件和视频，人工确认微信消息类型。

`E2E-4` 只覆盖 adapter direct send 与 monitor shutdown 的并发，不覆盖 Harness Agent
`whenIdle`、Agent tail generation 或 Harness 持久化 reconcile。后者必须通过完整 Harness
运行时单独验证，不能从这个 adapter suite 推断。

如果只是排查文本链路，可不设置素材路径且不设置 `DSH_WEIXIN_REQUIRE_MEDIA`，此时
`E2E-5` 会明确跳过；该结果不能作为 Phase 0-4 release gate 通过证据。

## 3. GitHub Actions

Actions -> **Weixin Live Gate** -> Run workflow，填写：

- `upstream_commit`：40 位 Tencent commit SHA。
- `upstream_version`：该 commit 根 `package.json` 的精确 version，例如 `2.4.6`。
- `base_url`：留空使用生产默认值。
- `image_path` / `file_path` / `video_path`：self-hosted runner 上可读的绝对路径。

workflow 会把 Tencent commit fetch 到临时目录，并核对实际 commit 与 `package.json.version`；
仅仅填写格式正确的 SHA/version 不算通过。workflow 不接受预置 bot token，也不上传 QR 或
credential artifact。GitHub 托管 runner 无法在不泄漏 QR 的前提下完成扫码，因此不受支持。

## 4. 仍需手工执行的场景

自动 suite 不覆盖以下破坏性或网络注入场景，详细步骤见
[`tests/weixin-live-phase0-4-test-cases.md`](../tests/weixin-live-phase0-4-test-cases.md)：

- 入站图片、文件、语音、视频 hydration 和引用上下文。
- 只阻断微信 CDN、但保持 iLink API 可访问的降级恢复测试。
- 使真实 token 失效后的 `-14` 终止重连和重新扫码恢复。
- 完整 Harness 的 ACL、附件工具读取、Agent `whenIdle` 和会话绑定行为。

CDN 和 stale-token 测试没有安全、通用的平台自动化入口。执行时必须使用隔离账号/网络，
记录脱敏日志；不能直接修改 credential 文件伪造“平台返回 -14”。

Harness 支持边界也必须写准确：图片可进入 Harness 原生 image block；文件经
`channel-files` 私有附件存储和工具读取；音频/视频当前只验证传输与存储，不代表模型原生
理解音频或视频。当前 outbox 会保留 `channel-files` 中 file/audio/video 的存储类型并按
adapter capability 拒绝不支持的类型；入站图片走 Harness 原生 image seam，不进入该私有
文件 resolver。`E2E-5` 仍用于把 Harness 工具链和微信原生 wire send 分开验收。

## 5. 通过后再写 manifest

只有全部 release blocker 和 High 用例通过、证据完成脱敏复核后，才能在单独变更中更新
`packages/channel-weixin/src/manifest.ts`：

```ts
upstream: {
  testedVersion: '<真实 package version>',
  testedCommit: '<真实 40 位 commit SHA>',
  versionRange: '<实际验证范围，不能为 *>',
  // 其余 source-port 字段保持不变
},
status: 'tested',
```

不要在 live 执行前预填这些值，也不要把 workflow 输入自动写回仓库。更新 manifest 后再跑：

```powershell
pnpm check:manifests
pnpm doctor
pnpm check:upstream
pnpm ci:check
```

此时 `pnpm doctor` 才应显示：

```text
Release verification:
  implementation: PASS
  offline contract: PASS
  live verification: PASS
  tested commit: <40-hex-sha>
  release status: VERIFIED
```

在本手册对应变更尚未完成真实执行时，Weixin manifest 必须继续保持
`status: 'experimental'` 和 pending live 值。
