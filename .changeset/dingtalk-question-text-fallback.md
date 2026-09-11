---
'@wsz987/channel-dingtalk': patch
'@wsz987/channel-harness': patch
---

修复钉钉 `ask_user_question` 总是回「无法在当前渠道展示问题，已取消。」

钉钉协议**支持**卡片按钮问答（互动卡片「回传请求」+ STREAM 回调），但按钮要求卡片模板
已在本组织卡片平台发布、且含 `text`/`actions` 变量。此前 `card.interactiveTemplateId`
有内置默认值（第三方 Claw Bot AI Card 模板），SDK 模式下 `interactiveActions` 因此对任何
默认配置都是 `true`，卡片发送在该模板不存在/变量不匹配时抛错，而 presenter 直接取消问题。

- `channel-dingtalk`：`card.interactiveTemplateId` 取消内置默认（fail closed）。未显式
  配置即 `interactiveActions: false`，问题走编号文字回复（与微信一致）；`02fcf2f4-…`
  常量仅保留给流式 AI Card 路径。gateway 模式永不声明按钮能力。
- `channel-harness`（通用，非渠道特判）：actions 模式发送失败时，把该批问题降级为
  `text` 并重新渲染发送（带上「回复 1/2/3」说明与群聊关联码），只有文字也失败才取消。
  QQ / Telegram / Lark 同样受益。
- 回归测试覆盖两种降级路径与「默认不声明按钮能力」。
