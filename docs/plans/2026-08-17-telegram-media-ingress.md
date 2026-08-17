# Telegram Media Ingress Implementation Plan

**Goal:** Make Telegram images and files reliably enter the shared Harness attachment pipeline while keeping Telegram albums as independent, ordered updates.

**Architecture:** Telegram remains responsible only for resolving Bot API `file_id` handles into trusted bytes and metadata. `channel-harness` continues to convert images through Harness `attachments.saveImage`, while `channel-files` stores and extracts generic files. Messages sharing `media_group_id` are not buffered or merged; each update is dispatched and acknowledged independently.

**Tech Stack:** TypeScript, Telegram Bot API HTTP transport, Channel Contract `MessagePart`, Harness attachment API, Vitest.

---

### Task 1: Preserve binary response metadata

**Files:**
- Modify: `packages/channel-telegram/src/transport.ts`
- Modify: `packages/channel-telegram/src/upstream.ts`
- Test: `packages/channel-telegram/test/adapter.test.ts`

1. Add a structured binary response containing `data`, optional `contentType`, and optional `contentDisposition`.
2. Make `FetchTransport.requestBinary` retain safe response metadata.
3. In `downloadFile`, prefer explicit platform metadata, then HTTP metadata, then infer MIME and filename from Telegram `file_path`.
4. Verify photos resolve to a supported image MIME even when `getFile` returns only `file_path`.

### Task 2: Preserve captions as structured text

**Files:**
- Modify: `packages/channel-telegram/src/mapper.ts`
- Test: `packages/channel-telegram/test/adapter.test.ts`
- Modify: `fixtures/telegram/inbound-image.json`

1. Map a media caption to a `text` part followed by the binary part.
2. Keep media order deterministic and avoid duplicating captions.
3. Confirm ordinary documents and photos both preserve captions.

### Task 3: Specify independent album delivery

**Files:**
- Test: `packages/channel-telegram/test/adapter.test.ts`
- Modify: `packages/channel-telegram/README.md`

1. Add a test with two updates sharing one `media_group_id`.
2. Assert they emit as two ordered channel events and each image is hydrated independently.
3. Document that Telegram albums are intentionally delivered image-by-image to preserve per-update retry and acknowledgement behavior.

### Task 4: Verify shared pipeline compatibility

**Files:**
- Test: `packages/channel-telegram/test/adapter.test.ts`
- Existing shared tests: `packages/channel-harness/test/message-converter-image.test.ts`, `packages/channel-harness/test/message-converter-file.test.ts`

1. Assert hydrated Telegram photos carry `localData` plus a supported image MIME.
2. Assert hydrated Telegram documents carry `localData`, name, MIME, and size for `ChannelFileProvider`.
3. Run Telegram tests, Telegram typecheck/build, shared Harness/file tests, adapter verification, and repository CI gates proportional to the change.
