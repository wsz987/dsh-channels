/**
 * The "渠道" (Channels) Settings section component (M5).
 *
 * Dashboard that renders four channel cards (Weixin/QQ/DingTalk/Lark) with
 * live summary from GET /channels/api/v2 via fetchChannelsV2. Each card shows a
 * RuntimeStatus and a «配置» button that opens the generic ChannelSetupDialog.
 *
 * Cards are themed purely through the Harness `--dsw-alias-*` token family so
 * they track the host's light/dark theme: `bg-layer-3` surface (elevated above
 * the settings panel's `bg-layer-2`), `border-l2` resting border with a
 * `border-l3` hover, and `label-primary/secondary` text. Each channel gets a
 * small brand-tinted monogram tile for a bit of visual identity.
 */
import { useEffect, useState } from 'react';
import { Button, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { fetchChannelsV2, type AuthMethod, type ChannelSummary } from './api.js';
import { ChannelSetupDialog } from './ChannelSetupDialog.js';
import { channelDisplayName } from './channelNames.js';
import { RuntimeStatus } from './components/RuntimeStatus.js';
import { ChannelBrandIcon } from './components/ChannelBrandIcon.js';

export interface ChannelsSectionProps {
  close?: () => void;
  __t?: (key: string) => string;
  __requestRefresh?: number;
}

const CARD_IDS = ['weixin', 'qq', 'dingtalk', 'lark'] as const;

interface ChannelMeta {
  accent: string;
}

// Accent = brand color, used as a subtle tint behind the card's brand logo.
const CHANNEL_META: Record<string, ChannelMeta> = {
  weixin: { accent: '#07c160' },
  qq: { accent: '#1ebafc' },
  dingtalk: { accent: '#0089ff' },
  lark: { accent: '#3370ff' },
};

interface OpenDialog {
  id: string;
  method?: AuthMethod;
}

export function ChannelsSection(props: ChannelsSectionProps) {
  const t: (key: string) => string = props.__t ?? ((key: string) => key);
  const [list, setList] = useState<ChannelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [openDialog, setOpenDialog] = useState<OpenDialog | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchChannelsV2()
      .then((data) => {
        if (alive) {
          setList(data);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [refreshTick, props.__requestRefresh]);

  const byId = (id: string): ChannelSummary | undefined => list?.find((c) => c.id === id);
  const refresh = () => setRefreshTick((n) => n + 1);

  const overlay = 'var(--dsw-alias-border-l2)';

  return (
    <div style={{ padding: '16px 20px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)' }}>
      {error && (
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            fontSize: 12, color: 'var(--dsw-alias-state-error-primary)',
            background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 10, padding: '8px 12px', marginBottom: 14,
          }}
          data-testid="channels-error"
        >
          <span>
            {t('connectionError')}: {error}
          </span>
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); refresh(); }}
            style={{ color: 'var(--dsw-alias-label-primary-bluish)', textDecoration: 'none', whiteSpace: 'nowrap' }}
          >
            {t('retry')}
          </a>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
          gap: 12,
        }}
      >
        {CARD_IDS.map((id) => {
          const summary = byId(id);
          const meta = CHANNEL_META[id] ?? { accent: 'var(--dsw-alias-label-tertiary)' };
          const hovered = hoverId === id;
          return (
            <div
              key={id}
              style={{
                background: 'var(--dsw-alias-bg-layer-3)',
                border: '1px solid ' + (hovered ? 'var(--dsw-alias-border-l3, var(--dsw-alias-border-l2))' : overlay),
                borderRadius: 14,
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                boxSizing: 'border-box',
                transition: 'border-color 0.15s ease',
              }}
              data-channel-card={id}
              data-testid={'channel-card-' + id}
              onMouseEnter={() => setHoverId(id)}
              onMouseLeave={() => setHoverId(null)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    width: 30, height: 30, borderRadius: 8, flex: 'none',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: meta.accent + '1f',
                  }}
                >
                  <ChannelBrandIcon channelId={id} size={16} />
                </span>
                <span
                  style={{ fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}
                >
                  {channelDisplayName(id, t)}
                </span>
                {summary && (
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}>
                    <Tooltip label={() => connectionLabel(summary.connection, t)} side="top">
                      <span style={{ display: 'inline-flex' }}>
                        <StateDot state={connectionState(summary.connection)} size={8} />
                      </span>
                    </Tooltip>
                  </span>
                )}
              </div>

              {summary ? (
                <RuntimeStatus summary={summary} t={t} />
              ) : (
                <div style={{ fontSize: 12, opacity: 0.6, color: 'var(--dsw-alias-label-tertiary)' }}>{t('loading')}</div>
              )}

              <div
                style={{
                  marginTop: 2, paddingTop: 10,
                  borderTop: '1px solid var(--dsw-alias-border-l1)',
                  display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
                }}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOpenDialog({ id, method: id === 'weixin' ? 'qr' : undefined })}
                  data-testid={'configure-' + id}
                >
                  {t('configure')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {openDialog && (
        <ChannelSetupDialog
          channelId={openDialog.id}
          method={openDialog.method}
          close={() => setOpenDialog(null)}
          onChange={refresh}
          t={t}
        />
      )}
    </div>
  );
}

function connectionState(conn: ChannelSummary['connection']): 'done' | 'warning' | 'error' | 'ongoing' {
  switch (conn) {
    case 'connected':
      return 'done';
    case 'degraded':
      return 'warning';
    case 'disconnected':
      return 'error';
    case 'unknown':
    default:
      return 'ongoing';
  }
}

function connectionLabel(conn: ChannelSummary['connection'], t: (key: string) => string): string {
  switch (conn) {
    case 'connected':
      return t('statusConnected');
    case 'degraded':
      return t('statusDegraded');
    case 'disconnected':
      return t('statusDown');
    case 'unknown':
      return t('statusUnknown');
    default:
      return conn;
  }
}

export default ChannelsSection;
