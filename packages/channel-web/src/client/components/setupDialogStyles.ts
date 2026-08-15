/**
 * Collapse the primitives Modal body's default 20px top margin for the channel
 * setup dialog. The Modal's body region ships `margin-top: 20px` inside a
 * hashed CSS-module class; we scope the dialog via contentClassName and drop
 * the margin with a one-time injected stylesheet since the body is always the
 * last child of that `.content` container.
 */
const CSS_ID = '@wsz987/channel-web/SetupDialog';
const CSS = '.dsc-setup-dialog > :last-child { margin-top: 0; }';

export function injectSetupDialogStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) return;
  const tag = document.createElement('style');
  tag.dataset.pluginCss = CSS_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
