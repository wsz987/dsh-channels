/**
 * Editor for ONE named-group access rule (plan §40).
 *
 * Each card is keyed by its canonical group id (the user adds groups by id in
 * the parent section; the id is fixed per card). Fields: the group id label,
 * senderPolicy radio (owner-only / specified / all members danger), the member
 * allowlist (only when senderPolicy === 'allowlist'), requireMention checkbox
 * (only when `descriptor.mentions === true`), and an enabled toggle. Sender
 * 'open' shows the danger warning.
 */
import type { GroupAccessRule, GroupSenderPolicy } from '../api.js';
import { AccessWarning } from './AccessWarning.js';
import { IdentityListEditor } from './IdentityListEditor.js';
import { Switch } from './Switch.js';

export interface GroupAccessCardProps {
  /** Canonical conversation/group id this card edits. */
  groupId: string;
  rule: GroupAccessRule;
  mentions: boolean;
  /** Display label for the member identity (e.g. descriptor.identityLabels.user). */
  userLabel: string;
  onChange: (next: GroupAccessRule) => void;
  onRemove: () => void;
  t: (key: string) => string;
}

type SenderOption = 'only-self' | 'specified' | 'all-members-danger';

function senderToOption(rule: GroupAccessRule): SenderOption {
  if (rule.senderPolicy === 'open') return 'all-members-danger';
  return rule.allowFrom.length === 0 ? 'only-self' : 'specified';
}

export function GroupAccessCard({ groupId, rule, mentions, userLabel, onChange, onRemove, t }: GroupAccessCardProps) {
  const sender = senderToOption(rule);

  const setSender = (next: SenderOption) => {
    if (next === 'all-members-danger') {
      onChange({ ...rule, senderPolicy: 'open' });
    } else if (next === 'only-self') {
      onChange({ ...rule, senderPolicy: 'allowlist', allowFrom: [] });
    } else {
      onChange({ ...rule, senderPolicy: 'allowlist' });
    }
  };

  const radio = (value: SenderOption, label: string, danger = false) => (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        cursor: 'pointer',
        color: danger ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-primary)',
      }}
    >
      <input
        type="radio"
        name={'group-sender-' + groupId}
        checked={sender === value}
        onChange={() => setSender(value)}
        data-testid={'group-sender-' + value}
      />
      {label}
    </label>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        padding: 10,
      }}
      data-testid="group-card"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          data-testid="group-id"
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--dsw-alias-label-primary)',
          }}
        >
          {groupId}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('rmGroup')}
          data-testid="group-remove"
          style={{
            flex: 'none',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--dsw-alias-label-tertiary)',
            fontSize: 14,
            lineHeight: 1,
            padding: 2,
          }}
        >
          ×
        </button>
        <Switch
          checked={rule.enabled}
          onChange={(v) => onChange({ ...rule, enabled: v })}
          aria-label={t('groupEnable')}
          testId="group-enabled"
        />
      </div>

      {rule.enabled && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('memberOnly')}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {radio('only-self', t('memberOnly'))}
              {radio('specified', t('memberSpecified'))}
              {radio('all-members-danger', t('memberAllDanger'), true)}
            </div>
          </div>

          {sender === 'specified' && (
            <IdentityListEditor
              ids={rule.allowFrom}
              onChange={(ids) => onChange({ ...rule, allowFrom: ids })}
              label={userLabel}
              t={t}
            />
          )}

          {sender === 'all-members-danger' && (
            <AccessWarning testId="group-open-danger">{t('memberAllDangerHint')}</AccessWarning>
          )}

          {mentions && (
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                cursor: 'pointer',
                color: 'var(--dsw-alias-label-primary)',
              }}
            >
              <input
                type="checkbox"
                checked={rule.requireMention}
                onChange={(e) => onChange({ ...rule, requireMention: e.target.checked })}
                data-testid="group-require-mention"
              />
              {t('requireMention')}
            </label>
          )}
        </>
      )}
    </div>
  );
}

export default GroupAccessCard;
