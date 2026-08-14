/**
 * Channel display-label and safe path/title helpers (plan §4.2).
 *
 * Covers the label registry, single- vs multi-account workspace titles, the
 * stable 6-hex account hash, path-safe segmentation, and the conservative
 * readable-account-label heuristic.
 */
import { describe, expect, it } from 'vitest';
import {
  channelLabel,
  channelWorkspaceTitle,
  safeAccountLabel,
  safeSegment,
  stableSafeAccountKey,
} from '../src/channel-label.ts';

describe('channelLabel', () => {
  it('maps known channels to their display labels', () => {
    expect(channelLabel('weixin')).toBe('微信');
    expect(channelLabel('qq')).toBe('QQ');
    expect(channelLabel('dingtalk')).toBe('DingTalk');
    expect(channelLabel('lark')).toBe('Lark');
    expect(channelLabel('telegram')).toBe('Telegram');
    expect(channelLabel('discord')).toBe('Discord');
    expect(channelLabel('slack')).toBe('Slack');
  });

  it('falls back to the raw id for unknown channels', () => {
    expect(channelLabel('unknown-channel')).toBe('unknown-channel');
  });
});

describe('channelWorkspaceTitle', () => {
  it('single-account default id yields "Channels · <label>"', () => {
    expect(channelWorkspaceTitle({ channelId: 'weixin', accountId: 'main' })).toBe('Channels · 微信');
    expect(channelWorkspaceTitle({ channelId: 'weixin', accountId: 'default' })).toBe('Channels · 微信');
    expect(channelWorkspaceTitle({ channelId: 'telegram', accountId: '' })).toBe('Channels · Telegram');
  });

  it('readable multi-account appends the account label', () => {
    expect(channelWorkspaceTitle({ channelId: 'telegram', accountId: 'bot-main' })).toBe(
      'Channels · Telegram · bot-main',
    );
  });

  it('sensitive multi-account (phone-like) uses the stable hash', () => {
    const title = channelWorkspaceTitle({ channelId: 'weixin', accountId: '13800138000' });
    expect(title).toBe(`Channels · 微信 · ${stableSafeAccountKey('13800138000')}`);
  });
});

describe('stableSafeAccountKey', () => {
  it('is deterministic and 6 hex chars', () => {
    const a = stableSafeAccountKey('account-a');
    const b = stableSafeAccountKey('account-a');
    expect(a).toBe(b);
    expect(a).toHaveLength(6);
    expect(/^[0-9a-f]{6}$/.test(a)).toBe(true);
  });

  it('differs for different accounts', () => {
    expect(stableSafeAccountKey('a')).not.toBe(stableSafeAccountKey('b'));
  });
});

describe('safeSegment', () => {
  it('lowercases and sanitizes to a path-safe segment', () => {
    expect(safeSegment('WeiXin / 1')).toBe('weixin-1');
    expect(safeSegment('Wechat Bot:Main')).toBe('wechat-bot-main');
  });

  it('falls back to "unknown" for empty or all-illegal input', () => {
    expect(safeSegment('')).toBe('unknown');
    expect(safeSegment('///')).toBe('unknown');
  });
});

describe('safeAccountLabel', () => {
  it('allows a short readable identifier', () => {
    expect(safeAccountLabel('bot-main')).toBe('bot-main');
    expect(safeAccountLabel('Alice')).toBe('Alice');
  });

  it('rejects phone-like all-digit values', () => {
    expect(safeAccountLabel('13800138000')).toBeUndefined();
  });

  it('rejects sensitive token / openid / secret / appid values', () => {
    expect(safeAccountLabel('o_wx-token-abc')).toBeUndefined();
    expect(safeAccountLabel('OpenID_123')).toBeUndefined();
    expect(safeAccountLabel('appid_xyz')).toBeUndefined();
    expect(safeAccountLabel('supersecret')).toBeUndefined();
  });

  it('rejects too-long or structurally surprising values', () => {
    expect(safeAccountLabel('a'.repeat(30))).toBeUndefined();
    expect(safeAccountLabel('has spaces')).toBeUndefined();
  });
});
