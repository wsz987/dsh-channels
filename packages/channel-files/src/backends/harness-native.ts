/**
 * Native Harness Generic Attachment capability seam.
 *
 * This module defines the INTERFACE and the FAKE only. There is deliberately
 * NO real Harness generic attachment implementation here, because the current
 * Harness distribution only ships an IMAGE attachment seam
 * (`@deepseek-ai/dsh-attachment` SaveImageHook / ImageAttachmentRef /
 * ImageBlock) — an image-only service MUST NOT be mistaken for a generic
 * attachment surface.
 *
 * No runtime detector is exported yet: guessing future method or capability
 * names would create a false public contract. When Harness publishes a real
 * generic attachment API, its public package types/schema will define the
 * adapter and trust-boundary validation added here.
 */
import { BINARY_KINDS, type BinaryKind } from '@wsz987/channel-core';

/** Backend-neutral capability consumed by the dormant migration seam. */
export interface NativeGenericAttachmentCapability {
  /** Whether a generic attachment surface is available for use. */
  available: boolean;
  /** Whether the available backend accepts the given kind (and MIME hint). */
  supports(kind: BinaryKind, mimeType?: string): boolean;
}

/**
 * Constant production capability until Harness publishes a generic API.
 */
export const NO_NATIVE_GENERIC_ATTACHMENT: NativeGenericAttachmentCapability = {
  available: false,
  supports: () => false,
};

/**
 * Kinds the generic backend covers. `image` is deliberately excluded: images
 * belong to the Harness image seam, not to the generic attachment backend.
 */
const GENERIC_KINDS: readonly BinaryKind[] = BINARY_KINDS.filter(
  (kind) => kind !== 'image',
);

export interface FakeNativeGenericAttachmentCapabilityOptions {
  /** Defaults to `false` — a fake must opt in to availability. */
  available?: boolean;
  /** Kinds the fake accepts; defaults to the generic kinds when available. */
  supportedKinds?: readonly BinaryKind[];
  /**
   * Optional MIME allow-list. When given, `supports` requires the `mimeType`
   * argument to be present and listed (mirrors a future MIME-scoped API).
   */
  supportedMimeTypes?: readonly string[];
}

/**
 * Configurable fake capability for tests. By default (no options) it behaves
 * exactly like `NO_NATIVE_GENERIC_ATTACHMENT`; set `available: true` to
 * simulate a future generic surface.
 */
export function FakeNativeGenericAttachmentCapability(
  options: FakeNativeGenericAttachmentCapabilityOptions = {},
): NativeGenericAttachmentCapability {
  const available = options.available ?? false;
  const kinds = options.supportedKinds ?? (available ? GENERIC_KINDS : []);
  const mimeTypes = options.supportedMimeTypes;
  let supports: NativeGenericAttachmentCapability['supports'];
  if (mimeTypes === undefined) {
    supports = (kind) => available && kinds.includes(kind);
  } else {
    supports = (kind, mimeType) => {
      if (!available) return false;
      if (!kinds.includes(kind)) return false;
      // A MIME allow-list means an absent MIME hint cannot be supported.
      if (mimeType === undefined) return false;
      return mimeTypes.includes(mimeType);
    };
  }
  return { available, supports };
}
