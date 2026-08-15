import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ChannelSummary } from '../api.js';

export interface RuntimeStatusProps {
  summary: ChannelSummary;
  t: (key: string) => string;
}

/**
 * Read-only user-facing connection state. Runtime lifecycle remains internal.
 */
export function RuntimeStatus(props: RuntimeStatusProps) {
  const { summary, t } = props;

  return (
    <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
        <StateDot state={stateFor(summary.connection)} />
        {connectionLabel(summary, t)}
      </div>
      <div style={{ opacity: 0.75 }}>
        {summary.configured ? t('configured') : t('notConfigured')}
        {' · '}{summary.enabled ? t('enabled') : t('disabled')}
      </div>
    </div>
  );
}

function stateFor(conn: ChannelSummary['connection']): 'done' | 'warning' | 'error' | 'ongoing' {
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

function connectionLabel(summary: ChannelSummary, t: (key: string) => string): string {
  switch (summary.connection) {
    case 'connected':
      return t('statusConnected');
    case 'degraded':
      return t('statusDegraded');
    case 'disconnected':
      return t('statusDown');
    case 'unknown':
      return t('statusUnknown');
    default:
      return summary.connection;
  }
}

export default RuntimeStatus;