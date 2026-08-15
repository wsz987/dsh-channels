/**
 * Extractor contracts (plan §48 / §49).
 *
 * An extractor turns a supported file's raw bytes into a *readable text*
 * surface (plain text or markdown) that the private asset store publishes via
 * `putExtracted`. The output never mutates the stored `raw.bin`; it is a
 * derived projection written to `extracted.md` for the
 * `read_channel_attachment` tool.
 *
 * Parser caps (plan §49) are enforced OUTSIDE the extractors by the
 * registry / pipeline: input beyond `maxInputBytes` short-circuits to
 * `too-large` without parsing, and extracted output beyond
 * `maxOutputBytes` is truncated by the pipeline with a marker. Extractors
 * themselves only map bytes -> text and wrap their failures into a stable
 * `ExtractionError`.
 */
// Reuses (does not redeclare) the core asset-store format enum so the public
// surface of attachments/index stays unambiguous.
import type { ExtractionFormat } from '../types.js';

/** A successful extraction: the format and the produced text. */
export interface ExtractResult {
  format: ExtractionFormat;
  /** The extracted readable text (never the raw file bytes). */
  text: string;
}

/** Stable, de-identified extraction failure codes (stored as `errorCode`). */
export type ExtractionErrorCode =
  /** The parser could not make sense of the input (corrupt / unsupported construct). */
  | 'parser-error'
  /** The input is a recognized format the extractor does not handle. */
  | 'unsupported'
  /** Input or output exceeded a configured parser cap (enforced before/after parse). */
  | 'too-large';

/**
 * Raised by an extractor when it cannot produce text. The code is stable and
 * machine-routable; the message is de-identified (never an exception trace).
 */
export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;
  constructor(code: ExtractionErrorCode, message: string) {
    super(message);
    this.name = 'ExtractionError';
    this.code = code;
  }
}

/** Options passed to an extractor's `extract` call. */
export interface ExtractOptions {
  /** Cancellation signal forwarded from the caller (best-effort). */
  signal?: AbortSignal;
}

/** A strategy that extracts text from one file kind. */
export interface Extractor {
  /**
   * Kinds this extractor serves. Each entry is [mime, extension] — matching is
   * OR'd across entries, so a DOCX extractor lists both
   * `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
   * and `docx`.
   */
  readonly mimes: readonly string[];
  /** File extensions this extractor serves (lower-case, no dot, OR'd with mimes). */
  readonly extensions: readonly string[];
  /**
   * Render a textual surface from raw bytes.
   * @throws ExtractionError with a stable code on failure.
   */
  extract(data: Uint8Array, options?: ExtractOptions): Promise<ExtractResult>;
}
