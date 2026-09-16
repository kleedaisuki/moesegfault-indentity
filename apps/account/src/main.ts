import "./styles.css";
import { AccountApiClient, ApiError } from "./api/client";
import { accountLoginUrl, resolveIdentityOrigin, resolveLoginOrigin } from "./environment";
import { normalizeLocale, translator } from "./i18n";
import { applyTheme, isInAppBrowser, readPreferences, safeStorage, writePreference, type Theme } from "./preferences";
import { renderPage } from "./pages";
import { installRouter, resolveRoute } from "./router";
import { el, icon, replace } from "./ui/dom";
import { createShell } from "./ui/shell";
import { localeOptions } from "./ui/locale-select";
import { authenticatedSession, type AccountSession } from "./session";

const mount = document.querySelector<HTMLElement>("#app");
if (!mount) throw new Error("Missing #app mount point");
const media = matchMedia("(prefers-color-scheme: dark)");
const storage = safeStorage(() => window.localStorage);
const preferences = readPreferences(storage, navigator.language);
let locale = preferences.locale;
let theme = preferences.theme;
let t = translator(locale);
applyTheme(theme, document.documentElement, media);
document.documentElement.lang = locale;

const shell = createShell(t, isInAppBrowser(navigator.userAgent), logoutUrl());
let session: AccountSession = { status: "pending" };
let active: AbortController | undefined;
const api = new AccountApiClient(resolveIdentityOrigin(location, import.meta.env.VITE_IDENTITY_API_ORIGIN), undefined, becomeAnonymous);
shell.setSession(session);
mount.append(shell.root);
installPreferenceControls();

/** 路由切换时取消旧请求，防止过期页面回写。Cancels stale requests on navigation to prevent old pages writing back. */
async function renderCurrent(reloadSession = false): Promise<void> {
  active?.abort(); active = new AbortController(); const signal = active.signal;
  const route = resolveRoute(location.pathname); shell.setRoute(route);
  document.title = `${t(route === "/" ? "overview" : route.slice(1) as "profile" | "security" | "sessions" | "apps")} · moeSegFault`;
  if (session.status === "anonymous") { renderAnonymous(); return; }
  replace(shell.main, el("div", { className: "loading", attrs: { role: "status" } }, icon("sparkle"), t("loading")));
  try {
    if (session.status === "pending" || reloadSession) {
      const [envelope, loadedPreferences] = await Promise.all([api.getMe(signal), api.getPreferences(signal)]);
      if (signal.aborted) return;
      session = authenticatedSession(envelope, loadedPreferences);
      shell.setSession(session);
    }
    if (session.status !== "authenticated") return;
    await renderPage(route, shell.main, { api, account: session.account, preferences: session.preferences, csrfToken: session.csrfToken, locale, t, signal, refresh: refreshCurrent });
    if (!signal.aborted) shell.main.focus({ preventScroll: true });
  } catch (error) {
    if (!signal.aborted) renderFailure(error);
  }
}

/** 从服务重新读取账号与 CSRF token 后刷新页面。Reloads account and CSRF state before rerendering. */
async function refreshCurrent(): Promise<void> { await renderCurrent(true); }

/** 任意 401 都原子地清空鉴权态并渲染匿名外壳。Any 401 atomically clears authenticated state and renders the anonymous shell. */
function becomeAnonymous(): void {
  session = { status: "anonymous" };
  active?.abort();
  shell.setSession(session);
  renderAnonymous();
}

/** 保留当前深链接的匿名登录提示。Renders the anonymous sign-in prompt while preserving the current deep link. */
function renderAnonymous(): void {
  const route = resolveRoute(location.pathname);
  const signIn = el("a", { className: "button primary", attrs: { href: loginUrl(route) } }, t("signIn"));
  replace(shell.main, el("section", { className: "failure card moe-glass", attrs: { role: "status" } }, icon("key"), el("h1", {}, t("notSignedIn")), el("p", {}, t("notSignedInBody")), signIn));
  shell.main.focus({ preventScroll: true });
}

/** 失败页面区分未登录与可重试故障。Failure UI distinguishes unauthenticated and retryable states. */
function renderFailure(error: unknown): void {
  const unauthenticated = error instanceof ApiError && error.status === 401;
  if (unauthenticated) { becomeAnonymous(); return; }
  replace(shell.main, el("section", { className: "failure card moe-glass", attrs: { role: "alert" } }, icon("shield"), el("h1", {}, t("errorTitle")), el("p", {}, error instanceof ApiError ? error.message : t("unexpectedError")), retryButton()));
}

/** 重试按钮。Retry button. */
function retryButton(): HTMLButtonElement { const button = el("button", { className: "button primary" }, t("retry")); button.addEventListener("click", () => void refreshCurrent()); return button; }

/** 顶栏中的语言和主题偏好只保存非敏感数据。Header controls persist only non-sensitive language and theme preferences. */
function installPreferenceControls(): void {
  for (const target of shell.controls) {
    const language = el("select", { className: "compact-select", attrs: { "aria-label": t("language") } }, ...localeOptions(locale));
    language.addEventListener("change", () => { locale = normalizeLocale(language.value); writePreference(storage, "locale", locale); location.reload(); });
    const themeButton = el("button", { className: "icon-button", attrs: { type: "button", title: t("appearance"), "aria-label": t("appearance") } }, icon(theme === "dark" ? "moon" : "palette"));
    themeButton.addEventListener("click", () => { const order: Theme[] = ["system", "light", "dark"]; theme = order[(order.indexOf(theme) + 1) % order.length] ?? "system"; writePreference(storage, "theme", theme); applyTheme(theme, document.documentElement, media); installPreferenceControls(); });
    target.replaceChildren(language, themeButton);
  }
  media.addEventListener("change", () => { if (theme === "system") applyTheme(theme, document.documentElement, media); });
}

/** 登录页使用同环境 origin 并保留已规范化的深链接。Keeps the Login origin paired and preserves a normalized deep link. */
export function loginUrl(route: ReturnType<typeof resolveRoute> = resolveRoute(location.pathname)): string {
  return accountLoginUrl(location, route);
}

/** 退出端点使用允许的账号站回跳 URI。Logout endpoint uses an allowlisted Account post-logout URI. */
function logoutUrl(): string { const identity = resolveIdentityOrigin(location, import.meta.env.VITE_IDENTITY_API_ORIGIN); const login = new URL("/login", resolveLoginOrigin(location)).href; return `${identity}/v1/oidc/logout-requests?post_logout_redirect_uri=${encodeURIComponent(login)}`; }

installRouter(() => void renderCurrent());
void renderCurrent();
