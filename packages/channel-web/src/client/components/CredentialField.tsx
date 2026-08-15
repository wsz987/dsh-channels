import { useState } from 'react';
import { Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ChannelSetupField } from '../api.js';

export interface CredentialFieldProps {
  field: ChannelSetupField;
  value: string;
  onChange: (value: string) => void;
  t: (key: string) => string;
  disabled?: boolean;
}

/** Shown as a fake password value while a configured secret is not being edited. */
const MASKED_SECRET = '••••••••';

/**
 * Presentational setup field. Saving is owned by the parent form so a channel
 * with multiple credentials still has one user action.
 *
 * Non-secret fields show their current value (seeded by the parent from
 * `field.value`). Configured secret fields show a masked placeholder value;
 * focusing clears the mask so the user can type a replacement, and leaving the
 * field empty keeps the existing secret. The "已配置/未配置" pill is gone:
 * the field's own value/mask already communicates that state.
 */
export function CredentialField(props: CredentialFieldProps) {
  const { field, value, onChange, t, disabled = false } = props;

  const isSecret = field.kind === 'secret';
  const inputDisabled = !field.writable || disabled;
  const [editing, setEditing] = useState(false);

  // A configured secret with no typed replacement shows masked dots; focusing
  // switches to the real (empty) value so a fresh replacement can be entered.
  const masked = isSecret && field.configured && !editing && !value;
  const displayValue = masked ? MASKED_SECRET : value;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid={'credential-field-' + field.name}>
      <label style={{ fontSize: 12, opacity: 0.85, display: 'flex', alignItems: 'center', gap: 6 }}>
        {field.name}
        {!field.writable && <Pill active={false}>{t('readonlyHint')}</Pill>}
      </label>
      <Input
        type={isSecret ? 'password' : 'text'}
        value={displayValue}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          if (isSecret && field.configured) setEditing(true);
        }}
        onBlur={() => setEditing(false)}
        placeholder={t('inputValue')}
        disabled={inputDisabled}
      />
    </div>
  );
}

export default CredentialField;
