/**
 * channelRegistry tests (refactor plan §5, §7, §18): presentation metadata for
 * the built-in channels, the unknown-channel fallback, and the GENERIC setup
 * logic that replaced the old per-channel branches in authSetup.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_WEB,
  channelWebDefinition,
  channelWebTitle,
  createGenericChannelWebDefinition,
  isSetupMethodAvailable,
  needsConfigBeforeAuth,
  setupIntroKey,
  setupMethods,
} from '../src/client/channelRegistry.js';
import { locales } from '../src/client/locales.js';
import type { ChannelSetupDescriptor } from '../src/client/api.js';

const t = (key: keyof typeof locales.zh) => locales.zh[key];

describe('CHANNEL_WEB built-in metadata', () => {
  it('declares all five built-in channels with a stable sort order', () => {
    const ids = Object.keys(CHANNEL_WEB);
    expect(ids).toEqual(['weixin', 'qq', 'dingtalk', 'lark', 'telegram']);
    const orders = ids.map((id) => CHANNEL_WEB[id]!.order);
    // Orders are unique and ascending.
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('resolves localized titles through the registry', () => {
    expect(channelWebTitle(CHANNEL_WEB.weixin!, t)).toBe('微信');
    expect(channelWebTitle(CHANNEL_WEB.dingtalk!, t)).toBe('钉钉');
    expect(channelWebTitle(CHANNEL_WEB.lark!, t)).toBe('飞书');
  });

  it('falls back to the raw id for an unknown channel', () => {
    const web = channelWebDefinition('discord');
    expect(web.order).toBe(999);
    expect(channelWebTitle(web, t)).toBe('discord');
    expect(channelWebDefinition('lark')).toBe(CHANNEL_WEB.lark);
  });
});

describe('setup method helpers (generic, no channel branches)', () => {
  const larkIncomplete: ChannelSetupDescriptor = {
    authMethods: ['credentials', 'hybrid'],
    fields: [
      { name: 'appId', kind: 'text', secret: false, configured: true, writable: true },
      { name: 'appSecret', kind: 'secret', secret: true, configured: false, writable: true },
    ],
  };
  const larkConfigured: ChannelSetupDescriptor = {
    ...larkIncomplete,
    fields: larkIncomplete.fields.map((field) => ({ ...field, configured: true })),
  };

  it('keeps DingTalk device authorization first (provider order preserved)', () => {
    expect(setupMethods({ authMethods: ['device', 'credentials'], fields: [] })).toEqual([
      'device',
      'credentials',
    ]);
  });

  it('gates hybrid auth on registry-declared prerequisite fields', () => {
    const lark = CHANNEL_WEB.lark!;
    expect(isSetupMethodAvailable(lark, 'hybrid', larkIncomplete)).toBe(false);
    expect(isSetupMethodAvailable(lark, 'hybrid', larkConfigured)).toBe(true);
    expect(isSetupMethodAvailable(lark, 'credentials', larkIncomplete)).toBe(true);
  });

  it('a channel without prerequisites never gates its methods', () => {
    const qq = CHANNEL_WEB.qq!;
    expect(isSetupMethodAvailable(qq, 'qr', { authMethods: ['qr'], fields: [] })).toBe(true);
  });

  it('needsConfigBeforeAuth reports gated interactive auth methods', () => {
    expect(needsConfigBeforeAuth(CHANNEL_WEB.lark!, larkIncomplete)).toBe(true);
    expect(needsConfigBeforeAuth(CHANNEL_WEB.lark!, larkConfigured)).toBe(false);
    // credentials-only channel: nothing to gate.
    expect(
      needsConfigBeforeAuth(CHANNEL_WEB.qq!, { authMethods: ['credentials'], fields: [] }),
    ).toBe(false);
  });

  it('uses channel-specific setup copy with a generic fallback', () => {
    expect(setupIntroKey(CHANNEL_WEB.dingtalk!)).toBe('setupIntroDingtalk');
    expect(setupIntroKey(CHANNEL_WEB.lark!)).toBe('setupIntroLark');
    expect(setupIntroKey(CHANNEL_WEB.qq!)).toBe('setupIntro');
    expect(setupIntroKey(createGenericChannelWebDefinition('custom'))).toBe('setupIntro');
  });
});
