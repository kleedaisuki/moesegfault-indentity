/** 应用支持的静态路由。Static routes supported by the application. */
export type AppRoute =
  | "/register"
  | "/login"
  | "/recovery"
  | "/account"
  | "/account/passkeys"
  | "/account/bindings"
  | "/account/sessions"
  | "/account/recovery";

const routes = new Set<AppRoute>([
  "/register",
  "/login",
  "/recovery",
  "/account",
  "/account/passkeys",
  "/account/bindings",
  "/account/sessions",
  "/account/recovery",
]);

/** 将任意 pathname 归一到受支持路由。Normalizes any pathname to a supported route. */
export function resolveRoute(pathname: string): AppRoute {
  const normalized = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (normalized === "/") return "/login";
  return routes.has(normalized as AppRoute) ? normalized as AppRoute : "/login";
}

/** 判断 pathname 是否精确对应支持路由。Checks whether a pathname exactly names a supported route. */
export function isAppRoute(pathname: string): boolean {
  const normalized = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return normalized === "/" || routes.has(normalized as AppRoute);
}

/**
 * 安装无框架 History API 路由，仅拦截同源左键导航。
 * Installs framework-free History API routing and intercepts only same-origin primary navigation.
 */
export function installRouter(render: (route: AppRoute) => void): void {
  document.addEventListener("click", (event) => {
    if (!(event instanceof MouseEvent) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!target || target.target || target.download) return;
    const url = new URL(target.href, location.href);
    if (url.origin !== location.origin || !isAppRoute(url.pathname)) return;
    event.preventDefault();
    history.pushState(null, "", `${url.pathname}${url.search}`);
    render(resolveRoute(url.pathname));
  });
  window.addEventListener("popstate", () => render(resolveRoute(location.pathname)));
}

/** 用 History API 导航到站内路由。Navigates to an internal route through the History API. */
export function navigate(route: AppRoute): void {
  history.pushState(null, "", route);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
