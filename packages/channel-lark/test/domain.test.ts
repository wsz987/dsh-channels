/**
 * Lark API domain resolution (R4 - configurable Feishu / Lark / custom domain).
 *
 * resolveDomain maps the config string to the official SDK Domain enum
 * ('feishu' / 'lark') and preserves a custom base domain verbatim (the SDK
 * WSClient accepts 'Domain | string'). Also pins the config default.
 */
import { describe, expect, it } from 'vitest';
import { Domain } from '@larksuiteoapi/node-sdk';
import { Config, resolveDomain } from '../src/index.ts';

describe('lark resolveDomain', () => {
  it("maps 'feishu' to Domain.Feishu", () => {
    expect(resolveDomain('feishu')).toBe(Domain.Feishu);
  });

  it("maps 'lark' to Domain.Lark", () => {
    expect(resolveDomain('lark')).toBe(Domain.Lark);
  });

  it('preserves a custom base domain verbatim', () => {
    expect(resolveDomain('open.example.com')).toBe('open.example.com');
  });
});

describe('lark config domain default', () => {
  it("defaults upstream.domain to 'feishu'", () => {
    const config = Config({
      enabled: true,
      accountId: 'main',
      baseUrl: 'http://fake',
      timeoutMs: 1000,
      longPollTimeoutMs: 1000,
      reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
      dedup: { enabled: true, windowMs: 5000 },
      card: { createOnFirstDelta: true },
      upstream: { mode: 'sdk', appId: 'k', appSecret: 's' },
    });
    expect(config.upstream.domain).toBe('feishu');
  });

  it("honours an explicit 'lark' domain", () => {
    const config = Config({
      enabled: true,
      accountId: 'main',
      baseUrl: 'http://fake',
      timeoutMs: 1000,
      longPollTimeoutMs: 1000,
      reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
      dedup: { enabled: true, windowMs: 5000 },
      card: { createOnFirstDelta: true },
      upstream: { mode: 'sdk', appId: 'k', appSecret: 's', domain: 'lark' },
    });
    expect(config.upstream.domain).toBe('lark');
  });
});
