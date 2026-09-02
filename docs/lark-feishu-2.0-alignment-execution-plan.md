---
title: 飞书官方 SDK 与 Card JSON 2.0 全面对齐执行方案
summary: 移除飞书适配器旧 gateway、旧卡片和旧凭据兼容路径，统一到官方 Node SDK、OpenAPI 与 CardKit 2.0。
when_to_use: 飞书适配器升级、旧接口清理、Card JSON 2.0 迁移、发布前核验
authoritative: 当前仓库实现、@larksuiteoapi/node-sdk 官方包类型/实现、飞书开放平台官方文档
status: implemented-with-live-gate-pending
---

# 飞书官方 SDK 与 Card JSON 2.0 全面对齐执行方案

## 1. 目标与边界

本方案针对 `packages/channel-lark`，目标是形成**单一的官方 2.0 实现**：

- 入站只使用 `@larksuiteoapi/node-sdk` 的 `WSClient + EventDispatcher`。
- 出站只使用同一官方 SDK 的 OpenAPI Client。
- 普通消息继续使用 `im.v1.message.create`。
- 图片/文件继续使用官方上传接口，再发送 `image_key` / `file_key`。
- 交互卡片只使用 Card JSON 2.0；按钮使用 2.0 的 `behaviors[].value`。
- 流式回复迁移到 CardKit 原生流式接口：创建卡片实体、发送卡片引用、调用
  `cardkit.v1.cardElement.content`，结束时调用 `cardkit.v1.card.settings` 关闭
  `streaming_mode`。
- 不提供旧 gateway、旧卡片、旧 plaintext secret 的运行时兼容。

本方案**不**把“离线测试通过”当成平台权限或真实消息收发已通过。权限、事件订阅、应用发布和真实账号行为仍需 live gate。

## 2. 核验快照

| 项目 | 结果 | 级别 |
| --- | --- | --- |
| DSH HEAD | `d0df3dcfb20942056adb7be9e92cf36ef9b69ce7`，2026-09-01 | `CODE-CONFIRMED` |
| Skill 快照 | `78655a40a266c4122ecd0c030b0a882fdb92f2df`，2026-08-19 | `DRIFT`（仓库已前进） |
| 官方 SDK npm latest | `@larksuiteoapi/node-sdk@1.73.1`，2026-09-01 发布 | `OFFICIAL-CONFIRMED` |
| 官方 SDK Git HEAD | `larksuite/node-sdk` main = `37d241ee28e6792f3ad500e35384d5d08d40dc7b` | `OFFICIAL-CONFIRMED` |
| 当前 manifest | SDK `1.73.1`，`versionRange: 1.73.1`，status `tested` | `CODE-CONFIRMED` |
| 真实 Feishu 应用验证 | 本次未执行 | `LIVE-REQUIRED` |

## 3. 当前实现事实

本轮已完成代码收敛与离线契约核验。下文差异表保留为审计记录；列出的删除项已落实，
剩余未完成项仅限真实飞书租户 live gate。

### 3.0 实施核验结果（2026-09-02）

| 核验项 | 结果 | 级别 |
| --- | --- | --- |
| 官方 SDK 单一路径 | WS 入站与 OpenAPI 出站均为 `@larksuiteoapi/node-sdk@1.73.1` | `CODE-CONFIRMED` |
| CardKit 生命周期 | `card.create` → card reference → `cardElement.content` → `card.settings` | `CODE-CONFIRMED` |
| rollover 正确性 | 完整累计文本与当前卡片内容分离；覆盖追加、累计更新和多次 rollover | `CODE-CONFIRMED` |
| 终态一致性 | close 成功后才进入 finished；失败内容写入失败仍独立尝试 close | `CODE-CONFIRMED` |
| OpenAPI 响应 | 标准 envelope 统一校验且 `code !== 0` 直接失败 | `CODE-CONFIRMED` |
| 旧配置兼容 | plaintext `upstream.appSecret` 不再属于 schema；无运行时迁移 | `CODE-CONFIRMED` |
| 离线验证 | channel-lark typecheck、15 test files / 179 passed（1 skipped） | `CODE-CONFIRMED` |
| 真实租户 | L1-L5 尚未执行 | `LIVE-REQUIRED` |

### 3.1 已经对齐的部分

- `src/lark-sdk-upstream.ts` 已注册 `im.message.receive_v1` 和 `card.action.trigger`。
- `src/openapi-outbound.ts` 已使用 `im.v1.message.create`、`im.v1.message.patch`、
  `im.v1.image.create`、`im.v1.file.create`。
- `cardContent()` 和 `interactiveCardContent()` 已输出 `schema: "2.0"`、
  `body.elements[].tag: "markdown"`，按钮回调已使用 `behaviors`。
- `src/upstream/media-port.ts` 已通过 `im.v1.messageResource.get` 处理图片、文件、音频和视频入站资源。
- `src/adapter.ts` 已声明文本、图片、文件、音频、卡片、反应、线程和 `edit` streaming capability。
- `src/definition.ts` 的 secret 已通过 `ctx.credentials` seam 解析，Web 只展示净化后的 configured state。

### 3.2 与“只保留 2.0”冲突的部分（已处理）

以下内容仍是生产代码或公开导出的一部分，必须删除，而不是继续维护：

| 位置 | 现状 | 处理 |
| --- | --- | --- |
| `src/config.ts` | `upstream.mode: 'sdk' | 'gateway'`，默认仍允许 gateway | 删除 `gateway`，配置只允许 `sdk` |
| `src/adapter.ts` | 仅保留官方 SDK upstream | 已完成；无 gateway 分支或 transport 注入 |
| `src/upstream.ts` | 仅保留平台无关的 SDK upstream contract | 已完成；无旧 HTTP endpoint |
| `src/index.ts` | 仅导出官方 SDK 实现 | 已完成；无旧导出或迁移函数 |
| `src/definition.ts` | gateway 模式视为 configured；支持 hidden plaintext secret | 删除 gateway 逻辑和 migration-only 分支 |
| `src/config.ts` | `upstream.appSecret` hidden 字段 | 删除字段；新配置遇到该字段应 fail closed 或由发布前迁移脚本显式处理 |
| `baseUrl` / `longPollTimeoutMs` | 仅服务旧 HTTP gateway | 删除配置和默认值 |
| `src/openapi-outbound.ts` | 官方 OpenAPI + CardKit 2.0 | 已完成；标准 envelope 统一校验 |
| `src/card.ts` | CardKit sequence/uuid/element_id、双状态 rollover、可重试终态 | 已完成；按官方 SDK 状态机实现 |
| `src/mapper.ts`、测试注释 | “gateway raw shape”“legacy gateway”作为主语 | 改成 SDK event canonical shape，避免旧协议成为内部契约 |
| `test/**` | 多个 suite 直接验证 fake gateway 和旧 endpoint | 删除 gateway suite，改成官方 SDK fake client + CardKit contract suite |

## 4. 官方 2.0 事实

以下结论来自官方 `@larksuiteoapi/node-sdk@1.73.1` 的类型声明、README 和打包实现，以及飞书开放平台文档。

### 4.1 官方消息和卡片接口

| 能力 | 官方接口 | 2.0 要求 |
| --- | --- | --- |
| 文本 | `client.im.v1.message.create` | `msg_type: "text"`，`content: JSON.stringify({ text })` |
| 图片 | `client.im.v1.image.create` → `client.im.v1.message.create` | 上传后发送 `image_key` |
| 文件 | `client.im.v1.file.create` → `client.im.v1.message.create` | 上传后发送 `file_key` |
| 普通卡片发送 | `client.im.v1.message.create` | `msg_type: "interactive"`，内容为卡片 JSON |
| 已发送卡片改写 | `client.im.v1.message.patch` | 只更新消息卡片 content |
| 卡片实体创建 | `client.cardkit.v1.card.create` | 只接受 Card JSON 2.0；返回 `card_id` |
| 卡片实体发送 | `im.v1.message.create` | `msg_type: "interactive"`，content 为 `{ type: "card", data: { card_id } }` |
| 卡片全量更新 | `cardkit.v1.card.update` | 只接受 Card JSON 2.0，要求单调 `sequence` |
| 卡片局部更新 | `cardkit.v1.card.batchUpdate` / `cardElement.*` | 只接受 Card JSON 2.0，要求单调 `sequence` |
| 文本流式更新 | `cardkit.v1.cardElement.content` | `streaming_mode: true`，指定 `card_id + element_id`，单调 `sequence` |
| 流式结束 | `cardkit.v1.card.settings` | 设置 `streaming_mode: false`，可更新 `summary` |

官方 SDK 类型明确注明：`cardkit.v1.card.idConvert` 已不推荐；新实现不得以“发送消息后再 idConvert”作为主路径。

### 4.2 Card JSON 2.0 结构

流式卡片的最低结构应包含稳定的 markdown element id，并开启原生流式模式：

```json
{
  "schema": "2.0",
  "config": {
    "streaming_mode": true,
    "summary": { "content": "[Generating...]" },
    "streaming_config": {
      "print_frequency_ms": { "default": 70 },
      "print_step": { "default": 1 },
      "print_strategy": "fast"
    }
  },
  "body": {
    "elements": [
      {
        "tag": "markdown",
        "element_id": "stream_md",
        "content": ""
      }
    ]
  }
}
```

交互按钮必须采用 Card JSON 2.0 结构。旧的 `tag: "action"` 容器和 `lark_md` 不得再输出：

```json
{
  "tag": "button",
  "text": { "tag": "plain_text", "content": "选择" },
  "type": "primary",
  "behaviors": [
    { "type": "callback", "value": { "actionId": "question:option:1" } }
  ]
}
```

### 4.3 CardKit 生命周期约束

- 卡片实体创建接口只接受 Card JSON 2.0；卡片实体有效期为 14 天。
- 一个卡片实体只发送一次；需要继续生成时应创建新的实体并发送新的卡片引用。
- 每个卡片的 `sequence` 必须单调递增；请求应使用稳定 `uuid` 做幂等。
- `cardElement.content` 是官方“打字机”流式接口；它要求卡片已开启 `streaming_mode`。
- 官方 SDK 的 high-level `Channel` 已采用 30,000 字符的单元素保护阈值；适配器应在达到阈值前 rollover，不能等待服务端报错。
- 结束时必须关闭 `streaming_mode` 并更新摘要，否则会话预览可能继续显示生成中状态。

## 5. 目标架构

```text
Feishu WSClient
  └─ EventDispatcher
      ├─ im.message.receive_v1
      └─ card.action.trigger

Feishu OpenAPI Client
  ├─ im.v1.message.create / patch
  ├─ im.v1.image.create
  ├─ im.v1.file.create
  ├─ im.v1.messageResource.get
  ├─ im.v1.chat.get
  ├─ im.v1.messageReaction.*
  └─ cardkit.v1.card.create / settings / update / batchUpdate / cardElement.content

LarkAdapter
  ├─ SdkInboundMapper       # canonical event，不再称 gateway raw
  ├─ LarkOpenApiOutbound    # 普通消息、媒体、交互卡片
  └─ LarkCardReply          # CardKit 2.0 native streaming
```

目标架构中不存在 `HttpLarkUpstream`、`FetchTransport`、`baseUrl`、`longPollTimeoutMs` 或旧 gateway endpoint。

## 6. 分阶段执行

### 阶段 A：配置和依赖收敛

1. 将 `LarkUpstreamConfig.mode` 改为固定 `sdk`，移除 `gateway` union。
2. 删除 `baseUrl`、`longPollTimeoutMs` 及其默认值、文档和 fixtures。
3. 删除 `upstream.appSecret` hidden 字段、`migrateLegacyAppSecret()` 和对应测试。
4. 保留 `upstream.appId`、`upstream.appSecretRef`、`upstream.domain`；secret 继续只从 credentials seam 解析。
5. 保持 `@larksuiteoapi/node-sdk` 精确 pin；升级时先更新 manifest，再走离线和 live gate。

验收：旧 YAML 含 gateway 或 plaintext appSecret 时不会静默进入运行态；新配置只能构造 SDK adapter。

### 阶段 B：删除旧 upstream

1. 删除 `HttpLarkUpstream` 及所有 `/stream`、`/message/*`、`/card/*` gateway endpoint 代码。
2. 删除 Lark 专用 `FetchTransport` 和 `transport` 依赖注入；SDK fake 直接注入 WS/OpenAPI client。
3. 将 `LarkUpstream` 重命名为不携带历史协议含义的内部 contract（建议 `LarkSdkUpstream` 或拆成 inbound/outbound interfaces）。
4. 删除导出层中的旧类和旧 transport 类型。
5. 将“gateway raw shape”改为 canonical SDK event mapping；保留 zod trust-boundary 校验。

验收：`rg` 不再找到 `/message/send`、`/card/create`、`/card/update`、`/card/finish`、`/card/fail` 或 `HttpLarkUpstream` 的生产引用。

### 阶段 C：CardKit 2.0 原生流式

1. 扩展官方 OpenAPI structural client：
   - `cardkit.v1.card.create`
   - `cardkit.v1.card.settings`
   - `cardkit.v1.cardElement.content`
   - 必要时 `cardkit.v1.card.update` / `batchUpdate`
2. `createCard()` 改为：创建 Card JSON 2.0 实体 → `im.v1.message.create` 发送 `{ type: "card", data: { card_id } }` → 保存 `cardId/messageId/elementId/sequence`。
3. `append/replace` 改为调用 `cardElement.content`，每次递增 sequence，并生成稳定 uuid。
4. `finish()` 改为调用 `card.settings` 设置 `streaming_mode: false`，并写入最终 summary。
5. `fail()` 改为先把错误内容通过 `cardElement.content` 或 CardKit update 写入，再关闭 streaming mode；二次失败不能覆盖原始错误。
6. 加入 rollover：单个 markdown element 接近 30,000 字符时完成当前卡片并创建后续卡片，记录 `chunkIds`。
7. 保持 `card.createOnFirstDelta` 语义，但两种路径都必须使用 CardKit 实体；禁止回退到普通 `message.patch` 伪流式。

验收：测试能断言 CardKit 调用顺序、sequence 单调、uuid 稳定、结束关闭 streaming、rollover 和失败路径。

### 阶段 D：交互卡片和事件

1. 保留 Card JSON 2.0 的直接 button elements；删除所有 `tag: "action"`、`lark_md` 生成器和兼容分支。
2. `card.action.trigger` 只接受官方 SDK `normalizeCardAction()` 规范化结果；输入继续先过 zod。
3. `im.v1.chat.get` 失败时继续 fail-closed，不创建本地 interaction 副作用。
4. 交互卡片编辑统一走 `message.patch`（普通已发送消息卡片）或 CardKit update（卡片实体）；在 contract 中明确两者适用边界。

验收：fixture 中不存在旧卡片结构；交互回调能保留 `event_id`、`open_message_id`、`open_chat_id` 和 action value。

### 阶段 E：测试、文档和 manifest

1. 删除 gateway adapter、gateway streaming、旧 endpoint 和 plaintext migration 测试。
2. 新增官方 SDK contract tests：消息、媒体、卡片实体、原生流式、按钮回调、媒体资源下载。
3. 更新 `packages/channel-lark/README.md`、根 README、channel matrix 和 verification 文档。
4. manifest 继续精确固定 `1.73.1`；增加“offline-tested / live-tested”区分（若 manifest schema 暂不支持，至少在 README 和本方案中明确）。
5. 更新 `channel-web` 仅保留官方文档入口和 setup/auth metadata，不添加静态“权限已授权”状态。

## 7. 权限与事件矩阵

| 能力 | 代码调用 | 平台事实 | 状态 |
| --- | --- | --- | --- |
| P2P 入站 | `im.message.receive_v1` | `im:message.p2p_msg:readonly` + 机器人能力 | `OFFICIAL-CONFIRMED`，应用需 live 验证 |
| 群聊 @ 入站 | `im.message.receive_v1` | `im:message.group_at_msg:readonly` + 事件订阅 | `OFFICIAL-CONFIRMED`，应用需 live 验证 |
| 发送消息 | `im.v1.message.create` | `im:message:send_as_bot` | `OFFICIAL-CONFIRMED`，应用需 live 验证 |
| 事件接收 | WS `im.message.receive_v1` | 应用事件订阅已发布 | `LIVE-REQUIRED` |
| 按钮回调 | WS `card.action.trigger` | 卡片交互事件订阅、机器人能力 | `LIVE-REQUIRED` |
| 图片上传 | `im.v1.image.create` | 图片上传权限/机器人能力，图片 ≤10 MB 等平台限制 | `OFFICIAL-CONFIRMED` + `LIVE-REQUIRED` |
| 文件上传 | `im.v1.file.create` | 文件上传及发送消息权限 | `OFFICIAL-CONFIRMED` + `LIVE-REQUIRED` |
| 入站资源 | `im.v1.messageResource.get` | 资源读取权限，单资源上限以官方文档为准 | `OFFICIAL-CONFIRMED` + `LIVE-REQUIRED` |
| 卡片 patch | `im.v1.message.patch` | 更新应用发送的消息卡片权限 | `OFFICIAL-CONFIRMED` + `LIVE-REQUIRED` |
| CardKit 创建/更新/流式 | `cardkit.v1.*` | CardKit 对应权限，应用身份必须与创建者一致 | `OFFICIAL-CONFIRMED` + `LIVE-REQUIRED` |
| 会话类型确认 | `im.v1.chat.get` | 当前 chat 信息读取权限 | `LIVE-REQUIRED` |
| Typing reaction | message reaction add/remove | 机器人能力及 reaction 权限 | `LIVE-REQUIRED` |
| 非 @ 群消息 | 不由当前默认代码保证 | 需申请敏感的群组全部消息能力，并关闭/调整相应限制 | `LIVE-REQUIRED` |

应用权限或事件订阅变更后，必须创建并发布新版本；仅在开发配置页勾选不能作为发布依据。

## 8. Live gate

使用专用测试租户和测试群，不使用生产账号。每项记录：应用版本、租户、chat_id、message_id、时间、结果和平台错误码。

### Gate L1：连接与入站

- WS 首次握手成功，能收到 `im.message.receive_v1`。
- P2P 文本收到并进入 canonical mapper。
- 群聊 @ 文本收到；非 @ 文本按产品策略验证，不得默认宣称支持。
- 线程字段 `thread_id/root_id/parent_id` 映射正确。

### Gate L2：普通出站与媒体

- 文本发送成功并返回 `message_id`。
- 图片上传、图片消息发送、入站图片下载成功。
- 文件上传、文件消息发送、入站文件下载成功。
- 音频/视频入站资源可下载；出站仍按 capability 标记为 unsupported。

### Gate L3：Card JSON 2.0

- 新建卡片实体成功并返回 `card_id`。
- 发送 card reference 成功。
- `cardElement.content` 连续更新至少 20 次，sequence 无乱序。
- 结束后 `streaming_mode=false`，会话预览不再显示生成中。
- 触发 30,000 字符 rollover 后，后续卡片仍能继续生成。
- 错误路径最终可见且不泄露 secret/raw payload。

### Gate L4：交互与反应

- Card JSON 2.0 button 回调收到 `card.action.trigger`。
- callback value 中的 `actionId` 能通过统一 interaction gate。
- `im.v1.chat.get` 失败时 interaction 被丢弃且无本地副作用。
- Typing reaction add/remove 成功；权限不足时只产生可诊断错误，不阻断主回复。

### Gate L5：安全与运维

- 浏览器 DTO、配置文件、日志和错误消息不含 AppSecret/token/providerState。
- 重启后 credentials ref 仍能构造 SDK client。
- 同一消息的 WS 重连重复投递不会创建重复 Harness session。
- 应用版本未发布或 scope 缺失时，health/日志能区分连接失败与权限失败。

## 9. 发布门槛

必须全部满足后，才可将本次迁移作为可发布版本：

- [ ] 生产代码无 gateway 分支和旧 endpoint。
- [ ] 生产代码无旧 Card 1.0 生成器、`lark_md` 或 `tag: "action"`。
- [ ] CardKit 2.0 原生流式 contract、sequence、uuid、结束和 rollover 测试通过。
- [ ] `pnpm build` 通过。
- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm test` 通过。
- [ ] `pnpm verify packages/channel-lark --test` 通过。
- [ ] `pnpm check:manifests`、`pnpm check:upstream`、`pnpm doctor` 通过。
- [ ] L1-L5 live gate 有可复核记录。
- [ ] manifest 的 testedVersion 与实际 SDK lock 版本一致；未完成 live gate 时不得声称 live-tested。

## 10. 禁止事项

- 不恢复 `upstream.mode: gateway` 作为临时 fallback。
- 不因为旧租户仍有 plaintext `appSecret` 就把迁移逻辑留在运行时。
- 不使用 `cardkit.v1.card.idConvert` 作为新主路径；官方已标记不推荐。
- 不用 `im.v1.message.patch` 的高频全量替换冒充 CardKit 原生打字机流式。
- 不把 `schema: "2.0"` 字段存在误认为已经完成 CardKit 2.0 生命周期。
- 不从第三方机器人项目、旧博客或静态 Web metadata 推断权限已授权。
- 不将 SDK 类型声明中的“支持”写成真实租户已验证；所有账号、权限、发布和事件行为都要经过 live gate。

## 11. 参考来源

### DSH

- [channel-lark definition](../packages/channel-lark/src/definition.ts)
- [channel-lark config](../packages/channel-lark/src/config.ts)
- [channel-lark adapter](../packages/channel-lark/src/adapter.ts)
- [SDK upstream](../packages/channel-lark/src/lark-sdk-upstream.ts)
- [OpenAPI outbound](../packages/channel-lark/src/openapi-outbound.ts)
- [Media port](../packages/channel-lark/src/upstream/media-port.ts)
- [Lark manifest](../packages/channel-lark/src/manifest.ts)
- [Lark package README](../packages/channel-lark/README.md)

### 官方

- [Feishu Open Platform](https://open.feishu.cn/document/)
- [Card JSON 2.0 structure](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure)
- [Streaming card updates](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview)
- [Message card markdown](https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags)
- [Official Node SDK](https://github.com/larksuite/node-sdk)
- [Official SDK npm package](https://www.npmjs.com/package/@larksuiteoapi/node-sdk)

## 12. 结论

当前仓库已完成“只保留官方 SDK + Card JSON 2.0 + CardKit 原生流式”的代码实现与离线测试：旧 gateway、旧卡片生成路径、plaintext secret 字段均已移除；rollover、终态关闭、失败清理和 OpenAPI 非零 code 均有回归覆盖。发布前仍必须完成第 8 节 L1-L5 真实飞书应用 live gate，并据结果更新 manifest 的 live 状态；离线通过不等于平台权限已授权。
