# dsh-channels 多渠道扫码授权与 Harness Web 接入最终执行方案

> **文档性质**：Final Execution Plan / 实施规格
> **目标仓库**：`wsz987/dsh-channels`
> **参考仓库**：`wsz987/openclaw-toolkit`
> **最终运行平台**：DeepSeek Harness
> **日期**：2026-08-15
>
> `openclaw-toolkit` 与 `dsh-channels` **不存在运行时依赖关系**。本方案只参考前者飞书、QQ、钉钉的配置/扫码/轮询/授权 UX 和状态设计，不引入其 Tauri、Rust、OpenClaw Runtime、OpenClaw 配置系统。
>
> **2026-08-15 源码核验修订**：参考项目并非只把官方控制台 URL 包装成二维码。
> 微信、钉钉、飞书均存在 Host 可发起并轮询的真实授权流程；QQ 也实现了可轮询的
> `ptlogin2` 开放平台登录二维码，只是当前参考项目的 QQ 面板没有接回这段已有能力。
> 四个渠道的前置条件和扫码结果不同，不能统一降级为“凭证表单 + 官方平台链接”，
> 也不能把“扫码完成”统一解释为“Channel 已连接”。

## 扫码能力矩阵

| 渠道 | 二维码前置条件 | Host 能否轮询 | 扫码成功得到什么 | Harness Web 最终交互 |
| --- | --- | --- | --- | --- |
| 微信 | 无需 AppID/Secret | 是（iLink QR + long poll） | bot token、bot/user 元数据 | 直接显示“扫码登录”，必要时输入验证码 |
| 钉钉 | 无需预填 ClientID/Secret | 是（`registration/init → begin → poll`） | `client_id` + `client_secret` | “扫码授权”和“手动填写凭证”二选一；扫码成功后 Host 自动保存凭证 |
| 飞书/Lark | **必须先提供 App ID + App Secret + domain** | 是（OAuth device authorization + token poll） | 用户授权 token/scope；不是新的 App ID/Secret | 先保存应用凭证，再显示“插件扫码授权”完成增量授权 |
| QQ | 无需凭证即可生成登录码 | 是（`ptlogin2` QR status） | QQ 开放平台登录状态；**不会返回机器人 AppID/Secret** | 可先扫码登录开放平台，随后创建机器人并手动填写 AppID/Secret |

因此二维码不能删，而应由统一 `AuthSession` 根据渠道定义编排不同前置步骤。只有钉钉扫码
可以直接补齐 Channel 的应用凭证；微信扫码生成运行凭据；飞书扫码依赖已保存的应用凭证；
QQ 扫码只完成开放平台登录，仍需后续凭证表单。
>
> 最终实现必须遵循：
>
> ```text
> DeepSeek Harness
> ├─ Cordis Plugin / Fiber 生命周期
> ├─ ctx.channels
> ├─ ctx.credentials
> ├─ ctx.webServer
> ├─ dsh.client Web Client Plugin
> └─ settings.section
> ```

---

# 0. 最终结论

本次不应该分别给：

```text
channel-weixin
channel-qq
channel-dingtalk
channel-lark
```

各写一套 Web 扫码代码。

正确方向是把现有 Weixin 已完成的：

```text
开始授权
→ 取得二维码
→ 浏览器展示二维码
→ Host 保管 challenge
→ 定时 poll
→ 扫码
→ 确认
→ 验证码（可选）
→ 授权成功
→ 凭据保存
→ Adapter 可用
```

提升成一套通用的：

```text
ChannelControlService
        │
        ├─ Credential Management
        ├─ AuthSessionManager
        ├─ Runtime Mount Manager
        └─ Channel Definition Registry
                   │
       ┌───────────┼──────────────┐
       │           │              │
    Weixin         QQ         DingTalk        Lark
```

而 Harness Web 只负责：

```text
表单
真实 Provider 授权的二维码 / 倒计时 / 验证码（微信 / 钉钉 / 飞书）
QQ 开放平台登录二维码 + 后续凭证表单
官方开放平台链接（所有需要人工补充配置的渠道）
只读连接状态
统一“保存并连接”操作
错误信息
```

**平台协议、Secret、deviceCode、token 都不进入浏览器业务层。**

现有 `channel-core` 已经把 Adapter 定义为平台协议与 Channel Contract 的边界，而且明确禁止 Adapter 触碰 Harness Agent API；这个边界继续保持。

---

# 1. 必须先区分三个概念

这是本次实现最重要的一条。

## 1.1 配置完成

例如：

```text
QQ
AppID = xxx
AppSecret 已保存
```

或者：

```text
飞书
AppID = cli_xxx
AppSecret 已保存
Domain = Feishu
```

叫：

```text
configured = true
```

---

## 1.2 扫码/授权完成

例如：

```text
pending
→ waiting-scan
→ scanned
→ authorized
```

叫：

```text
auth session authorized
```

---

## 1.3 Channel 真正可用

必须最终经过：

```text
Adapter.start()
→ 官方 SDK 建立连接
→ ready / connected
→ getHealth()
```

才能叫：

```text
runtime connected
```

因此：

```text
扫码成功
≠ 配置完成
≠ Channel 已连接
```

Web UI 必须分别展示：

```text
配置状态
授权状态
运行状态
```

不能再用：

```ts
configured = health.authenticated
```

这种推导。

当前 M1 的 `ChannelView` 仍然主要围绕 enabled/configured/mounted/health，而 `configured` 还是过渡语义，这一层应在 M2 正式纠正。

---

# 2. `openclaw-toolkit` 到底值得参考什么

## 2.1 飞书

参考实现的核心不是“前端自己做 OAuth”。

实际交互结构是：

```text
用户填写
App ID
App Secret
Domain / Region
        │
        ▼
Host 发起授权
        │
        ▼
verificationUriComplete
deviceCode
expiresIn
interval
        │
        ├─ deviceCode 留 Host
        │
        └─ verificationUriComplete → Web
                                  │
                                  ▼
                             前端生成二维码
                                  │
                                  ▼
                           手机飞书扫码授权
                                  │
                                  ▼
                             Host 定时 poll
```

它的前端二维码组件直接把 `verificationUriComplete` 当作二维码内容，浏览器使用 QR 库生成图片，并带倒计时、刷新、打开链接等 UX。

参考库的数据结构也明确包含：

```text
deviceCode
verificationUri
verificationUriComplete
userCode
expiresIn
interval
effectiveScope
```

说明二维码只是一种 **device-style 授权入口的视觉表示**，真正授权状态由 Host 保存的 session/deviceCode 驱动。

### dsh-channels 怎么吸收

该流程应作为真实 `device` Auth Session 接入，而不是只参考视觉交互：

```text
✔ AppID/AppSecret 表单
✔ 官方控制台链接
✔ Secret 不回显
✔ 保存 AppID/AppSecret 后由 Host 解析凭据并请求 device authorization
✔ deviceCode 只留在 Host，Web 只拿 verificationUriComplete / expiresAt
✔ Host 按 provider interval 轮询 token endpoint
✔ 授权结果只返回 authorized/scope 等脱敏状态
```

需要注意：参考实现的扫码不是用来生成 AppID/AppSecret，而是应用 owner 的 OAuth 增量授权。
AppID/AppSecret 仍是生成二维码的前置条件。dsh-channels 不照搬：

```text
✘ 控制台 URL 二维码
✘ Tauri invoke
✘ Rust command
✘ OpenClaw config
✘ OpenClaw plugin lifecycle
✘ 将 token response 或 AppSecret 写入日志
✘ 浏览器在每次 poll 时重复传 AppSecret
```

---

# 3. 钉钉参考模式

钉钉参考实现 UI 明确表达的是：

```text
手机钉钉扫码
→ 创建/授权机器人
```

同样使用：

```text
verificationUriComplete
```

作为二维码内容，再在客户端生成 QR 图片。

源码核验表明钉钉已经存在可由 Host 验证的 registration device flow：

```text
POST /app/registration/init
→ nonce
POST /app/registration/begin
→ device_code + verification_uri_complete + expires_in + interval
POST /app/registration/poll
→ WAITING | SUCCESS | FAIL | EXPIRED
→ SUCCESS 时返回 client_id + client_secret
```

其本质应抽象为：

```text
DeviceAuthorizationSession
```

而不是：

```text
DingTalkQrDialog + DingTalkQrState + DingTalkQrApi
```

这种平台绑定设计。dsh-channels 应实现此 session；扫码成功后 `client_id` 写普通配置，
`client_secret` 直接写入 `ctx.credentials`，浏览器不得读取或中转 Secret。手动填写凭证仍作为
已有应用的备用路径。

---

# 4. QQ / 钉钉 / 飞书分别建模，不能统一降级

三家的真实流程不同：

```text
QQ
→ Host 生成并轮询 ptlogin2 登录二维码
→ 登录开放平台成功
→ 用户创建机器人
→ 手动填写 AppID/AppSecret

钉钉
→ Host 发起 registration device flow
→ 手机扫码授权
→ poll 成功直接返回 client_id/client_secret
→ Host 自动保存并启动 Adapter

飞书/Lark
→ 用户先填写 AppID/AppSecret/domain
→ Host 发起 OAuth device authorization
→ 手机扫码完成增量授权
→ Host 轮询 token 结果
→ Adapter 仍使用已保存的应用凭证连接
```

对应 Definition 至少声明：

```ts
weixin.setup.authMethods = ['qr'];
qq.setup.authMethods = ['portal-login', 'credentials'];
dingtalk.setup.authMethods = ['device', 'credentials'];
lark.setup.authMethods = ['hybrid', 'credentials'];
```

其中 `credentials` 表示手动配置路径，不创建轮询 session；`portal-login`、`device`、`hybrid`
都由 `beginAuth()` / `pollAuth()` 驱动。飞书 `hybrid` 在字段未配置时先进入
`credentials-required`，保存凭据后才能生成二维码。QQ `portal-login` 成功后也进入
`credentials-required`，直到机器人 AppID/AppSecret 填写完成。

---

# 5. Weixin 继续作为通用 Auth Contract 的基准实现

当前 `channel-weixin` 已经有完整真实状态机：

```text
wait
scaned
confirmed
expired
need_verifycode
verify_code_blocked
scaned_but_redirect
binded_redirect
```

并将其规范化成 Channel auth 状态。

而且已经正确处理：

```text
二维码过期
扫码但未确认
验证码
redirect
最终 bot token
ilink bot id
user id
base url
```

因此本次不是重新设计 Weixin。

而是：

> **把 Weixin 已经跑通的能力提升为多平台通用控制面。**

---

# 6. Harness 官方边界

## 6.1 Web UI 仍然使用 `settings.section`

现有：

```text
Settings
└─ 渠道
```

继续保持。

`channel-web/client` 当前已经按照 Harness Client Module Loader：

```js
window.__ModuleLoader__.load({
  id,
  factory,
})
```

发布浏览器插件，并通过 `settings.section` 注册自己的设置页。

Harness 官方 Client Module 机制也是通过：

```text
dsh.client
→ Host 扫描模块
→ __DSH_BOOT__
→ /plugins/<id>/client.js
→ __ModuleLoader__
```

加载第三方 Web 模块。

因此：

```text
❌ 不 fork DeepSeek Harness Web
❌ 不另起独立管理后台
❌ 不启动 dsh-channels 自己的 HTTP Server

✅ 继续贡献 Harness Client Plugin
✅ 继续注册 settings.section
```

---

# 7. Host API 必须继续用 `ctx.webServer`

这一点不能混淆。

Harness 的：

```ts
ctx.web
```

是：

```text
模型 Web Search / Fetch Provider
```

不是 GUI HTTP Server。

Channel 管理 API 要继续使用：

```ts
ctx.webServer.register(...)
```

Harness 官方 WebServer 就是 GUI Host 的 HTTP transport seam，并且支持 exact/prefix route 与 disposer。

当前 `channel-web` 已经按照这个方式注册：

```text
/dsh-channels/api/v1
```

是正确方向。

---

# 8. AppSecret 必须统一迁移到 Harness Credentials

这是此次必须顺手修正的架构问题。

Harness 官方规则非常明确：

> 配置只携带对机密的引用，绝不携带机密本身。

官方接口：

```ts
ctx.credentials.resolve(ref)
ctx.credentials.describe(ref)
ctx.credentials.set(ref, value)
ctx.credentials.unset(ref)
```

`describe()` 可以告诉 UI：

```text
configured
source
writable
```

但永远不给 Secret value。

---

## 8.1 QQ 当前已经正确

现在：

```ts
interface QQConfig {
  appId: string;
  appSecretRef: string;
}
```

实际 Secret：

```ts
ctx.credentials.resolve(
  credentialRef(config.appSecretRef)
)
```

再注入 Adapter。

继续保持。

---

# 9. DingTalk 必须迁移

现在是：

```ts
upstream: {
  clientId?: string;
  clientSecret?: string;
}
```

Secret 直接存在 Schemastery config。

改成：

```ts
interface DingTalkUpstreamConfig {
  mode: 'sdk' | 'gateway';

  clientId?: string;

  clientSecretRef?: string;
}
```

推荐默认引用：

```text
DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET
```

插件增加：

```ts
export const inject = [
  'channels',
  'credentials',
];
```

启动时：

```ts
const secret =
  await ctx.credentials.resolve(
    credentialRef(config.upstream.clientSecretRef)
  );
```

然后：

```ts
new DingTalkAdapter(config, {
  clientSecret: secret.value,
})
```

禁止再由：

```ts
config.upstream.clientSecret
```

创建 DWClient。

---

# 10. Lark/飞书必须迁移

现在仍然：

```ts
upstream: {
  appId?: string;
  appSecret?: string;
}
```

并直接传：

```ts
new WSClient({
  appId,
  appSecret,
})
```



改成：

```ts
interface LarkUpstreamConfig {
  mode: 'sdk' | 'gateway';

  appId?: string;

  appSecretRef?: string;

  domain?: string;
}
```

推荐：

```text
DSH_CHANNEL_LARK_MAIN_APP_SECRET
```

或者：

```text
DSH_CHANNEL_FEISHU_MAIN_APP_SECRET
```

---

# 11. Weixin SecretStore 不需要强行迁移

Weixin 与 AppSecret 又不完全相同。

其 QR 登录后产生的是：

```text
bot token
ilink bot id
user id
```

目前实现已经将：

```text
bot token → SecretStore
metadata → ChannelStorage
```

拆开保存。

这可以继续保持。

建议明确两类 Secret：

```text
Harness Credential
    ↓
用户/管理员输入的部署级 Secret
AppSecret / ClientSecret

Channel SecretStore
    ↓
平台协议运行过程中生成的账号凭据
Weixin bot token
OAuth access token
refresh token（视具体平台实现决定）
```

不要为了“统一”把所有 Secret 强塞进同一个存储模型。

---

# 12. 新增 `channel-control`

## 12.1 package

新增：

```text
packages/channel-control/
├─ package.json
├─ src/
│  ├─ index.ts
│  ├─ service.ts
│  ├─ types.ts
│  │
│  ├─ definitions/
│  │  ├─ registry.ts
│  │  ├─ weixin.ts
│  │  ├─ qq.ts
│  │  ├─ dingtalk.ts
│  │  └─ lark.ts
│  │
│  ├─ auth/
│  │  ├─ session-manager.ts
│  │  ├─ types.ts
│  │  └─ sanitizer.ts
│  │
│  ├─ credentials/
│  │  └─ manager.ts
│  │
│  └─ runtime/
│     ├─ manager.ts
│     └─ mount-handle.ts
└─ test/
```

注册：

```ts
ctx.channelControl
```

---

# 13. 最终职责边界

```text
channel-core
    │
    │ 稳定 Channel Contract
    │ Adapter / Event / Message / Health
    │
    ▼
channel-control
    │
    │ 配置
    │ Credential
    │ Auth Session
    │ Runtime mount
    │
    ▼
channel-web
    │
    │ HTTP API
    │ Harness Settings UI
    │
    ▼
DeepSeek Harness Web
```

另外：

```text
channel-harness
```

完全不参与本次扫码。

仍然只做：

```text
ChannelEvent
→ Session Binding
→ Agent
→ ReplyRouter
```

你的项目架构文档已经明确规定：

```text
Adapter = Platform ↔ Channel Contract
```

而不是：

```text
Adapter = Platform ↔ Harness Agent
```

并明确要求 Harness Agent API 只存在于 `channel-harness`。

---

# 14. Channel Definition

不要让 `channel-control`：

```ts
if (channel === 'qq') ...
if (channel === 'dingtalk') ...
```

定义：

```ts
interface ChannelDefinition {
  id: string;

  setup: ChannelSetupDescriptor;

  getConfiguredState():
    Promise<ConfiguredState>;

  saveConfig(
    patch: Record<string, unknown>,
  ): Promise<void>;

  beginAuth?(
    input: AuthBeginInput,
  ): Promise<AuthProviderSession>;

  createAdapter():
    Promise<ChannelAdapter>;
}
```

例如：

```text
QQDefinition
DingTalkDefinition
LarkDefinition
WeixinDefinition
```

平台差异到此为止。

---

# 15. 通用 Auth Session 模型

现有 Core 已有：

```ts
beginAuth()
pollAuth()
submitAuthInput()
```

这是一个很好的起点。

该模型是能力容器，不代表每个渠道都必须声明 AuthMethod。只有 Host 能验证授权进度和结果的
真实 Provider Auth 才进入 AuthSessionManager；当前内置实现仅为 Weixin QR。QQ、钉钉、飞书
使用 setup form，不创建 session。

但 M2 Web 管理面需要更丰富的 Host-side auth state。

新增：

```ts
type AuthMethod =
  | 'qr'
  | 'device'
  | 'portal-login'
  | 'credentials'
  | 'hybrid';
```

以及：

```ts
type AuthPhase =
  | 'preparing'
  | 'waiting-scan'
  | 'scanned'
  | 'waiting-confirm'
  | 'verification-required'
  | 'credentials-required'
  | 'authorized'
  | 'expired'
  | 'failed'
  | 'cancelled';
```

Public coarse state 仍可保持：

```ts
type AuthState =
  | 'pending'
  | 'authenticated'
  | 'expired'
  | 'failed';
```

从而保持 M1 兼容。

---

# 16. 不再通过 `detail` 文本猜状态

当前 M1 Host 里还有类似：

```text
根据 detail 文本
判断 verify-code
confirm
waiting-scan
```

的过渡逻辑。

M2 必须去掉。

改为结构化：

```ts
interface PublicAuthStatus {
  state:
    | 'pending'
    | 'authenticated'
    | 'expired'
    | 'failed';

  phase: AuthPhase;

  prompt?: {
    kind:
      | 'verification-code'
      | 'confirm-on-phone'
      | 'credentials-required'
      | 'open-browser';

    message?: string;
  };

  expiresAt?: number;

  detail?: string;
}
```

Web 永远：

```ts
switch (phase)
```

而不是：

```ts
detail.includes('verify')
```

---

# 17. QR 也要从一个 string 升级为结构化对象

当前：

```ts
qrUrl?: string
```

既可能是：

```text
data:image/png...
```

也可能是：

```text
https://...
```

虽然现在已经能够正确展示，但语义模糊。

M2：

```ts
interface PublicQrPayload {
  kind:
    | 'content'
    | 'data-url'
    | 'external-url';

  value: string;

  expiresAt?: number;
}
```

含义：

### content

例如：

```text
verificationUriComplete
```

Web：

```text
QRCode.toDataURL(value)
```

---

### data-url

例如：

```text
data:image/png;base64,...
```

Web：

```html
<img src="..." />
```

---

### external-url

同时：

```text
生成二维码
+
显示「在新窗口打开」
```

---

# 18. 浏览器只拿 Public Auth Session

Host 内：

```ts
interface InternalAuthSession {
  id: string;

  channelId: string;
  accountId: string;

  provider: string;

  createdAt: number;
  expiresAt: number;

  pollingIntervalMs: number;
  nextPollAt: number;

  deviceCode?: string;

  challenge?: unknown;

  abortController: AbortController;

  providerState: unknown;
}
```

Browser：

```ts
interface PublicAuthSession {
  id: string;

  channelId: string;

  state: AuthState;
  phase: AuthPhase;

  qr?: PublicQrPayload;

  expiresAt?: number;

  prompt?: PublicAuthPrompt;
}
```

以下内容禁止出现在浏览器响应：

```text
AppSecret
ClientSecret
accessToken
refreshToken
botToken
完整 provider payload
session cookie
内部 challenge
```

---

# 19. `AuthSessionManager`

职责：

```text
create()
poll()
submit()
cancel()
expire()
cleanup()
```

约束：

```text
一个 channel/account/auth-method
默认最多一个 active session
```

新 session 创建时：

```text
旧 pending session
→ cancel
→ 新 session
```

Session ID：

```ts
crypto.randomUUID()
```

不使用：

```text
channelId
timestamp
deviceCode
```

直接当浏览器 session id。

---

# 20. Polling 由 Host 控制节流

如果 Provider 返回：

```text
interval = 5 seconds
```

Browser 即使每秒请求：

```text
GET auth session
```

Host 也只能在：

```text
now >= nextPollAt
```

时真正访问 Provider。

即：

```text
Browser polling
      ↓
Channel Host
      ↓
poll throttle
      ↓
Provider API
```

避免浏览器控制第三方 API 的访问频率。

---

# 21. 运行时生命周期必须纳入 `channel-control`

这是目前仓库真正的 M2 缺口。

当前：

```ts
mountChannelAdapter(...)
```

执行：

```text
register
→ start
→ rollback on failure
→ fiber unload 时 stop/unregister
```

已经非常正确。

问题只是：

```ts
mountChannelAdapter(): void
```

把 `ctx.effect()` 返回的 disposer 丢掉了。

而 Harness 官方 Cordis 明确规定：

```ts
ctx.effect(...)
```

会返回一个可主动调用的 disposer，并且父 fiber unload 时仍会自动清理。

所以不要重新发明 lifecycle framework。

---

# 22. 修改 `mountChannelAdapter`

从：

```ts
export function mountChannelAdapter(...): void {
  ctx.effect(...)
}
```

变成：

```ts
export function mountChannelAdapter(
  ...
): AsyncDisposable<Promise<void>> {
  return ctx.effect(...)
}
```

或封装稳定的项目类型：

```ts
export interface ChannelMountHandle {
  dispose(): Promise<void>;
}
```

然后：

```text
ChannelControlService
      │
      └─ Map<ChannelAccountKey, ChannelMountHandle>
```

---

# 23. RuntimeManager

接口：

```ts
interface ChannelRuntimeManager {
  start(
    channelId: string,
    accountId: string,
  ): Promise<void>;

  stop(
    channelId: string,
    accountId: string,
  ): Promise<void>;

  restart(
    channelId: string,
    accountId: string,
  ): Promise<void>;

  status(...): RuntimeStatus;
}
```

restart：

```text
resolve current config
        ↓
resolve current secrets
        ↓
构建 candidate adapter
        ↓
dispose old mount
        ↓
mount candidate
        ↓
adapter.start()
        ↓
getHealth()
```

---

# 24. 更新配置时必须事务化

保存新 AppSecret：

```text
1. ctx.credentials.set()
2. 保存 non-secret config
3. restart
4. 验证 health
```

如果新凭据导致 startup 失败：

```text
不要留下半启动 Adapter
```

当前 `mountChannelAdapter()` 已经实现：

```text
start fail
→ abort
→ stop
→ unregister
→ rethrow
```

因此继续复用。

M2 再增加：

```text
控制面错误
→ Web 显示 credential/config invalid
```

而不是让整个 Harness Profile 因某个未配置 Channel 启动失败。

---

# 25. 更重要：Channel 插件以后不能“一加载就必须连接”

当前 QQ：

```text
插件加载
→ resolve AppSecret
→ 没 Secret
→ throw
```



这适合纯配置部署，但不适合现在的 Web onboarding。

最终需要转成：

```text
Package installed
      ↓
ChannelDefinition registered
      ↓
发现 configured=false
      ↓
不 mount Adapter
      ↓
Web 显示“待配置”
```

用户配置后：

```text
Save
→ RuntimeManager.start()
→ Adapter mount
```

---

# 26. 推荐插件职责调整

例如 `channel-qq/src/index.ts`。

当前：

```text
apply
→ resolve credential
→ new QQAdapter
→ mount
```

M2：

```text
apply
→ register QQDefinition
```

而：

```text
QQDefinition.createAdapter()
```

负责：

```text
resolve appSecret
→ new QQAdapter
```

由：

```text
ChannelControlService
```

决定什么时候 mount。

---

# 27. 保持 Headless 使用能力

不过不能因此让 CLI/headless 用户必须进 Web。

建议 ChannelControlService 启动后：

```text
for every enabled definition
    │
    ├─ configured=true
    │       ↓
    │     autoStart=true
    │       ↓
    │      mount
    │
    └─ configured=false
            ↓
          idle
```

所以用户预先通过：

```text
profile config
+
credentials
```

配好的 Channel 仍然开机自动启动。

Web 只是新的管理入口。

---

# 28. 新 Web API 使用 `/api/v2`

M1 已经存在：

```text
/dsh-channels/api/v1
```

不要直接破坏。

新增：

```text
/dsh-channels/api/v2
```

---

# 29. V2 API

## Channel List

```http
GET /dsh-channels/api/v2/channels
```

返回：

```json
{
  "channels": [
    {
      "id": "qq",
      "configured": false,
      "enabled": true,
      "mounted": false,
      "runtime": "stopped",
      "connection": "disconnected"
    }
  ]
}
```

---

## Setup Descriptor

```http
GET /channels/:channelId/setup
```

返回：

```json
{
  "fields": [
    {
      "name": "appId",
      "kind": "text",
      "secret": false
    },
    {
      "name": "appSecret",
      "kind": "secret",
      "configured": true,
      "writable": true
    }
  ],
  "authMethods": [],
  "setupUrl": "https://q.qq.com/qqbot/openclaw/"
}
```

注意：

```text
只返回 Secret 是否存在
绝不返回值
绝不返回 credential ref
```

---

# 30. Web 统一保存 Setup

```http
PUT /channels/:channelId/setup
Content-Type: application/json

{
  "config": { "appId": "..." },
  "credentials": { "appSecret": "..." }
}
```

一个渠道无论有几个字段，Web 都只有一个“保存并连接”按钮。已配置字段留空表示保持原值；
未配置的必填字段必须填写。Host 校验字段类型后，将普通配置和 Secret 分别写入对应 seam，
再由内部 RuntimeManager 启动或重挂 Adapter。

兼容的低层接口仍可保留，但统一 Web 表单不逐字段调用：

# 30.1 保存普通配置（低层接口）

```http
PATCH /channels/:channelId/config
```

仅允许：

```text
appId
domain
enabled
accountId
markdownSupport
...
```

禁止：

```text
appSecret
clientSecret
token
```

---

# 31. 保存 Secret（低层接口）

```http
PUT /channels/:channelId/credentials/:field
Content-Type: application/json

{
  "value": "..."
}
```

Host：

```text
ChannelDefinition
→ credential ref
→ ctx.credentials.set()
```

返回：

```json
{
  "configured": true,
  "writable": true
}
```

绝不 echo：

```json
{
  "value": "..."
}
```

---

# 32. Auth Session

开始：

```http
POST /channels/:channelId/auth/sessions
```

例如：

```json
{
  "method": "device"
}
```

返回 PublicAuthSession。

---

查询：

```http
GET /channels/:channelId/auth/sessions/:sessionId
```

---

提交验证码：

```http
POST /channels/:channelId/auth/sessions/:sessionId/input
```

例如：

```json
{
  "kind": "verification-code",
  "value": "123456"
}
```

---

取消：

```http
DELETE /channels/:channelId/auth/sessions/:sessionId
```

---

# 33. Runtime 生命周期不向 Web 暴露

`ChannelRuntimeManager` 仍在 Host 内部提供 start / stop / restart，用于：

```text
开机自动挂载已配置渠道
保存 setup 后立即生效
插件 / Fiber 卸载时清理
内部故障恢复
```

但 `/channels/:id/start|stop|restart` 不属于用户 Web API，设置页也不显示对应按钮。用户只执行
“保存并连接”，页面展示只读 connection 状态。

---

# 34. V1 兼容层

原来的：

```text
POST /channels/:id/auth/start
POST /channels/:id/auth/poll
POST /channels/:id/auth/input
```

暂时继续保留。

内部变成：

```text
v1 route
    ↓
ChannelControlService
    ↓
AuthSessionManager
```

Weixin Web 迁移到 V2 后，再在未来 major version 删除 V1。

---

# 35. Web 安全边界继续保持并加强

Harness 官方 WebServer 当前本身不是：

```text
TLS Server
Authentication Gateway
Authorization Server
```

而只是 Host transport，因此管理面的安全不能假设平台会自动替你做。

当前 `channel-web` 已经做：

```text
loopback-only mutation
application/json
64 KiB body limit
strict schema
错误净化
Host-only challenge
```

这些全部保留。

---

# 36. 建议所有敏感 Control API 都 loopback-only

不仅：

```text
PUT credential
POST auth
restart
```

建议：

```text
GET credential describe
```

这种配置控制面也只开放给 loopback Harness Web。

如果未来支持：

```text
dsh web --host 0.0.0.0
```

不能默认把 Channel Secret 管理面一起暴露出去。

---

# 37. Web UI 不再以 `QrAuthDialog` 为中心

当前 `QrAuthDialog` 已经支持：

```text
自动 poll
二维码
倒计时
重新生成
验证码
fallback link
```

实现基础很好。

但未来流程已经不仅仅是 QR。

重构成：

```text
ChannelSetupDialog
│
├─ CredentialStep
├─ QrStep
├─ WaitingStep
├─ VerificationCodeStep
├─ CredentialsRequiredStep
├─ ConnectingStep
└─ CompletedStep
```

---

# 38. QR Renderer 继续通用化

参考项目和当前 dsh 都做得对：

```text
data:image
→ 直接 img

普通 URL/content
→ qrcode.toDataURL()
```

参考项目共享 hook 也是同样思路。

因此抽成：

```text
components/
└─ QrCodeDisplay.tsx
```

不要：

```text
FeishuQr.tsx
DingTalkQr.tsx
QQQr.tsx
WeixinQr.tsx
```

---

# 39. 飞书最终用户流程

```text
Settings > 渠道 > 飞书
        │
        ▼
打开飞书 / Lark 官方开放平台链接
        │
        ▼
选择区域
Feishu / Lark / Custom
        │
        ▼
填写 App ID
填写 App Secret
        │
        ▼
保存并连接（单一按钮）
        │
        ├─ appId → config
        └─ appSecret → ctx.credentials
        │
        ▼
Host 校验配置并内部启动 / 重挂
        │
        ▼
LarkAdapter
        │
        ▼
WSClient connected
        │
        ▼
Channel 可用
```

---

# 40. 飞书这里有一个非常重要的产品语义

当前 `dsh-channels` 的 Lark runtime 实际使用：

```text
appId
appSecret
→ @larksuiteoapi/node-sdk WSClient
→ 长连接
```

并不是依赖 QR device grant 才能建立 Adapter。

因此在 dsh-channels，控制台 URL 只作为普通链接，不创建 QR 授权助手或 Auth Session。

最终“已连接”判断必须来自：

```ts
adapter.getHealth()
```

除非未来选定的飞书上游官方能力明确要求/返回另一套 Bot runtime credential，再单独升级协议。

---

# 41. 钉钉最终流程

```text
打开钉钉开放平台链接
        │
填写 Client ID / AppKey
        │
填写 Client Secret
        │
        ▼
点击一次“保存并连接”
        │
        ▼
config + ctx.credentials
        │
        ▼
Host 内部启动 / 重挂 dingtalk-stream
        │
        ▼
connected
```

DingTalk 当前不声明 AuthMethod；控制台登录或创建应用不是本插件可验证的授权协议。

---

# 42. QQ 最终流程

```text
打开 QQ 开放平台链接（没有机器人时先创建）
       │
填写 AppID
填写 AppSecret
       │
       ▼
保存并连接
       │
       ▼
Host 内部保存并重挂
       │
       ▼
Tencent SDK token prefetch
       │
       ▼
Gateway ready
       │
       ▼
连接成功
```

QQ 不再提供 portal-login Auth Session；官方平台入口是普通链接。

---

# 43. Weixin 流程不改变

```text
开始登录
→ get_bot_qrcode
→ QR
→ waiting scan
→ scanned
→ confirm / verify code
→ confirmed
→ 保存 credential
→ authenticated
```

只把入口改成：

```text
ChannelControlService
```

内部仍继续调用已有：

```text
WeixinAdapter.beginAuth()
pollAuth()
submitAuthInput()
```

---

# 44. 推荐目录最终形态

```text
packages/
├─ channel-core/
│
├─ channel-control/                   # NEW
│  ├─ src/
│  │  ├─ service.ts
│  │  ├─ definitions/
│  │  ├─ auth/
│  │  ├─ credentials/
│  │  └─ runtime/
│  └─ test/
│
├─ channel-harness/
│
├─ channel-web/
│  ├─ src/
│  │  ├─ host/
│  │  │  ├─ routes-v1.ts
│  │  │  ├─ routes-v2.ts
│  │  │  ├─ security.ts
│  │  │  └─ json.ts
│  │  │
│  │  └─ client/
│  │     ├─ ChannelsSection.tsx
│  │     ├─ ChannelSetupDialog.tsx
│  │     ├─ api.ts
│  │     └─ components/
│  │        ├─ CredentialField.tsx
│  │        ├─ QrCodeDisplay.tsx
│  │        ├─ AuthProgress.tsx
│  │        └─ RuntimeStatus.tsx
│
├─ channel-weixin/
├─ channel-qq/
├─ channel-dingtalk/
├─ channel-lark/
└─ channels/
```

---

# 45. 文件级修改计划

## `channel-core`

### 修改

```text
src/mount.ts
```

返回 effect disposer。

不要给 `ChannelService` 塞：

```text
QR API
credentials API
HTTP API
platform setup
```

`ChannelService` 当前职责就是 Registry + Event + Shared Runtime Resources，应保持。

---

# 46. `channel-control`

### 新增

```text
service.ts
definitions/*
auth/session-manager.ts
credentials/manager.ts
runtime/manager.ts
```

### Service

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    channelControl: ChannelControlService;
  }
}
```

inject：

```text
channels
credentials
```

---

# 47. `channel-qq`

保留：

```text
Tencent SDK
Inbound
Outbound
Streaming
Mapper
```

迁移：

```text
QQ Adapter 的创建时机
```

从：

```text
插件 apply()
```

转到：

```text
QQDefinition.createAdapter()
```

现有 `appSecretRef` 无需改回去。

---

# 48. `channel-dingtalk`

修改：

```text
config.ts
index.ts
adapter deps
```

从：

```ts
clientSecret
```

迁移：

```ts
clientSecretRef
```

Adapter deps 增加：

```ts
clientSecret?: string
```

`DWClient` 从 deps Secret 创建。

---

# 49. `channel-lark`

修改：

```text
config.ts
index.ts
adapter deps
```

从：

```ts
appSecret
```

迁移：

```ts
appSecretRef
```

Adapter deps：

```ts
appSecret?: string
```

再创建：

```ts
WSClient
```

---

# 50. `channel-web`

`routes.ts` 逐步变薄。

最终 Host：

```text
HTTP
 ↓
validate
 ↓
ChannelControlService
 ↓
serialize public DTO
```

禁止在这里继续累积：

```text
QQ credentials logic
DingTalk QR logic
Lark OAuth logic
Weixin redirect logic
```

---

# 51. M2 — Control Plane Foundation

## Task 1

新增：

```text
@wsz987/channel-control
```

Service + definition registry。

### Gate

```text
channel-control 单测通过
现有四 Adapter 单测不回退
Harness 可以加载 bundle
```

---

## Task 2

修改：

```text
mountChannelAdapter()
```

返回 disposer。

增加测试：

```text
mount
→ dispose manually
→ adapter.stop exactly once
→ unregister
```

以及：

```text
manual dispose
→ parent fiber dispose
→ 不 double-stop
```

Harness 官方 `ctx.effect` 已保证 disposer 幂等语义，应按官方 seam 使用。

---

## Task 3

实现：

```text
ChannelRuntimeManager
```

完成：

```text
start
stop
restart
```

---

# 52. M3 — Credential Migration

## Task 4 — DingTalk

```text
clientSecret
→ clientSecretRef
```

兼容升级策略：

如果旧配置发现：

```text
clientSecret
```

只在一次明确 migration 阶段：

```text
写入 credentials
→ 改写为 ref
→ 删除 plaintext
```

严禁永久双写。

---

## Task 5 — Lark

同理：

```text
appSecret
→ appSecretRef
```

---

## Task 6 — QQ

保持现有实现，只迁入：

```text
ChannelDefinition
RuntimeManager
```

---

# 53. M4 — Generic AuthSession

## Task 7

实现：

```text
AuthSessionManager
```

包括：

```text
TTL
one-active-session
cancel
poll throttling
AbortController
cleanup
```

---

## Task 8

扩展 Public DTO：

```text
phase
qr.kind
prompt.kind
```

删除 UI 对 `detail` 的业务解析。

---

## Task 9

把 Weixin M1 接入 AuthSessionManager。

### Gate

真实行为不能变化：

```text
扫码
过期
重试
验证码
confirmed
```

fixtures 全部继续通过。

---

# 54. M5 — Harness Web Setup Wizard

## Task 10

新增：

```text
ChannelSetupDialog
```

替代以 Weixin 为中心的：

```text
QrAuthDialog
```

但可以暂时：

```text
QrAuthDialog
→ 内部成为 QrStep wrapper
```

降低一次性改动。

---

## Task 11

实现 Credential UI：

所有字段由一个 form 管理：

```text
普通配置 + Secret
→ 点击一次“保存并连接”
→ PUT /channels/:id/setup
→ Host 分流到 config / ctx.credentials
→ 内部启动或重挂 Adapter
```

已有值的字段允许留空保持不变；尚未配置的必填字段必须填写。禁止为每个字段生成独立保存按钮。

页面后续只显示：

```text
已配置
未配置
只读
来源：environment / local provider
```

这些状态直接来自：

```ts
ctx.credentials.describe()
```

官方 credentials seam 就是为这种配置界面设计的。

---

# 55. M6 — 多渠道扫码与 Setup Form 收口

```text
Weixin
→ 保留真实 QR / poll / verification / cancel / regenerate

QQ
→ portal-login QR / poll
→ 登录成功后引导创建机器人并填写 AppID/AppSecret

DingTalk
→ device registration QR / poll
→ 成功后 Host 自动写 clientId + clientSecret credential
→ 同时保留手动凭证表单

Lark / Feishu
→ AppID/AppSecret/domain 配置为 QR 前置条件
→ 保存凭据后发起 OAuth device authorization / token poll
→ 授权 token 不进入浏览器，应用凭证仍用于 Adapter 连接

All
→ setupUrl 保留为官方备用入口
→ Host 内部重挂并以 Adapter health 判断最终连接状态
```

# 56. QQ / 钉钉 / 飞书 Auth + Setup Gate

自动测试：

```text
Definition 按渠道声明 portal-login / device / hybrid / credentials
QQ 登录扫码成功后仍返回 credentials-required
钉钉扫码成功后自动持久化 clientId/clientSecret，响应不含 Secret
飞书未配置 AppID/AppSecret 时不能开始 device auth
飞书 poll 的 accessToken/refreshToken 不进入浏览器响应或日志
GET setup 返回 authMethods、setupUrl、动态 configured 状态
GET setup 不返回 Secret 或 credential ref
已配置字段留空时保持原值
未配置必填项不允许提交
一个 PUT setup 同时保存 config 与 credentials
Web 不存在 start / stop / restart 路由和按钮
```

真实测试：填写有效平台凭证后，Adapter 在不重启整个 Harness 的情况下连接，并完成手机消息收发。

---

# 59. Security Test Matrix

必须增加：

```text
AppSecret 不出现在 GET response
AppSecret 不出现在 error response
AppSecret 不出现在 logger
accessToken 不出现在 PublicAuthSession
refreshToken 不出现在 PublicAuthSession
internal challenge 不出现在 browser
```

并测试：

```text
非 loopback mutation → reject
非 application/json → reject
oversize payload → reject
unknown field → reject
wrong session/channel binding → reject
expired session → reject
cancelled session → reject
```

---

# 60. Runtime Test Matrix

至少：

```text
unconfigured channel
→ Harness 正常启动
→ UI 显示待配置

configured channel
→ auto mount

bad secret
→ adapter startup fail
→ registry 无残留 adapter

fix secret
→ start
→ connected

stop
→ AbortSignal
→ adapter.stop
→ unregister

restart
→ old adapter disposed
→ new adapter registered
```

---

# 61. QR Test Matrix

通用 renderer：

```text
data:image/png;base64
HTTP URL
opaque QR content
invalid QR content
expired
regenerate
```

现有 Weixin 已经同时支持：

```text
上游直接 data:image
+
https://liteapp.weixin.qq.com/q/...
```

这一点继续作为 renderer regression baseline。

---

# 62. Harness Integration Gate

每个 milestone 最后都要跑：

```text
pnpm test
turbo test
turbo build
```

以及真实 Harness：

```bash
npx @deepseek-ai/dsh plugin --profile web add @wsz987/dsh-channels

npx @deepseek-ai/dsh \
  --profile web \
  --dump-config

npx @deepseek-ai/dsh web
```

验证：

```text
Settings
└─ 渠道
```

Client 仍经：

```text
/plugins/@wsz987/channel-web/client.js
```

加载。

不能因为本次增加 control plane 而变成独立 SPA。

---

# 63. 明确禁止事项

## 禁止 1

不要：

```text
复制 openclaw-toolkit Rust/Tauri commands
```

---

## 禁止 2

不要：

```text
让浏览器直接调用
Feishu / DingTalk / QQ API
```

AppSecret 会穿过浏览器，而且还会引入 CORS、provider protocol 泄漏。

---

## 禁止 3

不要：

```text
把 Secret 塞回 Schemastery config
```

Harness 官方 credentials 已经提供正式 seam。

---

## 禁止 4

不要：

```text
扫码成功 = Channel Ready
```

最终必须看：

```text
Adapter health / connection
```

---

## 禁止 5

不要：

```text
channel-web → Harness Agent
```

Agent/Session 继续只允许：

```text
channel-harness
```

---

## 禁止 6

不要创建：

```text
channel-weixin-web
channel-qq-web
channel-dingtalk-web
channel-lark-web
```

Web 是统一的 control plane。

---

## 禁止 7

不要为 runtime mount 自研一套生命周期框架。

Harness/Cordis 已经提供：

```text
fiber
effect
disposer
restart
update
```

其中 `ctx.effect()` 已提供主动 disposer + 父 fiber 自动回收语义。

---

# 64. 最终架构图

```text
┌────────────────────────────────────────────────────┐
│              DeepSeek Harness Web                  │
│                                                    │
│ Settings > 渠道                                    │
│                                                    │
│  微信      QQ       钉钉       飞书                │
│   │        │         │          │                  │
│   └────────┴─────────┴──────────┘                  │
│                  │                                 │
│         ChannelSetupDialog                         │
│                  │                                 │
└──────────────────┼─────────────────────────────────┘
                   │
                   │ HTTP
                   ▼
┌────────────────────────────────────────────────────┐
│ @wsz987/channel-web                                │
│                                                    │
│ /dsh-channels/api/v2                              │
│                                                    │
│ validation / loopback / redaction                  │
└──────────────────┬─────────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────────┐
│ ChannelControlService                              │
│                                                    │
│ ┌────────────────┐  ┌───────────────────────────┐ │
│ │AuthSessionMgr  │  │CredentialManager          │ │
│ │QR / poll / TTL │  │ctx.credentials            │ │
│ └────────────────┘  └───────────────────────────┘ │
│                                                    │
│ ┌────────────────────────────────────────────────┐ │
│ │ RuntimeManager                                 │ │
│ │ mount / stop / restart                         │ │
│ └────────────────────────────────────────────────┘ │
│                                                    │
│ ChannelDefinitions                                │
│ Weixin / QQ / DingTalk / Lark                     │
└──────────────────┬─────────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────────┐
│ ChannelService / ctx.channels                     │
│ registry / events / resources                     │
└───────┬────────────┬─────────────┬────────────────┘
        │            │             │
        ▼            ▼             ▼
   WeixinAdapter  QQAdapter  DingTalkAdapter  LarkAdapter
        │            │             │              │
        ▼            ▼             ▼              ▼
     iLink      Tencent SDK   DingTalk SDK     Lark SDK
```

消息运行链路完全不变：

```text
Platform
  ↓
Adapter
  ↓
ChannelService
  ↓
channel-harness
  ↓
Harness Agent
  ↓
ReplyRouter
  ↓
Adapter
```

---

# 65. 推荐最终 Milestone

```text
M2A
ChannelControlService
+ ChannelDefinition
+ mount disposer

M2B
DingTalk/Lark credentials migration
+ QQ Definition migration

M3
RuntimeManager
+ unconfigured channel safe startup
+ start/stop/restart

M4
AuthSessionManager
+ structured phase
+ QR payload
+ API v2
+ Weixin migration

M5
Harness Web Setup Wizard
+ Credentials UI
+ generic QR renderer

M6
QQ portal-login QR + credentials continuation
+ DingTalk registration device flow + automatic credential persistence
+ Lark/Feishu credential-gated device authorization
+ manual setup fallback + official setupUrl
+ no public runtime lifecycle controls

M7
security
migration
backward compatibility
live phone E2E
release documentation
```

其中：

```text
M2A → M5
```

属于基础设施主线。

M6 收口多种真实授权与凭证配置 UX；新增 Provider Auth 仍必须以 Host 可验证的协议为前提。

这样以后新增：

```text
Telegram
Discord
Slack
企业微信
```

不用再改 `channel-web` 的基本框架。

---

# 66. Definition of Done

最终必须同时满足：

- [ ] `openclaw-toolkit` 不成为 package/runtime dependency。
- [ ] 不引入 Tauri/Rust/OpenClaw configuration。
- [ ] Harness Web 仍通过官方 Client Plugin + `settings.section` 接入。
- [ ] Host API 仍通过官方 `ctx.webServer.register()`。
- [ ] `channel-harness` Agent/Session 链路零改动或仅与本功能无关的兼容调整。
- [ ] QQ AppSecret 继续通过 `ctx.credentials`。
- [ ] DingTalk ClientSecret 迁移到 `ctx.credentials`。
- [ ] Lark/Feishu AppSecret 迁移到 `ctx.credentials`。
- [ ] Web 永远读取不到 Secret 原值。
- [ ] 未配置 QQ/钉钉/飞书不会导致整个 Harness Profile 启动失败。
- [ ] Weixin 原有真实 QR 登录行为不回退。
- [ ] QR 支持 URL、内容字符串、data URL。
- [ ] QR session 支持 TTL / cancel / regenerate / polling throttle。
- [ ] QQ 可扫码登录开放平台，成功后明确继续提示 AppID/AppSecret，而不误报 Channel 已配置。
- [ ] 钉钉扫码成功后自动保存 clientId/clientSecret，Secret 不经过浏览器。
- [ ] 飞书/Lark 仅在 AppID/AppSecret 已配置后生成 device authorization 二维码。
- [ ] QQ / 钉钉 / 飞书仍保留手动凭证配置与官方 `setupUrl` 作为备用路径。
- [ ] 飞书 token response、钉钉注册响应及所有 Secret 均不写日志。
- [ ] Web 不暴露 Channel Adapter start / stop / restart API 或按钮。
- [ ] 所有渠道最终连接状态仍来自 Runtime health，而不是“凭证已保存”。
- [ ] 保存正确凭据后无需重启整个 Harness，即可启动/重挂 Channel Adapter。
- [ ] Adapter start 失败不会污染 `ctx.channels.registry`。
- [ ] 父 Cordis fiber unload 时所有动态 mount 自动释放。
- [ ] 所有控制面错误经过 redaction。
- [ ] 真实手机扫码/消息收发作为 Manual Gate，不进入 CI。

---

# 67. 实施时最重要的判断

这次真正应该建设的不是：

```text
“复制三个彼此独立、互不兼容的二维码弹窗和轮询器”
```

而是：

```text
DeepSeek Harness
        │
        ▼
通用 Channel Control Plane
        │
        ├─ configuration
        ├─ credentials
        ├─ authorization
        └─ runtime lifecycle
```

二维码只是：

```text
authorization
```

中的一种 challenge renderer。

因此最终应该形成：

```text
Channel Adapter
= 消息协议能力

Channel Definition
= 配置/授权/实例化说明

ChannelControlService
= 管理生命周期

channel-web
= Harness Web Control UI

channel-harness
= Agent / Session Bridge
```

这套拆法与现有 `dsh-channels` 的 Harness-native 架构是一致的：既保留 Weixin 扫码链路，
也让 QQ portal login、钉钉 registration device flow、飞书 credential-gated device flow 复用同一套
Host session / Web renderer，而不会把 `channel-web/routes.ts` 变成第二个业务核心。
