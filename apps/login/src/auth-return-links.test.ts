// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityApiClient } from "./api/client";
import { authRouteHref } from "./environment";
import { renderPage } from "./pages";
import { createShell } from "./ui/shell";

const origin = "https://login-staging.moesegfault.dev";
const target = "https://account-staging.moesegfault.dev/profile";
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

/** Follow rendered auth links without submitting credentials or requesting recovery ceremonies. */
async function follow(route: "/login" | "/register" | "/recovery", href: string, next: string): Promise<string> {
  vi.stubGlobal("location", { hostname: "login-staging.moesegfault.dev", href: new URL(href, origin).href });
  const main = document.createElement("main");
  const abort = new AbortController();
  await renderPage(route, main, {} as IdentityApiClient, abort.signal, { locale: "en" });
  const link = [...main.querySelectorAll<HTMLAnchorElement>("a")].find(anchor => anchor.getAttribute("href")?.split("?")[0] === next);
  expect(link).toBeDefined();
  const result = link!.getAttribute("href")!;
  abort.abort();
  return result;
}

describe("Account destination continuity across auth alternatives", () => {
  it.each([
    { name: "paired staging profile", requested: target, expected: target },
    { name: "foreign destination", requested: "https://evil.example/profile", expected: undefined },
    { name: "cross-environment destination", requested: "https://account.moesegfault.dev/profile", expected: undefined },
    { name: "destination containing secrets", requested: `${target}?token=SECRET`, expected: undefined },
    { name: "no return destination", requested: undefined, expected: undefined },
  ])("preserves only an allowlisted return target: $name", async ({ requested, expected }) => {
    const initial = `/login?state=SECRET&tx=SECRET${requested ? `&return_uri=${encodeURIComponent(requested)}` : ""}#SECRET`;
    const recovery = await follow("/login", initial, "/recovery");
    const back = await follow("/recovery", recovery, "/login");
    const signup = await follow("/login", back, "/register");
    const signIn = await follow("/register", signup, "/login");
    for (const href of [recovery, back, signup, signIn]) {
      const url = new URL(href, origin);
      expect(url.searchParams.get("return_uri")).toBe(expected ?? null);
      expect([...url.searchParams.keys()]).toEqual(expected ? ["return_uri"] : []);
      expect(url.hash).toBe("");
      expect(href).not.toContain("SECRET");
      if (!expected) expect(href).toBe(url.pathname);
    }
  });

  it("refreshes header and brand links from the live route without retaining a stale destination", () => {
    const liveLocation = { hostname: "login-staging.moesegfault.dev", href: `${origin}/login?return_uri=${encodeURIComponent(target)}` };
    const shell = createShell({ locale: "en", theme: "system", accountOrigin: "https://account-staging.moesegfault.dev", authLocation: liveLocation, onLocale: vi.fn(), onTheme: vi.fn() });
    for (const anchor of shell.root.querySelectorAll<HTMLAnchorElement>(".brand, .top-nav a")) {
      expect(new URL(anchor.getAttribute("href")!, origin).searchParams.get("return_uri")).toBe(target);
    }
    liveLocation.href = `${origin}/recovery?return_uri=${encodeURIComponent(target)}`;
    shell.setActiveRoute("/recovery");
    expect(shell.root.querySelector(".brand")?.getAttribute("href")).toBe(authRouteHref("/login", liveLocation));
    liveLocation.href = `${origin}/login`;
    shell.setActiveRoute("/login");
    expect(shell.root.querySelector(".brand")?.getAttribute("href")).toBe("/login");
    expect([...shell.root.querySelectorAll(".top-nav a")].map(anchor => anchor.getAttribute("href"))).toEqual(["/login", "/register"]);
    expect(shell.root.querySelector('[aria-current]')?.getAttribute("href")).toBe("/login");
  });
});
