---
'@wsz987/dsh-channels': patch
'@wsz987/channel-core': patch
'@wsz987/channel-dingtalk': patch
'@wsz987/channel-files': patch
'@wsz987/channel-harness': patch
'@wsz987/channel-lark': patch
'@wsz987/channel-qq': patch
'@wsz987/channel-telegram': patch
'@wsz987/channel-web': patch
---

Follow the official DeepSeek Harness `0.1.0-rc.7` release: bump the whole `@deepseek-ai/dsh-*` family to peer `^0.1.0-rc.7` / dev `0.1.0-rc.7` across the channel packages, and `@wsz987/channel-harness` now depends on `@deepseek-ai/dsh-agent-default-model`.

The rc.7 release adds settings cards, Job Panel subagent tasks, durable MCP/ACP image attachments, a DeepSeek `low` reasoning effort (default stays `high`), and assorted stability fixes. The command / model-selection / session / llm API surface used by `channel-harness` is unchanged between rc.6 and rc.7 (verified by type diff + full test suite + manifest checks), so this is a dependency-alignment bump, not a behavior change.