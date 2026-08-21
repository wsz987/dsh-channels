# AGENTS.md — dsh-channels

> 本文件会被 DeepSeek Harness 的 `dsh-agent-instructions` 插件自动加载（`AGENTS.md` / `CLAUDE.md` 候选，从项目根到会话 cwd 逐级生效），作为在本仓库工作的 agent 的持久指引。它不覆盖 system / developer / 用户直接指令，只是帮助你更快定位答案。

## 1. 项目定位

这是 DeepSeek Harness 的即时通讯渠道插件（**社区项目，非官方**）：微信 / QQ / 钉钉 / 飞书 / Telegram，通过统一的 `ctx.channels` API 收发消息。仓库即 `dsh-channels`。

处理任何「本项目」的问题前，先读：

- `README.md` —— 安装、渠道配置与登录、渠道总览、开发命令、文档索引（最全入口）。
- `apps/example/minimal-profile/` —— 各渠道 patch 的完整示例；回答配置字段问题以它和 `README.md` 为准，**不要凭空编造字段**。

文档目录（按需加载，顶部 front-matter 标注了 `when_to_use` / `authoritative`）：

| 文档 | 何时读 |
| --- | --- |
| `docs/architecture.md` | 理解整体架构、判断依赖方向、核对架构红线（红线权威） |
| `docs/architecture/common-design.md` | 改 `channel-core` / `channel-harness` / `channel-control` / `channel-web` / `channel-files` 代码前（Contract/Bridge/控制面/Bundle 权威） |
| `docs/architecture/channel-roadmap.md` | 评估新渠道 / 扩展方向 / Channel-vs-Tool 边界 |
| `docs/adapter-authoring.md` | 新增第三方适配器、写 manifest、跑 `pnpm verify` |
| `docs/release.md` | 发版 / changeset / release gate（版本与发布权威） |
| `docs/weixin-live-verification-runbook.md` | 执行 Weixin live gate、填 manifest 真实值 |
| `docs/architecture/adr/` | 架构决策记录（上游边界、图片模型降级） |
| `.agents/skills/dsh-channels-verification/SKILL.md` | 核验渠道实现 / SDK / 官方接口 / 权限 / manifest / 上游版本漂移时使用 |

> **硬规则**：当任务涉及以下内容时，**必须**加载 `.agents/skills/dsh-channels-verification/SKILL.md`：
>
> - 核验 QQ / 微信 / 钉钉 / 飞书 / Telegram 实现
> - 修改渠道 SDK / API / 权限
> - 修改 manifest / testedVersion / upstream
> - 检查平台权限、事件订阅、Gateway intents
> - 判断 channel-web 权限展示是否与真实平台能力一致
>
> 这样即使某些 Agent 的 Skill 自动发现机制偶尔不工作，AGENTS.md 仍然会兜底要求它读取该 Skill。

### 入站访问控制

涉及以下内容时：

- inbound / `message.received`
- sender / conversation identity
- owner / owner claim
- dmPolicy / groupPolicy / allowFrom / requireMention
- interaction security

必须先阅读：

1. `docs/security/inbound-access-control.md`
2. `docs/security/channel-identity-map.md`
3. `docs/architecture.md`（涉及依赖/职责变化时）

Adapter 不得自行定义不同于 `channel-harness` 的 ACL 语义；外部主体必须先授权，再产生本地副作用（架构红线 13）。

包结构（`packages/`）：

| 包 | 职责 |
| --- | --- |
| `channels` | 对外 bundle（`@wsz987/dsh-channels`） |
| `channel-core` | Channel Contract / `defineChannelAdapter` |
| `channel-harness` | 渠道 ↔ Harness 桥 |
| `channel-files` | 可选通用文件扩展（存储 / 解析 / `read_channel_attachment`） |
| `channel-weixin` / `-qq` / `-dingtalk` / `-lark` / `-telegram` | 五个内置渠道适配器（Telegram：Bot API 长轮询 + edit streaming + getFile 下载） |
| `channel-compat` / `-testkit` / `-verify` / `-web` | 校验 / 测试 / 契约验证 / Web 可视化 |

常用命令：`pnpm build`、`pnpm typecheck`、`pnpm test`、`pnpm channels`、`pnpm channels:clean`、`pnpm verify <dir>`、`pnpm doctor`、`pnpm check:fixtures`、`pnpm check:manifests`、`pnpm check:upstream`（含 dsh-* 基线 `check:harness-compat`；`check:harness-newer` 为非阻塞提示，基线事实来源是 `scripts/check-upstream.mjs` 的 `HARNESS_TESTED_VERSION`）。

## 2. DeepSeek Harness 怎么排查（本体问题）

Harness 本体是**闭源但可读的发布产物**：源码随 npm 包以 `lib/` 分发（带完整 JSDoc），包内 `README.md` / `README.zh.md` 双语。绝大多数「它到底怎么工作」都能在本机读源码得到答案。

排查顺序：

1. **定版本**：`dsh --version`（报告问题必须带版本号）。
2. **读安装后的源码**：`node_modules/@deepseek-ai/*`。从包名猜实现位置，例如 `dsh-workspace`（工作区/归档）、`dsh-session-persistence-jsonl`（会话落盘）、`dsh-storage-json`（JSON 存储）、`dsh-host-apiproxy`（RPC API 契约）、`dsh-client-ui-*`（前端）、`dsh-web-app`（web bundle）。每个包的 `package.json` 有 `repository.directory` 指向 monorepo 目录，`README.md` 常引用仓库相对路径。
3. **排配置**：`dsh --help`（启动器 flag）、`dsh web --help`（web 应用 flag）、`dsh --profile web --dump-config`（合并后完整配置，含用户层与 `--patch`）、`--dump-default-config`（仅 bundle 层）。配置层优先级：各 bundle patch → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`；patch 是**整体替换**目标行 config，不是合并。
4. **查数据目录** `~/.dsh`（`$DSH_HOME` 可覆盖；Windows 下 `%USERPROFILE%\.dsh`）：

| 路径 | 内容 |
| --- | --- |
| `sessions/<encoded-cwd>/<id>/session.jsonl.zstd` | 会话日志（zstd） |
| `storages/workspace.json` | 工作区注册表 + **归档集合 `global.archivedSessionIds`** |
| `storages/session_projcache.json` | 会话投影缓存 |
| `settings.yaml` | 用户设置（热加载） |
| `.credentials.yaml` | 受管凭据（脱敏查看） |
| `profiles/<name>/` | 各 profile 的 `package.json`、`cordis.patch.yml` |
| `.anonymous-user-id` | 匿名用户 id |

常见定位：

- 会话在侧边栏「消失」 → `storages/workspace.json` 的 `archivedSessionIds`（当前 rc 版归档单向，删掉对应 id 并重启即恢复，日志未删）。
- 插件没生效 → `--dump-config` 里有没有对应行 id；bundle 是否进了 `dsh.profile.bundles`。
- 凭据/key 不生效 → `settings.yaml` 的 `llm-*:` 段 + `.credentials.yaml`。
- 启动即退出 → 完整报错 + `--dump-config`；launcher flag 必须在应用参数之前。

## 3. 官方文档与源码链接

DeepSeek Harness 官方文档站点（**优先查这里**）：

- 站点根：<https://deepseek-harness.github.io/deepseek-harness/>
- **Reference（CLI / 配置 / flag 参考）**：<https://deepseek-harness.github.io/deepseek-harness/reference/>
- **Develop → Basic（开发基础，含 AGENTS.md 编写约定等）**：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/>

源码与仓库：

- 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- CLI 包（npm）：<https://www.npmjs.com/package/@deepseek-ai/dsh>
- 本项目仓库 / issue：<https://github.com/wsz987/dsh-channels>

> 小技巧：任意 `@deepseek-ai/<pkg>/package.json` 的 `repository.url` + `repository.directory` + 包内 README 引用的相对路径（如 `reference/README.md`、`src/args.ts`）三者合起来，即可定位到官方源码/文档的确切位置。

各渠道上游 SDK：微信 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)、QQ [tencent-connect/bot-node-sdk](https://github.com/tencent-connect/bot-node-sdk)、钉钉 [open-dingtalk/dingtalk-stream-sdk-nodejs](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)、飞书 [larksuite/node-sdk](https://github.com/larksuite/node-sdk)；Telegram 直连 [Bot API](https://core.telegram.org/bots/api) 协议（无 SDK）。

## 4. 报告 / 提问时的最小信息

判断「是本项目问题还是 Harness 本体问题」后再给结论；拿不准就先按上文排查，不要臆断。需要用户补信息时，至少索要：

- `node --version`、`pnpm --version`、`dsh --version`
- `npx @deepseek-ai/dsh --profile web --dump-config` 的相关段落（**密钥脱敏**）
- 完整报错原文 + 复现步骤（做了什么 / 期望 / 实际）


## 5. 项目代码规范（硬约束）

### 5.1 架构红线（违反即架构退化，详见 `docs/architecture.md`）

1. **依赖方向只允许**：`adapter → channel-core`；`upstream driver → SDK/package/protocol`；`channel-harness → channel-core + Harness public API`；`bundle → 仅插件配置`。禁止反向。
2. **Agent/Session API 只允许在 `channel-harness`**：`channel-core`、`channel-control`、`channel-files`、各适配器、`channel-web`、`channel-testkit` 禁止 `import`/访问 `ctx.agents`、`dsh-agent`、`dsh-session`。
3. **Core 禁止渠道特判**：不允许 `if (channel === 'weixin')`，用 `adapter.capabilities` 协商。
4. **结构化内容**：平台 raw payload 必须映射为 `MessagePart` 再进模型；禁止 raw 直塞或压成 `text: string`。`event.raw` 只作调试。
5. **禁止 OpenClaw Runtime 兼容层**：上游 OpenClaw 渠道仓库仅作 SDK/协议/行为参考，运行时不依赖。
6. **上游版本治理**：禁止 `latest` + 未测试自动部署；manifest 固定 `testedVersion`/`versionRange`，升级走 Renovate → typecheck → contract → fixtures → 更新 `testedVersion`。
7. **依赖归属**：root 不安装各渠道 SDK；平台 SDK 归属对应 adapter；`unpdf`/`mammoth`/`xlsx` 只允许在 `channel-files`。
8. **AgentHandle ownership**：`ctx.agents.create()/resume()` 返回的 `AgentHandle` 必须由 `channel-harness` 持有（`Map<SessionId, AgentHandle>`），禁止丢弃。
9. **会话绑定**：按 `channel:account:conversation[:thread]` 绑定；禁止「一个渠道账号 = 一个 Harness Session」。
10. **凭据与 DTO**：浏览器只允许 `PublicAuthSession` 等净化 DTO；Secret/token/deviceCode 永不出进程。
11. **持久化边界**：适配器禁止读写 Harness persistence；SessionBinding 持久化只由 `channel-harness` 的 store 接口负责。
12. **只用 Harness public package API**：禁止 private/internal source；Harness breaking change 优先只改 `channel-harness`。
13. **外部主体必须授权才能产生本地副作用**：任何能触发 Agent / Command / Session / Binding / Workspace / Interaction 或其他本地特权行为的外部入站事件，必须先过 `channel-harness` 的统一 Access Gate（缺失/损坏 policy、未知 sender/group 一律 Fail-Closed）；Adapter 只产出 canonical identity 与 activation facts，不得实现渠道私有 ACL。`requireMention` 是 Activation，不是 Authorization。详见 `docs/security/inbound-access-control.md` 与 `docs/security/channel-identity-map.md`。

### 5.2 官方 Harness 约束

完整清单见 `docs/architecture/common-design.md`「Harness 集成约束（速查）」——覆盖：DSH Bundle / patch 整体替换 / Cordis 插件形态 / inject 名称 / 命令 / Agent 输入语义 / session-event 回复 / 配置与凭据。写共享代码前按需加载。

### 5.2.1 入站日志与媒体诊断

- 每个适配器必须在完成 mapper + media hydration、调用 `ctx.emit(event)` **之前**记录一条 `info` 入站摘要；不得只记录文本而省略附件。
- `connection.changed` / `auth.changed` 是控制面状态事件，由 `channel-control` / `channel-web` 消费；`channel-harness` bridge 必须静默忽略，不得打印成 `ignoring channel event`。未知的未来事件才进入 bridge debug 日志。
- 入站摘要必须使用适配器专属 logger namespace：`channel-<name>`，并包含稳定的 message/conversation 标识和 `parts` 摘要。
- `image` 摘要至少包含 `resourceRef`、`mimeType`、`localDataBytes`、`ingressFailure`；`file` 摘要至少包含 `name`、`mimeType`、`size`、`localDataBytes`、`ingressFailure`。严禁打印 token、签名 URL、文件正文或完整 raw payload。
- 新增或更名 logger namespace 时，必须同步更新 `packages/channel-harness/src/debug-logger.ts` 的 `DSH_CHANNELS_DEBUG=1` exporter 白名单，并添加回归测试；否则 `pnpm web:debug` 中不会显示该渠道日志。
- `localDataBytes` 缺失时，模型侧出现 `[image]` / `[file]` 属于媒体未完成 hydration 或附件保存失败，先根据上述摘要定位，不得用增加文本占位符掩盖失败。

### 5.2.2 命令面与作用域上下文（易错点）

命令 handler **禁止**从 `invocation.agent.ctx` 读 Harness 服务（`commands` / `llm`，会抛
`cannot get property "X" without inject`）；服务访问一律走 `deps` 窄能力注入（`/new` 模式）
或 `ctx.get()` 探测。完整规范、示例与测试写法见
[`docs/architecture/common-design.md`「命令面：服务访问规范」](docs/architecture/common-design.md#command-plane-service-access)。

### 5.3 验证与提交

- 适配器必须过 `runChannelAdapterContract` + `pnpm verify <adapter> --test`。
- 提交前跑 `pnpm ci:check`（build / typecheck / test / verify Telegram+Weixin / check:fixtures / check:manifests / doctor / check:bundle）。
- Commit：Conventional Commits（`feat(scope):` / `fix(scope):` / `docs:`），scope 用包名（如 `channel-qq`）。
- 新增渠道四步：复制 `templates/channel-adapter` → `packages/channels/cordis.patch.yml` 加行 → `pnpm build && pnpm typecheck && pnpm test` → `pnpm verify packages/channel-<name> --test`。
- 契约表达不了的需求上报 contract gap，禁止改 `channel-core` / `channel-harness`。
- 运行环境：Node ≥ 22、pnpm 9.15.3、ESM（`"type": "module"`）。

### 5.4 校验与类型安全（zod / Schemastery）

- **所有外部或不可信输入必须使用 zod `safeParse` 校验**：包括第三方 SDK 回调、HTTP/WebSocket 响应、解析后的 JSON、fixture，以及插件导出的未知对象。生产代码在信任边界处禁止使用手写 cast 或 `as` 断言绕过校验；校验成功后只使用解析结果。
- **契约边界复用统一 schema**：Adapter shape、capabilities、event envelope 等必须复用 `channel-core/src/schema.ts` 中的 schema。`defineChannelAdapter`、`isChannelAdapter` 和 `channel-verify` 应保持同一契约形状，不得各自维护不一致的校验逻辑。
- **上游驱动负责校验上游 payload**：各 adapter 的 upstream 层必须对 SDK/API 返回值和入站回调 payload 使用 zod `safeParse`。校验失败应转换为明确的渠道错误，不得把未经校验的 `unknown` 继续传入 adapter 或 core。参考 `channel-telegram/src/upstream.ts`、`channel-dingtalk/src/official-upstream.ts`、`channel-lark/src/openapi-outbound.ts`。
- **配置 Schema 用 Schemastery（`@deepseek-ai/schemastery`），不是 zod**：配置是 Cordis 插件形态，用官方 Schema DSL；Schemastery 负责配置解析、默认值和配置语义，zod 不承担配置 schema 职责（参考 `channel-telegram/src/config.ts`）。
- **zod 版本统一 `^4.4.3`**（workspace 各包一致）；zod 只做运行时校验，不承担序列化、持久化或配置转换。
- **简单标量守卫允许手写**：例如 `definition.ts` 中对单个字段的 `typeof` 检查；但跨信任边界的结构化 payload 必须使用 zod schema。
- **测试代码可以使用必要的类型断言构造 fake 或断言结果**，但不得以此替代生产代码中的运行时校验。