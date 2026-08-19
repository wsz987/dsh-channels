
/**
 * Locale dictionaries for the "渠道" (Channels) Settings section.
 * Keyed namespace: 'channels'.
 */
export const locales = {
  zh: {
    nav: '渠道',
    channelWeixin: '微信',
    channelQq: 'QQ',
    channelDingtalk: '钉钉',
    channelLark: '飞书',
    channelTelegram: 'Telegram',
    loading: '加载中…',
    configured: '已配置',
    notConfigured: '未配置',
    // status
    statusConnected: '已连接',
    // generic form
    saving: '保存中…',
    saveError: '保存失败',
    inputValue: '输入',
    readonlyHint: '只读',
    // setup copy
    setupIntro: '填写渠道凭证，保存后自动连接。已配置的字段可留空。',
    setupIntroDingtalk: '扫码授权可一键创建并授权钉钉机器人，成功后自动回填凭证；也可填写已有应用凭证并保存连接。已配置的字段可留空。',
    setupIntroLark: '填写 App ID 和 App Secret 后保存即可连接；扫码授权可一键配置机器人，用于接入 deepseek-harness。已配置的字段可留空。',
    setupIntroTelegram: '在 @BotFather 创建机器人并获取 Bot Token，填写后保存即可连接。已配置的字段可留空。',
    scanTab: '扫码登录',
    scanAuthTab: '扫码授权',
    portalLoginTab: '平台扫码',
    saveAndConnect: '保存并连接',
    openPlatform: '打开官方开放平台',
    incompleteSetup: '请填写所有尚未配置的必填项',
    setupSaved: '配置已保存，渠道连接已启动',
    done: '完成',
    // inline setup sections
    setupSection: '应用配置',
    // inline auth section
    authSection: '授权',
    beginAuth: '开始授权',
    authNeedsConfigFirst: '请先在「应用配置」中填写并保存必填凭证，再开始授权',
    // permissions section
    permissionsSection: '权限与事件',
    permissionMessageReceive: '消息接收',
    permissionMessageSend: '消息发送',
    permissionScopeImRead: '机器人消息读取（IM scope）',
    permissionScopeImWrite: '机器人消息发送（IM scope）',
    permissionRequired: '必需',
    viewOfficialDocs: '查看官方文档',
    // enable lifecycle (row switch)
    enableChannel: '启动渠道',
    disableChannel: '停用渠道',
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
    expiresIn: '剩余',
    seconds: '秒',
    connectionError: '连接出错',
    retry: '重试',
  },
  en: {
    nav: 'Channels',
    channelWeixin: 'Weixin',
    channelQq: 'QQ',
    channelDingtalk: 'DingTalk',
    channelLark: 'Lark',
    channelTelegram: 'Telegram',
    loading: 'Loading…',
    configured: 'Configured',
    notConfigured: 'Not configured',
    // status
    statusConnected: 'Connected',
    // generic form
    saving: 'Saving…',
    saveError: 'Save failed',
    inputValue: 'Value',
    readonlyHint: 'Read-only',
    // setup copy
    setupIntro: 'Enter channel credentials and connect. Leave configured fields blank to keep them unchanged.',
    setupIntroDingtalk: 'Scan to create and authorize a DingTalk bot in one step, then fill the credentials automatically; or enter an existing app credential and connect. Leave configured fields blank to keep them unchanged.',
    setupIntroLark: 'Save and connect directly with App ID and App Secret. Scanning one-click configures the bot to connect to deepseek-harness. Leave configured fields blank to keep them unchanged.',
    setupIntroTelegram: 'Create a bot and get its Bot Token from @BotFather, then save and connect. Leave configured fields blank to keep them unchanged.',
    scanTab: 'Scan to sign in',
    scanAuthTab: 'Scan to authorize',
    portalLoginTab: 'Platform login',
    saveAndConnect: 'Save and connect',
    openPlatform: 'Open official developer console',
    incompleteSetup: 'Complete every required field that is not configured yet',
    setupSaved: 'Configuration saved and channel connection started',
    done: 'Done',
    // inline setup sections
    setupSection: 'Application config',
    // inline auth section
    authSection: 'Authorization',
    beginAuth: 'Begin authorization',
    authNeedsConfigFirst: 'Fill in and save the required credentials under "Application config" first',
    // permissions section
    permissionsSection: 'Permissions & events',
    permissionMessageReceive: 'Receive messages',
    permissionMessageSend: 'Send messages',
    permissionScopeImRead: 'Bot message read (IM scope)',
    permissionScopeImWrite: 'Bot message send (IM scope)',
    permissionRequired: 'Required',
    viewOfficialDocs: 'View official docs',
    // enable lifecycle (row switch)
    enableChannel: 'Enable channel',
    disableChannel: 'Disable channel',
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
    expiresIn: 'Expires in',
    seconds: 's',
    connectionError: 'Connection error',
    retry: 'Retry',
  },
} as const;

export type ChannelNavNamespaces = 'zh' | 'en';
export type ChannelLocale = typeof locales;
