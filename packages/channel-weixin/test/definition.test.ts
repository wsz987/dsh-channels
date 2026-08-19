/**
 * Weixin ChannelDefinition tests (execution plan §43, M2B + M4 Task 9).
 *
 * Verifies that the control-plane entry (createWeixinDefinition) delegates the
 * M1 QR flow to the mounted adapter byte-for-byte while exposing the structured
 * control-plane surface: empty setup fields, always-configured state,
 * AuthProviderSession begin/poll/submit, and the AUTH_NOT_READY guard when the
 * adapter is not mounted. Also covers the apply() wiring (register into
 * channelControl vs legacy mount fallback).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@wsz987/channel-core';
import type { ChannelAdapter, AuthChallenge, AuthStatePoll } from '@wsz987/channel-core';
import type { ChannelDefinition, AuthProviderSession } from '@wsz987/channel-control';
import { apply as weixinApply, Config as WeixinConfigSchema, createWeixinDefinition } from '../src/index.js';
import type { WeixinConfig } from '../src/config.js';

function makeConfig(overrides: Partial<WeixinConfig> = {}): WeixinConfig {
  return WeixinConfigSchema({
    enabled: true,
    accountId: 'main',
    ilink: { baseUrl: 'https://fake.ilink.test', cdnBaseUrl: 'https://fake.cdn.test', botAgent: 'DeepSeekHarness/0.8.1' },
    network: { timeoutMs: 1000, longPollTimeoutMs: 1000 },
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10 },
    ...overrides,
  } as unknown as WeixinConfig);
}

/** A scripted fake adapter exposing the three auth hooks (no transport). */
function fakeAuthAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  const beginAuth = vi.fn(async (): Promise<AuthChallenge> => ({
    id: 'challenge-1',
    instruction: '请使用微信扫描二维码',
    qrUrl: 'http://login/1',
    expiresAt: 12345,
  }));
  const pollAuth = vi.fn(async (): Promise<AuthStatePoll> => ({ state: 'pending', detail: 'awaiting WeChat scan' }));
  const submitAuthInput = vi.fn(async () => {});
  return {
    id: 'weixin',
    capabilities: { text: true, image: true, file: false, audio: false, video: false, markdown: false, cards: false, reactions: false, threads: false, streaming: 'buffered' },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => ({ delivered: true })),
    beginAuth,
    pollAuth,
    submitAuthInput,
    ...overrides,
  } as unknown as ChannelAdapter;
}

const challenge = { id: 'c1', instruction: 'scan', qrUrl: 'http://login/1', expiresAt: 12345 };
const session = {
  provider: 'weixin',
  expiresAt: 12345,
  pollingIntervalMs: 3000,
  providerState: { challenge },
} as AuthProviderSession;

function makeDefinition(adapter: ChannelAdapter | undefined, config = makeConfig()): ChannelDefinition {
  return createWeixinDefinition({ config, deps: {}, getAdapter: () => adapter });
}

describe('createWeixinDefinition', () => {
  it('advertises an empty setup surface with only the qr auth method', () => {
    const def = makeDefinition(undefined);
    expect(def.id).toBe('weixin');
    expect(def.enabled).toBe(true);
    expect(def.setup).toEqual({ fields: [], authMethods: ['qr'] });
    expect(def.autoStart).toBe(true);
  });

  it('getConfiguredState always reports configured (nothing to configure)', async () => {
    const def = makeDefinition(undefined);
    await expect(def.getConfiguredState()).resolves.toEqual({ configured: true, fields: {} });
  });

  it('saveConfig is a no-op and ignores unknown keys', async () => {
    const def = makeDefinition(undefined);
    await expect(def.saveConfig({ any: 'thing' } as Record<string, unknown>)).resolves.toBeUndefined();
  });

  it('beginAuth delegates to the mounted adapter and returns a content qr payload', async () => {
    const adapter = fakeAuthAdapter();
    const def = makeDefinition(adapter);
    const result = (await def.beginAuth!({ method: 'qr' })) as AuthProviderSession;
    expect(adapter.beginAuth).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('weixin');
    expect(result.expiresAt).toBe(12345);
    expect(result.pollingIntervalMs).toBe(3000);
    expect(result.qr).toEqual({ kind: 'content', value: 'http://login/1', expiresAt: 12345 });
    expect(result.prompt).toEqual({ kind: 'confirm-on-phone', message: '请使用微信扫描二维码' });
  });

  it('beginAuth maps a data:image qrUrl to a data-url payload', async () => {
    const adapter = fakeAuthAdapter({
      beginAuth: vi.fn(async () => ({ id: 'c', instruction: 'scan', qrUrl: 'data:image/png;base64,AAA', expiresAt: 1 }) as AuthChallenge),
    });
    const def = makeDefinition(adapter);
    const result = (await def.beginAuth!({ method: 'qr' })) as AuthProviderSession;
    expect(result.qr).toEqual({ kind: 'data-url', value: 'data:image/png;base64,AAA', expiresAt: 1 });
  });

  it('beginAuth falls back to a default expiry when the challenge has none', async () => {
    const adapter = fakeAuthAdapter({
      beginAuth: vi.fn(async () => ({ id: 'c', instruction: 'scan', qrUrl: 'u' }) as AuthChallenge),
    });
    const def = makeDefinition(adapter);
    const before = Date.now();
    const result = (await def.beginAuth!({ method: 'qr' })) as AuthProviderSession;
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3 * 60_000);
  });

  it('beginAuth throws AUTH_NOT_READY when no adapter is mounted', async () => {
    const def = makeDefinition(undefined);
    await expect(def.beginAuth!({ method: 'qr' })).rejects.toMatchObject({ code: 'AUTH_NOT_READY' });
  });

  it('pollAuth delegates and maps detail text to structured phases', async () => {
    const cases: { detail: string; state: 'pending' | 'authenticated' | 'expired' | 'failed'; phase: string; promptKind?: string }[] = [
      { detail: 'weixin QR requires a phone-verified code', state: 'pending', phase: 'verification-required', promptKind: 'verification-code' },
      { detail: 'weixin QR scanned; redirecting to IDC host', state: 'pending', phase: 'waiting-confirm', promptKind: 'confirm-on-phone' },
      { detail: 'weixin QR scanned; waiting for confirmation', state: 'pending', phase: 'waiting-confirm', promptKind: 'confirm-on-phone' },
      { detail: 'awaiting WeChat scan', state: 'pending', phase: 'waiting-scan', promptKind: undefined },
      { detail: 'weixin QR confirmed and authenticated', state: 'authenticated', phase: 'authorized', promptKind: undefined },
      { detail: 'weixin QR code expired', state: 'expired', phase: 'expired', promptKind: undefined },
      { detail: 'weixin QR verify code blocked after repeated failures', state: 'failed', phase: 'failed', promptKind: undefined },
    ];
    for (const c of cases) {
      const adapter = fakeAuthAdapter({ pollAuth: vi.fn(async () => ({ state: c.state, detail: c.detail })) });
      const def = makeDefinition(adapter);
      const sess = (await def.beginAuth!({ method: 'qr' })) as AuthProviderSession;
      const status = (await def.pollAuth!(sess)) as {
        state: string;
        phase: string;
        prompt?: { kind?: string };
      };
      expect(status.state).toBe(c.state);
      expect(status.phase).toBe(c.phase);
      if (c.promptKind) {
        expect(status.prompt?.kind).toBe(c.promptKind);
      } else {
        expect(status.prompt).toBeUndefined();
      }
    }
  });

  it('pollAuth throws AUTH_NOT_READY when the adapter is gone', async () => {
    const def = makeDefinition(undefined);
    await expect(def.pollAuth!(session)).rejects.toMatchObject({ code: 'AUTH_NOT_READY' });
  });

  it('submitAuthInput delegates the verification-code to the adapter then re-polls', async () => {
    const adapter = fakeAuthAdapter({
      submitAuthInput: vi.fn(async () => {}),
      pollAuth: vi.fn(async () => ({ state: 'pending', detail: 'weixin QR requires a phone-verified code' })),
    });
    const def = makeDefinition(adapter);
    const sess = (await def.beginAuth!({ method: 'qr' })) as AuthProviderSession;
    const status = (await def.submitAuthInput!(sess, { kind: 'verification-code', value: '123456' })) as {
      phase: string;
      prompt?: { kind?: string };
    };
    const storedChallenge = (sess.providerState as { challenge: AuthChallenge }).challenge;
    expect(adapter.submitAuthInput).toHaveBeenCalledWith(storedChallenge, { kind: 'verification-code', value: '123456' });
    expect(adapter.pollAuth).toHaveBeenCalled();
    expect(status.phase).toBe('verification-required');
    expect(status.prompt?.kind).toBe('verification-code');
  });

  it('submitAuthInput throws AUTH_NOT_READY when the adapter is gone', async () => {
    const def = makeDefinition(undefined);
    await expect(
      def.submitAuthInput!(session, { kind: 'verification-code', value: '1' }),
    ).rejects.toMatchObject({ code: 'AUTH_NOT_READY' });
  });

  it('createAdapter builds a real WeixinAdapter', async () => {
    const def = makeDefinition(undefined);
    const adapter = await def.createAdapter();
    expect(adapter.id).toBe('weixin');
  });

  it('exposes resolveOwnerIdentity from the injected closure', async () => {
    const fn = vi.fn(async (accountId: string) =>
      accountId === 'main' ? 'wx-scan-user-123' : undefined,
    );
    const def = createWeixinDefinition({
      config: makeConfig(),
      deps: {},
      getAdapter: () => undefined,
      resolveOwnerIdentity: fn,
    });
    expect(def.resolveOwnerIdentity).toBeDefined();
    await expect(def.resolveOwnerIdentity!('main')).resolves.toBe('wx-scan-user-123');
    await expect(def.resolveOwnerIdentity!('other')).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledWith('main');
    expect(fn).toHaveBeenCalledWith('other');
  });

  it('omits resolveOwnerIdentity when the closure is not provided', () => {
    const def = makeDefinition(undefined);
    expect(def.resolveOwnerIdentity).toBeUndefined();
  });
});

describe('apply() wiring', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the weixin definition into ctx.channelControl when present (no legacy mount)', () => {
    const register = vi.fn();
    const ctx = new Context();
    new ChannelService(ctx);
    ctx.provide('channelControl', {
      definitions: { register },
      runtime: { adapter: () => undefined },
    });
    const effect = vi.spyOn(ctx, 'effect');
    weixinApply(ctx, makeConfig(), {});
    expect(register).toHaveBeenCalledTimes(1);
    const def = register.mock.calls[0][0] as ChannelDefinition;
    expect(def.id).toBe('weixin');
    expect(def.autoStart).toBe(true);
    // The plugin wires the owner-identity resolver over ctx.channels.resources.
    expect(typeof def.resolveOwnerIdentity).toBe('function');
    // Control-plane path never touches the legacy mount effect.
    expect(effect).not.toHaveBeenCalled();
  });

  it('mounts via the legacy fallback when channel-control is absent', () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const effect = vi.spyOn(ctx, 'effect');
    weixinApply(ctx, makeConfig(), {});
    // mountChannelAdapter drives a ctx.effect for the transactional mount.
    expect(effect).toHaveBeenCalled();
  });

  it('registers the definition even when disabled (enabled: false)', () => {
    const register = vi.fn();
    const ctx = new Context();
    new ChannelService(ctx);
    ctx.provide('channelControl', {
      definitions: { register },
      runtime: { adapter: () => undefined },
    });
    const effect = vi.spyOn(ctx, 'effect');
    weixinApply(ctx, makeConfig({ enabled: false } as WeixinConfig), {});
    // The control plane owns lifecycle: a disabled definition must stay in the
    // directory so the Web control plane can re-enable it (doc §19/§20).
    expect(register).toHaveBeenCalledTimes(1);
    const def = register.mock.calls[0][0] as { enabled?: boolean };
    expect(def.enabled).toBe(false);
    // Control-plane path never touches the legacy mount effect.
    expect(effect).not.toHaveBeenCalled();
  });
});
