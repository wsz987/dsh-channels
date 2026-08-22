# Upstream Contract Fixtures — weixin @ 2.4.6

Sanitized protocol fixtures captured from the published Tencent source contract
for M0 (Upstream Boundary Lock). They record wire shapes, not live traffic, and
must remain usable without Tencent credentials or network access.

## What will live here

- `raw-inbound/` — sanitized raw inbound samples as delivered by the official
  upstream for this channel/version (message envelopes, stream frames, login /
  monitor events). These are the platform-behavior oracle inputs the adapter
  must map.
- `platform-errors/` — representative upstream error payloads (ret/errcode,
  error codes, stream ack cases) the adapter must recognize.
- `upload-send-expected-shape/` — expected outbound payload shapes (upload
  request bodies / send-message payloads) that DSH adapter output must match.

## No-secrets rule (binding)

These fixtures are checked into a public repository. They MUST NOT contain:

- real tokens / credentials / bearer strings
- real signed URLs
- real user ids / app ids / open ids / secrets

Every fixture uses fake-but-channel-shaped placeholder tokens (example values)
so tests can run offline without any live credential.

## How these fixtures are used

The package-local `upstream-fixtures.test.ts` validates this tree as an offline
compatibility oracle. It intentionally does not use the legacy
`fixtures/<channel>/*.json` format: these are raw iLink protocol payloads,
whereas legacy fixtures are mapped Channel Contract events.

The outbound `aes_key` fixtures use Tencent 2.4.6's source-confirmed encoding:
base64 of the 32-character ASCII hex key. Live delivery remains a separate
release gate and is not implied by these offline fixtures.


Pinned upstream: `@tencent-weixin/openclaw-weixin@2.4.6` (repo `Tencent/openclaw-weixin`).
