/**
 * ChannelControlService tests (doc §29–§31, §33, §46): convenience API around
 * the sub-managers — saveConfig secret rejection, listChannels merge,
 * getSetup descriptor.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  ChannelService,
  type ChannelAdapter,
  type ChannelCapabilities,
} from '@wsz987/channel-core';
import { ChannelControlService } from '../src/service.js';
import { ChannelDefinitionRegistry } from '../src/definitions/registry.js';
import { CredentialManager, type CredentialSeam } from '../src/credentials/manager.js';
import { AuthSessionManager } from '../src/auth/session-manager.js';
import { ChannelRuntimeManager } from '../src/runtime/manager.js';
import type { ChannelDefinition } from '../src/index.js';

const capabilities: ChannelCapabilities = {
  text: true,
  image: false,
  file: false,
  audio: false,
  video: false,
  markdown: true,
  cards: false,
  reactions: false,
  threads: false,
  streaming: 'buffered',
};

const seam: CredentialSeam = {
  async resolve() {
    return undefined;
  },
  async describe() {
    return { configured: false, writable: true };
  },
  async set() {},
  async unset() {},
};

function makeAdapter(id: string): ChannelAdapter {
  return {
    id,
    capabilities,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => ({ delivered: true })),
    getHealth: vi.fn(async () => ({ status: 'ok', connection: 'connected' })),
  } as unknown as ChannelAdapter;
}

function makeDef(id: string, overrides: Partial<ChannelDefinition> = {}): ChannelDefinition {
  return {
    id,
    enabled: true,
    setup: {
      fields: [
        { name: 'appId', kind: 'text', secret: false, configured: false, writable: true },
        { name: 'appSecret', kind: 'secret', secret: true, configured: false, writable: true },
      ],
      authMethods: ['credentials'],
    },
    getConfiguredState: async () => ({ configured: false, fields: {} }),
    saveConfig: vi.fn(async () => {}),
    createAdapter: async () => {
      throw new Error('not used');
    },
    ...overrides,
  } as ChannelDefinition;
}

function harness(defs: ChannelDefinition[], credentials: CredentialSeam = seam) {
  const ctx = new Context();
  new ChannelService(ctx);
  const registry = new ChannelDefinitionRegistry();
  for (const def of defs) registry.register(def);
  const service = new ChannelControlService(ctx, { credentials, registry });
  return { ctx, service, registry };
}

describe('ChannelControlService', () => {
  it('saveConfig rejects secret field names with SECRET_FIELD_REJECTED', async () => {
    const { service } = harness([makeDef('weixin')]);

    await expect(service.saveConfig('weixin', { appId: 'wx123' })).resolves.toBeUndefined();

    // Secret fields (by suffix and by descriptor kind:'secret') are rejected.
    await expect(service.saveConfig('weixin', { appSecret: 'x' })).rejects.toMatchObject({
      code: 'SECRET_FIELD_REJECTED',
    });
    await expect(service.saveConfig('weixin', { clientSecret: 'x' })).rejects.toMatchObject({
      code: 'SECRET_FIELD_REJECTED',
    });
    await expect(service.saveConfig('weixin', { accessToken: 'x' })).rejects.toMatchObject({
      code: 'SECRET_FIELD_REJECTED',
    });
    // 'appSecret' is both suffix-matching AND declared kind:'secret' in the
    // descriptor; it must never be persisted through saveConfig.
    await expect(
      service.saveConfig('weixin', { appSecret: 'declared-secret' }),
    ).rejects.toMatchObject({ code: 'SECRET_FIELD_REJECTED' });
  });

  it('saveConfig rejects a missing channel with a stable error', async () => {
    const { service } = harness([]);
    await expect(service.saveConfig('nope', { appId: '1' })).rejects.toThrow();
  });

  it('getSetup merges dynamic state and does not expose credential refs', async () => {
    const def = makeDef('lark', {
      setup: {
        fields: [
          { name: 'appId', kind: 'text', secret: false, configured: false, writable: true },
          { name: 'appSecret', kind: 'secret', secret: true, configured: false, writable: true, ref: 'LARK_APP_SECRET' },
        ],
        authMethods: [],
        setupUrl: 'https://open.feishu.cn/app',
      },
      getConfiguredState: async () => ({
        configured: true,
        fields: {
          appId: { configured: true, writable: true, value: 'cli_123' },
          // A buggy definition must never be able to leak a secret: the
          // control plane strips value for secret fields regardless.
          appSecret: { configured: true, writable: true, source: 'test', value: 'SHOULD_NEVER_LEAK' },
        },
      }),
    });
    const { service } = harness([def]);
    const setup = await service.getSetup('lark');
    expect(setup).toMatchObject({
      fields: [
        { name: 'appId', kind: 'text', secret: false, configured: true, value: 'cli_123' },
        { name: 'appSecret', kind: 'secret', secret: true, configured: true },
      ],
      authMethods: [],
      setupUrl: 'https://open.feishu.cn/app',
    });
    expect(JSON.stringify(setup)).not.toContain('LARK_APP_SECRET');
    expect(JSON.stringify(setup)).not.toContain('SHOULD_NEVER_LEAK');
  });

  it('listChannels merges registry + runtime status', async () => {
    const adapter = makeAdapter('qq');
    const def = makeDef('qq');
    def.createAdapter = async () => adapter;
    const def2 = makeDef('idle');
    def2.getConfiguredState = async () => ({ configured: true, fields: {} });

    const { service } = harness([def, def2]);

    await service.runtime.start('qq');
    const rows = await service.listChannels();
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get('qq')).toMatchObject({ mounted: true, runtime: 'running' });
    expect(byId.get('idle')).toMatchObject({ mounted: false, runtime: 'stopped' });
    await service.runtime.stop('qq');
  });

  it('applySetup can defer runtime reconciliation for an authorization prerequisite', async () => {
    let appId = '';
    const stored = new Map<string, string>();
    const credentials: CredentialSeam = {
      async resolve(ref) {
        const value = stored.get(ref);
        return value ? { value, source: 'test' } : undefined;
      },
      async describe(ref) {
        return { configured: stored.has(ref), writable: true, source: 'test' };
      },
      async set(ref, value) {
        stored.set(ref, value);
      },
      async unset(ref) {
        stored.delete(ref);
      },
    };
    const adapter = makeAdapter('qq');
    const def = makeDef('qq', {
      setup: {
        fields: [
          { name: 'appId', kind: 'text', secret: false, configured: false, writable: true },
          { name: 'appSecret', kind: 'secret', secret: true, configured: false, writable: true, ref: 'QQBOT_APP_SECRET' },
        ],
        authMethods: [],
      },
      saveConfig: vi.fn(async (patch) => {
        if (typeof patch.appId === 'string') appId = patch.appId;
      }),
      getConfiguredState: async () => ({
        configured: Boolean(appId) && stored.has('QQBOT_APP_SECRET'),
        fields: {
          appId: { configured: Boolean(appId), writable: true },
          appSecret: { configured: stored.has('QQBOT_APP_SECRET'), writable: true },
        },
      }),
      createAdapter: async () => adapter,
    });
    const { service } = harness([def], credentials);

    const deferred = await service.applySetup('qq', {
      config: { appId: '102345678' },
      credentials: { appSecret: 'secret-value' },
      reconcile: false,
    });

    expect(def.saveConfig).toHaveBeenCalledWith({ appId: '102345678' });
    expect(stored.get('QQBOT_APP_SECRET')).toBe('secret-value');
    expect(adapter.start).not.toHaveBeenCalled();
    expect(deferred).toEqual({ configured: true, connection: 'unknown' });

    const result = await service.applySetup('qq', { config: {}, credentials: {} });

    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ configured: true, connection: 'connected' });
  });

  it('applySetup restores the prior setup and running adapter when replacement startup fails', async () => {
    let appId = 'old-app';
    const stored = new Map<string, string>([['QQBOT_APP_SECRET', 'old-secret']]);
    const credentials: CredentialSeam = {
      async resolve(ref) {
        const value = stored.get(ref);
        return value ? { value, source: 'test' } : undefined;
      },
      async describe(ref) {
        return { configured: stored.has(ref), writable: true, source: 'test' };
      },
      async set(ref, value) {
        stored.set(ref, value);
      },
      async unset(ref) {
        stored.delete(ref);
      },
    };
    const oldAdapter = makeAdapter('qq');
    const failingAdapter = makeAdapter('qq');
    failingAdapter.start = vi.fn(async () => {
      throw new Error('invalid replacement credentials');
    });
    const def = makeDef('qq', {
      setup: {
        fields: [
          { name: 'appId', kind: 'text', secret: false, configured: true, writable: true },
          { name: 'appSecret', kind: 'secret', secret: true, configured: true, writable: true, ref: 'QQBOT_APP_SECRET' },
        ],
        authMethods: [],
      },
      getConfiguredState: async () => ({
        configured: Boolean(appId) && stored.has('QQBOT_APP_SECRET'),
        fields: {
          appId: { configured: Boolean(appId), writable: true, value: appId },
          appSecret: { configured: stored.has('QQBOT_APP_SECRET'), writable: true },
        },
      }),
      saveConfig: vi.fn(async (patch) => {
        if (typeof patch.appId === 'string') appId = patch.appId;
      }),
      snapshotConfig: () => appId,
      restoreConfig: (snapshot) => {
        appId = snapshot as string;
      },
      createAdapter: async () => (appId === 'old-app' ? oldAdapter : failingAdapter),
    });
    const { ctx, service } = harness([def], credentials);

    await service.runtime.start('qq');
    await expect(
      service.applySetup('qq', {
        config: { appId: 'new-app' },
        credentials: { appSecret: 'new-secret' },
      }),
    ).rejects.toThrow('invalid replacement credentials');

    expect(ctx.channels.get('qq')).toBe(oldAdapter);
    expect(service.runtime.isRunning('qq')).toBe(true);
    expect(appId).toBe('old-app');
    expect(stored.get('QQBOT_APP_SECRET')).toBe('old-secret');
    expect(oldAdapter.stop).toHaveBeenCalledTimes(1);
    expect(oldAdapter.start).toHaveBeenCalledTimes(2);
    await service.runtime.stop('qq');
  });

  it('applySetup stops a running channel when the submitted setup becomes incomplete', async () => {
    let appId = 'old-app';
    const stored = new Map<string, string>([['QQBOT_APP_SECRET', 'old-secret']]);
    const credentials: CredentialSeam = {
      async resolve(ref) {
        const value = stored.get(ref);
        return value ? { value, source: 'test' } : undefined;
      },
      async describe(ref) {
        return { configured: stored.has(ref), writable: true, source: 'test' };
      },
      async set(ref, value) {
        stored.set(ref, value);
      },
      async unset(ref) {
        stored.delete(ref);
      },
    };
    const adapter = makeAdapter('qq');
    const def = makeDef('qq', {
      setup: {
        fields: [
          { name: 'appId', kind: 'text', secret: false, configured: true, writable: true },
          { name: 'appSecret', kind: 'secret', secret: true, configured: true, writable: true, ref: 'QQBOT_APP_SECRET' },
        ],
        authMethods: [],
      },
      getConfiguredState: async () => ({
        configured: Boolean(appId) && stored.has('QQBOT_APP_SECRET'),
        fields: {
          appId: { configured: Boolean(appId), writable: true, value: appId },
          appSecret: { configured: stored.has('QQBOT_APP_SECRET'), writable: true },
        },
      }),
      saveConfig: vi.fn(async (patch) => {
        if (typeof patch.appId === 'string') appId = patch.appId;
      }),
      snapshotConfig: () => appId,
      restoreConfig: (snapshot) => {
        appId = snapshot as string;
      },
      createAdapter: async () => adapter,
    });
    const { ctx, service } = harness([def], credentials);

    await service.runtime.start('qq');
    await expect(
      service.applySetup('qq', {
        config: { appId: '' },
        credentials: { appSecret: 'new-secret' },
      }),
    ).resolves.toEqual({ configured: false, connection: 'unknown' });

    expect(ctx.channels.get('qq')).toBeUndefined();
    expect(service.runtime.isRunning('qq')).toBe(false);
    expect(appId).toBe('');
    expect(stored.get('QQBOT_APP_SECRET')).toBe('new-secret');
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(adapter.start).toHaveBeenCalledTimes(1);
  });

  it('describeCredential maps a setup field to its credential ref without returning the value', async () => {
    const store = new Map<string, string>([['LARK_APP_SECRET', 's3cret']]);
    const seamWithValues: CredentialSeam = {
      async resolve(ref) {
        const value = store.get(ref);
        return value ? { value, source: 'test' } : undefined;
      },
      async describe(ref) {
        return { configured: store.has(ref), writable: true, source: 'test' };
      },
      async set(ref, value) {
        store.set(ref, value);
      },
      async unset(ref) {
        store.delete(ref);
      },
    };
    const ctx = new Context();
    new ChannelService(ctx);
    const registry = new ChannelDefinitionRegistry();
    registry.register(
      makeDef('lark', {
        setup: {
          fields: [
            { name: 'appId', kind: 'text', secret: false, configured: true, writable: true },
            { name: 'appSecret', kind: 'secret', secret: true, configured: true, writable: true, ref: 'LARK_APP_SECRET' },
          ],
          authMethods: ['credentials'],
        },
      }),
    );
    const service = new ChannelControlService(ctx, { credentials: seamWithValues, registry });

    const described = await service.describeCredential('lark', 'appSecret');
    expect(described).toMatchObject({ configured: true, writable: true });
    // The value itself never surfaces through the control plane.
    expect(JSON.stringify(described)).not.toContain('s3cret');
    // Non-secret field: no ref -> reported as not configured, no crash.
    await expect(service.describeCredential('lark', 'appId')).resolves.toMatchObject({
      configured: false,
    });
  });

  it('saveCredential writes through the ref and never echoes the value', async () => {
    const writes: { ref: string; value: string }[] = [];
    const seamRecorder: CredentialSeam = {
      async resolve() {
        return undefined;
      },
      async describe(ref) {
        return { configured: writes.some((w) => w.ref === ref), writable: true };
      },
      async set(ref, value) {
        writes.push({ ref, value });
      },
      async unset() {},
    };
    const ctx = new Context();
    new ChannelService(ctx);
    const registry = new ChannelDefinitionRegistry();
    registry.register(
      makeDef('qq', {
        setup: {
          fields: [
            { name: 'appId', kind: 'text', secret: false, configured: false, writable: true },
            { name: 'appSecret', kind: 'secret', secret: true, configured: false, writable: true, ref: 'QQBOT_APP_SECRET' },
          ],
          authMethods: ['credentials'],
        },
      }),
    );
    const service = new ChannelControlService(ctx, { credentials: seamRecorder, registry });

    const result = await service.saveCredential('qq', 'appSecret', 'top-secret-value');
    expect(result).toMatchObject({ configured: true, writable: true });
    expect(writes).toEqual([{ ref: 'QQBOT_APP_SECRET', value: 'top-secret-value' }]);
    // Saving a non-secret field through the credential endpoint is rejected.
    await expect(service.saveCredential('qq', 'appId', 'x')).rejects.toMatchObject({
      code: 'NOT_A_SECRET_FIELD',
    });
    // Unknown field name is a stable error.
    await expect(service.saveCredential('qq', 'nope', 'x')).rejects.toMatchObject({
      code: 'UNKNOWN_FIELD',
    });
  });

  it('saveCredential with an empty value clears the credential via unset', async () => {
    const writes: { ref: string; value: string }[] = [];
    const unsets: string[] = [];
    const seamRecorder: CredentialSeam = {
      async resolve() {
        return undefined;
      },
      async describe(ref) {
        // configured only when set and not subsequently unset.
        return {
          configured: !unsets.includes(ref) && writes.some((w) => w.ref === ref),
          writable: true,
        };
      },
      async set(ref, value) {
        writes.push({ ref, value });
      },
      async unset(ref) {
        unsets.push(ref);
      },
    };
    const ctx = new Context();
    new ChannelService(ctx);
    const registry = new ChannelDefinitionRegistry();
    registry.register(
      makeDef('qq', {
        setup: {
          fields: [
            { name: 'appSecret', kind: 'secret', secret: true, configured: false, writable: true, ref: 'QQBOT_APP_SECRET' },
          ],
          authMethods: ['credentials'],
        },
      }),
    );
    const service = new ChannelControlService(ctx, { credentials: seamRecorder, registry });

    const result = await service.saveCredential('qq', 'appSecret', '');
    expect(result).toMatchObject({ configured: false, writable: true });
    expect(unsets).toEqual(['QQBOT_APP_SECRET']);
    expect(writes).toEqual([]);
  });

  it('registers ctx.channelControl via module augmentation and Cordis Service', () => {
    const ctx = new Context();
    new ChannelService(ctx);
    new ChannelControlService(ctx, { credentials: seam });
    // `ctx.<name>` resolves through the cordis context proxy; assert the
    // exposed instance shape instead of object identity (same pattern as the
    // channel-core tests for `ctx.channels`).
    expect(ctx.channelControl.name).toBe('channelControl');
    expect(ctx.channelControl).toBeInstanceOf(ChannelControlService);
    expect(ctx.channelControl.definitions).toBeInstanceOf(ChannelDefinitionRegistry);
    expect(ctx.channelControl.credentials).toBeInstanceOf(CredentialManager);
    expect(ctx.channelControl.auth).toBeInstanceOf(AuthSessionManager);
    expect(ctx.channelControl.runtime).toBeInstanceOf(ChannelRuntimeManager);
  });
});

describe('ChannelControlService enable lifecycle (doc §22, §25, §27)', () => {
  /**
   * Build a definition whose `enabled` is a live getter over mutable state and
   * whose `setEnabled` persists the intent (mirrors the adapter definitions).
   * `makeDef` spreads overrides as data properties, so the dynamic getter is
   * installed afterwards with defineProperty.
   */
  function makeToggleableDef(
    initialEnabled: boolean,
    overrides: Partial<ChannelDefinition> = {},
  ): { def: ChannelDefinition; persisted: boolean[]; setEnabled: ReturnType<typeof vi.fn> } {
    let enabled = initialEnabled;
    const persisted: boolean[] = [];
    const setEnabled = vi.fn(async (next: boolean) => {
      enabled = next;
      persisted.push(next);
    });
    const def = makeDef('qq', { getConfiguredState: async () => ({ configured: true, fields: {} }), ...overrides });
    Object.defineProperty(def, 'enabled', { get: () => enabled, configurable: true });
    (def as { setEnabled?: unknown }).setEnabled = setEnabled;
    return { def, persisted, setEnabled };
  }

  it('disabled definitions still appear in the directory (acceptance 39.9)', async () => {
    const { def } = makeToggleableDef(false);
    const { service } = harness([def]);
    const rows = await service.listChannels();
    expect(rows.map((r) => r.id)).toContain('qq');
    expect(rows.find((r) => r.id === 'qq')).toMatchObject({
      enabled: false,
      configured: true,
      mounted: false,
      runtime: 'stopped',
    });
  });

  it('setEnabled(true) persists the intent and starts a configured runtime', async () => {
    const { def, persisted, setEnabled } = makeToggleableDef(false);
    const adapter = makeAdapter('qq');
    def.createAdapter = async () => adapter;
    const { service } = harness([def]);

    await service.setEnabled('qq', true);
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(persisted).toEqual([true]);
    expect(service.runtime.isRunning('qq')).toBe(true);
    expect(await service.getChannel('qq')).toMatchObject({
      enabled: true,
      mounted: true,
      runtime: 'running',
      connection: 'connected',
    });

    await service.runtime.stop('qq');
  });

  it('setEnabled(false) persists the intent and stops the runtime', async () => {
    const { def, persisted, setEnabled } = makeToggleableDef(true);
    const adapter = makeAdapter('qq');
    def.createAdapter = async () => adapter;
    const { service } = harness([def]);

    await service.setEnabled('qq', true); // enabled + configured -> running
    expect(service.runtime.isRunning('qq')).toBe(true);

    await service.setEnabled('qq', false);
    expect(setEnabled).toHaveBeenLastCalledWith(false);
    expect(persisted).toEqual([true, false]);
    expect(service.runtime.isRunning('qq')).toBe(false);
    expect(await service.getChannel('qq')).toMatchObject({
      enabled: false,
      mounted: false,
      runtime: 'stopped',
    });
  });

  it('setEnabled(true) leaves an unconfigured channel stopped', async () => {
    const { def } = makeToggleableDef(false, {
      getConfiguredState: async () => ({ configured: false, fields: {} }),
    });
    def.createAdapter = vi.fn(async () => {
      throw new Error('must not be created for an unconfigured channel');
    });
    const { service } = harness([def]);

    await service.setEnabled('qq', true);
    expect(service.runtime.isRunning('qq')).toBe(false);
    expect(await service.getChannel('qq')).toMatchObject({
      enabled: true,
      configured: false,
      mounted: false,
      runtime: 'stopped',
    });
  });

  it('setEnabled without a definition.setEnabled throws ENABLE_NOT_SUPPORTED', async () => {
    const { service } = harness([makeDef('qq')]);
    await expect(service.setEnabled('qq', true)).rejects.toMatchObject({
      code: 'ENABLE_NOT_SUPPORTED',
    });
    await expect(service.setEnabled('qq', false)).rejects.toMatchObject({
      code: 'ENABLE_NOT_SUPPORTED',
    });
  });

  it('a disabled definition registered after the service is not auto-started', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const registry = new ChannelDefinitionRegistry();
    const service = new ChannelControlService(ctx, { credentials: seam, registry });
    const { def } = makeToggleableDef(false);
    const adapter = makeAdapter('qq');
    def.createAdapter = async () => adapter;

    registry.register(def);
    expect(service.runtime.isRunning('qq')).toBe(false);

    await service.setEnabled('qq', true);
    expect(service.runtime.isRunning('qq')).toBe(true);
    await service.runtime.stop('qq');
  });
});
