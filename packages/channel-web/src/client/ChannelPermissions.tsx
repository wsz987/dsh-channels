/**
 * Inline platform-permission section for one expanded channel (plan §26–§28,
 * §8.1). Static presentation only in this iteration: the requirement list and
 * the official docs link come from `channelRegistry.ts`. Platform permission
 * (Lark scopes / QQ bot permission / DingTalk event permission / Telegram bot
 * capabilities) stays deliberately separate from Harness Agent permission —
 * this section never touches the Agent model.
 *
 * Rendered only while the row is open (DisclosureRow children), so a collapsed
 * row issues zero permission requests (red line W6).
 */
import type { ChannelSummary } from './api.js';
import type { ChannelWebDefinition } from './channelRegistry.js';
import { SectionHeading } from './components/SectionHeading.js';

export interface ChannelPermissionsProps {
  channel: ChannelSummary;
  web: ChannelWebDefinition;
  t: (key: string) => string;
}

export function ChannelPermissions(props: ChannelPermissionsProps) {
  const { web, t } = props;
  const permissions = web.permissions;
  if (!permissions || permissions.items.length === 0) return null;

  return (
    <section aria-label={t('permissionsSection')} data-testid="channel-permissions">
      <SectionHeading title={t('permissionsSection')} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {permissions.items.map((item) => (
          <div
            key={item.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              color: 'var(--dsw-alias-label-secondary)',
            }}
            data-testid="permission-item"
          >
            <span style={{ color: 'var(--dsw-alias-state-success-primary)', width: 14, flex: 'none' }}>✓</span>
            <span>{t(item.labelKey)}</span>
            {item.required && (
              <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' }}>{t('permissionRequired')}</span>
            )}
          </div>
        ))}
      </div>
      {permissions.docsUrl && (
        <a
          href={permissions.docsUrl}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12, color: 'var(--dsw-alias-label-primary-bluish)', textDecoration: 'none', width: 'fit-content', marginTop: 8, display: 'inline-block' }}
          data-testid="permissions-docs-link"
        >
          {t('viewOfficialDocs')} ↗
        </a>
      )}
    </section>
  );
}

export default ChannelPermissions;
