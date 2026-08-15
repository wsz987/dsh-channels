import { describe, expect, it } from 'vitest';
import {
  collectText,
  textParts,
  type AudioPart,
  type BinaryIngressFailureCode,
  type BinaryPartBase,
  type FilePart,
  type ImagePart,
  type MessagePart,
  type VideoPart,
} from '../src/index.js';
import { assertSafeMediaUrl } from '../src/media/remote-policy.js';
import { toIngressFailureCode } from '../src/media/bounded-response.js';
import { SecureRemoteMediaFetcher } from '../src/media/secure-fetcher.js';

describe('BinaryPartBase contract', () => {
  it('is implemented by image / file / audio / video parts', () => {
    const image: ImagePart = { type: 'image', url: 'https://example.com/a.png', alt: 'a' };
    const file: FilePart = { type: 'file', name: 'doc.pdf', size: 100 };
    const audio: AudioPart = { type: 'audio', url: 'https://example.com/a.mp3', durationMs: 3000 };
    const video: VideoPart = { type: 'video', dataUri: 'data:video/mp4;base64,AAAA', durationMs: 5000 };

    // All four silently conform to the shared carrier base.
    const bases: BinaryPartBase[] = [image, file, audio, video];
    expect(bases).toHaveLength(4);
    // Type discriminants + extra fields are preserved.
    expect(image.alt).toBe('a');
    expect(audio.durationMs).toBe(3000);
    expect(video.durationMs).toBe(5000);
  });

  it('carries every BinaryPartBase field', () => {
    const part: ImagePart = {
      type: 'image',
      url: 'https://example.com/a.png',
      resourceRef: 'img_v2_abc',
      mimeType: 'image/png',
      name: 'a.png',
      size: 123,
      dataUri: 'data:image/png;base64,AAAA',
      localData: new Uint8Array([1, 2, 3]),
      ingressFailure: 'too-large',
      alt: 'alt text',
    };
    expect(part.resourceRef).toBe('img_v2_abc');
    expect(part.localData).toHaveLength(3);
    expect(part.ingressFailure).toBe('too-large');
  });

  it('advertises the full BinaryIngressFailureCode union export', () => {
    const codes: readonly BinaryIngressFailureCode[] = [
      'too-large',
      'download-failed',
      'decrypt-failed',
      'integrity-failed',
      'mime-invalid',
      'resource-unavailable',
    ];
    expect(codes).toHaveLength(6);
    const part: ImagePart = { type: 'image', ingressFailure: 'download-failed' };
    expect(part.ingressFailure).toBe('download-failed');
  });
});

describe('url vs resourceRef contract', () => {
  it('treats a platform opaque handle (resourceRef) as non-fetchable by the secure fetcher', async () => {
    // A Lark image_key / Telegram file_id / DingTalk mediaId is an opaque
    // handle, not a URL: generic URL parsing must not turn it into a fetch.
    const opaqueHandle = 'img_v2_9f0a-3f9c-4b7e-8d2a-filekey';
    await expect(assertSafeMediaUrl(opaqueHandle)).rejects.toBeTruthy();
  });

  it('lets only a genuine http(s) url through the secure fetcher, never resourceRef', async () => {
    const fetcher = new SecureRemoteMediaFetcher({
      fetch: async () => {
        throw new Error('fetch must never be called for a resourceRef');
      },
    });

    // A resourceRef-only part has no url carrier; only url (a genuine http(s)
    // URL) is ever passed to fetchBounded. Passing an opaque handle here would
    // be rejected by assertSafeMediaUrl before any network call.
    const part: ImagePart = { type: 'image', resourceRef: 'img_v2_xyz' };
    expect(part.url).toBeUndefined();
    await expect(fetcher.fetchBounded('img_v2_xyz', { maxBytes: 1024 })).rejects.toBeTruthy();
  });

  it('encodes the rule — a resourceRef-only part has no fetchable url', () => {
    const resourceRefOnly: ImagePart = {
      type: 'image',
      resourceRef: 'file_id_12345',
    };
    // Type-level guarantee: there is no generic URL to fetch from a resourceRef.
    expect(resourceRefOnly.url).toBeUndefined();
    expect(resourceRefOnly.dataUri).toBeUndefined();
    expect(typeof resourceRefOnly.resourceRef).toBe('string');
  });

  it('maps the fetcher rejection of a non-http opaque handle to resource-unavailable', async () => {
    try {
      await assertSafeMediaUrl('img_v2_invalid');
      expect.unreachable('should have rejected the opaque handle');
    } catch (err) {
      expect(toIngressFailureCode(err)).toBe('resource-unavailable');
    }
  });
});

describe('collectText / textParts (unchanged behavior)', () => {
  it('collects text with the same semantics as before the refactor', () => {
    const parts: MessagePart[] = [
      { type: 'text', text: 'hi ' },
      { type: 'image', resourceRef: 'key', ingressFailure: 'download-failed' },
      { type: 'text', text: 'there' },
    ];
    expect(collectText(parts)).toBe('hi there');
    expect(textParts('alone')).toEqual([{ type: 'text', text: 'alone' }]);
  });
});
