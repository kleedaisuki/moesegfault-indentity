import type { Locale } from "../i18n";
import type { PageContext } from "../pages";
import { resolveAccountOrigin } from "../environment";
import { el, replace } from "./dom";

/** Selects a fixed subscription origin without crossing staging into production. */
export function subscriptionOrigin(hostname: string): string {
  if (hostname === "account-staging.moesegfault.dev") return "https://subscribe-staging.moesegfault.dev";
  if (hostname === "localhost" || hostname === "127.0.0.1") return "http://localhost:8788";
  return "https://subscribe.moesegfault.dev";
}

/** Builds presentation-only iframe parameters; no Account credentials or identifiers leave this app. */
export function subscriptionViewerUrl(hostname: string, locale: Locale, theme: string | undefined): string {
  const url = new URL("/account", subscriptionOrigin(hostname));
  url.searchParams.set("embedded", "1");
  url.searchParams.set("locale", locale);
  url.searchParams.set("theme", theme === "dark" ? "dark" : "light");
  return url.href;
}

/** Starts a new Subscribe OIDC transaction; the return destination is an exact paired Account route. */
export function subscriptionReconnectUrl(hostname: string): string {
  const url = new URL("/auth/login", subscriptionOrigin(hostname));
  url.searchParams.set("path", "/account");
  url.searchParams.set("return_to", new URL("/subscriptions", resolveAccountOrigin({ hostname })).href);
  return url.href;
}

/**
 * Renders a separately authenticated subscription view without claiming an Identity-to-OIDC subject join.
 * Subscribe owns tokens and the viewer identity. The parent only supplies locale/theme and fixed links.
 */
export function renderSubscriptions(main: HTMLElement, c: PageContext): void {
  const heading = el("div", { className: "page-heading" }, el("h1", {}, c.t("subscriptions")), el("p", { className: "muted" }, c.t("subscriptionsIntro")));
  const frame = el("iframe", { className: "subscription-viewer", attrs: {
    src: subscriptionViewerUrl(location.hostname, c.locale, document.documentElement.dataset.theme),
    title: c.t("subscriptionViewer"), referrerpolicy: "no-referrer",
    sandbox: "allow-scripts allow-same-origin allow-top-navigation-by-user-activation",
  } });
  // Theme changes reload only this read-only viewer, never restart authentication.
  const observer = new MutationObserver(() => {
    frame.src = subscriptionViewerUrl(location.hostname, c.locale, document.documentElement.dataset.theme);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  c.signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  replace(main, heading, el("section", { className: "card moe-glass" },
    el("p", { className: "muted" }, c.t("subscriptionBoundary")),
    el("div", { className: "subscription-actions" },
      el("a", { className: "button primary", attrs: { href: subscriptionOrigin(location.hostname) } }, c.t("manageSubscriptions")),
      el("a", { className: "button quiet", attrs: { href: subscriptionReconnectUrl(location.hostname) } }, c.t("reconnectSubscriptions")),
    ), frame,
  ));
}
