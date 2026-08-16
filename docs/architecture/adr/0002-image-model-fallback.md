# ADR 0002 — Image Model Fallback at the Provider Boundary

> Records the decision for handling inbound channel images when the configured
> model cannot accept images. Implementation:
> `packages/channel-harness/src/image-model-fallback.ts` (the `llm/stream`
> waterfall listener) and the `saveImage` attachment path in
> `packages/channel-harness/src/message-converter.ts`.

## Status

Accepted — implemented.

## Context

WeChat, QQ, DingTalk, and Lark hydrate inbound images into Harness
`ImageBlock`s. A text-only model rejects a request containing an image. Because
the immutable user message remains in durable Session history, every later
request repeats that image and fails until the user manually starts a new
Session.

## Decision

Every inbound part is delivered to the existing Harness Session. The common
`channel-harness` converter saves real images (via the `saveImage` hook) and
preserves the source block order, including mixed messages such as
`text -> image -> text`. Session history is never rewritten and the channel
binding is never rolled over for model compatibility.

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

## Consequences

- Degradation happens only at the provider boundary; the durable Session
  history keeps the real image blocks.
- A text-only model can keep serving a channel-bound Session without the user
  having to start a new one.
- The behavior is opt-out: when capability metadata is missing or the lookup
  fails, the original request is streamed unchanged.
- Tests cover ordered Session conversion, text-only request degradation,
  image-capable and unknown capabilities, failed lookup, non-channel Sessions,
  and recursive waterfall dispatch.
