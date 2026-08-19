/**
 * Editable list of canonical IDs (add/remove) for an allowlist (plan §39/§40).
 * Each row is a read-only ID chip with a remove button (×); a trailing input
 * accepts a new ID and commits it on Enter. IDs are canonical and opaque — no
 * lowercase, no fuzzy matching — matches the channel-core contract.
 */
import { useState } from 'react';

export interface IdentityListEditorProps {
  ids: string[];
  onChange: (ids: string[]) => void;
  label: string;
  t: (key: string) => string;
}

export function IdentityListEditor({ ids, onChange, label, t }: IdentityListEditorProps) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const value = draft.trim();
    if (!value) return;
    if (ids.includes(value)) return;
    onChange([...ids, value]);
    setDraft('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{label}</span>
      {ids.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {ids.map((id) => (
            <div
              key={id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                background: 'var(--dsw-alias-bg-layer-1)',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 6,
                padding: '4px 8px',
              }}
              data-testid="identity-chip"
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)' }}>
                {id}
              </span>
              <button
                type="button"
                aria-label={t('rmGroup')}
                data-testid="identity-remove"
                onClick={() => onChange(ids.filter((x) => x !== id))}
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
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          value={draft}
          placeholder={t('userPlaceholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          data-testid="identity-input"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            padding: '4px 8px',
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary)',
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={commit}
          disabled={!draft.trim()}
          data-testid="identity-add"
          style={{
            flex: 'none',
            fontSize: 13,
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'transparent',
            cursor: draft.trim() ? 'pointer' : 'not-allowed',
            color: 'var(--dsw-alias-label-primary)',
            opacity: draft.trim() ? 1 : 0.5,
          }}
        >
          {t('addUser')}
        </button>
      </div>
    </div>
  );
}

export default IdentityListEditor;
