/**
 * channel-qq ChannelDefinition + control-plane apply() tests (M2B-Task6).
 *
 * Covers the universal Channel Control Plane integration offline:
 *  - createQQDefinition() setup descriptor shape
 *  - getConfiguredState() dynamic appId/appSecret state (via a fake credential seam)
 *  - createAdapter() resolving the secret and threading it into deps.appSecret
 *  - createAdapter() throwing a stable ControlError when the credential is missing
 *  - saveConfig() merging a non-secret patch into the snapshot used by createAdapter()
 *  - apply() registering the definition into ctx.channelControl.definitions.register
 *  - apply() legacy fallback: mounts only when configured; logs + returns (no throw,
 *    no mount) when not configured (doc §25).
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, type ChannelAdapterContext } from '@wsz987/channel-core';
import { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials';
import { Config, QQAdapter, apply, createQQDefinition } from '../src/index.ts';
import { FakeQQSdkClient } from '../src/sdk-client.ts';
import type { QQConfig } from '../src/config.ts';
import type { CredentialSeam } from '../src/definition.ts';

/** Minimal in-memory credential seam (structural, not dsh-credentials). */
class FakeSeam implements CredentialSeam {
  store = new Map<string, string>();
  resolveCalled: string[] = [];
  describeCalled: string[] = [];
  source = 'test';
  writable = true;

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    this.resolveCalled.push(ref);
    const value = this.store.get(ref);
    return value === undefined ? undefined : { value, source: this.source };
  }

  async describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }> {
    this.describeCalled.push(ref);
    return {
      configured: this.store.has(ref),
      source: this.store.has(ref) ? this.source : undefined,
      writable: this.writable,
    };
  }

  async set(ref: string, value: string): Promise<void> {
    this.store.set(ref, value);
  }

  async unset(ref: string): Promise<void> {
    this.store.delete(ref);
  }
}

function makeConfig(overrides: Partial<QQConfig> = {}): QQConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    appId: 'dummy-app-id',
    appSecretRef: 'QQBOT_APP_SECRET',
    markdownSupport: false,
    streaming: { enabled: true, throttleMs: 500 },
    dedup: { enabled: true, windowMs: 5000 },
    startupTimeoutMs: 15000,
    ...overrides,
  });
}

function makeDefinition(overrides: {
  config?: Partial<QQConfig>;
  deps?: { sdkClient?: FakeQQSdkClient };
  seam?: FakeSeam;
  persistSetup?: (patch: Pick<QQConfig, 'appId'>) => Promise<void>;
} = {}) {
  const config = makeConfig(overrides.config);
  const seam = overrides.seam ?? new FakeSeam();
  const deps = overrides.deps ?? {};
  const definition = createQQDefinition({
    config,
    deps,
    credentials: seam,
    persistSetup: overrides.persistSetup,
  });
  return { definition, seam, config, deps };
}

/** Minimal credentials provider for the legacy apply() fallback path. */
class FakeCredentials extends CredentialProvider {
  configured = true;

  async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return this.configured ? { value: 'test-secret', source: 'test' } : undefined;
  }

  async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: this.configured, writable: false, source: 'test' };
  }

  async set(_ref: CredentialRef, _value: string): Promise<void> {}

  async unset(_ref: CredentialRef): Promise<void> {}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createQQDefinition', () => {
  it('exposes credential fields and the official console without fake auth methods', () => {
    const { definition } = makeDefinition();
    expect(definition.id).toBe('qq');
    expect(definition.enabled).toBe(true);
    expect(definition.autoStart).toBe(true);
    expect(definition.setup.authMethods).toEqual([]);
    // The configured appId deep-links into the QQ openclaw console.
    expect(definition.setup.setupUrl).toBe('https://q.qq.com/qqbot/openclaw/?appid=dummy-app-id');
    expect(definition.beginAuth).toBeUndefined();
    expect(definition.pollAuth).toBeUndefined();
    expect(definition.submitAuthInput).toBeUndefined();

    const appId = definition.setup.fields.find((f) => f.name === 'appId');
    expect(appId).toEqual({
      name: 'appId',
      kind: 'text',
      secret: false,
      configured: true,
      writable: true,
    });

    const appSecret = definition.setup.fields.find((f) => f.name === 'appSecret');
    expect(appSecret).toMatchObject({
      name: 'appSecret',
      kind: 'secret',
      secret: true,
      writable: true,
      ref: 'QQBOT_APP_SECRET',
    });
  });

  it('setup reflects config.enabled and appId configured flag', () => {
    const { definition } = makeDefinition({ config: { enabled: false, appId: '' } });
    expect(definition.enabled).toBe(false);
    const appId = definition.setup.fields.find((f) => f.name === 'appId')!;
    expect(appId.configured).toBe(false);
  });

  it('setupUrl falls back to the openclaw console when appId is not configured', () => {
    const { definition } = makeDefinition({ config: { appId: '' } });
    expect(definition.setup.setupUrl).toBe('https://q.qq.com/qqbot/openclaw/');
  });

  it('saveConfig keeps the console deep-link in sync with the patched appId', async () => {
    const { definition } = makeDefinition({ config: { appId: '' } });
    await definition.saveConfig({ appId: 'patched-app-id' });
    expect(definition.setup.setupUrl).toBe('https://q.qq.com/qqbot/openclaw/?appid=patched-app-id');
  });

  it('uses the default writable credential ref when appSecretRef is blank', () => {
    const { definition } = makeDefinition({ config: { appSecretRef: '' } });
    const appSecret = definition.setup.fields.find((field) => field.name === 'appSecret');
    expect(appSecret?.ref).toBe('QQBOT_APP_SECRET');
  });

  it('getConfiguredState: configured when appId present and credential configured', async () => {
    const { definition, seam } = makeDefinition();
    seam.set('QQBOT_APP_SECRET', 'top-secret');
    const state = await definition.getConfiguredState();
    expect(state.configured).toBe(true);
    expect(state.fields.appId).toEqual({ configured: true, writable: true, value: 'dummy-app-id' });
    expect(state.fields.appSecret).toMatchObject({
      configured: true,
      writable: true,
      source: 'test',
    });
    expect(seam.describeCalled).toContain('QQBOT_APP_SECRET');
  });

  it('getConfiguredState: reflected as unconfigured when the credential is missing', async () => {
    const { definition } = makeDefinition();
    const state = await definition.getConfiguredState();
    expect(state.configured).toBe(false);
    expect(state.fields.appSecret.configured).toBe(false);
  });

  it('getConfiguredState: unconfigured when appId is missing even if the credential exists', async () => {
    const { definition, seam } = makeDefinition({ config: { appId: '' } });
    seam.set('QQBOT_APP_SECRET', 'x');
    const state = await definition.getConfiguredState();
    expect(state.fields.appId.configured).toBe(false);
    expect(state.configured).toBe(false);
  });

  it('createAdapter resolves the secret and threads it into deps.appSecret', async () => {
    const client = new FakeQQSdkClient();
    const { definition, seam } = makeDefinition({ deps: { sdkClient: client } });
    seam.set('QQBOT_APP_SECRET', 'top-secret');

    const adapter = (await definition.createAdapter()) as QQAdapter;
    expect(adapter).toBeInstanceOf(QQAdapter);
    expect(seam.resolveCalled).toContain('QQBOT_APP_SECRET');
    // The resolved secret must have reached the adapter's injected deps.
    expect(adapter.testAppSecret).toBe('top-secret');
  });

  it('createAdapter throws a stable ControlError when the credential is missing', async () => {
    const { definition } = makeDefinition();
    await expect(definition.createAdapter()).rejects.toMatchObject({
      code: 'CONTROL_ERROR',
    });
    await expect(definition.createAdapter()).rejects.toThrow(
      'QQ credential "QQBOT_APP_SECRET" is not configured',
    );
  });

  it('saveConfig merges a non-secret patch into the snapshot used by createAdapter', async () => {
    const client = new FakeQQSdkClient();
    const { definition, seam } = makeDefinition({ deps: { sdkClient: client } });
    seam.set('QQBOT_APP_SECRET', 'top-secret');

    await definition.saveConfig({ appId: 'patched-app-id' });

    const adapter = (await definition.createAdapter()) as QQAdapter;
    // The adapter is built from the updated snapshot config.
    expect(adapter.id).toBe('qq');
    // The resolved secret still flows through.
    expect(adapter.testAppSecret).toBe('top-secret');

    // The snapshot now feeds getConfiguredState: appId reflects the patch.
    const state = await definition.getConfiguredState();
    expect(state.fields.appId.configured).toBe(true);
  });

  it('persists appId changes and a transactional restore without touching credentials', async () => {
    const persistSetup = vi.fn(async () => {});
    const { definition } = makeDefinition({ persistSetup });
    const before = definition.snapshotConfig!();

    await definition.saveConfig({ appId: 'replacement-app-id' });
    await definition.restoreConfig!(before);

    expect(persistSetup).toHaveBeenNthCalledWith(1, { appId: 'replacement-app-id' });
    expect(persistSetup).toHaveBeenNthCalledWith(2, { appId: 'dummy-app-id' });
  });

  it('saveConfig deep-merges streaming/dedup sub-objects and ignores unknown keys', async () => {
    const client = new FakeQQSdkClient();
    const { definition, seam } = makeDefinition({ deps: { sdkClient: client } });
    seam.set('QQBOT_APP_SECRET', 'top-secret');

    await definition.saveConfig({
      streaming: { enabled: false },
      dedup: { windowMs: 1234 },
      unknownKey: 'ignored',
    });

    const adapter = (await definition.createAdapter()) as QQAdapter;
    // streaming.enabled is private on the adapter; observe it via resolveStreamingMode.
    const target = {
      channelId: 'qq' as never,
      accountId: 'main' as never,
      conversationId: 'c' as never,
      conversationType: 'dm' as never,
      replyToMessageId: 'm' as never,
    };
    // streaming.enabled=false forces buffered even for a C2C+msgId reply target.
    expect(adapter.resolveStreamingMode(target)).toBe('buffered');
  });
});

describe('apply() — channel-control registration', () => {
  it('registers the definition into ctx.channelControl.definitions (spy on register)', () => {
    const register = vi.fn();
    const fakeControl = { definitions: { register } };
    // A fresh Context with injected fakes; registration itself is sync and does
    // not touch the credential seam, so a structural FakeSeam suffices here.
    const ctx = new Context() as Context & {
      channelControl?: { definitions: { register(d: unknown): unknown } };
      credentials?: CredentialSeam;
    };
    ctx.provide('channelControl', fakeControl);
    ctx.credentials = new FakeSeam();

    apply(ctx, makeConfig());

    expect(register).toHaveBeenCalledTimes(1);
    const registered = register.mock.calls[0][0] as { createQQDefinition?: unknown };
    expect(registered).toBeDefined();
    expect((registered as { id?: string }).id).toBe('qq');
  });

  it('does nothing when the channel is disabled', () => {
    const register = vi.fn();
    const ctx = new Context() as Context & {
      channelControl?: { definitions: { register(d: unknown): unknown } };
      credentials?: CredentialSeam;
    };
    ctx.provide('channelControl', { definitions: { register } });
    ctx.credentials = new FakeSeam();

    apply(ctx, makeConfig({ enabled: false }));

    expect(register).not.toHaveBeenCalled();
  });
});

describe('apply() — legacy fallback (no channelControl)', () => {
  function ctxWithChannels(configured: boolean): Context {
    const ctx = new Context();
    new ChannelService(ctx);
    const credentials = new FakeCredentials(ctx);
    credentials.configured = configured;
    return ctx;
  }

  it('mounts when configured (registers the adapter)', async () => {
    const ctx = ctxWithChannels(true);
    let captured: ChannelAdapterContext | undefined;
    vi.spyOn(QQAdapter.prototype, 'start').mockImplementation(
      async function (this: QQAdapter, adapterCtx: ChannelAdapterContext) {
        captured = adapterCtx;
        return undefined;
      },
    );
    vi.spyOn(QQAdapter.prototype, 'stop').mockImplementation(async function () {
      return undefined;
    });

    try {
      apply(ctx, makeConfig());
      await tick();
      await tick();
      await tick();
      expect(captured).toBeDefined();
      expect(ctx.channels.get('qq')).toBeInstanceOf(QQAdapter);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does NOT throw and does NOT mount when unconfigured', async () => {
    const ctx = ctxWithChannels(false);
    const spy = vi.spyOn(QQAdapter.prototype, 'start');

    try {
      expect(() => apply(ctx, makeConfig())).not.toThrow();
      await tick();
      await tick();
      await tick();
      expect(ctx.channels.get('qq')).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does NOT throw when no appSecretRef is set', async () => {
    const ctx = ctxWithChannels(true);
    const spy = vi.spyOn(QQAdapter.prototype, 'start');

    try {
      // appSecretRef omitted -> early warn + return, no effect.
      expect(() => apply(ctx, makeConfig({ appSecretRef: '' }))).not.toThrow();
      await tick();
      await tick();
      await tick();
      expect(ctx.channels.get('qq')).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
