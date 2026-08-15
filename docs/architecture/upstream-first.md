# Upstream-First — dsh-channels Channel Platform Boundary (Milestone M0)

> Output of **Milestone M0 — Upstream Boundary Lock** (plan section 77).
> Authority: `docs/dsh-channels-final-execution-plan-2026-08-16-FINAL.md`.

Project reference noted in plan section 106: code `dsh-channels@eddab2996ab47a7559f6c1135b3e40be9e5cc68b` (main). Executed at baseline `HEAD = de30e10b795ceaf0a609b1a70cc5e8e939a01a37`.

---

## 1. The Upstream-First Principle (plan section 0)

`dsh-channels` is **DeepSeek Harness 对官方渠道实现的 Adapter / Bridge** — an adapter/bridge over official platform implementations, **not** a re-implementation of the WeChat / QQ / DingTalk / Lark platform protocol.

```text
DeepSeek Harness 专属能力
        +
官方渠道 SDK / host-neutral upstream
        ↓
极薄 Channel Adapter
```

Rather than:

```text
看官方 OpenClaw 插件源码 → 在 dsh-channels 再实现一套平台协议
```

Red line (plan section 0):

> **DSH 自己做宿主适配，不重新实现平台协议。**
> DSH itself does host adaptation; it does not re-implement platform protocol.

| Rule | Location |
| --- | --- |
| Official SDK / host-neutral upstream is the platform-behavior Source of Truth | plan section 3.2 |
| DSH adapter only maps, bridges lifecycle, declares capability, wires into Harness | plan section 5 (architecture) |
| At most one thin port per channel; the port never re-implements official AES / streaming / upload / token behavior | plan section 7 |
| Compatibility Facade never copies protocol algorithms | plan section 38 |
| Duplicate self-implemented platform code is consolidated toward upstream, never removed wholesale | plan section 19 / 20 |
| No-protocol-reimplementation policy is recorded as an ADR | `docs/architecture/adr/0001-upstream-first-channel-platform-boundary.md` |

---

## 2. Fixed Upstream Compatibility Baseline (plan section 4)

The four channels' official upstream versions are pinned at M0 and recorded programmatically in `packages/channel-compat/src/upstream-manifest.ts`. Later milestones and `channels doctor` compare against exactly these values.

| Channel | Upstream package | Tested version | Strategy | Source repository |
| --- | --- | --- | --- | --- |
| weixin | `@tencent-weixin/openclaw-weixin` (source reference only) | `2.4.6` | `source-port` | `Tencent/openclaw-weixin` |
| qq | plugin `@tencent-connect/openclaw-qqbot` | `2.0.1` | `official-sdk` | `tencent-connect/openclaw-qqbot` |
| qq | sdk `@tencent-connect/qqbot-nodejs` | `1.0.4` | — (SDK consumed) | — |
| lark | plugin `@larksuite/openclaw-lark` | `2026.7.9` | `official-sdk` | `larksuite/openclaw-lark` |
| lark | sdk `@larksuiteoapi/node-sdk` | `1.73.0` | — (SDK consumed) | — |
| dingtalk | stream `dingtalk-stream` | `2.1.5` | `minimal-official-api-port` | `DingTalk-Real-AI/dingtalk-openclaw-connector` |
| dingtalk | oracle connector `@dingtalk-real-ai/dingtalk-connector` | `0.8.24` | — (behavior oracle) | — |

These values are exactly the manifest entries validated by `packages/channel-compat/test/upstream-manifest.test.ts` (plan section 39).

---

## 3. Per-Channel Strategy (plan section 39)

| Channel | Strategy | Meaning |
| --- | --- | --- |
| **qq** | `official-sdk` | Consume `@tencent-connect/qqbot-nodejs@1.0.4` directly (Token, WebSocket gateway, media, streaming). No in-source gateway protocol, no OpenClaw runtime dependency. |
| **lark** | `official-sdk` | Consume `@larksuiteoapi/node-sdk@1.73.0` directly. Inbound via WebSocket long-connection + `EventDispatcher`; outbound via the same SDK's OpenAPI client. |
| **weixin** | `source-port` | Tencent's published plugin is coupled to the OpenClaw runtime. It is a source reference only; `dsh-channels` deliberately does not install it or deep-import its `dist` internals until a host-neutral upstream package exists. |
| **dingtalk** | `minimal-official-api-port` | Inbound via `dingtalk-stream@2.1.5`; OpenAPI / media / card payloads mirror the official `@dingtalk-real-ai/dingtalk-connector@0.8.24` (the behavior oracle) — the connector is not a runtime dependency, only a payload oracle. |

`channels doctor` output contract per plan section 39:

```text
QQ        upstream = @tencent-connect/qqbot-nodejs@1.0.4    strategy = official-sdk                  status = compatible
Lark      upstream = @larksuiteoapi/node-sdk@1.73.0         strategy = official-sdk                  status = compatible
Weixin    upstream = @tencent-weixin/openclaw-weixin@2.4.6  strategy = source-port  status = compatible
DingTalk  upstream = dingtalk-stream@2.1.5 + official-api-port   oracle = @dingtalk-real-ai/dingtalk-connector@0.8.24  status = compatible
```

---

## 4. Current Duplicate-Protocol Inventory

Audit performed against the code at baseline `de30e10`. Each self-implemented platform module is classified as:

- **(A) DSH glue** — host/DSH behavior (mapping, lifecycle, orchestration, storage); valid to keep, no upstream duplicate.
- **(B) official SDK wrapper** — a thin seam over an official SDK / host-neutral module; valid to keep as a facade/port.
- **(C) duplicate protocol implementation** — re-implements wire protocol / media / AES / payload owned by an official upstream; must be consolidated toward upstream (plan section 19 / 20).

### 4.1 Weixin (`packages/channel-weixin`)

| Module | What it does | Class | Recommended disposition (plan §19 / §20) |
| --- | --- | --- | --- |
| `ilink/constants.ts` | iLink endpoint paths, header names, fixed wire values (AES/CDN app-id, protocol endpoint table) | **C** | Mark upstream-gap; source from `@tencent-weixin/openclaw-weixin@2.4.6` (plan §20 endpoint table) |
| `ilink/client.ts` | Full iLink HTTP client: get_bot_qrcode / get_config / get_updates / send_message / getuploadurl endpoints + request/response shapes | **C** | Reuse the Tencent host-neutral iLink implementation via `vendor-compat`; keep a deprecated shim during the M1 transition |
| `ilink/headers.ts` | iLink HTTP header construction (Authorization, X-WECHAT-UIN, ClientVersion, SKRouteTag) | **C** | Facade/upstream reuse; delete duplicate header logic |
| `ilink/base-info.ts` | `base_info` payload build (`bot_agent` = DeepSeekHarness, channel version) | **A** | Keep as DSH glue (host identity metadata) |
| `ilink/errors.ts` | Typed iLink protocol errors + token redaction | **B** | Keep as facade (error normalization; redaction is DSH-only) |
| `ilink/types.ts` | iLink wire types (proto mirror; baseline64 cell / AES key payload shapes) | **C** | Mark upstream-gap; source from upstream proto mirror |
| `media/encrypt.ts` | AES-128-ECB encrypt (PKCS#7) | **C** | Delete duplicate; upstream owns AES (plan §20) |
| `media/decrypt.ts` | AES-128-ECB decrypt | **C** | Delete duplicate; upstream owns AES (plan §20) |
| `media/download.ts` | CDN download URL resolution + AES decrypt of the body | **C** | Reuse upstream media/CDN behavior (plan §106) |
| `media/upload.ts` | getuploadurl CGI + AES-128-ECB encrypt + ciphertext CDN upload | **C** | Reuse upstream (plan §20 getuploadurl payload); delete duplicate |
| `media/send-media.ts` | media sendmessage payload builder (encrypt_query_param / aes_key / full_url) | **C** | Delete duplicate (plan §20 sendmessage media payload); use upstream |
| `messaging/dedup.ts` | inbound dedup identity + two-phase store | **A** | Keep as DSH glue (DSH delivery semantics) |
| `messaging/mapper.ts` | pure inbound iLink map to Channel | **A** | Keep as DSH glue / pure mapper (plan §10) |
| `messaging/monitor.ts` | getUpdates loop, cursor commit, reconnect backoff | **A** | Keep as DSH glue; upstream provides getUpdates only, DSH owns the loop/ordering |
| `messaging/send.ts` | outbound build + CDN upload orchestration to sendmessage | **C** | Split: keep orchestration as glue, move payload construction to upstream |
| `messaging/typing.ts` | typing indicator (sendTyping) wrapper | **B** | Keep as thin facade (orchestration) |
| `auth/login.ts` | iLink QR login state machine (get_bot_qrcode / get_qrcode_status) | **B/C** | Facade/upstream port — QR auth is upstream-owned (plan §106); keep state normalization as glue, move wire calls to upstream |
| `auth/account-store.ts` | credential split across SecretStore + ChannelStorage | **A** | Keep as DSH glue (store boundary; never embeds secrets) |

### 4.2 DingTalk (`packages/channel-dingtalk`)

| Module | What it does | Class | Recommended disposition (plan §30/§31/§32/§34) |
| --- | --- | --- | --- |
| `stream-upstream.ts` | inbound via official `dingtalk-stream` (TOPIC_ROBOT), maps to raw shape | **B** | Keep as official SDK wrapper |
| `official-upstream.ts` | outbound: sessionWebhook + AI Card OpenAPI + access-token cache | **B** | Keep as minimal-official-api-port; strictly align payloads to the connector@0.8.24 oracle; do not grow into a second DingTalk SDK (plan §34) |
| `ai-card.ts` | AI Card streaming reply handle (create / update / finish / fail) | **B** | Keep as facade/glue over the official AI Card OpenAPI |

### 4.3 QQ (`packages/channel-qq`)

| Module | What it does | Class | Recommended disposition (plan §21/§22/§23) |
| --- | --- | --- | --- |
| `sdk-client.ts` | thin seam over official `QQBot` (`@tencent-connect/qqbot-nodejs`); prod `TencentQQSdkClient`, tests fake | **B** | Keep as official SDK wrapper (correct direction) |

### 4.4 Lark (`packages/channel-lark`)

| Module | What it does | Class | Recommended disposition (plan §25/§26/§27) |
| --- | --- | --- | --- |
| `lark-sdk-upstream.ts` | inbound via official `@larksuiteoapi/node-sdk` (EventDispatcher / WSClient) mapped to raw shape | **B** | Keep as official SDK wrapper |
| `openapi-outbound.ts` | outbound via official node-sdk OpenAPI client (message.create / image.create / patch) | **B** | Keep as official SDK wrapper |

### 4.5 Summary

- **(A) DSH glue**: `ilink/base-info.ts`, `messaging/dedup.ts`, `messaging/mapper.ts`, `messaging/monitor.ts`, `auth/account-store.ts`, plus the orchestration halves of `messaging/send.ts` and `auth/login.ts`.
- **(B) official SDK wrapper**: `ilink/errors.ts`, `messaging/typing.ts`, `auth/login.ts` (facade half), `stream-upstream.ts`, `official-upstream.ts`, `ai-card.ts`, `sdk-client.ts`, `lark-sdk-upstream.ts`, `openapi-outbound.ts`.
- **(C) duplicate protocol implementation**: the Weixin `ilink/*` protocol plus media stack (`constants.ts`, `client.ts`, `headers.ts`, `types.ts`, and `media/*` encrypt/decrypt/download/upload/send-media) and the `messaging/send.ts` payload. **Weixin is the heaviest duplication and is prioritized for upstream consolidation (plan §14 / M1).**

---

## 5. No-Protocol-Reimplementation ADR Summary

- ADR: `docs/architecture/adr/0001-upstream-first-channel-platform-boundary.md` (status **Accepted**).
- Decision core text (verbatim from plan section 105):

> dsh-channels treats official platform SDKs and official channel implementations as the owners of platform protocol semantics. dsh-channels implements only the minimum adapter layer required to expose those semantics through the Channel Contract and DeepSeek Harness. Platform protocol behavior must not be reimplemented locally when an official host-neutral implementation exists.

- Signature ADR format: **Status / Context / Decision / Consequences**.
- Consequence: existing duplicate (C) modules are consolidated toward upstream over M1+ (never removed in one large delete, plan §19); the manifest plus fixture skeleton lock the boundary so future work checks against the official upgrade contract.

---

## 6. Fixture Skeleton (plan section 73)

Placeholder skeleton directories established at M0 (README + no-secrets rule; no payload fixtures invented yet):

```text
fixtures/upstream/weixin/2.4.6/
fixtures/upstream/qq/2.0.1/
fixtures/upstream/lark/2026.7.9/
fixtures/upstream/dingtalk/0.8.24/     # OAPI payload oracle (connector @ 0.8.24)
fixtures/upstream/dingtalk/2.1.5/      # inbound dingtalk-stream @ 2.1.5 shape
```

Each will hold: raw inbound samples, normalized media metadata, target mapping, platform errors, and upload/send expected shapes. **No real tokens, signed URLs, or user/app ids** — every fixture uses fake channel-shaped placeholders so offline contract tests run without any live credential.

---

## 7. Milestone M0 Checklist (plan section 77)

- [x] Record project baseline (`dsh-channels@eddab2996`, HEAD `de30e10`).
- [x] Fix four upstream compatibility versions (section 2 above).
- [x] Build `UpstreamManifest` (`packages/channel-compat/src/upstream-manifest.ts`).
- [x] Create fixture directories (section 6; skeleton + README only).
- [x] Four-channel package dependency audit (section 2; SDK-versus-plugin distinction).
- [x] Mark all self-produced platform protocol code (section 4 table).
- [x] Classify each: DSH glue / official SDK wrapper / duplicate protocol implementation (section 4).
- [x] Add no-protocol-reimplementation ADR (section 5).
- [x] This document is the M0 output.

Next milestones: M1 Weixin Upstream Consolidation (priority), then QQ / Lark / DingTalk media hydration onto `ImagePart.localData` for the three not-yet-wired channels (plan section 1A).
