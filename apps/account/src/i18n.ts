/** 支持的界面语言。Supported UI locale. */
export type Locale = "zh-CN" | "en" | "ja";

const messages = {
  "zh-CN": {
    account: "账号中心", overview: "总览", profile: "个人资料", security: "安全中心", sessions: "登录设备", apps: "已连接应用",
    hello: "欢迎回来", subtitle: "你的数字身份、联系方式与安全设置，都在这里。", editProfile: "编辑个人资料", securityScore: "安全状态",
    displayName: "显示名称", bio: "自我介绍", locale: "界面语言", timezone: "时区", save: "保存更改", saved: "已保存", avatar: "头像", upload: "上传新头像", remove: "移除",
    contacts: "联系方式", email: "邮箱", mobile: "手机", value: "地址或号码", add: "添加", verified: "已验证", pending: "待验证", primary: "主要", makePrimary: "设为主要", verify: "验证", verificationCode: "验证码", confirm: "确认",
    password: "密码", passkeys: "Passkey", recovery: "恢复代码", twoFactor: "两步验证", enabled: "已启用", disabled: "未启用", manageAtLogin: "前往登录服务管理",
    comingSoon: "准备中", devicesIntro: "查看登录过此账号的浏览器与设备。", current: "当前设备", revoke: "退出此设备", connectedIntro: "这些应用可以代表你访问已授权的数据。", permissions: "权限", disconnect: "撤销授权",
    noApps: "还没有连接任何应用。", noSessions: "没有其他活跃会话。", loading: "正在读取最新状态…", retry: "重试", signIn: "前往登录", signOut: "退出登录",
    appearance: "外观", light: "浅色", dark: "深色", system: "跟随系统", language: "语言", menu: "菜单", close: "关闭", danger: "需要留意", secure: "状态良好",
    inApp: "当前是应用内浏览器；Passkey 管理会在系统浏览器中打开。", notSignedIn: "需要先登录", notSignedInBody: "账号中心没有检测到登录会话。",
  },
  en: {
    account: "Account", overview: "Overview", profile: "Profile", security: "Security", sessions: "Sessions", apps: "Connected apps",
    hello: "Welcome back", subtitle: "Your identity, contacts, and security settings—all in one place.", editProfile: "Edit profile", securityScore: "Security status",
    displayName: "Display name", bio: "About you", locale: "Interface language", timezone: "Time zone", save: "Save changes", saved: "Saved", avatar: "Avatar", upload: "Upload new avatar", remove: "Remove",
    contacts: "Contact methods", email: "Email", mobile: "Mobile", value: "Address or number", add: "Add", verified: "Verified", pending: "Pending", primary: "Primary", makePrimary: "Make primary", verify: "Verify", verificationCode: "Verification code", confirm: "Confirm",
    password: "Password", passkeys: "Passkeys", recovery: "Recovery codes", twoFactor: "Two-factor authentication", enabled: "Enabled", disabled: "Not enabled", manageAtLogin: "Manage at Login",
    comingSoon: "Coming soon", devicesIntro: "Review browsers and devices signed in to this account.", current: "This device", revoke: "Sign out device", connectedIntro: "These apps can access the data you approved.", permissions: "Permissions", disconnect: "Revoke access",
    noApps: "No connected apps yet.", noSessions: "No other active sessions.", loading: "Fetching the latest state…", retry: "Retry", signIn: "Go to Login", signOut: "Sign out",
    appearance: "Appearance", light: "Light", dark: "Dark", system: "System", language: "Language", menu: "Menu", close: "Close", danger: "Needs attention", secure: "Looking good",
    inApp: "You are in an in-app browser; passkey management will open in your system browser.", notSignedIn: "Sign in required", notSignedInBody: "No sign-in session was found for the account center.",
  },
  ja: {
    account: "アカウント", overview: "概要", profile: "プロフィール", security: "セキュリティ", sessions: "ログイン端末", apps: "連携アプリ",
    hello: "おかえりなさい", subtitle: "デジタル ID、連絡先、セキュリティ設定をひとつの場所で。", editProfile: "プロフィール編集", securityScore: "セキュリティ状態",
    displayName: "表示名", bio: "自己紹介", locale: "表示言語", timezone: "タイムゾーン", save: "変更を保存", saved: "保存しました", avatar: "アバター", upload: "新しい画像をアップロード", remove: "削除",
    contacts: "連絡先", email: "メール", mobile: "携帯電話", value: "アドレスまたは番号", add: "追加", verified: "確認済み", pending: "未確認", primary: "メイン", makePrimary: "メインにする", verify: "確認する", verificationCode: "確認コード", confirm: "確定",
    password: "パスワード", passkeys: "パスキー", recovery: "リカバリーコード", twoFactor: "2段階認証", enabled: "有効", disabled: "無効", manageAtLogin: "Login で管理",
    comingSoon: "準備中", devicesIntro: "このアカウントにログイン中の端末を確認できます。", current: "この端末", revoke: "ログアウト", connectedIntro: "許可したデータにアクセスできるアプリです。", permissions: "権限", disconnect: "連携解除",
    noApps: "連携アプリはありません。", noSessions: "他のセッションはありません。", loading: "最新の状態を取得中…", retry: "再試行", signIn: "ログインへ", signOut: "ログアウト",
    appearance: "外観", light: "ライト", dark: "ダーク", system: "システム", language: "言語", menu: "メニュー", close: "閉じる", danger: "確認が必要", secure: "良好です",
    inApp: "アプリ内ブラウザです。パスキー管理はシステムブラウザで開きます。", notSignedIn: "ログインが必要です", notSignedInBody: "アカウントセンターのログインセッションが見つかりません。",
  },
} as const;

export type MessageKey = keyof typeof messages["zh-CN"];

/** 浏览器语言规整为产品支持的语言。Normalizes browser language to a supported locale. */
export function normalizeLocale(value?: string | null): Locale {
  const locale = value?.toLowerCase();
  if (locale?.startsWith("ja")) return "ja";
  if (locale?.startsWith("en")) return "en";
  return "zh-CN";
}

/** 创建无回退缺口的翻译函数。Creates a translation function with no missing-key fallback. */
export function translator(locale: Locale): (key: MessageKey) => string { return (key) => messages[locale][key]; }
