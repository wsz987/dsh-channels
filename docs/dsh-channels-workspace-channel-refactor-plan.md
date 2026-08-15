# dsh-channels：CWD / Workspace / 渠道标识修整方案

> 目标仓库：`wsz987/dsh-channels`  
> 对照：DeepSeek Harness 当前 Workspace / Session / Session Persistence 设计  
> 日期：2026-08-15

## 1. 目标

本轮修整解决以下问题：

1. `SessionHeader.cwd` 与 Harness Home（`~/.dsh`）职责混淆。
2. `bindingStore.path` 默认跟随 `process.cwd()`，启动目录变化后绑定文件“消失”。
3. Channel 创建 Session 后仅设置 `cwd`，没有挂接到 Harness `WorkspaceRegistry`。
4. `/new` 创建的是 blank session，Web 列表可能暂时隐藏，容易被误判为“没有创建会话”。
5. 希望在 Harness Workspace 层明确看出会话来自哪个渠道，例如：
   - `Channels · 微信`
   - `Channels · Telegram`
   - `Channels · Discord`
6. 保留未来“渠道会话绑定真实项目目录”的能力，不把渠道来源硬编码进 `cwd`。

---

## 2. 已核验的当前实现

### 2.1 SessionBinding 已经拥有完整渠道身份

当前 `packages/channel-harness/src/session-router.ts`：

```ts
export interface SessionBinding {
  channelId: string;
  accountId: string;
  conversationId: string;
  threadId?: string;
  sessionId: string;
  route: AgentRouteSpec;
  schemaVersion: 2;
  createdAt: number;
  updatedAt: number;
}
```

Canonical key 已经是：

```text
channel:account:conversation[:thread]
```

因此 **Workspace 的渠道来源不需要额外推断**，直接使用现有：

```text
channelId
accountId
conversationId
threadId
```

即可。

---

### 2.2 当前新 Session 的 cwd 使用 process.cwd()

当前 `HarnessAgentGateway.create()`：

```ts
const handle = await this.ctx.agents.create({
  sessionId: SessionId(sessionId),
  meta: {
    cwd: process.cwd(),
    ...(resolved.preset ? { agentPreset: resolved.preset } : {}),
  },
  agentOptions: optionsFor(resolved),
  setup,
});
```

这解决了 `{{cwd}}` 缺失问题，但有两个问题：

1. `process.cwd()` 是 Host 启动目录，不一定是 Channel 想使用的工作目录。
2. 它没有自动完成 Harness Workspace 归属。

---

### 2.3 当前 createFreshSession 没有 Workspace attach

现在链路：

```text
ChannelEvent
    ↓
createFreshSession()
    ↓
agentManager.create()
    ↓
ctx.agents.create()
    ↓
bindingStore.put()
    ↓
registerBinding()
```

缺少：

```text
workspaceRegistry.resolveByPath/create
    ↓
workspace.attachSession(sessionId)
```

因此：

```text
SessionHeader.cwd 已存在
≠
Session 已属于某个 Harness Workspace
```

---

### 2.4 bindingStore 仍然依赖 process.cwd()

当前配置注释明确说明 binding 文件：

```text
relative to cwd
```

即：

```ts
bindingStore: {
  type: 'file',
  path: DEFAULT_BINDING_STORE_PATH
}
```

如果默认值类似：

```text
./data/channels/bindings.json
```

则：

```text
从 C:\Users\wsz987 启动
→ C:\Users\wsz987\data\channels\bindings.json

从 C:\Users\wsz987\.dsh 启动
→ C:\Users\wsz987\.dsh\data\channels\bindings.json
```

这会造成“重新启动后绑定消失”的错觉。

---

# 3. 官方语义应保持清晰分层

建议严格区分以下四层。

## 3.1 Harness Home

```text
C:\Users\wsz987\.dsh
```

职责：

- Harness 用户级配置
- 用户级 AGENTS / presets / skills 等
- dsh-channels 自己的持久化状态
- 可选的 Channel 专用 Workspace 根目录

它不是天然等于 Session cwd。

---

## 3.2 Channel 持久化数据

建议：

```text
%DSH_HOME%\dsh-channels\
├─ bindings.json
└─ ...
```

例如：

```text
C:\Users\wsz987\.dsh\dsh-channels\bindings.json
```

这个位置应独立于 `process.cwd()`。

---

## 3.3 Channel Workspace

如果 Channel 会话本身没有指定真实项目目录，则给它一个明确的 Harness Workspace。

推荐：

```text
%DSH_HOME%\workspaces\channels\
├─ weixin\
│  └─ <account-key>\
├─ telegram\
│  └─ <account-key>\
└─ discord\
   └─ <account-key>\
```

例如：

```text
C:\Users\wsz987\.dsh\workspaces\channels\weixin\default
```

这时：

```text
SessionHeader.cwd
=
C:\Users\wsz987\.dsh\workspaces\channels\weixin\default
```

是合理的，因为这个目录被**明确设计成该 Channel Session 的真实工作区**。

注意：

```text
cwd = C:\Users\wsz987\.dsh
```

仍然不推荐。

推荐的是：

```text
cwd = C:\Users\wsz987\.dsh\workspaces\channels\<channel>\<account>
```

即 `.dsh` 下的一个专门 Workspace，而不是整个 Harness Home。

---

## 3.4 Workspace 展示标题

Harness Workspace 的：

```ts
create(path, title?)
```

允许：

```text
path  = 实际目录
title = 人类可读名称
```

因此可以把：

```text
C:\Users\wsz987\.dsh\workspaces\channels\weixin\default
```

显示成：

```text
Channels · 微信
```

或者：

```text
微信 · 主账号
```

而无需把路径命名成人类中文标题。

---

# 4. 推荐的最终产品行为

## 4.1 默认模式：按 channel + account 建 Workspace

推荐默认粒度：

```text
channel + account
```

不要默认细到 conversation。

原因：

如果每个微信联系人都创建 Workspace：

```text
微信 · 张三
微信 · 李四
微信 · 群 A
微信 · 群 B
...
```

Workspace 数量会快速爆炸。

更合理：

```text
Channels · 微信 · 主账号
    ├─ Session A
    ├─ Session B
    └─ Session C

Channels · Telegram · bot-main
    ├─ Session D
    └─ Session E
```

Session 与具体：

```text
conversationId
threadId
```

的对应关系继续由 `bindings.json` 管理。

---

## 4.2 Workspace 标题生成

增加统一函数：

```ts
function channelWorkspaceTitle(input: {
  channelId: string;
  accountId: string;
}): string
```

建议提供 adapter display-name registry：

```ts
const CHANNEL_LABELS: Record<string, string> = {
  weixin: '微信',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
};
```

默认：

```ts
label = CHANNEL_LABELS[channelId] ?? channelId;
```

标题规则：

### 单账号渠道

```text
Channels · 微信
```

### 多账号渠道

```text
Channels · 微信 · <accountLabel>
```

如果没有安全、可读的 account label：

```text
Channels · 微信 · a13f92
```

其中 `a13f92` 使用 accountId 的稳定短 hash。

**不要直接把 token、openid、完整手机号等敏感 accountId 展示在 Workspace title。**

---

# 5. 推荐的数据结构

## 5.1 新增 WorkspaceConfig

建议 `channel-harness/config.ts`：

```ts
export interface WorkspaceConfig {
  /**
   * Channel session 的 Workspace 策略。
   *
   * - channel-account:
   *   默认；每个 channel/account 一个 Workspace。
   *
   * - host-cwd:
   *   保持旧语义，只使用 Host cwd；
   *   如果 cwd 已注册为 Harness Workspace，则 attach。
   *
   * - disabled:
   *   不做 WorkspaceRegistry 集成。
   */
  mode: 'channel-account' | 'host-cwd' | 'disabled';

  /**
   * Channel Workspace 根目录。
   * 未设置时：
   *   $DSH_HOME/workspaces/channels
   */
  root?: string;

  /**
   * 是否自动创建缺失的 Channel Workspace。
   */
  autoCreate: boolean;
}
```

加入：

```ts
export interface Config {
  ...
  workspace: WorkspaceConfig;
}
```

推荐默认：

```yaml
workspace:
  mode: channel-account
  autoCreate: true
```

---

## 5.2 bindingStore 默认路径修改

不要再：

```text
./data/channels/bindings.json
```

改成运行时解析：

```text
$DSH_HOME/dsh-channels/bindings.json
```

建议新增：

```ts
function resolveDshHome(): string {
  return process.env.DSH_HOME
    ? resolveHome(process.env.DSH_HOME)
    : join(homedir(), '.dsh');
}
```

然后：

```ts
function defaultBindingStorePath(): string {
  return join(resolveDshHome(), 'dsh-channels', 'bindings.json');
}
```

### 注意

不建议在 Schemastery schema 初始化时直接固化：

```ts
Schema.string().default(DEFAULT_BINDING_STORE_PATH)
```

如果 `DEFAULT_BINDING_STORE_PATH` 在 module import 时就取 `process.cwd()`，问题仍然存在。

应改成：

```text
config.path 显式指定
    ↓
使用 config.path

未指定
    ↓
运行时 resolveDshHome()
```

---

# 6. WorkspaceResolver 设计

新增：

```text
packages/channel-harness/src/workspace-resolver.ts
```

职责只有一个：

```text
Channel conversation identity
        ↓
决定 Session 的 cwd
        ↓
确保 Workspace 存在
        ↓
返回 Workspace / cwd
```

建议接口：

```ts
export interface ChannelWorkspaceInput {
  channelId: string;
  accountId: string;
  conversationId: string;
  threadId?: string;
}

export interface ResolvedChannelWorkspace {
  cwd: string;
  workspace?: {
    id: string;
    path: string;
    title: string;
  };
}

export interface ChannelWorkspaceResolver {
  resolve(input: ChannelWorkspaceInput): Promise<ResolvedChannelWorkspace>;
}
```

---

# 7. 推荐创建链路

现状：

```text
createFreshSession()
    ↓
agentManager.create(sessionId, route)
    ↓
bindingStore.put()
```

修改为：

```text
createFreshSession()
    │
    ├─ 1. workspaceResolver.resolve(conversation)
    │       ↓
    │     cwd + workspace
    │
    ├─ 2. agentManager.create(
    │        sessionId,
    │        route,
    │        setup,
    │        { cwd }
    │      )
    │
    ├─ 3. workspace.attachSession(sessionId)
    │
    ├─ 4. bindingStore.put(binding)
    │
    └─ 5. registerBinding(binding)
```

---

# 8. AgentManager 不应自己决定 cwd

当前：

```ts
meta: {
  cwd: process.cwd(),
}
```

建议改成：

```ts
export interface AgentCreateMeta {
  cwd?: string;
}
```

```ts
async create(
  sessionId: string,
  route: AgentRouteSpec,
  setup?: AgentSetup,
  meta?: AgentCreateMeta,
): Promise<GatewayAgentHandle> {
  const resolved = resolveRoute(route, this.defaultSelection());

  const handle = await this.ctx.agents.create({
    sessionId: SessionId(sessionId),
    meta: {
      ...(meta?.cwd ? { cwd: meta.cwd } : {}),
      ...(resolved.preset ? { agentPreset: resolved.preset } : {}),
    },
    agentOptions: optionsFor(resolved),
    setup,
  });

  return this.wrap(handle);
}
```

### 关键原则

`HarnessAgentGateway` 只负责：

```text
按照调用方给出的 cwd 创建 Session
```

不负责：

```text
决定 Channel 应该在哪个 Workspace
```

Workspace 策略属于 Channel bridge / resolver 层。

这样职责更干净。

---

# 9. Channel Workspace 的 resolve 算法

推荐：

```ts
async resolve(input: ChannelWorkspaceInput) {
  if (config.mode === 'disabled') {
    return {};
  }

  if (config.mode === 'host-cwd') {
    const cwd = process.cwd();

    const workspace =
      await ctx.workspaceRegistry?.resolveByPath(cwd);

    return { cwd, workspace };
  }

  const root = resolveChannelWorkspaceRoot();

  const accountKey = stableSafeAccountKey(input.accountId);

  const cwd = join(
    root,
    safeSegment(input.channelId),
    accountKey,
  );

  await mkdir(cwd, { recursive: true });

  const title = channelWorkspaceTitle({
    channelId: input.channelId,
    accountId: input.accountId,
  });

  let workspace =
    await ctx.workspaceRegistry.resolveByPath(cwd);

  if (!workspace && config.autoCreate) {
    workspace =
      await ctx.workspaceRegistry.create(cwd, title);
  }

  return { cwd, workspace };
}
```

---

# 10. Workspace attach

Session 创建成功后：

```ts
if (resolvedWorkspace.workspace) {
  await resolvedWorkspace.workspace.attachSession(
    SessionId(sessionId),
  );
}
```

最终：

```text
SessionHeader.cwd
        =
workspace.path
```

满足官方 Workspace membership 校验。

不要出现：

```text
Session.cwd = A

workspace.attachSession()
的 Workspace.path = B
```

因为 Harness 会校验 canonical cwd 是否一致。

---

# 11. attach 失败语义

官方 Host 的思路是：

```text
先创建 Session
再 attach Workspace
```

所以 Channel 也建议保持相同顺序。

但需要显式处理：

```text
agent create 成功
workspace attach 失败
```

推荐：

```ts
try {
  await workspace.attachSession(SessionId(sessionId));
} catch (error) {
  logger.error(
    `[channel-harness] workspace attach failed`,
    {
      sessionId,
      workspaceId: workspace.id,
      cwd: workspace.path,
      channelId,
      accountId,
      error,
    },
  );

  await agentManager.disposeSession(sessionId).catch(() => {});

  throw new ChannelWorkspaceAttachError(...);
}
```

为什么 Channel 这里建议 rollback？

因为这是 `createFreshSession()` 的内部事务。

如果 Channel 的产品契约是：

```text
“创建成功” = Session + Workspace + Binding 都建立
```

那么其中任何一步失败，都不应该给用户返回：

```text
已开启新会话
```

---

# 12. createFreshSession 推荐事务顺序

推荐最终：

```text
A. resolve/create Workspace
        ↓
B. create Harness Session
        ↓
C. attach Session → Workspace
        ↓
D. persist Binding
        ↓
E. register reverse binding
        ↓
F. success
```

失败回滚：

```text
A 失败
→ 什么都没创建

B 失败
→ Workspace 可以保留（空 Workspace 无害）

C 失败
→ dispose newly-created Agent/Session handle
→ 不写 Binding

D 失败
→ detach Session from Workspace
→ dispose newly-created Agent
→ 不改变旧 Binding

E
→ 内存操作，不应成为持久化失败点
```

---

# 13. `/new` 修整

当前 `/new`：

```text
createFreshSession()
        ↓
send "已开启新会话。"
```

这条逻辑本身是正确的。

问题在于 Harness Web 会隐藏 blank session。

因此不建议为了“让 Web 立即显示”而伪造：

```text
turn/start
user/message
assistant/message
```

`/new` 应保持 command-only，不进入模型历史。

---

## 13.1 增加明确日志

```ts
logger.info(
  '[channel-harness] fresh channel session created',
  {
    sessionId,
    channelId,
    accountIdHash,
    workspaceId,
    cwd,
    bindingKey,
  },
);
```

这样 `/new` 后即使 Web 暂时隐藏 blank session，也能确认：

```text
Harness Session 已创建
Workspace 已挂接
Binding 已持久化
```

---

## 13.2 用户发第一条普通消息后

发生：

```text
agent.followup()
    ↓
turn/start
```

Session 不再 blank，正常出现在 Web Session list。

---

# 14. “来源渠道”应该保存在哪里？

推荐分层：

| 信息 | 保存位置 |
|---|---|
| 工作目录 | `SessionHeader.cwd` |
| Workspace 展示分组 | `Workspace.title` |
| channel/account/conversation/thread | `SessionBinding` |
| Harness Session ID | `SessionBinding.sessionId` |
| provider/model/preset | `route` / `agentPreset` |
| 渠道来源 Badge | 后续 UI projection，可选 |

不要：

```text
把 channelId 塞进 cwd 字符串语义
```

不要：

```text
擅自扩展 SessionHeader.channelId
```

官方 `SessionHeader` 是持久化格式的一部分，私自增加 Harness 不认识的字段会增加升级兼容风险。

---

# 15. 是否需要给 Session 标题加 “[微信]”？

第一阶段不需要。

因为：

```text
Workspace: Channels · 微信
    ├─ “帮我查一下今天新闻”
    ├─ “项目部署问题”
    └─ “图片生成”
```

已经很清楚。

如果以后：

```text
同一个真实项目 Workspace
D:\workspace\ImageCreator
```

同时包含：

```text
Web Session
微信 Session
Telegram Session
```

这时 Workspace 无法承担渠道区分。

再做第二阶段：

```text
Session source badge
```

例如：

```text
[微信] API provider 修复
[Web] Director 流程调整
[Telegram] 部署状态
```

---

# 16. 第二阶段渠道 Badge 的正确做法

不建议修改官方 `SessionHeader`。

更推荐：

```text
自定义 Session Projection
```

概念：

```ts
interface ChannelSourceProjection {
  channelId: string;
  accountLabel?: string;
}
```

由 `channel-harness` 注册 projection，例如：

```text
channelSource
```

然后 `channel-web` 客户端扩展读取该 projection，展示 Badge：

```text
┌ 微信 ┐  API provider 修复
```

优点：

- 不污染 Agent prompt
- 不污染 conversation event
- 不修改 `SessionHeader` 格式
- 可以持久化/缓存
- UI 可以按渠道筛选

这是 M2，不建议本次一起做。

---

# 17. Binding schema 是否需要升级到 v3？

本轮 **不需要**。

当前 binding 已经包含：

```text
channelId
accountId
conversationId
threadId
sessionId
route
```

Workspace 可以完全由这些字段重新解析。

不需要增加：

```ts
workspaceId
workspacePath
```

否则会制造重复真源。

Workspace 真源应是：

```text
SessionHeader.cwd
+
WorkspaceRegistry
```

Binding 只负责：

```text
Channel conversation → Harness Session
```

保持职责纯净。

---

# 18. Resume / 重启后的恢复

收到 Channel 消息：

```text
bindingStore.get(key)
    ↓
sessionId
    ↓
sessionPersistence exists?
    ↓
resume
```

恢复后不要尝试修改 Session cwd。

因为 SessionHeader.cwd 是创建时的持久化 metadata。

可以做一次“Workspace membership repair”：

```text
session.header.cwd
    ↓
workspaceRegistry.resolveByPath(cwd)
    ↓
如果 Workspace 存在，但 sessionIds 未包含 session
    ↓
attachSession(sessionId)
```

但只有在明确确认官方 API 能获取该 resumed Session header 的情况下实现。

否则：

```text
M1 只处理 fresh session attach
```

避免为了修历史数据引入侵入性逻辑。

---

# 19. 首次发布前的数据路径

## 19.1 Binding 文件

旧：

```text
C:\Users\wsz987\data\channels\bindings.json
```

新：

```text
C:\Users\wsz987\.dsh\dsh-channels\bindings.json
```

该路径约定仍处于 dev、尚未发布，因此不实现自动迁移。首次发布统一使用
`$DSH_HOME/dsh-channels`；开发期遗留文件由开发者按需手动清理，避免把一次性
迁移逻辑带入正式库代码。

---

## 19.2 已有 Session

已有 Session 的 `cwd` 不可随意重写。

策略：

```text
旧 Session 保持原状
新创建 Session 使用新 Workspace 规范
```

如果用户已经删了旧 binding：

```text
无法仅凭 Session 自动恢复完整
channel/account/conversation
```

因此不要猜。

---

# 20. 建议新增文件

```text
packages/channel-harness/src/
├─ dsh-home.ts
├─ workspace-resolver.ts
├─ channel-label.ts
├─ binding-store.ts
├─ agent-manager.ts
├─ bridge.ts
└─ config.ts
```

---

# 21. 具体修改清单

## M0 — 修 binding path

### `dsh-home.ts`

新增：

```ts
resolveDshHome()
resolveChannelDataDir()
resolveDefaultBindingStorePath()
```

默认：

```text
$DSH_HOME
?? ~/.dsh
```

结果：

```text
~/.dsh/dsh-channels/bindings.json
```

---

## M1 — Workspace resolver

新增：

```ts
ChannelWorkspaceResolver
```

默认模式：

```text
channel-account
```

路径：

```text
~/.dsh/workspaces/channels/<channel>/<account-key>
```

标题：

```text
Channels · <channel-label>
```

多账号：

```text
Channels · <channel-label> · <safe-account-label>
```

---

## M2 — Agent create 接收 cwd

删除：

```ts
cwd: process.cwd()
```

改为：

```ts
cwd: createMeta.cwd
```

由上层 resolver 决定。

---

## M3 — createFreshSession attach Workspace

修改：

```text
resolve workspace
→ create agent/session
→ attach workspace
→ save binding
→ register binding
```

增加 rollback。

---

## M4 — `/new` observability

增加：

```text
sessionId
channelId
workspaceId
cwd
bindingKey
```

结构化日志。

不创建虚假 turn。

---

## M5 — 测试

至少增加以下测试。

### Test 1

```text
no binding
+ ordinary first message
```

断言：

```text
new Session
cwd = channel Workspace path
workspace.attachSession called
binding persisted
followup called
```

### Test 2

```text
no binding
+ /new
```

断言：

```text
只创建一个 Session
attach 一次
binding 一次
不 followup
返回“已开启新会话。”
```

### Test 3

```text
existing binding
+ /new
```

断言：

```text
new sessionId != old sessionId
new Session 同一 Channel Workspace
binding 切换到新 sessionId
old agent retire
```

### Test 4

```text
workspace.attachSession fails
```

断言：

```text
binding 不更新
new agent disposed
/new 不返回 success
错误日志包含 session/channel/workspace
```

### Test 5

```text
bindingStore.path omitted
```

无论：

```text
process.cwd() = A
```

还是：

```text
process.cwd() = B
```

都断言：

```text
binding path = $DSH_HOME/dsh-channels/bindings.json
```

### Test 6

多渠道：

```text
weixin / account-a
telegram / account-a
```

断言生成不同 Workspace。

### Test 7

同渠道多 conversation：

```text
weixin / account-a / conversation-1
weixin / account-a / conversation-2
```

断言：

```text
Workspace 相同
Session 不同
Binding 不同
```

---

# 22. 推荐配置示例

```yaml
channel-harness:
  workspace:
    mode: channel-account
    autoCreate: true

  bindingStore:
    type: file

  routing:
    mode: global

  reply:
    updateIntervalMs: 200
```

运行时解析为：

```text
DSH_HOME
C:\Users\wsz987\.dsh
```

最终：

```text
C:\Users\wsz987\.dsh\
├─ dsh-channels\
│  └─ bindings.json
│
└─ workspaces\
   └─ channels\
      ├─ weixin\
      │  └─ 1f8a20\
      └─ telegram\
         └─ 41c5bd\
```

Harness UI：

```text
Workspaces

Channels · 微信
  ├─ 会话 A
  ├─ 会话 B
  └─ 会话 C

Channels · Telegram
  ├─ 会话 D
  └─ 会话 E
```

---

# 23. 推荐最终架构

```text
                    Channel Adapter
                         │
                         ▼
                  MessageReceived
                         │
          ┌──────────────┴──────────────┐
          │ channelId                   │
          │ accountId                   │
          │ conversationId              │
          │ threadId                    │
          └──────────────┬──────────────┘
                         │
                         ▼
               ChannelWorkspaceResolver
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
      WorkspaceRegistry          cwd
              │                     │
      create / resolve              │
              │                     │
              └──────────┬──────────┘
                         ▼
                 ctx.agents.create
                         │
                         ▼
                    Session
                  header.cwd
                         │
                         ▼
                workspace.attach
                         │
                         ▼
                  BindingStore
       channel conversation → session
                         │
                         ▼
                  agent.followup
```

---

# 24. 最终判断

本次最推荐的设计是：

```text
.dsh
= Harness Home

.dsh/dsh-channels
= Channel 插件持久状态

.dsh/workspaces/channels/<channel>/<account>
= Channel 的真实 Harness Workspace

SessionHeader.cwd
= 对应 Channel Workspace path

Workspace.title
= Channels · 微信 / Telegram / ...

SessionBinding
= channel/account/conversation/thread → sessionId
```

这样有几个直接好处：

1. Harness Web 左侧能按渠道明显分组。
2. `cwd` 仍然具有真实 Workspace 语义。
3. Binding 不再因为启动目录变化而“消失”。
4. 不修改官方 SessionHeader 持久化格式。
5. 不重复存储 workspaceId/path，避免多真源。
6. `/new` 可以保持官方 command-only / blank-session 语义。
7. 未来如果需要“同一真实项目中同时显示微信/Web/Telegram来源”，再增加 Channel Source Projection + UI Badge，不破坏这一层架构。

---

# 25. 实施优先级

推荐按以下顺序执行：

```text
P0
├─ binding path → $DSH_HOME/dsh-channels
├─ WorkspaceResolver
├─ Agent create 接收显式 cwd
├─ createFreshSession attach Workspace
└─ /new 错误日志

P1
├─ 旧 binding 路径迁移
├─ Workspace title / channel label
└─ resume membership repair

P2
└─ channelSource projection + Web Session badge
```

**不要在 P0 同时改 SessionHeader schema，也不要为了让 `/new` 在 Web 立即出现而伪造消息或 turn。**
