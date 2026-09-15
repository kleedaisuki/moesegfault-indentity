import { normalizeLocale, type Locale } from "./i18n";

/** 外观选项。Appearance preference. */
export type Theme = "light" | "dark" | "system";

/** 仅保存非敏感 UI 偏好；认证状态永不进入 storage。Stores only non-sensitive UI preferences, never authentication state. */
export function readPreferences(storage: Pick<Storage, "getItem"> | undefined, browserLanguage: string): { locale: Locale; theme: Theme } {
  try {
    const theme = storage?.getItem("moe.account.theme");
    return { locale: normalizeLocale(storage?.getItem("moe.account.locale") ?? browserLanguage), theme: theme === "light" || theme === "dark" ? theme : "system" };
  } catch {
    return { locale: normalizeLocale(browserLanguage), theme: "system" };
  }
}

/** 尝试取得可能被浏览器策略禁用的 storage。Tries to obtain storage that browser policy may deny. */
export function safeStorage(resolve: () => Storage): Storage | undefined { try { return resolve(); } catch { return undefined; } }

/** 尽力保存非敏感偏好，存储失败不阻断界面。Best-effort persistence of non-sensitive preferences never blocks the UI. */
export function writePreference(storage: Pick<Storage, "setItem"> | undefined, key: "locale" | "theme", value: string): void { try { storage?.setItem(`moe.account.${key}`, value); } catch { /* Private browsing or policy denial: current-page preference still works. */ } }

/** 将主题投影为稳定 DOM 属性。Projects the theme preference to a stable DOM attribute. */
export function applyTheme(theme: Theme, root: HTMLElement, media: Pick<MediaQueryList, "matches">): void {
  root.dataset.themePreference = theme;
  root.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
}

/** 检测常见应用内浏览器，只用于提供兼容提示而不阻断功能。Detects common in-app browsers only to show guidance, never to block features. */
export function isInAppBrowser(userAgent: string): boolean {
  return /MicroMessenger|Weibo|QQ\/|FBAN|FBAV|Instagram|Line\/|wv\)|; wv|WebView/iu.test(userAgent);
}
