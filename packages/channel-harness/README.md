# @wsz987/channel-harness

Thin Harness-native bridge between channel adapters and DeepSeek Harness
agents/sessions.

This package is the **only** package allowed to import Harness public APIs. It
turns `ChannelEvent`s emitted by `@wsz987/channel-core` adapters into Harness
sessions, routes them to the right agent, and streams assistant output back to
the channel reply pipeline.

## Install

```bash
pnpm add @wsz987/channel-harness
```

As a Cordis plugin:

```yaml
- id: channels-harness
  name: '@wsz987/channel-harness'
  inject:
    - channels
    - agents
    - agentDefaultModel
    - agentPresets
    - llm
    - commands
    - apiProxy
```

How a text-only model handles inbound channel images is an explicit **Channel
compatibility policy** (`imageCompatibility.mode`, default `degrade`), not host
parity: the official Web host refuses to switch a Session to a model that
cannot see its existing images, while channels keep serving the conversation.
With `degrade`, each image is replaced by `[图片：当前模型不支持查看]` at the
agent `pre-step` boundary, so the durable `user/message` and the model request
stay reconstructable and text/image order is preserved. Unknown capabilities
fail open. With `reject`, the step is refused with an error instead — the user
must start a new Session (`/new`) or switch to an image-capable model.

## What it does

| Area | Responsibility |
| --- | --- |
| `SessionBinding` / `BindingStore` | Binds platform conversations to Harness session ids (file-backed by default, survives restarts) |
| `AgentManager` / `AgentRouter` | Resolves/creates the agent for a conversation via `agent.default` plus per-channel/account/conversation overrides |
| `MessageConverter` | Maps structured `ChannelEvent` messages to Harness message types |
| `ReplyRouter` / `ReplyContextStore` | Streams `session/event` output back to the adapter (`ReplyHandle`) |
| `ChannelQuestionBridge` | Presents channel-origin `ask_user_question` requests through generic interactive actions and returns structured answers through the public ApiProxy contract |
| `WorkspaceResolver` | Maps conversations to Harness workspaces (`channel-account` by default) |
| commands | Registers Agent-scoped slash commands (`/new`) through Harness `CommandRuntime` |
| outbox | Proactive `send_channel_message` tool support (`OutboxService`) |

Model routing remains Harness-owned. A channel Session uses the model resolved
at create/resume time from its request header, route options, or the shared
`agentDefaultModel`. `/model` delegates the current-Session switch to the
official Host RPC (or the official headless hook) and persists the same choice
as the default for future Sessions. The bridge does not add a second owner or
run a first-turn model preparation RPC.

## Configuration

```yaml
- id: channels-harness
  name: '@wsz987/channel-harness'
  inject: [channels, agents, agentDefaultModel, agentPresets, llm, commands, apiProxy]
  config:
    agent:
      default:
        preset: main
        provider: deepseek
        model: deepseek-chat
        maxTokens: 4096
    routing:
      mode: global            # global | channel | account | conversation
    bindingStore:
      type: file              # memory | file
    workspace:
      mode: channel-account   # channel-account | host-cwd | disabled
      autoCreate: true
    imageCompatibility:
      mode: degrade           # degrade (default) | reject — ADR 0002
    userQuestions:
      enabled: true
      timeoutMs: 300000
    reply:
      updateIntervalMs: 200
      splitParagraphs: true
      splitCodeBlocks: true
      finalFlush: true
    maxConcurrency: 4
    drainTimeoutMs: 5000
    includeMetadataPrefix: false
```

Routing priority when `routing.mode` is not `global`:
`conversation` > `account` > `channel` > `agent.default`.

## Development

```bash
pnpm --filter @wsz987/channel-harness build
pnpm --filter @wsz987/channel-harness typecheck
pnpm --filter @wsz987/channel-harness test
```

## Related

- [Repository root](../../README.md)
- [Architecture design](../../docs/architecture.md)

## License

[MIT](../../LICENSE)
