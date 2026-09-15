import "./styles.css";
import { AccountApiClient, ApiError } from "./api/client";
import type { Account, AccountPreferences } from "./api/types";
import { resolveIdentityOrigin } from "./environment";
import { normalizeLocale, translator } from "./i18n";
import { applyTheme, isInAppBrowser, readPreferences, type Theme } from "./preferences";
import { renderPage } from "./pages";
import { installRouter, resolveRoute } from "./router";
import { el, icon, replace } from "./ui/dom";
import { createShell } from "./ui/shell";

const mount = document.querySelector<HTMLElement>("#app");
if (!mount) throw new Error("Missing #app mount point");
const media = matchMedia("(prefers-color-scheme: dark)");
const preferences = readPreferences(localStorage, navigator.language);
let locale = preferences.locale;
let theme = preferences.theme;
let t = translator(locale);
applyTheme(theme, document.documentElement, media);
document.documentElement.lang = locale;

const api = new AccountApiClient(resolveIdentityOrigin(location, import.meta.env.VITE_IDENTITY_API_ORIGIN));
const shell = createShell(t, isInAppBrowser(navigator.userAgent));
mount.append(shell.root);
installPreferenceControls();
let active: AbortController | undefined;
let account: Account | undefined;
let serverPreferences: AccountPreferences | undefined;
let csrfToken: string | undefined;

/** 路由切换时取消旧请求，防止过期页面回写。Cancels stale requests on navigation to prevent old pages writing back. */
async function renderCurrent(): Promise<void> {
  active?.abort(); active = new AbortController(); const signal = active.signal;
  const route = resolveRoute(location.pathname); shell.setRoute(route);
  document.title = `${t(route === "/" ? "overview" : route.slice(1) as "profile" | "security" | "sessions" | "apps")} · moeSegFault`;
  replace(shell.main, el("div", { className: "loading", attrs: { role: "status" } }, icon("sparkle"), t("loading")));
  try {
    if (!account || !csrfToken || !serverPreferences) {
      const [envelope, loadedPreferences] = await Promise.all([api.getMe(signal), api.getPreferences(signal)]); account = envelope.account; csrfToken = envelope.csrf_token; serverPreferences = loadedPreferences;
      shell.setUser(account.profile.display_name, account.profile.avatar_url);
    }
    await renderPage(route, shell.main, { api, account, preferences: serverPreferences, csrfToken, locale, t, signal, refresh: refreshCurrent });
    if (!signal.aborted) shell.main.focus({ preventScroll: true });
  } catch (error) {
    if (!signal.aborted) renderFailure(error);
  }
}

/** 从服务重新读取账号与 CSRF token 后刷新页面。Reloads account and CSRF state before rerendering. */
async function refreshCurrent(): Promise<void> { account = undefined; serverPreferences = undefined; csrfToken = undefined; await renderCurrent(); }

/** 失败页面区分未登录与可重试故障。Failure UI distinguishes unauthenticated and retryable states. */
function renderFailure(error: unknown): void {
  const unauthenticated = error instanceof ApiError && error.status === 401;
  replace(shell.main, el("section", { className: "failure card moe-glass", attrs: { role: "alert" } }, icon(unauthenticated ? "key" : "shield"), el("h1", {}, unauthenticated ? t("notSignedIn") : "Oops, something segfaulted"), el("p", {}, unauthenticated ? t("notSignedInBody") : error instanceof Error ? error.message : "Unexpected error"), unauthenticated ? el("a", { className: "button primary", attrs: { href: loginUrl() } }, t("signIn")) : retryButton()));
}

/** 重试按钮。Retry button. */
function retryButton(): HTMLButtonElement { const button = el("button", { className: "button primary" }, t("retry")); button.addEventListener("click", () => void refreshCurrent()); return button; }

/** 顶栏中的语言和主题偏好只保存非敏感数据。Header controls persist only non-sensitive language and theme preferences. */
function installPreferenceControls(): void {
  const language = el("select", { className: "compact-select", attrs: { "aria-label": t("language") } }, ...([["zh-CN", "中"], ["en", "EN"], ["ja", "日"]] as const).map(([value, label]) => el("option", { attrs: { value, selected: locale === value } }, label)));
  language.addEventListener("change", () => { locale = normalizeLocale(language.value); localStorage.setItem("moe.account.locale", locale); location.reload(); });
  const themeButton = el("button", { className: "icon-button", attrs: { type: "button", title: t("appearance"), "aria-label": t("appearance") } }, icon(theme === "dark" ? "moon" : "palette"));
  themeButton.addEventListener("click", () => { const order: Theme[] = ["system", "light", "dark"]; theme = order[(order.indexOf(theme) + 1) % order.length] ?? "system"; localStorage.setItem("moe.account.theme", theme); applyTheme(theme, document.documentElement, media); themeButton.replaceChildren(icon(theme === "dark" ? "moon" : "palette")); themeButton.title = t(theme); });
  shell.controls.append(language, themeButton);
  media.addEventListener("change", () => { if (theme === "system") applyTheme(theme, document.documentElement, media); });
}

/** 登录页 origin 与环境一致。Keeps the Login origin in the same environment. */
function loginUrl(): string { return location.hostname.includes("staging") ? "https://login-staging.moesegfault.dev/login" : "https://login.moesegfault.dev/login"; }

installRouter(() => void renderCurrent());
void renderCurrent();
