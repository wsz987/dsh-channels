/**
 * ConversationPicker — add an already discovered group to the policy.
 *
 * For channels whose descriptor declares
 * `identity.conversation.conversationDiscoverable` (QQ), the picker lists the
 * canonical identities the conversation directory observed. QQ's platform
 * payload does not reliably provide a human QQ group number, so there is no
 * manual input or identifier guessing path.
 *
 * This component only ever handles directory DTOs: the canonical id saved into
 * the policy comes from the control plane, never typed here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { fetchConversations, type PublicConversationIdentity } from '../api.js';

/** Short debug form of an opaque canonical id (e.g. `04E…A91`). */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

/**
 * Display title for one conversation identity (plan §37 order): alias →
 * displayName → `${groupLabel} ${externalId}` → undefined (caller falls back
 * to the short canonical id).
 */
export function conversationTitle(
  identity: PublicConversationIdentity,
  groupLabel: string,
): string | undefined {
  return (
    identity.alias ??
    identity.displayName ??
    (identity.externalId ? `${groupLabel} ${identity.externalId}` : undefined)
  );
}

export interface ConversationPickerProps {
  channelId: string;
  /** Label for a group (e.g. 'QQ群'), used as the display fallback prefix. */
  groupLabel: string;
  /** Canonical ids already present in the draft policy. */
  addedIds: string[];
  /** Called with the RESOLVED canonical id to add to the policy. */
  onAdd: (canonicalId: string) => void;
  t: (key: string) => string;
}

export function ConversationPicker({
  channelId,
  groupLabel,
  addedIds,
  onAdd,
  t,
}: ConversationPickerProps) {
  const [conversations, setConversations] = useState<PublicConversationIdentity[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    fetchConversations(channelId, c.signal)
      .then((next) => {
        if (c.signal.aborted) return;
        setConversations(next);
        setLoadFailed(false);
      })
      .catch((cause) => {
        if (c.signal.aborted) return;
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLoadFailed(true);
      });
  }, [channelId]);

  useEffect(() => {
    load();
    return () => controller.current?.abort();
  }, [load]);

  const discovered = (conversations ?? []).filter(
    (identity) => !addedIds.includes(identity.canonicalId),
  );

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      data-testid="conversation-picker"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
          {t('conversationDiscovered')}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          data-testid="conversation-refresh"
        >
          {t('conversationRefresh')}
        </Button>
      </div>

      {loadFailed ? (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>
          {t('connectionError')}
        </div>
      ) : conversations !== null && discovered.length === 0 ? (
        <div
          style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}
          data-testid="conversation-empty"
        >
          {t('conversationEmpty')
            .replace('{groupLabel}', groupLabel)}
        </div>
      ) : (
        conversations && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="conversation-list">
            {discovered.map((identity) => {
              const title = conversationTitle(identity, groupLabel) ?? `${groupLabel} OpenID`;
              return (
                <div
                  key={identity.canonicalId}
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  data-testid="conversation-row"
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      title={identity.canonicalId}
                      style={{
                        fontSize: 13,
                        color: 'var(--dsw-alias-label-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {title}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
                      OpenID: {identity.canonicalId}
                    </div>
                    {identity.identityConflict && (
                      <div
                        style={{ fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' }}
                        data-testid="conversation-conflict"
                      >
                        {t('conversationIdentityConflict')}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onAdd(identity.canonicalId)}
                    data-testid="conversation-add"
                  >
                    {t('conversationAdd')}
                  </Button>
                </div>
              );
            })}
          </div>
        )
      )}

    </div>
  );
}

export default ConversationPicker;
