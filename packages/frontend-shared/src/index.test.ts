import { describe, expect, expectTypeOf, it } from "vitest";

import { isLocale, LOCALES, normalizeLocale, type Locale } from "./index";

describe("locale metadata", () => {
  it("keeps a single ordered representation for every supported locale", () => {
    expect(LOCALES).toEqual([
      { tag: "zh-CN", autonym: "简体中文", htmlLang: "zh-CN" },
      { tag: "en", autonym: "English", htmlLang: "en" },
      { tag: "ja", autonym: "日本語", htmlLang: "ja" },
    ]);
    expect(new Set(LOCALES.map(({ tag }) => tag)).size).toBe(LOCALES.length);
    expectTypeOf<Locale>().toEqualTypeOf<"zh-CN" | "en" | "ja">();
  });
});

describe("isLocale", () => {
  it.each(["zh-CN", "en", "ja"])("accepts the supported tag %s", (locale) => {
    expect(isLocale(locale)).toBe(true);
  });

  it.each(["", "zh", "en-US", "JA", null, undefined, 1])("rejects unsupported input %s", (value) => {
    expect(isLocale(value)).toBe(false);
  });
});

describe("normalizeLocale", () => {
  it.each([
    ["zh-CN", "zh-CN"],
    ["zh-TW", "zh-CN"],
    ["en-US", "en"],
    [" EN_gb ", "en"],
    ["ja-JP", "ja"],
    ["JA", "ja"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected);
  });

  it.each([undefined, null, "", "  ", "fr", "english"])("defaults unsupported input %s", (input) => {
    expect(normalizeLocale(input)).toBe("zh-CN");
  });
});
