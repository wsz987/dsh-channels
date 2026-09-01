---
'@wsz987/channel-harness': patch
---

`ask_user_question` 统一文本兜底（P0）：`interactiveActions` 不再作为问题准入条件，
只要渠道 `text: true` 即可通过编号文字完成问答；`interactiveActions: true` 仅升级为
原生按钮展示。非按钮渠道（Weixin / QQ / DingTalk / Lark）现在会收到编号选项文本
（`1. xxx`，无 description 也始终渲染），支持数字 / 选项文字 / 自定义 / `跳过` /
多选 `1,3` 回答；群聊文字回答支持平台 `replyTo` 或每道题生成的短关联码
（`Q-XXXXXX`）两种关联方式；越界多选输入提示重新输入而不取消整个问题。
Telegram 原生按钮 + ForceReply 路径保持不变。
