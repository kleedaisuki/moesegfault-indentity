import type { MessageKey } from "../i18n";
import { el, icon } from "./dom";

type Translate = (key: MessageKey) => string;

/** 匿名页的已验证导航目标。Validated navigation targets for the anonymous landing page. */
export interface AnonymousLandingLinks { signInHref: string; registerHref: string; }

const features: ReadonlyArray<[MessageKey, MessageKey, string]> = [
  ["landingProfileTitle", "landingProfileBody", "user"],
  ["landingSecurityTitle", "landingSecurityBody", "shield"],
  ["landingControlTitle", "landingControlBody", "apps"],
];

/**
 * 创建账号中心的公开介绍页，并将登录操作绑定到调用方提供的安全深链接。
 * Creates the public Account Center introduction and binds its sign-in action to the caller-provided safe deep link.
 *
 * @example
 * ```ts
 * main.replaceChildren(createAnonymousLanding(t, {
 *   signInHref: "https://login.example/login?return_uri=...",
 *   registerHref: "https://login.example/register",
 * }));
 * ```
 */
export function createAnonymousLanding(t: Translate, links: AnonymousLandingLinks): HTMLElement {
  const featureList = el("ul", { className: "landing-features" }, ...features.map(([title, body, iconName]) =>
    el("li", { className: "landing-feature moe-glass" },
      el("span", { className: "landing-feature-icon" }, icon(iconName)),
      el("div", {}, el("h2", {}, t(title)), el("p", {}, t(body))),
    ),
  ));

  return el("section", { className: "anonymous-landing", attrs: { "aria-labelledby": "landing-title" } },
    el("div", { className: "landing-hero" },
      el("div", { className: "landing-copy" },
        el("p", { className: "eyebrow" }, t("landingEyebrow")),
        el("h1", { attrs: { id: "landing-title" } }, t("landingTitle")),
        el("p", { className: "landing-lede" }, t("landingBody")),
        el("div", { className: "landing-actions" },
          el("a", { className: "button primary landing-login", attrs: { href: links.signInHref } }, icon("key"), t("landingSignIn")),
          el("a", { className: "button quiet landing-register", attrs: { href: links.registerHref } }, t("landingCreateAccount")),
        ),
        el("span", { className: "landing-reassurance" }, icon("shield"), t("landingReassurance")),
      ),
      el("div", { className: "landing-orbit moe-glass", attrs: { "aria-hidden": "true" } },
        el("span", { className: "landing-orbit-logo" }, el("img", { attrs: { src: "/icons/logo.svg", alt: "" } })),
        el("span", { className: "landing-orbit-item orbit-profile" }, icon("user")),
        el("span", { className: "landing-orbit-item orbit-security" }, icon("shield")),
        el("span", { className: "landing-orbit-item orbit-apps" }, icon("apps")),
      ),
    ),
    el("div", { className: "landing-section-heading" },
      el("p", { className: "eyebrow" }, t("landingFeaturesEyebrow")),
      el("h2", {}, t("landingFeaturesTitle")),
    ),
    featureList,
  );
}
