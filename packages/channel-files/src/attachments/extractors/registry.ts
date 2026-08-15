/**
 * Extractor registry (plan §48 / §49).
 *
 * Picks the right extractor for a stored asset by its VERIFIED mime type and
 * filename extension, and enforces the parser input cap BEFORE parsing: input
 * beyond maxInputBytes reports 'too-large' without ever handing bytes to a
 * parser. Unrecognized formats report 'unsupported'. The output cap is also
 * enforced here (truncate with a marker, per plan §49).
 */
import { textExtractor } from './text.js';
import { pdfExtractor } from './pdf.js';
import { docxExtractor } from './docx.js';
import { xlsxExtractor } from './xlsx.js';
import { ExtractionError, type ExtractOptions, type ExtractResult, type Extractor } from './types.js';

/** The ordered candidate extractors (first match wins). */
const EXTRACTORS: readonly Extractor[] = [
  textExtractor,
  pdfExtractor,
  docxExtractor,
  xlsxExtractor,
];

/** Marker appended when the extracted output is truncated to the output cap. */
export const TRUNCATION_MARKER = '\n\n[...truncated]\n';

/** Extraction boundaries (plan §49: parser input cap + extracted output cap). */
export interface ExtractionCaps {
  /** Max raw bytes handed to a parser (beyond => too-large, no parse). */
  maxInputBytes: number;
  /** Max extracted text bytes surfaced (beyond => truncate with marker). */
  maxOutputBytes: number;
}

/**
 * Resolve an extractor for a verified mime/extension pair, or undefined.
 * The filename extension is used for formats whose verified mime is generic
 * (e.g. plain text); the verified mime wins when it names a concrete format.
 */
export function pickExtractor(mime: string | undefined, extension: string | undefined): Extractor | undefined {
  const mimeLower = mime?.toLowerCase();
  const extLower = extension?.toLowerCase();
  for (const extractor of EXTRACTORS) {
    if (mimeLower && extractor.mimes.includes(mimeLower)) return extractor;
    if (extLower && extractor.extensions.includes(extLower)) return extractor;
  }
  return undefined;
}

/** Whether a (verified) mime/extension is served by ANY extractor. */
export function isExtractable(mime: string | undefined, extension: string | undefined): boolean {
  return pickExtractor(mime, extension) !== undefined;
}

/** Outcome of attempting extraction against an asset. */
export type ExtractAttemptResult =
  | { status: 'ready'; result: ExtractResult }
  | { status: 'unsupported' }
  | { status: 'too-large' }
  | { status: 'failed'; errorCode: string };

/**
 * Guards + runs the extractor for one asset, enforcing input/output caps.
 * Never throws: every failure collapses to a typed status so the pipeline can
 * record it and continue (best-effort, plan §41).
 */
export async function attemptExtraction(input: {
  mime: string | undefined;
  extension: string | undefined;
  data: Uint8Array;
  caps: ExtractionCaps;
  signal?: AbortSignal;
}): Promise<ExtractAttemptResult> {
  const { mime, extension, data, caps, signal } = input;
  if (signal?.aborted) {
    return { status: 'failed', errorCode: 'aborted' };
  }
  const extractor = pickExtractor(mime, extension);
  if (!extractor) return { status: 'unsupported' };
  if (data.byteLength > caps.maxInputBytes) return { status: 'too-large' };
  try {
    const result = await extractor.extract(data, { signal });
    const capped = capOutput(result, caps.maxOutputBytes);
    return { status: 'ready', result: capped };
  } catch (error) {
    if (error instanceof ExtractionError) return { status: 'failed', errorCode: error.code };
    return { status: 'failed', errorCode: 'parser-error' };
  }
}

/** Truncate extracted output to the byte cap, appending a truncation marker. */
function capOutput(result: ExtractResult, maxOutputBytes: number): ExtractResult {
  const encoded = new TextEncoder().encode(result.text);
  if (encoded.byteLength <= maxOutputBytes) return result;
  // Slide back to a UTF-8 boundary so we never split a multi-byte sequence.
  let end = maxOutputBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  const sliced = new TextDecoder('utf-8').decode(encoded.subarray(0, end));
  return { format: result.format, text: sliced + TRUNCATION_MARKER };
}
