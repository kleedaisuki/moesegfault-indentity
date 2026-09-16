// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
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
    const shell = createShell(translator("en"), true, "/logout");
    shell.setSession({ status });
    expect(shell.root.querySelector(".brand")).not.toBeNull();
    expect(shell.controls).toHaveLength(2);
    expect(shell.root.contains(shell.main)).toBe(true);
    for (const selector of [".side-nav", ".bottom-nav", ".user-chip", ".in-app-banner"]) expect(shell.root.querySelector(selector)?.hasAttribute("hidden")).toBe(true);
    expect(shell.root.textContent).not.toContain("…");
  });

  it("reveals accessible navigation and a named user only after authentication", () => {
    const shell = createShell(translator("en"), true, "/logout");
    shell.setSession(authenticated);
    for (const selector of [".side-nav", ".bottom-nav", ".user-chip", ".in-app-banner"]) expect(shell.root.querySelector(selector)?.hasAttribute("hidden")).toBe(false);
    expect(shell.root.querySelector(".side-nav")?.getAttribute("aria-label")).toBe("Account");
    expect(shell.root.querySelector(".user-chip")?.textContent).toContain("Klee");
  });
});

describe("shared locale representation", () => {
  it("renders every full autonym with an option language", () => {
    const options = localeOptions("ja");
    expect(options.map((option) => ({ value: option.value, label: option.textContent, lang: option.lang }))).toEqual(
      LOCALES.map(({ tag, autonym, htmlLang }) => ({ value: tag, label: autonym, lang: htmlLang })),
    );
    expect(options.find((option) => option.value === "ja")?.selected).toBe(true);
  });
});
