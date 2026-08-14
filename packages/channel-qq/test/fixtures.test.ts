/**
 * Fixture tests (fully offline): every `fixtures/qq/*.json` payload maps
 * deeply to its `expected` event.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadFixture, resolveFixturesDir } from '@wsz987/channel-testkit';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { mapInbound } from '../src/mapper.ts';

const meta = { channel: 'qq' as never, accountId: 'main' as never };

function fixtureNames(): string[] {
  const dir = join(resolveFixturesDir(), 'qq');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/i, ''))
    .sort();
}

describe('qq fixtures', () => {
  for (const name of fixtureNames()) {
    it(`maps ${name}`, async () => {
      const fixture = await loadFixture('qq', name);
      const event = mapInbound(fixture.payload as QQBotInboundMessage, meta);
      expect(event).toEqual(fixture.expected);
    });
  }
});
