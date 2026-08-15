---
'@wsz987/dsh-channels': minor
'@wsz987/channel-weixin': minor
'@wsz987/channel-qq': minor
'@wsz987/channel-dingtalk': minor
'@wsz987/channel-lark': minor
'@wsz987/channel-core': minor
'@wsz987/channel-harness': minor
'@wsz987/channel-files': minor
---

M8 hardening — upstream-first consolidation, native image ingress for all four channels, and the generic-file asset pipeline.

- **Upstream boundary lock (M0/M1/M2A/M7)**: each channel is verified against a fixed `UPSTREAM_MANIFESTS` entry; `channels doctor` now emits a per-channel upstream section (`Channel:` / `upstream =` / `strategy =` / `status = compatible`).
- **Native image ingress (QQ / Lark / DingTalk)**: inbound images are hydrated to `ImagePart.localData` and feed the existing Harness `saveImage()` / `ImageBlock` path — no channel-harness platform branches.
- **Generic file understanding**: optional `@wsz987/channel-files` extension provides the private Channel Asset Store, mature PDF / DOCX / XLSX / text extractors, and the `read_channel_attachment` Harness tool (no `file_path` surfaced to the model).
- **Binding v3**: session bindings migrate to v3; the optional file extension enforces Session ACLs for stored assets.
- **Durable outbox**: `send_channel_message` Harness tool with per-channel proactive capability (Lark / QQ active; DingTalk SDK-mode active, gateway-mode fail-closed).
- Weixin treats `@tencent-weixin/openclaw-weixin@2.4.6` as a source reference only. Its OpenClaw-coupled runtime is not installed; the iLink implementation remains an explicit DSH source-port/upstream-gap.
