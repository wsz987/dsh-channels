/**
 * Inline setup form for one expanded channel (plan §17.1, §8.1).
 *
 * The descriptor + draft state are owned by the row (so the Auth section can
 * gate on the same descriptor); this component renders the fields and owns the
 * "保存并连接" action: `applySetup(channelId, { config, credentials,
 * reconcile: true })`. No channel-specific branches — intro copy and field
 * labels come from `channelRegistry.ts`.
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  applySetup,
  type ChannelSetupDescriptor,
  type ChannelSummary,
} from './api.js';
import { setupIntroKey, type ChannelWebDefinition } from './channelRegistry.js';
import { CredentialField } from './components/CredentialField.js';
import { SectionHeading } from './components/SectionHeading.js';

export interface ChannelSetupProps {
  channel: ChannelSummary;
  web: ChannelWebDefinition;
  descriptor: ChannelSetupDescriptor | null;
  loading: boolean;
  loadError: string | null;
  drafts: Record<string, string>;
  edited: Set<string>;
  onDraftsChange: Dispatch<SetStateAction<Record<string, string>>>;
  onEditedChange: Dispatch<SetStateAction<Set<string>>>;
  t: (key: string) => string;
  /** Event-driven refresh after a successful save (directory + descriptor reload). */
  onSaved: () => void;
}

export function ChannelSetup(props: ChannelSetupProps) {
  const { channel, web, descriptor, loading, loadError, drafts, edited, onDraftsChange, onEditedChange, t, onSaved } = props;

  if (loading) {
    return (
      <section aria-label={t('setupSection')} data-testid="channel-setup">
        <SectionHeading title={t('setupSection')} />
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{t('loading')}</div>
      </section>
    );
  }
  if (loadError || !descriptor) {
    return (
      <section aria-label={t('setupSection')} data-testid="channel-setup">
        <SectionHeading title={t('setupSection')} />
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>{loadError ?? '?'}</div>
      </section>
    );
  }

  // No config fields (e.g. Weixin): hide the whole "应用配置" section instead
  // of showing an empty "此渠道无需填写配置" placeholder.
  if (descriptor.fields.length === 0) return null;

  return (
    <section aria-label={t('setupSection')} data-testid="channel-setup">
      <SectionHeading title={t('setupSection')} />
      <SetupForm
        channelId={channel.id}
        descriptor={descriptor}
        web={web}
        drafts={drafts}
        edited={edited}
        onDraftsChange={onDraftsChange}
        onEditedChange={onEditedChange}
        t={t}
        onSaved={onSaved}
      />
    </section>
  );
}

function SetupForm({
  channelId,
  descriptor,
  web,
  drafts,
  edited,
  onDraftsChange,
  onEditedChange,
  t,
  onSaved,
}: {
  channelId: string;
  descriptor: ChannelSetupDescriptor;
  web: ChannelWebDefinition;
  drafts: Record<string, string>;
  edited: Set<string>;
  onDraftsChange: Dispatch<SetStateAction<Record<string, string>>>;
  onEditedChange: Dispatch<SetStateAction<Set<string>>>;
  t: (key: string) => string;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const saveController = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => saveController.current?.abort();
  }, []);

  // A field is "changed" when the user actually edited it — for credentials
  // this includes DELETING the value (empty draft = clear that credential on
  // save). Untouched fields are never resent, so a configured secret keeps its
  // stored value unless the user explicitly clears it.
  const changed = descriptor.fields.filter((field) => edited.has(field.name));
  const missing = descriptor.fields.filter(
    (field) => field.writable && !field.configured && !(drafts[field.name] ?? '').trim(),
  );
  const canSubmit = changed.length > 0 && missing.length === 0 && !saving;

  const submit = async () => {
    const config: Record<string, unknown> = {};
    const credentials: Record<string, string> = {};
    for (const field of changed) {
      const value = drafts[field.name]!.trim();
      if (field.secret) credentials[field.name] = value;
      else config[field.name] = value;
    }

    setSaving(true);
    setError(null);
    setSavedNotice(null);
    const controller = new AbortController();
    saveController.current = controller;
    try {
      await applySetup(channelId, { config, credentials, reconcile: true }, controller.signal);
      if (controller.signal.aborted) return;
      // Clear secret drafts so an untouched secret is never resent on the next
      // edit cycle; keep non-secret values visible.
      onDraftsChange((current) => {
        const next = { ...current };
        for (const field of descriptor.fields) {
          if (field.secret) next[field.name] = '';
        }
        return next;
      });
      onEditedChange(new Set());
      setSavedNotice(t('setupSaved'));
      onSaved();
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saveController.current = null;
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="credentials-form">
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }}>
        {t(setupIntroKey(web))}
      </p>
      {descriptor.setupUrl && (
        <a
          href={descriptor.setupUrl}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12, color: 'var(--dsw-alias-label-primary-bluish)', textDecoration: 'none', width: 'fit-content' }}
        >
          {t('openPlatform')} ↗
        </a>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {descriptor.fields.map((field) => (
          <CredentialField
            key={field.name}
            field={field}
            value={drafts[field.name] ?? ''}
            onChange={(value) => {
              onDraftsChange((current) => ({ ...current, [field.name]: value }));
              if (!field.secret) onEditedChange((current) => new Set(current).add(field.name));
            }}
            t={t}
            disabled={saving}
          />
        ))}
      </div>
      {missing.length > 0 && changed.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' }}>{t('incompleteSetup')}</div>
      )}
      {error && <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>{t('saveError')}: {error}</div>}
      {savedNotice && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' }} data-testid="setup-saved-notice">
          {savedNotice}
        </div>
      )}
      <div>
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={!canSubmit} data-testid="setup-save">
          {saving ? t('saving') : t('saveAndConnect')}
        </Button>
      </div>
    </div>
  );
}

export default ChannelSetup;
