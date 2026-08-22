# dsh-channels：Harness 运行失败回传渠道执行方案

> 适用基线：`dsh-channels main@213fd5c`
> Harness：`@deepseek-ai/dsh-* 0.1.1-rc.2`
> 目标版本线：`dsh-channels 0.5.x`
> 状态：最终实施方案

---

## 1. 背景

当前渠道消息进入 `dsh-channels` 后，通过 `ChannelHarnessBridge` 调用 Harness Agent：

```text
Telegram / 微信 / QQ / 飞书 / 钉钉
        ↓
ChannelHarnessBridge
        ↓
agent.followup(userMessage)
        ↓
Harness Agent Loop
        ↓
LLM Provider
```

如果模型请求在产生任何 assistant 输出前失败，例如：

```text
API key is invalid
```

Harness 会正常产生：

```text
turn/end
reason.kind = "error"
reason.error = LlmFailure
```

但当前 `ReplyRouter` 只消费：

- `assistant/chunk`
- `assistant/message`
- `turn/end` 作为普通 finalize 信号

没有消费 `turn/end.data.reason` 中的失败信息。

因此当前行为是：

```text
用户消息
  ↓
agent/inbox/claimed
  ↓
startTyping
  ↓
LLM AUTH 失败
  ↓
turn/end { reason.kind = "error" }
  ↓
无 assistant/chunk
  ↓
没有 ActiveReply
  ↓
finishTurn() 直接 releaseTurn()
  ↓
渠道没有任何失败提示
```

现有 rc.2 Session contract test 也明确记录了这一行为：

```ts
it('an errored turn with NO streamed output sends nothing (observed real behavior)')
```

该缺口应在 `channel-harness` 的终态投影层修复，而不是在各 Channel Adapter 或入站 Bridge 中特殊处理。

---

# 2. 目标

实现以下行为：

### 2.1 无输出失败

当 Harness 返回：

```ts
turn/end
reason.kind === 'error'
```

且本轮没有产生任何 assistant 输出时，渠道收到：

```text
⚠️ 本轮运行失败

API key is invalid
```

或对应的安全化错误信息。

---

### 2.2 已有部分输出后失败

如果模型已经输出部分内容：

```text
正在分析项目……
```

随后失败，则：

```text
消息 1：
正在分析项目……

消息 2：
⚠️ 本轮运行失败

<错误信息>
```

错误通知不得拼入 assistant 内容本身。

原因：Harness rc.2 官方 Client 将 terminal error 投影为独立的 `turn-error` 节点，而不是篡改 assistant message。

---

### 2.3 AUTH 信息安全

对于：

```ts
failure.code === 'AUTH'
```

不得直接把 provider 原始 `failure.message` 发到渠道。

统一输出：

```text
API key is invalid
```

避免某些 Provider 的认证失败信息中泄露掩码后或部分保留的 credential。

---

### 2.4 终态正确停止 typing

任何拥有 Channel ReplyContext 的 turn 在 `turn/end` 后都必须停止 typing，包括：

- completed 且无输出
- error 且无输出
- aborted 且无输出
- blocked
- max-tokens
- 其他未来终态

---

# 3. 非目标

本次不要顺带扩大范围。

明确不做：

- 不修改 Telegram Adapter 的业务错误判断
- 不修改微信 Adapter
- 不修改 QQ Adapter
- 不修改钉钉 Adapter
- 不修改飞书 Adapter
- 不在 `bridge.ts` 外层 `try/catch` 捕获模型失败
- 不增加第二套 `runId -> channel` 映射
- 不修改 `SessionBinding` 数据结构
- 不修改 `ReplyContextStore` 存储模型
- 不实现完整错误码中文化系统
- 不实现自动重试
- 不把 `blocked` / `max-tokens` / `interrupted` 全部转成用户提示

本次范围只包括：

```text
terminal error notice
+
no-output terminal cleanup
```

---

# 4. 官方 Harness rc.2 契约

Harness rc.2 的 `TurnEndReason`：

```ts
completed
aborted
blocked
error
max-tokens
interrupted
```

其中失败：

```ts
{
  kind: 'error',
  error: LlmFailure,
}
```

`LlmFailure`：

```ts
interface LlmFailure {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
  readonly requestId?: ProviderRequestId;
}
```

注意：

```ts
code: string
```

不是封闭 union。

因此 Channel 层不要假设自己可以穷举全部 Harness 错误码。

应遵循：

```text
机器路由：failure.code
诊断：failure.message
```

而不是解析错误字符串决定类型。

---

# 5. 最终架构

```text
Channel inbound
      │
      ▼
ChannelHarnessBridge
      │
      └── agent.followup()
               │
               ▼
        Harness Agent Loop
               │
        ┌──────┴───────┐
        │              │
 assistant 输出     terminal failure
        │              │
assistant/chunk    turn/end
assistant/message  reason.kind=error
        │              │
        └──────┬───────┘
               ▼
           ReplyRouter
        ┌──────┴────────┐
        │               │
 assistant reply    error notice
        │               │
        ▼               ▼
    ChannelAdapter   ChannelAdapter
```

职责边界：

### Harness

负责：

- Provider 调用
- retry
- failure 分类
- `LlmFailure`
- `turn/end`

### channel-harness

负责：

- 判断该 turn 是否来自 Channel
- 找回回复目标
- 把 Harness terminal failure 安全投影为渠道通知

### Channel Adapter

只负责：

```text
发送 / 编辑 / 流式展示
```

不理解：

```text
AUTH
RATE_LIMIT
QUOTA
SERVER
```

---

# 6. 文件变更范围

建议只修改：

```text
packages/channel-harness/
├── src/
│   ├── reply-router.ts
│   └── failure-display.ts        # 新增
│
├── test/
│   └── reply-router-session-contract.test.ts
│
└── CHANGELOG / changeset
```

不修改 Channel Adapter。

---

# 7. P0-1：新增 failure-display.ts

路径：

```text
packages/channel-harness/src/failure-display.ts
```

建议：

```ts
import type { LlmFailure } from '@deepseek-ai/dsh-llm';

/**
 * 将 Harness terminal failure 转为适合渠道展示的文本。
 *
 * AUTH 的 provider message 不能直接投影：
 * 部分 Provider 的认证失败文本可能包含 credential 片段。
 */
export function displayChannelFailure(
  failure: LlmFailure,
): string {
  if (failure.code === 'AUTH') {
    return 'API key is invalid';
  }

  return failure.message || 'Model request failed';
}

/** 渠道端完整终态失败通知。 */
export function formatChannelTurnFailure(
  failure: LlmFailure,
): string {
  return `⚠️ 本轮运行失败\n\n${displayChannelFailure(failure)}`;
}
```

## 7.1 为什么不直接依赖 dsh-client-runtime

Harness 官方 `dsh-client-runtime` 已提供类似：

```ts
displayFailureMessage()
```

但 `channel-harness` 属于 Host/server bridge。

为了复用一个极薄的 display helper 而引入 Client Runtime，会形成不合理依赖：

```text
Host bridge
   ↓
Client/browser runtime
```

因此这里允许复制该安全规则，但必须在注释中注明来源语义：

```text
保持与 Harness rc.2 官方 Client failure-display 行为一致。
```

---

# 8. P0-2：ReplyRouter 消费 turn/end.reason

当前：

```ts
case 'turn/end':
  void this.finishTurn(session, event.data.turn);
  break;
```

修改为：

```ts
case 'turn/end':
  void this.finishTurn(
    session,
    event.data.turn,
    event.data.reason,
  );
  break;
```

导入：

```ts
import type {
  Session,
  SessionEvent,
  TurnEndReason,
} from '@deepseek-ai/dsh-session';
```

---

# 9. P0-3：增加无 ActiveReply target resolution

当前 `ActiveReply` 只会在：

```text
assistant/chunk
或
assistant/message
```

发生时创建。

AUTH 经常发生在第一个 token 之前，因此：

```ts
active === undefined
```

但此时 `ReplyContextStore` 已经在：

```text
agent/inbox/claimed
```

完成：

```text
messageId
→ sessionId + turn
```

关联。

所以无需新增映射。

建议在 `ReplyRouter` 中增加：

```ts
private resolveTurnTarget(
  sessionId: string,
  context: ChannelReplyContext | undefined,
):
  | {
      binding: SessionBinding;
      adapter: ChannelAdapter;
      target: ChannelTarget;
    }
  | undefined {
  if (!context) return undefined;

  const binding = this.options.getBinding(sessionId);
  if (!binding) {
    this.options.logger.warn(
      `[channel-harness] no session binding for '${sessionId}'`,
    );
    return undefined;
  }

  const adapter = this.options.getAdapter(binding.channelId);
  if (!adapter) {
    this.options.logger.warn(
      `[channel-harness] no adapter for channel '${binding.channelId}'`,
    );
    return undefined;
  }

  return {
    binding,
    adapter,
    target: targetFor(binding, context),
  };
}
```

本次不要为了 DRY 大规模重构 `ensureActive()`。

---

# 10. P0-4：重写 finishTurn 终态流程

目标实现：

```ts
private async finishTurn(
  session: Session,
  turn: number,
  reason: TurnEndReason,
): Promise<void> {
  const sessionId = String(session.id);
  const active = this.active.get(sessionId);

  // finalize() 会 releaseTurn，因此必须先取得 context。
  const context = this.options.replyContexts.getTurn(
    sessionId,
    turn,
  );

  const terminalTarget = active
    ? (() => {
        const adapter = this.options.getAdapter(
          active.binding.channelId,
        );
        if (!adapter) return undefined;
        return {
          binding: active.binding,
          adapter,
          target: active.target,
        };
      })()
    : this.resolveTurnTarget(sessionId, context);

  try {
    // 先正常结束已有 assistant 输出。
    if (active) {
      await this.finalize(active, turn);
    }

    // Harness terminal error 单独作为系统通知投影。
    if (
      reason.kind === 'error' &&
      terminalTarget
    ) {
      const notice = formatChannelTurnFailure(
        reason.error,
      );

      try {
        await this.deliver(
          terminalTarget.adapter,
          terminalTarget.target,
          notice,
        );
      } catch (error) {
        this.options.logger.error(
          `[channel-harness] failed to deliver turn error for session '${sessionId}'`,
          error,
        );
      }
    }
  } finally {
    // active 路径由 finalize() 自己负责 cleanup。
    // 无 active 路径必须手动完成 terminal cleanup。
    if (!active) {
      this.options.replyContexts.releaseTurn(
        sessionId,
        turn,
      );

      if (terminalTarget) {
        this.stopTypingIfSupported(
          terminalTarget.binding.channelId,
          terminalTarget.target,
        );
      }
    }
  }
}
```

---

# 11. 为什么 error notice 必须独立发送

不推荐：

```text
assistant partial + "本轮运行失败"
```

拼接为一个 assistant message。

推荐：

```text
assistant 消息
+
terminal error notice
```

理由：

Harness rc.2 官方 Client 的 Conversation 层将：

```text
turn/end.reason.kind === error
```

构造成独立：

```text
turn-error
```

说明 terminal failure 是运行时状态，不属于模型回答正文。

Channel 应保持同样语义。

---

# 12. 各 TurnEndReason 行为

本次最终行为：

| reason | assistant 已输出 | 无 assistant 输出 | 是否发送 error notice |
|---|---|---|---|
| `completed` | 正常 finalize | 不发文本 | 否 |
| `error` | finalize + 独立错误通知 | 直接错误通知 | 是 |
| `aborted` | finalize 已输出部分 | 不发额外消息 | 否 |
| `blocked` | 保持现状 | 保持现状 | 否 |
| `max-tokens` | 保持现状 | 保持现状 | 否 |
| `interrupted` | 保持现状 | 保持现状 | 否 |

注意：

`blocked / max-tokens / interrupted` 后续如需 UI 化，应单独设计 `TerminalTurnPresenter`，不要塞进本次修复。

---

# 13. AUTH 安全要求

测试必须证明 raw auth diagnostic 不会发送到 Channel。

例如：

```ts
reason: {
  kind: 'error',
  error: {
    code: 'AUTH',
    message: '401 invalid key sk-THIS-MUST-NOT-LEAK',
  },
}
```

期望：

```text
⚠️ 本轮运行失败

API key is invalid
```

并验证：

```ts
expect(JSON.stringify(adapter.sent))
  .not.toContain('sk-THIS-MUST-NOT-LEAK');
```

原始 diagnostic 仍由 Harness Session log / logger 保留。

---

# 14. 测试调整

文件：

```text
packages/channel-harness/test/reply-router-session-contract.test.ts
```

## 14.1 修改现有测试

当前：

```ts
it(
  'an errored turn with NO streamed output sends nothing (observed real behavior)',
)
```

修改为：

```ts
it(
  'an errored turn with no assistant output sends a terminal failure notice',
)
```

测试：

```ts
session.append('turn/start', { turn: 0 });
session.append('turn/end', {
  turn: 0,
  reason: {
    kind: 'error',
    error: {
      message: 'provider 500',
      code: 'UNKNOWN',
    },
  },
});

await vi.waitFor(() => {
  expect(adapter.sent).toHaveLength(1);
});

expect(adapter.sent[0]?.text).toBe(
  '⚠️ 本轮运行失败\n\nprovider 500',
);
```

---

## 14.2 新增 AUTH redaction 测试

```ts
it('redacts raw AUTH provider diagnostics', async () => {
  const { session, adapter, detach } = makeFixture();

  try {
    session.append('turn/start', { turn: 0 });
    session.append('turn/end', {
      turn: 0,
      reason: {
        kind: 'error',
        error: {
          code: 'AUTH',
          message: '401 invalid key sk-THIS-MUST-NOT-LEAK',
        },
      },
    });

    await vi.waitFor(() => {
      expect(adapter.sent).toHaveLength(1);
    });

    expect(adapter.sent[0]?.text).toBe(
      '⚠️ 本轮运行失败\n\nAPI key is invalid',
    );

    expect(JSON.stringify(adapter.sent))
      .not.toContain('sk-THIS-MUST-NOT-LEAK');
  } finally {
    detach();
  }
});
```

---

## 14.3 partial + error

当前 partial failure 测试只验证 partial。

更新预期：

```text
adapter.sent.length === 2
```

第一条：

```text
partial before failure
```

第二条：

```text
⚠️ 本轮运行失败

provider 500
```

不得将两者拼起来。

---

## 14.4 aborted 无输出

保持：

```text
adapter.sent === []
```

用于保证 `/stop` 不产生额外“本轮运行失败”。

---

## 14.5 non-channel turn error

如果 turn 没有 `ReplyContext`：

```text
不得发送到 Channel
```

这是重要的 outbound gate。

Web UI / CLI / 其他插件驱动同一个 Session 时，其错误不能串到 Channel。

---

# 15. typing 清理测试

建议为测试 Adapter 增加：

```ts
stopTypingForTargetCalls: ChannelTarget[] = [];

async stopTypingForTarget(target: ChannelTarget) {
  this.stopTypingForTargetCalls.push(target);
}
```

验证：

### 15.1 error 无输出

```text
turn/start
→ turn/end(error)
→ stopTyping
```

### 15.2 aborted 无输出

```text
turn/start
→ turn/end(aborted)
→ stopTyping
```

### 15.3 completed 无输出

```text
turn/start
→ turn/end(completed)
→ stopTyping
```

原则：

> 只要 Channel ReplyContext 已被 claim，本轮 `turn/end` 必须完成 typing cleanup。

---

# 16. Error notice 发送失败必须安全

当前 `session/event` 入口是：

```ts
void this.finishTurn(...)
```

因此 `finishTurn()` 中不能让 `adapter.send()` rejection 漏出成为 unhandled rejection。

必须：

```ts
try {
  await this.deliver(...);
} catch (error) {
  logger.error(...);
}
```

同时无论发送成功失败：

```text
ReplyContext 必须 release
Typing 必须停止
```

测试：

```ts
adapter.send = async () => {
  throw new Error('channel unavailable');
};
```

最终：

```ts
expect(
  replyContexts.getTurn(sessionId, turn),
).toBeUndefined();
```

---

# 17. 不要在 Bridge 捕获 LLM terminal failure

不要这样：

```ts
try {
  agentRef.followup(userMessage);
} catch (error) {
  // send to channel
}
```

原因：

`followup()` 是投递输入。

LLM 请求实际发生在后续 Agent Loop 中。

Provider 的：

- AUTH
- RATE_LIMIT
- SERVER
- TIMEOUT
- TRANSPORT
- QUOTA

属于异步 turn 生命周期错误。

官方稳定边界是：

```text
session/event
→ turn/end
→ reason
```

因此必须在 `ReplyRouter` 消费。

---

# 18. 不要在 Adapter 识别 API 错误

错误设计：

```text
Telegram Adapter
  └─ if message includes "API key is invalid"
```

或：

```text
QQ Adapter
  └─ switch AUTH
```

正确：

```text
Harness
  ↓
LlmFailure
  ↓
channel-harness failure projection
  ↓
ChannelMessage{text}
  ↓
Adapter
```

Adapter 只负责平台发送行为。

---

# 19. Changeset

新增：

```text
.changeset/channel-turn-error-notice.md
```

建议：

```md
---
'@wsz987/channel-harness': patch
'@wsz987/dsh-channels': patch
---

Channel-triggered Harness turns that terminate with
`turn/end.reason.kind = "error"` now return a safe terminal failure
notice to the originating channel. `AUTH` failures hide the raw
provider diagnostic and display `API key is invalid`. No-output
terminal turns also stop typing indicators correctly.
```

当前 rc.2 baseline changeset 已经对 0.5.x 做 minor bump，因此最终 release 合并时仍会进入 0.5.0，但该 changeset 可以保留独立 changelog 语义。

---

# 20. 实施顺序

## Step 1

新增：

```text
src/failure-display.ts
```

只实现：

```text
AUTH redaction
+
generic message fallback
```

---

## Step 2

修改：

```text
reply-router.ts
```

让：

```text
turn/end
```

把 `reason` 传给 `finishTurn()`。

---

## Step 3

新增：

```text
resolveTurnTarget()
```

支持：

```text
ReplyContext 存在
但 ActiveReply 不存在
```

---

## Step 4

重构：

```text
finishTurn()
```

实现：

```text
assistant finalize
terminal error notice
typing cleanup
reply-context cleanup
```

---

## Step 5

更新 rc.2 Session contract tests。

优先使用官方真实：

```text
SessionStore
Session.append
session/event
```

不要手写伪 Session event 作为主要测试。

---

## Step 6

增加 changeset。

---

# 21. 自动测试命令

实现完成后执行：

```bash
pnpm --filter @wsz987/channel-harness typecheck

pnpm --filter @wsz987/channel-harness test

pnpm check:harness-compat

pnpm ci:check
```

要求全部通过。

---

# 22. Telegram 真实验收

## Case A：错误 API Key

设置错误 key。

TG 发送：

```text
你好
```

期望：

```text
⚠️ 本轮运行失败

API key is invalid
```

并且 typing 停止。

---

## Case B：修复 API Key 后继续同 Session

换正确 key。

继续发送：

```text
你好
```

期望正常回答。

目的：确认失败 turn 没有污染下一 turn。

---

## Case C：/stop

模型生成期间发送：

```text
/stop
```

期望：

```text
已停止当前任务。
```

不能额外出现：

```text
⚠️ 本轮运行失败
```

---

## Case D：Partial + Error

模拟模型先产生部分输出，再 Provider 失败。

期望：

```text
消息 1：模型已经产生的 partial

消息 2：⚠️ 本轮运行失败
        <安全错误信息>
```

---

# 23. 跨渠道 Smoke Test

因为本次实现位于 `channel-harness`，各 Adapter 不需要单独实现逻辑，但发布前建议至少验证：

```text
Telegram   ✅
微信       ✅
QQ         ✅
钉钉       ✅
飞书       ✅
```

每个渠道只需验证一个：

```text
error/no-output
```

场景即可。

无需每个平台重复全部 contract tests。

---

# 24. 稳定性约束

实现必须遵守以下不变量。

## 24.1 ReplyContext 是 outbound authority

只有：

```text
replyContexts.getTurn(sessionId, turn)
```

存在时，terminal failure 才允许发往 Channel。

绝不能仅凭：

```text
SessionBinding 存在
```

就发送。

否则 Web UI / CLI 驱动的同 Session turn 也可能串到 Channel。

---

## 24.2 Session log 是 failure truth

不要另存：

```text
lastError
lastTurnError
providerErrorCache
```

Harness 已经把 `LlmFailure` 持久化在：

```text
turn/end.reason.error
```

Channel 只做实时投影。

---

## 24.3 Adapter failure 不改变 Session 语义

如果：

```text
Harness turn error
```

之后：

```text
Telegram send error
```

不得：

- 修改 Session 状态
- 重试 LLM
- 重新执行 turn
- 修改 binding

只记录：

```text
channel delivery failed
```

---

## 24.4 AUTH diagnostic 不得外泄

必须有测试守护。

---

# 25. 后续可选演进

本次完成后，如果未来需要更丰富用户提示，可以新增：

```text
TerminalTurnPresenter
```

例如：

```ts
interface TerminalTurnPresentation {
  kind: 'error' | 'warning' | 'info';
  text: string;
  retryable?: boolean;
}
```

之后处理：

```text
error
max-tokens
blocked
interrupted
```

但不建议现在就做。

原因：当前最重要的是稳定闭合：

```text
Harness terminal failure
→ Channel user receives feedback
```

---

# 26. 最终实施范围

```text
P0
├── packages/channel-harness/src/failure-display.ts
│   ├── AUTH 安全展示
│   └── generic failure message
│
├── packages/channel-harness/src/reply-router.ts
│   ├── 消费 turn/end.reason
│   ├── resolve no-output turn target
│   ├── 独立 terminal error notice
│   └── no-output terminal typing cleanup
│
├── packages/channel-harness/test/reply-router-session-contract.test.ts
│   ├── error/no-output
│   ├── AUTH redaction
│   ├── partial + error
│   ├── aborted/no-output
│   ├── non-channel turn error
│   └── delivery failure cleanup
│
└── .changeset/channel-turn-error-notice.md
```

---

# 27. Done Definition

只有全部满足才算完成：

- [ ] `turn/end.reason.kind === 'error'` 已被 ReplyRouter 消费
- [ ] error/no-output 能回原 Channel
- [ ] AUTH 不泄露 raw provider diagnostic
- [ ] partial assistant 与 error notice 分离
- [ ] `/stop` 不产生额外 failure notice
- [ ] non-channel turn 不串消息到 Channel
- [ ] no-output terminal 会 stopTyping
- [ ] adapter.send 失败不会产生 unhandled rejection
- [ ] ReplyContext 始终释放
- [ ] rc.2 Session contract tests 通过
- [ ] `pnpm check:harness-compat` 通过
- [ ] `pnpm ci:check` 通过
- [ ] Telegram 错误 key 实机验证通过
- [ ] 修复 key 后同 Session 可继续正常运行

---

# 28. 最终结论

这次问题不属于 Telegram，也不属于具体 Provider Adapter。

正确修复层级是：

```text
Harness Session terminal event
        ↓
ReplyRouter
        ↓
Channel-safe terminal projection
        ↓
ChannelAdapter
```

当前 `dsh-channels` 在升级到 Harness `0.1.1-rc.2` 后，已经具备完成该功能所需的全部基础设施：

- 官方 `turn/end.reason.error`
- `LlmFailure`
- `ReplyContextStore`
- `SessionBinding`
- `targetFor()`
- `deliver()`
- `stopTypingIfSupported()`
- 真实 rc.2 Session contract tests

因此不需要新增 Channel 协议，也不需要修改具体 Adapter。

本方案应作为 `0.5.x` 的一个收敛型稳定性修复直接实施。
