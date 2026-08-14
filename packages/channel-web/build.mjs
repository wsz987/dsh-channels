#!/usr/bin/env node
/**
 * Build script for @wsz987/channel-web.
 *
 * Produces:
 *   lib/client.js      Harness Web client bundle (esbuild CJS, wrapped in
 *                      window.__ModuleLoader__.load({ id, factory }))
 *   lib/client.js.map  source map for the client bundle
 *
 * The host half (src/index.ts + src/protocol.ts) is compiled by tsc in the
 * package "build" script (`tsc -p tsconfig.json && node build.mjs`). The client
 * half is NOT typechecked by tsc (esbuild strips types).
 *
 * Every bare-specifier import in the client bundle is kept as a runtime
 * require() call (react, react/jsx-runtime, @deepseek-ai/...); only relative
 * imports are inlined — exactly the Harness bundle convention (§1.2).
 */
import { build } from 'esbuild';
import { writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

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
    // Keep every bare package import as require(); bundle only relative files.
    packages: 'external',
    outfile: root + '/lib/.client.tmp.js',
    write: false,
  });

  const out = result.outputFiles.find((f) => f.path.endsWith('.client.tmp.js')) ?? result.outputFiles[0];
  let code = out.text;

  // Strip the trailing sourceMappingURL comment so we append our own.
  code = code.replace(/\/\/# sourceMappingURL=[^\n]*\s*$/, '');

  const wrapped = [
    'window.__ModuleLoader__.load({',
    '  id: "@wsz987/channel-web",',
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    '    try {',
    '      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    '    } catch (e) { /* environments without Symbol support */ }',
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