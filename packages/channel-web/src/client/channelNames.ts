/** Localized display names for the built-in channel identifiers. */
export function channelDisplayName(channelId: string, t: (key: string) => string): string {
  switch (channelId) {
    case 'weixin':
      return t('channelWeixin');
    case 'qq':
      return t('channelQq');
    case 'dingtalk':
      return t('channelDingtalk');
    case 'lark':
      return t('channelLark');
    case 'telegram':
      return t('channelTelegram');
    default:
      return channelId;
  }
}
