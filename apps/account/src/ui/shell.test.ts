// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { LOCALES } from "@moesegfault/frontend-shared";
import { translator } from "../i18n";
import type { AccountSession } from "../session";
import { localeOptions } from "./locale-select";
import { createShell } from "./shell";

const authenticated: AccountSession = {
  status: "authenticated",
  account: { principal_id: "principal", lifecycle_state: "active", profile: { display_name: "Klee", locale: "zh-CN", avatar_url: null }, identifiers: [], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  preferences: { locale: "zh-CN", theme: "system", timezone: "Asia/Shanghai", reduced_motion: false, compact_mode: false, notifications: { security_email: true } },
  csrfToken: "csrf",
};

describe("Account shell authentication state", () => {
  it.each(["pending", "anonymous"] as const)("hides auth-only controls while %s but retains the public shell", (status) => {
    const shell = createShell(translator("en"), true, async () => undefined);
    shell.setSession({ status });
    expect(shell.root.querySelector(".brand")).not.toBeNull();
    expect(shell.controls).toHaveLength(2);
    expect(shell.root.contains(shell.main)).toBe(true);
    for (const selector of [".side-nav", ".bottom-nav", ".user-chip", ".mobile-sign-out", ".in-app-banner"]) expect(shell.root.querySelector(selector)?.hasAttribute("hidden")).toBe(true);
    expect(shell.root.textContent).not.toContain("…");
  });

  it("awaits the sign-out command and prevents duplicate clicks without navigating to an OIDC URL", async () => {
    let complete!: () => void;
    const command = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const shell = createShell(translator("en"), false, command);
    shell.setSession(authenticated);
    const button = shell.root.querySelector<HTMLButtonElement>(".user-chip")!;
    expect(button.tagName).toBe("BUTTON");
    expect(button.hasAttribute("href")).toBe(false);
    button.click(); button.click();
    expect(command).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    complete();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
  });

  it("reveals accessible navigation and a named user only after authentication", () => {
    const shell = createShell(translator("en"), true, async () => undefined);
    shell.setSession(authenticated);
    for (const selector of [".side-nav", ".bottom-nav", ".user-chip", ".mobile-sign-out", ".in-app-banner"]) expect(shell.root.querySelector(selector)?.hasAttribute("hidden")).toBe(false);
    expect(shell.root.querySelector(".side-nav")?.getAttribute("aria-label")).toBe("Account");
    expect(shell.root.querySelector(".user-chip")?.textContent).toContain("Klee");
  });

  it("keeps a labeled mobile sign-out command outside the hidden sidebar and preference replacement", async () => {
    let complete!: () => void;
    const command = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const shell = createShell(translator("en"), false, command);
    shell.setSession(authenticated);
    const mobile = shell.root.querySelector<HTMLButtonElement>(".mobile-header .mobile-sign-out")!;
    const desktop = shell.root.querySelector<HTMLButtonElement>(".user-chip")!;
    expect(mobile.getAttribute("aria-label")).toBe(translator("en")("signOut"));
    expect(mobile.closest(".sidebar")).toBeNull();
    for (const controls of shell.controls) controls.replaceChildren(document.createElement("select"));
    expect(shell.root.contains(mobile)).toBe(true);
    mobile.click(); desktop.click(); mobile.click();
    expect(command).toHaveBeenCalledOnce();
    expect(mobile.disabled).toBe(true);
    expect(desktop.disabled).toBe(true);
    complete();
    await vi.waitFor(() => expect(mobile.disabled).toBe(false));
    expect(desktop.disabled).toBe(false);
    shell.setSession({ status: "anonymous" });
    expect(mobile.hidden).toBe(true);
  });
});

describe("shared locale representation", () => {
  it("relocalizes persistent shell labels without replacing focused commands or their locks", async () => {
    let finish!: () => void;
    const shell = createShell(translator("en"), true, () => new Promise<void>((resolve) => { finish = resolve; }));
    document.body.append(shell.root); shell.setSession(authenticated);
    const main = shell.main; const mobile = shell.root.querySelector<HTMLButtonElement>(".mobile-sign-out")!;
    const nav = shell.root.querySelector<HTMLAnchorElement>('[data-route="/profile"]')!;
    nav.focus(); shell.relocalize(translator("ja"));
    expect(document.activeElement).toBe(nav); expect(shell.main).toBe(main);
    expect(nav.querySelector("span")?.textContent).toBe(translator("ja")("profile"));
    expect(mobile.getAttribute("aria-label")).toBe(translator("ja")("signOut"));
    expect(shell.root.querySelector(".in-app-banner span")?.textContent).toBe(translator("ja")("inApp"));
    mobile.click(); expect(mobile.disabled).toBe(true);
    shell.relocalize(translator("zh-CN")); expect(mobile.disabled).toBe(true);
    expect(shell.root.querySelector(".mobile-sign-out")).toBe(mobile);
    finish(); await vi.waitFor(() => expect(mobile.disabled).toBe(false));
    shell.root.remove();
  });
  it("renders every full autonym with an option language", () => {
    const options = localeOptions("ja");
    expect(options.map((option) => ({ value: option.value, label: option.textContent, lang: option.lang }))).toEqual(
      LOCALES.map(({ tag, autonym, htmlLang }) => ({ value: tag, label: autonym, lang: htmlLang })),
    );
    expect(options.find((option) => option.value === "ja")?.selected).toBe(true);
  });
});
