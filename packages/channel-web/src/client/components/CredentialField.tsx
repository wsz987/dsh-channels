import { Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ChannelSetupField } from '../api.js';

export interface CredentialFieldProps {
  field: ChannelSetupField;
  value: string;
  onChange: (value: string) => void;
  t: (key: string) => string;
  disabled?: boolean;
}

/**
 * Presentational setup field. Saving is owned by the parent form so a channel
 * with multiple credentials still has one user action.
 */
export function CredentialField(props: CredentialFieldProps) {
  const { field, value, onChange, t, disabled = false } = props;

  const label = field.name;
  const isSecret = field.kind === 'secret';
  const inputDisabled = !field.writable || disabled;

  const placeholder = isSecret && field.configured ? t('credentialKeepBlank') : t('inputValue');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid={'credential-field-' + field.name}>
      <label style={{ fontSize: 12, opacity: 0.85, display: 'flex', alignItems: 'center', gap: 6 }}>
        {label}
        {field.configured && <Pill active>{t('configured')}</Pill>}
        {!field.configured && <Pill active={false}>{t('notConfigured')}</Pill>}
        {!field.writable && <Pill active={false}>{t('readonlyHint')}</Pill>}
      </label>
      <Input
        type={isSecret ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={inputDisabled}
      />
    </div>
  );
}

export default CredentialField;