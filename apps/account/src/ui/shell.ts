import type { MessageKey } from "../i18n";
import type { Route } from "../router";
import { el, icon } from "./dom";

/** 持久账号应用外壳。Persistent Account application shell. */
export interface Shell { root: HTMLElement; main: HTMLElement; controls: HTMLElement[]; setRoute(route: Route): void; setUser(name: string, avatar?: string | null): void; }

const nav: ReadonlyArray<[Route, MessageKey, string]> = [["/", "overview", "sparkle"], ["/profile", "profile", "user"], ["/security", "security", "shield"], ["/sessions", "sessions", "devices"], ["/apps", "apps", "apps"]];

/** 创建桌面侧栏与移动底栏共享语义的导航外壳。Creates a shell whose desktop rail and mobile bar share navigation semantics. */
export function createShell(t: (key: MessageKey) => string, inApp: boolean, logoutUrl: string): Shell {
  const links = nav.map(([href, label, iconName]) => el("a", { className: "nav-link", attrs: { href }, dataset: { route: href } }, icon(iconName), el("span", {}, t(label))));
  const userName = el("strong", {}, "…");
  const avatar = el("img", { className: "mini-avatar", attrs: { alt: "", src: "/icons/logo.svg" } });
  const main = el("main", { attrs: { id: "main", tabindex: "-1" } });
  const mobileControls = el("div", { className: "header-controls" });
  const desktopControls = el("div", { className: "header-controls desktop-controls" });
  const root = el("div", { className: "app-shell" },
    el("header", { className: "mobile-header moe-glass" }, el("a", { className: "brand", attrs: { href: "/" }, dataset: { route: "/" } }, el("img", { attrs: { src: "/icons/logo.svg", alt: "" } }), "moeSegFault", el("small", {}, t("account"))), mobileControls),
    el("aside", { className: "sidebar" },
      el("a", { className: "brand desktop-brand", attrs: { href: "/" }, dataset: { route: "/" } }, el("img", { attrs: { src: "/icons/logo.svg", alt: "" } }), el("span", {}, "moeSegFault", el("small", {}, t("account")))),
      el("nav", { className: "side-nav", attrs: { "aria-label": t("account") } }, ...links),
      desktopControls,
      el("a", { className: "user-chip", attrs: { href: logoutUrl } }, avatar, el("span", {}, userName, el("small", {}, t("signOut"))), icon("logout")),
    ),
    inApp ? inAppBanner(t) : null,
    main,
    el("nav", { className: "bottom-nav", attrs: { "aria-label": t("account") } }, ...links.map((link) => link.cloneNode(true) as HTMLAnchorElement)),
  );
  return { root, main, controls: [mobileControls, desktopControls], setRoute(route) { for (const link of root.querySelectorAll<HTMLAnchorElement>("[data-route]")) link.toggleAttribute("aria-current", link.dataset.route === route); }, setUser(name, url) { userName.textContent = name; avatar.src = url || "/icons/logo.svg"; } };
}

/** 提供不夸大能力的应用内浏览器提示与复制回退。Provides truthful in-app guidance with a copy-link fallback. */
function inAppBanner(t: (key: MessageKey) => string): HTMLElement {
  const copy = el("button", { className: "button quiet", attrs: { type: "button" } }, t("copyLink"));
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); copy.textContent = t("copied"); }
    catch { const field = el("input", { attrs: { value: location.href, readonly: true } }); copy.replaceWith(field); field.select(); }
  });
  return el("div", { className: "in-app-banner", attrs: { role: "status" } }, icon("phone"), el("span", {}, t("inApp")), copy);
}
