/**
 * Bundle update-check tests (prompt-only npm dist-tag check).
 *
 * Every case is offline: `fetch` is stubbed with vi.stubGlobal, the clock is
 * injectable, and storage is the in-memory ChannelStorage. No test ever
 * contacts the real npm registry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { MemoryStorage, type ChannelStorage } from '@wsz987/channel-core';
import {
  BUNDLE_PACKAGE,
  BUNDLE_VERSION,
  BundleUpdateChecker,
  UPDATE_CHECK_STORAGE_KEY,
  compareSemver,
  evaluateBundleUpdate,
  isSemverString,
  type UpdateCheckLogger,
} from '../src/update-check.js';
import { ChannelControlService } from '../src/service.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** A captured log line (level, message). */
type LogLine = [level: 'debug' | 'info', message: string];

function captureLogger(): { logger: UpdateCheckLogger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    logger: {
      debug: (message: string) => lines.push(['debug', message]),
      info: (message: string) => lines.push(['info', message]),
    },
  };
}

/** Fake single-tag registry manifest response. */
function manifestResponse(version: string): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({ name: BUNDLE_PACKAGE, version }),
  } as unknown as Response;
}

/** Fake 404 (dist-tag not published). */
const NOT_FOUND = { status: 404, ok: false } as unknown as Response;

interface TagPlan {
  latest?: Response | Error;
  next?: Response | Error;
}

/**
 * Stub global fetch with per-tag outcomes. Any unexpected URL rejects (and
 * fails the test through the checker's offline tolerance + call assertions).
 */
function stubRegistry(plan: TagPlan): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(`https://registry.npmjs.org/${BUNDLE_PACKAGE}/`)) {
      throw new Error('unexpected fetch url: ' + url);
    }
    const tag = url.endsWith('/latest') ? 'latest' : url.endsWith('/next') ? 'next' : undefined;
    if (!tag) throw new Error('unexpected fetch url: ' + url);
    const outcome = plan[tag];
    if (outcome instanceof Error) throw outcome;
    if (outcome) return outcome;
    return NOT_FOUND;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function offlineStub(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => {
    throw new Error('network unreachable');
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

interface CheckerHarness {
  checker: BundleUpdateChecker;
  lines: LogLine[];
  storage: ChannelStorage;
  fetchMock: ReturnType<typeof vi.fn>;
  now: { value: number };
}

function makeChecker(options: {
  currentVersion?: string;
  enabled?: boolean;
  intervalHours?: number;
  plan?: TagPlan;
  storage?: ChannelStorage;
  offline?: boolean;
}): CheckerHarness {
  const { logger, lines } = captureLogger();
  const storage = options.storage ?? new MemoryStorage();
  const now = { value: 1_700_000_000_000 };
  const fetchMock = options.offline ? offlineStub() : stubRegistry(options.plan ?? {});
  const checker = new BundleUpdateChecker({
    currentVersion: options.currentVersion ?? '0.4.2',
    enabled: options.enabled ?? true,
    intervalHours: options.intervalHours ?? 24,
    getStorage: () => storage,
    logger,
    now: () => now.value,
  });
  return { checker, lines, storage, fetchMock, now };
}

afterEach(() => {
  vi.unstubAllGlobals();
  // No fake timers anywhere: the checker owns no timers (the fetch timeout
  // AbortSignal never fires against stubs) and vi.waitFor polls real timers.
});

/* ------------------------------------------------------------------ */
/* semver primitives                                                   */
/* ------------------------------------------------------------------ */

describe('semver primitives', () => {
  it('validate strict semver strings', () => {
    expect(isSemverString('0.4.2')).toBe(true);
    expect(isSemverString('0.5.0-rc.1')).toBe(true);
    expect(isSemverString('1.2.3-alpha.1+build.5')).toBe(true);
    expect(isSemverString('not.a.version')).toBe(false);
    expect(isSemverString('')).toBe(false);
    expect(isSemverString('1.2')).toBe(false);
    expect(isSemverString('01.2.3')).toBe(false);
  });

  it('orders the semver.org precedence chain (build metadata ignored)', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 1; i < chain.length; i++) {
      expect(compareSemver(chain[i - 1]!, chain[i]!)).toBe(-1);
      expect(compareSemver(chain[i]!, chain[i - 1]!)).toBe(1);
    }
    expect(compareSemver('1.0.0+build', '1.0.0')).toBe(0);
  });

  it('compares numeric prerelease identifiers numerically (rc.10 > rc.9)', () => {
    expect(compareSemver('0.5.0-rc.10', '0.5.0-rc.9')).toBe(1);
    expect(compareSemver('0.5.0-rc.2', '0.5.0-rc.10')).toBe(-1);
    expect(compareSemver('0.5.0', '0.5.0-rc.1')).toBe(1);
    expect(compareSemver('0.5.1', '0.5.0')).toBe(1);
    expect(compareSemver('0.6.0', '0.5.99')).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* evaluateBundleUpdate (pure rules)                                   */
/* ------------------------------------------------------------------ */

describe('evaluateBundleUpdate', () => {
  it('prompts on a newer same-line version with a single update command', () => {
    const info = evaluateBundleUpdate('0.4.2', { latest: '0.4.3' });
    expect(info).toMatchObject({ version: '0.4.3', tag: 'latest', crossLine: false });
    expect(info!.commands).toEqual([
      'npx @deepseek-ai/dsh plugin --profile web update -w @wsz987/dsh-channels',
    ]);
  });

  it('prompts with the two-step commands when crossing a version line', () => {
    const info = evaluateBundleUpdate('0.4.2', { latest: '0.5.0' });
    expect(info).toMatchObject({ version: '0.5.0', tag: 'latest', crossLine: true });
    expect(info!.commands).toEqual([
      'npm i -g @deepseek-ai/dsh@latest',
      'npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest',
    ]);
  });

  it('does not prompt when the target is not strictly greater', () => {
    expect(evaluateBundleUpdate('0.4.2', { latest: '0.4.2' })).toBeUndefined();
    expect(evaluateBundleUpdate('0.4.2', { latest: '0.4.1' })).toBeUndefined();
    expect(evaluateBundleUpdate('0.5.0-rc.2', { latest: '0.5.0-rc.2', next: '0.5.0-rc.1' })).toBeUndefined();
  });

  it('a prerelease install compares against max(latest, next)', () => {
    // next is higher than latest → target comes from next.
    expect(evaluateBundleUpdate('0.5.0-rc.0', { latest: '0.4.9', next: '0.5.0-rc.1' })).toMatchObject({
      version: '0.5.0-rc.1',
      tag: 'next',
    });
    // latest is higher than next → target comes from latest.
    expect(evaluateBundleUpdate('0.4.9-rc.3', { latest: '0.5.0', next: '0.5.0-rc.1' })).toMatchObject({
      version: '0.5.0',
      tag: 'latest',
      crossLine: true,
    });
  });

  it('a stable install never prompts onto a next prerelease', () => {
    expect(evaluateBundleUpdate('0.5.0', { latest: '0.5.0', next: '0.6.0-rc.1' })).toBeUndefined();
  });

  it('ignores malformed dist-tag versions (no fabricated hints)', () => {
    expect(evaluateBundleUpdate('0.4.2', { latest: 'banana' })).toBeUndefined();
    expect(evaluateBundleUpdate('0.4.2', {})).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* checker: fetch + comparison integration                             */
/* ------------------------------------------------------------------ */

describe('BundleUpdateChecker', () => {
  it('reports a same-line update and logs exactly one info line', async () => {
    const h = makeChecker({ plan: { latest: manifestResponse('0.4.3'), next: manifestResponse('0.4.4-rc.1') } });
    await h.checker.trigger();

    const status = await h.checker.getStatus();
    expect(status.currentVersion).toBe('0.4.2');
    expect(status.update).toMatchObject({ version: '0.4.3', tag: 'latest', crossLine: false });
    expect(status.checkedAt).toBe(h.now.value);
    // One info line with current + target + tag; no registry raw payload.
    const infos = h.lines.filter(([level]) => level === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0]![1]).toContain('0.4.2');
    expect(infos[0]![1]).toContain('0.4.3');
    expect(infos[0]![1]).toContain('latest');
  });

  it('reports a cross-line update with the two-step commands', async () => {
    const h = makeChecker({ plan: { latest: manifestResponse('0.5.0') } });
    await h.checker.trigger();
    const status = await h.checker.getStatus();
    expect(status.update).toMatchObject({ version: '0.5.0', crossLine: true });
    expect(status.update!.commands).toHaveLength(2);
    expect(status.update!.commands[0]).toContain('npm i -g @deepseek-ai/dsh@latest');
  });

  it('a prerelease install adopts the higher next tag', async () => {
    const h = makeChecker({
      currentVersion: '0.5.0-rc.0',
      plan: { latest: manifestResponse('0.4.9'), next: manifestResponse('0.5.0-rc.1') },
    });
    await h.checker.trigger();
    const status = await h.checker.getStatus();
    expect(status.update).toMatchObject({ version: '0.5.0-rc.1', tag: 'next' });
  });

  it('a stable install ignores a newer next prerelease', async () => {
    const h = makeChecker({
      currentVersion: '0.5.0',
      plan: { latest: manifestResponse('0.5.0'), next: manifestResponse('0.6.0-rc.1') },
    });
    await h.checker.trigger();
    expect((await h.checker.getStatus()).update).toBeUndefined();
  });

  it('no update → status only, no info log', async () => {
    const h = makeChecker({ plan: { latest: manifestResponse('0.4.2') } });
    await h.checker.trigger();
    const status = await h.checker.getStatus();
    expect(status.update).toBeUndefined();
    expect(status.checkedAt).toBe(h.now.value);
    expect(h.lines.filter(([level]) => level === 'info')).toHaveLength(0);
  });

  it('a missing next dist-tag (404) is tolerated', async () => {
    const h = makeChecker({ currentVersion: '0.5.0-rc.0', plan: { latest: manifestResponse('0.5.0') } });
    await h.checker.trigger();
    expect((await h.checker.getStatus()).update).toMatchObject({ version: '0.5.0', tag: 'latest' });
  });

  it('offline / timeout failures are silent: no update, no user-facing error', async () => {
    const h = makeChecker({ offline: true });
    await expect(h.checker.trigger()).resolves.toBeUndefined();
    const status = await h.checker.getStatus();
    expect(status.currentVersion).toBe('0.4.2');
    expect(status.update).toBeUndefined();
    expect(status.checkedAt).toBeUndefined();
    // Silent for the user: debug only, no warn/error/info.
    expect(h.lines.filter(([level]) => level !== 'debug')).toHaveLength(0);
    expect(h.lines[0]![1]).toContain('skipped');
  });

  it('a corrupted registry response (zod rejection) is treated as offline', async () => {
    const h = makeChecker({
      plan: { latest: manifestResponse('zero.five.ZERO'), next: manifestResponse('0.5.0') },
    });
    await expect(h.checker.trigger()).resolves.toBeUndefined();
    const status = await h.checker.getStatus();
    expect(status.update).toBeUndefined();
    expect(status.checkedAt).toBeUndefined(); // no partially-trusted snapshot kept
  });

  it('fetches latest and next from the npm registry endpoints', async () => {
    const h = makeChecker({ plan: { latest: manifestResponse('0.4.3') } });
    await h.checker.trigger();
    const urls = h.fetchMock.mock.calls.map(([input]) => String(input)).sort();
    expect(urls).toEqual([
      'https://registry.npmjs.org/@wsz987/dsh-channels/latest',
      'https://registry.npmjs.org/@wsz987/dsh-channels/next',
    ]);
  });

  /* ---------------- TTL cache -------------------------------------- */

  it('a fresh cache is not re-fetched within the TTL', async () => {
    const h = makeChecker({ plan: { latest: manifestResponse('0.4.3') } });
    await h.checker.trigger();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    h.now.value += 23 * 3_600_000; // still inside 24h
    await h.checker.trigger();
    await h.checker.trigger();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('an expired TTL triggers a re-check', async () => {
    const h = makeChecker({ plan: { latest: manifestResponse('0.4.3') } });
    await h.checker.trigger();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    h.now.value += 25 * 3_600_000; // beyond 24h
    await h.checker.trigger();
    expect(h.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('the durable cache is reused by a new process without fetching', async () => {
    const plan = { latest: manifestResponse('0.4.3') };
    const storage = new MemoryStorage();
    const first = makeChecker({ plan, storage });
    await first.checker.trigger();
    expect(first.fetchMock).toHaveBeenCalledTimes(2);

    // "Second process": same storage, a fresh checker, fetch now throws.
    const second = makeChecker({ plan: {}, storage });
    second.fetchMock.mockImplementation(async () => {
      throw new Error('must not fetch: cache is fresh');
    });
    const status = await second.checker.getStatus();
    expect(status.update).toMatchObject({ version: '0.4.3' });
    expect(status.checkedAt).toBe(first.now.value);
    expect(second.fetchMock).not.toHaveBeenCalled();
  });

  it('a cache recorded for a different installed version is discarded', async () => {
    const storage = new MemoryStorage();
    const old = makeChecker({ currentVersion: '0.4.2', plan: { latest: manifestResponse('0.4.3') }, storage });
    await old.checker.trigger();

    const upgraded = makeChecker({ currentVersion: '0.5.0', plan: { latest: manifestResponse('0.5.1') }, storage });
    const status = await upgraded.checker.getStatus();
    // The stale snapshot is discarded, so the immediate answer carries no
    // hint computed against the OLD installed version.
    expect(status.currentVersion).toBe('0.5.0');
    expect(status.update).toBeUndefined();
    // The next check (background or explicit) re-runs immediately.
    await upgraded.checker.trigger();
    expect(upgraded.fetchMock).toHaveBeenCalledTimes(2);
    expect((await upgraded.checker.getStatus()).update).toMatchObject({ version: '0.5.1' });
  });

  it('a stale cache makes getStatus() kick a background refresh', async () => {
    const storage = new MemoryStorage();
    // Seed a stale snapshot written for the current version.
    await storage.set(
      UPDATE_CHECK_STORAGE_KEY,
      JSON.stringify({ v: 1, checkedAt: 1_699_000_000_000, currentVersion: '0.4.2', latest: '0.4.3' }),
    );
    const h = makeChecker({ plan: { latest: manifestResponse('0.4.4') }, storage });
    const status = await h.checker.getStatus();
    // Immediate answer is the stale snapshot's evaluation…
    expect(status.update).toMatchObject({ version: '0.4.3' });
    // …while the refresh runs in the background and rewrites the cache.
    await vi.waitFor(async () => {
      const raw = await storage.get(UPDATE_CHECK_STORAGE_KEY);
      expect(raw).toContain('0.4.4');
    });
    expect((await h.checker.getStatus()).update).toMatchObject({ version: '0.4.4' });
  });

  it('a corrupt cache row is ignored (re-check on next trigger)', async () => {
    const storage = new MemoryStorage();
    await storage.set(UPDATE_CHECK_STORAGE_KEY, '{not json');
    const h = makeChecker({ plan: { latest: manifestResponse('0.4.3') }, storage });
    const status = await h.checker.getStatus();
    expect(status.update).toBeUndefined();
    expect(status.checkedAt).toBeUndefined();
    await h.checker.trigger();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect((await h.checker.getStatus()).update).toMatchObject({ version: '0.4.3' });
  });

  /* ---------------- configuration ---------------------------------- */

  it('disabled configuration never fetches', async () => {
    const h = makeChecker({ enabled: false, plan: { latest: manifestResponse('0.4.3') } });
    await expect(h.checker.trigger()).resolves.toBeUndefined();
    const status = await h.checker.getStatus();
    expect(status.update).toBeUndefined();
    expect(status.checkedAt).toBeUndefined();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('disabled configuration surfaces no hint even from a fresh stored snapshot', async () => {
    const storage = new MemoryStorage();
    await storage.set(
      UPDATE_CHECK_STORAGE_KEY,
      JSON.stringify({ v: 1, checkedAt: 1_700_000_000_000, currentVersion: '0.4.2', latest: '0.5.0' }),
    );
    const h = makeChecker({ enabled: false, storage });
    const status = await h.checker.getStatus();
    expect(status).toEqual({ currentVersion: '0.4.2' });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('memory-only caching when no storage seam is provided', async () => {
    const { logger } = captureLogger();
    const fetchMock = stubRegistry({ latest: manifestResponse('0.4.3') });
    const checker = new BundleUpdateChecker({
      currentVersion: '0.4.2',
      enabled: true,
      intervalHours: 24,
      logger,
      now: () => 1_700_000_000_000,
    });
    await checker.trigger();
    expect((await checker.getStatus()).update).toMatchObject({ version: '0.4.3' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ */
/* service wiring                                                      */
/* ------------------------------------------------------------------ */

describe('ChannelControlService update-check surface', () => {
  const seam = {
    async resolve() {
      return undefined;
    },
    async describe() {
      return { configured: false, writable: true };
    },
    async set() {},
    async unset() {},
  };

  it('BUNDLE_VERSION tracks the bundle package version (release-family lockstep)', () => {
    // The runtime family moves in lockstep (docs/release.md); the update check
    // reports this package's version as the installed bundle version, so a
    // drifted package.json would fabricate wrong hints. Guard the invariant.
    const bundlePkg = JSON.parse(
      readFileSync(join(rootDir, '..', 'channels', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(BUNDLE_VERSION).toBe(bundlePkg.version);
  });

  it('exposes updates and a getUpdateStatus() that never throws offline', async () => {
    offlineStub();
    const ctx = new Context();
    const service = new ChannelControlService(ctx, {
      credentials: seam,
      updateCheck: { enabled: true, intervalHours: 24 },
    });
    expect(service.updates).toBeDefined();
    // Serving the status must resolve (offline-tolerant) with the lockstep
    // bundle version and no fabricated hint.
    const status = await service.getUpdateStatus();
    expect(status.currentVersion).toBe(BUNDLE_VERSION);
    expect(status.update).toBeUndefined();
  });
});
