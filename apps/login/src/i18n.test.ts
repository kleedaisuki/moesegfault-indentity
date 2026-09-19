import { describe, expect, it } from "vitest";
import { normalizeLocale, translate } from "./i18n";
import { readPreferences } from "./preferences";

describe("display localization", () => {
  it("normalizes regional browser locales", () => {
    expect(normalizeLocale("ja-JP")).toBe("ja");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("zh-TW")).toBe("zh-CN");
  });

  it("contains distinct copy for every supported locale", () => {
    expect(new Set([translate("zh-CN", "welcome"), translate("en", "welcome"), translate("ja", "welcome")]).size).toBe(3);
  });

  it("localizes the mandatory registration verification actions", () => {
    for (const locale of ["zh-CN", "en", "ja"] as const) {
      expect(translate(locale, "verifyEmailTitle")).toBeTruthy();
      expect(translate(locale, "verificationCode")).toBeTruthy();
      expect(translate(locale, "resendCode")).toBeTruthy();
    }
  });

  it("accepts only supported persisted preferences", () => {
    const storage = { getItem: (key: string) => key.endsWith("locale") ? "xx" : "neon" };
    expect(readPreferences(storage, "ja-JP")).toEqual({ locale: "ja", theme: "system" });
  });

  it("tolerates storage denial", () => {
    expect(readPreferences({ getItem() { throw new Error("denied"); } }, "en-US")).toEqual({ locale: "en", theme: "system" });
  });
});
