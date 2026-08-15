/**
 * DOCX text extractor (plan §48).
 *
 * Uses the established, pure-JS mammoth@1.12.1 (exact-pinned) to render the
 * document to plain text. mammoth understands paragraphs, headers, lists
 * and embedded styles, which a zip+document.xml unzip would only approximate.
 *
 * Capped parsing is enforced by the registry/pipeline (input > maxInputBytes
 * short-circuits before this extractor runs). Here we only map bytes -> text
 * and wrap any failure into a stable ExtractionError.
 */
import mammoth from 'mammoth';
import { ExtractionError, type ExtractOptions, type ExtractResult, type Extractor } from './types.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The singleton DOCX extractor. */
export const docxExtractor: Extractor = {
  mimes: [DOCX_MIME],
  extensions: ['docx'],
  async extract(data: Uint8Array, options?: ExtractOptions): Promise<ExtractResult> {
    if (options?.signal?.aborted) {
      throw new ExtractionError('parser-error', 'extraction aborted');
    }
    try {
      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value.trim();
      if (text.length === 0) {
        throw new ExtractionError('unsupported', 'no extractable text in docx');
      }
      return { format: 'markdown', text };
    } catch (error) {
      if (error instanceof ExtractionError) throw error;
      throw new ExtractionError('parser-error', 'docx text could not be extracted');
    }
  },
};

/** Whether a (verified) MIME / extension is served by the DOCX extractor. */
export function docxMimeServed(mime: string | undefined): boolean {
  return mime?.toLowerCase() === DOCX_MIME;
}
