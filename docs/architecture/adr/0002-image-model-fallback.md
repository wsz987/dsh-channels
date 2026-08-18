# ADR 0002 — Channel Image-Compatibility Policy at the Provider Boundary

> Records the decision for handling inbound channel images when the configured
> model cannot accept images. Implementation:
> `packages/channel-harness/src/image-model-fallback.ts` (the `llm/stream`
> waterfall listener), the `imageCompatibility` config in
> `packages/channel-harness/src/config.ts`, and the `saveImage` attachment path
> in `packages/channel-harness/src/message-converter.ts`.

## Status

Accepted — implemented.

## Context

WeChat, QQ, DingTalk, and Lark hydrate inbound images into Harness
`ImageBlock`s. A text-only model rejects a request containing an image. Because
the immutable user message remains in durable Session history, every later
request repeats that image and fails until the user manually starts a new
Session.

### Explicitly NOT host parity

This is a **Channel compatibility policy**, not an attempt to mirror the
official Web host. The official Web host refuses to switch a Session to a model
that cannot accept images once that Session already contains an image
(`session.selectModel` → `model-unavailable`) — the switch is rejected and the
existing Session keeps its model. A channel conversation cannot be "left alone"
the same way: the model is fixed by routing config, and the user's alternative
is to abandon the conversation (`/new`). Whether channels should force that is
a product decision, so the channel behavior is its own explicit, configurable
policy — never described as "host parity".

## Decision

Every inbound part is delivered to the existing Harness Session. The common
`channel-harness` converter saves real images (via the `saveImage` hook) and
preserves the source block order, including mixed messages such as
`text -> image -> text`. Session history is never rewritten and the channel
binding is never rolled over for model compatibility.

At the provider boundary, a `llm/stream` waterfall listener examines requests
for channel-bound Sessions that contain images. It queries
`llm.resolveModelInfo(provider, model)` and, when `inputModalities` explicitly
omits `image`, applies the configured `imageCompatibility.mode`:

| mode | behavior |
| --- | --- |
| `degrade` (default) | Copies the request and replaces each image block in place with `[图片：当前模型不支持查看]`, then streams the copied request. The original request, messages, attachments, and Session log remain intact. A text-only model keeps serving the conversation — no forced `/new`. |
| `reject` | Refuses the request with `ChannelImageUnsupportedError` instead of sending it — closest to the official Web refusal semantics. The user must start a new Session (`/new`) or switch to an image-capable model. |

Image-capable models receive the original request. Missing capability metadata
and lookup failures fail open because an absent declaration is not proof that
the model rejects images. A recursion guard lets the copied request pass
through the same waterfall exactly once without being transformed again.

## Consequences

- The identity is an explicit **Channel compatibility policy** with an explicit
  `reject` / `degrade` switch — the channel never claims to replicate the
  official Web `selectModel` refusal, and `reject` is available to deployments
  that want it.
- Degradation (or rejection) happens only at the provider boundary; the durable
  Session history keeps the real image blocks.
- The default (`degrade`) keeps a text-only model serving a channel-bound
  Session without the user having to start a new one; `reject` opts into the
  stricter official-Web-like behavior.
- The behavior is opt-out: when capability metadata is missing or the lookup
  fails, the original request is streamed unchanged.
- Tests cover ordered Session conversion, text-only request degradation,
  image-capable and unknown capabilities, failed lookup, non-channel Sessions,
  recursive waterfall dispatch, and both policy modes.
