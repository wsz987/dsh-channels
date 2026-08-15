import { describe, expect, it } from 'vitest';
import {
  isLarkCredentialStep,
  isSetupMethodAvailable,
  setupIntroKey,
  setupMethods,
} from '../src/client/authSetup.js';
import type { ChannelSetupDescriptor } from '../src/client/api.js';

const larkIncomplete: ChannelSetupDescriptor = {
  authMethods: ['credentials', 'hybrid'],
  fields: [
    { name: 'appId', kind: 'text', secret: false, configured: true, writable: true },
    { name: 'appSecret', kind: 'secret', secret: true, configured: false, writable: true },
  ],
};

describe('channel setup authorization methods', () => {
  it('keeps DingTalk device authorization first', () => {
    expect(setupMethods({ authMethods: ['device', 'credentials'], fields: [] })).toEqual([
      'device',
      'credentials',
    ]);
  });

  it('keeps Lark scan authorization unavailable until all credentials are saved', () => {
    expect(isSetupMethodAvailable('lark', 'hybrid', larkIncomplete)).toBe(false);
    expect(isLarkCredentialStep('lark', larkIncomplete)).toBe(true);
  });

  it('enables Lark scan authorization after all credentials are saved', () => {
    const configured = {
      ...larkIncomplete,
      fields: larkIncomplete.fields.map((field) => ({ ...field, configured: true })),
    };

    expect(isSetupMethodAvailable('lark', 'hybrid', configured)).toBe(true);
    expect(isLarkCredentialStep('lark', configured)).toBe(false);
  });

  it('uses channel-specific setup copy', () => {
    expect(setupIntroKey('dingtalk')).toBe('setupIntroDingtalk');
    expect(setupIntroKey('lark')).toBe('setupIntroLark');
    expect(setupIntroKey('qq')).toBe('setupIntro');
  });
});
