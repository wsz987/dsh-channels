---
'@wsz987/channel-harness': minor
---

清理残留的旧描述与死代码。

- **移除 `ChannelWorkspaceAttachError`（BREAKING，未发布的 0.5.1 内）**：该类是 Workspace
  软附加（soft-attach）之前的遗留导出，bridge 已不再抛出它，仓库内无任何引用（含测试）。
  现在 Workspace 附加失败是非致命的：session 保留、按未分组处理，binding 与 followup 继续。
- 移除只讲述历史演进的注释（旧 provider/ApiProxy/`resolveSessionPreset`/旧网关等），
  改为描述当前契约；不改任何行为。
