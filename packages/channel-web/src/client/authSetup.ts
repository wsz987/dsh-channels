import type { AuthMethod, ChannelSetupDescriptor } from './api.js';

export type SetupMethod = AuthMethod | 'credentials';

/** Preserve the provider-declared order while retaining an implicit credentials form. */
export function setupMethods(descriptor: ChannelSetupDescriptor): SetupMethod[] {
  const methods: SetupMethod[] = [...descriptor.authMethods];
  if (descriptor.fields.length > 0 && !methods.includes('credentials')) {
    methods.unshift('credentials');
  }
  return methods;
}

/** Lark device authorization is only valid after its app credentials are saved. */
export function isSetupMethodAvailable(
  channelId: string,
  method: SetupMethod,
  descriptor: ChannelSetupDescriptor,
): boolean {
  if (channelId !== 'lark' || method === 'credentials') return true;
  return descriptor.fields.every((field) => field.configured);
}

export function isLarkCredentialStep(channelId: string, descriptor: ChannelSetupDescriptor): boolean {
  return channelId === 'lark'
    && descriptor.authMethods.some((method) => method !== 'credentials')
    && !descriptor.fields.every((field) => field.configured);
}

export function setupIntroKey(channelId: string): string {
  if (channelId === 'dingtalk') return 'setupIntroDingtalk';
  if (channelId === 'lark') return 'setupIntroLark';
  if (channelId === 'telegram') return 'setupIntroTelegram';
  return 'setupIntro';
}
