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

/** Minimal external stubs for react / react/jsx-runtime / @deepseek-ai/cordis / UI primitives. */
function requireStub(id: string): unknown {
  switch (id) {
    case 'react':
      return { createElement: (t: unknown, p: unknown, ...c: unknown[]) => ({ type: t, props: p, children: c }) };
    case 'react/jsx-runtime':
      return { jsx: (t: unknown, p: unknown) => ({ type: t, props: p }), jsxs: (t: unknown, p: unknown) => ({ type: t, props: p }) };
    case '@deepseek-ai/cordis':
      return {};
    case '@deepseek-ai/dsh-client-ui-primitives':
      return {};
    default:
      throw new Error('unexpected require: ' + id);
  }
}

function loadClient(): LoadedModule {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
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
    const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
    // qrcode must be inlined: the Harness ModuleLoader does not provide it.
    expect(code).not.toContain('require("qrcode")');
    expect(code).not.toContain("require('qrcode')");
    // React stays external (provided by the Harness runtime).
    expect(code).toContain('require("react")');
    expect(code).toContain('require("react/jsx-runtime")');
  });

  it('keeps the UI primitives external (runtime-provided)', () => {
    const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
    // The Harness ModuleLoader registers the primitives under this bare id; the
    // bundle must require() it at runtime rather than inlining it.
    expect(code).toContain('require("@deepseek-ai/dsh-client-ui-primitives")');
    expect(code).toContain('@deepseek-ai/dsh-client-ui-primitives');
  });
});
