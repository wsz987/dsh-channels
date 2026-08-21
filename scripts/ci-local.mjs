#!/usr/bin/env node
/**
 * Run the repository's CI gates locally before committing or pushing.
 * Keep this sequence aligned with .github/workflows/ci.yml.
 */
import { spawnSync } from 'node:child_process';

const steps = [
  ['build', ['build']],
  ['typecheck', ['typecheck']],
  ['test', ['test']],
  ['build verification targets', ['build', '--filter=@wsz987/channel-verify...']],
  ['build Telegram verification target', ['build', '--filter=@wsz987/channel-telegram...']],
  ['build Weixin verification target', ['build', '--filter=@wsz987/channel-weixin...']],
  ['verify Telegram adapter', ['verify', './packages/channel-telegram', '--test']],
  ['verify Weixin adapter', ['verify', './packages/channel-weixin', '--test']],
  ['check fixtures', ['check:fixtures']],
  ['check manifests', ['check:manifests']],
  ['check harness baseline', ['check:harness-compat']],
  ['report harness newer', ['check:harness-newer']],
  ['run doctor', ['doctor']],
  ['check bundle', ['check:bundle']],
];

for (const [label, args] of steps) {
  console.log(`\n[ci:check] ${label}: pnpm ${args.join(' ')}`);
  const result = spawnSync('pnpm', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(`[ci:check] failed to start pnpm: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[ci:check] ${label} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n[ci:check] all CI gates passed');
