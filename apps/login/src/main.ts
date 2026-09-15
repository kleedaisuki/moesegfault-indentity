import "./styles.css";
import { IdentityApiClient } from "./api/client";
import { resolveAccountOrigin, resolveIdentityOrigin } from "./environment";
import { renderPage } from "./pages";
import { installRouter, resolveRoute } from "./router";
import { captureAndScrubTransaction } from "./transaction";
import { createShell } from "./ui/shell";
import { detectInAppBrowser } from "./browser";
import { applyPreferences, readPreferences } from "./preferences";
import type { DisplayPreferences } from "./preferences";
import { translate } from "./i18n";

// 必须先清除 URL 中的事务句柄，再创建任何会发出请求的组件。
// Scrub the transaction handle before constructing anything that may issue requests.
captureAndScrubTransaction(window.location, window.history);

const apiOrigin = resolveIdentityOrigin(window.location, import.meta.env.VITE_IDENTITY_API_ORIGIN);
const api = new IdentityApiClient(apiOrigin);
const mount = document.querySelector<HTMLElement>("#app");
if (!mount) throw new Error("缺少 #app 挂载点 / Missing #app mount point");

let activeRender: AbortController | undefined;
let preferenceStorage: Storage | undefined;
try { preferenceStorage = window.localStorage; } catch { preferenceStorage = undefined; }
let preferences: DisplayPreferences = readPreferences(preferenceStorage, navigator.language);
applyPreferences(preferences, preferenceStorage);
let shell: ReturnType<typeof createShell>;

/** 使用最新偏好重建静态外壳。Rebuilds the static shell with the latest preferences. */
function buildShell(): void {
  const skipLink = document.querySelector<HTMLAnchorElement>(".skip-link");
  if (skipLink) skipLink.textContent = translate(preferences.locale, "skipLink");
  shell = createShell({ locale: preferences.locale, theme: preferences.theme, accountOrigin: resolveAccountOrigin(window.location), inAppBrowser: detectInAppBrowser(navigator.userAgent).name,
    onLocale(locale) { preferences = { ...preferences, locale }; applyPreferences(preferences, preferenceStorage); buildShell(); renderCurrentRoute(); },
    onTheme(theme) { preferences = { ...preferences, theme }; applyPreferences(preferences, preferenceStorage); },
  });
  mount?.replaceChildren(shell.root);
}
buildShell();

/** 取消旧页面请求并呈现当前路由。Cancels stale page requests and renders the current route. */
function renderCurrentRoute(): void {
  activeRender?.abort();
  activeRender = new AbortController();
  const route = resolveRoute(location.pathname);
  shell.setActiveRoute(route);
  document.title = `${routeTitle(route, preferences.locale)} · moeSegFault Identity`;
  void renderPage(route, shell.main, api, activeRender.signal, { locale: preferences.locale }).then(() => {
    if (!activeRender?.signal.aborted) shell.main.focus({ preventScroll: true });
  });
}

/** 为路由生成简短、稳定的文档标题。Generates a short, stable document title for a route. */
function routeTitle(route: ReturnType<typeof resolveRoute>, locale: DisplayPreferences["locale"]): string {
  return {
    "/register": translate(locale, "register"),
    "/login": translate(locale, "login"),
    "/recovery": translate(locale, "recovery"),
    "/passkey/enroll": translate(locale, "enrollTitle"),
    "/recovery-codes/rotate": translate(locale, "rotateTitle"),
  }[route];
}

installRouter(() => renderCurrentRoute());
renderCurrentRoute();
