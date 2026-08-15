/**
 * XLSX (and xls) text extractor (plan §48).
 *
 * Uses the established, pure-JS xlsx@0.18.5 (SheetJS, exact-pinned) to read
 * the workbook cells and render each sheet as a markdown table. Shared
 * strings, inline strings, numbers and booleans are all surfaced as text.
 *
 * Capped parsing is enforced by the registry/pipeline; here we only map bytes
 * -> text and wrap failures into a stable ExtractionError.
 */
import * as XLSX from 'xlsx';
import { ExtractionError, type ExtractOptions, type ExtractResult, type Extractor } from './types.js';

const SPREADSHEET_MIMES: readonly string[] = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
]

/** Render one cell address range as a markdown table. */
function sheetToMarkdown(sheetName: string, sheet: XLSX.WorkSheet): string {
  const ref = sheet['!ref'];
  if (!ref) return '## ' + sheetName + '\n\n(empty sheet)\n';
  const range = XLSX.utils.decode_range(ref);
  const rows: string[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr] as XLSX.CellObject | undefined;
      if (!cell || cell.v === undefined || cell.v === null) {
        row.push('');
        continue;
      }
      const val = String(cell.v).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
      row.push(val);
    }
    rows.push(row);
  }
  const header = rows[0] ?? [];
  const sep = header.map(() => '---');
  const all = [header, sep, ...rows.slice(1)].map((r) => '| ' + r.join(' | ') + ' |').join('\n');
  return '## ' + sheetName + '\n\n' + all + '\n';
}

/** The singleton spreadsheet extractor. */
export const xlsxExtractor: Extractor = {
  mimes: SPREADSHEET_MIMES,
  extensions: ['xlsx', 'xls'],
  async extract(data: Uint8Array, options?: ExtractOptions): Promise<ExtractResult> {
    if (options?.signal?.aborted) {
      throw new ExtractionError('parser-error', 'extraction aborted');
    }
    // XLSX / XLS are ZIP containers: reject bytes that are not even a zip so a
    // corrupt blob is reported as parser-error rather than misparsed as cells.
    if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
      throw new ExtractionError('parser-error', 'not a spreadsheet container');
    }
    try {
      const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const workbook = XLSX.read(buf, { type: 'buffer', cellText: false, cellNF: false });
      if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        throw new ExtractionError('unsupported', 'workbook has no sheets');
      }
      const parts = workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name];
        return sheet ? sheetToMarkdown(name, sheet) : '';
      }).filter((text) => text.length > 0);
      const text = parts.join('\n').trim();
      if (text.length === 0) {
        throw new ExtractionError('unsupported', 'no extractable text in spreadsheet');
      }
      return { format: 'markdown', text };
    } catch (error) {
      if (error instanceof ExtractionError) throw error;
      throw new ExtractionError('parser-error', 'spreadsheet text could not be extracted');
    }
  },
};

/** Whether a (verified) MIME / extension is served by the spreadsheet extractor. */
export function xlsxMimeServed(mime: string | undefined): boolean {
  return mime ? SPREADSHEET_MIMES.includes(mime.toLowerCase()) : false;
}
