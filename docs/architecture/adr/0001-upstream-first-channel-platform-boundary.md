# ADR 0001 — Upstream-First Channel Platform Boundary

> Milestone M0 (Upstream Boundary Lock).
> Source: `docs/dsh-channels-final-execution-plan-2026-08-16-FINAL.md` section 105.

## Status

Accepted

## Context

`dsh-channels` is a community channel plugin for DeepSeek Harness covering
WeChat / QQ / DingTalk / Lark. It is not the official platform implementation:
the platform protocol semantics for each channel are owned by official
platform SDKs and official channel implementations, not by this repository.

Early code self-implemented several platform wire behaviors directly (notably
the Weixin iLink client, media CDN + AES-128-ECB, several payload builders, and
parts of DingTalk OAPI). That approach duplicates the official upstreams,
drifts from platform behavior, and makes the adapter a second, unaudited
implementation of platform protocol.

Per the execution plan, `dsh-channels` must act only as an Adapter / Bridge
over official upstreams: it maps, bridges lifecycle, declares capability, and
wires into Harness — it does not reimplement platform protocol.

## Decision

The Decision core text, verbatim from plan section 105:

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
  `packages/channel-compat/src/upstream-manifest.ts` (plan section 4 / 39).
- Per-channel strategy is one of `official-sdk`, `official-host-neutral-subpath`,
  `minimal-official-api-port`, or explicit `source-port` where an upstream
  plugin is host-coupled and no host-neutral distribution exists.
- A channel may keep at most one thin port (plan section 7); a port only
  translates official API shape into a small testable adapter interface and
  never re-implements official AES / streaming / upload / token behavior when
  the SDK provides it.
- A Compatibility Facade is used only when the official plugin exposes no
  stable public API; the facade must not copy protocol algorithms (plan 38).

## Consequences

- Protocol source-of-truth stays in the official upstream; DSH adapters only
  convert shape, dramatically reducing drift risk.
- Self-implemented platform modules become classified as DSH glue, official
  SDK wrapper, or duplicate protocol implementation (plan section 19), and the
  duplicate ones are consolidated toward their upstream over later milestones
  (M1+), never removed in one large delete.
- Weixin is the heaviest duplication today and is prioritized first for
  upstream consolidation (plan section 14 / M1).
- Contract fixtures capture upstream behavior so offline tests remain a
  compatibility oracle without live credentials (plan section 73).
- No new runtime dependency is introduced by this ADR; it only records a
  boundary policy.
