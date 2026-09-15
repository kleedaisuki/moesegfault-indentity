import { normalizeLocale, type Locale } from "./i18n";

/** 可选择的配色模式。Selectable color modes. */
export type Theme = "system" | "light" | "dark";

/** 登录页无秘密的显示偏好。Non-secret display preferences for the login page. */
export interface DisplayPreferences { locale: Locale; theme: Theme }

const localeKey = "moesegfault.locale";
const themeKey = "moesegfault.theme";

/** 从可选持久层读取显示偏好；存储不可用时仍可正常工作。Reads preferences while tolerating unavailable storage. */
export function readPreferences(storage: Pick<Storage, "getItem"> | undefined, browserLanguage: string): DisplayPreferences {
  let locale: string | null = null;
  let theme: string | null = null;
  try { locale = storage?.getItem(localeKey) ?? null; theme = storage?.getItem(themeKey) ?? null; } catch { /* Private browser storage may reject access. */ }
  return {
    locale: locale === "zh-CN" || locale === "en" || locale === "ja" ? locale : normalizeLocale(browserLanguage),
    theme: theme === "light" || theme === "dark" || theme === "system" ? theme : "system",
  };
}

/** 应用并尽力保存显示偏好。Applies and best-effort persists display preferences. */
export function applyPreferences(preferences: DisplayPreferences, storage?: Pick<Storage, "setItem">): void {
  document.documentElement.lang = preferences.locale;
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.style.colorScheme = preferences.theme === "system" ? "light dark" : preferences.theme;
  try { storage?.setItem(localeKey, preferences.locale); storage?.setItem(themeKey, preferences.theme); } catch { /* Appearance remains applied in memory. */ }
}
