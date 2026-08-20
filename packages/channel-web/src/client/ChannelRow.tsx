/**
 * One channel row in the Channels directory (plan §8, §9, §25).
 *
 * The disclosure interaction mirrors the Harness Workspace sidebar
 * `ProjectRowItem` (ui-workspace internal): a compact tree row that toggles on
 * whole-row click — brand icon, chevron that rotates 90° when open,
 * `role="button"` + `aria-expanded`, Enter/Space keyboard support. We do NOT
 * depend on `ui-workspace` internals nor on `DisclosureRow` (its layout
 * semantics target Reasoning/Tool-call rows); `ChannelRow` is the channel-web
 * business composition, built on official primitives (`IconTriangleRightFill14`,
 * `StateDot`) + the local `Switch` and `--dsw-*` tokens (plan §31).
 *
 * Exactly one channel is expanded at a time (`openChannelId` in
 * ChannelsSection); the expanded body renders only while `open`, so a collapsed
 * row issues 0 setup / 0 auth / 0 access requests (red line W6).
 *
 * The row owns the shared setup descriptor + draft state (so the Auth section
 * can gate its begin button on the same descriptor — plan §17.2) and the
 * enable/disable lifecycle, exposed as a direct 启动/停用 Switch on the
 * collapsed row (clicking it must not expand the row).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { IconTriangleRightFill14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  applySetup,
  fetchSetup,
  setChannelEnabled,
  type ChannelSetupDescriptor,
  type ChannelSummary,
} from './api.js';
import { channelWebTitle, type ChannelWebDefinition } from './channelRegistry.js';
import { ChannelBrandIcon } from './components/ChannelBrandIcon.js';
import { Switch } from './components/Switch.js';
import { ChannelSetup } from './ChannelSetup.js';
import { ChannelAuth } from './ChannelAuth.js';
import { ChannelAccess } from './ChannelAccess.js';

/**
 * Row-level hover background via a real CSS `:hover` rule. The official
 * primitives ship with stub CSS modules in plugin bundles, so row chrome is
 * ours — injected once through the same `data-plugin-css` mechanism the
 * official client bundles use. A React-state `:hover` simulation was flaky
 * (highlight could land on the wrong row); pure CSS cannot.
 */
const CHANNEL_ROW_CSS_TAG = 'dsh-channels/channel-row.css';
if (typeof document !== 'undefined') {
  const existing = document.querySelector(`style[data-plugin-css="${CHANNEL_ROW_CSS_TAG}"]`);
  if (!existing) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@wsz987/dsh-channels';
    tag.dataset.pluginCss = CHANNEL_ROW_CSS_TAG;
    tag.textContent =
      '[data-channel-row-toggle]{border-radius:8px}' +
      '[data-channel-row-toggle]:hover{background:var(--dsw-alias-interactive-bg-hover)}';
    document.head.appendChild(tag);
  }
}

export interface ChannelRowProps {
  channel: ChannelSummary;
  web: ChannelWebDefinition;
  open: boolean;
  onToggle: () => void;
  t: (key: string) => string;
  /** Event-driven refresh after enable/disable, setup save or auth success. */
  onChanged: () => void;
}

export function ChannelRow(props: ChannelRowProps) {
  const { channel, web, open, onToggle, t, onChanged } = props;

  // Shared setup state: fetched once per expansion, fed to both the setup form
  // and the auth prerequisite gate.
  const [descriptor, setDescriptor] = useState<ChannelSetupDescriptor | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [edited, setEdited] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const setupController = useRef<AbortController | null>(null);

  const loadSetup = useCallback(() => {
    setupController.current?.abort();
    const controller = new AbortController();
    setupController.current = controller;
    fetchSetup(channel.id, controller.signal)
      .then((setup) => {
        if (controller.signal.aborted) return;
        setDescriptor(setup);
        setSetupLoading(false);
        setSetupError(null);
        setDrafts(() => {
          const seed: Record<string, string> = {};
          for (const field of setup.fields) {
            if (!field.secret && field.value) seed[field.name] = field.value;
          }
          return seed;
        });
        setEdited(new Set());
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setSetupLoading(false);
        setSetupError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [channel.id]);

  // Fetch the descriptor whenever the row is opened (W6: only expanded rows).
  useEffect(() => {
    if (!open) return;
    setSetupLoading(true);
    loadSetup();
    return () => setupController.current?.abort();
  }, [open, loadSetup]);

  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // Keys typed while the enable/disable switch is focused belong to the
    // switch (it stops its own propagation too); never expand from those.
    if ((event.target as HTMLElement).closest?.('[data-channel-switch]')) return;
    event.preventDefault();
    onToggle();
  };

  const toggleEnabled = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await setChannelEnabled(channel.id, !channel.enabled);
      onChanged();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // Compute the effective config/credentials patch for changed draft fields.
  // A secret field counts as changed when EDITED — including a cleared (empty)
  // draft, which becomes an empty credential value meaning "clear that
  // credential". Untouched fields are skipped so configured values persist.
  const buildPatch = (setup: ChannelSetupDescriptor) => {
    const config: Record<string, unknown> = {};
    const credentials: Record<string, string> = {};
    for (const field of setup.fields) {
      if (!edited.has(field.name)) continue;
      const value = (drafts[field.name] ?? '').trim();
      if (field.secret) credentials[field.name] = value;
      else config[field.name] = value;
    }
    return { config, credentials };
  };

  // §17.2: persist unsaved drafts WITHOUT reconciling the runtime, then refresh
  // the descriptor so the auth gate reflects the saved state.
  const saveSetupForAuth = async () => {
    if (!descriptor) return;
    const { config, credentials } = buildPatch(descriptor);
    await applySetup(channel.id, { config, credentials, reconcile: false });
    await loadSetup();
  };

  const hasUnsavedSetup = descriptor
    ? descriptor.fields.some((field) => edited.has(field.name))
    : false;

  const handleSetupSaved = () => {
    loadSetup();
    onChanged();
  };

  const accent = web.accent ?? 'var(--dsw-alias-label-tertiary)';

  return (
    <div
      style={{ borderBottom: '1px solid var(--dsw-alias-border-l1)' }}
      data-testid={'channel-row-' + channel.id}
      data-channel-enabled={channel.enabled}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={toggleFromKeyboard}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 36,
          padding: '0 8px',
          cursor: 'pointer',
          userSelect: 'none',
          color: 'var(--dsw-alias-label-primary)',
        }}
        data-testid="channel-row-toggle"
        data-channel-row-toggle
      >
        {/* Expanding caret sits LEFT of the brand icon, like a standard tree
            row (plan §8): ▸ [icon] title ... */}
        <span
          style={{
            flex: 'none',
            display: 'inline-flex',
            color: 'var(--dsw-alias-label-tertiary)',
            transition: 'transform 150ms ease',
            transform: open ? 'rotate(90deg)' : undefined,
          }}
        >
          <IconTriangleRightFill14 size={14} />
        </span>

        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            flex: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: accent + '1f',
          }}
        >
          <ChannelBrandIcon channelId={channel.id} size={16} />
        </span>

        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 14,
            lineHeight: '20px',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          {channelWebTitle(web, t)}
        </span>

        <span
          style={{
            flex: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--dsw-alias-label-secondary)',
          }}
          data-testid="channel-collapsed-status"
        >
          <StateDot state={collapsedDot(channel)} size={8} />
          <span>{collapsedLabel(channel, t)}</span>
          {accessWarning(channel, t) && (
            <span
              style={{
                color: 'var(--dsw-alias-state-warn-primary)',
                whiteSpace: 'nowrap',
              }}
              data-testid="channel-access-warning"
            >
              {accessWarning(channel, t)}
            </span>
          )}
        </span>

        {/* 启动 / 停用 — a direct switch on the collapsed row, replacing the
            old "高级操作" button. Clicking it must not expand the row (the
            Switch stops propagation). */}
        <span
          style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', marginLeft: 2 }}
        >
          <Switch
            checked={channel.enabled}
            disabled={busy}
            onChange={() => void toggleEnabled()}
            aria-label={channel.enabled ? t('disableChannel') : t('enableChannel')}
            testId={'channel-switch-' + channel.id}
          />
        </span>
      </div>

      {open && (
        <div
          style={{
            padding: '16px 4px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
          }}
          data-testid="channel-row-body"
        >
          <ChannelSetup
            channel={channel}
            web={web}
            descriptor={descriptor}
            loading={setupLoading}
            loadError={setupError}
            drafts={drafts}
            edited={edited}
            onDraftsChange={setDrafts}
            onEditedChange={setEdited}
            t={t}
            onSaved={handleSetupSaved}
          />

          <ChannelAuth
            channel={channel}
            web={web}
            descriptor={descriptor}
            hasUnsavedSetup={hasUnsavedSetup}
            saveSetup={saveSetupForAuth}
            onAuthorized={onChanged}
            t={t}
          />

          <ChannelAccess channel={channel} web={web} t={t} onChanged={onChanged} />
        </div>
      )}

      {/* Enable/disable failures surface directly under the row so they stay
          visible even while the row is collapsed (the switch lives on the
          collapsed row now, not inside the expanded body). */}
      {actionError && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--dsw-alias-state-error-primary)',
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 8,
            padding: '8px 10px',
            margin: '0 8px 8px',
          }}
          data-testid="row-action-error"
        >
          {actionError}
        </div>
      )}
    </div>
  );
}

/** Trailing summary on the collapsed row: connection dot + configuration state. */
function collapsedLabel(channel: ChannelSummary, t: (key: string) => string): string {
  if (channel.runtime === 'running' && channel.connection === 'connected') return t('statusConnected');
  return channel.configured ? t('configured') : t('notConfigured');
}

function collapsedDot(channel: ChannelSummary): 'done' | 'ongoing' | 'error' {
  if (channel.runtime === 'running' && channel.connection === 'connected') return 'done';
  if (channel.enabled && channel.runtime === 'running' && channel.connection === 'disconnected') return 'error';
  return 'ongoing';
}

/**
 * Surface access-readiness trouble on the collapsed row (plan §28) so the
 * operator can see why inbound is gated before expanding the row. Empty string
 * when nothing is wrong.
 */
function accessWarning(channel: ChannelSummary, t: (key: string) => string): string {
  switch (channel.access) {
    case 'needs-owner':
      return t('readinessNeedsOwner');
    case 'missing-policy':
      return t('readinessMissingPolicy');
    case 'invalid-policy':
      return t('readinessInvalidPolicy');
    default:
      return '';
  }
}

export default ChannelRow;
