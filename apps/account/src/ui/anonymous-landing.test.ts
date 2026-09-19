// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { translator } from "../i18n";
import { createAnonymousLanding } from "./anonymous-landing";

describe("anonymous Account Center landing", () => {
  it("renders a dominant deep-link sign-in action and a paired registration link", () => {
    const signInHref = "https://login.moesegfault.dev/login?return_uri=https%3A%2F%2Faccount.moesegfault.dev%2Fsecurity";
    const registerHref = "https://login.moesegfault.dev/register";
    const landing = createAnonymousLanding(translator("en"), { signInHref, registerHref });

    expect(landing.matches("section.anonymous-landing[aria-labelledby=landing-title]")).toBe(true);
    expect(landing.querySelector("h1")?.textContent).toContain("identity");
    expect(landing.querySelectorAll(".landing-feature")).toHaveLength(3);
    expect(landing.querySelectorAll("a")).toHaveLength(2);
    expect(landing.querySelector<HTMLAnchorElement>(".landing-login")?.href).toBe(signInHref);
    expect(landing.querySelector(".landing-login")?.classList.contains("primary")).toBe(true);
    expect(landing.querySelector<HTMLAnchorElement>(".landing-register")?.href).toBe(registerHref);
    expect(landing.querySelector(".landing-register")?.classList.contains("quiet")).toBe(true);
    expect(landing.querySelector("[role=alert], .failure")).toBeNull();
  });

  it.each(["zh-CN", "en", "ja"] as const)("localizes all public landing copy in %s", (locale) => {
    const landing = createAnonymousLanding(translator(locale), { signInHref: "/login", registerHref: "/register" });
    expect(landing.querySelector("h1")?.textContent).toBe(translator(locale)("landingTitle"));
    expect(landing.querySelector(".landing-login")?.textContent).toContain(translator(locale)("landingSignIn"));
    expect(landing.querySelector(".landing-register")?.textContent).toBe(translator(locale)("landingCreateAccount"));
    expect(landing.textContent).not.toContain("undefined");
  });
});
