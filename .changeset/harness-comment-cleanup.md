---
'@wsz987/channel-harness': patch
---

清理残留的旧描述（仅注释，无 API 变化）。

- 移除只讲述历史演进的注释（旧 provider / ApiProxy / `resolveSessionPreset` / 旧网关等），
  改为描述当前契约。
- 修正 `ChannelWorkspaceAttachError` 文档注释中重复的 “soft-attach semantics” 短语。
  该导出**保留不动**：它是已发布版本（0.5.0）的公开 API 面，`@deprecated` 兼容 shim 是有意
  保留的，删除会影响下游 `instanceof` / catch。
