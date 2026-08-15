
/**
 * Locale dictionaries for the "渠道" (Channels) Settings section.
 * Keyed namespace: 'channels'.
 */
export const locales = {
  zh: {
    nav: '渠道',
    title: '渠道',
    loading: '加载中…',
    // dashboard
    connecting: '连接中…',
    configure: '配置',
    configured: '已配置',
    notConfigured: '未配置',
    enabled: '已启用',
    disabled: '未启用',
    capabilities: '能力',
    // status (RuntimeStatus)
    statusConnected: '已连接',
    statusDegraded: '部分异常',
    statusUnknown: '状态未知',
    statusDown: '不可用',
    // generic form
    save: '保存',
    saving: '保存中…',
    saved: '已保存',
    saveError: '保存失败',
    inputValue: '输入',
    credentialKeepBlank: '已配置，留空保持不变',
    readonlyHint: '只读',
    // setup dialog
    setupIntro: '填写渠道凭证，保存后自动连接。已配置的字段可留空。',
    saveAndConnect: '保存并连接',
    openPlatform: '打开官方开放平台',
    incompleteSetup: '请填写所有尚未配置的必填项',
    setupSaved: '配置已保存，渠道连接已启动',
    setupDisabled: '配置已保存，渠道已停止',
    done: '完成',
    // auth progress
    waitingScan: '等待扫码',
    scannedConfirm: '已扫码，请确认',
    confirmOnPhone: '请在手机上确认',
    credentialsRequired: '请填写 AppID / AppSecret',
    preparing: '准备中…',
    needVerifyCode: '需要验证码',
    verifyCodePlaceholder: '输入验证码',
    success: '认证成功',
    expired: '二维码已过期',
    failed: '认证失败',
    regenerate: '重新生成',
    submit: '提交',
    // qr display
    openLink: '在新窗口打开',
    // misc
    close: '关闭',
    refresh: '刷新',
    expiresIn: '剩余',
    seconds: '秒',
    connectionError: '连接出错',
    retry: '重试',
  },
  en: {
    nav: 'Channels',
    title: 'Channels',
    loading: 'Loading…',
    // dashboard
    connecting: 'Connecting…',
    configure: 'Configure',
    configured: 'Configured',
    notConfigured: 'Not configured',
    enabled: 'Enabled',
    disabled: 'Disabled',
    capabilities: 'Capabilities',
    // status (RuntimeStatus)
    statusConnected: 'Connected',
    statusDegraded: 'Degraded',
    statusUnknown: 'Unknown',
    statusDown: 'Unavailable',
    // generic form
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved',
    saveError: 'Save failed',
    inputValue: 'Value',
    credentialKeepBlank: 'Configured — leave blank to keep',
    readonlyHint: 'Read-only',
    // setup dialog
    setupIntro: 'Enter channel credentials and connect. Leave configured fields blank to keep them unchanged.',
    saveAndConnect: 'Save and connect',
    openPlatform: 'Open official developer console',
    incompleteSetup: 'Complete every required field that is not configured yet',
    setupSaved: 'Configuration saved and channel connection started',
    setupDisabled: 'Configuration saved and channel stopped',
    done: 'Done',
    // auth progress
    waitingScan: 'Waiting for scan',
    scannedConfirm: 'Scanned, please confirm',
    confirmOnPhone: 'Please confirm on your phone',
    credentialsRequired: 'Enter App ID / App Secret',
    preparing: 'Preparing…',
    needVerifyCode: 'Verification code required',
    verifyCodePlaceholder: 'Enter verification code',
    success: 'Authentication successful',
    expired: 'QR code expired',
    failed: 'Authentication failed',
    regenerate: 'Regenerate',
    submit: 'Submit',
    // qr display
    openLink: 'Open in new window',
    // misc
    close: 'Close',
    refresh: 'Refresh',
    expiresIn: 'Expires in',
    seconds: 's',
    connectionError: 'Connection error',
    retry: 'Retry',
  },
} as const;

export type ChannelNavNamespaces = 'zh' | 'en';
export type ChannelLocale = typeof locales;
