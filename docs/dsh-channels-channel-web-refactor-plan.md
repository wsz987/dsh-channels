# dsh-channels Channel Web 集中化重构实施方案

> 状态：Proposal / Execution Plan  
> 日期：2026-08-19  
> 适用仓库：`https://github.com/wsz987/dsh-channels`  
> 核验基线：`8cf9546edc9e44875c75cae7d28809d5ef36f1df`  
> DeepSeek Harness 核验基线：`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`（`dsh@0.1.0-rc.7`）

---

## 1. 最终决策

本项目采用：

> **产品一体化，代码模块化。**

最终用户只需要安装：

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest
```

用户不需要分别安装：

```text
@wsz987/channel-weixin
@wsz987/channel-qq
@wsz987/channel-dingtalk
@wsz987/channel-lark
@wsz987/channel-telegram
```

这些 `channel-*` 子包的作用是：

- 隔离各渠道 SDK / API / 协议代码。
- 保持运行时职责清晰。
- 便于测试和维护。
- 避免平台依赖污染公共层。
- 避免 Harness breaking change 扩散。

它们**不是最终用户安装边界，也不是前端 UI 边界**。

因此最终设计确定为：

```text
@wsz987/dsh-channels
        │
        ├─ channel-core
        ├─ channel-harness
        ├─ channel-control
        ├─ channel-files
        │
        ├─ channel-weixin
        ├─ channel-qq
        ├─ channel-dingtalk
        ├─ channel-lark
        ├─ channel-telegram
        │
        └─ channel-web
             └─ 统一维护所有 Channel Web UI
```

不采用：

```text
channel-lark/client
channel-qq/client
channel-weixin/client
...
```

也不采用每个渠道独立注册 Harness Client Slot 的方案。

---

# 2. 当前代码核验结论

当前后端控制面总体方向是正确的，不需要推翻。

## 2.1 `channel-control` 已经具备正确的动态架构

当前 `ChannelDefinitionRegistry` / `ChannelControlService` 已实现：

```text
ChannelDefinition 注册
        ↓
ChannelControlService
        ↓
listChannels()
getSetup()
applySetup()
beginAuth()
pollAuth()
runtime.start/stop/restart
```

`channel-control` 不需要知道：

```ts
if (channelId === 'lark')
if (channelId === 'qq')
```

这是正确架构，应继续保持。

因此本次重构重点不是后端 registry，而是：

```text
channel-web
+
enable / disable lifecycle
+
auth request lifecycle
```

---

## 2.2 当前 `channel-web` 仍然存在明显静态耦合

当前：

```ts
const CARD_IDS = [
  'weixin',
  'qq',
  'dingtalk',
  'lark',
  'telegram',
]
```

并且存在：

```ts
const CHANNEL_META = {
  weixin: ...,
  qq: ...,
  dingtalk: ...,
  lark: ...,
  telegram: ...,
}
```

这意味着：

```text
Host / Control
    = 动态

Browser
    = 固定写死 5 个渠道
```

需要修改为：

```text
GET /channels
    ↓
后端返回当前已注册 ChannelDefinition
    ↓
channel-web 根据返回值生成 UI
```

---

## 2.3 当前页面存在永久 3 秒刷新

当前 Channels 页面使用：

```ts
setInterval(..., 3000)
```

持续刷新：

```text
GET /channels
```

这会产生无意义请求。

最终必须删除页面级永久轮询。

---

## 2.4 当前配置入口仍然是 Dialog

当前主要交互：

```text
Channel Card
    ↓
配置按钮
    ↓
Modal
    ↓
配置 / Auth / QR
```

目标改为：

```text
Channel Row
    ↓
Disclosure / Accordion 展开
    ↓
Inline Configuration
```

Dialog 不再作为主设置入口。

---

## 2.5 当前打开配置可能自动启动 Auth

当前流程中：

```text
打开 ChannelSetupDialog
    ↓
GET setup
    ↓
如果初始方式不是 credentials
    ↓
startAuth()
```

这意味着用户只是查看配置，也可能创建：

```text
Auth Session
QR
Polling
```

这是不合理的。

最终必须改为：

```text
展开 Channel
    ↓
只加载 setup
    ↓
不创建 Auth

用户主动点击「开始授权」
    ↓
才 beginAuth
```

---

## 2.6 当前 `authSetup.ts` 已泄漏平台逻辑

目前存在：

```ts
channelId === 'lark'
channelId === 'dingtalk'
channelId === 'telegram'
```

例如：

```ts
isLarkCredentialStep(...)
setupIntroKey(...)
isSetupMethodAvailable(...)
```

这类平台 UI / UX 差异应该集中管理，而不是散落在通用 Auth 逻辑。

---

# 3. 最终职责划分

## 3.1 `channel-core`

职责：

```text
稳定 Channel Contract
Channel Service
Adapter Contract
Message / Reply Contract
```

禁止：

```text
平台 SDK
Harness Agent API
Web UI
```

---

## 3.2 `channel-harness`

职责：

```text
Channel ↔ Harness Agent
Session
Model Selection
Workspace
Reply routing
```

继续作为：

> Harness Agent / Session API 唯一边界。

---

## 3.3 `channel-control`

职责：

```text
ChannelDefinition Registry
Configured State
Credential 管理
Auth Session
Runtime Lifecycle
Enable / Disable
```

必须继续保持：

```text
Adapter agnostic
```

禁止：

```ts
if (channelId === 'lark')
```

---

## 3.4 `channel-*`

例如：

```text
channel-lark
channel-qq
channel-weixin
...
```

职责仅包括：

```text
Adapter
Protocol
SDK
Platform API
Credential semantics
ChannelDefinition
Runtime config
Platform auth implementation
Platform permission check implementation（未来可选）
```

不承担 React UI。

---

## 3.5 `channel-web`

统一负责：

```text
Settings > Channels
Channel list
Accordion
Setup Form
QR/Auth UI
Permission UI
Enable / Disable UI
Platform Web metadata
Official links
Field labels
Platform help text
```

---

# 4. 推荐目录结构

最终建议：

```text
packages/channel-web/
└─ src/
   ├─ index.ts
   │
   ├─ host/
   │  ├─ routes.ts
   │  ├─ routes-v2.ts
   │  └─ security.ts
   │
   └─ client/
      ├─ index.ts
      ├─ api.ts
      ├─ locales.ts
      │
      ├─ channelRegistry.ts
      │
      ├─ ChannelsSection.tsx
      ├─ ChannelRow.tsx
      ├─ ChannelSetup.tsx
      ├─ ChannelAuth.tsx
      ├─ ChannelPermissions.tsx
      ├─ useChannelAuth.ts
      │
      └─ components/
         ├─ ChannelBrandIcon.tsx
         ├─ CredentialField.tsx
         ├─ QrCodeDisplay.tsx
         ├─ AuthProgress.tsx
         └─ RuntimeStatus.tsx
```

不建议继续拆：

```text
controller/
store/
provider-ui/
client-plugin-per-channel/
```

当前项目规模下没有必要。

---

# 5. `channelRegistry.ts`

这是本次重构最关键的 Web 边界。

它用于集中维护：

```text
渠道名称
排序
图标
品牌色
说明
字段 label
Auth UX dependency
权限说明
官方文档 URL
```

它**不是业务逻辑定义**。

例如：

```ts
export interface ChannelWebDefinition {
  id: string
  order: number

  titleKey: string
  descriptionKey?: string
  introKey?: string

  accent?: string

  fieldLabels?: Record<string, string>

  authRequiresConfigured?: Partial<
    Record<AuthMethod, string[]>
  >

  permissions?: {
    docsUrl?: string
    items: ChannelPermissionItem[]
  }
}
```

示例：

```ts
export const CHANNEL_WEB = {
  weixin: {
    id: 'weixin',
    order: 10,
    titleKey: 'channelWeixin',
    accent: '#07c160',
  },

  qq: {
    id: 'qq',
    order: 20,
    titleKey: 'channelQQ',
    introKey: 'setupIntroQQ',
  },

  dingtalk: {
    id: 'dingtalk',
    order: 30,
    titleKey: 'channelDingtalk',
    introKey: 'setupIntroDingtalk',
  },

  lark: {
    id: 'lark',
    order: 40,
    titleKey: 'channelLark',
    introKey: 'setupIntroLark',

    authRequiresConfigured: {
      hybrid: ['appId', 'appSecret'],
    },
  },

  telegram: {
    id: 'telegram',
    order: 50,
    titleKey: 'channelTelegram',
    introKey: 'setupIntroTelegram',
  },
} satisfies Record<string, ChannelWebDefinition>
```

---

# 6. 动态性的最终定义

本项目不需要做成第三方插件市场。

正确的动态模型：

```text
Backend
========

ChannelDefinitionRegistry
        ↓
动态知道当前真正注册了哪些 Channel
        ↓
GET /channels


Frontend
========

GET /channels
        ↓
只渲染 Host 返回的 Channel
        ↓
使用 channelRegistry 补充 presentation metadata
```

因此：

```ts
const channels = await fetchChannelsV2()

const rows = channels.map((channel) => {
  const web =
    CHANNEL_WEB[channel.id]
    ?? createGenericChannelWebDefinition(channel.id)

  return {
    channel,
    web,
  }
})
```

删除：

```ts
CARD_IDS
```

---

# 7. 未知渠道 fallback

即使未来后端出现：

```text
discord
```

而 Web registry 尚未加入，也不应该崩溃。

建议：

```ts
function createGenericChannelWebDefinition(
  id: string,
): ChannelWebDefinition {
  return {
    id,
    order: 999,
    titleKey: id,
  }
}
```

表现为：

```text
Discord
未提供专属展示定义
```

而不是完全消失或报错。

---

# 8. Accordion 交互

Channel 列表采用与 Harness Workspace Sidebar `ProjectRowItem` 一致的
compact disclosure 交互模型：一行一个渠道，点整行展开下方配置。

`ProjectRowItem` 是 `ui-workspace` 内部组件（参数绑着 GroupNode /
WorkspaceBrowserProps / drag / create session 等），官方**没有**导出可供外部插件
复用的 Workspace 行组件；`DisclosureRow` 是另一个通用 primitive，布局语义面向
Reasoning / Tool call / Context injection 行，与本场景不完全一致。因此：

- `ChannelRow` 由 `channel-web` 自己维护（薄业务组合层）。
- 复用 Harness 官方 primitives 与 tokens：

```text
IconTriangleRightFill14
StateDot
Button
Pill
Input
Menu
Modal
RiskConfirmation
Tooltip
Toast
--dsw-* tokens
```

- 参考官方 `ProjectRowItem` 的交互与视觉：整行 `role="button"` +
  `aria-expanded`、箭头旋转 90°、hover 背景、compact row 布局。
- 不直接依赖 `ui-workspace` 内部 `ProjectRowItem`，也不强制使用布局语义
  不同的 `DisclosureRow`。

当前 Harness `ui-primitives` 已提供：

```text
StateDot
Button
Pill
Input
Menu
Modal
RiskConfirmation
Tooltip
Toast
IconTriangleRightFill14
...
```

当前未提供统一 `Switch` primitive，因此第一阶段不要自行造 Switch。

---

## 8.1 页面结构

目标：

```text
微信                  ● 已连接
──────────────────────────

QQ                    ○ 未配置
──────────────────────────

▼ 飞书                ● 已连接

    连接状态
    ──────────────────────

    应用配置

    App ID
    [__________________]

    App Secret
    [••••••••••••••••••]

    [保存并连接]

    授权
    ──────────────────────

    [开始授权]

    权限与事件
    ──────────────────────

    ✓ 消息接收
    ✓ 消息发送
    ! 机器人权限

    [查看官方文档]

    高级操作
    ──────────────────────

    [停用渠道]

──────────────────────────

Telegram              ○ 未配置
```

---

## 8.2 推荐实现

交互结构参考官方 `ProjectRowItem`（tree row 语义），`ChannelRow` 自维护：

```tsx
<div
  role="button"
  tabIndex={0}
  aria-expanded={open}
  onClick={onToggle}
  onKeyDown={toggleFromKeyboard} // Enter / Space
>
  <span style={{ background: accent + '1f' }}>
    <ChannelBrandIcon channelId={channel.id} />
  </span>

  <IconTriangleRightFill14
    style={{
      transform: open ? 'rotate(90deg)' : undefined,
      transition: 'transform 150ms ease',
    }}
  />

  <span>{title}</span>

  <span>
    <StateDot state={collapsedDot(channel)} size={8} />
    <span>{collapsedLabel}</span>
  </span>
</div>

{open && (
  <div>
    <ChannelSetup
      channel={channel}
      definition={definition}
    />

    <ChannelAuth
      channel={channel}
      definition={definition}
    />

    <ChannelPermissions
      channel={channel}
      definition={definition}
    />
  </div>
)}
```

---

# 9. Accordion 状态

建议第一版：

```ts
const [openChannelId, setOpenChannelId] =
  useState<string | null>(null)
```

只允许一个 Channel 展开。

理由：

- 减少视觉复杂度。
- 防止多个 Auth UI 同时存在。
- 简化请求生命周期。
- 更容易严格做到“只有打开的 Channel 请求”。

---

# 10. 请求生命周期

这是本次重构的硬要求。

---

## 10.1 页面进入

只调用：

```text
GET /dsh-channels/api/v2/channels
```

一次。

禁止：

```text
永久 3 秒 GET /channels
```

---

## 10.2 Channel 未展开

必须满足：

```text
0 GET setup
0 beginAuth
0 pollAuth
0 permission probe
```

---

## 10.3 Channel 展开

例如：

```text
用户展开 Lark
        ↓
GET /channels/lark/setup
```

只加载 Lark。

不加载：

```text
QQ setup
Telegram setup
DingTalk setup
...
```

---

## 10.4 展开不自动授权

展开以后：

```text
GET setup
```

完成。

不能自动：

```text
POST auth/sessions
```

二维码不能自动创建。

---

## 10.5 用户主动开始授权

只有：

```text
用户点击「开始授权」
```

才执行：

```text
POST /channels/:id/auth/sessions
```

然后：

```text
PublicAuthSession
    ↓
QR / Verification UI
    ↓
poll
```

---

# 11. Auth Lifecycle

授权轮询只在以下条件全部成立时运行：

```text
row open
AND
auth UI active
AND
session pending
AND
document visible
```

即：

```ts
const shouldPoll =
  open &&
  authActive &&
  session?.state === 'pending' &&
  document.visibilityState === 'visible'
```

---

# 12. 收起 Channel 时

如果当前存在未完成 Auth Session：

```text
Collapse
    ↓
Abort 当前 HTTP Request
    ↓
DELETE Auth Session
    ↓
clear timeout
```

即：

```text
收起 = 用户退出当前授权流程
```

---

# 13. 浏览器进入后台

当：

```text
document.visibilityState === 'hidden'
```

只做：

```text
暂停 client poll
```

不立刻 DELETE session。

用户回来：

```text
visible
    ↓
检查 session
    ↓
未过期 + pending
    ↓
立即 poll 一次
    ↓
继续正常 interval
```

---

# 14. 不再使用 `setInterval`

当前：

```ts
setInterval(poll, 3000)
```

替换为：

```ts
async function pollLoop() {
  const status = await pollAuthSession(...)

  if (!shouldContinue(status)) {
    return
  }

  timer = window.setTimeout(
    pollLoop,
    interval,
  )
}
```

优势：

```text
Request
  ↓
完成
  ↓
等待 interval
  ↓
下一次 Request
```

不会发生：

```text
前一次没完成
下一次 interval 又触发
```

---

# 15. Provider Poll Interval

Host 内部当前已经存在：

```ts
pollingIntervalMs
```

并且 AuthSessionManager 已经按照：

```text
nextPollAt
```

对 Provider 做 throttle。

建议将安全的 interval 暴露给 Browser：

```ts
export interface PublicAuthSession {
  id: string
  channelId: string

  state: AuthState
  phase: AuthPhase

  pollingIntervalMs?: number

  qr?: PublicQrPayload
  expiresAt?: number
  prompt?: PublicAuthPrompt
}
```

Sanitizer：

```ts
if (session.pollingIntervalMs > 0) {
  publicSession.pollingIntervalMs =
    session.pollingIntervalMs
}
```

这个字段：

```text
不是 secret
不是 token
不是 deviceCode
不是 providerState
```

可安全暴露。

---

# 16. API 支持 AbortSignal

建议统一：

```ts
export async function fetchSetup(
  id: string,
  signal?: AbortSignal,
) {
  return request(..., { signal })
}
```

同样适用于：

```text
beginAuth
pollAuthSession
submitAuthInput
```

当：

```text
Row collapse
Component unmount
切换 Channel
```

可以立即 abort。

---

# 17. Setup 与 Auth 解耦

当前 Dialog 里：

```text
Credentials
    ↓
Lark special case
    ↓
Save
    ↓
自动 Hybrid Auth
```

这种状态机会越来越复杂。

新设计改成两个独立区域：

```text
Setup
Auth
```

---

## 17.1 Setup

统一：

```ts
applySetup(channelId, {
  config,
  credentials,
  reconcile: true,
})
```

按钮：

```text
[保存并连接]
```

---

## 17.2 Auth

统一：

```text
[开始授权]
```

如果当前 Auth 方式依赖某些字段，例如 Lark：

```ts
authRequiresConfigured: {
  hybrid: [
    'appId',
    'appSecret',
  ],
}
```

则：

```text
点击开始授权
    ↓
检查 prerequisite
    ↓
如果存在未保存内容
    ↓
applySetup(reconcile:false)
    ↓
重新 GET setup
    ↓
确认 configured
    ↓
beginAuth
```

无需：

```ts
isLarkCredentialStep()
```

---

# 18. 删除 `authSetup.ts`

当前：

```text
authSetup.ts
```

最终应删除。

其中：

```text
setupIntroKey
isLarkCredentialStep
isSetupMethodAvailable
```

分别移动到：

```text
channelRegistry.ts
+
通用 Auth prerequisite 逻辑
```

---

# 19. Enable / Disable：当前代码必须先修

这是本次重新核验最新代码后发现的关键问题。

当前多个 Provider：

```ts
export function apply(...) {
  if (!config.enabled) return

  const control = ctx.get('channelControl')

  ...
}
```

这意味着：

```text
enabled=false
    ↓
apply() return
    ↓
ChannelDefinition 没注册
    ↓
ChannelControl 根本不知道它存在
    ↓
Web 无法把它重新启用
```

因此 UI Enable / Disable 在当前底层模型下并不完整。

---

# 20. 正确的 Provider Apply 生命周期

必须改成：

```ts
export function apply(
  ctx: Context,
  config: ChannelConfig,
) {
  const control =
    ctx.get('channelControl')

  if (control) {
    // 即使 disabled 也注册。
    control.definitions.register(
      createDefinition(...)
    )

    return
  }

  // Legacy / standalone fallback
  if (!config.enabled) {
    return
  }

  mountLegacy(...)
}
```

即：

```text
Control Plane 模式
    ↓
Definition 永远注册

enabled=false
    ↓
存在于目录
但 runtime 不启动
```

这是正确模型。

---

# 21. `ChannelDefinition.enabled` 需要动态化

当前很多 Definition 直接：

```ts
enabled: state.enabled
```

这很容易变成注册时快照。

如果支持动态 Enable / Disable，建议：

```ts
interface ChannelDefinition {
  id: string

  readonly enabled: boolean

  setEnabled(
    enabled: boolean,
  ): Promise<void>

  ...
}
```

实现：

```ts
return {
  id: 'lark',

  get enabled() {
    return state.enabled
  },

  async setEnabled(enabled) {
    state.enabled = enabled

    await persistEnabled?.(
      enabled,
    )
  },

  ...
}
```

---

# 22. `ChannelControlService.setEnabled`

增加：

```ts
async setEnabled(
  channelId: string,
  enabled: boolean,
): Promise<ChannelSummary> {
  const definition =
    this.definitions.require(channelId)

  await definition.setEnabled(enabled)

  if (!enabled) {
    await this.runtime.stop(channelId)
  } else {
    const state =
      await definition.getConfiguredState()

    if (state.configured) {
      await this.runtime.start(channelId)
    }
  }

  return this.getChannel(channelId)
}
```

---

# 23. Enable API

建议：

```text
PUT /dsh-channels/api/v2/channels/:id/enabled
```

Body：

```json
{
  "enabled": true
}
```

返回：

```json
{
  "id": "lark",
  "enabled": true,
  "configured": true,
  "mounted": true,
  "runtime": "running",
  "connection": "connected"
}
```

---

# 24. Channel 状态语义必须严格区分

不要再混淆：

```text
enabled
configured
mounted
runtime
connection
```

定义如下：

### `enabled`

用户配置意图：

```text
是否允许该 Channel 运行
```

### `configured`

```text
是否满足运行需要的配置 / Credential
```

### `mounted`

```text
当前 Adapter 是否已经挂载
```

### `runtime`

```text
running / stopped
```

### `connection`

```text
connected
degraded
disconnected
unknown
```

---

# 25. Enable UI

已实现：渠道行直接提供一个 启动/停用 Switch（行的右侧，见 §8 页面结构）。

产品体验按用户要求改为「直接一个 switch」：

- 折叠行右侧放一个 Switch（`role="switch"` + `aria-checked`），点击直接
  启用/停用渠道，无需展开。
- Switch 是行内 disclosure 按钮的子元素，故点击/键盘 Enter/Space 都
  `stopPropagation`，绝不触发整行展开（与官方 `ProjectRowItem` 动作按钮的
  `e.stopPropagation()` 同一模式）。
- 点击后调用 `PUT /channels/:id/enabled`；失败在行下方直接显示错误。

实现：

官方 `@deepseek-ai/dsh-client-ui-primitives` 仍无 Switch primitive，但
Harness 自身的 trajectory 工具栏已有 `role="switch"` 先例（track + thumb、
`aria-checked`、ON 态用 `--dsw-alias-state-business-primary`、focus 用同色
outline）。`channel-web` 据此在本地实现一个小的 `Switch`（
`src/client/components/Switch.tsx`），仅用官方 `--dsw-*` tokens，不依赖
`ui-workspace` 等内部组件：

```tsx
<button type="button" role="switch" aria-checked={checked} onClick={...}>
  <span data-on={checked}>...thumb...</span>
</button>
```

不要为它引入未导出 / 内部依赖；Harness 未来若提供官方 Switch，再替换。

---

# 26. Permissions UI

平台权限统一由：

```text
channel-web/channelRegistry.ts
```

维护展示信息。

例如：

```ts
permissions: {
  docsUrl: '...',

  items: [
    {
      id: 'im.message',
      labelKey: 'larkPermissionMessage',
      required: true,
    },
  ],
}
```

---

# 27. Platform Permission 与 Harness Permission 必须分开

这是两个不同系统。

## Platform Permission

例如：

```text
Lark scopes
QQ Bot permissions
DingTalk event permission
Telegram bot capabilities
```

属于：

```text
Channel Platform
```

---

## Harness Permission

例如：

```text
workspace-write
danger-full-access
approval policy
sandbox mode
```

属于：

```text
Harness Agent
```

不能把两者混进同一个 Permission model。

---

# 28. Permission 检查

第一阶段：

```text
只展示官方要求
+
官方文档
```

以后平台支持 API introspection 时：

```text
Browser
    ↓
Channel Web API
    ↓
ChannelDefinition / Provider
    ↓
平台 API
    ↓
Sanitized Permission Status
```

Browser 永远不能：

```text
直接拿 token
直接拿 secret
直接调用平台 credential API
```

---

# 29. Refresh 策略

删除：

```text
全局 setInterval 3000
```

改为事件驱动。

刷新 `/channels` 的时机：

```text
首次进入 Channels
浏览器重新 visible
Setup 保存成功
Auth 成功
Enable 成功
Disable 成功
Disconnect 成功
用户手动 Retry
```

---

# 30. Connection 状态

第一阶段不做实时永久刷新。

如果后续确认必须实时展示：

```text
只对当前展开的 Channel
```

增加低频 status refresh。

不要恢复：

```text
整个页面所有 Channel 每 3 秒刷新
```

---

# 31. Harness 官方 UI 使用原则

必须优先使用：

```text
IconTriangleRightFill14
StateDot
Button
Pill
Input
Menu
Modal
RiskConfirmation
Tooltip
Toast
```

Channel 列表行（`ChannelRow`）是 channel-web 自维护的业务组合层：交互参考
官方 Workspace `ProjectRowItem`（role=button / aria-expanded / 箭头旋转 /
hover / compact row），但复用以上 primitives 与 tokens，不依赖 `ui-workspace`
内部组件，也不强制使用布局语义不同的 `DisclosureRow`。

允许自己写：

```text
layout
spacing
grid
section chrome
QR render
brand icon
ChannelRow 行组合
```

但 CSS 必须继续基于：

```text
--dsw-*
```

Harness tokens。

---

# 32. Modal 只用于二次确认

主配置 UI 不再使用 Modal。

Modal / RiskConfirmation 留给：

```text
删除 Credential
断开账号
重置配置
危险权限
高风险操作
```

---

# 33. Aggregate Bundle 保持当前模式

本轮不修改用户安装模型。

继续：

```text
@wsz987/dsh-channels
```

一次安装所有官方 Channel。

不引入：

```text
@wsz987/dsh-channels-base
```

不要求：

```text
@wsz987/channel-lark
@wsz987/channel-qq
```

成为用户安装单元。

---

# 34. 不再做 Provider Client Bundle

明确删除上一版方案中的：

```text
channel-lark/src/client
channel-qq/src/client
channel-weixin/src/client

dsh.client per provider
channels.item keyed slot
```

原因：

```text
子包是源码职责边界
不是产品 UI 扩展边界
```

---

# 35. 当前 Aggregate Client 机制保留

当前：

```text
@wsz987/dsh-channels
```

通过 build：

```text
channel-web/lib/client.js
    ↓
复制 / 改 Module ID
    ↓
dsh-channels/lib/client.js
```

在当前产品模型下可以继续保留。

本轮无需为了理论上的独立 Provider 安装去修改 Loader Identity。

---

# 36. 架构文档红线 4 需要调整

当前红线：

> Root package 安装所有渠道 SDK。

与产品目标：

> 用户一次安装所有官方渠道。

存在表达冲突。

建议修改为：

> **Root Bundle 不得直接实现或直接调用任何平台 SDK。平台 SDK 的依赖和使用必须被隔离在对应 `channel-*` 子包。Root Bundle 可以通过依赖这些子包完成一次性产品安装。**

也就是：

```text
允许：

dsh-channels
  -> channel-lark
       -> Lark SDK


禁止：

dsh-channels/src/*
  import '@larksuiteoapi/node-sdk'
```

---

# 37. 新的架构红线

## 红线 W1

禁止：

```ts
ChannelSetup.tsx

if (channelId === 'lark') {
}
```

---

## 红线 W2

禁止：

```ts
ChannelAuth.tsx

if (channelId === 'weixin') {
}
```

平台 UX metadata 应集中在：

```text
channelRegistry.ts
```

---

## 红线 W3

禁止：

```text
channel-lark
  React UI

channel-qq
  React UI
```

---

## 红线 W4

禁止：

```text
channel-web
  import platform SDK
```

例如：

```ts
import '@larksuiteoapi/node-sdk'
```

---

## 红线 W5

Browser 永远不能看到：

```text
Secret
Token
deviceCode
providerState
challenge
```

---

## 红线 W6

Channel Row 收起状态必须：

```text
0 setup request
0 auth request
0 permission request
```

---

## 红线 W7

没有用户操作不得：

```text
beginAuth()
```

---

## 红线 W8

禁止页面级：

```ts
setInterval(fetchChannels, ...)
```

---

## 红线 W9

禁止自己重新实现 Harness 已提供的：

```text
Button
Input
Modal
Tooltip
Status dot
Chevron / 三角箭头 icon
```

例外：官方未导出 Workspace 行组件（`ProjectRowItem` 是 `ui-workspace` 内部
实现，`DisclosureRow` 布局语义面向其他行型），`ChannelRow` 行组合属于
channel-web 自维护的业务层，允许自写——但必须复用上述 primitives、
`IconTriangleRightFill14` 与 `--dsw-*` tokens，交互（role=button /
aria-expanded / 箭头旋转 / 整行点击）参考官方 `ProjectRowItem`。

---

# 38. 实施阶段

---

## Phase 1 — Enable Lifecycle

优先级：最高。

修改：

```text
channel-weixin/src/index.ts
channel-qq/src/index.ts
channel-dingtalk/src/index.ts
channel-lark/src/index.ts
channel-telegram/src/index.ts
```

目标：

```text
Control Plane 存在
    ↓
disabled 也注册 Definition
```

新增：

```text
ChannelDefinition.setEnabled()
ChannelControlService.setEnabled()
PUT /channels/:id/enabled
```

---

## Phase 2 — Channel Directory + Accordion

修改：

```text
ChannelsSection.tsx
```

新增：

```text
channelRegistry.ts
ChannelRow.tsx
```

删除：

```text
CARD_IDS
inline CHANNEL_META
global 3s refresh
Dialog state
```

使用：

```text
GET /channels
Workspace-style ChannelRow（ProjectRowItem 交互）
```

---

## Phase 3 — Inline Setup

新增：

```text
ChannelSetup.tsx
```

迁移：

```text
CredentialField
draft state
applySetup
save state
error state
```

完成后：

```text
ChannelSetupDialog.tsx
```

不再作为主入口。

---

## Phase 4 — Auth Lifecycle

新增：

```text
ChannelAuth.tsx
useChannelAuth.ts
```

要求：

```text
explicit beginAuth
AbortSignal
setTimeout-after-await
collapse cancel
hidden pause
visible resume
terminal stop
```

新增：

```text
PublicAuthSession.pollingIntervalMs
```

---

## Phase 5 — Remove Platform Branches

删除：

```text
authSetup.ts
```

平台 Web metadata 移动至：

```text
channelRegistry.ts
```

通用组件中不得出现：

```ts
channelId === 'lark'
```

---

## Phase 6 — Permissions

新增：

```text
ChannelPermissions.tsx
```

第一阶段：

```text
docs + static requirement
```

后续再按需要增加：

```text
host-side permission status
```

---

## Phase 7 — Cleanup

清理：

```text
旧 Dialog
旧 timer
未使用 locale
旧 CARD_IDS
旧 channelNames 特判
重复 UI helpers
```

---

# 39. 测试要求

---

## 39.1 Directory

```text
进入 Channels
    → GET /channels exactly 1
```

---

## 39.2 Collapsed

所有 Row 收起：

```text
GET setup = 0
POST auth = 0
GET auth poll = 0
permission probe = 0
```

---

## 39.3 Expand

展开 Lark：

```text
GET /channels/lark/setup = 1
```

必须：

```text
QQ setup = 0
Telegram setup = 0
```

---

## 39.4 No Auto Auth

仅展开：

```text
POST auth/sessions = 0
```

---

## 39.5 Begin Auth

点击：

```text
开始授权
```

才：

```text
POST auth/sessions = 1
```

---

## 39.6 Collapse Auth

Auth pending 时收起：

```text
DELETE auth/session = 1
```

之后：

```text
GET poll = 0
```

---

## 39.7 Visibility

hidden：

```text
GET poll = 0
```

visible：

```text
pending session
    → poll resume
```

---

## 39.8 Terminal

以下任意状态：

```text
authorized
expired
failed
```

之后：

```text
poll count 不再增长
```

---

## 39.9 Enable False

启动时：

```text
lark.enabled = false
```

仍要求：

```text
GET /channels
```

包含：

```json
{
  "id": "lark",
  "enabled": false
}
```

---

## 39.10 Enable True

如果：

```text
configured=true
enabled=false
```

调用 enable：

```text
setEnabled(true)
    ↓
runtime.start()
```

---

## 39.11 Disable

如果：

```text
running=true
```

调用：

```text
setEnabled(false)
```

必须：

```text
runtime.stop()
```

---

## 39.12 Browser Security

测试确保 Public DTO 不包含：

```text
token
secret
deviceCode
challenge
providerState
credential ref
```

---

# 40. 最终验收条件

全部满足才算完成。

- [ ] 用户仍只安装 `@wsz987/dsh-channels`
- [ ] 不新增 provider-specific client bundle
- [ ] `channel-control` 继续 adapter-agnostic
- [ ] disabled provider 仍注册 Definition
- [ ] Enable / Disable 有明确 Control API
- [ ] `CARD_IDS` 删除
- [ ] Channel list 来源仅为 Host `/channels`
- [ ] 使用 Workspace-style `ChannelRow`（ProjectRowItem 交互：role=button / aria-expanded / 箭头旋转 / 整行点击），复用官方 `IconTriangleRightFill14`、`StateDot` 等 primitives 与 `--dsw-*` tokens，不依赖 `ui-workspace` 内部组件
- [ ] 主设置不再依赖 Dialog
- [ ] Row 收起时无 setup/auth/permission 请求
- [ ] 打开 Row 不自动 beginAuth
- [ ] Auth 必须用户显式触发
- [ ] Poll 不使用 `setInterval`
- [ ] Browser hidden 时停止 poll
- [ ] Row collapse 时 cancel auth
- [ ] `authSetup.ts` 删除
- [ ] 平台 UI 差异集中到 `channelRegistry.ts`
- [ ] 通用组件不得出现 built-in channel ID 判断
- [ ] 不重新实现 Harness primitives
- [ ] Platform Permission 与 Harness Permission 分离
- [ ] Root Bundle 不直接 import 平台 SDK
- [ ] `architecture.md` 红线 4 修正

---

# 41. 最终架构

```text
                         @wsz987/dsh-channels
                                  │
                                  │
                         DSH Bundle / Product
                                  │
       ┌──────────────────────────┼────────────────────────────┐
       │                          │                            │
       ▼                          ▼                            ▼
 channel-harness            channel-control               channel-web
       │                          │                            │
 Harness Agent             ChannelDefinition              Settings UI
 Session APIs                 Registry                     Accordion
       │                          │                         Setup/Auth
       │                          │                         Permissions
       │                          │                            │
       │              ┌───────────┼───────────┐                │
       │              │           │           │                │
       ▼              ▼           ▼           ▼                │
 Channel Core       Weixin        QQ        DingTalk           │
                      │           │           │                │
                      ├──────── Lark ─────────┤                │
                      │           │           │                │
                      └────── Telegram ───────┘                │
                                  │                            │
                           Platform SDK/API                    │
                                                               │
                                                  channelRegistry.ts
                                                  presentation only
```

---

# 42. 最终原则

本次重构不是为了让每一个 Channel 变成独立产品。

真正目标是：

> **一个产品、一套 Web UI、多个严格隔离的渠道运行时。**

新增第六个渠道时，允许：

```text
新增：

packages/channel-discord
+
channel-web/channelRegistry.ts
  discord metadata
```

但不应该修改：

```text
ChannelControlService 核心流程
ChannelRow 通用交互
ChannelSetup 通用保存逻辑
ChannelAuth 通用 Auth 生命周期
```

最终期望：

```text
新增 Channel
    =
新增 Adapter / Definition
+
新增 Web metadata
```

而不是：

```text
到处增加：

if (channelId === 'discord')
```

这就是当前 `dsh-channels` 最合适的复杂度边界。
