/**
 * Accessible on/off switch for the channel row's enable lifecycle
 * (启动 / 停用).
 *
 * `@deepseek-ai/dsh-client-ui-primitives` does not export a Switch yet, so
 * this is a small business-local control that follows the harness's own
 * switch precedent (the trajectory toolbar's `role="switch"` button: track +
 * thumb, `aria-checked`, `--dsw-alias-state-business-primary` ON state) and
 * the `--dsw-*` token family — no dependency on internal packages (plan §8
 * "不依赖 ui-workspace 内部组件").
 *
 * The switch lives INSIDE the row's `role="button"` disclosure toggle, so it
 * stops propagation of click and Enter/Space keydown: toggling enable/disable
 * must never expand/collapse the row (same pattern as the official
 * `ProjectRowItem` action buttons calling `e.stopPropagation()`).
 */
const SWITCH_CSS_TAG = 'dsh-channels/switch.css';
if (typeof document !== 'undefined') {
  const existing = document.querySelector(`style[data-plugin-css="${SWITCH_CSS_TAG}"]`);
  if (!existing) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@wsz987/dsh-channels';
    tag.dataset.pluginCss = SWITCH_CSS_TAG;
    tag.textContent =
      '[data-channel-switch]:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:1px}';
    document.head.appendChild(tag);
  }
}

export interface SwitchProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  'aria-label'?: string;
  testId?: string;
}

export function Switch(props: SwitchProps) {
  const { checked, disabled, onChange } = props;
  const ariaLabel = props['aria-label'];
  const testId = props.testId;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      data-channel-switch
      data-testid={testId}
      onClick={(event) => {
        // The switch is a child of the row's disclosure toggle: never let the
        // click bubble into expand/collapse.
        event.stopPropagation();
        event.preventDefault();
        onChange(!checked);
      }}
      // Also swallow the raw pointer/mouse events so fast presses or a future
      // pointerdown-based handler on the row can never see them (full
      // click-through isolation).
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // The row's own Enter/Space handler must not see keys typed on the
        // switch (it would expand the row while toggling).
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        width: 32,
        height: 18,
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: 'transparent',
        border: 'none',
        borderRadius: 999,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span
        aria-hidden="true"
        data-on={checked || undefined}
        style={{
          boxSizing: 'border-box',
          position: 'relative',
          display: 'block',
          width: 32,
          height: 18,
          borderRadius: 999,
          background: checked ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)',
          transition: 'background-color 120ms ease',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: 2,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'var(--dsw-alias-bg-layer-1)',
            transition: 'transform 120ms ease',
            transform: checked ? 'translateX(14px)' : undefined,
          }}
        />
      </span>
    </button>
  );
}

export default Switch;
