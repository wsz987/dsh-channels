import type { ChannelSummary } from '../api.js';

export interface RuntimeStatusProps {
  summary: ChannelSummary;
  t: (key: string) => string;
}

/**
 * Read-only user-facing state for a card body. Connection + presence is
 * conveyed by the card-header StateDot, so the body only notes configuration
 * status — the redundant "已启用" text is dropped.
 */
export function RuntimeStatus(props: RuntimeStatusProps) {
  const { summary, t } = props;

  return (
    <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', opacity: 0.9 }}>
      {summary.configured ? t('configured') : t('notConfigured')}
    </div>
  );
}

export default RuntimeStatus;
