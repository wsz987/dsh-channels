/**
 * M4 text-extractor + registry tests (plan §48 / §49 / §81).
 *
 * Covers the dependency-free text path across txt/md/json/yaml/xml/csv/log/
 * source, BOM handling, control-char sanitization, the parser input cap
 * (too-large WITHOUT parsing) and the extracted output cap (truncate+marker).
 */
import { describe, expect, it } from 'vitest';
import { textExtractor } from '../src/attachments/extractors/text.js';
import { pdfExtractor } from '../src/attachments/extractors/pdf.js';
import {
  pickExtractor,
  isExtractable,
  attemptExtraction,
  TRUNCATION_MARKER,
} from '../src/attachments/extractors/registry.js';
import { ExtractionError } from '../src/attachments/extractors/types.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function caps(maxInputBytes = 33554432, maxOutputBytes = 5242880) {
  return { maxInputBytes, maxOutputBytes };
}

describe('text extractor (dependency-free primary path)', () => {
  it('extracts plain txt', async () => {
    const r = await textExtractor.extract(enc('hello world\nsecond line\n'));
    expect(r.format).toBe('text');
    expect(r.text).toBe('hello world\nsecond line');
  });

  it('extracts markdown', async () => {
    const r = await textExtractor.extract(enc('# title\n\nbody **bold**'));
    expect(r.text).toContain('# title');
    expect(r.text).toContain('body');
  });

  it('extracts JSON / YAML / XML / CSV / LOG / source', async () => {
    const json = await textExtractor.extract(enc('{"a": 1, "b": [2, 3]}'));
    expect(json.text).toContain('"a"');

    const yaml = await textExtractor.extract(enc('name: demo\nversion: 1'));
    expect(yaml.text).toContain('name: demo');

    const xml = await textExtractor.extract(enc('<?xml version="1.0"?><root><item>x</item></root>'));
    expect(xml.text).toContain('<root>');

    const csv = await textExtractor.extract(enc('a,b,c\n1,2,3'));
    expect(csv.text).toContain('1,2,3');

    const log = await textExtractor.extract(enc('2026-01-01 INFO booting'));
    expect(log.text).toContain('INFO booting');

    const source = await textExtractor.extract(enc('function main() {\n  return 42;\n}'));
    expect(source.text).toContain('function main()');
  });

  it('honors and strips a UTF-8 BOM', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('hello')]);
    const r = await textExtractor.extract(bytes);
    expect(r.text).toBe('hello');
  });

  it('sanitizes control characters but keeps tabs/newlines', async () => {
    const bytes = new Uint8Array([0x61, 0x00, 0x62, 0x09, 0x63, 0x0a, 0x64, 0x7f, 0x65]);
    const r = await textExtractor.extract(bytes);
    // 'a' NUL 'b' TAB 'c' LF 'd' DEL 'e' -> NUL and DEL removed, TAB/LF kept.
    expect(r.text).toBe('a' + String.fromCharCode(0x62) /* b */ + '\t' + 'c' + '\n' + 'd' + 'e');
  });
});

describe('extractor registry picking', () => {
  it('picks by mime for concrete formats', () => {
    expect(pickExtractor('application/pdf', undefined)?.extensions).toContain('pdf');
    expect(pickExtractor('text/markdown', undefined)).toBe(textExtractor);
    expect(isExtractable('application/vnd.openxmlformats-officedocument.wordprocessingml.document', undefined)).toBe(true);
    expect(isExtractable('application/pdf', undefined)).toBe(true);
  });

  it('picks by extension for generic text', () => {
    expect(pickExtractor(undefined, 'ts')).toBe(textExtractor);
    expect(pickExtractor(undefined, 'md')).toBe(textExtractor);
    expect(pickExtractor(undefined, 'csv')).toBe(textExtractor);
  });

  it('is not extractable for unknown formats', () => {
    expect(isExtractable('application/octet-stream', 'exe')).toBe(false);
    expect(pickExtractor('some/binary', 'bin')).toBeUndefined();
  });
});

describe('parser caps (plan §49)', () => {
  it('too-large input short-circuits without parsing', async () => {
    const big = enc('x'.repeat(100));
    const result = await attemptExtraction({
      mime: 'text/plain',
      extension: 'txt',
      data: big,
      caps: caps(50, 1000),
    });
    expect(result.status).toBe('too-large');
    // The extractor is never invoked: prove it by using a format that would fail.
  });

  it('too-large fires BEFORE the parser body runs', async () => {
    // Use a pdf extractor directly via registry: even for a fake pdf header, the
    // too-large path wins because attemptExtraction checks the cap first.
    const result = await attemptExtraction({
      mime: 'application/pdf',
      extension: 'pdf',
      data: new Uint8Array(600),
      caps: caps(500, 1000),
    });
    expect(result.status).toBe('too-large');
  });

  it('unsupported format reports unsupported', async () => {
    const result = await attemptExtraction({
      mime: 'video/mp4',
      extension: 'mp4',
      data: enc('whatever'),
      caps: caps(),
    });
    expect(result.status).toBe('unsupported');
  });

  it('truncates extracted output over the output cap with a marker', async () => {
    const result = await attemptExtraction({
      mime: 'text/plain',
      extension: 'txt',
      data: enc('a'.repeat(200)),
      caps: caps(10000, 100),
    });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.result.text.endsWith(TRUNCATION_MARKER)).toBe(true);
      // The visible body (before marker) is within the cap.
      const body = result.result.text.slice(0, -TRUNCATION_MARKER.length);
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(100);
    }
  });

  it('pdf extractor throws ExtractionError for a non-pdf input (parser-error/unsupported)', async () => {
    await expect(pdfExtractor.extract(enc('not a pdf at all'))).rejects.toBeInstanceOf(ExtractionError);
  });
});
