import { describe, expect, it } from 'vitest';
import { channelDisplayName } from '../src/client/channelNames.js';
import { locales } from '../src/client/locales.js';

describe('channelDisplayName', () => {
  it('uses Chinese names for DingTalk and Lark in the Chinese locale', () => {
    const t = (key: keyof typeof locales.zh) => locales.zh[key];

    expect(channelDisplayName('dingtalk', t)).toBe('钉钉');
    expect(channelDisplayName('lark', t)).toBe('飞书');
  });

  it('keeps the English brand names in the English locale', () => {
    const t = (key: keyof typeof locales.en) => locales.en[key];

    expect(channelDisplayName('dingtalk', t)).toBe('DingTalk');
    expect(channelDisplayName('lark', t)).toBe('Lark');
  });

  it('preserves an unknown channel identifier', () => {
    expect(channelDisplayName('custom', (key) => key)).toBe('custom');
  });
});
