import type { MessageKey } from "../i18n";
import type { Route } from "../router";
import { el, icon } from "./dom";
import type { AccountSession } from "../session";

/** 持久账号应用外壳。Persistent Account application shell. */
export interface Shell { root: HTMLElement; main: HTMLElement; controls: HTMLElement[]; setRoute(route: Route): void; setSession(session: AccountSession): void; relocalize(next: (key: MessageKey) => string): void; }

const nav: ReadonlyArray<[Route, MessageKey, string]> = [["/", "overview", "sparkle"], ["/profile", "profile", "user"], ["/security", "security", "shield"], ["/sessions", "sessions", "devices"], ["/apps", "apps", "apps"], ["/subscriptions", "subscriptions", "apps"]];

/** 创建桌面侧栏与移动底栏共享语义的导航外壳。Creates a shell whose desktop rail and mobile bar share navigation semantics. */
export function createShell(t: (key: MessageKey) => string, inApp: boolean, signOut: () => Promise<void>): Shell {
  const links = nav.map(([href, label, iconName]) => el("a", { className: "nav-link", attrs: { href }, dataset: { route: href } }, icon(iconName), el("span", {}, t(label))));
  const userName = el("strong");
  const avatar = el("img", { className: "mini-avatar", attrs: { alt: "", src: "/icons/logo.svg" } });
  const main = el("main", { attrs: { id: "main", tabindex: "-1" } });
  const mobileControls = el("div", { className: "header-controls" });
  const desktopControls = el("div", { className: "header-controls desktop-controls" });
  const sideNav = el("nav", { className: "side-nav", attrs: { "aria-label": t("account"), hidden: true } }, ...links);
  const userChip = el("button", { className: "user-chip", attrs: { type: "button", hidden: true } }, avatar, el("span", {}, userName, el("small", {}, t("signOut"))), icon("logout"));
  const mobileSignOut = el("button", { className: "icon-button mobile-sign-out", attrs: { type: "button", hidden: true, title: t("signOut"), "aria-label": t("signOut") } }, icon("logout"));
  const signOutButtons = [userChip, mobileSignOut];
  // Both responsive surfaces share one command lock, including during viewport changes.
  for (const control of signOutButtons) control.addEventListener("click", async () => {
    if (userChip.disabled) return;
    for (const button of signOutButtons) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
    try { await signOut(); }
    finally { for (const button of signOutButtons) { button.disabled = false; button.removeAttribute("aria-busy"); } }
  });
  const banner = inApp ? inAppBanner((key) => t(key)) : undefined;
  banner?.setAttribute("hidden", "");
  const bottomNav = el("nav", { className: "bottom-nav", attrs: { "aria-label": t("account"), hidden: true } }, ...links.map((link) => link.cloneNode(true) as HTMLAnchorElement));
  const root = el("div", { className: "app-shell" },
    el("header", { className: "mobile-header moe-glass" }, el("a", { className: "brand", attrs: { href: "/" }, dataset: { route: "/" } }, el("img", { attrs: { src: "/icons/logo.svg", alt: "" } }), "moeSegFault", el("small", {}, t("account"))), mobileControls, mobileSignOut),
    el("aside", { className: "sidebar" },
      el("a", { className: "brand desktop-brand", attrs: { href: "/" }, dataset: { route: "/" } }, el("img", { attrs: { src: "/icons/logo.svg", alt: "" } }), el("span", {}, "moeSegFault", el("small", {}, t("account")))),
      sideNav,
      desktopControls,
      userChip,
    ),
    banner,
    main,
    bottomNav,
  );
  return {
    root,
    main,
    controls: [mobileControls, desktopControls],
    relocalize(next) {
      t = next;
      for (const link of root.querySelectorAll<HTMLAnchorElement>(".nav-link")) {
        const entry = nav.find(([route]) => route === link.dataset.route);
        if (entry) link.querySelector("span")!.textContent = t(entry[1]);
      }
      for (const label of root.querySelectorAll(".brand small")) label.textContent = t("account");
      for (const navigation of [sideNav, bottomNav]) navigation.setAttribute("aria-label", t("account"));
      userChip.querySelector("small")!.textContent = t("signOut");
      mobileSignOut.setAttribute("aria-label", t("signOut")); mobileSignOut.title = t("signOut");
      if (banner) {
        banner.querySelector("span")!.textContent = t("inApp");
        const copy = banner.querySelector("button");
        if (copy) copy.textContent = t(copy.dataset.copied ? "copied" : "copyLink");
      }
    },
    setRoute(route) { for (const link of root.querySelectorAll<HTMLAnchorElement>("[data-route]")) link.toggleAttribute("aria-current", link.dataset.route === route); },
    setSession(session) {
      const authenticated = session.status === "authenticated";
      for (const element of [sideNav, ...signOutButtons, bottomNav, banner]) element?.toggleAttribute("hidden", !authenticated);
      if (!authenticated) { userName.textContent = ""; avatar.src = "/icons/logo.svg"; return; }
      userName.textContent = session.account.profile.display_name;
      avatar.src = session.account.profile.avatar_url || "/icons/logo.svg";
    },
  };
}

/** 提供不夸大能力的应用内浏览器提示与复制回退。Provides truthful in-app guidance with a copy-link fallback. */
function inAppBanner(t: (key: MessageKey) => string): HTMLElement {
  const copy = el("button", { className: "button quiet", attrs: { type: "button" } }, t("copyLink"));
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); copy.dataset.copied = "true"; copy.textContent = t("copied"); }
    catch { const field = el("input", { attrs: { value: location.href, readonly: true } }); copy.replaceWith(field); field.select(); }
  });
  return el("div", { className: "in-app-banner", attrs: { role: "status" } }, icon("phone"), el("span", {}, t("inApp")), copy);
}
