/**
 * Byte caps for the private channel asset store and its (M4) text extractor
 * (plan \u00a749). Transport, parser-input and extracted-output bounds are
 * separated so a large inbound file does not silently blow up a parser or the
 * model surface.
 */
export interface AttachmentPolicy {
  /** Hard cap for a single inbound stored asset (transport max). */
  maxInboundBytes: number;
  extract: {
    /** Cap on the raw bytes handed to an extractor (parser input). */
    maxInputBytes: number;
    /** Cap on the extracted text bytes surfaced to the model. */
    maxOutputBytes: number;
  };
}

/** Defaults per plan \u00a749 (100 MB inbound, 32 MiB parser input, 5 MiB output). */
export const DEFAULT_ATTACHMENT_POLICY: AttachmentPolicy = {
  maxInboundBytes: 104857600,
  extract: {
    maxInputBytes: 33554432,
    maxOutputBytes: 5242880,
  },
};

/** Whether raw `bytes` may be written to a binder-bound asset store. */
export function isInboundWithinLimit(bytes: number, policy: AttachmentPolicy): boolean {
  return bytes <= policy.maxInboundBytes;
}

/** The wider read cap for `readRaw` (bounded by the transport cap). */
export function rawReadLimit(policy: AttachmentPolicy): number {
  return policy.maxInboundBytes;
}

/** The read cap for `readExtracted` (bounded by the extractor output cap). */
export function extractedReadLimit(policy: AttachmentPolicy): number {
  return policy.extract.maxOutputBytes;
}
