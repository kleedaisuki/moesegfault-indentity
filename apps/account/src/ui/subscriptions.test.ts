// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderSubscriptions, subscriptionOrigin, subscriptionReconnectUrl, subscriptionViewerUrl } from "./subscriptions";
import { translator } from "../i18n";
import type { PageContext } from "../pages";

/** Exercises the cross-origin presentation contract without bypassing either session boundary. */
describe("subscription integration", () => {
  it("pairs fixed origins and never accepts a caller-selected hostname as an origin", () => {
    expect(subscriptionOrigin("account-staging.moesegfault.dev")).toBe("https://subscribe-staging.moesegfault.dev");
    expect(subscriptionOrigin("account.moesegfault.dev")).toBe("https://subscribe.moesegfault.dev");
    expect(subscriptionOrigin("localhost")).toBe("http://localhost:8788");
    expect(subscriptionOrigin("attacker.example")).toBe("https://subscribe.moesegfault.dev");
  });
  it("passes only locale and effective theme, never Account identifiers or credentials", () => {
    const url = new URL(subscriptionViewerUrl("account-staging.moesegfault.dev", "ja", "dark"));
    expect(url.pathname).toBe("/account");
    expect(Object.fromEntries(url.searchParams)).toEqual({ embedded: "1", locale: "ja", theme: "dark" });
    expect(new URL(subscriptionViewerUrl("localhost", "en", undefined)).searchParams.get("theme")).toBe("light");
  });
  it("reconnects through top-level OIDC with an exact same-environment return route", () => {
    const url = new URL(subscriptionReconnectUrl("account-staging.moesegfault.dev"));
    expect(url.origin).toBe("https://subscribe-staging.moesegfault.dev");
    expect(url.pathname).toBe("/auth/login");
    expect(url.searchParams.get("path")).toBe("/account");
    expect(url.searchParams.get("return_to")).toBe("https://account-staging.moesegfault.dev/subscriptions");
  });
  it("keeps the subscription session distinction visible in every language", () => {
    for (const locale of ["zh-CN", "en", "ja"] as const) {
      const main = document.createElement("main");
      const t = translator(locale);
      const controller = new AbortController();
      renderSubscriptions(main, { locale, t, signal: controller.signal } as PageContext);
      expect(main.textContent).toContain(t("subscriptionBoundary"));
      expect(main.querySelector("iframe")?.title).toBe(t("subscriptionViewer"));
      expect(main.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-top-navigation-by-user-activation");
      expect(main.querySelectorAll("a")).toHaveLength(2);
      expect(main.querySelector("a")?.getAttribute("target")).toBeNull();
      controller.abort();
    }
  });
});
