---
title: 兼容矩阵
summary: dsh-channels 版本线 × DeepSeek Harness × Node 的兼容关系、当前 0.5.x 基线发布必测场景与渠道 smoke 清单。
when_to_use: 升级 | 发版 | 兼容性 | Harness 版本 | Node 版本 | 0.4.x | 0.5.x | smoke 清单
authoritative: 版本线兼容矩阵（旧版 / 当前开发线）、发布必测场景的覆盖状态。
see_also: [release.md, architecture.md]
status: as-built
---

# Compatibility Matrix（版本线兼容矩阵）

> **核验基线日期：2026-09-11**（registry 快照：`@deepseek-ai/dsh` 的 `latest` 是
> `0.1.5-rc.1`、`next` 是 `0.1.5-rc.2`，`alpha` 停在 `0.1.5-alpha.2`；不存在 `0.5.x`
> 家族包）。本仓库基线取 **`0.1.5-rc.2`**（`next`，最新已发布预发布版）。Harness 仍处于
> Developer Preview（官方声明会有 breaking change），因此兼容性按**版本线**声明，不做同一包
> 版本内的运行时双兼容。
>
> 两次 API diff 结论均为 **0 项破坏性变更**：
> - alpha.2 → rc.1：45 个包逐文件比对；唯一 `.d.ts` 变更是 `dsh-client-ui-primitives`
>   的纯增量 `CodeBlockProps.contentRef?`。
> - rc.1 → rc.2：28 个包中 27 个仅 `package.json` 有差异（311 处依赖区间 `^0.1.5-rc.1`
>   → `^0.1.5-rc.2`）；唯一新增 `.d.ts` 是未导出的内部模块；唯一功能变更是该包的
>   代码文件图标美术资源替换，公开导出面不变。
>
> 详见 [`docs/harness-0.5.x-migration-plan.md`](harness-0.5.x-migration-plan.md)。

## 1. 版本线矩阵

| dsh-channels 版本线 | DeepSeek Harness | 依赖声明方式 | Node engines | 状态 |
| --- | --- | --- | --- | --- |
| 0.4.x（0.4.2，npm 已发布） | 0.1.0-rc.7（legacy wave） | peer `^0.1.0-rc.7`（宽声明，历史遗留） | `>=22` | 维护线：仅接收关键修复，不跟进新 Harness |
| 0.5.0（npm 已发布，2026-08-24） | 0.1.1-rc.2 | peer 精确 `0.1.1-rc.2`，**含已退役 `dsh-host-apiproxy`** | `>=22` | ⚠️ 旧线；npm `latest` 指向它，但与 0.1.5-rc.2 **不兼容** |
| 当前开发线（`0.5.1`） | **0.1.5-rc.2（精确）** | dependencies / devDependencies / peerDependencies 全部精确 `0.1.5-rc.2`（tested compatibility band，无 `^`/范围） | `^22.19.0 \|\| >=24.0.0` | 当前开发线：11 个发布包 + private root 已完成 release-prep（`changeset version` 已消费全部 changeset 并对齐 `0.5.1`），**待打 `v0.5.1` tag 发布** |

- **⚠️ 版本号与内容倒挂（`0.5.1` 发布前仍然成立）**：npm `@wsz987/dsh-channels` 的 `latest`
  是 **`0.5.0`**，它构建于旧 Harness `0.1.1-rc.2`，peer 仍包含已退役的
  `@deepseek-ai/dsh-host-apiproxy` —— 在 `0.1.5-rc.2` 上注入已移除的 `apiProxy` 会卡住
  Cordis loader，因此 **0.5.0 无法在 0.1.5-rc.2 上运行**。旧的 Harness 线占用了 `0.5.0`
  这个号，当前 `0.1.5-rc.2` 线只能发下一个空闲稳定版 **`0.5.1`**：`0.4.2 + minor` 只会算出
  `0.5.0`（与 npm 上已存在的版本号相撞，release 流程会按"已存在则跳过"处理，迁移将永远不会
  发布），因此 release-prep 直接把消费 changeset 后的版本对齐到 `0.5.1`（`docs/release.md`
  目标版本表已同步）。剩余动作只有打 tag：`git tag v0.5.1 && git push origin v0.5.1`。
- 由此产生的用户侧风险：`@latest` 当前装到的是面向 `0.1.1-rc.2` 的旧 bundle；而
  `channel-control` 的 update-check 会把 `0.5.0` 提示为 "有可用更新"（`crossLine: true`），
  对 0.1.5-rc.2 用户实际是**降级**。发布 `0.5.1` 后该提示才回归正确语义。
- 当前开发线 **不**与旧 Harness 运行时双兼容（新版移除了 ApiProxy、
  `Session.events` 与单一 UserQuestionProvider 槽位）。旧版本用户二选一：升级 Harness
  到 `0.1.5-rc.2`，旧版本用户需停留在对应旧 bundle。
- 版本推进是**单向**的：`0.1.5-rc.2` 满足 `^0.1.5-alpha.2`，但 `0.1.5-alpha.2` 不满足
  `^0.1.5-rc.2`。`pnpm-lock.yaml` 重新生成后只解析出一个 `dsh-*` 版本（`0.1.5-rc.2`），
  无 `rc.1` / `alpha` tag 残留。注意 `dsh-fs` / `dsh-sandbox` / `dsh-client-file-upload` 的
  npm `latest` 是无关的陈旧 `0.0.1-rc.1`，这些包必须由 rc.2 pin 显式带动，不能依赖
  dist-tag；同理子包的 `latest` 也不指向当前预发布线，**必须精确 pin**。
- 单一事实来源：`scripts/check-upstream.mjs` 的 `HARNESS_TESTED_VERSION` 常量
  （`packages/channel-harness/src/commands/version.ts` 中有镜像常量，由
  `test/commands-version.test.ts` 守护一致性）。阻塞门禁 `pnpm check:harness-compat`
  （基线统一 + registry 存在性）；提示性报告 `pnpm check:harness-newer`（"已发布，尚未验证"，
  exit 0）。两者均已纳入 `pnpm ci:check`，每周 `upgrade.yml` 也会运行。

## 2. Node 矩阵

| Node | 0.4.x | 0.5.x | 说明 |
| --- | --- | --- | --- |
| 22.x < 22.19 | 支持 | 不支持 | 当前 Harness 运行时要求 22.19+（root `engines: ^22.19.0 \|\| >=24.0.0`） |
| 22.19.x | 支持 | 支持 | 本仓库 CI 核验线（`ci.yml` Node 22 + frozen lockfile） |
| 24.x | 支持 | 支持（发布前需手动 smoke） | CI 当前只跑 Node 22；24.x 在发版前手动或 `workflow_dispatch` 验证（遗留项，见 release.md） |

## 3. 0.5.x 发布必测场景

覆盖状态标注：`offline` = 本仓库离线测试套件已覆盖（`pnpm ci:check` 全绿）；
`live` = 需要真实环境验证（clean profile / 真实渠道 / 真实模型账号），发版前手动执行。

| 场景 | 必测 Harness / Node | 覆盖 | 位置 / 方式 |
| --- | --- | --- | --- |
| Harness 基线统一 | 0.1.5-rc.2 | offline | `pnpm check:harness-compat`（workspace 精确 pin + registry 存在性） |
| Node 引擎 | 22.19.x | offline | root `engines` + CI Node 22 leg |
| Node 24.x | 24.x | live | 发版前手动 smoke（当前无 CI matrix leg） |
| Fresh Session | 0.1.5-rc.2 | offline | `channel-harness/test/harness-compat.test.ts`（create 路由/preset） |
| Persisted Resume | 0.1.5-rc.2 | offline | `reply-router-session-contract.test.ts`（同 Session 第二轮）、`binding-v3.test.ts`（FileBindingStore reopen） |
| Missing persisted binding | 0.1.5-rc.2 | offline | `binding-v3.test.ts`（无映射返回 undefined / 迁移链） |
| `/new` | 0.1.5-rc.2 | offline | `commands.test.ts` |
| `/stop` while streaming | 0.1.5-rc.2 | offline | `stop.test.ts` + session-contract（aborted turn 交付截断前缀） |
| unknown slash | 0.1.5-rc.2 | offline | `commands.test.ts` / bridge（reject，不进 LLM） |
| `/model` | 0.1.5-rc.2 | offline | `commands-model.test.ts`、`commands-help-status-models.test.ts` |
| reasoning effort | 0.1.5-rc.2 | offline | `commands-model.test.ts`（effort 解析与透传） |
| `ask_user_question` | 0.1.5-rc.2 | offline | `question-presenter/-waterfall-backend.test.ts`（question 走官方 `user-questions/request` waterfall）；渠道矩阵见下方 |
| question waterfall 委托/中止 | 0.1.5-rc.2 | offline | `question-waterfall-backend.test.ts`（官方 `ask()` 分发、decline → `next()` → `NO_PROVIDER`、abort/cancel/stop） |
| question answerer 顺序（web profile） | 0.1.5-rc.2 | offline | `question-waterfall-backend.test.ts`（先注册官方 Remote/Web 式 answerer，渠道 `prepend` answerer 仍须拿到问题；渠道 decline 时仍能到达 Web answerer）、`question-backend.test.ts`（探测失败只 warn，不关闭问答） |
| `/model` host 通道 | 0.1.5-rc.2 | offline | `commands-model.test.ts`（host 模式走 `sessionController.selectModel`，无 rpcId 信封；Host current 读取走 header/options/default 链） |

`ask_user_question` 渠道矩阵（Harness 选择题/确认问题的展示与回答方式，P0 统一文本兜底）：

```text
Telegram : actions + text（原生按钮 + 文字回答）
Weixin   : text（编号文字回复）
QQ       : actions + text（新版 QQ Markdown keyboard + @机器人编号文字回答）
DingTalk : text（默认；interactiveActions 需显式配置本组织已发布的卡片模板）
Lark     : actions + text（原生卡片按钮 callback + 编号文字回答）
```

所有内置渠道 `text: true` 均可完成 `ask_user_question`；`interactiveActions: true`
（Telegram / QQ / Lark；DingTalk 需显式配置卡片模板）优先显示原生按钮，其余自动降级为
编号文字回复。**声明的按钮能力若在真实平台不可用（卡片模板未发布、缺权限），
`channel-harness` 会把该批问题降级为编号文字并重新发送，而不是取消问题。**

| 场景（续） | 必测 Harness / Node | 覆盖 | 位置 / 方式 |
| --- | --- | --- | --- |
| question multi select | 0.1.5-rc.2 | offline | `question-presenter.test.ts`（multi-select 只提交最新集合） |
| question custom answer | 0.1.5-rc.2 | offline | `question-presenter.test.ts`（批量问题含自定义文本答案） |
| plan-review intent | 0.1.5-rc.2 | offline | `question-presenter.test.ts`（intent/detail/header 透传，approve 主按钮） |
| image → vision model | 0.1.5-rc.2 | offline（投影语义） | `image-pipeline.test.ts`（saveImage 落 ImageBlock，agent/pre-step 零改写）；真实视觉模型效果属 live |
| image → text-only model | 0.1.5-rc.2 | offline（投影语义） | 同上（确定性占位由官方 request projection 决定） |
| DeepSeek Files path | 0.1.5-rc.2 | offline + live | 离线：附件转换与官方 pipeline 测试；真实 DeepSeek Files 上传链路需 live（真实模型账号） |
| attachment fallback | 0.1.5-rc.2 | offline | `message-converter-file.test.ts`（无 hook / hook 失败降级占位） |
| 可选 seam 惰性解析 | 0.1.5-rc.2 | offline | `file-provider-compat.test.ts`（`liveAttachmentProvider`：provider 后挂载仍可见；缺失时不硬依赖） |
| streamed reply | 0.1.5-rc.2 | offline | `reply-router-edit.test.ts`（V3 stream 节流 / turn/end 冲洗） |
| buffered reply | 0.1.5-rc.2 | offline | `reply-router-edit.test.ts`（无 createReply 时降级 buffered） |
| edit reply | 0.1.5-rc.2 | offline | `reply-router-edit.test.ts`（edit 模式累积替换）+ Telegram `render.test.ts` |
| V3 persistence | 0.1.5-rc.2 | offline | `persistence-compat.test.ts`（V3 list/open/read/close 与单向升级读取） |
| web turn 镜像（opt-in） | 0.1.5-rc.2 | offline | `mirror.test.ts`（无 ReplyContext 的 turn 仅在 `mirror: true` 时缓冲送达） |
| `/mirror` / `/bind` | 0.1.5-rc.2 | offline | `mirror-bind-commands.test.ts`（fail-closed 解析、冲突拒绝、两步确认、开关持久化） |
| 图片出站解析 | 0.1.5-rc.2 | offline | `channel-files/test/image-mirror.test.ts`（镜像写入与解析）+ `image-pipeline.test.ts`（镜像失败不阻断投递）+ `file-provider-compat.test.ts`（解析器惰性接线）；真实渠道上传链路仍属 live |
| Web plugin boot | 0.1.5-rc.2 | live ✅ 2026-09-10 / 2026-09-11 | 隔离 `DSH_HOME` 真机启动通过（rc.1 与 rc.2 各一次，结果一致）：`channel-harness` 插件加载、token URL 打印、9 行插件全部落地、`/dsh-channels/api/v1`+`/v2` 路由真实注册（未知路径 404 对照成立）、客户端 bundle 出现在 boot graph 且 HTTP 200 可取回。详见迁移记录 §7 |
| Settings → Channels | 0.1.5-rc.2 | live（面板交互待人工走查） | 服务端链路已在上条验证；浏览器内 Settings → 渠道 的面板渲染/扫码/安全访问交互仍属人工 live 走查 |

### 3.1 接入链路真机核验（2026-09-10，rc.1）

在隔离 `DSH_HOME`（未触碰用户真实 `~/.dsh`）中用 rc.1 CLI 建立 `web` profile 并链入本地
工作树 bundle，逐段验证链路：

| 链路环节 | 证据 | 结论 |
| --- | --- | --- |
| bundle patch 发现 + 9 行落地 | `dsh --profile <p> --dump-config` 列出 `channels-service/files/harness/control/weixin/qq/dingtalk/lark/telegram/web` 全部行，id/name/inject 正确 | ✅ |
| exports 子路径解析 | 上表各行 `name: @wsz987/dsh-channels/<sub>` 均来自 `packages/channels/package.json` exports | ✅ |
| 插件运行时加载 | 启动日志 `[channel-harness] console diagnostics enabled (DSH_CHANNELS_DEBUG=1)` | ✅ |
| 五渠道注册 | `GET /dsh-channels/api/v2/channels` → 五渠道全列；weixin 真实 `mounted:true, runtime:"running"`，capabilities 完整 | ✅ |
| 控制面 API | `GET /dsh-channels/api/v2/channels` / `update-check` → 200（对照：未知路径 404，`/` 401 正常鉴权） | ✅ |
| channel-control update-check 真实网络链路 | 返回 `{"currentVersion":"0.4.2","update":{"version":"0.5.0","crossLine":true,...}}` | ✅（并暴露上述版本倒挂） |
| Web 客户端投递 | `__DSH_BOOT__` 含 `{"id":"@wsz987/dsh-channels","url":"/plugins/??@wsz987/dsh-channels/client.js&rev=...","inject":[locale,ui-settings]}`；该 URL 返回 200 / 189690 B，内容为 `window.__ModuleLoader__.load({id,factory})` 且含 `settings.section` | ✅ |
| 真实平台收发 | 需真实账号/应用 | LIVE-REQUIRED（未变） |

## 4. 渠道 smoke 清单（live，发版前）

每个渠道至少一轮真实往返（收文本 → Agent 回复 → 发文本），加渠道特有项：

| 渠道 | 基础 smoke | 渠道特有项 | 现状 |
| --- | --- | --- | --- |
| Telegram | 文本往返 | 图片/文件收发、edit streaming、callback 按钮、`formatting.mode: auto` | manifest `experimental`，live gate 未跑 |
| Weixin | 文本往返 | 扫码登录、凭据持久化重启、图片收发 | live gate 见 `docs/weixin-live-verification-runbook.md` |
| QQ | 文本往返 | 私聊（创建者）、群聊 @、图片/文件、流式 | offline fixtures 全绿 |
| DingTalk | 文本往返 | 扫码或应用凭据、流式（SDK 模式） | offline fixtures 全绿 |
| Lark | 文本往返 | 事件订阅、图片/文件、主动外发 | offline fixtures 全绿 |

Live 渠道 smoke 不放在普通 PR CI；微信走 `live-weixin.yml`（`workflow_dispatch` + secret 门控）。

### 4.1 五渠道 rc.1 支持性核验（2026-09-10）

对五个适配器逐一核验「Harness rc.1 升级是否影响本渠道」。注意：各渠道 `manifest.testedVersion`
是**上游平台/SDK 版本**，不是 Harness 版本 —— Harness 基线单独由 `HARNESS_TESTED_VERSION`
治理，因此 `1.0.4` / `2.1.5` / `1.73.1` / `10.2` 等值**不需要**改成 `0.1.5-rc.2`。

| 渠道 | upstream testedVersion | status | 上游 pin 精确 | 架构红线 | 结论 |
| --- | --- | --- | --- | --- | --- |
| weixin | `<pending-live-verification>` | experimental | n/a（无 SDK 依赖，`versionRange: '*'`） | 干净 | rc.1 兼容；live pin 待完成（LIVE-REQUIRED，非 rc.1 阻塞） |
| qq | `1.0.4` | tested | 是（`@tencent-connect/qqbot-nodejs: 1.0.4`） | 干净 | rc.1 兼容 |
| dingtalk | `2.1.5` | tested | 是（`dingtalk-stream: 2.1.5`） | 干净 | rc.1 兼容 |
| lark | `1.73.1` | tested | 是（`@larksuiteoapi/node-sdk: 1.73.1`） | 干净 | rc.1 兼容 |
| telegram | `10.2` | experimental | n/a（协议直连；`@grammyjs/types` 4.0.0 精确） | 干净 | rc.1 兼容 |

核验要点（全部 CODE-CONFIRMED）：

- **架构红线**：五个适配器包（src 与 test）均无 `ctx.agents` / `@deepseek-ai/dsh-agent` /
  `dsh-session` 引用；其全部 `@deepseek-ai/*` 导入仅 `cordis`、`dsh-credentials`、`dsh-settings`、
  `schemastery`。即渠道不接触 rc.1 变更面，Harness 影响全部落在 `channel-harness`。
- **inject 名称**：`packages/channels/cordis.patch.yml` 中的 `agents` / `agentDefaultModel` /
  `agentPresets` / `llm` / `commands` / `credentials` 在 rc.1 全部存在（另有本 bundle 自提供的
  `channels` / `channelControl`）→ 不会导致 Cordis loader 卡住。
- **peer**：`channel-harness` 的 17 个 `@deepseek-ai/dsh-*` peer 全部发布了 `0.1.5-rc.2`；
  `@deepseek-ai/cordis: ^4.0.2` 属独立 4.x 线（rc.1 实际随附 4.0.2），非缺陷。
- **离线覆盖**：五渠道均有 contract（`runChannelAdapterContract`）+ fixture（`loadFixture`）双覆盖。

## 5. 门禁与命令映射

| 命令 | 阻塞 | 作用 |
| --- | --- | --- |
| `pnpm check:upstream` | 是 | channel SDK 精确 pin + dsh-* 基线统一 + 非 dsh `@deepseek-ai/*`（cordis/schemastery）npm latest drift |
| `pnpm check:harness-compat` | 是 | 仅 dsh-* 基线（workspace 全部精确 `HARNESS_TESTED_VERSION` + registry 发布该版本） |
| `pnpm check:harness-newer` | 否（exit 0） | 报告高于基线的已发布 dsh-* 版本（"已发布，尚未验证"），提示启动升级流程 |
| `pnpm ci:check` | 是 | 本地全门禁（build/typecheck/test/verify/fixtures/manifests/harness-compat/harness-newer/doctor/bundle） |
| `upgrade.yml`（每周） | 是 | `check:upstream` + `check:harness-newer` + fixtures/manifests/doctor |

基线升级流程（AGENTS.md 红线 6）：Renovate PR → typecheck → contract → fixtures →
adapter tests → 全绿后把 `HARNESS_TESTED_VERSION` 与 workspace 所有 dsh-* pin 一起更新。
