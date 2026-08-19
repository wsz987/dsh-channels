/**
 * Web presentation metadata for channels — the ONLY place platform UI/UX
 * differences may live (refactor plan §5; red lines W1/W2).
 *
 * This is NOT business logic: the channel list itself comes from the host
 * `GET /channels`; this module only adds display metadata (title copy keys,
 * ordering, accent, field labels, auth prerequisites, permissions, docs links).
 * Unknown future channels fall back to [createGenericChannelWebDefinition]
 * instead of crashing (plan §7).
 *
 * The small pure helpers at the bottom are the generic replacement for the old
 * `authSetup.ts` platform branches (plan §18): every decision is derived from
 * registry metadata, never from a `channelId === 'lark'` check.
 */
import type { AuthMethod, ChannelSetupDescriptor } from './api.js';

export interface ChannelPermissionItem {
  id: string;
  /** Locale key for the permission copy. */
  labelKey: string;
  required: boolean;
}

export interface ChannelWebDefinition {
  id: string;
  /** Stable sort order in the directory (lower first). */
  order: number;

  /** Locale key for the display name. */
  titleKey: string;
  /** Optional one-line description shown under the title (not yet surfaced). */
  descriptionKey?: string;
  /** Locale key for the setup intro copy. */
  introKey?: string;

  /** Brand accent color (used as a subtle tint behind the brand logo). */
  accent?: string;

  /** Override labels for setup fields (name → locale key). */
  fieldLabels?: Record<string, string>;

  /**
   * Auth methods that may only begin once the listed setup fields are
   * configured. e.g. Lark `hybrid: ['appId', 'appSecret']`.
   */
  authRequiresConfigured?: Partial<Record<AuthMethod, string[]>>;

  /** Static platform permission requirements + official docs link. */
  permissions?: {
    docsUrl?: string;
    items: ChannelPermissionItem[];
  };
}

/**
 * Built-in channel web metadata. Presentation only — the set of channels the
 * UI actually renders comes from the host directory.
 */
export const CHANNEL_WEB: Record<string, ChannelWebDefinition> = {
  weixin: {
    id: 'weixin',
    order: 10,
    titleKey: 'channelWeixin',
    accent: '#07c160',
    permissions: {
      docsUrl: 'https://channels.weixin.qq.com/',
      items: [
        { id: 'message.receive', labelKey: 'permissionMessageReceive', required: true },
        { id: 'message.send', labelKey: 'permissionMessageSend', required: true },
      ],
    },
  },

  qq: {
    id: 'qq',
    order: 20,
    titleKey: 'channelQq',
    introKey: 'setupIntro',
    permissions: {
      docsUrl: 'https://q.qq.com/qqbot/',
      items: [
        { id: 'message.receive', labelKey: 'permissionMessageReceive', required: true },
        { id: 'message.send', labelKey: 'permissionMessageSend', required: true },
      ],
    },
  },

  dingtalk: {
    id: 'dingtalk',
    order: 30,
    titleKey: 'channelDingtalk',
    introKey: 'setupIntroDingtalk',
    permissions: {
      docsUrl: 'https://open.dingtalk.com/document/',
      items: [
        { id: 'message.receive', labelKey: 'permissionMessageReceive', required: true },
        { id: 'message.send', labelKey: 'permissionMessageSend', required: true },
      ],
    },
  },

  lark: {
    id: 'lark',
    order: 40,
    titleKey: 'channelLark',
    introKey: 'setupIntroLark',

    authRequiresConfigured: {
      hybrid: ['appId', 'appSecret'],
    },

    permissions: {
      docsUrl: 'https://open.feishu.cn/document/',
      items: [
        { id: 'im.message.read', labelKey: 'permissionScopeImRead', required: true },
        { id: 'im.message.write', labelKey: 'permissionScopeImWrite', required: true },
      ],
    },
  },

  telegram: {
    id: 'telegram',
    order: 50,
    titleKey: 'channelTelegram',
    introKey: 'setupIntroTelegram',
    permissions: {
      docsUrl: 'https://core.telegram.org/bots',
      items: [
        { id: 'message.receive', labelKey: 'permissionMessageReceive', required: true },
        { id: 'message.send', labelKey: 'permissionMessageSend', required: true },
      ],
    },
  },
} satisfies Record<string, ChannelWebDefinition>;

/**
 * Fallback for a channel the web registry does not know yet: keep rendering it
 * with its raw id as the title instead of dropping it from the directory.
 */
export function createGenericChannelWebDefinition(id: string): ChannelWebDefinition {
  return {
    id,
    order: 999,
    titleKey: id,
  };
}

/** Resolve the web metadata for a channel, with the generic fallback. */
export function channelWebDefinition(channelId: string): ChannelWebDefinition {
  return CHANNEL_WEB[channelId] ?? createGenericChannelWebDefinition(channelId);
}

/**
 * Display title for a channel row. Unknown channels use their raw id as the
 * title key; a translator that has no entry for it (or returns an empty string)
 * must still render the id instead of a blank row (plan §7).
 */
export function channelWebTitle(definition: ChannelWebDefinition, t: (key: string) => string): string {
  return t(definition.titleKey) || definition.titleKey;
}

// ---------------------------------------------------------------------------
// Generic setup logic (replaces the removed per-channel branches in authSetup.ts)
// ---------------------------------------------------------------------------

export type SetupMethod = AuthMethod | 'credentials';

/** Preserve the provider-declared order while retaining an implicit credentials form. */
export function setupMethods(descriptor: ChannelSetupDescriptor): SetupMethod[] {
  const methods: SetupMethod[] = [...descriptor.authMethods];
  if (descriptor.fields.length > 0 && !methods.includes('credentials')) {
    methods.unshift('credentials');
  }
  return methods;
}

/**
 * Whether an auth method may begin right now. Methods with registry-declared
 * prerequisites (authRequiresConfigured) are unavailable until every listed
 * field is configured. The credentials form itself has no prerequisites.
 */
export function isSetupMethodAvailable(
  web: ChannelWebDefinition,
  method: SetupMethod,
  descriptor: ChannelSetupDescriptor,
): boolean {
  if (method === 'credentials') return true;
  const required = web.authRequiresConfigured?.[method];
  if (!required || required.length === 0) return true;
  const configured = new Set(descriptor.fields.filter((field) => field.configured).map((field) => field.name));
  return required.every((name) => configured.has(name));
}

/**
 * Whether a channel offers a non-credentials auth method that is gated behind
 * config the user has not saved yet (the old `isLarkCredentialStep`). The
 * Auth UI uses this to defer beginAuth until the setup form is saved first.
 */
export function needsConfigBeforeAuth(
  web: ChannelWebDefinition,
  descriptor: ChannelSetupDescriptor,
): boolean {
  const gated = descriptor.authMethods.filter((method) => method !== 'credentials');
  if (gated.length === 0) return false;
  return gated.some((method) => !isSetupMethodAvailable(web, method, descriptor));
}

/** Setup intro copy key: channel-specific when declared, generic otherwise. */
export function setupIntroKey(web: ChannelWebDefinition): string {
  return web.introKey ?? 'setupIntro';
}
