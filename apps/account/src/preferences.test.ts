import { describe, expect, it } from "vitest";
import { applyTheme, isInAppBrowser, readPreferences } from "./preferences";

describe("preferences", () => {
  it("falls back to system and browser locale", () => { const storage = { getItem: () => null }; expect(readPreferences(storage, "ja-JP")).toEqual({ locale: "ja", theme: "system" }); });
  it("applies explicit and system themes", () => { const root = { dataset: {} } as HTMLElement; applyTheme("system", root, { matches: true }); expect(root.dataset).toMatchObject({ theme: "dark", themePreference: "system" }); applyTheme("light", root, { matches: true }); expect(root.dataset.theme).toBe("light"); });
  it("detects major in-app browsers without classifying ordinary Safari", () => { expect(isInAppBrowser("MicroMessenger/8.0")).toBe(true); expect(isInAppBrowser("Mozilla/5.0 Safari/605.1.15")).toBe(false); });
});
