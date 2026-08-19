/**
 * The "渠道" (Channels) Settings section (refactor plan §10).
 *
 * The directory is fully backend-driven: on entry it issues exactly one
 * `GET /dsh-channels/api/v2/channels` and renders every channel the host
 * reports, enriched with presentation metadata from `channelRegistry.ts`.
 * Unknown channels still render through the generic fallback.
 *
 * Request lifecycle is strictly event-driven — no page-level polling:
 *   - initial entry + `__requestRefresh` tick → one GET /channels
 *   - browser becomes visible again → one GET /channels
 *   - after setup saved / auth success / enable / disable → `onChanged` → one
 *     GET /channels
 *   - manual retry on error
 *
 * Exactly one row is open at a time (`openChannelId`); `ChannelRow` +
 * `DisclosureRow` guarantee collapsed rows issue zero expanded-content requests.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchChannelsV2, type ChannelSummary } from './api.js';
import { channelWebDefinition } from './channelRegistry.js';
import { ChannelRow } from './ChannelRow.js';

export interface ChannelsSectionProps {
  close?: () => void;
  __t?: (key: string) => string;
  __requestRefresh?: number;
}

export function ChannelsSection(props: ChannelsSectionProps) {
  const t: (key: string) => string = props.__t ?? ((key: string) => key);
  const [list, setList] = useState<ChannelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openChannelId, setOpenChannelId] = useState<string | null>(null);

  const loadChannels = useCallback(async () => {
    try {
      const data = await fetchChannelsV2();
      setList(data);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  // One directory load on entry + any explicit refresh tick from the host.
  useEffect(() => {
    void loadChannels();
  }, [loadChannels, props.__requestRefresh]);

  // Event-driven refresh: returning to a visible tab re-reads the directory.
  // No setInterval anywhere (red line W8).
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadChannels();
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => document.removeEventListener('visibilitychange', refreshWhenVisible);
  }, [loadChannels]);

  const toggle = (id: string) => {
    setOpenChannelId((current) => (current === id ? null : id));
  };

  const rows = (list ?? [])
    .map((channel) => ({ channel, web: channelWebDefinition(channel.id) }))
    .sort((a, b) => a.web.order - b.web.order);

  return (
    <div
      style={{ padding: '16px 20px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)' }}
      data-testid="channels-section"
    >
      {error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            fontSize: 12,
            color: 'var(--dsw-alias-state-error-primary)',
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 10,
            padding: '8px 12px',
            marginBottom: 14,
          }}
          data-testid="channels-error"
        >
          <span>
            {t('connectionError')}: {error}
          </span>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              void loadChannels();
            }}
            style={{ color: 'var(--dsw-alias-label-primary-bluish)', textDecoration: 'none', whiteSpace: 'nowrap' }}
          >
            {t('retry')}
          </a>
        </div>
      )}

      {list === null && !error ? (
        <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '12px 0' }}>{t('loading')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }} data-testid="channel-directory">
          {rows.map(({ channel, web }) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              web={web}
              open={openChannelId === channel.id}
              onToggle={() => toggle(channel.id)}
              onChanged={() => void loadChannels()}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default ChannelsSection;
