import type { AppRoute } from "../router";
import { el } from "./dom";

/** 页面外壳及可替换主内容。Application shell and replaceable main content. */
export interface AppShell {
  root: HTMLElement;
  main: HTMLElement;
  setActiveRoute(route: AppRoute): void;
}

const accountLinks: ReadonlyArray<[AppRoute, string]> = [
  ["/account", "概览"],
  ["/account/passkeys", "Passkeys"],
  ["/account/bindings", "Bindings"],
  ["/account/sessions", "会话"],
  ["/account/recovery", "恢复代码"],
];

/** 构建一次性应用外壳，避免路由切换破坏焦点结构。Builds the persistent application shell without disrupting focus structure. */
export function createShell(): AppShell {
  const navLinks = accountLinks.map(([href, label]) => el("a", { attrs: { href }, dataset: { route: href } }, label));
  const main = el("main", { attrs: { id: "main-content", tabindex: "-1" } });
  const root = el("div", { className: "app-shell" },
    el("header", { className: "site-header" },
      el("a", { className: "brand", attrs: { href: "/login", "aria-label": "moeSegFault Identity 首页" } },
        el("span", { className: "brand__mark", attrs: { "aria-hidden": "true" } }, "✦"),
        el("span", {}, "moeSegFault", el("small", {}, "Identity")),
      ),
      el("nav", { className: "top-nav", attrs: { "aria-label": "账号安全" } }, ...navLinks),
    ),
    main,
    el("footer", { className: "site-footer" },
      el("p", {}, "Passkey-first · 不使用密码 · 敏感状态只在服务端"),
      el("p", { className: "muted" }, "登录界面不加载第三方脚本、字体或追踪器。"),
    ),
  );

  return {
    root,
    main,
    setActiveRoute(route) {
      for (const link of navLinks) {
        const active = link.dataset.route === route;
        if (active) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    },
  };
}

/** 创建页面标题区。Creates a page heading region. */
export function pageHeading(eyebrow: string, title: string, intro: string): HTMLElement {
  return el("header", { className: "page-heading" },
    el("p", { className: "eyebrow" }, eyebrow),
    el("h1", {}, title),
    el("p", { className: "lede" }, intro),
  );
}
