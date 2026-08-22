import { describe, expect, it } from 'vitest';
import { WeixinConfigManager } from '../src/upstream/config-manager.js';

describe('WeixinConfigManager', () => {
  it('caches a valid typing ticket and refreshes after its randomized window', async () => {
    let now = 0;
    let calls = 0;
    const manager = new WeixinConfigManager({
      now: () => now,
      rand: () => 0,
      minRefreshMs: 100,
      refreshJitterMs: 0,
      fetchConfig: async () => ({ typing_ticket: `ticket-${++calls}` }),
    });
    await expect(manager.resolveTypingTicket('peer')).resolves.toBe('ticket-1');
    await expect(manager.resolveTypingTicket('peer')).resolves.toBe('ticket-1');
    expect(calls).toBe(1);
    now = 100;
    await expect(manager.resolveTypingTicket('peer')).resolves.toBe('ticket-2');
  });

  it('uses exponential retry and keeps a prior ticket when refresh fails', async () => {
    let now = 0;
    let succeed = true;
    const manager = new WeixinConfigManager({
      now: () => now,
      rand: () => 0,
      minRefreshMs: 10,
      refreshJitterMs: 0,
      initialRetryDelayMs: 20,
      fetchConfig: async () => {
        if (!succeed) throw new Error('network down');
        return { typing_ticket: 'ticket-1' };
      },
    });
    await expect(manager.resolveTypingTicket('peer')).resolves.toBe('ticket-1');
    now = 10;
    succeed = false;
    await expect(manager.resolveTypingTicket('peer')).resolves.toBe('ticket-1');
    now = 29;
    await expect(manager.resolveTypingTicket('peer')).resolves.toBe('ticket-1');
  });
});
