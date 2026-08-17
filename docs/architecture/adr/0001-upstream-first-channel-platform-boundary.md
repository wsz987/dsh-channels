# ADR 0001 — Upstream-First Channel Platform Boundary

> Records the upstream-boundary decision that the five built-in channel
> adapters follow. Platform-SDK upstream baselines live programmatically in
> `packages/channel-compat/src/upstream-manifest.ts`; the Telegram Bot API
> baseline (direct protocol, no SDK) lives in
> `packages/channel-telegram/src/manifest.ts`.

## Status

Accepted

## Context

`dsh-channels` is a community channel plugin for DeepSeek Harness covering
WeChat / QQ / DingTalk / Lark / Telegram. It is not the official platform
implementation:
the platform protocol semantics for each channel are owned by official
platform SDKs and official channel implementations, not by this repository.

Early code self-implemented several platform wire behaviors directly (notably
the Weixin iLink client, media CDN + AES-128-ECB, several payload builders, and
parts of DingTalk OAPI). That approach duplicates the official upstreams,
drifts from platform behavior, and makes the adapter a second, unaudited
implementation of platform protocol.

`dsh-channels` therefore acts only as an Adapter / Bridge over official
upstreams: it maps, bridges lifecycle, declares capability, and wires into
Harness — it does not reimplement platform protocol.

## Decision

The decision core text:

```text
Decision:

dsh-channels treats official platform SDKs and official channel implementations
as the owners of platform protocol semantics.

dsh-channels implements only the minimum adapter layer required to expose those
semantics through the Channel Contract and DeepSeek Harness.

Platform protocol behavior must not be reimplemented locally when an official
host-neutral implementation exists.
```

Encoding details:

- Officially pinned upstream compatibility baseline is fixed in
  `packages/channel-compat/src/upstream-manifest.ts`.
- Per-channel strategy is one of `official-sdk`, `official-host-neutral-subpath`,
  `minimal-official-api-port`, or explicit `source-port` where an upstream
  plugin is host-coupled and no host-neutral distribution exists.
- A channel may keep at most one thin port; a port only translates official
  API shape into a small testable adapter interface and never re-implements
  official AES / streaming / upload / token behavior when the SDK provides it.
- A Compatibility Facade is used only when the official plugin exposes no
  stable public API; the facade must not copy protocol algorithms.

## Consequences

- Protocol source-of-truth stays in the official upstream; DSH adapters only
  convert shape, dramatically reducing drift risk.
- Self-implemented platform modules become classified as DSH glue, official
  SDK wrapper, or duplicate protocol implementation, and the duplicate ones
  are consolidated toward their upstream, never removed in one large delete.
- Weixin carries the heaviest platform-protocol surface today and is therefore
  prioritized for upstream consolidation.
- Contract fixtures capture upstream behavior so offline tests remain a
  compatibility oracle without live credentials.
- No new runtime dependency is introduced by this ADR; it only records a
  boundary policy.
