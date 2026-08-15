/**
 * M2B-Task4 DingTalk ChannelDefinition tests.
 *
 * Covers the universal Control Plane spec for DingTalk: the setup descriptor +
 * credential refs, configured-state computation (SDK / gateway / missing
 * credential), createAdapter (resolves + injects deps.clientSecret, throws when
 * the SDK secret is missing), non-secret saveConfig merging, and the apply()
 * wiring — registering into ctx.channelControl, the one-time legacy plaintext
 * migration, and the headless fallback when channel-control is absent.
 *
 * The credential and stream seams are fakes, so everything is fully offline.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@wsz987/channel-core';
import { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials';
import {
  Config,
  DINGTALK_CLIENT_SECRET_REF,
  DingTalkAdapter,
  apply,
  createDingTalkDefinition,
  type DingTalkAdapterDeps,
} from '../src/index.ts';
import type { DingTalkConfig } from '../src/config.ts';

/** In-memory credentials provider recording set/unset, for the apply() paths. */
class FakeCredentials extends CredentialProvider {
  readonly stored = new Map<string, string>();
  readonly sets: string[] = [];

  async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const key = String(_ref);
    const value = this.stored.get(key);
    return value === undefined ? undefined : { value, source: 'test' };
  }

  async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    const key = String(_ref);
    return { configured: this.stored.has(key), writable: true, source: this.stored.has(key) ? 'test' : undefined };
  }

  async set(_ref: CredentialRef, value: string): Promise<void> {
    const key = String(_ref);
    this.sets.push(key);
    this.stored.set(key, value);
  }

  async unset(_ref: CredentialRef): Promise<void> {
    this.stored.delete(String(_ref));
  }
}

/** Thin structural credentials seam backed by a plain object (for definition-only tests). */
interface SeamState {
  values: Record<string, string>;
  describe?: Record<string, boolean>;
}
class FakeSeam {
  lastDescribe: string[] = [];
  lastResolve: string[] = [];
  constructor(private readonly state: SeamState) {}

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    this.lastResolve.push(ref);
    const value = this.state.values[ref];
    return value === undefined ? undefined : { value, source: 'test' };
  }

  async describe(ref: string): Promise<{ configured: boolean; writable: boolean; source?: string }> {
    this.lastDescribe.push(ref);
    const configured = this.state.describe?.[ref] ?? this.state.values[ref] !== undefined;
    return { configured, writable: true, source: configured ? 'test' : undefined };
  }
}

function makeConfig(overrides: Partial<DingTalkConfig> = {}): DingTalkConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    baseUrl: 'http://fake',
    timeoutMs: 1000,
    longPollTimeoutMs: 1000,
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
    dedup: { enabled: true, windowMs: 5000 },
    card: { createOnFirstDelta: true },
    upstream: { mode: 'gateway' },
    ...overrides,
  });
}

describe('createDingTalkDefinition setup descriptor', () => {
  it('advertises credential fields and the official console without fake auth methods', () => {
    const def = createDingTalkDefinition({
      config: makeConfig({ enabled: true, upstream: { mode: 'sdk' } }),
      deps: {},
      credentials: new FakeSeam({ values: {} }),
    });
    expect(def.id).toBe('dingtalk');
    expect(def.enabled).toBe(true);
    expect(def.autoStart).toBe(true);
    expect(def.setup.authMethods).toEqual([]);
    expect(def.setup.setupUrl).toBe('https://open-dev.dingtalk.com/#/app');
    expect(def.beginAuth).toBeUndefined();
    expect(def.pollAuth).toBeUndefined();
    expect(def.submitAuthInput).toBeUndefined();

    const byName = Object.fromEntries(def.setup.fields.map((f) => [f.name, f]));
    expect(byName.clientId).toMatchObject({ kind: 'text', secret: false, writable: true });
    expect(byName.clientSecret).toMatchObject({
      kind: 'secret',
      secret: true,
      writable: true,
      ref: DINGTALK_CLIENT_SECRET_REF,
    });
    expect(byName.clientSecret.ref).toBe(DINGTALK_CLIENT_SECRET_REF);
  });

  it('deep-links to the configured app when clientId is set', () => {
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'sdk', clientId: 'app-key' } }),
      deps: {},
      credentials: new FakeSeam({ values: {} }),
    });
    expect(def.setup.setupUrl).toBe('https://open-dev.dingtalk.com/#/app?clientId=app-key');
  });

  it('saveConfig keeps the console deep-link in sync with the patched clientId', async () => {
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'gateway' } }),
      deps: {},
      credentials: new FakeSeam({ values: {} }),
    });
    await def.saveConfig({ clientId: 'new-key' });
    expect(def.setup.setupUrl).toBe('https://open-dev.dingtalk.com/#/app?clientId=new-key');
  });

  it('defaults the secret ref to DINGTALK_CLIENT_SECRET_REF when unset', () => {
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'sdk' } }),
      deps: {},
      credentials: new FakeSeam({ values: {} }),
    });
    const secretField = def.setup.fields.find((f) => f.name === 'clientSecret')!;
    expect(secretField.ref).toBe('DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET');
  });

  it('reflects a custom clientSecretRef', () => {
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'sdk', clientSecretRef: 'MY_DINGTALK_SECRET' } }),
      deps: {},
      credentials: new FakeSeam({ values: {} }),
    });
    const secretField = def.setup.fields.find((f) => f.name === 'clientSecret')!;
    expect(secretField.ref).toBe('MY_DINGTALK_SECRET');
  });
});

describe('createDingTalkDefinition getConfiguredState', () => {
  it('sdk mode: configured when clientId present and credential configured', async () => {
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'sdk', clientId: 'app-key' } }),
      deps: {},
      credentials: new FakeSeam({ values: { [DINGTALK_CLIENT_SECRET_REF]: 'secret' } }),
    });
    const state = await def.getConfiguredState();
    expect(state.configured).toBe(true);
    expect(state.fields.clientId).toMatchObject({ configured: true, value: 'app-key' });
    expect(state.fields.clientSecret.configured).toBe(true);
    expect(state.fields.clientSecret.source).toBe('test');
  });

  it('sdk mode: not configured when the credential is missing', async () => {
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'sdk', clientId: 'app-key' } }),
      deps: {},
      credentials: new FakeSeam({ values: {} }),
    });
    const state = await def.getConfiguredState();
    expect(state.configured).toBe(false);
    expect(state.fields.clientSecret.configured).toBe(false);
  });

  it('sdk mode: not configured when clientId is missing', async () => {
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'sdk' } }),
      deps: {},
      credentials: new FakeSeam({ values: { [DINGTALK_CLIENT_SECRET_REF]: 'secret' } }),
    });
    const state = await def.getConfiguredState();
    expect(state.configured).toBe(false);
    expect(state.fields.clientId.configured).toBe(false);
  });

  it('gateway mode: configured by baseUrl (gateway owns credentials)', async () => {
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'gateway' }, baseUrl: 'http://gw' }),
      deps: {},
      credentials: new FakeSeam({ values: {} }),
    });
    const state = await def.getConfiguredState();
    expect(state.configured).toBe(true);
    expect(state.fields.baseUrl.configured).toBe(true);
  });

  it('gateway mode: not configured without baseUrl', async () => {
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'gateway' }, baseUrl: '' }),
      deps: {},
      credentials: new FakeSeam({ values: {} }),
    });
    const state = await def.getConfiguredState();
    expect(state.configured).toBe(false);
  });
});

describe('createDingTalkDefinition createAdapter', () => {
  it('sdk mode: resolves the secret and injects deps.clientSecret', async () => {
    const credentials = new FakeSeam({ values: { [DINGTALK_CLIENT_SECRET_REF]: 'the-secret' } });
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'sdk', clientId: 'app-key' } }),
      deps: {},
      credentials,
    });
    const adapter = await def.createAdapter();
    expect(adapter).toBeInstanceOf(DingTalkAdapter);
    expect(credentials.lastResolve).toContain(DINGTALK_CLIENT_SECRET_REF);

    // The passed deps get clientSecret appended (probe via the adapter's own deps).
    const a = adapter as DingTalkAdapter & { deps: DingTalkAdapterDeps & { clientSecret?: string } };
    expect(a.deps.clientSecret).toBe('the-secret');
  });

  it('sdk mode: throws a stable error when the secret credential is missing', async () => {
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'sdk', clientId: 'app-key' } }),
      deps: {},
      credentials: new FakeSeam({ values: {} }),
    });
    await expect(def.createAdapter()).rejects.toThrow(
      'dingtalk credential "DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET" is not configured',
    );
  });

  it('gateway mode: builds the adapter without resolving any credential', async () => {
    const credentials = new FakeSeam({ values: {} });
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'gateway' } }),
      deps: {},
      credentials,
    });
    const adapter = await def.createAdapter();
    expect(adapter).toBeInstanceOf(DingTalkAdapter);
    expect(credentials.lastResolve).toHaveLength(0);
  });
});

describe('createDingTalkDefinition saveConfig', () => {
  it('merges allowed non-secret keys and reflects them in createAdapter/state', async () => {
    const seam = new FakeSeam({ values: { [DINGTALK_CLIENT_SECRET_REF]: 'secret' } });
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'gateway' }, baseUrl: 'http://old' }),
      deps: {},
      credentials: seam,
    });
    await def.saveConfig({ baseUrl: 'http://new', timeoutMs: 5000 });
    await def.saveConfig({ upstream: { mode: 'sdk' }, clientId: 'new-key' });

    // The new mode+clientId now drive configured-state and createAdapter.
    const state = await def.getConfiguredState();
    expect(state.configured).toBe(true);
    const adapter = await def.createAdapter();
    expect(adapter).toBeInstanceOf(DingTalkAdapter);

    const probe = adapter as DingTalkAdapter & { config: DingTalkConfig };
    expect(probe.config.baseUrl).toBe('http://new');
    expect(probe.config.timeoutMs).toBe(5000);
    expect(probe.config.upstream.mode).toBe('sdk');
    expect(probe.config.upstream.clientId).toBe('new-key');
  });

  it('persists clientId changes and a transactional restore without touching credentials', async () => {
    const persistSetup = vi.fn(async () => {});
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'sdk', clientId: 'old-key' } }),
      deps: {},
      credentials: new FakeSeam({ values: {} }),
      persistSetup,
    });
    const before = def.snapshotConfig!();

    await def.saveConfig({ clientId: 'replacement-key' });
    await def.restoreConfig!(before);

    expect(persistSetup).toHaveBeenNthCalledWith(1, { upstream: { clientId: 'replacement-key' } });
    expect(persistSetup).toHaveBeenNthCalledWith(2, { upstream: { clientId: 'old-key' } });
  });

  it('deep-merges sub-objects without losing untouched sibling keys', async () => {
    const seam = new FakeSeam({ values: { [DINGTALK_CLIENT_SECRET_REF]: 'secret' } });
    const def = createDingTalkDefinition({
      config: makeConfig({
        upstream: { mode: 'gateway' },
        reconnect: { enabled: true, baseDelayMs: 100, maxDelayMs: 500, maxRetries: 5 },
      }),
      deps: {},
      credentials: seam,
    });
    await def.saveConfig({ reconnect: { baseDelayMs: 999 } });

    const probe = (await def.createAdapter()) as DingTalkAdapter & { config: DingTalkConfig };
    // Untouched sibling keys survive the shallow merge.
    expect(probe.config.reconnect.enabled).toBe(true);
    expect(probe.config.reconnect.maxRetries).toBe(5);
    expect(probe.config.reconnect.baseDelayMs).toBe(999);
  });

  it('ignores unknown and secret keys as a final safety net', async () => {
    const seam = new FakeSeam({ values: { [DINGTALK_CLIENT_SECRET_REF]: 'secret' } });
    const def = createDingTalkDefinition({
      config: makeConfig({ upstream: { mode: 'gateway' } }),
      deps: {},
      credentials: seam,
    });
    await def.saveConfig({ nope: 1, clientSecret: 'should-not-apply' } as never);
    const probe = (await def.createAdapter()) as DingTalkAdapter & { config: DingTalkConfig };
    expect(probe.config.upstream.clientSecret).toBeUndefined();
    expect((probe.config as unknown as Record<string, unknown>).nope).toBeUndefined();
  });
});

describe('apply() wiring', () => {
  it('registers a DingTalkDefinition into a fake ctx.channelControl', () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const creds = new FakeCredentials(ctx);
    const registered: unknown[] = [];
    ctx.provide('channelControl', {
      definitions: {
        register(def: unknown) {
          registered.push(def);
        },
      },
    });

    apply(ctx, makeConfig({ enabled: true, upstream: { mode: 'gateway' } }), {});
    expect(registered).toHaveLength(1);
    const def = registered[0] as { id: string; enabled: boolean; createAdapter: () => Promise<unknown> };
    expect(def.id).toBe('dingtalk');
    expect(def.enabled).toBe(true);
    // createAdapter resolves through the ctx-provided credentials seam.
    expect(typeof def.createAdapter).toBe('function');
    void creds;
  });

  it('does not register when the channel is disabled', () => {
    const ctx = new Context();
    new ChannelService(ctx);
    new FakeCredentials(ctx);
    const registered: unknown[] = [];
    ctx.provide('channelControl', {
      definitions: { register(def: unknown) { registered.push(def); } },
    });

    apply(ctx, makeConfig({ enabled: false }), {});
    expect(registered).toHaveLength(0);
  });

  it('migrates a legacy plaintext clientSecret into credentials once and deletes it', () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const creds = new FakeCredentials(ctx);
    ctx.provide('channelControl', {
      definitions: { register: () => {} },
    });

    const config = makeConfig({ upstream: { mode: 'sdk', clientId: 'k', clientSecret: 'legacy-plaintext' } });
    apply(ctx, config, {});

    // Written to the default ref exactly once; plaintext removed from config.
    expect(creds.sets).toEqual([DINGTALK_CLIENT_SECRET_REF]);
    expect(creds.stored.get(DINGTALK_CLIENT_SECRET_REF)).toBe('legacy-plaintext');
    expect((config.upstream as { clientSecret?: string }).clientSecret).toBeUndefined();
  });

  it('migrates once only — no double-write when a legacy field persists', () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const creds = new FakeCredentials(ctx);
    ctx.provide('channelControl', {
      definitions: { register: () => {} },
    });

    // Simulate a config that still carries the plaintext twice (a pathological
    // double-registration); apply() must write only once per call and never both.
    const config = makeConfig({ upstream: { mode: 'sdk', clientId: 'k', clientSecret: 's1' } });
    apply(ctx, config, {});
    apply(ctx, config, {});
    expect(creds.sets).toEqual([DINGTALK_CLIENT_SECRET_REF]);
    expect(creds.stored.get(DINGTALK_CLIENT_SECRET_REF)).toBe('s1');
  });

  it('legacy fallback (no channelControl) does not throw when SDK credential is unconfigured', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    new FakeCredentials(ctx);

    // No credential stored; SDK mode. apply() must warn + return without throwing.
    expect(() => apply(ctx, makeConfig({ upstream: { mode: 'sdk', clientId: 'k' } }), {})).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ctx.channels.get('dingtalk')).toBeUndefined();
  });
});
