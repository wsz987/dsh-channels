import { describe, expect, it } from 'vitest';
import {
  BODY_LIMIT_BYTES,
  isJsonContentType,
  isLoopbackAddress,
  readJsonBody,
  sanitizeError,
} from '../src/host/security.js';

describe('isLoopbackAddress', () => {
  it('accepts 127.0.0.1', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
  });
  it('accepts ::1 and the IPv4-mapped IPv6 form', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });
  it('rejects non-loopback addresses and undefined', () => {
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('10.0.0.5')).toBe(false);
    expect(isLoopbackAddress('2001:db8::1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});

describe('isJsonContentType', () => {
  it('accepts application/json with and without options', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('Application/JSON')).toBe(true);
  });
  it('rejects other types and missing header', () => {
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('')).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe('sanitizeError', () => {
  it('redacts token/AES-key shaped fragments', () => {
    expect(sanitizeError('endpoint failed: token=abc123xyz')).not.toContain('abc123xyz');
    expect(sanitizeError('bad aeskey: DEADBEEF123')).not.toContain('DEADBEEF123');
    expect(sanitizeError('verifycode=999888 leaked')).not.toContain('999888');
  });
  it('keeps plain messages intact', () => {
    expect(sanitizeError('network timeout')).toBe('network timeout');
  });
  it('truncates very long messages', () => {
    const long = 'x'.repeat(2000);
    expect(sanitizeError(long).length).toBeLessThanOrEqual(501);
  });
});

describe('readJsonBody', () => {
  async function* stream(parts: (Buffer | string)[]): AsyncIterable<Buffer | string> {
    for (const p of parts) yield p;
  }

  it('parses a valid JSON body', async () => {
    const result = await readJsonBody(stream([Buffer.from('{"a":1}')]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1 });
  });

  it('rejects a body over the byte cap with 413', async () => {
    const big = Buffer.from('x'.repeat(BODY_LIMIT_BYTES + 1));
    const result = await readJsonBody(stream([big]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });

  it('treats an empty body as an empty object (endpoints validate their own fields)', async () => {
    const result = await readJsonBody(stream([]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({});
  });

  it('rejects malformed JSON with 400', async () => {
    const result = await readJsonBody(stream([Buffer.from('{not json')]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });
});