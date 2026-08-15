/**
 * Harness Home and binding-store default path tests (plan Test 5).
 *
 * Verifies that resolveDshHome honors $DSH_HOME, that the default binding
 * store path lives under the Harness Home (not `process.cwd()`), that a
 * path-less file binding store writes there.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  CHANNELS_DATA_DIR_NAME,
  resolveChannelDataDir,
  resolveDefaultBindingStorePath,
  resolveDshHome,
} from '../src/dsh-home.ts';
import {
  FileBindingStore,
  createBindingStore,
  type SessionBindingStore,
} from '../src/binding-store.ts';
import {
  SESSION_BINDING_SCHEMA_VERSION,
  bindingKey,
  sessionKey,
  type SessionBinding,
} from '../src/session-router.ts';

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
    const customHome = resolve('custom-dsh-home');
    vi.stubEnv('DSH_HOME', customHome);
    expect(resolveDshHome()).toBe(customHome);
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

  it('resolveChannelDataDir uses the plugin namespace under DSH_HOME', () => {
    const customHome = resolve('custom-dsh-home');
    vi.stubEnv('DSH_HOME', customHome);
    expect(resolveChannelDataDir()).toBe(join(customHome, CHANNELS_DATA_DIR_NAME));
  });

  it('resolveChannelDataDir honors DSH_CHANNELS_DATA_DIR', () => {
    const customDir = resolve('custom-channel-data');
    vi.stubEnv('DSH_CHANNELS_DATA_DIR', customDir);
    vi.stubEnv('DSH_HOME', resolve('ignored-dsh-home'));
    expect(resolveChannelDataDir()).toBe(customDir);
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
      expect(resolved).toBe(join(dir, CHANNELS_DATA_DIR_NAME, 'bindings.json'));
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
