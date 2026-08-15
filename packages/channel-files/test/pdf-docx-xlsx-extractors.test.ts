/**
 * M4 PDF / DOCX / XLSX extractor tests (plan §48).
 *
 * Generate small real fixtures in-process:
 * - PDF: a hand-written, uncompressed + a FlateDecode content-stream variant.
 * - DOCX: a minimal OOXML zip (STORED entries) carrying word/document.xml.
 * - XLSX: a workbook built with the sheetjs lib itself.
 * Plus corrupt inputs exercising the failed / parser-error path.
 */
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { pdfExtractor } from '../src/attachments/extractors/pdf.js';
import { docxExtractor } from '../src/attachments/extractors/docx.js';
import { xlsxExtractor } from '../src/attachments/extractors/xlsx.js';
import { ExtractionError } from '../src/attachments/extractors/types.js';
// @ts-expect-error sheetjs ships its own types
import * as XLSX from 'xlsx';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---- minimal PDF (uncompressed content stream) -------------------------------
function buildPdf(textLines: string[]): Uint8Array {
  const content = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    ...textLines.map((t) => '(' + t + ') Tj\nT*'),
    'ET',
  ].join('\n');
  return enc(
    '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n' +
      '4 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n' +
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
  );
}

/** The same PDF with a FlateDecode-compressed content stream. */
function buildFlatePdf(textLines: string[]): Uint8Array {
  const content = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    ...textLines.map((t) => '(' + t + ') Tj\nT*'),
    'ET',
  ].join('\n');
  const compressed = new Uint8Array(deflateSync(Buffer.from(content)));
  const prefix = enc(
    '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n' +
      '4 0 obj\n<< /Length ' + compressed.length + ' /Filter /FlateDecode >>\nstream\n',
  );
  const suffix = enc('\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
  const joined = new Uint8Array(prefix.length + compressed.length + suffix.length);
  joined.set(prefix, 0);
  joined.set(compressed, prefix.length);
  joined.set(suffix, prefix.length + compressed.length);
  return joined;
}

describe('pdf extractor', () => {
  it('extracts visible text from an uncompressed content stream', async () => {
    const r = await pdfExtractor.extract(buildPdf(['Hello, PDF!', 'Second line']));
    expect(r.format).toBe('text');
    expect(r.text).toContain('Hello, PDF!');
    expect(r.text).toContain('Second line');
  });

  it('extracts visible text from a FlateDecode-compressed stream', async () => {
    const r = await pdfExtractor.extract(buildFlatePdf(['Compressed', 'Text']));
    expect(r.text).toContain('Compressed');
    expect(r.text).toContain('Text');
  });

  it('rejects a non-pdf input with unsupported', async () => {
    await expect(pdfExtractor.extract(enc('this is definitely not a pdf'))).rejects.toBeInstanceOf(
      ExtractionError,
    );
  });

  it('rejects a corrupt PDF stream with parser-error', async () => {
    // A valid pdf header but no usable stream -> parser-error or unsupported.
    const bytes = enc('%PDF-1.4\n1 0 obj\nendobj\n%%EOF');
    await expect(pdfExtractor.extract(bytes)).rejects.toBeInstanceOf(ExtractionError);
  });
});

// ---- minimal DOCX zip (STORED entries) ---------------------------------------
let crcTable: Uint32Array | undefined;
function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a STORED (uncompressed) zip archive from name->bytes entries. */
function buildZip(entries: Array<[string, Uint8Array]>): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = enc(name);
    // Local file header.
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(0, 8); // method: store
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0x21, 12); // mod date
    lfh.writeUInt32LE(crc32(data), 14);
    lfh.writeUInt32LE(data.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBytes.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length
    local.push(new Uint8Array(lfh), nameBytes, data);

    // Central directory header.
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8); // flags
    cdh.writeUInt16LE(0, 10); // method
    cdh.writeUInt16LE(0, 12); // mod time
    cdh.writeUInt16LE(0x21, 14); // mod date
    cdh.writeUInt32LE(crc32(data), 16);
    cdh.writeUInt32LE(data.length, 20); // compressed
    cdh.writeUInt32LE(data.length, 24); // uncompressed
    cdh.writeUInt16LE(nameBytes.length, 28);
    cdh.writeUInt16LE(0, 30); // extra
    cdh.writeUInt16LE(0, 32); // comment
    cdh.writeUInt16LE(0, 34); // disk start
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42); // local header offset
    central.push(new Uint8Array(cdh), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralBytes = concat(central);
  const cdSize = centralBytes.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd disk
  eocd.writeUInt16LE(entries.length, 8); // entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment length

  return concat([...local, centralBytes, new Uint8Array(eocd)]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function buildDocx(text: string): Uint8Array {
  const documentXml = enc(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>' + escapeXml(text) + '</w:t></w:r></w:p></w:body></w:document>',
  );
  const contentTypes = enc(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  const rels = enc(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  return buildZip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels],
    ['word/document.xml', documentXml],
  ]);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

describe('docx extractor', () => {
  it('extracts text from a real minimal docx', async () => {
    const r = await docxExtractor.extract(buildDocx('Hello DOCX world'));
    expect(r.format).toBe('markdown');
    expect(r.text).toContain('Hello DOCX world');
  });

  it('rejects a corrupt docx with parser-error', async () => {
    await expect(docxExtractor.extract(enc('garbage not a docx'))).rejects.toBeInstanceOf(ExtractionError);
  });
});

// ---- XLSX via sheetjs --------------------------------------------------------
function buildXlsx(rows: unknown[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out as number[]);
}

describe('xlsx extractor', () => {
  it('extracts a cell matrix as a markdown table', async () => {
    const r = await xlsxExtractor.extract(buildXlsx([['name', 'count'], ['apple', 3], ['pear', 7]]));
    expect(r.format).toBe('markdown');
    expect(r.text).toContain('name');
    expect(r.text).toContain('apple');
    expect(r.text).toContain('3');
    expect(r.text).toContain('|');
  });

  it('rejects a corrupt xlsx with parser-error', async () => {
    await expect(xlsxExtractor.extract(enc('definitely not xlsx'))).rejects.toBeInstanceOf(ExtractionError);
  });
});
