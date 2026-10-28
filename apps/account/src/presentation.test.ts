// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { renderPage, type PageContext } from "./pages";
import { translator } from "./i18n";
import { createShell } from "./ui/shell";
import { createAnonymousLanding } from "./ui/anonymous-landing";

function context(): PageContext {
  return {
    api: {} as PageContext["api"],
    account: { principal_id: "principal", lifecycle_state: "active", profile: { display_name: "Klee", locale: "en", bio: "Hello, world" }, identifiers: [{ identifier_id: "username", kind: "username", value: "klee", created_at: "", updated_at: "" }], created_at: "", updated_at: "" },
    preferences: { locale: "en", theme: "system", timezone: "Asia/Singapore", reduced_motion: false, compact_mode: false, notifications: { security_email: true } },
    csrfToken: "csrf", locale: "en", t: translator("en"), signal: new AbortController().signal, refresh: vi.fn(async () => undefined),
  };
}

describe("Account presentation hierarchy", () => {
  it("uses one page title and actionable card names instead of repeated brand and introductory labels", async () => {
    const main = document.createElement("main");
    await renderPage("/", main, context());
    expect(main.querySelectorAll("h1")).toHaveLength(1);
    expect(main.querySelector("h1")?.textContent).toBe("Overview");
    expect(main.querySelector(".page-heading .eyebrow, .page-heading .lede")).toBeNull();
    expect(main.querySelectorAll(".quick-card")).toHaveLength(4);
    expect(main.querySelectorAll(".quick-card p")).toHaveLength(0);
    expect(main.querySelector(".hero-card")?.textContent).toContain("Hello, world");
    expect(main.querySelector(".hero-card a")?.getAttribute("href")).toBe("/profile");
  });

  it("announces the current page accurately on both navigation surfaces", () => {
    const shell = createShell(translator("en"), false, async () => undefined);
    shell.setRoute("/security");
    expect(shell.root.querySelectorAll('a[aria-current="page"]')).toHaveLength(2);
    shell.setRoute("/profile");
    for (const link of shell.root.querySelectorAll("a[aria-current]")) {
      expect(link.getAttribute("aria-current")).toBe("page");
      expect((link as HTMLElement).dataset.route).toBe("/profile");
    }
    expect(shell.root.querySelector('[data-route="/security"][aria-current]')).toBeNull();
  });

  it.each(["zh-CN", "en", "ja"] as const)("keeps the public landing focused on the two actions in %s", (locale) => {
    const landing = createAnonymousLanding(translator(locale), { signInHref: "/login", registerHref: "/register" });
    expect(landing.querySelectorAll("a")).toHaveLength(2);
    expect(landing.querySelectorAll(".landing-feature h2")).toHaveLength(3);
    expect(landing.querySelector(".eyebrow, .landing-reassurance, .landing-section-heading, .landing-feature p")).toBeNull();
  });
});
