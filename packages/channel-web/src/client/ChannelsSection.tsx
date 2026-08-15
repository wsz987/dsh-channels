/**
 * The "渠道" (Channels) Settings section component (M5).
 *
 * Dashboard that renders four channel cards (Weixin/QQ/DingTalk/Lark) with
 * live summary from GET /channels/api/v2 via fetchChannelsV2. Each card shows
 * a RuntimeStatus and a 「配置」 button that opens the generic ChannelSetupDialog.
 * The Weixin card keeps a prominent 「连接微信」 button that opens the dialog
 * pre-set to the 'qr' auth step (M1 flow, unchanged UX, now over the v2 API).
 *
 * Dependency-light: react + react/jsx-runtime + @deepseek-ai/dsh-client-ui-primitives
 * as runtime externals; plain divs + minimal inline styles for layout.
 */
import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { fetchChannelsV2, type AuthMethod, type ChannelSummary } from './api.js';
import { ChannelSetupDialog } from './ChannelSetupDialog.js';
import { RuntimeStatus } from './components/RuntimeStatus.js';

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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {CARD_IDS.map((id) => {
          const summary = byId(id);
          return (
            <div key={id} style={cardBase} data-channel-card={id} data-testid={'channel-card-' + id}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{CARD_LABELS[id] ?? id}</div>
              {summary ? (
                <RuntimeStatus summary={summary} t={t} />
              ) : (
                <div style={{ fontSize: 12, opacity: 0.6 }}>{t('loading')}</div>
              )}
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                {id === 'weixin' && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setOpenDialog({ id, method: 'qr' })}
                    data-testid="weixin-connect-button"
                  >
                    {t('connect')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOpenDialog({ id })}
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

export default ChannelsSection;