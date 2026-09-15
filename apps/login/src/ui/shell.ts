import type { AppRoute } from "../router";
import type { Locale, MessageKey } from "../i18n";
import { translate } from "../i18n";
import type { Theme } from "../preferences";
import { el } from "./dom";
import { icon } from "./icons";

/** 页面外壳及可替换主内容。Application shell and replaceable main content. */
export interface AppShell { root: HTMLElement; main: HTMLElement; setActiveRoute(route: AppRoute): void }

/** 外壳中的显示偏好与事件。Display preferences and events used by the shell. */
export interface ShellOptions { locale: Locale; theme: Theme; accountOrigin: string; inAppBrowser?: string; onLocale(locale: Locale): void; onTheme(theme: Theme): void }

/** 构建轻量、可本地化的登录外壳。Builds a lightweight, localizable login shell. */
export function createShell(options: ShellOptions): AppShell {
  const t = (key: MessageKey) => translate(options.locale, key);
  const language = el("select", { className: "toolbar-select", attrs: { "aria-label": t("language") } },
    el("option", { attrs: { value: "zh-CN", selected: options.locale === "zh-CN" } }, "简体中文"),
    el("option", { attrs: { value: "en", selected: options.locale === "en" } }, "English"),
    el("option", { attrs: { value: "ja", selected: options.locale === "ja" } }, "日本語"));
  language.addEventListener("change", () => options.onLocale(language.value as Locale));
  const theme = el("select", { className: "toolbar-select", attrs: { "aria-label": t("theme") } },
    ...(["system", "light", "dark"] as const).map((value) => el("option", { attrs: { value, selected: options.theme === value } }, t(value))));
  theme.addEventListener("change", () => options.onTheme(theme.value as Theme));
  const main = el("main", { attrs: { id: "main-content", tabindex: "-1" } });
  const links = (["/login", "/register"] as AppRoute[]).map((href) => el("a", { attrs: { href }, dataset: { route: href } }, t(href === "/login" ? "login" : "register")));
  const root = el("div", { className: "app-shell" },
    el("header", { className: "site-header" },
      el("a", { className: "brand", attrs: { href: "/login", "aria-label": t("brand") } }, el("img", { attrs: { src: "/assets/brand.svg", alt: "", width: "38", height: "38" } }), el("span", {}, "moeSegFault", el("small", {}, "IDENTITY"))),
      el("nav", { className: "top-nav", attrs: { "aria-label": t("brand") } }, ...links),
      el("div", { className: "display-tools" }, icon("globe"), language, icon("moon"), theme)),
    options.inAppBrowser ? inAppNotice(options.inAppBrowser, t) : undefined, main,
    el("footer", { className: "site-footer" }, el("p", {}, t("privacy")), el("a", { attrs: { href: options.accountOrigin } }, t("accountLink"))));
  return { root, main, setActiveRoute(route) { for (const link of links) link.toggleAttribute("aria-current", link.dataset.route === route); } };
}

/** 创建页面标题区。Creates a page heading region. */
export function pageHeading(eyebrow: string, title: string, intro: string): HTMLElement {
  return el("header", { className: "page-heading" }, el("p", { className: "eyebrow" }, eyebrow), el("h1", {}, title), el("p", { className: "lede" }, intro));
}

function inAppNotice(name: string, t: (key: MessageKey) => string): HTMLElement {
  const button = el("button", { className: "text-button", attrs: { type: "button" } }, t("openBrowser"));
  button.addEventListener("click", async () => { try { await navigator.clipboard.writeText(location.href); button.textContent = t("copied"); } catch { window.prompt(t("openBrowser"), location.href); } });
  return el("aside", { className: "browser-notice", attrs: { role: "note" } }, el("strong", {}, `${t("inAppTitle")} · ${name}`), el("span", {}, t("inAppBody")), button);
}
