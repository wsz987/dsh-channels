---
title: 兼容矩阵
summary: dsh-channels 版本线 × DeepSeek Harness × Node 的兼容关系、发布必测场景与渠道 smoke 清单。
when_to_use: 升级 | 发版 | 兼容性 | Harness 版本 | Node 版本 | smoke 清单
authoritative: 版本线兼容矩阵、发布必测场景的覆盖状态。
see_also: [release.md, architecture.md]
status: as-built
---

# Compatibility Matrix（版本线兼容矩阵）

本仓库按**版本线**声明兼容性：每条 dsh-channels 版本线只对应一个 DeepSeek Harness
基线，**不做跨版本线运行时双兼容**。升级前请先确认你的 Harness 版本。

## 1. 版本线矩阵

| dsh-channels | DeepSeek Harness | Node | 状态 |
| --- | --- | --- | --- |
| **0.5.1（当前）** | **`0.1.5-rc.2`**（精确 pin） | `^22.19.0 \|\| >=24.0.0` | 推荐使用 |
| 0.5.0 | `0.1.1-rc.2`（精确 pin） | `^22.19.0 \|\| >=24.0.0` | 已被 0.5.1 取代，请勿新装 |
| 0.4.x（0.4.2） | `^0.1.0-rc.7` | `>=22` | 维护线，仅关键修复 |

- **不要跳过 0.5.0 直接理解成"更旧就更稳"**：0.5.0 绑定的是中间态 Harness `0.1.1-rc.2`，
  且 peer 含已退役的 `@deepseek-ai/dsh-host-apiproxy`，在 `0.1.5-rc.2` 上**无法启动**。
  升级路径是 `0.4.2 → 0.5.1`（或 `0.5.0 → 0.5.1`）。
- 版本推进是**单向**的：`0.1.5-rc.2` 满足 `^0.1.5-alpha.2`，反之不成立。降级 Harness
  必须同时降级 bundle。

## 2. Node 矩阵

| Node | 0.4.x | 0.5.x | 说明 |
| --- | --- | --- | --- |
| 22.x < 22.19 | 支持 | 不支持 | 0.5.x 要求 Node 22.19+ |
| 22.19.x | 支持 | 支持 | CI 核验线 |
| 24.x | 支持 | 支持 | CI 只跑 Node 22，24.x 发版前手动 smoke |

## 3. 0.5.x 发布必测场景

覆盖状态：`offline` = 离线测试套件已覆盖（`pnpm ci:check` 全绿）；
`live` = 需要真实环境（clean profile / 真实渠道 / 真实模型账号），发版前手动执行。

| 场景 | 覆盖 | 位置 / 方式 |
| --- | --- | --- |
| Harness 基线统一 | offline | `pnpm check:harness-compat`（workspace 精确 pin + registry 存在性） |
| Node 引擎 | offline | root `engines` + CI Node 22 leg |
| Node 24.x | live | 发版前手动 smoke（当前无 CI matrix leg） |
| Fresh Session | offline | `harness-compat.test.ts`（create 路由/preset） |
| Persisted Resume | offline | `reply-router-session-contract.test.ts`、`binding-v3.test.ts` |
| Missing persisted binding | offline | `binding-v3.test.ts`（无映射返回 undefined / 迁移链） |
| `/new` | offline | `commands.test.ts` |
| `/stop` while streaming | offline | `stop.test.ts` + session-contract（交付截断前缀） |
| unknown slash | offline | `commands.test.ts` / bridge（reject，不进 LLM） |
| `/model` | offline | `commands-model.test.ts`、`commands-help-status-models.test.ts` |
| reasoning effort | offline | `commands-model.test.ts`（effort 解析与透传） |
| `/model` host 通道 | offline | `commands-model.test.ts`（host 模式走 `sessionController.selectModel`） |
| `ask_user_question` | offline | `question-presenter/-waterfall-backend.test.ts`；渠道矩阵见下 |
| question waterfall 委托/中止 | offline | `question-waterfall-backend.test.ts`（`ask()` 分发、decline → `next()` → `NO_PROVIDER`、abort/cancel/stop） |
| question answerer 顺序（web profile） | offline | `question-waterfall-backend.test.ts`（渠道 `prepend` answerer 仍须拿到问题） |
| question multi select / custom / plan-review | offline | `question-presenter.test.ts` |
| image → vision / text-only model | offline（投影语义） | `image-pipeline.test.ts`；真实视觉模型效果属 live |
| DeepSeek Files path | offline + live | 离线附件转换；真实上传链路需 live |
| attachment fallback | offline | `message-converter-file.test.ts`（无 hook / hook 失败降级占位） |
| 可选 seam 惰性解析 | offline | `file-provider-compat.test.ts`（provider 后挂载仍可见） |
| streamed / buffered / edit reply | offline | `reply-router-edit.test.ts` + Telegram `render.test.ts` |
| V3 persistence | offline | `persistence-compat.test.ts`（V3 list/open/read/close 与单向升级读取） |
| web turn 镜像（opt-in） | offline | `mirror.test.ts`（无 ReplyContext 的 turn 仅在 `mirror: true` 时缓冲送达） |
| `/mirror` / `/bind` | offline | `mirror-bind-commands.test.ts`（fail-closed 解析、冲突拒绝、两步确认） |
| 图片出站解析 | offline | `channel-files/test/image-mirror.test.ts` + `image-pipeline.test.ts`；真实渠道上传链路属 live |
| Web plugin boot | live ✅ | 隔离 `DSH_HOME` 真机启动：9 行插件全部落地、控制面 API 注册、客户端 bundle 可取回 |
| Settings → Channels | live（交互待人工走查） | 服务端链路已验证；浏览器内面板渲染/扫码/安全访问仍属人工走查 |

`ask_user_question` 渠道矩阵：

```text
Telegram : actions + text（原生按钮 + 文字回答）
Weixin   : text（编号文字回复）
QQ       : actions + text（QQ Markdown keyboard + @机器人编号文字回答）
DingTalk : text（默认；interactiveActions 需显式配置本组织已发布的卡片模板）
Lark     : actions + text（原生卡片按钮 callback + 编号文字回答）
```

所有内置渠道 `text: true` 均可完成 `ask_user_question`；`interactiveActions: true`
（Telegram / QQ / Lark；DingTalk 需显式配置卡片模板）优先显示原生按钮，其余自动降级为
编号文字回复。**声明的按钮能力若在真实平台不可用（卡片模板未发布、缺权限），
`channel-harness` 会把该批问题降级为编号文字并重新发送，而不是取消问题。**

## 4. 渠道 smoke 清单（live，发版前）

每个渠道至少一轮真实往返（收文本 → Agent 回复 → 发文本），加渠道特有项：

| 渠道 | 基础 smoke | 渠道特有项 | 现状 |
| --- | --- | --- | --- |
| Telegram | 文本往返 | 图片/文件收发、edit streaming、callback 按钮 | manifest `experimental`，live gate 未跑 |
| Weixin | 文本往返 | 扫码登录、凭据持久化重启、图片收发 | 见 `docs/weixin-live-verification-runbook.md` |
| QQ | 文本往返 | 私聊（创建者）、群聊 @、图片/文件、流式 | offline fixtures 全绿 |
| DingTalk | 文本往返 | 扫码或应用凭据、流式（SDK 模式） | offline fixtures 全绿 |
| Lark | 文本往返 | 事件订阅、图片/文件、主动外发 | offline fixtures 全绿 |

Live 渠道 smoke 不放在普通 PR CI；微信走 `live-weixin.yml`（`workflow_dispatch` + secret 门控）。

> 各渠道 `manifest.testedVersion` 是**上游平台/SDK 版本**（如 `1.0.4` / `2.1.5` /
> `1.73.1` / `10.2`），不是 Harness 版本；Harness 基线单独由 `HARNESS_TESTED_VERSION` 治理。

## 5. 门禁与命令映射

| 命令 | 阻塞 | 作用 |
| --- | --- | --- |
| `pnpm check:upstream` | 是 | channel SDK 精确 pin + dsh-* 基线统一 + 非 dsh `@deepseek-ai/*` npm latest drift |
| `pnpm check:harness-compat` | 是 | 仅 dsh-* 基线（workspace 全部精确 `HARNESS_TESTED_VERSION` + registry 发布该版本） |
| `pnpm check:harness-newer` | 否（exit 0） | 报告高于基线的已发布 dsh-* 版本，提示启动升级流程 |
| `pnpm ci:check` | 是 | 本地全门禁（build/typecheck/test/verify/fixtures/manifests/harness-compat/doctor/bundle） |
| `upgrade.yml`（每周） | 是 | `check:upstream` + `check:harness-newer` + fixtures/manifests/doctor |

Harness 基线升级流程（AGENTS.md 红线 6）：Renovate PR → typecheck → contract → fixtures →
adapter tests → 全绿后把 `HARNESS_TESTED_VERSION` 与 workspace 所有 dsh-* pin 一起更新。
