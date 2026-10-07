import { ACCOUNT_ROUTES } from "@moesegfault/frontend-shared";

/** 账号中心的稳定一级路由。Stable top-level Account routes. */
export type Route = (typeof ACCOUNT_ROUTES)[number];
const routes: ReadonlySet<string> = new Set(ACCOUNT_ROUTES);

/** An approved link discards only its visible draft; native traversal preserves route-owned values. */
export type NavigationDraftPolicy = "discard-visible" | "preserve";

/** 未知路径回到总览而不是制造错误页。Unknown paths normalize to the overview. */
export function resolveRoute(pathname: string): Route { const clean = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname; return routes.has(clean as Route) ? clean as Route : "/"; }

/** Waits for one same-origin link decision; native traversal invalidates consent without rewriting history. */
export function installRouter(render: (draftPolicy: NavigationDraftPolicy) => void, canNavigate: () => boolean | Promise<boolean> = () => true): () => void {
  let pending = false;
  // A history traversal/disposal invalidates an unresolved link even if its URL later matches again.
  let generation = 0;
  const click = async (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[data-route]");
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self") || anchor.origin !== location.origin) return;
    event.preventDefault();
    if (anchor.href === location.href || pending) return;
    const destination = anchor.href;
    const origin = location.href;
    const owner = generation;
    pending = true;
    try {
      if (!await canNavigate() || owner !== generation || location.href !== origin) return;
      history.pushState(null, "", destination); render("discard-visible");
    } finally { pending = false; }
  };
  const traverse = () => { generation++; render("preserve"); };
  document.addEventListener("click", click); window.addEventListener("popstate", traverse);
  return () => { generation++; document.removeEventListener("click", click); window.removeEventListener("popstate", traverse); };
}
