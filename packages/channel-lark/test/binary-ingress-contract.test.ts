/**
 * Multi-channel binary ingress contract for Lark.
 *
 * Every case drives the REAL inbound entry — `InboundProcessor.handle(raw)` —
 * mirroring `test/media-hydration.test.ts`: a fake `LarkMediaPort` returns
 * deterministic bytes for the fixture's opaque resource handles, the emitted
 * `message.received` is captured from a `ChannelService` listener and
 * returned to the runner.
 *
 * Fixture-driven cases (existing fixtures only):
 * - video `inbound-video` — `mediaUrl` is an opaque file_key -> mapped to
 *   `resourceRef` -> media port `messageResource.get` -> localData. Marked
 *   `bytes` (and backed by `capabilities.media.inbound.video === 'bytes'`).
 * - image `inbound-image` / audio `inbound-audio` — the fixture locators are
 *   genuine http(s) URLs (`picUrl` / `mediaUrl`), which the mapper places on
 *   the `url` carrier; Lark's `MediaHydrator` resolves ONLY
 *   `resourceRef` handles through the media port, so through the
 *   real ingress these fixtures truthfully yield a URL LOCATOR, never bytes.
 *   Asserting `bytes` here would claim something the real fixture cannot
 *   produce, so the honest §32 state is `locator` (URL retained, no fabricated
 *   bytes, no unstable failure). The resourceRef->bytes path for image/audio
 *   is covered by test/media-hydration.test.ts with SDK opaque-key payloads;
 *   a `bytes` case needs an SDK-shaped fixture, which does not exist yet.
 * - file `inbound-file`: no fixture -> SKIPPED (plan: prefer documented skips
 *   over invented fixtures).
 */
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, type MessageReceived } from '@wsz987/channel-core';
import { createTestContext, runBinaryIngressContract } from '@wsz987/channel-testkit';
import {
  Config,
  InboundProcessor,
  LarkAdapter,
  type LarkMediaPort,
  type LarkResourceType,
} from '../src/index.ts';
import type { LarkConfig } from '../src/config.ts';

function makeConfig(overrides: Partial<LarkConfig> = {}): LarkConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    timeoutMs: 1000,
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
    dedup: { enabled: false, windowMs: 5000 },
    card: { createOnFirstDelta: true, typingIndicator: false },
    upstream: { appId: 'cli_binary' },
    ...overrides,
  });
}

const meta = { channel: 'lark' as never, accountId: 'main' as never };

/** Fake media port: deterministic bytes for any opaque resource key. */
class FakeMediaPort implements LarkMediaPort {
  async downloadMessageResource(input: {
    messageId: string;
    resourceKey: string;
    type: LarkResourceType;
    signal?: AbortSignal;
  }): Promise<{ data: Uint8Array; mimeType?: string; name?: string }> {
    return {
      data: new Uint8Array([0x1a, 0x2b, 0x3c, 0x4d, ...Buffer.from(`key:${input.resourceKey}`)]),
      mimeType: 'video/mp4',
      name: 'fixture.mp4',
    };
  }

  uploadImage(): Promise<{ imageKey: string }> {
    return Promise.resolve({ imageKey: 'img_v2_up' });
  }

  uploadFile(): Promise<{ fileKey: string }> {
    return Promise.resolve({ fileKey: 'file_v2_up' });
  }
}

runBinaryIngressContract({
  adapter: new LarkAdapter(makeConfig()),
  cases: [
    // inbound-image: picUrl is a genuine https URL -> url carrier; Lark does
    // not fetch url carriers, so the truthful post-ingress state is a URL
    // locator (no fabricated bytes), not bytes.
    { kind: 'image', expected: 'locator', fixture: 'inbound-image', channel: 'lark' },
    // inbound-audio: mediaUrl is a genuine https URL -> url carrier; same
    // locator semantics as image above.
    { kind: 'audio', expected: 'locator', fixture: 'inbound-audio', channel: 'lark' },
    // inbound-video: mediaUrl is an opaque file_key -> resourceRef -> media
    // port -> localData. Capability-consistent bytes claim.
    { kind: 'video', expected: 'bytes', fixture: 'inbound-video', channel: 'lark' },
    // file: no fixtures/lark/inbound-file.json -> SKIPPED (documented above).
  ],
  deliver: async (raw): Promise<MessageReceived> => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const processor = new InboundProcessor({
      ctx,
      meta,
      dedupEnabled: false,
      dedupWindowMs: 5000,
      now: () => 1000,
      mediaPort: new FakeMediaPort(),
    });
    let captured: MessageReceived | undefined;
    service.on((event) => {
      if (event.type === 'message.received') captured = event;
    });
    await processor.handle(raw);
    if (!captured) throw new Error('no message.received emitted for lark fixture');
    return captured;
  },
});