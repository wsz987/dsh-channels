/**
 * Task 16.3 — DSH Bundle validation (offline, deterministic, fast).
 *
 * Parses `cordis.patch.yml` with a hand-rolled minimal parser (the file is a
 * fixed `- insert:` list of `- id:` / `name:` pairs — no YAML dependency),
 * asserts the seven plugin insertions, resolves every plugin specifier through
 * the package `exports` maps (dynamic import enforces Node ESM exports
 * resolution), and checks that each channel adapter Config exposes an
 * `enabled` boolean so every channel can be disabled via config.
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

// Expected bundle result — the exact plugins cordis.patch.yml inserts.
const EXPECTED_ITEMS: PatchItem[] = [
  { id: 'channels-service', name: '@wsz987/channel-core/plugin' },
  { id: 'channels-files', name: '@wsz987/channel-files' },
  // channel-harness injects the command-plane capabilities: the Harness
  // `commands` registry plus the default-model selection it resolves routes against.
  { id: 'channels-harness', name: '@wsz987/channel-harness', inject: ['channels', 'agents', 'agentDefaultModel', 'commands'] },
  // channel-control is the universal control plane: it must load before the
  // channel plugins so ctx.channelControl exists when they register definitions.
  { id: 'channels-control', name: '@wsz987/channel-control/plugin', inject: ['channels', 'credentials'] },
  { id: 'channels-weixin', name: '@wsz987/channel-weixin', inject: ['channels', 'channelControl'] },
  { id: 'channels-qq', name: '@wsz987/channel-qq', inject: ['channels', 'credentials', 'channelControl'] },
  { id: 'channels-dingtalk', name: '@wsz987/channel-dingtalk', inject: ['channels', 'credentials', 'channelControl'] },
  { id: 'channels-lark', name: '@wsz987/channel-lark', inject: ['channels', 'credentials', 'channelControl'] },
  // The Web client plugin has no module-level `inject` export on its host
  // entry (only `name` + `apply`); the client half declares inject and the
  // settings.section slot, which is not part of the host patch shape.
  { id: 'channels-web', name: '@wsz987/channel-web' },
];

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
    async (_id, specifier) => {
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

      // The module name matches the package short name (@wsz987/channel-core ->
      // channel-core; @wsz987/channel-core/plugin -> channel-core).
      const shortName = splitSpecifier(specifier).packageName.replace('@wsz987/', '');
      expect(mod.name).toBe(shortName);
    },
  );

  it('covers every referenced plugin subpath in the package exports map', () => {
    for (const item of EXPECTED_ITEMS) {
      const { packageName, subpath } = splitSpecifier(item.name);
      // Workspace package dir mirrors the package name without the scope.
      const pkgJson = JSON.parse(
        readFileSync(packageJsonPath(packageName.replace('@wsz987/', '')), 'utf8'),
      ) as { name?: string; exports?: Record<string, unknown> };
      expect(pkgJson.name, `${packageName} exists in the workspace`).toBe(packageName);
      expect(
        pkgJson.exports?.[subpath],
        `${packageName} exports map covers ${subpath}`,
      ).toBeTruthy();
    }
  });
});

describe('every channel adapter can be disabled through its config', () => {
  it.each(['weixin', 'qq', 'dingtalk', 'lark'] as const)(
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
      expect(manifest.peerDependencies?.['@deepseek-ai/dsh-tools']).toBe('^0.1.0-rc.6');
      expect(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh-tools']?.optional).toBe(true);
      expect(manifest.devDependencies?.['@deepseek-ai/dsh-tools']).toBe('0.1.0-rc.6');
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
  it('passes only the real bundle through dsh plugin management', () => {
    const installer = readFileSync(fileURLToPath(DEV_INSTALLER_URL), 'utf8');

    expect(installer).toContain("'plugin', '--profile', profile, 'add', '-w', BUNDLE_DIR");
    expect(installer).toContain("spawnSync('pnpm', ['add', '-w', ...[...selectedDirs].map((dir) => resolve(dir))]");
    expect(installer).not.toContain("'plugin', '--profile', profile, 'add', '-w', ...toLink");
    expect(installer).toContain('owned.has(name)');
    expect(installer).not.toContain("name.startsWith('@wsz987/')");
    expect(installer).toContain("'plugin', '--profile', profile, 'remove', bundleName");
    expect(installer).toContain("spawnSync('pnpm', ['remove', '-w', ...implementations]");
  });
});
