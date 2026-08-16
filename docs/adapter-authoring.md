---
title: 第三方渠道接入指南
summary: 用 defineChannelAdapter 编写第三方适配器（config / mapper / upstream / contract / fixtures / manifest / verify）。
when_to_use: 新增渠道 | 第三方适配器 | defineChannelAdapter | manifest | pnpm verify
authoritative: 第三方适配器编写流程、契约测试、fixtures、manifest 字段与状态语义、pnpm verify 校验项。
see_also: [architecture.md, architecture/common-design.md, architecture/channel-roadmap.md]
status: as-built
---

# Adapter Authoring Guide

This guide explains how to build a third-party channel adapter for DeepSeek
Harness using the public Channel SDK. It covers the authoring helper
(`defineChannelAdapter`), the scaffold in `templates/channel-adapter`,
contract tests, fixtures, the compatibility manifest, verification and the
maturity model.

## 1. Overview: the no-modification guarantee

A channel adapter is an independent package that implements the stable
`ChannelAdapter` contract from `@wsz987/channel-core`. Adding a new channel
never requires changes to:

```text
channel-core
channel-harness
DeepSeek Harness source
the official adapters
```

If your channel needs something the contract cannot express, that is a
contract gap — report it instead of patching core. The whole point of the SDK
is that the fifth, tenth and thirtieth channel join without touching core
(see [architecture.md](architecture.md)).

The adapter itself is a thin layer between the platform and the Channel
Contract:

```text
Messaging Platform
       │
       ▼
Upstream Driver      ← the only module that talks to the platform
       │
       ▼
Channel Adapter      ← maps platform semantics ↔ Channel Contract
       │
       ▼
ChannelService (ctx.channels)
       │
       ▼
Harness Bridge       ← Harness public API (owned by the monorepo)
       │
       ▼
DeepSeek Harness Agent / Session
```

Three red lines (see [architecture.md](architecture.md) — 架构红线) apply to every adapter:

1. Never branch on other channel ids in core — that is core's business.
2. Never call Harness Agent APIs from an adapter (`ctx.agents...`).
3. Never leak raw platform payloads to the model — map everything into
   structured `MessagePart` content.

## 2. `defineChannelAdapter`

`defineChannelAdapter` is the entry point for object-form
adapters. It is an identity function at runtime — the object you pass in is
returned unchanged — and it runs a structural dev-time validation outside
production that throws a descriptive `TypeError` when the object does not
satisfy the `ChannelAdapter` contract (listing every missing/incorrect
required field).

```ts
import {
  defineChannelAdapter,
  type ChannelAdapter,
  type ChannelCapabilities,
} from '@wsz987/channel-core';

export default defineChannelAdapter({
  id: 'telegram',

  capabilities: {
    text: true,
    image: true,
    file: true,
    audio: true,
    video: true,
    markdown: true,
    cards: false,
    reactions: true,
    threads: true,
    streaming: 'edit',   // 'native' | 'edit' | 'buffered'
  },

  async start(ctx) {
    // Open the upstream connection and start the receive loop. The context
    // signal aborts when the owning scope is disposed.
  },

  async stop() {
    // Tear down the upstream connection; must be idempotent.
  },

  async send(target, message) {
    // Send one outbound message; return { delivered: true }.
  },
});
```

Because the helper keeps the concrete type of the input, you can also carry a
compatibility `manifest` field on the object (see §7) — it will still satisfy
`runChannelAdapterContract`, `ChannelService.register` and
`getAdapterManifest`.

The same contract is implemented by class-based adapters (all official
adapters use a class that `implements ChannelAdapter`). Either form works.

## 3. The template walkthrough

`templates/channel-adapter/` is a working scaffold mirroring the official
adapters (reference implementation: `packages/channel-qq`). It lives outside
the pnpm workspace, so it is never built by turbo — copy it out first.

1. Copy the scaffold, e.g. `cp -r templates/channel-adapter
   packages/channel-telegram`.
2. Rename the placeholders: `<channel>` → `telegram`, `<ChannelName>` →
   `Telegram`, `ChannelNameAdapter` → `TelegramAdapter`, and the sample
   fixtures directory `fixtures/example/` → `fixtures/telegram/`.
3. Replace the `workspace:*` dependency ranges with real published ranges
   when the package leaves the monorepo (see the template README).
4. Implement your channel, then run `pnpm install` + `pnpm test`.

Template layout:

```text
templates/channel-adapter/
├─ package.json          # metadata + dsh.bundle patch reference
├─ tsconfig.json
├─ cordis.patch.yml      # DSH bundle insert block for this adapter
├─ src/
│  ├─ index.ts           # exports + Cordis plugin shape (name/inject/apply)
│  ├─ config.ts          # Schemastery config
│  ├─ transport.ts       # HttpTransport / FetchTransport (test injection point)
│  ├─ upstream.ts        # ChannelUpstream + HTTP implementation
│  ├─ adapter.ts         # ChannelNameAdapter (ChannelAdapter lifecycle)
│  └─ mapper.ts          # raw payload → MessageReceived + dedupKey
├─ test/
│  └─ adapter.test.ts    # mapper/upstream/lifecycle + contract suite
└─ fixtures/example/     # sample fixtures
```

## 4. Writing config, mapper and upstream

**Config** (`src/config.ts`) — use a Schemastery `Schema.object` factory.
Every deployment-tunable parameter belongs here; credentials never do (the
platform owns credentials inside the upstream/gateway, red line 3).

**Mapper** (`src/mapper.ts`) — pure functions with no I/O:
`mapInbound(raw, meta)` turns a platform payload into a `MessageReceived`
event with structured `MessagePart` content (text/image/audio/file/...), and
`dedupKey(raw)` returns a stable identity for webhook retries (msgId, else
eventId, else a content hash). Raw payloads only ride along in `event.raw`
for debugging.

**Upstream** (`src/upstream.ts`) — the only module that knows the platform
endpoints/SDK. It exposes `start`/`stop`/`receive(signal, cb)`/
`sendText`/`sendMedia` and is implemented over the injectable
`HttpTransport`. Swapping in an official SDK later only touches this module.

**Adapter** (`src/adapter.ts`) — implements the lifecycle: `start(ctx)`
starts the upstream and the long-poll receive loop, `stop()` tears down
(idempotent), `send(target, message)` maps outbound messages, `getHealth()`
reports status. The template includes dedup (via `InboundProcessor`) and
exponential reconnect backoff.

## 5. Contract tests

`@wsz987/channel-testkit` ships `runChannelAdapterContract(adapter, options)`,
which registers a vitest suite verifying the stable contract:

- register/unregister through `ChannelService`
- `start` receives a complete `ChannelAdapterContext`
- event emit reaches service listeners
- AbortSignal aborts on scope disposal
- `send` returns a `SendResult`; failing sends map to `ChannelError`
- idempotent `stop` and cleanup
- capabilities structure
- health (when implemented)
- dedup (opt-in via `options.expectedDedup`)

Call it once per adapter in your test file:

```ts
import { runChannelAdapterContract } from '@wsz987/channel-testkit';

runChannelAdapterContract(new TelegramAdapter(makeConfig(), { transport }));
```

The testkit also provides `createTestContext`, `makeChannelTarget`,
`makeOutboundMessage`, fakes and the fixture loader.

## 6. Fixtures

Record real (or realistic) platform payloads as fixtures so mapping changes
are caught without a live platform:

```json
{
  "name": "inbound text",
  "channel": "telegram",
  "upstreamVersion": "7.10.0",
  "payload": {
    "type": "text",
    "msgId": "msg_text_1",
    "senderId": "user_123",
    "conversationId": "conv_456",
    "content": "hello harness"
  },
  "expected": {
    "type": "message.received",
    "channel": "telegram",
    "accountId": "main",
    "conversation": { "id": "conv_456", "type": "dm" },
    "sender": { "id": "user_123" },
    "message": {
      "id": "msg_text_1",
      "content": [{ "type": "text", "text": "hello harness" }]
    }
  }
}
```

Fixture format: `name`, `channel` (matching the directory name),
`upstreamVersion`, `payload` and `expected`. Load them in tests with
`loadFixture(channel, name)` from `@wsz987/channel-testkit`; the verifier
validates them with `validateFixture`.

## 7. The compatibility manifest

Each adapter should expose a `readonly manifest` field (class form) or a
`manifest` property (object form) describing what it was tested against.
The shape is structural — you never import `channel-compat`:

```ts
const manifest = {
  id: 'telegram',
  adapterVersion: '0.1.0',
  upstream: {
    reference: 'telegram bot api (official)',
    testedVersion: '7.10',
    versionRange: '>=7.0 <8.0',
    // official-sdk | official-host-neutral-subpath | minimal-official-api-port | source-port
    strategy: 'official-sdk',
    // optional: exact upstream commit SHA, required only for source-port channels
    // after the live gate passes (see the Weixin manifest).
    testedCommit: undefined,
  },
  status: 'untested', // tested | compatible | untested | unsupported | experimental
};
```

`channel-compat` reads this structurally via `getAdapterManifest` and
governs the state:

| State | Meaning | Verdict |
| --- | --- | --- |
| `tested` | verified against `testedVersion` (contract + fixtures) | ok |
| `compatible` | believed compatible with `versionRange` | ok |
| `untested` | default when there is no evidence | warning |
| `experimental` | declared but not yet live-verified | warning |
| `unsupported` | declared unsupported | fail (warning with `--allow-unsupported`) |

Start new adapters at `untested`; promote to `tested` once the contract
suite and fixtures pass against a real upstream version.

## 8. Verification with `pnpm verify`

The `@wsz987/channel-verify` package is the in-repo form of
`dsh channels verify ./my-adapter`. It runs offline, so it works in CI:

```bash
pnpm verify ./packages/channel-telegram          # checks only
pnpm verify ./packages/channel-telegram --test   # also runs pnpm test
pnpm verify ./my-adapter --allow-unsupported     # tolerate unsupported state
```

Checks (each produces ok/warning/fail items; any `fail` fails the run):

1. **package** — package.json parses; name/version/main/types/exports present;
   a declared `dsh.bundle.patch` file exists.
2. **adapter surface** — imports the package entry and finds an exported
   adapter (a class instance-able without args, a class constructible via the
   module's `Config` factory, or a `defineChannelAdapter` object) exposing
   id/capabilities/start/stop/send; reports the found id.
3. **manifest** — `getAdapterManifest` + `validateManifest`;
   `versionState`/`manifestVerdict` (tested/compatible ok, untested
   warning, unsupported fail unless `--allow-unsupported`).
4. **capabilities** — all flags are booleans; `streaming` ∈
   {native, edit, buffered}.
5. **fixtures** — sweeps `fixtures/<channel>/*.json` with
   `validateFixture`; each file must carry name/upstreamVersion/payload/
   expected and a `channel` matching its directory.
6. **credentials** — scans `src/**` and `fixtures/**` for secret-like
   assignments (token/secret/password/api-key/authorization); warns per hit
   and never prints matched values (known placeholders like
   `TEST_TOKEN_PLACEHOLDER`, `<token>`, `xxx` are ignored).
7. **contract** — with `--test`, spawns `pnpm test` in the adapter dir and
   requires exit 0; otherwise an informational ok item notes the suite runs
   via the package test script.

Exit code: 0 when there are no fail items, 1 otherwise (warnings do not fail).

## 9. Maturity levels

The suggested lifecycle (see [channel-roadmap.md](architecture/channel-roadmap.md) — 第三方成熟度):

```text
Experimental → Beta → Stable → Verified
```

**Verified** requires all of:

- Contract tests (`runChannelAdapterContract`)
- lifecycle coverage (start/stop idempotency, health)
- fixtures (payload mapping regression)
- no plaintext credentials (verified by the credentials check)
- health reporting
- reconnect/backoff
- duplicate protection (dedup)
- capabilities negotiation
- compatibility manifest (status `tested`)
- docs
- example (config + usage)

`pnpm verify ./my-adapter --test` is the gate: a clean report (no fail
items) plus a passing test suite is the practical definition of Verified.

## 10. Exposing the adapter via the DSH bundle patch

The `dsh.bundle.patch` field in package.json points at a small YAML file that
inserts the adapter into a DeepSeek Harness profile (mirror the official
`packages/channels/cordis.patch.yml`):

```yaml
- insert:
    - id: channels-telegram
      name: '@wsz987/channel-telegram'
      inject:
        - channels
```

The adapter package itself exports the Cordis plugin shape —
`export const name = 'channel-telegram';`, `export const inject = ['channels'];`
and `export function apply(ctx, config, deps)` — which registers the adapter
with `ctx.channels` inside `ctx.effect` and wires the `ChannelAdapterContext`
(emit via the service, logger, in-memory secrets/storage, an AbortController
signal). Users enable/disable the channel through its plugin config
(`plugins.channel-telegram.enabled = false`).

## 11. Publishing checklist

1. Rename the template placeholders and replace `workspace:*` ranges.
2. Implement config/mapper/upstream/adapter against the contract.
3. Add fixtures and make the contract suite pass (`pnpm test`).
4. Fill in the compatibility manifest; set `status` honestly.
5. Run `pnpm verify . --test` (or `pnpm verify ./packages/<name> --test`
   in-repo) until the report is clean.
6. Publish; point `dsh.bundle.patch` at your `cordis.patch.yml`.
