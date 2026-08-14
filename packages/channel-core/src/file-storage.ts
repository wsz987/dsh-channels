/**
 * FileStorage: a durable ChannelStorage backed by the local filesystem.
 *
 * One UTF-8 file per storage key. The key is split on ':' into a nested path,
 * so a namespace like weixin:sync-cursor:main lands at weixin/sync-cursor/main.
 * Writes are atomic (temp file + rename) so a crash mid-write never corrupts
 * an existing value.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ChannelStorage } from './storage.js';

export interface FileStorageOptions {
  /** Absolute (or cwd-resolved) directory that stores the value tree. */
  directory: string;
}

function sanitizeSegment(segment: string): string {
  let out = '';
  for (const ch of segment) {
    const code = ch.charCodeAt(0);
    const ok =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      ch === '-' || ch === '_' || ch === '.';
    out += ok ? ch : '_';
  }
  if (out.length === 0 || out === '.' || out === '..') return '_';
  return out;
}

function keyToRelativePath(key: string): string {
  return key.split(':').map(sanitizeSegment).join('/');
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export class FileStorage implements ChannelStorage {
  private readonly directory: string;

  constructor(options: FileStorageOptions) {
    if (!options.directory) {
      throw new Error('FileStorage: directory is required');
    }
    this.directory = resolve(options.directory);
  }

  private pathFor(key: string): string {
    return join(this.directory, keyToRelativePath(key));
  }

  async get(key: string): Promise<string | undefined> {
    const file = this.pathFor(key);
    try {
      if (!existsSync(file)) return undefined;
      return readFileSync(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const file = this.pathFor(key);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
    writeFileSync(tmp, value, 'utf8');
    renameSync(tmp, file);
  }

  async delete(key: string): Promise<void> {
    const file = this.pathFor(key);
    try {
      rmSync(file, { force: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }
}
