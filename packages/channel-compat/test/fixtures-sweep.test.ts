/**
 * Fixture sweep (M4 governance — `pnpm check:fixtures`).
 *
 * Sweeps every `fixtures/<channel>/*.json` file: parses it, validates it with
 * `validateFixture`, checks that the `channel` field matches the directory
 * name and that `upstreamVersion` is a non-empty string, and asserts every
 * channel directory carries the `inbound-text` and `duplicate` cases.
 * Prints a per-channel upstreamVersion summary (the CI surface). Fully
 * offline and deterministic (sorted iteration, no network).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFixturesDir, validateFixture, type FixtureCase } from '@wsz987/channel-testkit';

const FIXTURES_DIR = resolveFixturesDir();

interface ChannelCase {
  channel: string;
  file: string;
  path: string;
}

/**
 * The M0 upstream contract-fixture skeleton (plan §73) lives at
 * `fixtures/upstream/<channel>/<version>/` — a different layout from the
 * legacy `fixtures/<channel>/*.json` channel cases. It is not a channel root
 * and must not be swept here.
 */
const UPSTREAM_SKELETON_DIR = 'upstream';

function discoverChannels(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => statSync(join(FIXTURES_DIR, name)).isDirectory())
    .filter((name) => name !== UPSTREAM_SKELETON_DIR)
    .sort();
}

function discoverCases(channel: string): ChannelCase[] {
  return readdirSync(join(FIXTURES_DIR, channel))
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ channel, file, path: join(FIXTURES_DIR, channel, file) }));
}

function readFixture(c: ChannelCase): FixtureCase {
  const parsed: unknown = JSON.parse(readFileSync(c.path, 'utf8'));
  validateFixture(parsed);
  return parsed;
}

const channels = discoverChannels();

describe('fixture sweep (M4 governance)', () => {
  it('discovers the four official channel fixture directories', () => {
    for (const id of ['weixin', 'qq', 'dingtalk', 'lark']) {
      expect(channels).toContain(id);
    }
  });

  it('prints the per-channel upstreamVersion summary', () => {
    for (const channel of channels) {
      const cases = discoverCases(channel);
      const versions = [...new Set(cases.map((c) => readFixture(c).upstreamVersion))].sort();
      console.log(
        `[fixtures] ${channel}: ${cases.length} case(s), upstreamVersion(s): ${versions.join(', ')}`,
      );
    }
  });

  for (const channel of channels) {
    describe(`fixtures/${channel}`, () => {
      const cases = discoverCases(channel);

      it('contains the required inbound-text and duplicate cases', () => {
        const stems = cases.map((c) => c.file.replace(/\.json$/i, ''));
        expect(stems).toContain('inbound-text');
        expect(stems).toContain('duplicate');
      });

      for (const c of cases) {
        it(`validates ${c.file}`, () => {
          const fixture = readFixture(c);
          expect(fixture.channel).toBe(channel);
          expect(typeof fixture.upstreamVersion).toBe('string');
          expect(fixture.upstreamVersion.length).toBeGreaterThan(0);
        });
      }
    });
  }
});
