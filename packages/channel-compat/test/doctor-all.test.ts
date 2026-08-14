/**
 * Doctor surface for all four official channels (M4 — `pnpm doctor`).
 *
 * Instantiates the real Weixin / QQ / DingTalk / Lark adapters with minimal
 * configs, runs `diagnose` over all four and asserts every diagnostic is
 * `tested` with an `ok` verdict, then prints the formatted doctor output —
 * exactly the surface CI prints via `pnpm doctor`.
 *
 * All four adapters expose a `readonly manifest` class field that the
 * doctor reads structurally.
 */
import { describe, expect, it } from 'vitest';
import {
  diagnose,
  formatDoctor,
  manifestVerdict,
} from '../src/index.ts';
import { WeixinAdapter } from '../../channel-weixin/src/adapter.ts';
import { Config as WeixinConfig } from '../../channel-weixin/src/config.ts';
import { DingTalkAdapter } from '../../channel-dingtalk/src/adapter.ts';
import { Config as DingTalkConfig } from '../../channel-dingtalk/src/config.ts';
import { QQAdapter } from '../../channel-qq/src/adapter.ts';
import { Config as QQConfig } from '../../channel-qq/src/config.ts';
import { LarkAdapter } from '../../channel-lark/src/adapter.ts';
import { Config as LarkConfig } from '../../channel-lark/src/config.ts';

const weixin = new WeixinAdapter(
  WeixinConfig({
    enabled: true,
    accountId: 'main',
    baseUrl: 'http://fake',
    timeoutMs: 1000,
    longPollTimeoutMs: 1000,
    auth: { statePath: undefined, qrPollIntervalMs: 100, qrExpireMs: 10000 },
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
    dedup: { enabled: true, windowMs: 5000 },
  }),
);

const qq = new QQAdapter(
  QQConfig({
    enabled: true,
    accountId: 'main',
    appId: 'dummy-app-id',
    appSecretRef: 'QQBOT_APP_SECRET',
    markdownSupport: false,
    streaming: { enabled: true, throttleMs: 500 },
    dedup: { enabled: true, windowMs: 5000 },
    startupTimeoutMs: 15000,
  }),
);

const dingtalk = new DingTalkAdapter(
  DingTalkConfig({
    enabled: true,
    accountId: 'main',
    baseUrl: 'http://fake',
    timeoutMs: 1000,
    longPollTimeoutMs: 1000,
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
    dedup: { enabled: true, windowMs: 5000 },
    card: { createOnFirstDelta: true },
  }),
);

const lark = new LarkAdapter(
  LarkConfig({
    enabled: true,
    accountId: 'main',
    baseUrl: 'http://fake',
    timeoutMs: 1000,
    longPollTimeoutMs: 1000,
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
    dedup: { enabled: true, windowMs: 5000 },
    card: { createOnFirstDelta: true },
  }),
);

describe('doctor — all four official channels (M4 surface)', () => {
  it('produces a tested diagnostic for every channel and renders the doctor output', async () => {
    const diagnostics = await diagnose([weixin, qq, dingtalk, lark]);
    expect(diagnostics).toHaveLength(4);

    const ids = diagnostics.map((d) => d.id).sort();
    expect(ids).toEqual(['dingtalk', 'lark', 'qq', 'weixin']);

    for (const d of diagnostics) {
      expect(d.compatibility).toBe('tested');
      expect(manifestVerdict(d.compatibility)).toBe('ok');
      expect(d.adapterVersion.length).toBeGreaterThan(0);
      expect(d.upstreamReference.length).toBeGreaterThan(0);
      expect(d.upstreamTestedVersion.length).toBeGreaterThan(0);
      expect(d.upstreamVersionRange.length).toBeGreaterThan(0);
    }

    const text = formatDoctor(diagnostics);
    for (const id of ['weixin', 'qq', 'dingtalk', 'lark']) {
      expect(text).toContain(id);
      expect(text).toContain('Compatibility: tested');
    }

    // The doctor surface CI prints via `pnpm doctor`.
    console.log(text);
  });
});
