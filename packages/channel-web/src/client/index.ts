/**
 * @wsz987/channel-web — Web client plugin entry.
 *
 * This file is bundled by esbuild into lib/client.js and wrapped in the
 * Harness `window.__ModuleLoader__.load({ id, factory })` format. It registers
 * the "渠道" Settings section via the settings.section slot and the
 * 'channels' locale namespace.
 *
 * rc.2 client module graph notes: React, react/jsx-runtime and
 * @deepseek-ai/dsh-client-ui-primitives are static shell identities
 * (PLATFORM_MODULES seeds compiled into the Vite shell), so the bundle keeps
 * them as require() externals instead of inlining them. The dynamic client
 * dependency of this entry is declared in package.json `dsh.client.inject`
 * (currently @deepseek-ai/dsh-client-locale, provider of the "locale"
 * service); the plugin context itself is described by LOCAL structural
 * interfaces — we deliberately do NOT import any @deepseek-ai/dsh-client-*
 * runtime or type package here.
 */
import { ChannelsSection } from './ChannelsSection.js';
import { locales } from './locales.js';

export const name = 'channel-web';

/** Loader-level services this client fibre depends on. */
export const inject = ['slots', 'locale'];

type Translate = (key: string) => string;

interface LocaleContext {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown;
  bind(namespace: string): Translate;
}

interface SlotOptions {
  name: string;
  id: string;
  order?: number;
  label?: string | (() => string);
  locale?: string;
  [key: string]: unknown;
}

interface SlotsContext {
  register(options: SlotOptions, component: unknown): unknown;
  inject(name: string, renderer: () => unknown): unknown;
}

interface EffectContext {
  effect(callback: () => unknown, label?: string): unknown;
}

type ClientContext = EffectContext & {
  locale: LocaleContext;
  slots: SlotsContext;
};

const linkIconPaths = [
  'M10 13a5 5 0 0 0 7.07.07l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
  'M14 11a5 5 0 0 0-7.07-.07l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
];

/**
 * The current Harness settings slot exposes a section label but not a nav
 * icon. Replace only this section's fallback gear after the host renders it.
 */
function installChannelsNavIcon(label: () => string): (() => void) | undefined {
  if (typeof document === 'undefined') return undefined;

  const replaceFallbackIcon = () => {
    const navItem = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === label());
    const previousIcon = navItem?.querySelector('svg');
    if (!previousIcon || previousIcon.dataset.channelNavIcon === 'link') return;

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.dataset.channelNavIcon = 'link';
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('height', '16');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('stroke-width', '2');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', '16');
    icon.setAttribute('class', previousIcon.getAttribute('class') ?? '');
    for (const d of linkIconPaths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      icon.append(path);
    }
    previousIcon.replaceWith(icon);
  };

  const observer = new MutationObserver(replaceFallbackIcon);
  observer.observe(document.body, { childList: true, subtree: true });
  replaceFallbackIcon();
  return () => observer.disconnect();
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    ctx.locale.register('channels', locales as Record<string, Record<string, string>>);
  }, 'channel-web: locales');

  const t = ctx.locale.bind('channels');

  ctx.effect(() => installChannelsNavIcon(() => t('nav')), 'channel-web: channels nav icon');

  // Give the section a translator so its body text follows the active locale.
  const Section = function Section(props: Record<string, unknown>) {
    return ChannelsSection({ ...(props as object), __t: t });
  };

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'channels',
        order: 60,
        label: () => t('nav'),
        locale: 'channels',
      },
      Section,
    );
  });
}
