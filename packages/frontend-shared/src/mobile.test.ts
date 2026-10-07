import { describe, expect, it } from "vitest";
import { MOBILE_CALLING_CODES, normalizeMobileInput } from "./mobile";

describe("six-selector mobile formatting", () => {
  it.each(MOBILE_CALLING_CODES)("accepts national and matching full input for %s without changing country", (code) => {
    const expected = { kind: "valid", mobile: { country_calling_code: code, national_number: "2025550107" } };
    expect(normalizeMobileInput(code, " (202) 555-0107 ")).toEqual(expected);
    expect(normalizeMobileInput(code, `${code} (202) 555-0107`)).toEqual(expected);
  });
  it.each([["+81", "090-1234-5678", "9012345678"], ["+44", "020 7946 0018", "2079460018"], ["+81", "+81 (0)90-1234-5678", "9012345678"]])("preserves supported trunk-zero normalization (%s, %s)", (code, input, national) => {
    expect(normalizeMobileInput(code!, input!)).toEqual({ kind: "valid", mobile: { country_calling_code: code, national_number: national } });
  });
  it("distinguishes optional blank input from malformed nonempty input", () => {
    expect(normalizeMobileInput("+86", " \t ")).toEqual({ kind: "empty" });
    for (const input of ["()-", "+", "+86", "0", "12a34", "＋86138", "１２３", "1.23", "+1+202"]) {
      expect(normalizeMobileInput("+86", input)).toEqual({ kind: "invalid", reason: "invalid" });
    }
  });
  it("refuses ambiguous double-zero dialing instead of silently targeting another number", () => {
    for (const [code, input] of [["+86", "0012025550107"], ["+1", "0044 20 7946 0018"], ["+81", "+81 009012345678"]]) {
      expect(normalizeMobileInput(code!, input!)).toEqual({ kind: "invalid", reason: "international-prefix" });
    }
    expect(normalizeMobileInput("+86", "+86 138 0000 0000")).toEqual({ kind: "valid", mobile: { country_calling_code: "+86", national_number: "13800000000" } });
  });
  it("reports mismatched explicit country instead of selecting it implicitly", () => {
    expect(normalizeMobileInput("+1", "+44 20 7946 0018")).toEqual({ kind: "invalid", reason: "country-mismatch" });
    expect(normalizeMobileInput("+86", "+852 2123 4567")).toEqual({ kind: "invalid", reason: "country-mismatch" });
    expect(normalizeMobileInput("+39", "0123")).toEqual({ kind: "invalid", reason: "invalid" });
  });
  it.each(MOBILE_CALLING_CODES)("retains backend <=15 combined-digit boundary for %s", (code) => {
    const national = "1".repeat(15 - (code.length - 1));
    expect(normalizeMobileInput(code, national).kind).toBe("valid");
    expect(normalizeMobileInput(code, code + national).kind).toBe("valid");
    expect(normalizeMobileInput(code, national + "1")).toEqual({ kind: "invalid", reason: "invalid" });
  });
});
