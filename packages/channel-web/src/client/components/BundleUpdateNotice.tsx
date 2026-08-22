/**
 * Advisory "new bundle version available" notice rendered at the bottom of the
 * Channels panel (below the channel list — never a top banner). Pure display:
 * it receives the host's sanitized `BundleUpdateInfo` DTO, holds no state and
 * fetches nothing (`useUpdateCheck` owns the request). When no update is known
 * (up-to-date, check failed or still pending) it renders nothing.
 */
import type { BundleUpdateInfo } from '../api.js';

export interface BundleUpdateNoticeProps {
  /** Sanitized host DTO, or null when no update is known → render nothing. */
  update: BundleUpdateInfo | null;
  t: (key: string) => string;
}

export function BundleUpdateNotice({ update, t }: BundleUpdateNoticeProps) {
  if (!update) return null;

  return (
    <div
      style={{
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        padding: '8px 12px',
        marginTop: 14,
      }}
      data-testid="update-banner"
    >
      <span>
        {t('updateAvailable').replace('{version}', update.version).replace('{tag}', update.tag)}
      </span>
      {update.crossLine && (
        <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('updateCrossLineHint')}</div>
      )}
      {update.commands.map((command) => (
        <div
          key={command}
          style={{
            fontFamily: 'var(--dsw-alias-font-family-mono, monospace)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {command}
        </div>
      ))}
    </div>
  );
}

export default BundleUpdateNotice;
