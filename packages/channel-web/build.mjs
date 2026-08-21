#!/usr/bin/env node
/**
 * Build script for @wsz987/channel-web.
 *
 * Produces:
 *   lib/client.js      Harness Web client bundle (esbuild CJS, wrapped in
 *                      window.__ModuleLoader__.load({ id, factory }))
 *   lib/client.js.map  source map for the client bundle
 *
 * rc.2 client module graph contract (verified against
 * @deepseek-ai/dsh-client-modules@0.1.1-rc.2 and @deepseek-ai/dsh-client-web@0.1.1-rc.2):
 *
 * - A dynamic client package registers itself by executing
 *   `window.__ModuleLoader__.load({ id, factory })`; the factory only runs at
 *   materialization and receives a synchronous `require`.
 * - `require(spec)` resolves in this order: static shell seed word →
 *   registered dynamic package factory → throw. The static seed table
 *   (`PLATFORM_MODULES` exported by @deepseek-ai/dsh-client-web) is:
 *     react, react/jsx-runtime, react-dom, react-dom/client,
 *     @deepseek-ai/cordis,
 *     @deepseek-ai/dsh-client-ui-slots,
 *     @deepseek-ai/dsh-client-ui-primitives
 *   Those identities are compiled into the Vite shell — they are NOT dynamic
 *   graph rows, must never appear in `dsh.client.inject`, and a bundle must
 *   reference them via `require(...)` instead of inlining them (inlining
 *   ui-primitives would drag in shiki/katex/markdown — megabytes, and a second
 *   React copy would break hooks).
 * - Dynamic client packages (declared in this package's `dsh.client.inject`)
 *   are served by the host at `/plugins/<id>/client.js` and resolved through
 *   the module table, so any import of them stays external too.
 *
 * Everything else (e.g. `qrcode`, which the client needs to render QR codes
 * locally) is bundled inline so the artifact has no undeclared runtime
 * dependency. The purity gate below fails the build when the emitted bundle
 * requires anything outside the declared externals — the build-time mirror of
 * the loader's runtime resolution error.
 */
import { build } from 'esbuild';
import { writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/**
 * Static shell identities this client imports (subset of the rc.2
 * `PLATFORM_MODULES` seed table — see header). React belongs to the shell;
 * ui-primitives is a static assembly library, not a dynamic graph row.
 */
const STATIC_SHELL_IDENTITIES = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
];

/** Dynamic client packages this entry depends on (`dsh.client.inject`). */
const dynamicClientModules = pkg.dsh?.client?.inject ?? [];

/** Every specifier the artifact may `require()` at runtime. */
const allowedExternals = new Set([...STATIC_SHELL_IDENTITIES, ...dynamicClientModules]);

/** Extract the require() specifiers from the emitted factory body. */
function requiredSpecifiers(code) {
  const specs = new Set();
  const re = /require\((['"])((?:[^\\'"\n]|\\.)*)\1\)/g;
  for (const match of code.matchAll(re)) specs.add(match[2]);
  return specs;
}

async function buildClient() {
  const result = await build({
    entryPoints: [root + '/src/client/index.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    sourcemap: 'external',
    sourcesContent: true,
    // The rc.2 module table resolves static shell identities and dynamic
    // client packages; everything else (qrcode, …) is bundled inline.
    external: [...allowedExternals],
    outfile: root + '/lib/.client.tmp.js',
    write: false,
  });

  const out = result.outputFiles.find((f) => f.path.endsWith('.client.tmp.js')) ?? result.outputFiles[0];
  let code = out.text;

  // Strip the trailing sourceMappingURL comment so we append our own.
  code = code.replace(/\/\/# sourceMappingURL=[^\n]*\s*$/, '');

  // Bundle purity gate: the loader throws at runtime for unresolvable
  // requires ("not a platform seed word, not a materialized module, and no
  // registered package factory"); fail here, at build time, instead.
  const specs = requiredSpecifiers(code);
  const drift = [...specs].filter((spec) => !allowedExternals.has(spec));
  if (drift.length > 0) {
    throw new Error(
      '[channel-web] client bundle requires undeclared externals: ' +
        drift.map((s) => JSON.stringify(s)).join(', ') +
        ' — add them to STATIC_SHELL_IDENTITIES / dsh.client.inject, or bundle them inline.',
    );
  }

  // Same wrapper shape as the official rc.2 dynamic client artifacts
  // (tsdown output of e.g. @deepseek-ai/dsh-client-ui-settings-general).
  // NOTE: packages/channels/build.mjs rewrites the `id:` line below when it
  // rebrands this artifact for the @wsz987/dsh-channels bundle.
  const wrapped = [
    'window.__ModuleLoader__.load({',
    '  id: "@wsz987/channel-web",',
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    code,
    '    return module.exports;',
    '  }',
    '});',
    '//# sourceMappingURL=client.js.map',
    '',
  ].join('\n');

  await writeFile(root + '/lib/client.js', wrapped, 'utf8');

  const mapOut = result.outputFiles.find((f) => f.path.endsWith('.map'));
  if (mapOut) {
    await writeFile(root + '/lib/client.js.map', mapOut.text, 'utf8');
  }
  if (existsSync(root + '/lib/.client.tmp.js')) {
    await rm(root + '/lib/.client.tmp.js', { force: true });
  }
}

await buildClient();
console.log('[channel-web] client bundle written to lib/client.js');
