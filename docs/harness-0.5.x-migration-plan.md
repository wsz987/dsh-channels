# Harness 0.1.5-rc.2 适配与渠道核验记录

> 核验日期：2026-09-10（rc.1）／2026-09-11（rc.2）
> 目标：仅支持官方最新 Harness `0.1.5-rc.2`；不保留 0.1.x/alpha.2/rc.1 兼容层。
> 依据：官方 dsh-v0.1.5-rc.1 与 rc.2 发布说明、npm registry dist-tags、官方 rc.1/rc.2 产物比对、当前仓库代码与架构红线。

## 1. 版本事实（OFFICIAL-CONFIRMED）

- npm `@deepseek-ai/dsh` dist-tags：`latest = 0.1.5-rc.1`、`next = 0.1.5-rc.2`、
  `alpha = 0.1.5-alpha.2`。**官方尚未把 rc.2 提升为 `latest`**，因此本仓库基线取
  `next` 上的最新预发布版 `0.1.5-rc.2`，并必须**精确 pin**（子包的 `latest` 甚至停在
  无关的陈旧版本上，不能依赖 dist-tag 解析）。
- rc.1 发布 `2026-09-10T03:12:53Z`，rc.2 发布 `2026-09-10T14:57:10Z`（同日稍晚）。
- 本仓库声明的 44 个 `@deepseek-ai/dsh-*` 包在 rc.1 与 rc.2 均已发布（逐一经
  `npm view <pkg>@<ver> version` 核验，无一缺失）。
- 本机已安装的 `dsh` CLI 为 `0.1.5-rc.1`，rc.1 产物作为类型/行为核验来源；rc.2 的
  差异通过 `npm pack` 双版本比对确认（见 §2.3），并在 rc.2 CLI 上做真机启动复核。
- 历史上「0.5.x」是对版本号的误称：官方实际版本线是 `0.1.5-rc.x`，不存在 `0.5.x` 家族包。

## 2. 官方破坏性变更核验

### 2.1 alpha.2 → rc.1 的公共 API diff（CODE-CONFIRMED）

对 45 个相关包做了逐文件比对（`.d.ts` 329 个文件做 SHA-256 + 声明级 diff，`package.json` 做结构化深比较）：

- **公共 API 破坏性变更：0 项。** 没有移除/重命名导出、没有签名或可选性变化、没有返回值变化、没有接口成员移除、没有 Cordis 服务名变化、没有 `inject` 变化、没有 schema/配置形状变化、没有 `dsh` 字段变化。
- 唯一一处 `.d.ts` 变更是**纯增量**：`dsh-client-ui-primitives` 的 `CodeBlockProps.contentRef?: Ref<HTMLDivElement>`（可选参数，另加一个内层包裹 `<div>`）。
- 全部 44 个包其余差异仅为 `version` 与内部依赖区间由 `0.1.5-alpha.2` 改为 `0.1.5-rc.1`。
- 关键语义：`0.1.5-rc.1` 满足 `^0.1.5-alpha.2`，但 `0.1.5-alpha.2` **不**满足 `^0.1.5-rc.1` —— 所以升级方向是单向的，正好与本项目「只做最新版」的策略一致。

结论：**alpha.2 → rc.1 是纯版本号推进，无 API 迁移成本。**

### 2.3 rc.1 → rc.2 的公共 API diff（CODE-CONFIRMED）

对 28 个高信号包做了 `npm pack` 双版本比对（逐文件 SHA-256 + 声明级 diff +
`package.json` 结构化深比较），并做了编译级验证：

- **公共 API 破坏性变更：0 项。** 28 个包中 27 个仅 `package.json` 有差异。
- 311 处依赖区间变更**全部**是 `^0.1.5-rc.1` → `^0.1.5-rc.2`；依赖键 **新增 0、删除 0**；
  `exports` / `main` / `types` / `files` / `type` 全未变；`dsh` 块全未变。
- **无任何 `.d.ts` 被修改**；唯一新增的 `.d.ts` 是 `code-file-icon-artwork.d.ts` ——
  一个「已产出但未再导出」的内部模块（`index.d.ts` 与 ESM 导出语句逐字节相同，从包入口
  不可达）。
- 唯一功能变更是 `dsh-client-ui-primitives` 的代码文件图标美术资源替换
  （内联 `switch` → 查表 + `dangerouslySetInnerHTML`），48 个分类键名不变、
  公开导出面不变。
- 编译级证明：构造消费方工程 re-export 28 个包的全部 458 个公开导出名，rc.1 与 rc.2
  在 strict 下均 **0 error**；开启 `skipLibCheck: false` 后两侧错误集合逐字节相同
  （均为既有的缺失 peer 类型声明噪声，与本次变更无关）。
- 官方 rc.2 发布说明亦印证：仅两条 UI 改进（反馈提交确认弹窗、代码文件图标刷新），
  无 API 条目。

结论：**rc.1 → rc.2 是增量、非破坏性发布，下游零代码改动；迁移为纯版本号推进。**

#### 2.3.1 rc.2 两条发布说明与本地代码的交集（逐条核验）

| 官方 rc.2 条目 | 落点 | 与本项目的关系 | 结论 |
| --- | --- | --- | --- |
| 反馈提交加确认弹窗（点赞/点踩） | 官方 Web UI 反馈流程 | 本项目无反馈功能集成（`channel-web/src/client/locales.ts` 的 `repoFooterIssue: 'Feedback'` 只是仓库 issue 链接文案） | 无需改动 |
| 交付文件卡片排版 + 代码文件图标刷新 | `dsh-client-ui-primitives`（`lib/index.js` 美术资源重构 + 新增内部 `code-file-icon-artwork.d.ts`） | 见下方专项核对 | 无需改动 |

对 `dsh-client-ui-primitives` 单独做了 rc.1/rc.2 逐文件 SHA-256 比对：

- 88 → 89 个文件；**仅新增** `lib/types/code-file-icon-artwork.d.ts`（从包入口不可达）。
- **共有文件中内容不同的只有 5 个**：`package.json`（版本）、3 个 README、
  `lib/index.js`（图标美术重构）。**没有任何组件 `.d.ts` 发生变化**
  （`lib/types/index.d.ts` 两版逐字节相同）。
- 本项目客户端从该包**实际只取用 5 个符号**：
  `Button`、`Input`、`Pill`、`StateDot`、`IconTriangleRightFill14`
  （`packages/channel-web/src/client/**`）。这 5 个在 rc.2 运行时导出面中**全部存在**，
  且声明未变。
- rc.2 变更涉及的符号 `CodeFileIcon` / `CODE_FILE_ARTWORK` / `CODE_FILE_ICON_ID_TOKEN`
  **均未从包入口导出**（不可达）；`CodeBlock`（rc.1 曾加 `contentRef`）虽导出但本项目未使用。
- 构建产物交叉验证：`packages/channel-web/lib/client.js` 中
  `CodeFileIcon`、`CODE_FILE_ARTWORK`、`CODE_FILE_ICON_ID_TOKEN`、`CodeBlock`、`contentRef`、
  `dangerouslySetInnerHTML` **出现次数均为 0** —— 本项目完全位于 rc.2 变更面之外。

结论：**rc.2 的两条变更都不触及本项目代码，唯一需要的调整是版本基线推进（已完成）。**

### 2.2 rc.1 发布说明中的开发者向破坏性条目（逐项核验）

| 官方变更 | 本仓库现状 | 结论 |
| --- | --- | --- |
| 移除 `ctx.agent`，调用方需显式传递 Agent | 全仓库无 `ctx.agent` 生产用法；`channel-harness` 走 `ctx.agents`（复数）+ 显式 Agent/AgentHandle | 无需改动 |
| `Inbox` 改为类型接口，`hasPending`/`claim` 不再公开 | 无生产用法；`reply-context-store.claim()` 是项目内部回复路由状态，与 Harness Inbox 无关，禁止机械替换 | 无需改动 |
| Session persistence 改为 `SessionHandle`，`agentLoop.create()` 改异步，新增 session 锁 | 不使用 `agentLoop.create()`；经 `ctx.agents.create()`；持久化只经 `sessionPersistence.list()/open(id,'read')` 与 `session.snapshotEvents()` | 无需改动 |
| 会话格式升级 V3，旧日志单向迁移、不支持降级 | `persistence-compat.test.ts` 覆盖 V3 list/open/read/close 与单向升级读取；不自行解析日志文件 | 无需改动 |
| `Session.events` 移除 → `snapshotEvents()` | `lifecycle.ts` 已使用 `live.snapshotEvents()` | 已对齐 |
| persona 配置拆分为 `personaPrefix`/`personaSuffix`，旧 `persona` 需适配 | 本仓库 patch 未设置任何 `system-prompt` 行；`{{model}}` persona 变量仍然有效 | 无需改动 |
| 默认工具调整，base bundle 不再挂载 `str_replace_editor` | 本仓库不依赖该行 | 无需改动 |
| 默认模型 `deepseek-v4-flash` → `deepseek-flash` | `channel-harness` 有意继承用户 Harness 全局默认模型 | 无需改动 |
| Web 插件面板 API：`sidebar.panellist`/`main`；原 `conversation` slot 迁为 `main` 的 key | 本产品继续使用 `settings.section`，**该扩展点在 rc.1 仍然存在且未被废弃** | 无需改动 |
| 外部插件不能注册 `sessionFormatMigration` | 本仓库不注册 | 无需改动 |

### 2.3 配置与 patch 语义（OFFICIAL-CONFIRMED，重要）

- 配置层优先级：各 bundle patch（按 `dsh.profile.bundles` 顺序）→ profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → argv 顺序的每个 `--patch`。
- **patch 是整体替换目标行的整个 `config`，不是深度合并。** 因此本仓库 patch 中任何覆盖既有行的写法都必须重述该行需要的每一个键。当前 `packages/channels/cordis.patch.yml` 只做 `insert`，不覆盖宿主行，不受影响。
- 启动器 flag 必须写在应用参数之前；rc.1 新增 `--from-default-profile`，无移除/重命名。

## 3. 本仓库改动

1. `scripts/check-upstream.mjs` 的 `HARNESS_TESTED_VERSION` 与
   `packages/channel-harness/src/commands/version.ts` 的镜像常量更新为 `0.1.5-rc.2`。
2. 全部 workspace `@deepseek-ai/dsh-*` 声明（dependencies / devDependencies /
   peerDependencies）更新为精确 `0.1.5-rc.2`；root `pnpm.overrides` 的 `dsh-sandbox`
   同步更新。
3. 跟随更新的测试断言与注释：`channel-web/test/client-registration.test.ts`、
   `channels/test/bundle.test.ts`（pin 断言），以及 `channel-harness` 各测试/源码中
   标注「pinned contract」的版本串。
4. 删除 lockfile 与 `node_modules` 后重新生成：lockfile 中 **`dsh-*` 唯一解析版本为
   `0.1.5-rc.2`，rc.1 / alpha 引用为 0**，且干净安装无 unmet peer。
5. 文档基线（README 中英、兼容矩阵、Weixin runbook、架构说明、迁移记录、changeset）
   同步为 `0.1.5-rc.2`。README 中的 Harness 升级命令改为**显式版本**
   （`npm i -g @deepseek-ai/dsh@0.1.5-rc.2`），因为 rc.2 只在 `next` 标签上，
   `@latest` 会装到 rc.1。

## 4. 验收门禁（全部通过）

```text
pnpm install --frozen-lockfile  # CI 同款；lockfile 最新
pnpm build                      # 15/15 成功
pnpm typecheck                  # 27/27 成功
pnpm test                       # 27/27 成功
pnpm ci:check                   # 全门禁通过（含 verify / fixtures / manifests / harness-compat / doctor / bundle）
pnpm check:harness-newer        # 无高于 0.1.5-rc.2 的已发布 dsh-* 版本
```

## 5. 渠道支持性

五渠道离线门禁（contract / fixture / adapter tests）在 rc.2 下全绿；渠道不直接依赖
Harness Agent/Session API，Harness 变更只落在 `channel-harness`，本次无 API 变更需要下沉。
平台权限与真实链路仍按渠道分别标注 OFFICIAL-CONFIRMED / LIVE-REQUIRED，见
`docs/compatibility-matrix.md` 第 4 节 smoke 清单：

- Telegram：manifest `experimental`，真实 Bot live gate 未跑。
- Weixin：iLink live gate 与 upstream version/commit pin 未完成，见 `docs/weixin-live-verification-runbook.md`。
- QQ：最小 intents（`GROUP_AND_C2C | INTERACTION`）需真实 App 确认已获准。
- DingTalk：Stream / 主动消息 / 媒体 / AI Card 各项 OpenAPI 权限需逐项 live 核验。
- Lark：scope、事件订阅、CardKit 权限需按官方应用后台逐项确认。
- Web 面板：`settings.section` 为正式扩展点，离线 client-registration / bundle 测试通过；
  真实 `dsh web` 启动 smoke 已在隔离 DSH_HOME + rc.1 CLI 完成（§7），rc.2 上按同一流程复核。

## 6. 风险与回滚

- V3 会话升级单向；升级前备份 session store。新版会话不可被 alpha.2/0.1.x Harness 降级读取。
- 本项目不提供旧 Harness 运行时兼容层：用户必须把 Harness CLI 升级到 `0.1.5-rc.2` 后再安装
  本 bundle，顺序不可颠倒；且因 rc.2 位于 `next` 标签，升级命令必须写显式版本。
- 后续若官方发布更高版本，按 AGENTS.md 红线 6 走 Renovate → typecheck → contract →
  fixtures → live gate → 更新 `HARNESS_TESTED_VERSION` 与全部 pin。

## 7. 接入链路真机核验（rc.1 2026-09-10；rc.2 2026-09-11 复核）

静态核验之外，在**隔离 `DSH_HOME`**（未触碰用户真实 `~/.dsh`）中用 CLI 建立 `web` profile
并链入本地工作树 bundle，逐段验证运行时链路。**同一流程在 rc.1 与 rc.2 上各执行一次，
结果一致**（rc.2 用 `npx @deepseek-ai/dsh@0.1.5-rc.2`，本机常驻 CLI 仍是 rc.1）：

```text
bundle patch  →  9 行插件落地  →  插件加载  →  五渠道注册
              →  控制面 API 200  →  客户端 bundle 投递  →  boot graph 条目
```

| 环节 | 证据 | rc.1 | rc.2 |
| --- | --- | --- | --- |
| bundle patch 发现 + 落地 | `--dump-config` 列出全部 9 行（service/files/harness/control/五渠道/web），id/name/inject 正确 | ✅ | ✅ |
| exports 子路径解析 | 各行 `@wsz987/dsh-channels/<sub>` 全部来自 `packages/channels/package.json` exports | ✅ | ✅ |
| 插件运行时加载 | 启动日志 `[channel-harness] console diagnostics enabled` | ✅ | ✅ |
| 五渠道注册 | `GET /dsh-channels/api/v2/channels` → 五渠道齐全；weixin 真实 `mounted:true / runtime:"running"` | ✅ | ✅ |
| API 路由注册 | `/v2/channels`、`/v2/update-check`、`/v1/channels` → 200；未知路径 → 404；`/` → 401 | ✅ | ✅ |
| update-check 真实网络链路 | 返回 `currentVersion 0.4.2`、`update 0.5.0 / crossLine:true` | ✅（并暴露下述版本倒挂） | ✅ |
| Web 客户端投递 | `__DSH_BOOT__` 含 `@wsz987/dsh-channels` 条目（url=/plugins/...client.js、inject=locale+ui-settings）；该 URL 200 / 189690 B，内容为 `window.__ModuleLoader__.load({id,factory})` 且含 `settings.section` | ✅ | ✅ |
| 真实平台收发 | 需真实账号/应用 | LIVE-REQUIRED（未变） | LIVE-REQUIRED |

**关键结论**：Harness 0.1.5-rc.2 的变更面（`ctx.agent` 移除、Inbox 类型化、`SessionHandle`
生命周期、session 单写者锁、`Session.events`→`snapshotEvents`、V3、persona 拆分、
`settings.section`）**均未影响渠道接入链路**。特别是 session 锁：`open(id, access)` 仅对
`'write'` 抛 `SessionAlreadyOwnedError`，而 bridge 只使用 `list()` 与 `open(id,'read')` 并且
用完即 `close()`，因此新增的跨进程单写者约束不会与渠道侧产生所有权冲突。

## 8. 本次核验发现的两个真实问题（需决策）

### 8.1 版本号与内容倒挂（P0，发布阻塞）

npm `@wsz987/dsh-channels` 的 `latest` 是 **`0.5.0`**（2026-08-24），它构建于 Harness
**`0.1.1-rc.2`**，peer 仍包含已退役的 `@deepseek-ai/dsh-host-apiproxy`，因此在 `0.1.5-rc.2`
上**无法运行**（注入已移除的 `apiProxy` 会卡住 Cordis loader）。而本仓库工作树的
`package.json` 是 `0.4.2`，内容却是最新的 `0.1.5-rc.2` 线 —— **版本号与内容倒挂**。

后果：`docs/release.md` 原目标版本 `0.5.0` 已在 npm 存在，release 流程会按"已存在则跳过"
处理，**迁移将永远不会发布**。已把目标版本定为 `0.5.1` 并在 `docs/release.md` 增加校验步骤；
2026-09-11 执行 release-prep：消费全部 changeset 后，把 11 个发布包与 private root 对齐到
`0.5.1`（`changeset version` 从 `0.4.2 + minor` 只会算出被占用的 `0.5.0`，故按"下一个空闲
稳定版"重编号），`docs/release.md` 目标表与 `docs/compatibility-matrix.md` §1 已同步。
发布前必须确认：`npm view '@wsz987/channel-harness@<target>' peerDependencies` 指向
`0.1.5-rc.2` 且**不含** `dsh-host-apiproxy`。

### 8.2 v1 遗留路由是死代码（P2，与「只做最新版」方针冲突）

`/dsh-channels/api/v1/*`（`packages/channel-web/src/host/routes.ts`）是 M1 时代的兼容面：

- 客户端**从不使用**它 —— `packages/channel-web/src/client/api.ts:236` 声明了 `BASE_V1`
  但全仓库无任何调用，`request()` 的默认 base 是 `BASE_V2`。
- 它的渠道目录是硬编码四渠道 `CHANNEL_CATALOG = ['weixin','qq','dingtalk','lark']`
  （`routes.ts:27`），**缺 telegram**，因此真机 `/v1/channels` 只返回 4 条。
- v2（`routes-v2.ts`）已完整覆盖 auth（`beginAuth`/`pollAuth`/`submitAuthInput`/`cancelAuth`）
  与 owner claim，v1 无独有功能。

按本项目「只做最新版、不考虑向下兼容」的方针，v1 路由组（含 `CHANNEL_CATALOG` 与
`BASE_V1` 常量）是删除候选；删除需同步调整 `packages/channel-web/test/routes.test.ts`
与 `docs/release.md` 中 v1 的描述。此项属产品决策，未在本次核验中擅自删除。

## 9. 五渠道接入链路逐段审计（2026-09-10）

对五渠道的运行时链路做了代码级逐段核对：`cordis.patch.yml` 行 → bundle 再导出子路径 →
插件 `name`/`inject`/`apply` → `ChannelDefinition` → `ChannelAdapter` → 上游驱动，
以及入站（上游事件 → mapper → 媒体 hydration → `info` 摘要 → `ctx.emit`）与
出站（`send()` → 平台 API）。

### 9.1 rc.1 结论：链路无需改动

| 发布说明条目 | 代码事实 | 结论 |
| --- | --- | --- |
| 移除 `ctx.agent` | 全仓库无 `ctx.agent`；bridge 只用 `ctx.agents` | 未依赖 |
| Inbox 类型化（无 `hasPending`/`claim`） | 无引用；唯一 `claim()` 是本仓库 `reply-context-store.claim` | 未依赖 |
| `SessionHandle` 生命周期 + session 单写者锁 | bridge 只走 `list()` / `open(id,'read')`，用完即 `close()`；`SessionAlreadyOwnedError` 仅对 `'write'` 抛出 | 兼容 |
| `Session.events` → `snapshotEvents()` | `lifecycle.ts` 已用 `live.snapshotEvents()` 对账 | 已迁移 |
| V3 会话格式 | `list()` 快照取 `header.id`；持久化读取走公开 `open(id,'read')` 句柄 | 兼容 |
| persona 拆分 | 无 `personaPrefix`/`personaSuffix` 引用；仅消费默认模型以解析 `{{model}}` | 未依赖 |
| `settings.section` 槽位 | 客户端经 `ctx.slots.inject('settings.section', …)` 注册 | 已迁移 |
| `settings.register` 收裸命名空间串 | 五个插件均传小写字符串字面量 | 已迁移 |
| `apiProxy` 移除 | patch 的 inject 中不含它 | 兼容 |

五渠道共同确认项：patch 行 `name` 全部命中 bundle exports 子路径（由 `bundle.test.ts` 守护）；
行 `inject` 由 loader **合并**进插件自身 `inject`（并非要求相等）；适配器一律只经
`ctx.channels.createAdapterContext(...)` 取上下文，**无一**导入 `dsh-agent` / `dsh-session`；
五者都在 `ctx.emit` 前输出一条 `channel-<name>` 命名空间的入站摘要。

### 9.2 审计发现的既有问题（与 rc.1 无关，建议单独排期）

以下均为**既有**问题，不由本次 Harness 升级引入，因此未在本次改动；列出供后续决策：

- **P1｜QQ 主入站 payload 缺 zod 校验**：`channel-qq/src/inbound.ts` 与 `mapper.ts` 直接
  消费网关消息（`kind`/`content`/`attachments`/`timestamp`），仅 `mentions`、interaction
  与发送响应被 `safeParse`。非字符串 `content` 会在 `mapper.ts` 抛 `TypeError`，
  非数组 `attachments` 直接抛错。该包已依赖 zod，其他渠道同位置均有校验。
- **P1｜两个渠道的 Schema 仍保留 legacy 明文密钥键**：`channel-telegram/src/config.ts`
  的 `token` 与 `channel-dingtalk/src/config.ts` 的 `upstream.clientSecret`
  （均为 `Schema.string().hidden()`）。代码不会写入它们，但 schema 允许从配置层解析出
  明文密钥，且迁移只删内存字段、不改写 profile YAML —— 在无控制面路径下，
  telegram 适配器仍会读 `deps.token ?? config.token`，残留明文可能遮蔽已轮换的凭据。
  这与 AGENTS「config 只保存 credential reference」的约束存在张力。
- **P2｜三处信任边界缺校验**：DingTalk gateway 驱动（`src/upstream.ts` `/stream` 响应与
  card 响应）、Lark media port（`src/upstream/media-port.ts` 下载/上传结果，2xx 但
  `code != 0` 不会被诊断）、Telegram 下载二进制的元数据（`src/transport.ts` 的
  `content-type`/`content-disposition` 直接落到 `FilePart.name`）。
- **P2｜文档漂移（本次已修）**：weixin README 的能力表把 `file` 标为 ❌（适配器 `file: true`
  且 `sendFile` 在 `tencent-upstream.ts:323` 有真实实现）、示例 patch 行用了
  `@wsz987/channel-weixin`（应为 bundle 子路径 `@wsz987/dsh-channels/weixin`）；
  telegram README 能力表漏列 `interactiveActions`；`.changeset` 曾称 `dsh.client.inject`
  仅含 locale（实际含 locale + ui-settings）。
- **P3｜摘要日志含 `url` 字段**：QQ / Lark / Telegram 的 `image` 摘要在 AGENTS §5.2.1
  要求的四个字段之外额外打印了 `part.url`（QQ 为真实 CDN URL）；Weixin 的摘要恒打印
  `resourceRef: undefined`（其 mapper 只设 `url`）。

## 10. 迁移后回归核验：渠道问答全渠道失效（2026-09-12，已修）

用户报告：升级到本文档迁移后的工作树，**所有渠道的 `ask_user_question` 选择问题都不再出现**
（微信本应走编号文字兜底，也同样收不到）。

### 10.1 结论（CODE-CONFIRMED）

不是按钮/文字兜底坏了，而是**问题请求根本没到渠道侧**。0.1.2 把问题域从「单一 provider
槽位 + ApiProxy mux 广播」换成 `user-questions/request` **waterfall**，而 Cordis waterfall
是**串行、先认领者胜**（`cordis/lib/index.js`：`waterfall(...)` 逐个 `next()`，未调用
`next()` 的 listener 否决其后全部 listener）。`dsh-scope` 只承诺「未打 tag 的根 listener
一定被准入」，**不承诺顺序**。实测/代码证据链（本机安装 0.1.5-rc.1 产物 + 本仓库源码）：

| 环节 | 证据 |
| --- | --- |
| 官方分发 | `dsh-user-questions/lib/index.js` `ask()` → `ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', …, noAnswerer)` |
| 官方 Web answerer 注册时机 | `dsh-api-remotes/lib/index.js`：`apply()` → `ctx.typertGateway.registerRemoteEvents(remoteEventSource(ctx))`，生成器体在**启动时**同步注册 `user-questions/request` listener |
| 行顺序 | `dsh --profile web --dump-config`：`api-remotes`(451) 早于 `channels-harness`(550)；bridge 还要等 `channels` 服务（546），api-remotes 只等 `typertGateway`(22) |
| 有 client 连接时 | `dsh-api-gateway/lib/index.js` `startRemoteEvent()` 把请求投递给**所有**已连接 remote client；浏览器端 `dsh-client-ui-user-questions/lib/client.js` 只要 `ctx.sessions.scopeOf(owner)` 解析出 sessionId 就**认领并挂起**（`dsh-api-session-controller` 会为任何被寻址的 agentId `resolveAgentScope`），所以 GUI 一开就必胜 |
| 无 client 连接时 | 同一函数在没有 client 时**不投递也不 `next()`**，请求 park 在 `pendingRemoteEvents`（只有 client 应答或 agent context 释放才会 settle），渠道同样收不到 |

因此修复前的 `ctx.on('user-questions/request', …)`（普通 push）在 web profile 下**永远排在
官方 Remote answerer 之后**，渠道 answerer 形同不存在。

### 10.2 修复（`channel-harness`）

1. `WaterfallQuestionBackend` 改为 `ctx.on('user-questions/request', handler, { prepend: true })`：
   渠道能展示（binding + active reply context + `text: true`）就认领，不能展示仍 `next()`
   委托官方 Web answerer。`prepend` 是 cordis 公共 API（`on(name, listener, options?: boolean | EventOptions)`）。
2. 启动探测 `ctx.userQuestions` 不再「探测失败即永久关闭渠道问答」：profile 行并发创建、
   patch 可热重载，服务可能晚于 bridge 挂载；现在只 `warn` 并照常注册 answerer
   （answerer 只需要根 context，不调用该服务）。
3. 回归测试：`packages/channel-harness/test/question-waterfall-backend.test.ts` 新增
   「先注册一个 Web 式 answerer，渠道仍须拿到问题」与「渠道 decline 时仍能到达 Web answerer」
   两个用例；`test/question-backend.test.ts` 同步改为「探测失败只 warn 并照常组装」。

### 10.3 行为取舍（需产品确认）

waterfall 只有一个赢家，因此**渠道会话的问题只会出现在渠道里**（不再像 0.1.1 的 mux
广播那样同时出现在 Web GUI）。这是「谁问谁答」的默认取向；若需要恢复双端同时展示，
需要在渠道 answerer 内「认领 + 并发 `next()` 竞速」（谁先回答谁赢），代价是官方 Web 侧
可能残留一个已被渠道回答的 pending 问题（官方只在 waterfall settle 时才向其它 client
发 `cancel` 帧，而竞速路径不会 settle 转发的那个请求）。

## 11. 钉钉问答核验（2026-09-12）：「能力声明 ≠ 平台事实」的典型

**现象**：钉钉渠道 `ask_user_question` 一律回「无法在当前渠道展示问题，已取消。」

### 11.1 核验结论

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| 官方是否支持卡片按钮问答 | 支持（OFFICIAL-CONFIRMED） | 互动卡片「回传请求」按钮 + STREAM 回调；官方要求创建卡片带 `callbackType="STREAM"` 且注册 `/v1.0/card/instances/callback`（[钉钉卡片示例·注意事项](https://github.com/open-dingtalk/dingtalk-card-examples)、[卡片回调教程](https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/go/card-callback/)） |
| 本渠道代码是否实现了 | 实现存在（CODE-CONFIRMED） | `POST /v1.0/im/interactiveCards/send` + `PUT /v1.0/im/interactiveCards`；`stream-upstream.ts` 注册 `TOPIC_CARD`（= `/v1.0/card/instances/callback`）；`toCardInteractionRaw` 解析 `cardActionData.cardPrivateData.params`，与官方 Go SDK `CardRequest.CardActionData.CardPrivateData.Params` 形状一致 |
| 为什么实际失败 | **渠道代码缺陷（能力谎报）** | `card.interactiveTemplateId` 带内置默认值（`02fcf2f4-…schema`，第三方 Claw Bot AI Card 模板），`upstream.mode` 默认 `sdk`，于是 `interactiveActions` 对**任何**默认配置都是 `true`；该模板在本组织卡片平台不存在或变量名不匹配 → 卡片发送抛错 |
| 失败时的行为 | **缺陷（无兜底）** | presenter 只 catch 后取消，不降级为文字，尽管钉钉本可用编号文字回答 |

用户 `dsh --profile web --dump-config` 中 `channels-dingtalk` 行没有任何 `config`，
正好落在上述默认上——所以这不是「没接新版」，而是默认值把一个未经验证的平台能力
声明成了可用。

### 11.2 修复

1. `channel-harness`（通用，非渠道特判）：`present()` 在 actions 模式发送失败时，把该
   批次降级为 `text` 并**重新渲染**发送（重新渲染才会带上「回复 1/2/3」说明与群聊关联码），
   只有文字发送也失败才取消问题。对 QQ / Telegram / Lark 同样生效。
2. `channel-dingtalk`：`card.interactiveTemplateId` 取消内置默认（fail closed）——
   未显式配置即 `interactiveActions: false`，问题直接走编号文字（与微信一致）；
   配置了但发送失败由 (1) 兜底。`DEFAULT_DINGTALK_INTERACTIVE_TEMPLATE_ID` 仅保留给
   流式 AI Card 路径（`ai-card.ts`）。
3. 回归测试：`question-presenter.test.ts`（actions 失败→文字成功可答；文字也失败才取消）、
   `channel-dingtalk/test/adapter.test.ts`（默认不声明 `interactiveActions`；SDK + 显式
   模板才声明；gateway 模式永不声明）。

### 11.3 仍属 LIVE-REQUIRED

`POST /v1.0/im/interactiveCards/send` 是否接受 `callbackType`（官方明文只保证「创建卡片
时传 `callbackType=STREAM`」，本仓库未在真机验证该接口字段），以及卡片点击能否真的回到
STREAM 回调 topic。跑通前钉钉按钮路径不得标为已验证；用户侧默认走文字回复。



