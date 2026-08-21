# @wsz987/channel-telegram

## 0.4.2

### Patch Changes

- Add Telegram Bot API 10.2 Rich Markdown rendering and draft streaming, generic
  channel actions, callback-query interactions, and the Harness ApiProxy bridge
  for interactive user questions.
- Keep Rich Markdown byte-limit segmentation fast under concurrent CI load by
  reusing parser source ranges and avoiding redundant block serialization.
- Updated dependencies
  - @wsz987/channel-core@0.4.2
  - @wsz987/channel-control@0.4.2
