import { describe, expect, it } from "vitest";
import { normalizeLocale, translator } from "./i18n";

describe("i18n", () => {
  it("normalizes regional variants", () => { expect(normalizeLocale("en-US")).toBe("en"); expect(normalizeLocale("ja-JP")).toBe("ja"); expect(normalizeLocale("zh-TW")).toBe("zh-CN"); });
  it("has translated navigation in every locale", () => { for (const locale of ["zh-CN", "en", "ja"] as const) { const t = translator(locale); for (const key of ["overview", "profile", "security", "sessions", "apps"] as const) expect(t(key)).toBeTruthy(); } });
});
