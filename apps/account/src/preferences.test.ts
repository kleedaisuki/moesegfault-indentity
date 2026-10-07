import { describe, expect, it, vi } from "vitest";
import { applyTheme, changeLocalePreference, isInAppBrowser, readPreferences, safeStorage, writePreference } from "./preferences";

describe("preferences", () => {
  it("does not mutate locale or reload while consent is pending", async () => {
    let finish!: (approved: boolean) => void;
    const select = { value: "ja" };
    const commit = vi.fn();
    const pending = changeLocalePreference(select, "en", () => new Promise<boolean>((resolve) => { finish = resolve; }), commit);
    expect(select.value).toBe("en");
    expect(commit).not.toHaveBeenCalled();
    finish(true);
    await pending;
    expect(commit).toHaveBeenCalledExactlyOnceWith("ja");
  });
  it("restores cancelled locale selection without changing state, storage, or reloading", async () => {
    const select = { value: "ja" };
    const commit = vi.fn();
    await changeLocalePreference(select, "en", () => false, commit);
    expect(select.value).toBe("en");
    expect(commit).not.toHaveBeenCalled();
  });
  it("confirms locale changes exactly once and commits only after approval", async () => {
    const sequence: string[] = [];
    await changeLocalePreference({ value: "ja" }, "en", () => { sequence.push("confirm"); return true; }, (next) => sequence.push(`commit:${next}`));
    expect(sequence).toEqual(["confirm", "commit:ja"]);
    const confirm = vi.fn(() => true);
    const commit = vi.fn();
    await changeLocalePreference({ value: "en" }, "en", confirm, commit);
    expect(confirm).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
  it("falls back to system and browser locale", () => { const storage = { getItem: () => null }; expect(readPreferences(storage, "ja-JP")).toEqual({ locale: "ja", theme: "system" }); });
  it("applies explicit and system themes", () => { const root = { dataset: {} } as HTMLElement; applyTheme("system", root, { matches: true }); expect(root.dataset).toMatchObject({ theme: "dark", themePreference: "system" }); applyTheme("light", root, { matches: true }); expect(root.dataset.theme).toBe("light"); });
  it("detects major in-app browsers without classifying ordinary Safari", () => { expect(isInAppBrowser("MicroMessenger/8.0")).toBe(true); expect(isInAppBrowser("Mozilla/5.0 Safari/605.1.15")).toBe(false); });
  it("survives storage denied by browser policy", () => { const denied = { getItem: () => { throw new DOMException("denied", "SecurityError"); }, setItem: () => { throw new DOMException("denied", "SecurityError"); } }; expect(readPreferences(denied, "en-US")).toEqual({ locale: "en", theme: "system" }); expect(() => writePreference(denied, "theme", "dark")).not.toThrow(); expect(safeStorage(() => { throw new DOMException("denied", "SecurityError"); })).toBeUndefined(); });
});
