/**
 * M4 put-then-extract integration (plan §50).
 *
 * storeBinaryPart + the registry-backed extractor on a REAL store: a txt file
 * is put, then the extractor runs putExtracted so the stored asset's
 * extraction.status becomes ready and readExtracted returns the text. Audio /
 * video are left unsupported and never run the extractor.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileChannelInboundAssetStore } from '../src/attachments/store.js';
import { storeBinaryPart } from '../src/attachments/pipeline.js';
import { createAttachmentExtractor } from '../src/attachments/pipeline-extractor.js';
import { DEFAULT_ATTACHMENT_POLICY } from '../src/attachments/policy.js';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-pipe-'));
}

function context(sessionId = 's1') {
  return {
    sessionId,
    channelId: 'weixin',
    accountId: 'main',
    conversationId: 'u1',
    conversationType: 'dm' as const,
    messageId: 'm-1',
  };
}

describe('pipeline two-phase extraction (plan §50)', () => {
  it('puts a txt file then extracts it to ready via putExtracted', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      const extractor = createAttachmentExtractor(DEFAULT_ATTACHMENT_POLICY);
      const descriptor = await storeBinaryPart(
        store,
        context(),
        { type: 'file', name: 'hello.txt', mimeType: 'text/plain', localData: new TextEncoder().encode('hello extractor') },
        { extractor },
      );
      expect(descriptor?.readable).toBe(true);
      // Two-phase: extracted.md exists and readExtracted returns the text.
      const extracted = await store.readExtracted(descriptor!.attachmentId, {
        maxBytes: DEFAULT_ATTACHMENT_POLICY.extract.maxOutputBytes,
      });
      expect(extracted).toContain('hello extractor');
      const meta = await store.get(descriptor!.attachmentId);
      expect(meta?.extraction.status).toBe('ready');
      expect(meta?.extraction.format).toBe('text');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records unsupported for audio/video (no extraction attempted)', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      const extractor = createAttachmentExtractor(DEFAULT_ATTACHMENT_POLICY);
      const parts: Array<{ type: 'audio' | 'video'; durationMs: number; localData: Uint8Array }> = [
        { type: 'audio', durationMs: 100, localData: new Uint8Array([1, 2, 3]) },
        { type: 'video', durationMs: 50, localData: new Uint8Array([4, 5]) },
      ];
      for (const part of parts) {
        const descriptor = await storeBinaryPart(store, context(), part as any, { extractor });
        const meta = await store.get(descriptor!.attachmentId);
        expect(meta?.extraction.status).toBe('unsupported');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('an extractor added as an optional hook can be omitted (no extraction)', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      // No extractor hook -> store put only, status stays not-needed (M3 behavior).
      const descriptor = await storeBinaryPart(store, context(), {
        type: 'file',
        name: 'plain.pdf',
        mimeType: 'application/pdf',
        localData: new TextEncoder().encode('%PDF-1.4'),
      });
      const meta = await store.get(descriptor!.attachmentId);
      expect(meta?.extraction.status).toBe('not-needed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
