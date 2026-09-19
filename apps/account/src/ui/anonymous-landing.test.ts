// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { translator } from "../i18n";
import { createAnonymousLanding } from "./anonymous-landing";

describe("anonymous Account Center landing", () => {
  it("renders a promotional landmark and a single deep-link-aware sign-in action", () => {
    const href = "https://login.moesegfault.dev/login?return_uri=https%3A%2F%2Faccount.moesegfault.dev%2Fsecurity";
    const landing = createAnonymousLanding(translator("en"), href);

    expect(landing.matches("section.anonymous-landing[aria-labelledby=landing-title]")).toBe(true);
    expect(landing.querySelector("h1")?.textContent).toContain("identity");
    expect(landing.querySelectorAll(".landing-feature")).toHaveLength(3);
    expect(landing.querySelectorAll("a")).toHaveLength(1);
    expect(landing.querySelector<HTMLAnchorElement>(".landing-login")?.href).toBe(href);
    expect(landing.querySelector("[role=alert], .failure")).toBeNull();
  });

  it.each(["zh-CN", "en", "ja"] as const)("localizes all public landing copy in %s", (locale) => {
    const landing = createAnonymousLanding(translator(locale), "/login");
    expect(landing.querySelector("h1")?.textContent).toBe(translator(locale)("landingTitle"));
    expect(landing.querySelector(".landing-login")?.textContent).toContain(translator(locale)("landingSignIn"));
    expect(landing.textContent).not.toContain("undefined");
  });
});
