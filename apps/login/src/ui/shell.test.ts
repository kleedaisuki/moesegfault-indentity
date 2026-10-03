// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALES } from "@moesegfault/frontend-shared";
import { createShell } from "./shell";

afterEach(() => document.body.replaceChildren());

describe("login locale selector", () => {
  it("projects the active route onto the main containing block and clears registration sizing on navigation", () => {
    const shell = createShell({ locale: "en", theme: "system", accountOrigin: "https://account.example", onLocale: vi.fn(), onTheme: vi.fn() });
    shell.setActiveRoute("/register");
    expect(shell.main.dataset.route).toBe("/register");
    shell.setActiveRoute("/login");
    expect(shell.main.dataset.route).toBe("/login");
  });
  it("renders the shared full autonyms and language metadata", () => {
    const onLocale = vi.fn();
    const shell = createShell({ locale: "ja", theme: "system", accountOrigin: "https://account.example", onLocale, onTheme: vi.fn() });
    document.body.append(shell.root);
    const selector = shell.root.querySelector<HTMLSelectElement>('select[aria-label="言語"]')!;
    const options = [...selector.options];

    expect(options.map(({ value, textContent, lang }) => ({ value, autonym: textContent, lang }))).toEqual(
      LOCALES.map(({ tag, autonym, htmlLang }) => ({ value: tag, autonym, lang: htmlLang })),
    );
    expect(selector.value).toBe("ja");

    selector.value = "en";
    selector.dispatchEvent(new Event("change"));
    expect(onLocale).toHaveBeenCalledWith("en");
  });
});
