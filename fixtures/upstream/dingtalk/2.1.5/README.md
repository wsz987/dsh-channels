# Upstream Contract Fixtures — dingtalk @ 2.1.5

Directory placeholder for Milestone M0 (Upstream Boundary Lock).

This directory is a **skeleton** established by M0. Actual payload fixtures do
NOT exist here yet — they are produced by later milestone work (per-channel
upstream consolidation + contract capture). The structure below documents WHAT
will live here.

## What will live here

- `raw-inbound/` — sanitized raw inbound samples as delivered by the official
  upstream for this channel/version (message envelopes, stream frames, login /
  monitor events). These are the platform-behavior oracle inputs the adapter
  must map.
- `media/` or `normalized-media-metadata/` — normalized media metadata derived
  from official upstream media references (download URL / encryption params /
  upload slot shape) — NOT the algorithm, only the data shape.
- `target-mapping/` — real target/conversation/sender id shapes produced by the
  upstream (conversation_id, open_id, session ids, etc.) and their mapping into
  the Channel Contract `ChannelTarget`.
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

They feed the channel offline contract suites (`pnpm test` /
`pnpm check:fixtures`) as the compatibility oracle — the shape DSH adapter
mapping is tested against — and later the `contractFixtures` entries in
`packages/channel-compat/src/upstream-manifest.ts`.


Inbound stream package `dingtalk-stream@2.1.5`. This directory holds stream-frame/client-shape fixtures; `fixtures/upstream/dingtalk/0.8.24/` holds the OAPI send/card payload oracle.
