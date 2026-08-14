# Channel Adapter Template

A minimal, working scaffold for a third-party DeepSeek Harness channel adapter.
It mirrors the structure of the official adapters (`packages/channel-qq` is a
good reference) and builds on the stable Channel Contract in
`@dsh/channel-core`.

See **[docs/adapter-authoring.md](../../docs/adapter-authoring.md)** for the full
authoring guide (contract, fixtures, compatibility manifest, verification,
maturity levels).

## Quick start

1. Copy the scaffold to your adapter location:

   ```bash
   cp -r templates/channel-adapter packages/channel-telegram
   # or: cp -r templates/channel-adapter my-adapter-repo
   ```

2. Rename the placeholders (search for `<channel>`, `<ChannelName>` and
   `ChannelNameAdapter` in the copied tree):

   | Placeholder | Replace with (example) |
   | --- | --- |
   | `<channel>` | `telegram` |
   | `<ChannelName>` | `Telegram` |
   | `ChannelNameAdapter` | `TelegramAdapter` |
   | `fixtures/example/` | `fixtures/telegram/` |

   The `example` channel id used by `fixtures/example/` and
   `test/adapter.test.ts` is the concrete sample the fixtures need; rename it
   to your real channel id too.

3. Replace the `workspace:*` dependency ranges with real published ranges:

   ```json
   "dependencies": {
     "@dsh/channel-core": "^0.3.0",
     "@deepseek-ai/cordis": "^4.0.1",
     "@deepseek-ai/schemastery": "^3.18.1"
   },
   "devDependencies": {
     "@dsh/channel-testkit": "^0.2.0",
     "rimraf": "^6.0.0"
   }
   ```

   Inside the monorepo (e.g. `packages/channel-telegram`) `workspace:*` is
   correct and needs no change.

4. Implement your channel:
   - `src/config.ts` — deployment-tunable settings (Schemastery).
   - `src/upstream.ts` — the only module that talks to the platform
     (SDK / gateway / protocol); keeps platform knowledge out of the adapter.
   - `src/mapper.ts` — pure mapping of raw payloads → Channel Contract.
   - `src/adapter.ts` — the `ChannelAdapter` lifecycle (start/stop/send,
     receive loop, dedup, reconnect).
   - `src/index.ts` — exports + the Cordis plugin shape (`name`/`inject`/`apply`)
     and an optional `defineChannelAdapter` default export example.
   - `fixtures/<channel>/*.json` — recorded payloads + expected events.

5. Run the tests (contract suite + fixture-driven mapper tests + lifecycle):

   ```bash
   pnpm install
   pnpm test
   ```

6. Verify the adapter (requires `@dsh/channel-verify`):

   ```bash
   pnpm verify ./packages/channel-telegram --test
   ```

## What the scaffold provides

- **Config** — Schemastery `Config` factory mirroring the official adapters
  (enabled, accountId, baseUrl, timeoutMs, longPollTimeoutMs, reconnect
  backoff, dedup window).
- **Transport** — `HttpTransport` interface + `FetchTransport`; the single
  injection point for tests (swap in a fake, never touch the network).
- **Upstream** — `ChannelUpstream` (start/stop/receive/sendText/sendMedia)
  with an HTTP implementation over the transport.
- **Adapter** — `ChannelNameAdapter` implementing `ChannelAdapter`: id,
  capabilities, `readonly manifest`, start/stop/send/getHealth, receive loop
  with dedup (`InboundProcessor`) and exponential reconnect backoff.
- **Mapper** — `mapInbound` (raw → `MessageReceived`), `toTextPayload`
  (outbound), `dedupKey`.
- **Plugin shape** — `name`/`inject`/`apply` + the DSH bundle patch file
  `cordis.patch.yml` that inserts the adapter into a Harness profile.
- **Tests** — fixture-driven mapper tests, upstream tests, adapter lifecycle
  tests and the `runChannelAdapterContract` suite.
- **Fixtures** — `fixtures/example/` with text/image/unknown/duplicate cases.

## Layout

```text
templates/channel-adapter/
├─ package.json          # package metadata + dsh.bundle patch reference
├─ tsconfig.json           # strict TS, lib output
├─ cordis.patch.yml      # DSH bundle insert block for this adapter
├─ README.md
├─ src/
│  ├─ index.ts          # exports + Cordis plugin shape + defineChannelAdapter example
│  ├─ config.ts          # Schemastery config
│  ├─ transport.ts      # HttpTransport / FetchTransport
│  ├─ upstream.ts       # ChannelUpstream + HTTP implementation
│  ├─ adapter.ts        # ChannelNameAdapter (ChannelAdapter lifecycle)
│  └─ mapper.ts          # raw → MessageReceived + dedupKey
├─ test/
│  └─ adapter.test.ts    # mapper/upstream/lifecycle + contract suite
└─ fixtures/
   └─ example/           # sample fixtures (rename to your channel)
      ├─ inbound-text.json
      ├─ inbound-image.json
      ├─ inbound-unknown.json
      └─ duplicate.json
```

## Notes

- The template is **outside** the pnpm workspace (`templates/` is not in
  `pnpm-workspace.yaml`), so it is never built by turbo — it is a static
  scaffold you copy out.
- `workspace:*` dependencies only resolve inside the monorepo; when publishing
  standalone, replace them with real version ranges (step 3).
- The adapter must never call Harness Agent APIs (`ctx.agents...`) and must
  never embed raw platform payloads in what the model sees — map everything
  through the Channel Contract.
