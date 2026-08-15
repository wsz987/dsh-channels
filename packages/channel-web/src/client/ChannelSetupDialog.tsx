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
      footer={
        step === 'completed' ? (
          <Button variant="primary" onClick={close} data-testid="setup-done-button">
            {t('done')}
          </Button>
        ) : undefined
      }
    >
      <div data-testid="channel-setup-dialog">
        {error && <div style={{ fontSize: 12, color: '#d0453b', marginBottom: 10 }}>{error}</div>}
        {step === 'loading' && <div style={{ textAlign: 'center', padding: '28px 0', fontSize: 13 }}>{t('loading')}</div>}

        {step === 'credentials' && descriptor && (
          <CredentialsForm
            channelId={channelId}
            descriptor={descriptor}
            t={t}
            onComplete={() => complete('setupSaved')}
          />
        )}

        {(step === 'qr' || step === 'verification') && (
          <div data-testid="auth-flow" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {session?.qr && <QrCodeDisplay payload={session.qr} width={208} t={t} />}
            {status && (
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
            )}
          </div>
        )}

        {step === 'completed' && (
          <div data-testid="setup-completed" style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 14, color: '#1a7f37', marginBottom: 14 }}>{t(completedMessage)}</div>
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
  onComplete: () => void;
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = descriptor.fields.filter((field) => (drafts[field.name] ?? '').trim());
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
      if (!result.configured) throw new Error(t('incompleteSetup'));
      onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-testid="credentials-form">
      <div style={{ fontSize: 12, opacity: 0.8 }}>{t('setupIntro')}</div>
      {descriptor.setupUrl && (
        <a href={descriptor.setupUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#1f6feb', width: 'fit-content' }}>
          {t('openPlatform')}
        </a>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {descriptor.fields.map((field) => (
          <CredentialField
            key={field.name}
            field={field}
            value={drafts[field.name] ?? ''}
            onChange={(value) => setDrafts((current) => ({ ...current, [field.name]: value }))}
            t={t}
            disabled={saving}
          />
        ))}
      </div>
      {missing.length > 0 && changed.length > 0 && (
        <div style={{ fontSize: 11, color: '#9a6700' }}>{t('incompleteSetup')}</div>
      )}
      {error && <div style={{ fontSize: 11, color: '#d0453b' }}>{t('saveError')}: {error}</div>}
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
  );
}

export default ChannelSetupDialog;