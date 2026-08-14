/**
 * Weixin QR auth dialog (M1).
 *
 * Self-manages the whole QR auth loop against the host: beginAuth → poll →
 * verification-code input → authenticated. Regenerate fetches a fresh
 * challenge. Encodes qrUrl into a QR image locally (data:image/* is used
 * as-is; any other URL/string is turned into a PNG data URL via `qrcode`), a
 * countdown from expiresAt, an expired overlay with regenerate, and a
 * verification-code input when the host reports prompt === 'verify-code'.
 *
 * Dependency-light: plain divs + inline styles, no @deepseek-ai UI primitives.
 */
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import {
  pollAuth,
  startAuth,
  submitAuthInput,
  type PublicAuthChallenge,
  type PublicAuthPoll,
} from './api.js';

export interface QrAuthDialogProps {
  channelId: string;
  close: () => void;
  /** Fired on auth success or regenerate so the parent can refresh status. */
  onChange: () => void;
  t: (key: string) => string;
}

type DialogState =
  | { phase: 'loading' }
  | { phase: 'pending' }
  | { phase: 'input'; poll: PublicAuthPoll }
  | { phase: 'success' }
  | { phase: 'expired' }
  | { phase: 'failed'; detail?: string };

export function QrAuthDialog(props: QrAuthDialogProps) {
  const { channelId, close, onChange, t } = props;
  const [challenge, setChallenge] = useState<PublicAuthChallenge | null>(null);
  const [state, setState] = useState<DialogState>({ phase: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [verifyCode, setVerifyCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [qrRenderError, setQrRenderError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const alive = useRef(true);

  const clearTimer = () => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = undefined;
    }
  };

  useEffect(() => {
    alive.current = true;
    // Begin a fresh challenge immediately on mount.
    void begin();
    return () => {
      alive.current = false;
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Begin a fresh challenge.
  const begin = async () => {
    clearTimer();
    setError(null);
    setState({ phase: 'loading' });
    try {
      const fresh = await startAuth(channelId);
      if (!alive.current) return;
      setChallenge(fresh);
      setVerifyCode('');
      setSecondsLeft(fresh.expiresAt ? Math.max(0, Math.ceil((fresh.expiresAt - Date.now()) / 1000)) : 0);
      setState({ phase: 'pending' });
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Start polling once a challenge exists.
  useEffect(() => {
    if (!challenge) return;
    if (state.phase !== 'pending') return;

    let inFlight = false;
    const run = async () => {
      if (!alive.current || !challenge || inFlight) return;
      inFlight = true;
      try {
        const poll = await pollAuth(channelId, challenge.id);
        if (!alive.current) return;
        if (poll.state === 'authenticated') {
          clearTimer();
          setState({ phase: 'success' });
          onChange();
          return;
        }
        if (poll.state === 'expired') {
          clearTimer();
          setState({ phase: 'expired' });
          return;
        }
        if (poll.state === 'failed') {
          clearTimer();
          setState({ phase: 'failed', detail: poll.detail });
          return;
        }
        // pending: surface verify-code prompt when the host says so.
        if (poll.prompt === 'verify-code') {
          setState({ phase: 'input', poll });
        }
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight = false;
      }
    };

    run();
    timer.current = setInterval(run, 3000);
    return () => clearTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge, state.phase, channelId]);

  // Countdown ticker driven by challenge.expiresAt.
  useEffect(() => {
    if (!challenge?.expiresAt) return;
    const id = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((challenge.expiresAt! - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [challenge]);

  // Encode the QR payload locally: data:image/* is used as-is, otherwise the
  // URL/string is turned into a PNG data URL (the Weixin challenge is a login
  // content URL, not an image URL).
  useEffect(() => {
    let disposed = false;
    const source = challenge?.qrUrl;

    if (!source) {
      setQrImage(null);
      setQrRenderError(null);
      return;
    }

    if (source.startsWith('data:image/')) {
      setQrImage(source);
      setQrRenderError(null);
      return;
    }

    QRCode.toDataURL(source, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 208,
    })
      .then((dataUrl) => {
        if (!disposed) {
          setQrImage(dataUrl);
          setQrRenderError(null);
        }
      })
      .catch((err) => {
        if (!disposed) {
          setQrImage(null);
          setQrRenderError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      disposed = true;
    };
  }, [challenge?.qrUrl]);

  const submitCode = async () => {
    if (!challenge || !verifyCode.trim()) return;
    setSubmitting(true);
    try {
      const poll = await submitAuthInput(channelId, challenge.id, {
        kind: 'verification-code',
        value: verifyCode.trim(),
      });
      if (!alive.current) return;
      if (poll.state === 'authenticated') {
        clearTimer();
        setState({ phase: 'success' });
        onChange();
      } else if (poll.state === 'expired') setState({ phase: 'expired' });
      else if (poll.state === 'failed') setState({ phase: 'failed', detail: poll.detail });
      else setState({ phase: 'input', poll });
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setSubmitting(false);
    }
  };

  const qrUrl = challenge?.qrUrl;
  const expiresAt = challenge?.expiresAt;

  return (
    <div
      style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      data-testid="qr-auth-dialog"
    >
      <div style={{ background: '#fff', color: '#111', borderRadius: 12, padding: 20, minWidth: 280, maxWidth: 380, boxShadow: '0 8px 30px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{t('title')}</div>
          <button onClick={close} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16 }}>{t('close')}</button>
        </div>

        {state.phase === 'loading' || (!challenge && !error) ? (
          <div style={{ textAlign: 'center', padding: '28px 0', fontSize: 13 }}>{t('connecting')}</div>
        ) : state.phase === 'expired' ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: 13, marginBottom: 12 }}>{t('expired')}</div>
            <button onClick={begin} style={primaryBtn()}>{t('regenerate')}</button>
          </div>
        ) : state.phase === 'success' ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: 13, color: '#2e9e5b' }}>{t('success')}</div>
          </div>
        ) : state.phase === 'failed' ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: 13, color: '#d0453b', marginBottom: 12 }}>
              {t('failed')}{state.detail ? ': ' + state.detail : ''}
            </div>
            <button onClick={begin} style={primaryBtn()}>{t('regenerate')}</button>
          </div>
        ) : (
          <div>
            {challenge?.instruction && (
              <div style={{ fontSize: 12, opacity: 0.7, margin: '8px 0' }}>{challenge.instruction}</div>
            )}
            {qrUrl ? (
              <div style={{ textAlign: 'center', padding: '12px 0' }}>
                {qrImage ? (
                  <img
                    src={qrImage}
                    alt="QR"
                    data-testid="qr-auth-image"
                    style={{ width: 208, height: 208, objectFit: 'contain', background: '#fff', border: '1px solid #e3e3e3', borderRadius: 6 }}
                  />
                ) : qrRenderError ? (
                  <a
                    href={qrUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="qr-auth-open-link"
                    style={{ color: '#1f6feb', fontSize: 13, textDecoration: 'underline' }}
                  >
                    {t('openLink')}
                  </a>
                ) : (
                  <div style={{ fontSize: 12, opacity: 0.6 }}>{t('connecting')}</div>
                )}
                {expiresAt && (
                  <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
                    {t('expiresIn')} {secondsLeft}{t('seconds')}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '24px 0', fontSize: 13 }}>{t('waitingScan')}</div>
            )}

            {state.phase === 'input' && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>{t('needVerifyCode')}</div>
                <input
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                  placeholder={t('verifyCodePlaceholder')}
                  data-testid="verify-code-input"
                  style={{ padding: 8, width: '100%', boxSizing: 'border-box', borderRadius: 6, border: '1px solid #ccc' }}
                />
                <button onClick={submitCode} disabled={submitting} style={{ ...primaryBtn(), marginTop: 8, width: '100%' }}>
                  {submitting ? '…' : t('submit')}
                </button>
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{ fontSize: 11, color: '#d0453b', marginTop: 8 }} data-testid="qr-auth-error">{error}</div>
        )}
      </div>
    </div>
  );
}

function primaryBtn(): Record<string, string> {
  return { padding: '8px 16px', borderRadius: 6, border: 'none', background: '#1f6feb', color: '#fff', cursor: 'pointer', fontSize: 13 };
}

export default QrAuthDialog;