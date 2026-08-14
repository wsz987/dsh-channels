/**
 * The "渠道" (Channels) Settings section component (M1).
 *
 * Read-only dashboard: renders four channel cards (Weixin/QQ/DingTalk/Lark)
 * with live status from GET /channels. The Weixin card has a 「连接微信」 button
 * that opens the QR auth dialog (beginAuth/pollAuth/submitVerifyCode through
 * the host API). Other cards show status + capabilities and a note that their
 * configuration UI opens in the next phase.
 *
 * Dependency-light: react + react/jsx-runtime only as runtime externals, plain
 * divs + inline styles, no @deepseek-ai UI primitives.
 */
import { useEffect, useState } from 'react';
import { fetchChannels, type ChannelView } from './api.js';
import { QrAuthDialog } from './QrAuthDialog.js';

export interface ChannelsSectionProps {
  close?: () => void;
  __t?: (key: string) => string;
  __requestRefresh?: number;
}

const CARD_IDS = ['weixin', 'qq', 'dingtalk', 'lark'] as const;
const CARD_LABELS: Record<string, string> = {
  weixin: 'Weixin',
  qq: 'QQ',
  dingtalk: 'DingTalk',
  lark: 'Lark',
};

export function ChannelsSection(props: ChannelsSectionProps) {
  const t: (key: string) => string = props.__t ?? ((key: string) => key);
  const [list, setList] = useState<ChannelView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchChannels()
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

  const byId = (id: string): ChannelView | undefined => list?.find((c) => c.id === id);
  const refresh = () => setRefreshTick((n) => n + 1);

  const openAuth = () => {
    setConnecting(true);
    setAuthOpen(true);
  };

  const cardBase: Record<string, string> = {
    border: '1px solid #e5e5e5',
    borderRadius: '10px',
    padding: '14px 16px',
    background: '#fafafa',
  };

  return (
    <div style={{ padding: '16px 20px', fontFamily: 'inherit', color: 'inherit' }}>
      {error && (
        <div style={{ fontSize: 12, color: '#d0453b', marginBottom: 12 }} data-testid="channels-error">
          {t('connectionError')}: {error}{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); refresh(); }} style={{ color: '#1f6feb' }}>{t('retry')}</a>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {CARD_IDS.map((id) => {
          const view = byId(id);
          return (
            <div key={id} style={cardBase} data-channel-card={id} data-testid={'channel-card-' + id}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{CARD_LABELS[id] ?? id}</div>
              <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                <div style={{ fontWeight: 600 }}>
                  <span style={{ color: statusColor(view) }}>● </span>
                  {statusLabel(view, t)}
                  {view && !view.mounted && (
                    <span style={{ fontWeight: 400, opacity: 0.6 }}> · {t('notMounted')}</span>
                  )}
                </div>
                <div>
                  {t('capabilities')}: {view ? Object.keys(view.capabilities ?? {}).slice(0, 4).join(', ') : '—'}
                </div>
                {id === 'weixin' && view?.status === 'unconfigured' && view?.mounted === true && (
                  <div style={{ opacity: 0.7 }}>{t('unconfiguredHint')}</div>
                )}
              </div>

              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                {id === 'weixin' && (
                  <button
                    onClick={openAuth}
                    disabled={connecting}
                    style={primaryBtn()}
                    data-testid="weixin-connect-button"
                  >
                    {connecting ? t('connecting') : t('connect')}
                  </button>
                )}
                {id !== 'weixin' && (
                  <span style={{ fontSize: 11, opacity: 0.6 }}>{t('configNextPhase')}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {authOpen && (
        <QrAuthDialog
          channelId="weixin"
          close={() => {
            setAuthOpen(false);
            setConnecting(false);
          }}
          onChange={() => {
            setAuthOpen(false);
            setConnecting(false);
            refresh();
          }}
          t={t}
        />
      )}
    </div>
  );
}

function primaryBtn(): Record<string, string> {
  return {
    padding: '6px 12px',
    borderRadius: 6,
    border: 'none',
    background: '#1f6feb',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 12,
  };
}

/** User-friendly label for a channel's live status; '—' while still loading. */
function statusLabel(view: ChannelView | undefined, t: (key: string) => string): string {
  if (!view) return '—';
  const map: Record<string, string> = {
    connected: t('statusConnected'),
    degraded: t('statusDegraded'),
    unconfigured: t('statusUnconfigured'),
    error: t('statusError'),
    unknown: t('statusUnknown'),
    down: t('statusDown'),
  };
  return map[view.status] ?? view.status;
}

/** Status dot color: green connected, amber degraded, red error, gray otherwise. */
function statusColor(view: ChannelView | undefined): string {
  switch (view?.status) {
    case 'connected':
      return '#1a7f37';
    case 'degraded':
      return '#9a6700';
    case 'error':
      return '#d0453b';
    default:
      return '#8a8a8a';
  }
}

export default ChannelsSection;
