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

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    ctx.locale.register('channels', locales as Record<string, Record<string, string>>);
  }, 'channel-web: locales');

  const t = ctx.locale.bind('channels');

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