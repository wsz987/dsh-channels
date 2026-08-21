import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface LoadedModule {
  id?: string;
  factory?: (require: (id: string) => unknown) => Record<string, unknown>;
}

let captured: LoadedModule | undefined;

/**
 * Static shell identities of the rc.2 client module graph
 * (`PLATFORM_MODULES` exported by @deepseek-ai/dsh-client-web): compiled into
 * the Vite shell, shared into the frozen module table, and resolvable by
 * every bundle factory's require(). They are NOT dynamic graph rows.
 */
const STATIC_SHELL_IDENTITIES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
];

/** Minimal external stubs for the static identities the bundle requires. */
function requireStub(id: string): unknown {
  switch (id) {
    case 'react':
      return { createElement: (t: unknown, p: unknown, ...c: unknown[]) => ({ type: t, props: p, children: c }) };
    case 'react/jsx-runtime':
      return { jsx: (t: unknown, p: unknown) => ({ type: t, props: p }), jsxs: (t: unknown, p: unknown) => ({ type: t, props: p }) };
    case '@deepseek-ai/dsh-client-ui-primitives':
      return {};
    default:
      throw new Error('unexpected require: ' + id);
  }
}

function loadClientCode(): string {
  return readFileSync(join(root, 'lib', 'client.js'), 'utf8');
}

function loadClient(): LoadedModule {
  const code = loadClientCode();
  captured = {};
  const sandbox: Record<string, unknown> = {};
  sandbox.window = {};
  sandbox.window = {
    __ModuleLoader__: {
      load: (m: LoadedModule) => {
        captured = m;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox as vm.Context);
  if (!captured || typeof captured.factory !== 'function') {
    throw new Error('branch: window.__ModuleLoader__.load did not capture a factory');
  }
  const exports = captured.factory(requireStub) as Record<string, unknown>;
  return { id: captured.id, factory: captured.factory, exports };
}

/** Extract the require() specifiers the factory body actually emits. */
function requiredSpecifiers(code: string): Set<string> {
  const specs = new Set<string>();
  const re = /require\((['"])((?:[^\\'"\n]|\\.)*)\1\)/g;
  for (const match of code.matchAll(re)) specs.add(match[2]!);
  return specs;
}

describe('@wsz987/channel-web client bundle', () => {
  let module: LoadedModule & { exports?: Record<string, unknown> };

  beforeEach(() => {
    captured = undefined;
    module = loadClient();
  });

  it('captures the module id "@wsz987/channel-web"', () => {
    expect(module.id).toBe('@wsz987/channel-web');
  });

  it('exports name === "channel-web"', () => {
    expect(module.exports!.name).toBe('channel-web');
  });

  it('exports inject containing "slots" and "locale"', () => {
    const inject = module.exports!.inject as string[];
    expect(inject).toContain('slots');
    expect(inject).toContain('locale');
  });

  it('apply() registers locale dictionaries and the settings.section slot', () => {
    const registered: unknown[] = [];
    let boundNs: string | undefined;
    let sectionRegisterCalls: Array<Record<string, unknown>> = [];
    let injectedKey: string | undefined;

    const fakeCtx = {
      effect: (cb: () => void) => { cb(); },
      locale: {
        register: (ns: string, dict: Record<string, Record<string, string>>) => {
          registered.push({ ns, dict });
        },
        bind: (ns: string) => {
          boundNs = ns;
          return (key: string) => key;
        },
      },
      slots: {
        inject: (key: string, fn: () => unknown) => {
          injectedKey = key;
          const result = fn();
          return result;
        },
        register: (opts: Record<string, unknown>, component: unknown) => {
          sectionRegisterCalls.push(opts);
          expect(typeof component).toBe('function');
        },
      },
    };

    const apply = module.exports!.apply as (ctx: unknown) => void;
    apply(fakeCtx);

    expect(registered.length).toBe(1);
    const [reg] = registered as Array<{ ns: string; dict: Record<string, any> }>;
    expect(reg.ns).toBe('channels');
    expect(reg.dict.zh).toBeDefined();
    expect(reg.dict.en).toBeDefined();
    expect(reg.dict.zh.nav).toBe('渠道');
    expect(reg.dict.en.nav).toBe('Channels');

    expect(boundNs).toBe('channels');
    expect(injectedKey).toBe('settings.section');
    expect(sectionRegisterCalls.length).toBe(1);
    const opts = sectionRegisterCalls[0]!;
    expect(opts.name).toBe('settings.section');
    expect(opts.id).toBe('channels');
    expect(opts.order).toBe(60);
  });

  it('bundles qrcode inline instead of requiring it at runtime', () => {
    const code = loadClientCode();
    // qrcode must be inlined: the Harness ModuleLoader does not provide it.
    expect(code).not.toContain('require("qrcode")');
    expect(code).not.toContain("require('qrcode')");
    // React stays external (provided by the Harness runtime).
    expect(code).toContain('require("react")');
    expect(code).toContain('require("react/jsx-runtime")');
  });

  it('keeps the UI primitives external (runtime-provided)', () => {
    const code = loadClientCode();
    // The Harness ModuleLoader registers the primitives under this bare id; the
    // bundle must require() it at runtime rather than inlining it.
    expect(code).toContain('require("@deepseek-ai/dsh-client-ui-primitives")');
    expect(code).toContain('@deepseek-ai/dsh-client-ui-primitives');
  });
});

describe('@wsz987/channel-web rc.2 client module graph contract', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dsh?: { client?: { platform?: string; inject?: string[] } };
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  it('declares dsh.client with platform web and only dynamic client packages in inject', () => {
    expect(pkg.dsh?.client?.platform).toBe('web');
    // The one dynamic client dependency of this entry: the provider of the
    // "locale" service. Static shell identities must never appear here.
    expect(pkg.dsh?.client?.inject).toEqual(['@deepseek-ai/dsh-client-locale']);
  });

  it('never lists a static shell identity in dsh.client.inject', () => {
    const inject = pkg.dsh?.client?.inject ?? [];
    for (const identity of STATIC_SHELL_IDENTITIES) {
      expect(inject, `static identity ${identity} must not be a dynamic graph row`).not.toContain(identity);
    }
  });

  it('layers dependencies per the rc.2 static/dynamic split', () => {
    // Dynamic client dependency → peer + dev (compile input).
    expect(pkg.peerDependencies?.['@deepseek-ai/dsh-client-locale']).toBe('0.1.1-rc.2');
    expect(pkg.devDependencies?.['@deepseek-ai/dsh-client-locale']).toBe('0.1.1-rc.2');
    // Static UI library → dev-only compilation input, never a peer.
    expect(pkg.peerDependencies?.['@deepseek-ai/dsh-client-ui-primitives']).toBeUndefined();
    expect(pkg.devDependencies?.['@deepseek-ai/dsh-client-ui-primitives']).toBe('0.1.1-rc.2');
    // React is shell-owned: dev-only, not shipped as a dependency.
    expect(pkg.dependencies?.react).toBeUndefined();
    expect(pkg.peerDependencies?.react).toBeUndefined();
    expect(pkg.devDependencies?.react).toBeTruthy();
  });

  it('registers through the rc.2 window.__ModuleLoader__.load protocol', () => {
    const code = loadClientCode().replace(/\/\/# sourceMappingURL=[^\n]*(\s*)$/, '');
    // Same wrapper shape as the official rc.2 dynamic client artifacts: the
    // executing script only registers the factory; module body side effects
    // live inside the factory closure.
    expect(code.startsWith('window.__ModuleLoader__.load({\n  id: "@wsz987/channel-web",\n  factory: (require) => {')).toBe(true);
    expect(code.trimEnd().endsWith('return module.exports;\n  }\n});')).toBe(true);
  });

  it('requires only declared externals (bundle purity gate)', () => {
    const code = loadClientCode();
    const allowed = new Set([
      ...STATIC_SHELL_IDENTITIES,
      ...(pkg.dsh?.client?.inject ?? []),
    ]);
    for (const spec of requiredSpecifiers(code)) {
      expect(allowed.has(spec), `undeclared external require("${spec}")`).toBe(true);
    }
    // The externals the current client surface actually consumes:
    expect(requiredSpecifiers(code)).toEqual(new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']));
  });

  it('does not inline static shell identities into the bundle', () => {
    const code = loadClientCode();
    // Inlining ui-primitives would drag its dependency tree (shiki/katex/
    // markdown) into the artifact; inlining react would duplicate the shell's
    // React and break hooks. Their presence means the externals list drifted.
    expect(code).not.toContain('katex');
    expect(code).not.toContain('shiki');
    expect(code).not.toContain('mdast-util-from-markdown');
    expect(code).not.toContain('require("react-dom")');
    expect(code).not.toContain('require("react-dom/client")');
    expect(code).not.toContain('require("@deepseek-ai/cordis")');
  });
});
