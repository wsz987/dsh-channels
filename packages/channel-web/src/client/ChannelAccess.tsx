/**
 * Inline "安全访问 / Secure access" section for one expanded channel (plan
 * §37–§41).
 *
 * This is the access-control ACL editor: owner status + owner-claim flow, the
 * independent DM and named-group controls. It stays
 * DELIBERATELY separate from platform permissions and never touches the Agent
 * model. The Web UI does not infer or display platform authorization status.
 *
 * Rendered only while the row is open (no collapsed-row access request, red
 * line W6). The only polling is a LOCAL ~2s loop while an owner-claim session
 * is waiting for a candidate — there is no page-level polling (W8). Weixin
 * (`ownerDiscovery === 'account'`) needs no claim: the owner is auto-identified
 * and group controls are hidden (`descriptor.groups === false`).
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  beginOwnerClaim,
  cancelOwnerClaim,
  confirmOwnerClaim,
  fetchAccess,
  fetchOwnerClaim,
  saveAccess,
  type ChannelAccessPolicy,
  type ChannelAccessState,
  type ChannelSummary,
  type PublicOwnerClaimSession,
} from './api.js';
import {
  directMessageAccessMode,
  groupAccessMode,
  hasEditableAccessControls,
  isDirectMessageAccessEditable,
  prepareAccessPolicyForSave,
  withDirectMessageAccessMode,
  withGroupAccessMode,
  type DirectMessageAccessMode,
  type GroupAccessMode,
} from './accessPolicyUi.js';
import { type ChannelWebDefinition } from './channelRegistry.js';
import { AccessWarning } from './components/AccessWarning.js';
import { GroupAccessCard } from './components/GroupAccessCard.js';
import { IdentityListEditor } from './components/IdentityListEditor.js';
import { SectionHeading } from './components/SectionHeading.js';

export interface ChannelAccessProps {
  channel: ChannelSummary;
  web: ChannelWebDefinition;
  t: (key: string) => string;
  onChanged: () => void;
}

/** A pristine, blank custom policy used the first time there is no saved one. */
function blankPolicy(ownerId?: string): ChannelAccessPolicy {
  return {
    version: 1,
    preset: 'owner-only',
    ownerId,
    dmPolicy: 'allowlist',
    allowFrom: ownerId ? [ownerId] : [],
    groupPolicy: 'disabled',
    groups: {},
  };
}

export function ChannelAccess({ channel, web, t, onChanged }: ChannelAccessProps) {
  const [state, setState] = useState<ChannelAccessState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Draft policy being edited (mirrors the saved state until the user edits).
  const [draft, setDraft] = useState<ChannelAccessPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  // Owner-claim flow.
  const [claim, setClaim] = useState<PublicOwnerClaimSession | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimBusy, setClaimBusy] = useState(false);

  // Add-group input (local to this section).
  const [groupDraft, setGroupDraft] = useState('');

  const controller = useRef<AbortController | null>(null);

  const load = () => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    fetchAccess(channel.id, c.signal)
      .then((next) => {
        if (c.signal.aborted) return;
        setState(next);
        setLoadError(null);
        // (Re)seed the draft only when it was never initialized or the saved
        // policy is entirely absent — preserve any in-progress edits otherwise.
        setDraft((current) => current ?? next.policy ?? blankPolicy(next.owner.id));
      })
      .catch((cause) => {
        if (c.signal.aborted) return;
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  useEffect(() => {
    load();
    return () => controller.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  // Poll the claim ~2s while it is waiting for a candidate message. This is a
  // LOCAL loop gated to an active claim in this already-expanded row — no
  // page-level polling. It MUST be declared before the early return below: if
  // a hook sits after `if (!state) return`, the first render calls fewer hooks
  // than later renders and React throws #310 ("more hooks than previous").
  useEffect(() => {
    if (!claim || claim.phase !== 'waiting-message') return;
    const timer = setInterval(async () => {
      try {
        const next = await fetchOwnerClaim(channel.id, claim.id);
        setClaim(next);
        if (next.phase === 'candidate') {
          clearInterval(timer);
        }
      } catch {
        // transient poll failure: keep waiting unless it cannot be re-polled
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [claim, channel.id]);

  if (loadError || !state || !draft) {
    return (
      <section aria-label={t('accessSection')} data-testid="channel-access">
        <SectionHeading title={t('accessSection')} />
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>{loadError ?? '…'}</div>
      </section>
    );
  }

  const descriptor = state.descriptor;
  const isAccountDiscovery = descriptor.ownerDiscovery === 'account';
  const dmAccessEditable = isDirectMessageAccessEditable(descriptor.ownerDiscovery);
  const accessControlsEditable = hasEditableAccessControls(descriptor.ownerDiscovery, descriptor.groups);

  const ownerId = draft.ownerId ?? state.owner.id;
  const ownerIdentified = state.owner.configured || Boolean(ownerId);

  const dmAccess = directMessageAccessMode(draft, ownerId);
  const groupAccess = groupAccessMode(draft);
  const ownerRequiredBeforeSave = dmAccess === 'owner-only' && !ownerId;
  const policyForSave = (): ChannelAccessPolicy => prepareAccessPolicyForSave(draft, ownerId);

  const submit = async () => {
    setSaving(true);
    setActionError(null);
    setSavedNotice(null);
    try {
      const candidate = policyForSave();
      const saved = await saveAccess(channel.id, candidate);
      setState(saved);
      setDraft(saved.policy ?? candidate);
      setSavedNotice(t('accessSaved'));
      onChanged();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  // ---- owner claim flow -----------------------------------------------------

  const startClaim = async () => {
    setClaimBusy(true);
    setClaimError(null);
    setClaim(null);
    try {
      const session = await beginOwnerClaim(channel.id);
      setClaim(session);
    } catch (cause) {
      setClaimError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClaimBusy(false);
    }
  };

  const confirmClaim = async () => {
    if (!claim?.candidate) {
      setActionError(t('confirmBeforeCandidateError'));
      return;
    }
    setClaimBusy(true);
    setActionError(null);
    try {
      const next = await confirmOwnerClaim(channel.id, claim.id);
      setState(next);
      setDraft(next.policy ?? blankPolicy(next.owner.id));
      setClaim({ ...claim, phase: 'confirmed' });
      onChanged();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClaimBusy(false);
    }
  };

  const cancelFlow = async () => {
    if (!claim) return;
    try {
      await cancelOwnerClaim(channel.id, claim.id);
    } finally {
      setClaim(null);
    }
  };

  const setDmAccess = (mode: DirectMessageAccessMode) => {
    setDraft((current) => (current ? withDirectMessageAccessMode(current, mode, ownerId) : current));
  };

  const addGroup = () => {
    const id = groupDraft.trim();
    if (!id) return;
    setDraft((current) => {
      if (!current) return current;
      if (current.groups[id]) return current;
      return {
        ...current,
        groupPolicy: 'allowlist',
        groups: {
          ...current.groups,
          [id]: {
            enabled: true,
            senderPolicy: 'allowlist',
            allowFrom: ownerId ? [ownerId] : [],
            requireMention: false,
          },
        },
      };
    });
    setGroupDraft('');
  };

  return (
    <section aria-label={t('accessSection')} data-testid="channel-access">
      <SectionHeading title={t('accessSection')} />

      {/* ---- readiness / security banners (plan §28) ---- */}
      {state.readiness === 'needs-owner' && (
        <div style={{ marginBottom: 12 }}>
          <AccessWarning testId="access-needs-owner">{t('readinessNeedsOwner')}</AccessWarning>
        </div>
      )}
      {state.readiness === 'missing-policy' && (
        <div style={{ marginBottom: 12 }}>
          <AccessWarning testId="access-missing-policy">{t('readinessMissingPolicy')}</AccessWarning>
        </div>
      )}
      {state.readiness === 'invalid-policy' && (
        <div style={{ marginBottom: 12 }}>
          <AccessWarning testId="access-invalid-policy">{t('readinessInvalidPolicy')}</AccessWarning>
        </div>
      )}

      {/* ---- owner area (plan §38) ---- */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }} data-testid="access-owner">
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('ownerSection')}</span>
        {isAccountDiscovery ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary)' }} data-testid="owner-status-account">
              {ownerIdentified ? t('ownerIdentified') : t('ownerAutoIdentified')}
            </div>
            {ownerId && (
              <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }} data-testid="owner-id">
                {ownerId}
              </div>
            )}
          </div>
        ) : ownerIdentified ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary)' }} data-testid="owner-status-confirmed">
              {t('ownerIdentified')}
            </div>
            {ownerId && (
              <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }} data-testid="owner-id">
                {ownerId}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' }} data-testid="owner-unidentified">
              {t('ownerNotIdentified')}
            </div>
            <Button variant="outline" size="sm" onClick={() => void startClaim()} disabled={claimBusy} data-testid="owner-claim-begin">
              {t('identifyMyAccount')}
            </Button>
          </div>
        )}

        {claim && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 8,
              padding: 10,
            }}
            data-testid="owner-claim-flow"
          >
            {claim.challengeCode && claim.phase === 'waiting-message' && (
              <>
                <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>{t('claimInstruction')}</div>
                <code
                  data-testid="claim-challenge"
                  style={{
                    fontSize: 13,
                    background: 'var(--dsw-alias-bg-layer-1)',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    borderRadius: 6,
                    padding: '6px 10px',
                    fontFamily: 'ui-monospace, monospace',
                    color: 'var(--dsw-alias-label-primary)',
                    width: 'fit-content',
                  }}
                >
                  /dsh-claim {claim.challengeCode}
                </code>
                <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }} data-testid="claim-waiting">
                  {t('waitingForMessage')}
                </div>
              </>
            )}
            {claim.phase === 'candidate' && claim.candidate && (
              <>
                <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
                  {t('detectedCandidatePrefix')} <strong data-testid="claim-sender">{claim.candidate.senderId}</strong>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button variant="primary" size="sm" onClick={() => void confirmClaim()} disabled={claimBusy} data-testid="claim-confirm">
                    {t('confirmIsMe')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void cancelFlow()} data-testid="claim-cancel">
                    {t('cancel')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
        {claimError && (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }} data-testid="claim-error">
            {claimError}
          </div>
        )}
      </div>

      {/* ---- DM controls (plan §39) ---- */}
      {!isAccountDiscovery || descriptor.directMessages ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }} data-testid="access-dm">
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('dmSection')}</span>
          {!dmAccessEditable ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                color: 'var(--dsw-alias-label-primary)',
              }}
              data-testid="dm-owner-only-fixed"
            >
              <span style={{ color: 'var(--dsw-alias-state-success-primary)' }}>✓</span>
              {t('dmOwnerOnly')}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }} data-testid="dm-access-mode">
                {(
                  [
                    ['disabled', t('dmDisabled')],
                    ['owner-only', t('dmOwnerOnly')],
                    ['allowlist', t('dmAllowlist')],
                    ['open', t('dmOpen')],
                  ] as Array<[DirectMessageAccessMode, string]>
                ).map(([value, label]) => {
                  return (
                    <label
                      key={value}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 13,
                        cursor: 'pointer',
                        color:
                          value === 'open'
                            ? 'var(--dsw-alias-state-warn-primary)'
                            : 'var(--dsw-alias-label-primary)',
                      }}
                    >
                      <input
                        type="radio"
                        name="dm-access-mode"
                        checked={dmAccess === value}
                        onChange={() => setDmAccess(value)}
                        data-testid={'dm-' + value}
                      />
                      {label}
                    </label>
                  );
                })}
              </div>
              {dmAccess === 'allowlist' && (
                <IdentityListEditor
                  ids={draft.allowFrom}
                  onChange={(ids) => setDraft((c) => (c ? { ...c, preset: 'custom', allowFrom: ids } : c))}
                  label={t('allowUsers')}
                  t={t}
                />
              )}
              {dmAccess === 'open' && (
                <AccessWarning testId="dm-open-danger">{t('dmOpenDanger')}</AccessWarning>
              )}
            </>
          )}
        </div>
      ) : null}

      {/* ---- group controls (plan §40) — only when the channel supports them ---- */}
      {descriptor.groups === true ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }} data-testid="access-groups">
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('groupSection')}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }} data-testid="group-access-mode">
            {(
              [
                ['disabled', t('groupDisabled')],
                ['allowlist', t('groupSpecified')],
                ['open', t('groupAllDanger')],
              ] as Array<[GroupAccessMode, string]>
            ).map(([value, label]) => (
              <label
                key={value}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 13,
                  cursor: 'pointer',
                  color: value === 'open'
                    ? 'var(--dsw-alias-state-warn-primary)'
                    : 'var(--dsw-alias-label-primary)',
                }}
              >
                <input
                  type="radio"
                  name="group-access-mode"
                  checked={groupAccess === value}
                  onChange={() => setDraft((c) => c
                    ? withGroupAccessMode(c, value, ownerId, descriptor.defaults?.requireMention === true)
                    : c)}
                  data-testid={'group-' + value}
                />
                {label}
              </label>
            ))}
          </div>

          {draft.groupPolicy === 'allowlist' && (
            <>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  value={groupDraft}
                  placeholder={t('groupIdPlaceholder')}
                  onChange={(e) => setGroupDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addGroup();
                  }}
                  data-testid="group-add-input"
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
                <Button variant="outline" size="sm" onClick={addGroup} disabled={!groupDraft.trim()} data-testid="group-add">
                  {t('addGroup')}
                </Button>
              </div>

              {Object.entries(draft.groups).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {Object.entries(draft.groups).map(([groupId, rule]) => (
                    <GroupAccessCard
                      key={groupId}
                      groupId={groupId}
                      rule={rule}
                      ownerId={ownerId}
                      mentions={descriptor.mentions === true}
                      userLabel={descriptor.identityLabels.user}
                      onChange={(next) =>
                        setDraft((c) => (c ? { ...c, groups: { ...c.groups, [groupId]: next } } : c))
                      }
                      onRemove={() =>
                        setDraft((c) => {
                          if (!c) return c;
                          const groups = { ...c.groups };
                          delete groups[groupId];
                          return { ...c, groups, groupPolicy: Object.keys(groups).length ? 'allowlist' : 'disabled' };
                        })
                      }
                      t={t}
                    />
                  ))}
                </div>
              )}
            </>
          )}
          {draft.groupPolicy === 'open' && draft.defaultGroupRule && (
            <>
              <AccessWarning testId="all-groups-danger">{t('groupAllDangerHint')}</AccessWarning>
              <GroupAccessCard
                groupId={t('allGroups')}
                rule={draft.defaultGroupRule}
                ownerId={ownerId}
                mentions={descriptor.mentions === true}
                userLabel={descriptor.identityLabels.user}
                onChange={(next) => setDraft((c) => c ? { ...c, defaultGroupRule: next } : c)}
                fixedEnabled
                t={t}
              />
            </>
          )}
        </div>
      ) : dmAccessEditable ? (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 16 }} data-testid="access-no-groups">
          {t('noGroupSupport')}
        </div>
      ) : null}

      {/* ---- save ---- */}
      {accessControlsEditable && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <Button variant="primary" size="sm" onClick={() => void submit()} disabled={saving || ownerRequiredBeforeSave} data-testid="access-save">
            {saving ? t('saving') : t('saveAccess')}
          </Button>
          {savedNotice && (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' }} data-testid="access-saved">
              {savedNotice}
            </div>
          )}
          {actionError && (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }} data-testid="access-error">
              {actionError}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default ChannelAccess;
