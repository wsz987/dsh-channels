/**
 * FileSecretStore: a filesystem-backed SecretStore.
 *
 * One file per secret name (lower-cased, non-alphanumeric characters
 * sanitized). Values are written with mode 0600 and best-effort chmod'd again
 * after the atomic rename. Secret values are never logged by this store; they
 * round-trip as opaque UTF-8 strings exactly like the in-memory store.
 *
 * This is the Windows phase-1 implementation; it can later be replaced by a
 * Windows Credential Manager / DPAPI provider without touching any adapter.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { SecretStore } from './secrets.js';

export interface FileSecretStoreOptions {
  /** Absolute (or cwd-resolved) directory that stores one file per secret. */
  directory: string;
}

function sanitizeName(name: string): string {
  let out = '';
  const lower = name.toLowerCase();
  for (const ch of lower) {
    const code = ch.charCodeAt(0);
    const ok =
      (code >= 48 && code <= 57) ||
      (code >= 97 && code <= 122) ||
      ch === '-' || ch === '_' || ch === '.';
    out += ok ? ch : '_';
  }
  if (out.length === 0 || out === '.' || out === '..') return '_';
  return out;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export class FileSecretStore implements SecretStore {
  private readonly directory: string;

  constructor(options: FileSecretStoreOptions) {
    if (!options.directory) {
      throw new Error('FileSecretStore: directory is required');
    }
    this.directory = resolve(options.directory);
  }

  private pathFor(name: string): string {
    return join(this.directory, sanitizeName(name));
  }

  async get(name: string): Promise<string | undefined> {
    const file = this.pathFor(name);
    try {
      if (!existsSync(file)) return undefined;
      return readFileSync(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async set(name: string, value: string): Promise<void> {
    const file = this.pathFor(name);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
    writeFileSync(tmp, value, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows best-effort: chmod only toggles the read-only attribute.
    }
  }

  async delete(name: string): Promise<void> {
    const file = this.pathFor(name);
    try {
      rmSync(file, { force: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }
}
