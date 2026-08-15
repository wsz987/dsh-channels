#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';

const logPath = resolve('dsh-web.log');
const log = createWriteStream(logPath, { flags: 'w' });
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(command, ['@deepseek-ai/dsh', 'web', ...process.argv.slice(2)], {
  env: { ...process.env, DSH_CHANNELS_DEBUG: '1' },
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: true,
  shell: process.platform === 'win32',
});

function tee(stream, target) {
  stream.on('data', (chunk) => {
    target.write(chunk);
    log.write(chunk);
  });
}

tee(child.stdout, process.stdout);
tee(child.stderr, process.stderr);

child.on('error', (error) => {
  console.error(`[web:debug] failed to start dsh: ${error.message}`);
});

child.on('close', (code, signal) => {
  log.end(() => {
    if (signal) {
      console.error(`[web:debug] dsh exited from signal ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
});
