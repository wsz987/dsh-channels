/**
 * M0 end-to-end proof (execution plan M0 acceptance):
 *
 *   Fake Channel → Harness Agent → session/event → Fake Channel
 *
 * Reuses the testkit's assembled pipeline as the demo carrier.
 */
import { describe, expect, it } from 'vitest';
import { runFakeChannelE2E } from '@dsh/channel-testkit';

describe('M0 fake channel E2E', () => {
  it('routes inbound → agent followup → session event → reply', async () => {
    const e2e = await runFakeChannelE2E({ channel: 'fake' });

    await e2e.sendInbound('hello harness');
    await e2e.sendInbound('second message');

    expect(e2e.receivedByAgent).toHaveLength(2);
    expect(e2e.sessionIds).toHaveLength(2);
    expect(e2e.sentReplies.length).toBeGreaterThanOrEqual(2);
    expect(e2e.sentReplies[0]?.message.text).toContain('reply to hello harness');

    await e2e.dispose();
  });
});
