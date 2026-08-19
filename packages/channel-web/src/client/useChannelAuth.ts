/**
 * `useChannelAuth` — the shared interactive-auth lifecycle for one expanded
 * channel (plan §11–§17, §39.4–§39.8).
 *
 * Hard requirements implemented here:
 *   - explicit user action: `begin()` is only ever called from a user click
 *     (red line W7); expanding a row never auto-begins auth (39.4)
 *   - poll loop is `setTimeout`-after-`await`, never `setInterval` (§14) and
 *     aborts the in-flight request before scheduling (AbortSignal, §16)
 *   - polling only while the session is pending AND the document is visible
 *     (§11/§13); hidden → pause (timer cleared, session kept), visible →
 *     immediate single poll then the normal interval resumes
 *   - terminal states (authenticated/expired/failed) stop the loop (39.8)
 *   - collapse/unmount/switch → abort in-flight HTTP + DELETE the auth session
 *     + clear the timer (§12)
 *   - prerequisite gating (§17.2): a method with registry-declared config
 *     prerequisites first persists any unsaved setup drafts
 *     (`applySetup` reconcile:false), re-fetches the setup descriptor and only
 *     then begins auth — all derived from `channelRegistry.ts` metadata, never
 *     a per-channel branch (red lines W1/W2)
 *
 * The hook is mounted inside the expanded DisclosureRow children, so it only
 * exists while the row is open (red line W6).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  beginAuth as apiBeginAuth,
  cancelAuth,
  fetchSetup,
  pollAuthSession,
  type AuthMethod,
  type ChannelSetupDescriptor,
  type PublicAuthSession,
  type PublicAuthStatus,
} from './api.js';
import {
  isSetupMethodAvailable,
  type ChannelWebDefinition,
} from './channelRegistry.js';

export interface UseChannelAuthOptions {
  channelId: string;
  web: ChannelWebDefinition;
  /** Latest setup descriptor (owned by the row; prerequisite gating input). */
  descriptor: ChannelSetupDescriptor | null;
  /** Whether the setup form holds drafts that should be persisted before auth. */
  hasUnsavedSetup: boolean;
  /**
   * Persist the current setup form WITHOUT reconciling the runtime
   * (`applySetup(..., { reconcile: false })`), so an auth flow can make
   * prerequisite config effective first.
   */
  saveSetup: () => Promise<void>;
  /** Event-driven refresh after a successful authorization. */
  onAuthorized?: () => void;
  t: (key: string) => string;
}

export interface UseChannelAuthResult {
  /** Whether an interactive auth session is currently being driven. */
  active: boolean;
  busy: boolean;
  session: PublicAuthSession | null;
  status: PublicAuthStatus | null;
  error: string | null;
  /** True when `method` may begin right now (prerequisites configured). */
  canBegin(method: AuthMethod): boolean;
  /** User action — begin the interactive auth flow for `method`. */
  begin(method: AuthMethod): Promise<void>;
  /** Cancel the active session and clear all state. */
  cancel(): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;
const TERMINAL_STATES: ReadonlySet<string> = new Set(['authenticated', 'expired', 'failed']);

export function useChannelAuth(options: UseChannelAuthOptions): UseChannelAuthResult {
  const { channelId, web, descriptor, hasUnsavedSetup, saveSetup, onAuthorized, t } = options;

  const [session, setSession] = useState<PublicAuthSession | null>(null);
  const [status, setStatus] = useState<PublicAuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sessionRef = useRef<PublicAuthSession | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const controllerRef = useRef<AbortController | null>(null);
  const onAuthorizedRef = useRef(onAuthorized);
  onAuthorizedRef.current = onAuthorized;

  const clearTimer = () => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };

  const intervalMs = () => sessionRef.current?.pollingIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // One poll cycle, then schedule the next via setTimeout (never setInterval).
  const pollOnce = useCallback(async () => {
    const current = sessionRef.current;
    // No session / terminal / hidden → the loop must not continue.
    if (!current || TERMINAL_STATES.has(current.state)) return;
    if (document.visibilityState !== 'visible') return;

    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const next = await pollAuthSession(channelId, current.id, controller.signal);
      if (controller.signal.aborted) return;
      setStatus(next);

      if (next.state === 'authenticated' || next.phase === 'authorized') {
        clearTimer();
        sessionRef.current = null;
        setSession(null);
        onAuthorizedRef.current?.();
        return;
      }
      if (TERMINAL_STATES.has(next.state)) {
        // expired / failed: stop polling, keep the status for the UI.
        clearTimer();
        return;
      }
      // Continue: wait `interval` AFTER the request settled (§14).
      clearTimer();
      timerRef.current = window.setTimeout(() => void pollOnce(), intervalMs());
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [channelId]);

  const cancel = useCallback(async () => {
    clearTimer();
    controllerRef.current?.abort();
    const active = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setStatus(null);
    if (active?.id) await cancelAuth(channelId, active.id).catch(() => {});
  }, [channelId]);

  // Pause while hidden, resume (immediate poll) when visible (§13, 39.7).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        const current = sessionRef.current;
        if (current && !TERMINAL_STATES.has(current.state)) void pollOnce();
      } else {
        clearTimer();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [pollOnce]);

  // Unmount / collapse / switch: abort HTTP, DELETE the auth session, clear
  // the timer (§12, 39.6).
  useEffect(() => {
    return () => {
      clearTimer();
      controllerRef.current?.abort();
      const active = sessionRef.current;
      if (active?.id) void cancelAuth(channelId, active.id).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const begin = useCallback(
    async (method: AuthMethod) => {
      if (busy) return;
      setError(null);
      setBusy(true);
      try {
        // §17.2 prerequisite flow: when the method needs setup fields configured
        // first, persist any unsaved drafts (reconcile:false), re-fetch the
        // descriptor and only continue once configured.
        if (descriptor && !isSetupMethodAvailable(web, method, descriptor)) {
          if (hasUnsavedSetup) await saveSetup();
          const fresh = await fetchSetup(channelId);
          if (!isSetupMethodAvailable(web, method, fresh)) {
            setError(t('authNeedsConfigFirst'));
            return;
          }
        }

        const previous = sessionRef.current;
        if (previous?.id) await cancelAuth(channelId, previous.id).catch(() => {});
        sessionRef.current = null;
        setSession(null);

        const next = await apiBeginAuth(channelId, method);
        sessionRef.current = next;
        setSession(next);
        setStatus({
          state: next.state,
          phase: next.phase,
          prompt: next.prompt,
          expiresAt: next.expiresAt,
        });
        if (next.state === 'authenticated' || next.phase === 'authorized') {
          clearTimer();
          sessionRef.current = null;
          setSession(null);
          onAuthorizedRef.current?.();
          return;
        }
        // Kick off the poll loop for the pending session.
        void pollOnce();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy, channelId, web, descriptor, hasUnsavedSetup, saveSetup, t, pollOnce],
  );

  const canBegin = useCallback(
    (method: AuthMethod): boolean => {
      if (!descriptor) return false;
      return isSetupMethodAvailable(web, method, descriptor);
    },
    [web, descriptor],
  );

  return {
    active: session !== null,
    busy,
    session,
    status,
    error,
    canBegin,
    begin,
    cancel,
  };
}
