---
title: 兼容矩阵
summary: dsh-channels 版本线 × DeepSeek Harness × Node 的兼容关系、0.5.x 发布必测场景与渠道 smoke 清单。
when_to_use: 升级 | 发版 | 兼容性 | Harness 版本 | Node 版本 | 0.4.x | 0.5.x | smoke 清单
authoritative: 版本线兼容矩阵（0.4.x legacy / 0.5.x modern）、发布必测场景的覆盖状态。
see_also: [release.md, architecture.md]
status: as-built
---

# Compatibility Matrix（版本线兼容矩阵）

> **核验基线日期：2026-08-22**（registry 快照：`@deepseek-ai/dsh-*` 的 npm `latest`
> 停在 `0.1.0-rc.6`，`0.1.1-rc.2` 位于 `next`）。Harness 处于 Developer Preview
> （官方声明会有 breaking change），因此兼容性按**版本线**声明，不做同一包版本内的
> 运行时双兼容（升级方案 §17）。

## 1. 版本线矩阵

| dsh-channels 版本线 | DeepSeek Harness | 依赖声明方式 | Node engines | 状态 |
| --- | --- | --- | --- | --- |
| 0.4.x（0.4.2） | 0.1.0-rc.7（legacy wave） | peer `^0.1.0-rc.7`（宽声明，历史遗留） | `>=22` | 维护线：仅接收关键修复，不跟进新 Harness |
| 0.5.x | **0.1.1-rc.2（精确）** | dependencies / devDependencies / peerDependencies 全部精确 `0.1.1-rc.2`（tested compatibility band，无 `^`/范围） | `^22.19.0 \|\| >=24.0.0` | 当前开发线 |

- 0.5.x **不**与 rc.7 运行时双兼容。rc.7 用户二选一：升级 Harness 到 `0.1.1-rc.2`，
  或停留在 `@wsz987/dsh-channels@0.4.2`。
- 兼容带扩展规则（§16）：新 Harness 版本（如 `0.1.1-rc.3`）只有跑完 compatibility
  suite 后才进入 peer 声明，且形式是显式 OR（`0.1.1-rc.2 || 0.1.1-rc.3`），
  **绝不**写成 `^0.1.1-rc.2`。
- 单一事实来源：`scripts/check-upstream.mjs` 的 `HARNESS_TESTED_VERSION` 常量。
  阻塞门禁 `pnpm check:harness-compat`（基线统一 + registry 存在性）；提示性报告
  `pnpm check:harness-newer`（"已发布，尚未验证"，exit 0）。两者均已纳入
  `pnpm ci:check`，每周 `upgrade.yml` 也会运行。

## 2. Node 矩阵

| Node | 0.4.x | 0.5.x | 说明 |
| --- | --- | --- | --- |
| 22.x < 22.19 | 支持 | 不支持 | rc.2 官方运行时要求 22.19+（root `engines: ^22.19.0 \|\| >=24.0.0`） |
| 22.19.x | 支持 | 支持 | 本仓库 CI 核验线（`ci.yml` Node 22 + frozen lockfile） |
| 24.x | 支持 | 支持（发布前需手动 smoke） | CI 当前只跑 Node 22；24.x 在发版前手动或 `workflow_dispatch` 验证（遗留项，见 release.md） |

## 3. 0.5.x 发布必测场景（升级方案 §24）

覆盖状态标注：`offline` = 本仓库离线测试套件已覆盖（`pnpm ci:check` 全绿）；
`live` = 需要真实环境验证（clean profile / 真实渠道 / 真实模型账号），发版前手动执行。

| 场景 | 必测 Harness / Node | 覆盖 | 位置 / 方式 |
| --- | --- | --- | --- |
| Harness 基线统一 | 0.1.1-rc.2 | offline | `pnpm check:harness-compat`（workspace 精确 pin + registry 存在性） |
| Node 引擎 | 22.19.x | offline | root `engines` + CI Node 22 leg |
| Node 24.x | 24.x | live | 发版前手动 smoke（当前无 CI matrix leg） |
| Fresh Session | 0.1.1-rc.2 | offline | `channel-harness/test/harness-compat.test.ts`（create 路由/preset） |
| Persisted Resume | 0.1.1-rc.2 | offline | `reply-router-session-contract.test.ts`（同 Session 第二轮）、`binding-v3.test.ts`（FileBindingStore reopen） |
| Missing persisted binding | 0.1.1-rc.2 | offline | `binding-v3.test.ts`（无映射返回 undefined / 迁移链） |
| `/new` | 0.1.1-rc.2 | offline | `commands.test.ts` |
| `/stop` while streaming | 0.1.1-rc.2 | offline | `stop.test.ts` + session-contract（aborted turn 交付截断前缀） |
| unknown slash | 0.1.1-rc.2 | offline | `commands.test.ts` / bridge（reject，不进 LLM） |
| `/model` | 0.1.1-rc.2 | offline | `commands-model.test.ts`、`commands-help-status-models.test.ts` |
| reasoning effort | 0.1.1-rc.2 | offline | `commands-model.test.ts`（effort 解析与透传） |
| `ask_user_question` | 0.1.1-rc.2 | offline | `question-presenter/-apiproxy-backend/-direct-backend.test.ts` |
| question multi select | 0.1.1-rc.2 | offline | `question-presenter.test.ts`（multi-select 只提交最新集合） |
| question custom answer | 0.1.1-rc.2 | offline | `question-presenter.test.ts`（批量问题含自定义文本答案） |
| plan-review intent | 0.1.1-rc.2 | offline | `question-presenter.test.ts`（intent/detail/header 透传，approve 主按钮） |
| image → vision model | 0.1.1-rc.2 | offline（投影语义） | `image-pipeline.test.ts`（saveImage 落 ImageBlock，agent/pre-step 零改写）；真实视觉模型效果属 live |
| image → text-only model | 0.1.1-rc.2 | offline（投影语义） | 同上（确定性占位由官方 request projection 决定） |
| DeepSeek Files path | 0.1.1-rc.2 | offline + live | 离线：附件转换与官方 pipeline 测试；真实 DeepSeek Files 上传链路需 live（真实模型账号） |
| attachment fallback | 0.1.1-rc.2 | offline | `message-converter-file.test.ts`（无 hook / hook 失败降级占位） |
| streamed reply | 0.1.1-rc.2 | offline | `reply-router-edit.test.ts`（delta 节流 / turn/end 冲洗） |
| buffered reply | 0.1.1-rc.2 | offline | `reply-router-edit.test.ts`（无 createReply 时降级 buffered） |
| edit reply | 0.1.1-rc.2 | offline | `reply-router-edit.test.ts`（edit 模式累积替换）+ Telegram `render.test.ts` |
| Web plugin boot | 0.1.1-rc.2 | live | `pnpm web:debug` 或 clean profile 启动（`docs/release.md` 手动验证步骤）；离线仅 `client-registration` / bundle 测试 |
| Settings → Channels | 0.1.1-rc.2 | live | Web 面板配置/扫码/安全访问走查（同上） |

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
