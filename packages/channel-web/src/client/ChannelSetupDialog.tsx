import { useEffect, useRef, useState } from 'react';
import { Modal, Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  applySetup,
  beginAuth,
  cancelAuth,
  fetchSetup,
  pollAuthSession,
  type AuthMethod,
  type ChannelSetupDescriptor,
  type PublicAuthSession,
  type PublicAuthStatus,
} from './api.js';
import { CredentialField } from './components/CredentialField.js';
import { QrCodeDisplay } from './components/QrCodeDisplay.js';
import { AuthProgress } from './components/AuthProgress.js';
import { injectSetupDialogStyles } from './components/setupDialogStyles.js';

export interface ChannelSetupDialogProps {
  channelId: string;
  close: () => void;
  onChange: () => void;
  t: (key: string) => string;
  method?: AuthMethod;
}

type Step = 'loading' | 'credentials' | 'qr' | 'verification' | 'completed';

/** Generic setup form plus the real provider-auth flow used by Weixin. */
export function ChannelSetupDialog(props: ChannelSetupDialogProps) {
  const { channelId, close, onChange, t, method } = props;
  const [step, setStep] = useState<Step>('loading');
  const [descriptor, setDescriptor] = useState<ChannelSetupDescriptor | null>(null);
  const [session, setSession] = useState<PublicAuthSession | null>(null);
  const [status, setStatus] = useState<PublicAuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const sessionRef = useRef<PublicAuthSession | null>(null);
  const authMethodRef = useRef<AuthMethod | undefined>(method);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const [completedMessage, setCompletedMessage] = useState('success');

  // Collapse the primitives Modal body's default top gap (see setupDialogStyles).
  useEffect(() => {
    injectSetupDialogStyles();
  }, []);

  const clearTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = undefined;
  };

  const complete = (message = 'success') => {
    clearTimer();
    onChange();
    setCompletedMessage(message);
    setStep('completed');
  };

  const startAuth = async (authMethod: AuthMethod) => {
    clearTimer();
    setError(null);
    authMethodRef.current = authMethod;
    try {
      const next = await beginAuth(channelId, authMethod);
      if (!alive.current) return;
      sessionRef.current = next;
      setSession(next);
      setStatus({
        state: next.state,
        phase: next.phase,
        prompt: next.prompt,
        expiresAt: next.expiresAt,
      });
      if (next.phase === 'authorized') complete('success');
      else setStep(next.phase === 'verification-required' ? 'verification' : 'qr');
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const setup = await fetchSetup(channelId);
        if (!alive.current) return;
        setDescriptor(setup);
        if (method) await startAuth(method);
        else if (setup.fields.length > 0) setStep('credentials');
        else if (setup.authMethods.length > 0) await startAuth(setup.authMethods[0]!);
        else setStep('completed');
      } catch (cause) {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      alive.current = false;
      clearTimer();
      const active = sessionRef.current;
      if (active?.id) void cancelAuth(channelId, active.id).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session?.id || !(step === 'qr' || step === 'verification')) return;
    let inFlight = false;
    const poll = async () => {
      if (!alive.current || inFlight) return;
      inFlight = true;
      try {
        const next = await pollAuthSession(channelId, session.id);
        if (!alive.current) return;
        setStatus(next);
        if (next.phase === 'authorized' || next.state === 'authenticated') complete('success');
        else if (next.phase === 'verification-required') setStep('verification');
        else if (next.phase === 'expired' || next.phase === 'failed') clearTimer();
      } catch (cause) {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inFlight = false;
      }
    };
    void poll();
    timer.current = setInterval(poll, 3000);
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, session?.id, step]);

  return (
    <Modal
      open
      onClose={close}
      title={t('title') + ' · ' + channelId}
      closeLabel={t('close')}
      contentClassName="dsc-setup-dialog"
      footer={
        step === 'completed' ? (
          <Button variant="primary" onClick={close} data-testid="setup-done-button">
            {t('done')}
          </Button>
        ) : undefined
      }
    >
      <div data-testid="channel-setup-dialog">
        {error && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--dsw-alias-state-error-primary)',
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 8,
              padding: '8px 10px',
              marginBottom: 14,
            }}
          >
            {error}
          </div>
        )}
        {step === 'loading' && (
          <div style={{ textAlign: 'center', padding: '28px 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
            {t('loading')}
          </div>
        )}

        {step === 'credentials' && descriptor && (
          <CredentialsForm
            channelId={channelId}
            descriptor={descriptor}
            t={t}
            onComplete={(configured) => complete(configured ? 'setupSaved' : 'setupDisabled')}
          />
        )}

        {(step === 'qr' || step === 'verification') && (
          <div data-testid="auth-flow" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            {session?.qr && <QrCodeDisplay payload={session.qr} width={208} t={t} />}
            {status && (
              <div style={{ width: '100%' }}>
                <AuthProgress
                  channelId={channelId}
                  sessionId={session?.id ?? ''}
                  status={status}
                  t={t}
                  onRegenerate={() => {
                    const activeMethod = authMethodRef.current;
                    if (activeMethod) void startAuth(activeMethod);
                  }}
                />
              </div>
            )}
          </div>
        )}

        {step === 'completed' && (
          <div data-testid="setup-completed" style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--dsw-alias-state-success-primary)', marginBottom: 14 }}>
              {t(completedMessage)}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function CredentialsForm({
  channelId,
  descriptor,
  t,
  onComplete,
}: {
  channelId: string;
  descriptor: ChannelSetupDescriptor;
  t: (key: string) => string;
  onComplete: (configured: boolean) => void;
}) {
  // Seed non-secret fields with their current values (appId/clientId are
  // viewable); secret fields start empty so an untouched secret is never resent.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const field of descriptor.fields) {
      if (!field.secret && field.value) seed[field.name] = field.value;
    }
    return seed;
  });
  const [edited, setEdited] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = descriptor.fields.filter((field) =>
    field.secret ? Boolean((drafts[field.name] ?? '').trim()) : edited.has(field.name),
  );
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
    try {
      const result = await applySetup(channelId, { config, credentials });
      setDrafts((current) => {
        const next = { ...current };
        for (const field of descriptor.fields) {
          if (field.secret) next[field.name] = '';
        }
        return next;
      });
      onComplete(result.configured);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-testid="credentials-form">
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }}>
        {t('setupIntro')}
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
              setDrafts((current) => ({ ...current, [field.name]: value }));
              if (!field.secret) setEdited((current) => new Set(current).add(field.name));
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
      <div style={{ marginTop: 2, paddingTop: 14, borderTop: '1px solid var(--dsw-alias-border-l1)' }}>
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={!canSubmit}
          data-testid="setup-save"
          style={{ width: '100%' }}
        >
          {saving ? t('saving') : t('saveAndConnect')}
        </Button>
      </div>
    </div>
  );
}

export default ChannelSetupDialog;
