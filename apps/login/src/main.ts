import "./styles.css";
import { IdentityApiClient } from "./api/client";
import { resolveIdentityOrigin } from "./environment";
import { renderPage } from "./pages";
import { installRouter, resolveRoute } from "./router";
import { captureAndScrubTransaction } from "./transaction";
import { createShell } from "./ui/shell";

// 必须先清除 URL 中的事务句柄，再创建任何会发出请求的组件。
// Scrub the transaction handle before constructing anything that may issue requests.
captureAndScrubTransaction(window.location, window.history);

const apiOrigin = resolveIdentityOrigin(window.location, import.meta.env.VITE_IDENTITY_API_ORIGIN);
const api = new IdentityApiClient(apiOrigin);
const mount = document.querySelector<HTMLElement>("#app");
if (!mount) throw new Error("缺少 #app 挂载点 / Missing #app mount point");

const shell = createShell();
mount.append(shell.root);
let activeRender: AbortController | undefined;

/** 取消旧页面请求并呈现当前路由。Cancels stale page requests and renders the current route. */
function renderCurrentRoute(): void {
  activeRender?.abort();
  activeRender = new AbortController();
  const route = resolveRoute(location.pathname);
  shell.setActiveRoute(route);
  document.title = `${routeTitle(route)} · moeSegFault Identity`;
  void renderPage(route, shell.main, api, activeRender.signal).then(() => {
    if (!activeRender?.signal.aborted) shell.main.focus({ preventScroll: true });
  });
}

/** 为路由生成简短、稳定的文档标题。Generates a short, stable document title for a route. */
function routeTitle(route: ReturnType<typeof resolveRoute>): string {
  return {
    "/register": "注册",
    "/login": "登录",
    "/recovery": "恢复账号",
    "/account": "账号",
    "/account/passkeys": "Passkeys",
    "/account/bindings": "Bindings",
    "/account/sessions": "会话",
    "/account/recovery": "恢复代码",
  }[route];
}

installRouter(() => renderCurrentRoute());
renderCurrentRoute();
