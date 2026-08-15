
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { PublicQrPayload } from '../api.js';

export interface QrCodeDisplayProps {
  /** QR payload; null/undefined shows the "waiting" placeholder. */
  payload?: PublicQrPayload | null;
  width?: number;
  t: (key: string) => string;
}

/**
 * Generic QR renderer (§38) — the ONLY QR component in the client.
 *
 * Render rules:
 *   - kind 'data-url'      → the host already gave us an image; render <img>.
 *   - kind 'content'       → encode with qrcode.toDataURL(), showing a loading
 *                            state meanwhile and a fallback link on error.
 *   - kind 'external-url'  → encode the URL as a QR code and offer a
 *                            "在新窗口打开" link next to it.
 *   - no payload           → "等待扫码" placeholder (t('waitingScan')).
 *
 * A countdown is shown when payload.expiresAt is present.
 * Dependency-light: react + react/jsx-runtime only; qrcode is bundled inline.
 */
export function QrCodeDisplay(props: QrCodeDisplayProps) {
  const { payload, width = 208, t } = props;
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [qrRenderError, setQrRenderError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Encode content/external-url payloads locally into a PNG data URL.
  useEffect(() => {
    let disposed = false;
    const value = payload && payload.kind !== 'data-url' ? payload.value : undefined;

    if (value == null) {
      setQrImage(null);
      setQrRenderError(null);
      return;
    }

    setQrImage(null);
    setQrRenderError(null);
    QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 1, width })
      .then((dataUrl) => {
        if (!disposed) setQrImage(dataUrl);
      })
      .catch((err) => {
        if (!disposed) setQrRenderError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      disposed = true;
    };
  }, [payload?.kind, payload?.value, width]);

  // Countdown ticker driven by payload.expiresAt.
  useEffect(() => {
    const expiresAt = payload?.expiresAt;
    if (expiresAt == null) return;
    setSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    const id = setInterval(() => setSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))), 1000);
    return () => clearInterval(id);
  }, [payload?.expiresAt]);

  if (!payload) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 0', fontSize: 13 }} data-testid="qr-auth-image">
        {t('waitingScan')}
      </div>
    );
  }

  const isExternal = payload.kind === 'external-url';
  const imgStyle: Record<string, string | number> = {
    width, height: width, objectFit: 'contain', background: '#fff',
    border: '1px solid #e3e3e3', borderRadius: 6,
  };

  let body;
  if (payload.kind === 'data-url') {
    body = <img src={payload.value} alt="QR" data-testid="qr-auth-image" style={imgStyle} />;
  } else if (qrImage) {
    body = <img src={qrImage} alt="QR" data-testid="qr-auth-image" style={imgStyle} />;
  } else if (qrRenderError) {
    body = (
      <a
        href={payload.value}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="qr-auth-image"
        style={{ color: '#1f6feb', fontSize: 13, textDecoration: 'underline' }}
      >
        {t('openLink')}
      </a>
    );
  } else {
    body = <div style={{ fontSize: 12, opacity: 0.6 }}>{t('loading')}</div>;
  }

  return (
    <div style={{ textAlign: 'center', padding: '12px 0' }}>
      {body}
      {isExternal && (
        <div style={{ marginTop: 8 }}>
          <a
            href={payload.value}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="qr-open-link"
            style={{ color: '#1f6feb', fontSize: 12, textDecoration: 'underline' }}
          >
            {t('openLink')} ↗
          </a>
        </div>
      )}
      {payload.expiresAt != null && (
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }} data-testid="qr-countdown">
          {t('expiresIn')} {secondsLeft}{t('seconds')}
        </div>
      )}
    </div>
  );
}

export default QrCodeDisplay;
