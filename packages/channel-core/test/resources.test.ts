/**
 * Runtime resource tests (R0): FileStorage, FileSecretStore and the
 * ChannelService resources/createAdapterContext wiring.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import {
  ChannelService,
  FileSecretStore,
  FileStorage,
  type ChannelRuntimeResources,
} from '../src/index.js';

const dirs: string[] = [];
function makeDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('FileStorage', () => {
  it('persists values across instances (restart)', async () => {
    const dir = makeDir('dsh-fs-');
    const a = new FileStorage({ directory: dir });
    await a.set('weixin:sync-cursor:main', 'buf-42');

    const b = new FileStorage({ directory: dir });
    expect(await b.get('weixin:sync-cursor:main')).toBe('buf-42');
  });

  it('get returns undefined for missing keys and delete removes', async () => {
    const dir = makeDir('dsh-fs-');
    const s = new FileStorage({ directory: dir });
    expect(await s.get('missing')).toBeUndefined();
    await s.set('weixin:context-token:main:u1', 'ctx-1');
    expect(await s.get('weixin:context-token:main:u1')).toBe('ctx-1');
    await s.delete('weixin:context-token:main:u1');
    expect(await s.get('weixin:context-token:main:u1')).toBeUndefined();
  });

  it('maps keys into a nested path tree', async () => {
    const dir = makeDir('dsh-fs-');
    const s = new FileStorage({ directory: dir });
    await s.set('weixin:sync-cursor:main', 'x');
    const file = join(dir, 'weixin', 'sync-cursor', 'main');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('x');
  });
});

describe('FileSecretStore', () => {
  it('persists secrets across instances and lower-cases names', async () => {
    const dir = makeDir('dsh-sec-');
    const a = new FileSecretStore({ directory: dir });
    await a.set('WeiXin:Token:MAIN', 'secret-token');

    const b = new FileSecretStore({ directory: dir });
    expect(await b.get('weixin:token:main')).toBe('secret-token');
  });

  it('delete removes a secret', async () => {
    const dir = makeDir('dsh-sec-');
    const s = new FileSecretStore({ directory: dir });
    await s.set('weixin:token:main', 't');
    await s.delete('weixin:token:main');
    expect(await s.get('weixin:token:main')).toBeUndefined();
  });
});

describe('ChannelService resources + createAdapterContext', () => {
  it('defaults to in-memory resources when no options are given', () => {
    const ctx = new Context();
    const service = new ChannelService(ctx);
    expect(service.resources.secrets).toBeDefined();
    expect(service.resources.storage).toBeDefined();
  });

  it('injects durable resources and shares them with adapter contexts', async () => {
    const dir = makeDir('dsh-res-');
    const resources: ChannelRuntimeResources = {
      secrets: new FileSecretStore({ directory: join(dir, 'secrets') }),
      storage: new FileStorage({ directory: join(dir, 'storage') }),
    };
    const ctx = new Context();
    const service = new ChannelService(ctx, { resources });
    const adapterCtx = service.createAdapterContext({
      channelId: 'weixin',
      signal: new AbortController().signal,
    });

    expect(adapterCtx.secrets).toBe(resources.secrets);
    expect(adapterCtx.storage).toBe(resources.storage);

    await adapterCtx.secrets.set('weixin:token:main', 'tok');
    await adapterCtx.storage.set('weixin:sync-cursor:main', 'buf');

    expect(await service.resources.secrets.get('weixin:token:main')).toBe('tok');
    expect(await service.resources.storage.get('weixin:sync-cursor:main')).toBe('buf');
  });

  it('createAdapterContext wires emit, logger and signal', () => {
    const ctx = new Context();
    const service = new ChannelService(ctx);
    const signal = new AbortController().signal;
    const adapterCtx = service.createAdapterContext({ channelId: 'weixin', signal });
    expect(adapterCtx.signal).toBe(signal);
    expect(typeof adapterCtx.emit).toBe('function');
    expect(typeof adapterCtx.logger.info).toBe('function');
  });
});
