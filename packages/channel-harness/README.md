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
    - llm
    - commands
```

Inbound channel images remain real `ImageBlock`s in the original Session. If
the selected model explicitly declares that it does not accept image input,
the bridge keeps the same Session and replaces each image with
`[图片：当前模型不支持查看]` only in the provider-visible request. Text and
image order is preserved, and unknown model capabilities fail open.

## What it does

| Area | Responsibility |
| --- | --- |
| `SessionBinding` / `BindingStore` | Binds platform conversations to Harness session ids (file-backed by default, survives restarts) |
| `AgentManager` / `AgentRouter` | Resolves/creates the agent for a conversation via `agent.default` plus per-channel/account/conversation overrides |
| `MessageConverter` | Maps structured `ChannelEvent` messages to Harness message types |
| `ReplyRouter` / `ReplyContextStore` | Streams `session/event` output back to the adapter (`ReplyHandle`) |
| `WorkspaceResolver` | Maps conversations to Harness workspaces (`channel-account` by default) |
| commands | Registers Agent-scoped slash commands (`/new`) through Harness `CommandRuntime` |
| outbox | Proactive `send_channel_message` tool support (`OutboxService`) |

## Configuration

```yaml
- id: channels-harness
  name: '@wsz987/channel-harness'
  inject: [channels, agents, agentDefaultModel, llm, commands]
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
