/**
 * Session V3 persistence contract. The bridge consumes snapshot rows and the
 * public read handle; the removed pre-V3 inspect/bare-header APIs are not
 * supported.
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import {
  PersistenceMembershipProbe,
  resolvePersistedInspection,
} from '../src/agent-manager.ts';

function snapshotRow(id: string): { header: { id: SessionId }; revision: number; sizeBytes: number } {
  return { header: { id: SessionId(id) }, revision: 1, sizeBytes: 128 };
}

function makePersistence(listResult: unknown[], extra: Record<string, unknown> = {}): SessionPersistence {
  return {
    list: vi.fn(async () => listResult),
    ...extra,
  } as unknown as SessionPersistence;
}

describe('PersistenceMembershipProbe', () => {
  it('matches V3 snapshot rows', async () => {
    const probe = new PersistenceMembershipProbe(() => makePersistence([snapshotRow('s-1')]));
    await expect(probe.exists('s-1')).resolves.toBe(true);
    await expect(probe.probe('s-1')).resolves.toBe('present');
    await expect(probe.probe('s-2')).resolves.toBe('missing');
  });

  it('stays unavailable without a live persistence', async () => {
    const probe = new PersistenceMembershipProbe(() => undefined);
    await expect(probe.exists('s-1')).resolves.toBe(false);
    await expect(probe.probe('s-1')).resolves.toBe('unavailable');
  });
});

describe('resolvePersistedInspection', () => {
  it('reads through the official V3 read handle', async () => {
    const close = vi.fn();
    const read = vi.fn(async () => ({ events: [] }));
    const persistence = makePersistence([], {
      open: vi.fn(async () => ({ header: { id: SessionId('s-1') }, read, close })),
    });
    const result = await resolvePersistedInspection(persistence, SessionId('s-1'));
    expect(result).toEqual({ meta: { id: SessionId('s-1') }, events: [] });
    expect(read).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('propagates a missing V3 open implementation', async () => {
    const persistence = makePersistence([]);
    await expect(resolvePersistedInspection(persistence, SessionId('s-1'))).rejects.toThrow();
  });

  it('closes the open() handle even when read() rejects', async () => {
    const close = vi.fn();
    const persistence = makePersistence([], {
      open: vi.fn(async () => ({
        header: { id: SessionId('s-1') },
        read: vi.fn(async () => {
          throw new Error('storage failure');
        }),
        close,
      })),
    });
    await expect(resolvePersistedInspection(persistence, SessionId('s-1'))).rejects.toThrow('storage failure');
    expect(close).toHaveBeenCalledOnce();
  });
});
