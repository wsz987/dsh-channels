/**
 * channel-lark ChannelDefinition tests.
 *
 * Exercises the control-plane binding of the lark channel — setup descriptor,
 * configured-state reporting, non-secret saveConfig merging, adapter
 * instantiation (credential resolution), and the apply() behaviors (definition
 * registration into ctx.channelControl and the no-control-plane fallback).
 * Fully offline: fake credentials seam + fake sdk/openapi clients via deps.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, type ChannelAdapterContext } from '@wsz987/channel-core';
import { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { ChannelDefinition } from '@wsz987/channel-control';
import {
  Config,
  LarkAdapter,
  createLarkDefinition,
  LARK_APP_SECRET_REF,
  apply,
  type LarkSdkClient,
  type LarkOpenApiClient,
} from '../src/index.ts';
import type { LarkConfig } from '../src/config.ts';

function makeConfig(overrides: Partial<LarkConfig> = {}): LarkConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    timeoutMs: 1000,
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
    dedup: { enabled: true, windowMs: 5000 },
    card: { createOnFirstDelta: true },
    upstream: { appId: 'cli_default' },
    ...overrides,
  });
}

/** Minimal in-memory credentials provider for apply()/definition credential paths. */
class FakeCredentials extends CredentialProvider {
  readonly sets: { ref: string; value: string }[] = [];
  constructor(
    ctx: Context,
    private readonly values: Record<string, string> = {},
  ) {
    super(ctx);
  }

  async resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined> {
    const value = this.values[String(ref)];
    return value ? { value, source: 'test' } : undefined;
  }

  async describe(ref: CredentialRef): Promise<{ configured: boolean; source?: string; writable: boolean }> {
    return { configured: Boolean(this.values[String(ref)]), writable: true, source: 'test' };
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    this.sets.push({ ref: String(ref), value });
    this.values[String(ref)] = value;
  }

  async unset(ref: CredentialRef): Promise<void> {
    delete this.values[String(ref)];
  }
}

/** Fake WS client (offline); satisfies the adapter's injected client surface. */
const fakeClient: LarkSdkClient = {
  async start() {},
  close() {},
};

/** Fake OpenAPI client (offline). */
const fakeOpenApi: LarkOpenApiClient = {
  im: {
    v1: {
      message: {
        create: async () => ({ code: 0, data: { message_id: 'om_x' } }),
        patch: async () => ({ code: 0 }),
      },
      image: {
        create: async () => ({ image_key: 'img_x' }),
      },
    },
  },
  cardkit: {
    v1: {
      card: {
        create: async () => ({ code: 0, data: { card_id: 'cc_x' } }),
        settings: async () => ({ code: 0 }),
      },
      cardElement: {
        content: async () => ({ code: 0 }),
      },
    },
  },
};

function stubStart(): void {
  vi.spyOn(LarkAdapter.prototype, 'start').mockImplementation(
    async function (this: LarkAdapter, _ctx: ChannelAdapterContext) {
      return undefined;
    },
  );
}

describe('lark ChannelDefinition', () => {
  it('exposes the setup descriptor with appId (text) and appSecret (secret + ref)', () => {
    const definition = createLarkDefinition({
      config: makeConfig({ upstream: { appId: 'cli_abc' } }),
      credentials: {
        resolve: async () => undefined,
        describe: async () => ({ configured: true, writable: true }),
        set: async () => {},
      },
    });
    expect(definition.id).toBe('lark');
    expect(definition.enabled).toBe(true);
    expect(definition.autoStart).toBe(true);
    expect(definition.setup.authMethods).toEqual(['credentials', 'hybrid']);
    // The configured appId deep-links into the Feishu console app page.
    expect(definition.setup.setupUrl).toBe('https://open.feishu.cn/app/cli_abc');
    expect(definition.setup.fields).toHaveLength(2);

    const appId = definition.setup.fields.find((f) => f.name === 'appId');
    expect(appId).toMatchObject({ kind: 'text', secret: false, configured: true, writable: true });
    expect(appId?.ref).toBeUndefined();

    const appSecret = definition.setup.fields.find((f) => f.name === 'appSecret');
    expect(appSecret).toMatchObject({ kind: 'secret', secret: true, writable: true });
    expect(appSecret?.ref).toBe(LARK_APP_SECRET_REF);

    expect(definition.beginAuth).toBeTypeOf('function');
    expect(definition.pollAuth).toBeTypeOf('function');
    expect(definition.submitAuthInput).toBeUndefined();
  });

  it('uses the Lark console URL for the overseas domain', () => {
    const definition = createLarkDefinition({
      config: makeConfig({ upstream: { appId: 'cli_abc', domain: 'lark' } }),
      credentials: { resolve: async () => undefined, describe: async () => ({ configured: true, writable: true }), set: async () => {} },
    });
    expect(definition.setup.setupUrl).toBe('https://open.larksuite.com/app/cli_abc');
  });

  it('falls back to the app list URL when appId is not configured', () => {
    const definition = createLarkDefinition({
      config: makeConfig({ upstream: { appId: undefined } }),
      credentials: { resolve: async () => undefined, describe: async () => ({ configured: true, writable: true }), set: async () => {} },
    });
    expect(definition.setup.setupUrl).toBe('https://open.feishu.cn/app');
  });

  it('reports configured state from appId (config) AND appSecret (credential)', async () => {
    const definition = createLarkDefinition({
      config: makeConfig({ upstream: { appId: 'cli_abc' } }),
      credentials: {
        resolve: async () => ({ value: 'secret', source: 'test' }),
        describe: async () => ({ configured: true, writable: true, source: 'test' }),
        set: async () => {},
      },
    });
    const state = await definition.getConfiguredState();
    expect(state.configured).toBe(true);
    expect(state.fields.appId).toMatchObject({ configured: true, writable: true, value: 'cli_abc' });
    expect(state.fields.appSecret).toMatchObject({ configured: true, writable: true });
    expect(JSON.stringify(state)).not.toContain('secret');
  });

  it('reports unconfigured when the appSecret credential is missing', async () => {
    const definition = createLarkDefinition({
      config: makeConfig({ upstream: { appId: 'cli_abc' } }),
      credentials: {
        resolve: async () => undefined,
        describe: async () => ({ configured: false, writable: true, source: 'test' }),
        set: async () => {},
      },
    });
    const state = await definition.getConfiguredState();
    expect(state.configured).toBe(false);
    expect(state.fields.appSecret.configured).toBe(false);
  });

  it('reports unconfigured when appId is missing from config', async () => {
    const definition = createLarkDefinition({
      config: makeConfig({ upstream: { appId: undefined } }),
      credentials: { resolve: async () => undefined, describe: async () => ({ configured: true, writable: true }), set: async () => {} },
    });
    const state = await definition.getConfiguredState();
    expect(state.configured).toBe(false);
    expect(state.fields.appId.configured).toBe(false);
  });

  it('createAdapter resolves the AppSecret and injects appId/appSecret into deps', async () => {
    stubStart();
    try {
      const definition = createLarkDefinition({
        config: makeConfig({ upstream: { appId: 'cli_abc' } }),
        deps: { sdkClient: fakeClient, openApiClient: fakeOpenApi },
        credentials: {
          resolve: async (ref) => ({ value: ref === LARK_APP_SECRET_REF ? 'the-secret' : undefined, source: 'test' }),
          describe: async () => ({ configured: true, writable: true }),
          set: async () => {},
        },
      });
      const adapter = (await definition.createAdapter()) as unknown as { deps: { appId?: string; appSecret?: string } };
      expect(adapter).toBeDefined();
      expect(adapter.deps.appId).toBe('cli_abc');
      expect(adapter.deps.appSecret).toBe('the-secret');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('createAdapter throws a stable error when the AppSecret is missing', async () => {
    const definition = createLarkDefinition({
      config: makeConfig({ upstream: { appId: 'cli_abc' } }),
      credentials: { resolve: async () => undefined, describe: async () => ({ configured: false, writable: true }), set: async () => {} },
    });
    await expect(definition.createAdapter()).rejects.toThrow(/appSecret.*credentials ref/);
  });

  it('createAdapter throws when the AppId is missing from config', async () => {
    const definition = createLarkDefinition({
      config: makeConfig({ upstream: { appId: undefined } }),
      credentials: {
        resolve: async (ref) => ({ value: ref === LARK_APP_SECRET_REF ? 'secret' : undefined, source: 'test' }),
        describe: async () => ({ configured: true, writable: true }),
        set: async () => {},
      },
    });
    await expect(definition.createAdapter()).rejects.toThrow(/appId/);
  });

  it('saveConfig merges non-secret patches (appId, domain, accountId) into the snapshot used by createAdapter', async () => {
    stubStart();
    try {
      const definition = createLarkDefinition({
        config: makeConfig({ upstream: { appId: 'cli_old' } }),
        deps: { sdkClient: fakeClient, openApiClient: fakeOpenApi },
        credentials: {
          resolve: async (ref) => ({ value: ref === LARK_APP_SECRET_REF ? 'secret' : undefined, source: 'test' }),
          describe: async () => ({ configured: true, writable: true }),
          set: async () => {},
        },
      });
      await definition.saveConfig({
        appId: 'cli_new',
        upstream: { domain: 'lark' },
        accountId: 'second',
      } as Record<string, unknown>);
      const state = await definition.getConfiguredState();
      expect(state.fields.appId.configured).toBe(true);

      const adapter = (await definition.createAdapter()) as unknown as { config: LarkConfig };
      expect(adapter.config.upstream.appId).toBe('cli_new');
      expect(adapter.config.upstream.domain).toBe('lark');
      expect(adapter.config.accountId).toBe('second');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('persists appId changes and a transactional restore without touching credentials', async () => {
    const persistSetup = vi.fn(async () => {});
    const definition = createLarkDefinition({
      config: makeConfig({ upstream: { appId: 'cli_old' } }),
      credentials: {
        resolve: async () => undefined,
        describe: async () => ({ configured: false, writable: true }),
        set: async () => {},
      },
      persistSetup,
    });
    const before = definition.snapshotConfig!();

    await definition.saveConfig({ appId: 'cli_replacement' });
    await definition.restoreConfig!(before);

    expect(persistSetup).toHaveBeenNthCalledWith(1, { upstream: { appId: 'cli_replacement' } });
    expect(persistSetup).toHaveBeenNthCalledWith(2, { upstream: { appId: 'cli_old' } });
  });
});

describe('channel-lark apply() with channel-control present', () => {
  it('registers a definition into fake ctx.channelControl and does not mount directly', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    new FakeCredentials(ctx);
    stubStart();
    const registered: ChannelDefinition[] = [];
    ctx.provide('channelControl', {
      definitions: { register: (d: ChannelDefinition) => registered.push(d) },
    });

    try {
      apply(ctx, makeConfig({ upstream: { appId: 'cli_abc' } }));
      await new Promise((r) => setTimeout(r, 0));
      expect(registered).toHaveLength(1);
      expect(registered[0]?.id).toBe('lark');
      expect(ctx.channels.get('lark')).toBeUndefined();
      expect(vi.mocked(LarkAdapter.prototype.start)).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('channel-lark apply() without channel-control (standalone fallback)', () => {
  it('does not throw and does not mount when the adapter is unconfigured', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    new FakeCredentials(ctx); // empty — no appSecret
    stubStart();
    try {
      expect(() => apply(ctx, makeConfig({ upstream: { appId: 'cli_abc' } }))).not.toThrow();
      await new Promise((r) => setTimeout(r, 20));
      expect(ctx.channels.get('lark')).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('mounts directly in standalone mode when configured', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    new FakeCredentials(ctx, { DSH_CHANNEL_LARK_MAIN_APP_SECRET: 'cli_secret' });
    stubStart();
    try {
      apply(ctx, makeConfig({ upstream: { appId: 'cli_appid' } }));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(ctx.channels.get('lark')).toBeInstanceOf(LarkAdapter);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
