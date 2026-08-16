#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const webLib = join(root, '..', 'channel-web', 'lib');

const source = await readFile(join(webLib, 'client.js'), 'utf8');
const client = source.replace(
  'id: "@wsz987/channel-web"',
  'id: "@wsz987/dsh-channels"',
);

if (client === source) {
  throw new Error('channels: channel-web client bundle has an unexpected module id');
}

await writeFile(join(root, 'lib', 'client.js'), client, 'utf8');

const sourceMap = await readFile(join(webLib, 'client.js.map'), 'utf8');
await writeFile(join(root, 'lib', 'client.js.map'), sourceMap, 'utf8');
