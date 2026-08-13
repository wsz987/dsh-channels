/**
 * Fixture loader — reads `fixtures/<channel>/<name>.json` fixtures from the
 * repository's `fixtures/` directory.
 *
 * Fixture format (see the repository execution plan, Task 3.4):
 *
 * ```json
 * {
 *   "name": "...",
 *   "upstreamVersion": "...",
 *   "payload": {},
 *   "expected": {}
 * }
 * ```
 *
 * The `fixtures/` directory is located by walking up from `process.cwd()`, so
 * the loader works regardless of which package directory the tests run from.
 */
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/** A single channel fixture case. */
export interface FixtureCase {
  /** Human-readable fixture name, e.g. `'inbound text'`. */
  name: string;
  /** Channel the fixture belongs to; present when written into the file. */
  channel?: string;
  /** Upstream/platform version the payload was captured against. */
  upstreamVersion: string;
  /** Raw inbound payload as delivered by the platform. */
  payload: unknown;
  /** Expected structured channel event the adapter should produce. */
  expected: unknown;
}

/**
 * Validate that a parsed fixture carries all required fields.
 * Throws with the list of missing fields when invalid.
 */
export function validateFixture(fixture: unknown): asserts fixture is FixtureCase {
  if (typeof fixture !== 'object' || fixture === null) {
    throw new Error('invalid fixture: expected a JSON object');
  }
  const record = fixture as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof record.name !== 'string') missing.push('name');
  if (typeof record.upstreamVersion !== 'string') missing.push('upstreamVersion');
  if (!('payload' in record)) missing.push('payload');
  if (!('expected' in record)) missing.push('expected');
  if (missing.length > 0) {
    throw new Error(`invalid fixture: missing required field(s): ${missing.join(', ')}`);
  }
}

/**
 * Locate the repository `fixtures/` directory by walking up from `start`
 * (defaults to `process.cwd()`).
 */
export function resolveFixturesDir(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, 'fixtures');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`fixtures/ directory not found while searching up from ${start}`);
}

function fixturePath(channel: string, name: string): string {
  // Guard against path traversal and tolerate an explicit `.json` suffix.
  const stem = basename(name).replace(/\.json$/i, '');
  if (!stem) throw new Error(`invalid fixture name: ${JSON.stringify(name)}`);
  return join(resolveFixturesDir(), channel, `${stem}.json`);
}

/** Load and validate `fixtures/<channel>/<name>.json` asynchronously. */
export async function loadFixture(channel: string, name: string): Promise<FixtureCase> {
  const raw = await readFile(fixturePath(channel, name), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  validateFixture(parsed);
  return parsed;
}

/** Load and validate `fixtures/<channel>/<name>.json` synchronously. */
export function loadFixtureSync(channel: string, name: string): FixtureCase {
  const raw = readFileSync(fixturePath(channel, name), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  validateFixture(parsed);
  return parsed;
}
