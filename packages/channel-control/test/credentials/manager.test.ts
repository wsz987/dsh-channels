/**
 * CredentialManager unit tests (doc §31 / §52). Proves the manager is a thin,
 * leak-safe wrapper: set() returns metadata, never the value.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CredentialManager,
  type CredentialSeam,
} from '../../src/credentials/manager.js';

/** In-memory fake of the structural credential seam. */
function makeSeam(initial: Record<string, string> = {}): {
  seam: CredentialSeam;
  store: Map<string, string>;
  calls: { op: string; ref: string; value?: string }[];
} {
  const store = new Map(Object.entries(initial));
  const calls: { op: string; ref: string; value?: string }[] = [];
  const seam: CredentialSeam = {
    async resolve(ref) {
      calls.push({ op: 'resolve', ref });
      const value = store.get(ref);
      return value !== undefined ? { value, source: 'test' } : undefined;
    },
    async describe(ref) {
      calls.push({ op: 'describe', ref });
      return { configured: store.has(ref), writable: true, source: store.has(ref) ? 'test' : undefined };
    },
    async set(ref, value) {
      calls.push({ op: 'set', ref, value });
      store.set(ref, value);
    },
    async unset(ref) {
      calls.push({ op: 'unset', ref });
      store.delete(ref);
    },
  };
  return { seam, store, calls };
}

describe('CredentialManager', () => {
  it('resolve delegates to the seam and returns the value + source', async () => {
    const { seam, store } = makeSeam({ APP_SECRET: 's3cret' });
    const manager = new CredentialManager(seam);
    const resolved = await manager.resolve('APP_SECRET');
    expect(resolved).toEqual({ value: 's3cret', source: 'test' });
    expect(store.get('APP_SECRET')).toBe('s3cret');
  });

  it('resolve returns undefined for an unknown ref', async () => {
    const manager = new CredentialManager(makeSeam().seam);
    expect(await manager.resolve('MISSING')).toBeUndefined();
  });

  it('describe reports configured state without the value', async () => {
    const { seam, store } = makeSeam({ APP_SECRET: 'x' });
    const manager = new CredentialManager(seam);
    expect(await manager.describe('APP_SECRET')).toEqual({
      configured: true,
      writable: true,
      source: 'test',
    });
    void store;
  });

  it('set persists the value but returns only {configured, writable}, never the value', async () => {
    const { seam, store, calls } = makeSeam();
    const manager = new CredentialManager(seam);
    const result = await manager.set('CLIENT_SECRET', 'abc123');

    expect(result).toEqual({ configured: true, writable: true, source: 'test' });
    expect(store.get('CLIENT_SECRET')).toBe('abc123');
    // Never serialized/returned: the value only went into the seam.
    expect(Object.values(result)).not.toContain('abc123');
    const setCall = calls.find((c) => c.op === 'set');
    expect(setCall?.ref).toBe('CLIENT_SECRET');
    expect(setCall?.value).toBe('abc123');
  });

  it('set reflection calls describe once after writing (no value echo)', async () => {
    const { seam, calls } = makeSeam();
    const manager = new CredentialManager(seam);
    const describeSpy = vi.fn(async (ref: string) => {
      return { configured: true, writable: true, source: 'test' };
    });
    const customManager = new CredentialManager({ ...seam, describe: describeSpy });
    await customManager.set('REF', 'v');
    expect(describeSpy).toHaveBeenCalledWith('REF');
    const ops = calls.filter((c) => c.op !== 'describe').map((c) => c.op);
    expect(ops).toContain('set');
  });

  it('unset removes the credential and reflects unconfigured state', async () => {
    const { seam } = makeSeam({ APP_SECRET: 'v' });
    const manager = new CredentialManager(seam);
    await manager.unset('APP_SECRET');
    expect(await manager.describe('APP_SECRET')).toEqual({
      configured: false,
      writable: true,
      source: undefined,
    });
  });
});
