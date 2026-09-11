/**
 * Image mirror (issue #7): the bridge's saveImage hook mirrors inbound image
 * bytes into the private asset store under the HARNESS attachment id (the
 * model-visible `sha256:…` ref id), so `send_channel_message` can resolve the
 * image for outbound sends. The harness image seam stays authoritative.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelFileService } from '../src/service.ts';
import { resolveAttachment } from '../src/attachment-resolver.ts';

// Isolate the file-backed asset store from the developer's real DSH home.
let dshHome = '';
beforeAll(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-image-mirror-'));
  process.env.DSH_HOME = dshHome;
});

function context(overrides: Partial<Parameters<ChannelFileService['storeImage']>[0]> = {}) {
  return {
    sessionId: 'session-1',
    channelId: 'telegram',
    accountId: 'main',
    conversationId: 'chat-1',
    messageId: 'm-1',
    ...overrides,
  };
}

describe('ChannelFileService.storeImage (issue #7 image mirror)', () => {
  it('stores under the harness attachment id and resolves back as kind image', async () => {
    const service = new ChannelFileService(new Context());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const descriptor = await service.storeImage(context(), {
      attachmentId: 'sha256:abc123',
      data: bytes,
      mimeType: 'image/jpeg',
      name: 'photo.jpg',
    });

    expect(descriptor).toMatchObject({
      attachmentId: 'sha256:abc123',
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      bytes: 4,
      durable: true,
      readable: false,
    });

    // The outbox path resolves the model-visible id directly, session-ACL'd.
    const resolved = await resolveAttachment('sha256:abc123', 'session-1', service.storeBackend, {});
    expect(resolved).toMatchObject({
      kind: 'image',
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
    });
    expect(Array.from(resolved.data)).toEqual([1, 2, 3, 4]);
  });

  it('refuses a foreign-session read of a mirrored image (ACL preserved)', async () => {
    const service = new ChannelFileService(new Context());
    await service.storeImage(context(), {
      attachmentId: 'sha256:def456',
      data: new Uint8Array([9, 9]),
      mimeType: 'image/png',
    });
    await expect(
      resolveAttachment('sha256:def456', 'session-2', service.storeBackend, {}),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_ACCESS_DENIED' });
  });

  it('derives a sanitized name when none is supplied', async () => {
    const service = new ChannelFileService(new Context());
    const descriptor = await service.storeImage(context(), {
      attachmentId: 'sha256:789',
      data: new Uint8Array([1]),
      mimeType: 'image/png',
    });
    expect(descriptor?.name).toBeTruthy();
    expect(descriptor?.name.length).toBeGreaterThan(0);
  });
});
