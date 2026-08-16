# Image Model Fallback

## Problem

WeChat, QQ, DingTalk, and Lark hydrate inbound images into Harness
`ImageBlock`s. A text-only model rejects a request containing an image. Because
the immutable user message remains in durable Session history, every later
request repeats that image and fails until the user manually starts a new
Session.

## Design

Every inbound part is delivered to the existing Harness Session. The common
`channel-harness` converter saves real images and preserves the source block
order, including mixed messages such as `text -> image -> text`. Session
history is never rewritten and the channel binding is never rolled over for
model compatibility.

At the provider boundary, a `llm/stream` waterfall listener examines requests
for channel-bound Sessions that contain images. It queries
`llm.resolveModelInfo(provider, model)`. When `inputModalities` explicitly
omits `image`, it copies the request and replaces each image block in place
with `[图片：当前模型不支持查看]`, then streams the copied request. The original
request, messages, attachments, and Session log remain intact.

Image-capable models receive the original request. Missing capability metadata
and lookup failures fail open because an absent declaration is not proof that
the model rejects images. A recursion guard lets the copied request pass
through the same waterfall exactly once without being transformed again.

This uses Harness's public `llm/stream` short-circuit contract without mutating
the deep-frozen Agent Loop request. Later channel messages continue in the same
Session and see the same provider-only degradation for earlier images.

## Verification

Tests cover ordered Session conversion, text-only request degradation,
image-capable and unknown capabilities, failed lookup, non-channel Sessions,
and recursive waterfall dispatch. Bridge tests verify that WeChat, QQ, and
Lark image turns plus later text use one Session.
