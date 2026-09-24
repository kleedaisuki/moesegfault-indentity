import { ACCOUNT_ROUTES } from "@moesegfault/frontend-shared";

/** 账号中心的稳定一级路由。Stable top-level Account routes. */
export type Route = (typeof ACCOUNT_ROUTES)[number];
const routes: ReadonlySet<string> = new Set(ACCOUNT_ROUTES);

/** 未知路径回到总览而不是制造错误页。Unknown paths normalize to the overview. */
export function resolveRoute(pathname: string): Route { const clean = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname; return routes.has(clean as Route) ? clean as Route : "/"; }

/** 安装同源 History API 导航。Installs same-origin History API navigation. */
export function installRouter(render: () => void): () => void {
  const click = (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[data-route]");
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || anchor.origin !== location.origin) return;
    event.preventDefault(); history.pushState(null, "", anchor.href); render();
  };
  document.addEventListener("click", click); window.addEventListener("popstate", render);
  return () => { document.removeEventListener("click", click); window.removeEventListener("popstate", render); };
}
