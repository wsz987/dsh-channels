# Harness 0.1.5-rc.2 适配与渠道核验记录

> 核验日期：2026-09-10（rc.1）／2026-09-11（rc.2）；问答相关补充：2026-09-12。
> 目标：仅支持官方最新 Harness `0.1.5-rc.2`；不保留旧 Harness 兼容层。
> 本文只保留**仍然成立的基线事实、硬规则与未完成项**；已执行的搬运步骤、逐包 diff
> 细节和验收命令已随实现落地删除（版本与发布权威见 `docs/release.md`）。

## 1. 版本事实（OFFICIAL-CONFIRMED）

- 本仓库基线是 **`0.1.5-rc.2`**（发布 `2026-09-10T14:57:10Z`），取自 npm `next` 标签；
  官方当时未把 rc.2 提为 `latest`（`latest` 停在 `0.1.5-rc.1`），因此全部
  `@deepseek-ai/dsh-*` 声明**精确 pin**，不依赖 dist-tag 解析。
- 官方版本线是 `0.1.5-rc.x`；本仓库早前「0.5.x」的说法是对版本号的误称，不存在
  `0.5.x` 家族包（`0.5.x` 是**本产品**的版本号）。
- 上游更新走 manifest 治理：`testedVersion` / `versionRange` 固定，升级须
  Renovate → typecheck → contract → fixtures → live gate（AGENTS.md 红线 6）。

## 2. 官方破坏性变更结论（CODE-CONFIRMED）

### 2.1 公共 API diff

- `0.1.5-alpha.2 → rc.1` 与 `rc.1 → rc.2` 均**无公共 API 破坏性变更**（逐包 `.d.ts` +
  `package.json` 结构化比对；rc.2 唯一功能变更是官方 Web UI 的图标与反馈弹窗，
  本项目未使用相关符号）。因此两次推进都是纯版本号迁移。
- 真正影响本仓库的是 **alpha.2 → rc.1** 这批开发者向条目：

| 官方变更 | 本仓库落点 |
| --- | --- |
| 移除 `apiProxy` / 单一 `UserQuestionProvider` 槽位 | 问题域改走官方 `user-questions/request` waterfall；详见 §10 |
| `Session.events` 移除 → `snapshotEvents()` | `lifecycle.ts` 用 `live.snapshotEvents()` |
| Session persistence 改 `SessionHandle`，新增 session 单写者锁 | 只经 `sessionPersistence.list()` 与 `open(id,'read')`，用完即 `close()`（锁只对 `'write'` 抛） |
| 会话格式升级 V3，旧日志单向迁移、不支持降级 | `persistence-compat.test.ts` 覆盖 V3 list/open/read/close 与单向升级 |
| 移除 `ctx.agent`、Inbox 类型化、preset 拆分、`settings.section` 保留 | 未依赖 / 已对齐（`ctx.agents` 复数 + 显式 Agent） |

### 2.2 配置与 patch 语义（硬规则，仍适用）

- 配置层优先级：bundle patch（按 `dsh.profile.bundles` 顺序）→ profile `cordis.patch.yml`
  → `$DSH_HOME/cordis.patch.yml` → argv 顺序的每个 `--patch`。
- **patch 是整体替换目标行的整个 `config`，不是深度合并。** 覆盖既有行时必须重述该行
  需要的每一个键。（本仓库 `packages/channels/cordis.patch.yml` 只做 `insert`，不受影响。）
- 启动器 flag 必须写在应用参数之前。

## 2.3 已验证的接入链路（rc.1 与 rc.2 各跑一次，结果一致）

在**隔离 `DSH_HOME`**（未触碰用户真实 `~/.dsh`）中用 CLI 建立 `web` profile 并链入本地
工作树 bundle，逐段验证：

```text
bundle patch 发现/落地 → 9 行插件加载 → 五渠道注册 → 控制面 API 200
                      → 客户端 bundle 投递 → boot graph 条目
```

| 环节 | 证据 |
| --- | --- |
| patch 落地 | `--dump-config` 列出全部 9 行（service/files/harness/control/五渠道/web），id/name/inject 正确 |
| 插件加载 | 启动日志出现 `[channel-harness] console diagnostics enabled` |
| 五渠道注册 | `GET /dsh-channels/api/v2/channels` 返回五渠道齐全 |
| API 路由 | `/v2/channels`、`/v2/update-check`、`/v1/channels` → 200；未知路径 → 404；`/` → 401 |
| 客户端投递 | `__DSH_BOOT__` 含 `@wsz987/dsh-channels` 条目，其 url 200 且内容为 `window.__ModuleLoader__.load({id,factory})` |
| 真实平台收发 | 需真实账号/应用 → **LIVE-REQUIRED**（按渠道见 `docs/compatibility-matrix.md` §4） |

关键结论：本批 Harness 变更（`ctx.agent` 移除、Inbox 类型化、`SessionHandle` 生命周期、
session 单写者锁、`Session.events`→`snapshotEvents`、V3、persona 拆分、`settings.section`）
均未影响渠道接入链路；特别是 session 锁只对 `'write'` 抛，而 bridge 只用
`list()` / `open(id,'read')` 且用完即 `close()`。

## 3. 风险与回滚

- V3 会话格式升级**单向**：升级前备份 session store；新版会话不可被旧 Harness 读取。
- 本项目不提供旧 Harness 运行时兼容层：必须先把 CLI 升到 `0.1.5-rc.2` 再安装本 bundle，
  顺序不可颠倒；rc.2 位于 `next` 标签，升级命令必须写显式版本。

## 4. 未完成项（发布前必须处理）

### 4.1 版本号与内容倒挂（P0，发布阻塞）

npm `@wsz987/dsh-channels` 的 `latest` 是 **`0.5.0`**（2026-08-24），它构建于 Harness
**`0.1.1-rc.2`**，peer 仍包含已退役的 `@deepseek-ai/dsh-host-apiproxy`，因此在
`0.1.5-rc.2` 上**无法运行**（注入已移除的 `apiProxy` 会卡住 Cordis loader）。

后果：release 流程按「版本已存在则跳过」处理，若目标版本仍写 `0.5.0`，迁移将永远不会发布。
因此 release-prep 把 11 个发布包 + private root 对齐到**下一个空闲稳定版 `0.5.1`**
（`0.4.2 + minor` 只会算出被占用的 `0.5.0`）。

发布前必须确认：`npm view '@wsz987/channel-harness@<target>' peerDependencies` 指向
`0.1.5-rc.2` 且**不含** `dsh-host-apiproxy`；剩余动作只有打 tag
（`git tag v0.5.1 && git push origin v0.5.1`，见 `docs/release.md`）。

### 4.2 v1 遗留路由是死代码（P2，待产品决策）

`/dsh-channels/api/v1/*`（`packages/channel-web/src/host/routes.ts`）是 M1 时代的兼容面：

- 客户端**从不使用**它（`client/api.ts` 的 `BASE_V1` 无调用，`request()` 默认 `BASE_V2`）；
- 渠道目录是硬编码四渠道（缺 telegram），真机 `/v1/channels` 只返回 4 条；
- v2 已完整覆盖 auth 与 owner claim。

按「只做最新版」方针属删除候选；删除需同步调整 `channel-web/test/routes.test.ts` 与
`docs/release.md`。

### 4.3 其他待办（与本次升级无关，单独排期）

- **P1｜QQ 主入站 payload 缺 zod 校验**：`channel-qq/src/inbound.ts` 与 `mapper.ts` 直接
  消费网关消息（`kind`/`content`/`attachments`/`timestamp`）；非字符串 `content` / 非数组
  `attachments` 会抛 `TypeError`。该包已依赖 zod，其他渠道同位置均有校验。
- **P1｜两处 legacy 明文密钥键仍在 schema 中**：`channel-telegram/src/config.ts` 的
  `token` 与 `channel-dingtalk/src/config.ts` 的 `upstream.clientSecret`。代码不写入它们，
  但 schema 允许从配置层解析出明文密钥，且迁移只删内存字段、不改写 profile YAML —— 在无
  控制面路径下，残留明文可能遮蔽已轮换的凭据。与「config 只保存 credential reference」
  存在张力。
- **P2｜三处信任边界缺校验**：DingTalk gateway 驱动（`/stream` 响应与 card 响应）、
  Lark media port（2xx 但 `code != 0` 不被诊断）、Telegram 下载二进制的元数据
  （`content-type` / `content-disposition` 直接落到 `FilePart.name`）。

## 5. 问答链路（2026-09-12 修复记录）

### 5.1 渠道问答全渠道失效（CODE-CONFIRMED，已修）

现象：升级后**所有渠道**的 `ask_user_question` 都不出现（微信本应走编号文字兜底）。

根因不是按钮/文字兜底坏了，而是**问题请求根本没到渠道侧**。官方问题域是
`user-questions/request` **waterfall**：Cordis waterfall **串行、先认领者胜**，第一个返回
答案的 listener 否决其后全部 listener，只有 `next()` 才委托。`dsh-scope` 只保证「未打 tag
的根 listener 一定被准入」，**不承诺顺序**（因此 patch 里「无排序契约」的说法是错的）。
证据链（本机安装产物 + 本仓库源码）：

| 环节 | 证据 |
| --- | --- |
| 官方分发 | `dsh-user-questions` 的 `ask()` → `ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', …, noAnswerer)` |
| Web answerer 注册时机 | `dsh-api-remotes` 的 `apply()` → `ctx.typertGateway.registerRemoteEvents(...)`，生成器体在**启动时**同步注册 listener |
| 行顺序 | `dsh --profile web --dump-config`：`api-remotes` 远早于 `channels-harness`（后者还要等 `channels` 服务） |
| 有 client 连接 | `dsh-api-gateway` 把请求投递给所有已连接 remote client；浏览器端只要 `sessions.scopeOf(owner)` 解析出 sessionId 就**认领并挂起**（会为任意 agentId `resolveAgentScope`） |
| 无 client 连接 | 同一函数在零 client 时**不投递也不 `next()`**，请求 park 在 `pendingRemoteEvents` |

修复：

1. `WaterfallQuestionBackend` 改用
   `ctx.on('user-questions/request', h, { prepend: true })`：渠道能展示（binding + active
   reply context + `text: true`）就认领，不能展示仍 `next()` 委托官方 Web answerer。
2. 启动探测 `ctx.userQuestions` 失败不再永久关闭渠道问答，只 `warn`：服务可能晚于 bridge
   挂载（profile 行并发创建、patch 可热重载），answerer 只需要根 context。
3. 回归测试：`question-waterfall-backend.test.ts`（Web answerer 先注册，渠道仍须拿到问题；
   渠道 decline 时仍能到达 Web answerer）、`question-backend.test.ts`。

**行为取舍（需产品确认）**：waterfall 只有一个赢家，因此渠道会话的问题只出现在渠道里，
不再像 ApiProxy mux 广播时代那样 Web 与渠道同显。要恢复双端同显需在渠道 answerer 内
「认领 + 并发 `next()` 竞速」，代价是官方 Web 侧可能残留一个已被渠道回答的 pending 问题。

### 5.2 钉钉问答核验（「能力声明 ≠ 平台事实」）

现象：钉钉渠道 `ask_user_question` 一律回「无法在当前渠道展示问题，已取消。」

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| 官方是否支持卡片按钮问答 | 支持（OFFICIAL-CONFIRMED） | 互动卡片「回传请求」按钮 + STREAM 回调；官方要求创建卡片带 `callbackType="STREAM"` 且注册 `/v1.0/card/instances/callback`（[钉钉卡片示例](https://github.com/open-dingtalk/dingtalk-card-examples)、[卡片回调教程](https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/go/card-callback/)） |
| 渠道代码是否实现了 | 骨架正确（CODE-CONFIRMED） | `POST /v1.0/im/interactiveCards/send` + `PUT /v1.0/im/interactiveCards`；`stream-upstream.ts` 注册 `TOPIC_CARD`（= `/v1.0/card/instances/callback`）；`toCardInteractionRaw` 解析 `cardActionData.cardPrivateData.params`，与官方 Go SDK `CardRequest.CardActionData.CardPrivateData.Params` 形状一致 |
| 为什么实际失败 | **渠道代码缺陷（能力谎报）** | `card.interactiveTemplateId` 带内置第三方模板默认值 + `upstream.mode` 默认 `sdk` → `interactiveActions` 对任何默认配置都是 `true`；该模板在本组织卡片平台不存在 → 卡片发送抛错 |
| 失败时的行为 | **缺陷（无兜底）** | presenter 只 catch 后取消，尽管钉钉本可用编号文字回答 |

修复：

1. `channel-harness`（通用，非渠道特判）：actions 模式发送失败时把该批问题降级为 `text`
   并**重新渲染**发送（重新渲染才带上「回复 1/2/3」说明与群聊关联码），只有文字也失败才
   取消。对 QQ / Telegram / Lark 同样生效。
2. `channel-dingtalk`：`card.interactiveTemplateId` 取消内置默认（fail closed）——未显式
   配置即 `interactiveActions: false`，问题走编号文字（与微信一致）。
   `DEFAULT_DINGTALK_INTERACTIVE_TEMPLATE_ID` 仅保留给流式 AI Card 路径（`ai-card.ts`）。
3. 回归测试：`question-presenter.test.ts`（actions 失败→文字成功可答；文字也失败才取消）、
   `channel-dingtalk/test/adapter.test.ts`（默认不声明按钮；SDK + 显式模板才声明）。

**仍属 LIVE-REQUIRED**：`POST /v1.0/im/interactiveCards/send` 是否接受 `callbackType`，以及
卡片点击能否真的回到 STREAM 回调 topic。跑通前钉钉按钮路径不得标为已验证。
