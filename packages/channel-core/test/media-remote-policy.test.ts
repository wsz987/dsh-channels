import { describe, expect, it } from 'vitest';
import {
  assertSafeMediaUrl,
  isPrivateIp,
  sameOrigin,
  stripCrossOriginAuthHeader,
  UnsafeHostError,
} from '../src/media/remote-policy.js';

describe('isPrivateIp', () => {
  it.each([
    ['10.1.2.3', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['127.0.0.1', true],
    ['127.8.8.8', true],
    ['169.254.169.254', true],
    ['0.0.0.0', true],
    ['93.184.216.34', false],
    ['1.1.1.1', false],
  ])('classifies IPv4 %s → %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });

  it.each([
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fe80::', true],
    ['fd00::1', true],
    ['fc00::1', true],
    ['2001:db8::1', false],
    ['2001:4860:4860::8888', false],
  ])('classifies IPv6 %s → %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });

  it('returns false for non-IP strings and malformed input', () => {
    expect(isPrivateIp('example.com')).toBe(false);
    expect(isPrivateIp('999.1.1.1')).toBe(false);
    expect(isPrivateIp('')).toBe(false);
  });
});

describe('assertSafeMediaUrl — scheme', () => {
  it('accepts https by default', async () => {
    const url = await assertSafeMediaUrl('https://example.com/a.png');
    expect(url.hostname).toBe('example.com');
  });

  it('rejects http unless explicitly allowed', async () => {
    await expect(assertSafeMediaUrl('http://example.com/a.png')).rejects.toBeInstanceOf(
      UnsafeHostError,
    );
    await expect(
      assertSafeMediaUrl('http://example.com/a.png', { allowHttp: true }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('rejects non-http schemes', async () => {
    await expect(assertSafeMediaUrl('file:///etc/passwd')).rejects.toBeInstanceOf(UnsafeHostError);
    await expect(assertSafeMediaUrl('ftp://example.com/x')).rejects.toBeInstanceOf(UnsafeHostError);
    await expect(assertSafeMediaUrl('data:text/plain,hi')).rejects.toBeInstanceOf(UnsafeHostError);
  });

  it('rejects unparsable URLs', async () => {
    await expect(assertSafeMediaUrl('not a url')).rejects.toBeInstanceOf(UnsafeHostError);
  });
});

describe('assertSafeMediaUrl — IP literals', () => {
  it('rejects private/loopback/link-local/ULA literals', async () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.0.1', '169.254.1.1', '0.0.0.0']) {
      await expect(assertSafeMediaUrl(`http://${ip}/x`, { allowHttp: true })).rejects.toBeInstanceOf(
        UnsafeHostError,
      );
    }
    for (const ip of ['[::1]', '[fe80::1]', '[fc00::1]']) {
      await expect(assertSafeMediaUrl(`https://${ip}/`)).rejects.toBeInstanceOf(UnsafeHostError);
    }
  });

  it('accepts public IP literals', async () => {
    await expect(assertSafeMediaUrl('https://93.184.216.34/x')).resolves.toBeInstanceOf(URL);
  });
});

describe('assertSafeMediaUrl — hostname resolution', () => {
  const resolverFor = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];

  it('rejects a host that resolves to a private IP', async () => {
    await expect(
      assertSafeMediaUrl('https://evil.example/x', {
        resolver: resolverFor({ 'evil.example': ['127.0.0.1'] }),
      }),
    ).rejects.toBeInstanceOf(UnsafeHostError);
  });

  it('accepts a host that resolves to a public IP', async () => {
    await expect(
      assertSafeMediaUrl('https://good.example/x', {
        resolver: resolverFor({ 'good.example': ['93.184.216.34'] }),
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('rejects when any of several addresses is unsafe (DNS rebinding defense)', async () => {
    await expect(
      assertSafeMediaUrl('https://mixed.example/x', {
        resolver: resolverFor({ 'mixed.example': ['93.184.216.34', '10.0.0.2'] }),
      }),
    ).rejects.toBeInstanceOf(UnsafeHostError);
  });

  it('skips resolution when no resolver is injected', async () => {
    await expect(assertSafeMediaUrl('https://example.com/x')).resolves.toBeInstanceOf(URL);
  });
});

describe('sameOrigin / stripCrossOriginAuthHeader', () => {
  const headers = (): Headers => {
    const h = new Headers();
    h.set('authorization', 'Bearer abc');
    h.set('cookie', 'sid=1');
    h.set('x-trace', 't1');
    return h;
  };

  it('detects equal and different origins', () => {
    expect(sameOrigin('https://a.com/x', 'https://a.com/y')).toBe(true);
    expect(sameOrigin('https://a.com/x', 'https://b.com/y')).toBe(false);
    expect(sameOrigin('https://a.com/x', 'http://a.com/y')).toBe(false);
  });

  it('keeps auth headers on a same-origin hop', () => {
    const out = stripCrossOriginAuthHeader(headers(), 'https://a.com', 'https://a.com');
    expect(out.get('authorization')).toBe('Bearer abc');
    expect(out.get('cookie')).toBe('sid=1');
    expect(out.get('x-trace')).toBe('t1');
  });

  it('strips auth headers on a cross-origin hop and keeps non-auth headers', () => {
    const out = stripCrossOriginAuthHeader(headers(), 'https://a.com', 'https://cdn.com');
    expect(out.get('authorization')).toBeNull();
    expect(out.get('cookie')).toBeNull();
    expect(out.get('x-trace')).toBe('t1');
  });
});
