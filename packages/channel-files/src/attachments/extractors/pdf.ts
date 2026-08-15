import { extractText, getDocumentProxy } from 'unpdf';
import {
  ExtractionError,
  type ExtractOptions,
  type ExtractResult,
  type Extractor,
} from './types.js';

const PDF_MIME = 'application/pdf';

function isPdf(data: Uint8Array): boolean {
  return data.byteLength >= 5
    && new TextDecoder('latin1').decode(data.subarray(0, 5)) === '%PDF-';
}

export const pdfExtractor: Extractor = {
  mimes: [PDF_MIME],
  extensions: ['pdf'],
  async extract(data: Uint8Array, options?: ExtractOptions): Promise<ExtractResult> {
    if (options?.signal?.aborted) {
      throw new ExtractionError('parser-error', 'extraction aborted');
    }
    if (!isPdf(data)) {
      throw new ExtractionError('unsupported', 'input is not a pdf file');
    }

    let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
    try {
      pdf = await getDocumentProxy(data);
      const result = await extractText(pdf, { mergePages: true });
      if (options?.signal?.aborted) {
        throw new ExtractionError('parser-error', 'extraction aborted');
      }
      const text = result.text.trim();
      if (!text) {
        throw new ExtractionError('unsupported', 'no extractable text in pdf');
      }
      return { format: 'text', text };
    } catch (error) {
      if (error instanceof ExtractionError) throw error;
      throw new ExtractionError('parser-error', 'pdf could not be parsed');
    } finally {
      await pdf?.cleanup().catch(() => undefined);
    }
  },
};

export function pdfMimeServed(mime: string | undefined): boolean {
  return mime?.toLowerCase() === PDF_MIME;
}
