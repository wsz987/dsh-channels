---
'@wsz987/channel-harness': patch
---

修复渠道 `ask_user_question` 全渠道失效（Web profile 下问题被官方 Remote answerer 吞掉）。

0.1.2 起官方问题域改为 `user-questions/request` waterfall（串行、先认领者胜），
官方 `@deepseek-ai/dsh-api-remotes` 在 web profile 开机即注册转发 answerer，早于
`channels-harness`，因此普通 `ctx.on()` 注册的渠道 answerer 永远排在后面：有浏览器
连接时问题被 Web UI 认领并挂起，无连接时请求 park 在 `pendingRemoteEvents`，渠道
（含微信文字兜底）两种情况下都收不到问题。

- `WaterfallQuestionBackend` 改用 `{ prepend: true }` 注册：渠道能展示就认领
  （按钮或编号文字兜底），不能展示仍 `next()` 委托官方 Web answerer。
- 启动探测 `ctx.userQuestions` 失败不再永久关闭渠道问答，只 `warn`：服务可能晚于
  bridge 挂载（profile 行并发创建 / patch 热重载），answerer 本身只需要根 context。
- 新增「Web answerer 先注册，渠道仍须拿到问题」与「渠道 decline 后仍到达 Web
  answerer」回归测试。
