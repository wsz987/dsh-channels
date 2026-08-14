---
'@wsz987/channel-harness': minor
---

Official dsh-commands command plane + `/new` (first Agent-scoped channel command):

- Channel commands run through the official `@deepseek-ai/dsh-commands` registry: the bridge admits slash lines with the official `parseCommand()` and dispatches via `ctx.commands.execute()` — commands never enter the model prompt, `CommandResult` is rendered directly through the channel adapter (never via ReplyRouter / assistant messages), and syntactically valid but unregistered commands are rejected with `未知指令：/name` instead of reaching the model.
- `/new` is the first Agent-scoped channel command, shared by weixin / qq / dingtalk / lark (no per-channel implementations): it mints a brand-new Harness session, switches the conversation's SessionBinding to it, keeps the old session's persisted history, and retires the previous owned agent only after the official `command/done` settles. Includes busy guard (running session is not implicitly cancelled), binding-write rollback (fresh session disposed, old binding preserved), no-binding bootstrap (first message `/new` creates exactly one session), and per-conversation serialization so `/new` never races the next message.
- `channel-harness` now REQUIRES the `commands` capability (plugin inject + bundle patch) — no optional fallback. `AgentManager` gained raw-Agent exposure, create/resume/resolve `setup` passthrough (official `AgentRegistry` setup), one-time command setup for borrowed live agents, and `retireSession()`.
