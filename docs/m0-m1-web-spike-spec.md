# M0–M1 Spike 实施规格（agent 执行用）

> 执行对象：本仓库 D:\workspace\dsh-channels（git 基线 0c75ddd）。
> 总计划：见 `docs/dsh-channels-harness-web-visual-integration-execution-plan.md`（M0 §20 / M1 §16）。
> 本文件是**已验证的 ABI 事实 + 精确执行范围**。先读总计划，再按本文件实施。

## 0. 目标

- **M0**：外部 npm package `@wsz987/channel-web` 被官方 Harness（安装版 **0.1.0-rc.6**，非 rc.5）正常加载，在 Settings 出现「渠道」页。**禁止**顺手改任何 Adapter。
- **M1**：只读四渠道仪表盘 + 微信真实扫码闭环（beginAuth/pollAuth/submitVerifyCode 全部复用现有 WeixinAdapter）。**禁止**迁移 QQ/DingTalk/Lark 配置，**禁止**生命周期重构（M2 才做）。

## 1. 已核实的 ABI（rc.6，来自安装产物，勿凭记忆）

### 1.1 客户端包发现（host 侧 dsh-client-modules/lib/index.js）
- 扫描条件（全部满足才入图）：
  1. loader entry 存在且 fiber ACTIVE；
  2. package.json 有 "dsh": { "client": { "platform": "web" } }（platform 必须是字符串，inject 必须是字符串数组）；
  3. exports 有 "./client"（字符串或 { default: string }），指向构建产物。
- 声明了 dsh.client 但缺 ./client 导出 → **抛错使 fiber FAILED**（M0 必须避免）。
- 产物路由：`GET /plugins/<package-name>/client.js?rev=<sha1-12>`；rev 是文件内容 sha1 前 12 位。
- `window.__DSH_BOOT__` 注入 index.html 的 <head>：`{ rev, entries: [{ id, url, rev, inject?, immediately? }] }`。

### 1.2 客户端 bundle 格式（必须逐字节一致的模式，参考 dsh-client-ui-settings-general/lib/client.js）
```js
window.__ModuleLoader__.load({
  id: "@wsz987/channel-web",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // ... 打包后的 CJS 代码（内部相对 import 全部内联；外部包全部走 require()）...
    return module.exports;
  }
});
//# sourceMappingURL=client.js.map
```
- factory 的 require 解析顺序（dsh-client-modules/lib/client.js 的 makeRequire）：seed word → shell static → 已注册 factory。未注册即抛错。
- 因此：**所有 @deepseek-ai/dsh-* 与 react 必须 external**（打包为 require() 调用），内部文件必须内联。

### 1.3 客户端插件形态（参考 dsh-client-ui-settings-general/lib/client.js 的 apply）
```js
export const name = 'channel-web'
export const inject = ['slots', 'locale']   // 模块导出，loader 据此注入服务

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('channels', { zh, en }), 'channel-web: dictionaries')
  const t = ctx.locale.bind('channels')
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'channels',
        order: 60,               // 计划建议值；确认导航位置后固定
        label: () => t('nav'),   // thunk 形式，跟随 locale
        locale: 'channels',
      },
      ChannelsSection,
    ),
  )
}
```
- ctx.effect(cb, label)、ctx.locale.register(ns, {zh,en})、ctx.locale.bind(ns)、ctx.slots.inject(key, cb)、ctx.slots.register(options, component) 均已验证存在。
- settings.section 的 slot 声明由 ui-settings-general 的 sidebar.settings entry 提供；我们的注册通过 slots.inject 等声明出现后再注册，无需等待加载顺序。
- 组件收到 owner props：`{ close: () => void }`（SettingsSectionOwnerProps）。

### 1.4 package.json 声明（channel-web）
```json
{
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings"]
    }
  }
}
```
（dsh.client.inject 是 loader 级依赖边：先加载这些包的 client fiber。slots 服务由 dsh-client-runtime 提供，locale 由 dsh-client-locale 提供。）

### 1.5 Host 侧（channel-web 的 node 半）
- webServer 服务（dsh-host-webserver，rc.6）：`ctx.webServer.register({ kind: 'prefix', path: '/dsh-channels/api/v1', handler: async (req, res) => {} })` → 返回 disposer；handler 是 node:http (req, res)。prefix 匹配最长优先。
- ctx.channels（channel-core/plugin 提供）：`ctx.channels.get(id)`、`ctx.channels.list()`。
- `ctx.inject(['webServer'], webCtx => ...)` 与 `ctx.inject(['channels'], chCtx => ...)`（cordis Registry.inject(deps, callback)）已验证。channel-web 的 loader row **不要硬注入 webServer**；用 ctx.inject 动态等待（非 web profile 不激活）。

### 1.6 ChannelAdapter 契约（channel-core/src/adapter.ts，现状）
- `beginAuth?(): Promise<AuthChallenge>`，`pollAuth?(challenge: AuthChallenge): Promise<AuthStatePoll>`
- AuthChallenge = { id, instruction, qrUrl?, expiresAt?, payload? }
- AuthStatePoll = { state: 'pending'|'authenticated'|'expired'|'failed', detail? }
- getHealth?(): ChannelHealth = { status: 'ok'|'degraded'|'down'|'unknown', detail?, connection?, authenticated?, ... }

### 1.7 WeixinAdapter（channel-weixin/src/adapter.ts，现状）
- id = 'weixin'；start() 无凭据时 disconnected（允许 beginAuth）；
- beginAuth() → AuthChallenge（qrUrl = 上游 qrcode_img_content，base64 图片内容；expiresAt = now+5min）；
- pollAuth(challenge) → 复用，authenticated 时内部 persistCredentialFromAuth + startMonitor；
- submitVerifyCode(code: string): void —— **adapter 特有方法**；
- getHealth() 反映 authenticated/connected。

## 2. 实施范围

### M0（子任务 1）
1. 新建 `packages/channel-web`：
   - package.json（如上；host 依赖 @wsz987/channel-core、@deepseek-ai/cordis；devDeps: esbuild ^0.28.2、rimraf、typescript、vitest）。
   - tsconfig.json：extends ../../tsconfig.base.json；rootDir src；outDir lib；**include 排除 src/client**（client 由 esbuild 打包，不 tsc 检查）。
   - build.mjs：esbuild 打包 src/client/index.ts → lib/client.js（+ map），按 1.2 包装。
   - src/index.ts：host entry（export const name = 'channel-web'；apply 仅注册 webServer prefix 路由，M0 可只留 /dsh-channels/api/v1/channels 返回占位）。
   - src/protocol.ts：ChannelView 等 client-safe DTO（M1 用，M0 先放类型）。
   - src/client/index.ts + src/client/ChannelsSection.tsx + src/client/locales.ts：Settings > 渠道，页面文字「dsh-channels web extension loaded」+ 占位卡片说明。
   - 不引入任何 @deepseek-ai 客户端包运行时 import（react、react/jsx-runtime、@deepseek-ai/cordis 除外；客户端类型用本地结构性接口）。
2. `packages/channels/cordis.patch.yml`：insert 追加 `- id: channels-web` / `  name: '@wsz987/channel-web'`。
3. `packages/channels/package.json`：dependencies 加 `"@wsz987/channel-web": "workspace:*"`。
4. 测试：
   - test/client-registration.test.ts：读 lib/client.js，用 vm 执行（fake window.__ModuleLoader__.load 捕获 {id,factory}），调用 factory(require)（require 打桩），断言 exports.name/inject/apply，且 apply 注册 settings.section（fake slots/locale）。
   - 至少 build + test 通过。
5. 根目录 `pnpm install`（把新 workspace 包链进根 node_modules），然后 `pnpm build`（turbo）。

### M1（子任务 2，M0 验证通过后）
1. **Core 通用 AuthInput（最小、向后兼容）**：channel-core/src/adapter.ts 增加 `export type AuthInput = { kind: 'verification-code'; value: string }` 与 `submitAuthInput?(challenge: AuthChallenge, input: AuthInput): Promise<void> | void`（可选方法）。channel-weixin WeixinAdapter 增加映射：kind==='verification-code' → this.submitVerifyCode(input.value)。
2. Host API（src/host/routes.ts + security.ts），prefix /dsh-channels/api/v1：
   - GET  /channels → ChannelView[]
   - GET  /channels/:id → ChannelView
   - POST /channels/:id/auth/start → PublicAuthChallenge { id, instruction, qrUrl?, expiresAt? }（host 内部 Map 保存完整 AuthChallenge，payload 不过 wire）
   - POST /channels/:id/auth/poll → { state, detail?, prompt? }（body: { challengeId }）
   - POST /channels/:id/auth/input → 同上（body: { challengeId, input: AuthInput }，调 submitAuthInput）
   - 安全（security.ts，全部实现 + 测试）：
     - POST 仅 loopback（127.0.0.1 / ::1 / ::ffff:127.0.0.1），否则 403；
     - Content-Type 必须 application/json，否则 415；
     - body ≤ 64 KiB，否则 413；
     - 严格 schema 校验（手写小型 validator 即可，仓库无 zod），禁止 as any 直传；
     - challenge 过期（expiresAt < now）→ 404/410；
     - 未知 channel / 无 adapter / 无该方法 → 结构化 JSON 错误 { error: { code, message } }；
     - lastError/错误信息净化，禁止泄漏 secret。
   - ChannelView：{ id, enabled, configured, mounted, status, health?, capabilities?, lastError? }（M1 无 managed 生命周期，enabled/configured 用现有 adapter 状态推断）。
3. 客户端 UI：
   - ChannelsSection：四张卡（微信/QQ/钉钉/飞书），真实状态来自 GET /channels；微信卡有「连接微信」按钮；其它卡显示状态 + capabilities + 「配置界面将在下一阶段开放」。
   - QrAuthDialog：二维码（img src = qrUrl data URL）、倒计时（expiresAt - now）、过期遮罩 + 重新生成、等待扫码 / 已扫码待确认 / 需要验证码（输入框提交）、成功、失败。
   - api.ts：fetch('/dsh-channels/api/v1/...')。
4. 测试：routes.test.ts（node:http 起服务 + fake channels/adapter，覆盖全部安全项与正常流）、protocol.test.ts、security.test.ts、client-registration.test.ts 更新。

## 3. 构建与本地验证命令（仓库内）
```bash
pnpm install
pnpm --filter @wsz987/channel-web build
pnpm --filter @wsz987/channel-web test
pnpm build
```

## 4. 明确不做（M0/M1 边界）

- ❌ 不 fork/修改 Harness 源码；不修改 apps/web；不动 dsh-base/dsh-web-app。
- ❌ 不动 channel-harness 的 Agent/Session 语义；Web 不创建 Session。
- ❌ 不动 channel-qq / channel-dingtalk / channel-lark 的配置与 secret 模型。
- ❌ 不做 M2 的 channel-control / managed lifecycle / settings namespaces。
- ❌ 不把 secret 放进任何 wire 响应。
- ❌ 不改 profile 生成机制（`dsh plugin --profile web add` 是官方入口）。
