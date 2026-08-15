/**
 * Lark API domain resolution (R4 - configurable Feishu / Lark / custom domain).
 *
 * resolveDomain maps the config string to the official SDK Domain enum
 * ('feishu' / 'lark') and preserves a custom base domain verbatim (the SDK
 * WSClient accepts 'Domain | string'). Also pins the config defaults: AppId is
 * a plain config string, and the AppSecret credential reference defaults to
 * DSH_CHANNEL_LARK_MAIN_APP_SECRET (doc §10 / §52 Task 5).
 */
import { describe, expect, it } from 'vitest';
import { Domain } from '@larksuiteoapi/node-sdk';
import { Config, LARK_APP_SECRET_REF, resolveDomain } from '../src/index.ts';

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

describe('lark config defaults', () => {
  it("defaults upstream.domain to 'feishu' and appSecretRef to the DSH ref; appId is optional plain config", () => {
    const config = Config({
      enabled: true,
      accountId: 'main',
      baseUrl: 'http://fake',
      timeoutMs: 1000,
      longPollTimeoutMs: 1000,
      reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
      dedup: { enabled: true, windowMs: 5000 },
      card: { createOnFirstDelta: true },
      upstream: { mode: 'sdk' },
    });
    expect(config.upstream.domain).toBe('feishu');
    // AppSecret moves to a reference; AppId stays plain config (no appIdRef).
    expect(config.upstream.appSecretRef).toBe(LARK_APP_SECRET_REF);
    expect(config.upstream.appSecretRef).toBe('DSH_CHANNEL_LARK_MAIN_APP_SECRET');
    expect('appIdRef' in config.upstream).toBe(false);
    expect(config.upstream.appId).toBeUndefined();
  });

  it('keeps a plain appId in config and honours a custom appSecretRef', () => {
    const config = Config({
      enabled: true,
      accountId: 'main',
      baseUrl: 'http://fake',
      timeoutMs: 1000,
      longPollTimeoutMs: 1000,
      reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
      dedup: { enabled: true, windowMs: 5000 },
      card: { createOnFirstDelta: true },
      upstream: { mode: 'sdk', appId: 'cli_abc', appSecretRef: 'CUSTOM_SECRET_REF' },
    });
    expect(config.upstream.appId).toBe('cli_abc');
    expect(config.upstream.appSecretRef).toBe('CUSTOM_SECRET_REF');
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
      upstream: { mode: 'sdk', domain: 'lark' },
    });
    expect(config.upstream.domain).toBe('lark');
  });

  it('still parses a legacy plaintext upstream.appSecret (migration-only)', () => {
    const config = Config({
      enabled: true,
      accountId: 'main',
      baseUrl: 'http://fake',
      timeoutMs: 1000,
      longPollTimeoutMs: 1000,
      reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
      dedup: { enabled: true, windowMs: 5000 },
      card: { createOnFirstDelta: true },
      upstream: { mode: 'sdk', appSecret: 'legacy-secret' },
    });
    expect(config.upstream.appSecret).toBe('legacy-secret');
  });
});
