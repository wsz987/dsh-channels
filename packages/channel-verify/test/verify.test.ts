import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyAdapter, type VerifyCheck, type VerifyReport } from '../src/verify.ts';
import { formatReport, main, parseArgs } from '../src/cli.ts';

/**
 * Unit tests for the Task 17.3 verify surface. All fixtures live in temp
 * directories; `pnpm test` is never spawned here (the `opts.test` path is
 * covered through the report shape with an injected `runTests` hook).
 */

const VALID_PACKAGE = JSON.stringify(
  {
    name: '@test/channel-example',
    version: '0.1.0',
    type: 'module',
    main: './lib/index.js',
    types: './lib/index.d.ts',
    exports: {
      '.': { types: './lib/index.d.ts', default: './lib/index.js' },
    },
    files: ['lib'],
  },
  null,
  2,
);

const VALID_CAPABILITIES = [
  '  text: true, image: true, file: true, audio: true, video: false,',
  '  markdown: false, cards: false, reactions: false, threads: false,',
  "  streaming: 'buffered',",
].join('\n');

/** A self-contained adapter entry (no external imports so it runs from temp). */
function adapterEntry(extra: string): string {
  return [
    'export const Config = () => ({',
    "  enabled: true, accountId: 'main', baseUrl: 'http://fake',",
    '  timeoutMs: 1000, longPollTimeoutMs: 1000,',
    '  reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },',
    '  dedup: { enabled: true, windowMs: 5000 },',
    '});',
    'export class ExampleAdapter {',
    "  id = 'example';",
    '  capabilities = {',
    VALID_CAPABILITIES,
    '  };',
    '  constructor(config) { this.config = config; }',
    '  async start() {}',
    '  async stop() {}',
    '  async send() { return { delivered: true }; }',
    extra,
    '}',
    '',
  ].join('\n');
}

async function makeDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-verify-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

async function withDir<T>(files: Record<string, string>, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeDir(files);
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function check(report: VerifyReport, id: string): VerifyCheck {
  const found = report.checks.find((c) => c.id === id);
  expect(found, "check '" + id + "' present").toBeDefined();
  return found!;
}

function codes(report: VerifyReport, id: string): string[] {
  return check(report, id).items.map((item) => item.code);
}

describe('parseArgs / formatReport', () => {
  it('parses dir, --test and --allow-unsupported in any order', () => {
    expect(parseArgs(['./packages/channel-x', '--test', '--allow-unsupported'])).toEqual({
      dir: './packages/channel-x',
      test: true,
      allowUnsupported: true,
    });
    expect(parseArgs(['--test', '.'])).toEqual({ dir: '.', test: true, allowUnsupported: false });
    expect(parseArgs([])).toEqual({ dir: '.', test: false, allowUnsupported: false });
    expect(parseArgs(['--unknown', 'dir-a'])).toEqual({ dir: 'dir-a', test: false, allowUnsupported: false });
  });

  it('formats a report with badges and PASS/FAIL result', () => {
    const report: VerifyReport = {
      dir: '/tmp/adapter',
      checks: [
        { id: 'package', items: [{ severity: 'ok', code: 'package-ok', message: 'valid' }] },
        { id: 'manifest', items: [{ severity: 'warning', code: 'manifest-untested', message: 'untested' }] },
        { id: 'fixtures', items: [{ severity: 'fail', code: 'fixtures-invalid', message: 'bad' }] },
      ],
      summary: { ok: 1, warning: 1, fail: 1 },
      passed: false,
    };
    const text = formatReport(report);
    expect(text).toContain('[ok]');
    expect(text).toContain('[warn]');
    expect(text).toContain('[FAIL]');
    expect(text).toContain('result: FAIL');
  });
});

describe('package check', () => {
  it('accepts a valid package.json', async () => {
    await withDir({ 'package.json': VALID_PACKAGE }, async (dir) => {
      const report = await verifyAdapter(dir);
      expect(codes(report, 'package')).toContain('package-ok');
    });
  });

  it('fails on an invalid package.json', async () => {
    await withDir({ 'package.json': '{ not json' }, async (dir) => {
      const report = await verifyAdapter(dir);
      expect(codes(report, 'package')).toContain('package.json-invalid');
    });
  });

  it('fails when dsh.bundle.patch references a missing file', async () => {
    const pkg = JSON.parse(VALID_PACKAGE) as Record<string, unknown>;
    pkg.dsh = { bundle: { patch: './cordis.patch.yml' } };
    await withDir({ 'package.json': JSON.stringify(pkg, null, 2) }, async (dir) => {
      const report = await verifyAdapter(dir);
      expect(codes(report, 'package')).toContain('package-patch-missing');
    });
  });
});

describe('adapter surface check', () => {
  it('finds a class adapter exported from lib/index.js', async () => {
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': adapterEntry(''),
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        expect(codes(report, 'adapter-surface')).toContain('adapter-found');
        expect(check(report, 'adapter-surface').items[0]?.message).toContain("'example'");
      },
    );
  });

  it('finds a defineChannelAdapter-style default export object', async () => {
    const entry = [
      'export default {',
      "  id: 'object-adapter',",
      '  capabilities: {',
      VALID_CAPABILITIES,
      '  },',
      '  async start() {},',
      '  async stop() {},',
      '  async send() { return { delivered: true }; },',
      '};',
    ].join('\n');
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': entry,
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        const surface = check(report, 'adapter-surface');
        expect(codes(report, 'adapter-surface')).toContain('adapter-found');
        expect(surface.items[0]?.message).toContain("'object-adapter'");
      },
    );
  });

  it('fails clearly when no adapter is exported', async () => {
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': 'export const notAnAdapter = 42;\n',
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        expect(codes(report, 'adapter-surface')).toContain('adapter-not-found');
      },
    );
  });
});

describe('manifest check', () => {
  const manifest = (status: string): string => [
    '  manifest = {',
    "    id: 'example',",
    "    adapterVersion: '0.1.0',",
    '    upstream: {',
    "      reference: 'example http gateway',",
    "      testedVersion: '1.0.0',",
    "      versionRange: '*',",
    "      strategy: 'source',",
    '    },',
    "    status: '" + status + "',",
    '  };',
  ].join('\n');

  it('reports tested as ok', async () => {
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': adapterEntry(manifest('tested')),
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        expect(codes(report, 'manifest')).toContain('manifest-tested');
        expect(check(report, 'manifest').items[0]?.severity).toBe('ok');
      },
    );
  });

  it('reports untested as a warning', async () => {
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': adapterEntry(manifest('untested')),
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        expect(codes(report, 'manifest')).toContain('manifest-untested');
        expect(check(report, 'manifest').items[0]?.severity).toBe('warning');
      },
    );
  });

  it('fails on unsupported unless allowUnsupported', async () => {
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': adapterEntry(manifest('unsupported')),
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        expect(codes(report, 'manifest')).toContain('manifest-unsupported');
        expect(check(report, 'manifest').items[0]?.severity).toBe('fail');

        const allowed = await verifyAdapter(dir, { allowUnsupported: true });
        expect(check(allowed, 'manifest').items[0]?.severity).toBe('warning');
      },
    );
  });

  it('warns when the adapter exposes no manifest', async () => {
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': adapterEntry(''),
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        expect(codes(report, 'manifest')).toContain('manifest-missing');
      },
    );
  });
});

describe('capabilities check', () => {
  it('fails on an invalid streaming mode', async () => {
    const entry = adapterEntry('').replace("streaming: 'buffered'", "streaming: 'instant'");
    await withDir({ 'package.json': VALID_PACKAGE, 'lib/index.js': entry }, async (dir) => {
      const report = await verifyAdapter(dir);
      expect(codes(report, 'capabilities')).toContain('capabilities-streaming-invalid');
      expect(check(report, 'capabilities').items[0]?.severity).toBe('fail');
    });
  });

  it('accepts a valid capability surface', async () => {
    await withDir({ 'package.json': VALID_PACKAGE, 'lib/index.js': adapterEntry('') }, async (dir) => {
      const report = await verifyAdapter(dir);
      expect(codes(report, 'capabilities')).toContain('capabilities-ok');
    });
  });
});

describe('fixtures check', () => {
  const VALID_FIXTURE = JSON.stringify(
    {
      name: 'inbound text',
      channel: 'example',
      upstreamVersion: '1.0.0',
      payload: { type: 'text', msgId: 'm1', senderId: 'u1', conversationId: 'c1', content: 'hi' },
      expected: { type: 'message.received' },
    },
    null,
    2,
  );

  it('accepts a valid fixture directory', async () => {
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': adapterEntry(''),
        'fixtures/example/inbound-text.json': VALID_FIXTURE,
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        expect(codes(report, 'fixtures')).toContain('fixtures-ok');
      },
    );
  });

  it('fails on a fixture missing upstreamVersion', async () => {
    const broken = JSON.stringify(
      { name: 'inbound text', channel: 'example', payload: { type: 'text' }, expected: {} },
      null,
      2,
    );
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': adapterEntry(''),
        'fixtures/example/inbound-text.json': broken,
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        expect(codes(report, 'fixtures')).toContain('fixtures-invalid');
      },
    );
  });

  it('fails when the fixture channel does not match its directory', async () => {
    const mismatched = JSON.stringify(
      {
        name: 'inbound text',
        channel: 'other',
        upstreamVersion: '1.0.0',
        payload: { type: 'text' },
        expected: {},
      },
      null,
      2,
    );
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': adapterEntry(''),
        'fixtures/example/inbound-text.json': mismatched,
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        expect(codes(report, 'fixtures')).toContain('fixtures-channel-mismatch');
      },
    );
  });
});

describe('credentials check', () => {
  it('reports no hits for a clean src tree', async () => {
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': adapterEntry(''),
        'src/config.ts': 'export const baseUrl = \'http://fake\';\n',
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        expect(codes(report, 'credentials')).toContain('credentials-ok');
      },
    );
  });

  it('ignores known placeholder values', async () => {
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': adapterEntry(''),
        'src/config.ts': [
          'export const token = \'TEST_TOKEN_PLACEHOLDER\';',
          'export const password = \'xxx\';',
          'export const apiKey = \'<your-api-key>\';',
          'export const secret = \'your_secret_here\';',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        expect(codes(report, 'credentials')).toContain('credentials-ok');
      },
    );
  });

  it('warns on a real-looking secret without printing its value', async () => {
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': adapterEntry(''),
        'src/config.ts': 'export const token = \'sk-live-7f3a9c21e8b04d5f\';\n',
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        const credentials = check(report, 'credentials');
        expect(credentials.items.some((item) => item.code === 'credentials-suspect')).toBe(true);
        for (const item of credentials.items) {
          expect(item.message).not.toContain('sk-live-7f3a9c21e8b04d5f');
        }
      },
    );
  });
});

describe('contract check (report shape only — no real spawn)', () => {
  it('notes the package test script when opts.test is false', async () => {
    await withDir({ 'package.json': VALID_PACKAGE, 'lib/index.js': adapterEntry('') }, async (dir) => {
      const report = await verifyAdapter(dir, { test: false });
      const contract = check(report, 'contract');
      expect(contract.items[0]?.code).toBe('contract-skipped');
      expect(contract.items[0]?.severity).toBe('ok');
    });
  });

  it('reports ok when the injected test runner exits 0', async () => {
    await withDir({ 'package.json': VALID_PACKAGE, 'lib/index.js': adapterEntry('') }, async (dir) => {
      const report = await verifyAdapter(dir, { test: true, runTests: async () => 0 });
      const contract = check(report, 'contract');
      expect(contract.items[0]?.code).toBe('contract-passed');
      expect(contract.items[0]?.severity).toBe('ok');
    });
  });

  it('reports fail when the injected test runner exits non-zero', async () => {
    await withDir({ 'package.json': VALID_PACKAGE, 'lib/index.js': adapterEntry('') }, async (dir) => {
      const report = await verifyAdapter(dir, { test: true, runTests: async () => 3 });
      const contract = check(report, 'contract');
      expect(contract.items[0]?.code).toBe('contract-failed');
      expect(contract.items[0]?.severity).toBe('fail');
    });
  });
});

describe('end-to-end verifyAdapter over a broken adapter', () => {
  it('produces fail items for package/manifest/capabilities/fixtures', async () => {
    const brokenPackage = JSON.parse(VALID_PACKAGE) as Record<string, unknown>;
    brokenPackage.dsh = { bundle: { patch: './cordis.patch.yml' } }; // file missing
    const brokenAdapter = adapterEntry(
      [
        '  manifest = {',
        "    id: 'example',",
        "    adapterVersion: '0.1.0',",
        '    upstream: {',
        "      reference: 'example http gateway',",
        "      testedVersion: '1.0.0',",
        "      versionRange: '*',",
        "      strategy: 'source',",
        '    },',
        "    status: 'unsupported',",
        '  };',
      ].join('\n'),
    ).replace("streaming: 'buffered'", "streaming: 'instant'");

    await withDir(
      {
        'package.json': JSON.stringify(brokenPackage, null, 2),
        'lib/index.js': brokenAdapter,
        'src/config.ts': 'export const token = \'sk-live-7f3a9c21e8b04d5f\';\n',
        'fixtures/example/inbound-text.json': JSON.stringify(
          { name: 'inbound text', channel: 'example', payload: { type: 'text' }, expected: {} },
          null,
          2,
        ),
      },
      async (dir) => {
        const report = await verifyAdapter(dir);
        expect(report.passed).toBe(false);
        expect(report.summary.fail).toBeGreaterThanOrEqual(4);
        expect(codes(report, 'package')).toContain('package-patch-missing');
        expect(codes(report, 'manifest')).toContain('manifest-unsupported');
        expect(codes(report, 'capabilities')).toContain('capabilities-streaming-invalid');
        expect(codes(report, 'fixtures')).toContain('fixtures-invalid');
        expect(codes(report, 'credentials')).toContain('credentials-suspect');
      },
    );
  });

  it('passes for a healthy adapter (test runner not executed)', async () => {
    const healthyAdapter = adapterEntry(
      [
        '  manifest = {',
        "    id: 'example',",
        "    adapterVersion: '0.1.0',",
        '    upstream: {',
        "      reference: 'example http gateway',",
        "      testedVersion: '1.0.0',",
        "      versionRange: '*',",
        "      strategy: 'source',",
        '    },',
        "    status: 'tested',",
        '  };',
      ].join('\n'),
    );

    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': healthyAdapter,
        'fixtures/example/inbound-text.json': JSON.stringify(
          {
            name: 'inbound text',
            channel: 'example',
            upstreamVersion: '1.0.0',
            payload: { type: 'text', msgId: 'm1', senderId: 'u1', conversationId: 'c1', content: 'hi' },
            expected: { type: 'message.received' },
          },
          null,
          2,
        ),
      },
      async (dir) => {
        const report = await verifyAdapter(dir, { test: false });
        expect(report.passed).toBe(true);
        expect(report.summary.fail).toBe(0);
        expect(codes(report, 'manifest')).toContain('manifest-tested');
        expect(codes(report, 'fixtures')).toContain('fixtures-ok');
        expect(codes(report, 'contract')).toContain('contract-skipped');
      },
    );
  });
});

describe('cli main (no test spawn)', () => {
  it('returns 0 for a healthy adapter directory', async () => {
    await withDir(
      {
        'package.json': VALID_PACKAGE,
        'lib/index.js': adapterEntry(''),
      },
      async (dir) => {
        const code = await main([dir]);
        expect(code).toBe(0);
      },
    );
  });

  it('returns 1 for a broken adapter directory', async () => {
    await withDir(
      {
        'package.json': '{ broken',
      },
      async (dir) => {
        const code = await main([dir]);
        expect(code).toBe(1);
      },
    );
  });
});

