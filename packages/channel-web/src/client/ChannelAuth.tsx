/**
 * Inline interactive-auth section for one expanded channel (plan §8.1, §17.2).
 *
 * Rendered only while the row is open (DisclosureRow children), so no auth
 * request exists for a collapsed row (red line W6). beginAuth happens ONLY on
 * an explicit user click of "开始授权" (red line W7, 39.4/39.5); the loop,
 * cancellation and visibility pausing all live in `useChannelAuth`.
 *
 * The method list and prerequisite gating are derived from the setup descriptor
 * plus `channelRegistry.ts` metadata — this component contains no built-in
 * channel id checks (red line W2).
 */
import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { AuthMethod, ChannelSetupDescriptor, ChannelSummary } from './api.js';
import {
  channelDocsPlacement,
  needsConfigBeforeAuth,
  setupMethods,
  type ChannelWebDefinition,
} from './channelRegistry.js';
import { AuthProgress } from './components/AuthProgress.js';
import { OfficialDocsLink } from './components/OfficialDocsLink.js';
import { QrCodeDisplay } from './components/QrCodeDisplay.js';
import { SectionHeading } from './components/SectionHeading.js';
import { useChannelAuth } from './useChannelAuth.js';

export interface ChannelAuthProps {
  channel: ChannelSummary;
  web: ChannelWebDefinition;
  /** Latest setup descriptor (owned by the row; prerequisite gating input). */
  descriptor: ChannelSetupDescriptor | null;
  /** Whether the setup form holds unsaved drafts (persisted before auth). */
  hasUnsavedSetup: boolean;
  /** Persist the setup form without reconciling the runtime. */
  saveSetup: () => Promise<void>;
  /** Event-driven refresh after a successful authorization. */
  onAuthorized: () => void;
  t: (key: string) => string;
}

export function ChannelAuth(props: ChannelAuthProps) {
  const { channel, web, descriptor, hasUnsavedSetup, saveSetup, onAuthorized, t } = props;
  const auth = useChannelAuth({
    channelId: channel.id,
    web,
    descriptor,
    hasUnsavedSetup,
    saveSetup,
    onAuthorized,
    t,
  });

  const [selectedMethod, setSelectedMethod] = useState<AuthMethod | null>(null);

  const interactiveMethods = (descriptor ? setupMethods(descriptor) : [])
    .filter((method): method is AuthMethod => method !== 'credentials');

  if (interactiveMethods.length === 0) return null;

  const method = selectedMethod ?? interactiveMethods[0]!;
  const gated = needsConfigBeforeAuth(web, descriptor ?? { fields: [], authMethods: [] });
  const onBegin = () => void auth.begin(method);

  return (
    <section aria-label={t('authSection')} data-testid="channel-auth">
      <SectionHeading
        title={t('authSection')}
        action={
          descriptor && channelDocsPlacement(web, descriptor) === 'auth' && web.docsUrl
            ? <OfficialDocsLink href={web.docsUrl} label={t('viewOfficialDocs')} />
            : undefined
        }
      />

      {interactiveMethods.length > 1 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {interactiveMethods.map((m) => (
            <Button
              key={m}
              type="button"
              size="sm"
              variant={method === m ? 'primary' : 'ghost'}
              disabled={!auth.canBegin(m)}
              onClick={() => setSelectedMethod(m)}
            >
              {authMethodLabel(m, t)}
            </Button>
          ))}
        </div>
      )}

      {!auth.active ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <Button
            variant="primary"
            size="sm"
            onClick={onBegin}
            disabled={auth.busy || gated || !auth.canBegin(method)}
            data-testid="auth-begin"
          >
            {auth.busy ? t('saving') : t('beginAuth')}
          </Button>
          {gated && (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' }} data-testid="auth-gated-hint">
              {t('authNeedsConfigFirst')}
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }} data-testid="auth-flow">
          {auth.session?.qr && auth.status?.state !== 'expired' && (
            <QrCodeDisplay payload={auth.session.qr} width={208} t={t} />
          )}
          {auth.status && (
            <div style={{ width: '100%' }}>
              <AuthProgress
                channelId={channel.id}
                sessionId={auth.session?.id ?? ''}
                status={auth.status}
                t={t}
                onRegenerate={() => void auth.begin(method)}
              />
            </div>
          )}
        </div>
      )}

      {auth.error && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', marginTop: 8 }} data-testid="auth-error">
          {auth.error}
        </div>
      )}
    </section>
  );
}

function authMethodLabel(method: AuthMethod, t: (key: string) => string): string {
  if (method === 'portal-login') return t('portalLoginTab');
  if (method === 'device' || method === 'hybrid') return t('scanAuthTab');
  return t('scanTab');
}

export default ChannelAuth;
