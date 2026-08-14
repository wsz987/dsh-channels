/**
 * Harness Home and binding-store default path tests (plan Test 5).
 *
 * Verifies that resolveDshHome honors $DSH_HOME, that the default binding
 * store path lives under the Harness Home (not `process.cwd()`), that a
 * path-less file binding store writes there, and that the legacy bindings file
 * migrates to the new location (plan §5.2 / §19.1).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { ChannelLogger } from '@wsz987/channel-core';
import {
  resolveChannelDataDir,
  resolveDefaultBindingStorePath,
  resolveDshHome,
} from '../src/dsh-home.ts';
import {
  FileBindingStore,
  LEGACY_BINDING_STORE_PATH,
  migrateLegacyBindingStore,
  createBindingStore,
  type SessionBindingStore,
} from '../src/binding-store.ts';
import {
  SESSION_BINDING_SCHEMA_VERSION,
  bindingKey,
  sessionKey,
  type SessionBinding,
} from '../src/session-router.ts';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as ChannelLogger;

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    channelId: 'weixin',
    accountId: 'main',
    conversationId: 'user_123',
    sessionId: 's-1',
    route: { model: 'weixin-agent' },
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('dsh-home', () => {
  it('uses $DSH_HOME when set', () => {
    vi.stubEnv('DSH_HOME', '/custom/dsh');
    expect(resolveDshHome()).toBe('/custom/dsh');
  });

  it('expands a leading ~ in $DSH_HOME against homedir()', () => {
    vi.stubEnv('DSH_HOME', `~/proj${sep}data`);
    const expected = join(homedir(), 'proj', 'data');
    expect(resolveDshHome()).toBe(expected);
  });

  it('falls back to ~/.dsh when $DSH_HOME is unset', () => {
    vi.stubEnv('DSH_HOME', '');
    expect(resolveDshHome()).toBe(join(homedir(), '.dsh'));
  });

  it('resolveChannelDataDir is <dsh-home>/channels', () => {
    vi.stubEnv('DSH_HOME', '/x');
    expect(resolveChannelDataDir()).toBe(join('/x', 'channels'));
  });
});

describe('resolveDefaultBindingStorePath (plan Test 5)', () => {
  it('does not depend on process.cwd(); it targets the DSH_HOME channel dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-home-'));
    try {
      vi.stubEnv('DSH_HOME', dir);
      const resolved = resolveDefaultBindingStorePath();
      // Stubbed DSH_HOME is an absolute path — no ~ expansion involved.
      expect(resolved).toBe(join(resolveChannelDataDir(), 'bindings.json'));
      expect(resolved).toBe(join(dir, 'channels', 'bindings.json'));
      expect(resolved.startsWith(dir)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createBindingStore path-less file store (plan Test 5)', () => {
  it('writes bindings to the DSH_HOME-based default path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-home-'));
    try {
      vi.stubEnv('DSH_HOME', dir);
      const defaultPath = resolveDefaultBindingStorePath();

      const store: SessionBindingStore = createBindingStore({ type: 'file' });
      const binding = makeBinding();
      await store.put(binding);

      // The file exists at the default path derived from DSH_HOME.
      expect(existsSync(defaultPath)).toBe(true);

      // Re-open through a fresh FileBindingStore at the same path and read back.
      const reopened = new FileBindingStore(defaultPath);
      const read = await reopened.get(bindingKey(binding));
      expect(read).toEqual(binding);
      expect(sessionKey(read as SessionBinding)).toBe(bindingKey(binding));
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('migrateLegacyBindingStore (plan §19.1)', () => {
  it('copies the legacy file to the target when target is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-home-'));
    const targetPath = join(dir, 'channels', 'bindings.json');
    const legacyPath = join(process.cwd(), LEGACY_BINDING_STORE_PATH);
    try {
      mkdirSync(legacyPath.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
      const legacyContent = JSON.stringify({ k: 1 });
      writeFileSync(legacyPath, legacyContent, 'utf8');

      migrateLegacyBindingStore(targetPath, silentLogger);

      expect(existsSync(targetPath)).toBe(true);
      expect(readFileSync(targetPath, 'utf8')).toBe(legacyContent);
      // Legacy file is never deleted.
      expect(existsSync(legacyPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      if (existsSync(legacyPath)) {
        await rm(legacyPath.replace(/[\\/][^\\/]*$/, ''), { recursive: true, force: true });
      }
    }
  });

  it('is a no-op when the target already exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-home-'));
    const targetPath = join(dir, 'bindings.json');
    const legacyPath = join(process.cwd(), LEGACY_BINDING_STORE_PATH);
    try {
      writeFileSync(targetPath, '{"new":true}', 'utf8');
      mkdirSync(legacyPath.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
      writeFileSync(legacyPath, '{"legacy":true}', 'utf8');

      migrateLegacyBindingStore(targetPath, silentLogger);

      expect(readFileSync(targetPath, 'utf8')).toBe('{"new":true}');
    } finally {
      await rm(dir, { recursive: true, force: true });
      if (existsSync(legacyPath)) {
        await rm(legacyPath.replace(/[\\/][^\\/]*$/, ''), { recursive: true, force: true });
      }
    }
  });
});
