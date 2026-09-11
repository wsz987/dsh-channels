/**
 * Native Harness Generic Attachment capability seam.
 *
 * Harness 0.1.5-rc.2 has no generic attachment API, so this module only tests the
 * unavailable production capability and the explicit fake used by migration
 * tests. Runtime detection is intentionally absent until a public API exists.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_NATIVE_GENERIC_ATTACHMENT,
  FakeNativeGenericAttachmentCapability,
} from '../src/backends/harness-native.ts';

describe('NO_NATIVE_GENERIC_ATTACHMENT constant', () => {
  it('is always not-available and supports() always false', () => {
    expect(NO_NATIVE_GENERIC_ATTACHMENT.available).toBe(false);
    expect(NO_NATIVE_GENERIC_ATTACHMENT.supports('file')).toBe(false);
    expect(NO_NATIVE_GENERIC_ATTACHMENT.supports('file', 'application/pdf')).toBe(false);
    expect(NO_NATIVE_GENERIC_ATTACHMENT.supports('image')).toBe(false);
  });
});

describe('FakeNativeGenericAttachmentCapability factory', () => {
  it('defaults to not-available (mirrors NO_NATIVE_GENERIC_ATTACHMENT)', () => {
    const cap = FakeNativeGenericAttachmentCapability();
    expect(cap.available).toBe(false);
    expect(cap.supports('file')).toBe(false);
    expect(cap.supports('audio')).toBe(false);
  });

  it('available: true supports generic kinds but not image', () => {
    const cap = FakeNativeGenericAttachmentCapability({ available: true });
    expect(cap.supports('file')).toBe(true);
    expect(cap.supports('audio')).toBe(true);
    expect(cap.supports('video')).toBe(true);
    expect(cap.supports('image')).toBe(false);
  });

  it('supportedKinds restricts the accepted kinds', () => {
    const cap = FakeNativeGenericAttachmentCapability({ available: true, supportedKinds: ['file'] });
    expect(cap.supports('file')).toBe(true);
    expect(cap.supports('audio')).toBe(false);
    expect(cap.supports('video')).toBe(false);
  });

  it('supportedMimeTypes makes supports() respect kind AND MIME', () => {
    const cap = FakeNativeGenericAttachmentCapability({
      available: true,
      supportedMimeTypes: ['application/pdf'],
    });
    expect(cap.supports('file', 'application/pdf')).toBe(true);
    expect(cap.supports('file', 'image/png')).toBe(false);
    // With a MIME allow-list, a missing MIME hint is not supported.
    expect(cap.supports('file')).toBe(false);
  });

  it('available: false ignores kind/MIME configuration', () => {
    const cap = FakeNativeGenericAttachmentCapability({
      available: false,
      supportedKinds: ['file'],
      supportedMimeTypes: ['application/pdf'],
    });
    expect(cap.supports('file', 'application/pdf')).toBe(false);
    expect(cap.supports('file')).toBe(false);
  });
});
