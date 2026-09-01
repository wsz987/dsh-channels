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
  /**
   * Optional display title (alias → displayName → canonical OpenID);
   * defaults to the canonical groupId when the directory has no mapping.
   */
  title?: string;
  /** Optional secondary line (e.g. the short canonical id for debugging). */
  meta?: string;
  /** The platform identity behind this conversation changed (plan §23). */
  conflict?: boolean;
  rule: GroupAccessRule;
  ownerId?: string;
  mentions: boolean;
  memberPicker?: boolean;
  /** Display label for the member identity (e.g. descriptor.identityLabels.user). */
  userLabel: string;
  onChange: (next: GroupAccessRule) => void;
  onRemove?: () => void;
  fixedEnabled?: boolean;
  t: (key: string) => string;
}

export function GroupAccessCard({ groupId, title, meta, conflict, rule, ownerId, mentions, memberPicker = true, userLabel, onChange, onRemove, fixedEnabled = false, t }: GroupAccessCardProps) {
  const sender = groupSenderAccessMode(rule, ownerId);
  const canSpecifyMembers = memberPicker;

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
        <div style={{ flex: 1, minWidth: 0 }}>
          <span
            data-testid="group-id"
            style={{
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary)',
            }}
          >
            {title ?? groupId}
          </span>
          {meta && (
            <span
              data-testid="group-id-meta"
              style={{
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 12,
                fontWeight: 400,
                color: 'var(--dsw-alias-label-tertiary)',
              }}
            >
              {meta}
            </span>
          )}
          {conflict && (
            <span
              data-testid="group-identity-conflict"
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--dsw-alias-state-warn-primary)',
              }}
            >
              {t('conversationIdentityConflict')}
            </span>
          )}
        </div>
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
              {canSpecifyMembers && radio('allowlist', t('memberSpecified'))}
              {radio('open', t('memberAllDanger'), true)}
            </div>
          </div>

          {canSpecifyMembers && sender === 'allowlist' && (
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

        </>
      )}

      {/* Mention gating belongs to this conversation's group rule. Keep the
          control visible even when the rule is temporarily disabled so a
          named group does not lose the setting (the all-groups card is just
          another GroupAccessCard instance). */}
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
    </div>
  );
}

export default GroupAccessCard;
