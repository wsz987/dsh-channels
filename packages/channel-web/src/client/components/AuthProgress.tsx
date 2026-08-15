import { useState } from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import { submitAuthInput, type PublicAuthStatus } from '../api.js';

export interface AuthProgressProps {
  channelId: string;
  sessionId: string;
  status: PublicAuthStatus;
  t: (key: string) => string;
  /** Fire to begin a fresh auth session (expired → regenerate, failed → retry). */
  onRegenerate?: () => void;
}

/**
 * Renders a PublicAuthStatus by phase (§Task 8). It NEVER parses `detail` to
 * decide behaviour — phase alone drives the UI. 'verification-required' shows
 * an inline verification-code input that calls submitAuthInput. The parent
 * observes `authorized`/failed via polling and advances the flow itself.
 */
export function AuthProgress(props: AuthProgressProps) {
  const { channelId, sessionId, status, t, onRegenerate } = props;

  if (status.phase === 'authorized' || status.state === 'authenticated') {
    return (
      <div data-testid="auth-progress" style={{ fontSize: 13, color: '#2e9e5b', textAlign: 'center', padding: '12px 0' }}>
        {t('success')}
      </div>
    );
  }

  if (status.phase === 'expired' || status.state === 'expired') {
    return (
      <div data-testid="auth-progress" style={{ textAlign: 'center', padding: '16px 0' }}>
        <div style={{ fontSize: 13, marginBottom: 12 }}>{t('expired')}</div>
        <Button variant="outline" size="sm" onClick={onRegenerate} data-testid="auth-retry">
          {t('regenerate')}
        </Button>
      </div>
    );
  }

  if (status.phase === 'failed' || status.state === 'failed') {
    return (
      <div data-testid="auth-progress" style={{ textAlign: 'center', padding: '16px 0' }}>
        <div style={{ fontSize: 13, color: '#d0453b', marginBottom: 12 }}>
          {t('failed')}{status.detail ? ': ' + status.detail : ''}
        </div>
        <Button variant="outline" size="sm" onClick={onRegenerate} data-testid="auth-retry">
          {t('retry')}
        </Button>
      </div>
    );
  }

  switch (status.phase) {
    case 'waiting-scan':
      return <div data-testid="auth-progress" style={hint()}>{t('waitingScan')}</div>;
    case 'scanned':
      return <div data-testid="auth-progress" style={hint()}>{t('scannedConfirm')}</div>;
    case 'waiting-confirm':
      return <div data-testid="auth-progress" style={hint()}>{t('confirmOnPhone')}</div>;
    case 'credentials-required':
      return <div data-testid="auth-progress" style={hint()}>{t('credentialsRequired')}</div>;
    case 'verification-required':
      return <VerifyCodeInput channelId={channelId} sessionId={sessionId} t={t} />;
    case 'preparing':
    default:
      return <div data-testid="auth-progress" style={hint()}>{t('preparing')}</div>;
  }
}

function VerifyCodeInput({
  channelId,
  sessionId,
  t,
}: {
  channelId: string;
  sessionId: string;
  t: (key: string) => string;
}) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!code.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitAuthInput(channelId, sessionId, 'verification-code', code.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-testid="auth-progress" style={{ marginTop: 4 }}>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>{t('needVerifyCode')}</div>
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={t('verifyCodePlaceholder')}
        data-testid="verify-code-input"
      />
      <Button
        variant="primary"
        onClick={() => void submit()}
        disabled={submitting || !code.trim()}
        style={{ marginTop: 8, width: '100%' }}
      >
        {submitting ? '…' : t('submit')}
      </Button>
      {error && <div style={{ fontSize: 11, color: '#d0453b', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

type CssStyle = Record<string, string | number>;

function hint(): CssStyle {
  return { fontSize: 13, opacity: 0.8, textAlign: 'center' as const, padding: '12px 0' };
}

export default AuthProgress;
