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
import type { GroupAccessRule } from '../api.js';
import {
  groupSenderAccessMode,
  withGroupSenderAccessMode,
  type GroupSenderAccessMode,
} from '../accessPolicyUi.js';
import { AccessWarning } from './AccessWarning.js';
import { IdentityListEditor } from './IdentityListEditor.js';
import { Switch } from './Switch.js';

export interface GroupAccessCardProps {
  /** Canonical conversation/group id this card edits. */
  groupId: string;
  rule: GroupAccessRule;
  ownerId?: string;
  mentions: boolean;
  /** Display label for the member identity (e.g. descriptor.identityLabels.user). */
  userLabel: string;
  onChange: (next: GroupAccessRule) => void;
  onRemove?: () => void;
  fixedEnabled?: boolean;
  t: (key: string) => string;
}

export function GroupAccessCard({ groupId, rule, ownerId, mentions, userLabel, onChange, onRemove, fixedEnabled = false, t }: GroupAccessCardProps) {
  const sender = groupSenderAccessMode(rule, ownerId);

  const setSender = (next: GroupSenderAccessMode) => {
    onChange(withGroupSenderAccessMode(rule, next, ownerId));
  };

  const radio = (value: GroupSenderAccessMode, label: string, danger = false) => {
    const disabled = value === 'owner-only' && !ownerId;
    return (
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          cursor: disabled ? 'not-allowed' : 'pointer',
          color: danger
            ? 'var(--dsw-alias-state-warn-primary)'
            : disabled
              ? 'var(--dsw-alias-label-tertiary)'
              : 'var(--dsw-alias-label-primary)',
        }}
      >
        <input
          type="radio"
          name={'group-sender-' + groupId}
          checked={sender === value}
          disabled={disabled}
          onChange={() => setSender(value)}
          data-testid={'group-sender-' + value}
        />
        {label}
      </label>
    );
  };

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
        {onRemove && <button
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
        </button>}
        {!fixedEnabled && <Switch
          checked={rule.enabled}
          onChange={(v) => onChange({ ...rule, enabled: v })}
          aria-label={t('groupEnable')}
          testId="group-enabled"
        />}
      </div>

      {rule.enabled && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('memberAccess')}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {radio('owner-only', t('memberOnly'))}
              {radio('allowlist', t('memberSpecified'))}
              {radio('open', t('memberAllDanger'), true)}
            </div>
          </div>

          {sender === 'allowlist' && (
            <IdentityListEditor
              ids={rule.allowFrom}
              onChange={(ids) => onChange({ ...rule, allowFrom: ids })}
              label={userLabel}
              t={t}
            />
          )}

          {sender === 'open' && (
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
