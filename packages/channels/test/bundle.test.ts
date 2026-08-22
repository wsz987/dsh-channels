/**
 * Task 16.3 — DSH Bundle validation (offline, deterministic, fast).
 *
 * Parses `cordis.patch.yml` with a hand-rolled minimal parser (the file is a
 * fixed `- insert:` list of `- id:` / `name:` pairs — no YAML dependency),
 * asserts the plugin insertions, resolves every bundle-owned plugin specifier,
 * validates the Web client face, and checks that each channel adapter Config
 * exposes an `enabled` boolean so every channel can be disabled via config.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PatchItem {
  id: string;
  name: string;
  inject?: string[];
}

/** Strip a YAML single/double-quoted scalar (`'foo'` / `"foo"`). */
function unquote(value: string): string {
  const quoted = value.match(/^(['"])(.*)\1$/);
  return quoted ? quoted[2]! : value;
}

/** Minimal line-based parser for the fixed `cordis.patch.yml` shape. */
function parsePatch(source: string): PatchItem[] {
  const items: PatchItem[] = [];
  let current: PatchItem | null = null;

  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // A new `- id:` entry starts the next patch item.
    const idMatch = trimmed.match(/^- id:\s*(\S+)\s*$/);
    if (idMatch) {
      current = { id: unquote(idMatch[1]!), name: '' };
      items.push(current);
      continue;
    }

    if (!current) continue;

    const nameMatch = trimmed.match(/^name:\s*(\S+)\s*$/);
    if (nameMatch) {
      current.name = unquote(nameMatch[1]!);
      continue;
    }

    if (/^inject:\s*$/.test(trimmed)) {
      current.inject = [];
      continue;
    }

    // `inject:` list entries (`- channels`, ...). `- id:` lines are handled
    // above, so any remaining `- value` line inside an item belongs to inject.
    if (current.inject && trimmed.startsWith('- ')) {
      current.inject.push(trimmed.slice(2).trim());
    }
  }

  return items;
}

/** Split '@wsz987/pkg/sub' into the package name and the exports subpath. */
function splitSpecifier(specifier: string): { packageName: string; subpath: string } {
  const parts = specifier.split('/');
  const packageName = parts.slice(0, 2).join('/');
  const subpath = parts.length > 2 ? './' + parts.slice(2).join('/') : '.';
  return { packageName, subpath };
}

/** Test file -> root, then packages/<dir>. */
function packageJsonPath(dir: string): string {
  return fileURLToPath(
    new URL(`../../../packages/${dir}/package.json`, import.meta.url),
  );
}

// Test file: packages/channels/test/bundle.test.ts — the patch lives one
// directory up (packages/channels/cordis.patch.yml).
const PATCH_URL = new URL('../cordis.patch.yml', import.meta.url);
const DEV_INSTALLER_URL = new URL('../../../scripts/dev-channels.mjs', import.meta.url);
const BUNDLE_PACKAGE_URL = new URL('../package.json', import.meta.url);
const BUNDLE_CLIENT_URL = new URL('../lib/client.js', import.meta.url);

// Expected bundle result — the exact plugins cordis.patch.yml inserts.
const EXPECTED_ITEMS: PatchItem[] = [
  { id: 'channels-service', name: '@wsz987/dsh-channels/service' },
  { id: 'channels-files', name: '@wsz987/dsh-channels/files' },
  // channel-harness injects the command-plane capabilities plus `apiProxy`:
  // the loader-level service dependency orders this entry after the
  // api-gateway fiber, so the question-backend probe at apply time is
  // race-free (a missing inject lets the channel register the official
  // UserQuestionProvider first and the gateway's registration then fails the
  // boot with DUPLICATE_PROVIDER). Do not remove `apiProxy` without
  // replacing this ordering guarantee.
  { id: 'channels-harness', name: '@wsz987/dsh-channels/harness', inject: ['channels', 'agents', 'agentDefaultModel', 'agentPresets', 'llm', 'commands', 'apiProxy'] },
  // channel-control is the universal control plane: it must load before the
  // channel plugins so ctx.channelControl exists when they register definitions.
  { id: 'channels-control', name: '@wsz987/dsh-channels/control', inject: ['channels', 'credentials'] },
  { id: 'channels-weixin', name: '@wsz987/dsh-channels/weixin', inject: ['channels', 'channelControl'] },
  { id: 'channels-qq', name: '@wsz987/dsh-channels/qq', inject: ['channels', 'credentials', 'channelControl'] },
  { id: 'channels-dingtalk', name: '@wsz987/dsh-channels/dingtalk', inject: ['channels', 'credentials', 'channelControl'] },
  { id: 'channels-lark', name: '@wsz987/dsh-channels/lark', inject: ['channels', 'credentials', 'channelControl'] },
    { id: 'channels-telegram', name: '@wsz987/dsh-channels/telegram', inject: ['channels', 'credentials', 'channelControl'] },
  // The Web client plugin has no module-level `inject` export on its host
  // entry (only `name` + `apply`); the client half declares inject and the
  // settings.section slot, which is not part of the host patch shape.
  { id: 'channels-web', name: '@wsz987/dsh-channels' },
];

const EXPECTED_MODULE_NAMES = new Map([
  ['channels-service', 'channel-core'],
  ['channels-files', 'channel-files'],
  ['channels-harness', 'channel-harness'],
  ['channels-control', 'channel-control'],
  ['channels-weixin', 'channel-weixin'],
  ['channels-qq', 'channel-qq'],
  ['channels-dingtalk', 'channel-dingtalk'],
  ['channels-lark', 'channel-lark'],
  ['channels-telegram', 'channel-telegram'],
  ['channels-web', 'channel-web'],
]);

describe('DSH bundle patch (cordis.patch.yml)', () => {
  const patchSource = readFileSync(fileURLToPath(PATCH_URL), 'utf8');
  const items = parsePatch(patchSource);

  it('inserts exactly the expected plugins, in order, with the right names and inject lists', () => {
    expect(items.map((i) => i.id)).toEqual(EXPECTED_ITEMS.map((i) => i.id));
    expect(items.map((i) => i.name)).toEqual(EXPECTED_ITEMS.map((i) => i.name));
    expect(items.map((i) => i.inject)).toEqual(EXPECTED_ITEMS.map((i) => i.inject));
  });

  it.each(EXPECTED_ITEMS.map((item) => [item.id, item.name] as const))(
    'resolves plugin %s through the exports map and exports a Cordis plugin shape',
    async (id, specifier) => {
      // Dynamic import() enforces Node ESM exports resolution: a specifier not
      // covered by the package.json exports map (e.g. @wsz987/channel-core/plugin
      // before the subpath export was added) fails here.
      const mod: Record<string, unknown> = await import(specifier);

      // Cordis plugin shape: name (string), apply (function), inject (array of
      // strings) when present.
      expect(typeof mod.name).toBe('string');
      expect(typeof mod.apply).toBe('function');
      if (mod.inject !== undefined) {
        expect(Array.isArray(mod.inject)).toBe(true);
        for (const dep of mod.inject as unknown[]) {
          expect(typeof dep).toBe('string');
        }
      }

      expect(mod.name).toBe(EXPECTED_MODULE_NAMES.get(id));
    },
    15_000,
  );

  it('covers every referenced plugin subpath in the package exports map', () => {
    for (const item of EXPECTED_ITEMS) {
      const { packageName, subpath } = splitSpecifier(item.name);
      const pkgJson = JSON.parse(readFileSync(fileURLToPath(BUNDLE_PACKAGE_URL), 'utf8')) as {
        name?: string;
        exports?: Record<string, unknown>;
      };
      expect(packageName).toBe('@wsz987/dsh-channels');
      expect(pkgJson.name).toBe(packageName);
      expect(
        pkgJson.exports?.[subpath],
        `${packageName} exports map covers ${subpath}`,
      ).toBeTruthy();
    }
  });

  it('references no transitive implementation package from the profile patch', () => {
    expect(items.every((item) => item.name.startsWith('@wsz987/dsh-channels'))).toBe(true);
  });
});

describe('bundle-owned Web client face', () => {
  it('declares dsh.client and exports its built client bundle', () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(BUNDLE_PACKAGE_URL), 'utf8')) as {
      dsh?: { client?: { platform?: string; inject?: string[] } };
      exports?: Record<string, unknown>;
    };

    expect(manifest.dsh?.client).toMatchObject({
      platform: 'web',
      // rc.2 client module graph: `dsh.client.inject` lists only dynamic
      // client packages. react / cordis / ui-primitives / ui-slots are static
      // shell identities (PLATFORM_MODULES seeds) and must never appear here.
      inject: [
        '@deepseek-ai/dsh-client-locale',
      ],
    });
    expect(manifest.exports?.['./client']).toBeTruthy();
  });

  it('registers the client under the bundle package id', () => {
    const client = readFileSync(fileURLToPath(BUNDLE_CLIENT_URL), 'utf8');
    expect(client).toContain('id: "@wsz987/dsh-channels"');
    expect(client).not.toContain('id: "@wsz987/channel-web"');
  });
});

describe('every channel adapter can be disabled through its config', () => {
  it.each(['weixin', 'qq', 'dingtalk', 'lark', 'telegram'] as const)(
    '@wsz987/channel-%s Config exposes an `enabled` boolean',
    async (channel) => {
      const mod: Record<string, unknown> = await import(`@wsz987/channel-${channel}`);
      const config = mod.Config as {
        type?: string;
        dict?: Record<string, { type?: string } | undefined>;
      };

      // Schemastery introspection: 3.x object schemas are callable and store
      // their per-field schemas on `.dict` (the `object` constructor's
      // `dict` option) — the schema instance has no public `fields`
      // property, so `.dict` is the actual introspection surface. The
      // callable + type === 'object' assertions below also hold for any
      // future version that renames or drops `.dict`.
      expect(typeof config).toBe('function');
      expect(config.type).toBe('object');
      expect(config.dict).toBeTypeOf('object');
      expect(config.dict?.enabled, 'Config must contain an `enabled` key').toBeTruthy();
      expect(config.dict?.enabled?.type).toBe('boolean');
    },
  );
});

describe('optional generic-file package boundary', () => {
  it('uses the host Harness runtime for Agent scope and command registration', () => {
    const manifest = JSON.parse(readFileSync(packageJsonPath('channel-harness'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const runtimePeers = [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-scope',
      '@deepseek-ai/dsh-session',
    ];

    for (const dependency of runtimePeers) {
      expect(manifest.dependencies).not.toHaveProperty(dependency);
      expect(manifest.peerDependencies).toHaveProperty(dependency);
      expect(manifest.devDependencies).toHaveProperty(dependency);
    }
  });

  it('uses the Harness-owned tool runtime for every registered channel tool', () => {
    for (const dir of ['channel-files', 'channel-harness']) {
      const manifest = JSON.parse(readFileSync(packageJsonPath(dir), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      };
      // Tool definitions carry private runtime symbols. A bundled dsh-tools
      // copy cannot register with the host registry that executes the tool.
      expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-tools');
      // §16 tested compatibility band: exact pinned rc.2 (no wide prerelease ^).
      expect(manifest.peerDependencies?.['@deepseek-ai/dsh-tools']).toBe('0.1.1-rc.2');
      expect(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh-tools']?.optional).toBe(true);
      expect(manifest.devDependencies?.['@deepseek-ai/dsh-tools']).toBe('0.1.1-rc.2');
    }
  });

  it('links channel-files as shared infrastructure in source installs', () => {
    const installer = readFileSync(fileURLToPath(DEV_INSTALLER_URL), 'utf8');
    const infrastructure = installer.match(/const INFRASTRUCTURE_ROWS = new Set\(\[([\s\S]*?)\]\);/)?.[1];
    expect(infrastructure).toContain("'channels-files'");
  });

  it('keeps document parsers out of channel-harness', () => {
    const harness = JSON.parse(readFileSync(packageJsonPath('channel-harness'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(harness.dependencies).not.toHaveProperty('@wsz987/channel-files');
    expect(harness.dependencies).not.toHaveProperty('unpdf');
    expect(harness.dependencies).not.toHaveProperty('mammoth');
    expect(harness.dependencies).not.toHaveProperty('xlsx');
  });

  it('owns mature document parsers in channel-files', () => {
    const files = JSON.parse(readFileSync(packageJsonPath('channel-files'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(files.dependencies).toMatchObject({
      unpdf: '1.8.1',
      mammoth: '1.12.1',
      xlsx: '0.18.5',
    });
  });
});

describe('local development installer', () => {
  it('installs only the bundle as a direct profile dependency', () => {
    const installer = readFileSync(fileURLToPath(DEV_INSTALLER_URL), 'utf8');

    expect(installer).toContain("'plugin', '--profile', profile, 'add', '-w', BUNDLE_DIR");
    expect(installer).not.toContain("spawnSync('pnpm', ['add', '-w'");
    expect(installer).toContain('removeLegacyImplementationDependencies(profileDir)');
    expect(installer).toContain('owned.has(name)');
    expect(installer).not.toContain("name.startsWith('@wsz987/')");
    expect(installer).toContain("'plugin', '--profile', profile, 'remove', bundleName");
    expect(installer).toContain("spawnSync('pnpm', ['remove', '-w', ...implementations]");
  });
});
