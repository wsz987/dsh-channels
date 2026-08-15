# Weixin Live Verification Runbook

发布前把 Weixin 从 `experimental` 升到 `tested` 的唯一合法路径是跑通真实平台 live gate。
本 runbook 是"拿到凭据即可一键验收"的操作手册。

## 0. 前置条件

- 一个真实微信账号 + 手机（用于扫 QR + 发消息）。
- 仓库 secret `WEIXIN_LIVE_ENABLED = true`（解锁 inert gate）。
- 已知本次要验证的腾讯 `openclaw-weixin` 上游 commit SHA（40 位 hex）与版本号/tag。

> 注意：Weixin iLink 是 **QR 登录**，没有预置 appId/appSecret。live 测试会打印二维码，
> 由维护者用真实微信扫码确认，所以"凭据"是扫码产生的，不是 secret。

## 1. 一键验收（本地 CLI）

\`\`\`bash
DSH_WEIXIN_LIVE=1 pnpm --filter @wsz987/channel-weixin test:live
\`\`\`

可选：指定 endpoint（默认 prod）：

\`\`\`bash
DSH_WEIXIN_LIVE=1 DSH_WEIXIN_BASE_URL=https://ilinkai.weixin.qq.com pnpm --filter @wsz987/channel-weixin test:live
\`\`\`

或用 GitHub Actions（推荐，自带 preflight）：

1. Actions → **Weixin Live Gate** → Run workflow。
2. 填 `upstream_commit`（40 位 SHA，必填）、`upstream_version`（必填）、可选 `base_url`。
3. 运行时按日志提示扫码、发消息。

## 2. 通过后的离线复核

\`\`\`bash
pnpm check:manifests
pnpm doctor
pnpm check:bundle
pnpm test
\`\`\`

`pnpm doctor` 里 Weixin 的 Release verification 应显示：

\`\`\`text
Release verification:
  implementation: PASS
  offline contract: PASS
  live verification: PASS
  tested commit: <40-hex-sha>
  release status: VERIFIED
\`\`\`

## 3. 写入真实值（`packages/channel-weixin/src/manifest.ts`）

把 manifest 从 pending 改成真实值：

\`\`\`ts
export const manifest: WeixinManifest = {
  id: 'weixin',
  adapterVersion: pkg.version,
  upstream: {
    reference: 'Tencent/openclaw-weixin (direct Weixin iLink client, source-port)',
    testedVersion: '<real-upstream-version>',   // 例如 'ilink-2026-08' 或真实 tag
    testedCommit: '<40-char-real-sha>',          // 必须 40 位 hex
    versionRange: '<verified-range>',            // 例如 '=<40-char-real-sha>' 或具体版本范围
    strategy: 'source-port',
    protocol: 'weixin-ilink',
  },
  sdk: undefined,
  status: 'tested',
};
\`\`\`

\`status: 'tested'` 会触发 `validateManifest` 强校验：`testedVersion` 非 placeholder、
`testedCommit` 为合法 SHA、`versionRange` 非 `*`，任一不满足都会在 `check:manifests` 失败。
写完后再次跑 `pnpm check:manifests && pnpm doctor` 确认 VERIFIED。

## 4. 状态口径

live gate 通过后，本次版本可标记 `Release Verified`，但表述应精确：

> dsh-channels v0.x Release Verified：核心架构、Harness bridge、adapter contract、CI/governance
> 与目标 live gate 已验证。DingTalk official-direct outbound 已完成离线契约验证、
> 尚待真实平台 live gate；Lark multimodal attachment 属于后续 hardening。

（当前 QQ=官方 SDK；Weixin=官方协议 source-port（等 live）；Lark=官方 SDK inbound + 官方
OpenAPI outbound（R7B 已官方化）；DingTalk=官方 SDK inbound + 官方 OpenAPI outbound（等 live）。所以不要写成
"四渠道全部 official-direct verified"。）
