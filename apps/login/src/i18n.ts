/** 登录站支持的界面语言。Locales supported by the login surface. */
export type Locale = "zh-CN" | "en" | "ja";

const messages = {
  "zh-CN": {
    brand: "moeSegFault 通行证", login: "登录", register: "创建账号", recovery: "恢复账号",
    welcome: "欢迎回来，旅人", welcomeIntro: "选择最顺手的方式，继续前往你的目的地。",
    newTitle: "创建你的同好身份", newIntro: "昵称是你在社区里的第一句自我介绍，认真一点，也可以可爱一点。",
    identity: "邮箱或用户名", password: "密码", passwordAgain: "确认密码", displayName: "显示昵称", username: "用户名",
    email: "邮箱", avatar: "头像（可选）", mobile: "手机号（可选）", countryCode: "区号",
    signInPassword: "使用密码登录", usePasskey: "使用 Passkey",
    divider: "或者", create: "创建账号", haveAccount: "已经有账号？", noAccount: "第一次来？",
    passkeyOptional: "Passkey 是更快捷的可选登录方式，不是使用本站的前提。你可以稍后在账号中心添加。",
    registerPasskey: "创建账号并添加 Passkey", registerPassword: "使用密码创建账号", methodTitle: "选择初始登录方式",
    accountLink: "账号中心", accountHint: "资料、两步验证和登录设备由独立的账号中心管理。",
    signingIn: "正在登录…", registering: "正在创建…", waitingPasskey: "等待设备确认…",
    loginFailed: "登录没有完成", registerFailed: "注册没有完成", success: "成功啦！", signedIn: "身份已确认，正在继续…",
    passkeyUnavailable: "当前浏览器不能使用 Passkey，你仍可使用密码。",
    inAppTitle: "内置浏览器可能限制登录", inAppBody: "若 Passkey 无法打开，请使用系统浏览器继续。",
    openBrowser: "复制当前链接", copied: "链接已复制", theme: "主题", language: "语言", system: "跟随系统", light: "浅色", dark: "深色",
    privacy: "登录页不加载第三方字体、脚本或追踪器。", terms: "创建账号即表示你愿意遵守社区约定。",
    passwordHint: "至少 15 个字符；建议使用密码管理器生成独立密码。", mismatch: "两次输入的密码不一致。",
    invalidEmail: "请输入有效邮箱。", recoveryCode: "恢复代码", newPasskeyLabel: "新 Passkey 名称", recover: "恢复并添加 Passkey",
    recoveryIntro: "使用一次性恢复代码重新取得账号控制权。", recoveryFailed: "恢复没有完成",
    addAvatar: "支持 AVIF、PNG、JPEG 或 WebP；也可以稍后在账号中心更换。", phoneHint: "只在你选择绑定手机时保存，将来可用于二次验证。",
    avatarUploadFailed: "账号已创建，但头像暂未上传；请稍后在账号中心重试。", back: "返回登录", logoAlt: "moeSegFault 像素星标",
    statusLabel: "状态签名", statusPlaceholder: "今天也在修可爱的 bug ✦", oshiLabel: "最喜欢的角色", interestsLabel: "兴趣标签", mobileDevice: "我的手机", desktopDevice: "这台设备", skipLink: "跳到主要内容",
    enrollTitle: "添加一枚 Passkey", enrollIntro: "这是账号中心发起的短暂认证仪式。完成后请返回账号中心继续管理。", passkeyName: "Passkey 名称", enroll: "添加 Passkey", enrolled: "Passkey 已添加",
    passwordReauthTitle: "还没有可用的 Passkey？", passwordReauthIntro: "先用现有账号密码确认身份，然后就能添加第一枚 Passkey。", reauthIdentity: "邮箱或用户名", reauthPassword: "当前密码", reauthWithPassword: "使用密码确认并继续",
    rotateTitle: "生成新的恢复代码", rotateIntro: "此操作会让旧恢复代码失效；代码只展示这一次。", rotate: "轮换恢复代码", codesTitle: "立即保存恢复代码", codesIntro: "每枚代码只能使用一次。请下载或复制后存放在安全的位置。", copyCodes: "复制全部", downloadCodes: "下载 .txt", continueAccount: "返回账号中心", stepUp: "请先用 Passkey 再确认一次身份。",
  },
  en: {
    brand: "moeSegFault Passport", login: "Sign in", register: "Create account", recovery: "Recover account",
    welcome: "Welcome back, traveler", welcomeIntro: "Choose the way that feels right and continue to your destination.",
    newTitle: "Create your fandom identity", newIntro: "Your nickname is your first hello to the community. Make it sincere—or delightfully cute.",
    identity: "Email or username", password: "Password", passwordAgain: "Confirm password", displayName: "Display name", username: "Username",
    email: "Email", avatar: "Avatar (optional)", mobile: "Mobile (optional)", countryCode: "Country code",
    signInPassword: "Sign in with password", usePasskey: "Use a passkey",
    divider: "or", create: "Create account", haveAccount: "Already a member?", noAccount: "New here?",
    passkeyOptional: "A passkey is a quicker optional sign-in method, not a requirement. Add one later in Account Center.",
    registerPasskey: "Create and add passkey", registerPassword: "Create with password", methodTitle: "Choose your first sign-in method",
    accountLink: "Account Center", accountHint: "Profile, two-step verification, and devices live in the separate Account Center.",
    signingIn: "Signing in…", registering: "Creating…", waitingPasskey: "Waiting for your device…",
    loginFailed: "Sign-in wasn't completed", registerFailed: "Registration wasn't completed", success: "All set!", signedIn: "Identity confirmed. Continuing…",
    passkeyUnavailable: "Passkeys are unavailable here. You can still use your password.",
    inAppTitle: "This in-app browser may limit sign-in", inAppBody: "If Passkey won't open, continue in your system browser.",
    openBrowser: "Copy current link", copied: "Link copied", theme: "Theme", language: "Language", system: "System", light: "Light", dark: "Dark",
    privacy: "No third-party fonts, scripts, or trackers are loaded on this page.", terms: "By creating an account, you agree to be kind and follow the community rules.",
    passwordHint: "Use at least 15 characters. A unique password from a password manager is best.", mismatch: "The passwords do not match.",
    invalidEmail: "Enter a valid email.", recoveryCode: "Recovery code", newPasskeyLabel: "New passkey name", recover: "Recover and add passkey",
    recoveryIntro: "Use a one-time recovery code to regain control of your account.", recoveryFailed: "Recovery wasn't completed",
    addAvatar: "AVIF, PNG, JPEG, or WebP. You can also add or change it later.", phoneHint: "Saved only if supplied; it can support two-step verification later.",
    avatarUploadFailed: "Your account was created, but the avatar was not uploaded. Try again later in Account Center.", back: "Back to sign in", logoAlt: "moeSegFault pixel star",
    statusLabel: "Status message", statusPlaceholder: "Making cute bugs disappear today ✦", oshiLabel: "Favorite character", interestsLabel: "Interests", mobileDevice: "My phone", desktopDevice: "This device", skipLink: "Skip to main content",
    enrollTitle: "Add a passkey", enrollIntro: "This is a brief ceremony started by Account Center. Return there to continue managing your account.", passkeyName: "Passkey name", enroll: "Add passkey", enrolled: "Passkey added",
    passwordReauthTitle: "No passkey available yet?", passwordReauthIntro: "Confirm with your existing account password, then add your first passkey.", reauthIdentity: "Email or username", reauthPassword: "Current password", reauthWithPassword: "Confirm with password and continue",
    rotateTitle: "Generate new recovery codes", rotateIntro: "This invalidates your old recovery codes. The new codes are shown only once.", rotate: "Rotate recovery codes", codesTitle: "Save recovery codes now", codesIntro: "Each code works once. Copy or download them and keep them somewhere safe.", copyCodes: "Copy all", downloadCodes: "Download .txt", continueAccount: "Return to Account Center", stepUp: "Confirm your identity once more with a passkey.",
  },
  ja: {
    brand: "moeSegFault パスポート", login: "ログイン", register: "アカウント作成", recovery: "アカウント復旧",
    welcome: "おかえりなさい、旅人さん", welcomeIntro: "好きな方法を選んで、目的地へ進みましょう。",
    newTitle: "同好のための自分を作ろう", newIntro: "ニックネームはコミュニティへの最初の挨拶。真面目でも、かわいくても大丈夫。",
    identity: "メールまたはユーザー名", password: "パスワード", passwordAgain: "パスワード（確認）", displayName: "表示名", username: "ユーザー名",
    email: "メール", avatar: "アバター（任意）", mobile: "携帯番号（任意）", countryCode: "国番号",
    signInPassword: "パスワードでログイン", usePasskey: "Passkey を使う",
    divider: "または", create: "アカウント作成", haveAccount: "アカウントをお持ちですか？", noAccount: "はじめてですか？",
    passkeyOptional: "Passkey は便利な選択肢で、必須ではありません。後からアカウントセンターで追加できます。",
    registerPasskey: "作成して Passkey を追加", registerPassword: "パスワードで作成", methodTitle: "最初のログイン方法を選択",
    accountLink: "アカウントセンター", accountHint: "プロフィール、二段階認証、端末は独立したアカウントセンターで管理します。",
    signingIn: "ログイン中…", registering: "作成中…", waitingPasskey: "端末の確認待ち…",
    loginFailed: "ログインできませんでした", registerFailed: "登録できませんでした", success: "できました！", signedIn: "本人確認完了。続行します…",
    passkeyUnavailable: "このブラウザでは Passkey を使えません。パスワードをご利用ください。",
    inAppTitle: "アプリ内ブラウザではログインが制限される場合があります", inAppBody: "Passkey が開かない場合は、システムブラウザで続けてください。",
    openBrowser: "現在のリンクをコピー", copied: "コピーしました", theme: "テーマ", language: "言語", system: "システム", light: "ライト", dark: "ダーク",
    privacy: "このページは外部フォント、スクリプト、トラッカーを読み込みません。", terms: "作成すると、コミュニティの約束を守ることに同意します。",
    passwordHint: "15文字以上。パスワード管理ツールによる固有のパスワードがおすすめです。", mismatch: "パスワードが一致しません。",
    invalidEmail: "有効なメールアドレスを入力してください。", recoveryCode: "復旧コード", newPasskeyLabel: "新しい Passkey の名前", recover: "復旧して Passkey を追加",
    recoveryIntro: "一回限りの復旧コードでアカウントを取り戻します。", recoveryFailed: "復旧できませんでした",
    addAvatar: "AVIF、PNG、JPEG、WebPに対応。後から追加・変更もできます。", phoneHint: "入力した場合のみ保存され、将来の二段階認証に利用できます。",
    avatarUploadFailed: "アカウントは作成されましたが、アバターをアップロードできませんでした。後でアカウントセンターからお試しください。", back: "ログインへ戻る", logoAlt: "moeSegFault ピクセルスター",
    statusLabel: "ステータス", statusPlaceholder: "今日もかわいいバグを修正中 ✦", oshiLabel: "推しキャラ", interestsLabel: "興味タグ", mobileDevice: "自分のスマホ", desktopDevice: "このデバイス", skipLink: "メインコンテンツへ移動",
    enrollTitle: "Passkeyを追加", enrollIntro: "アカウントセンターから開始された短い認証手続きです。完了後はアカウントセンターへ戻ります。", passkeyName: "Passkeyの名前", enroll: "Passkeyを追加", enrolled: "Passkeyを追加しました",
    passwordReauthTitle: "利用できるPasskeyがまだありませんか？", passwordReauthIntro: "現在のパスワードで本人確認してから、最初のPasskeyを追加できます。", reauthIdentity: "メールまたはユーザー名", reauthPassword: "現在のパスワード", reauthWithPassword: "パスワードで確認して続ける",
    rotateTitle: "新しい復旧コードを生成", rotateIntro: "古い復旧コードは無効になります。新しいコードの表示は一度だけです。", rotate: "復旧コードを更新", codesTitle: "今すぐ復旧コードを保存", codesIntro: "各コードは一度だけ使えます。コピーまたはダウンロードして安全に保管してください。", copyCodes: "すべてコピー", downloadCodes: ".txtをダウンロード", continueAccount: "アカウントセンターへ戻る", stepUp: "Passkeyでもう一度本人確認してください。",
  },
} as const;

/** 翻译键集合。Translation key set. */
export type MessageKey = keyof typeof messages["zh-CN"];

/** 将浏览器语言规整到支持集合。Normalizes a browser language to the supported set. */
export function normalizeLocale(value: string | null | undefined): Locale {
  const language = value?.toLowerCase() ?? "";
  if (language.startsWith("ja")) return "ja";
  if (language.startsWith("en")) return "en";
  return "zh-CN";
}

/** 返回指定语言的本地化文本。Returns localized copy for a locale. */
export function translate(locale: Locale, key: MessageKey): string {
  return messages[locale][key];
}
