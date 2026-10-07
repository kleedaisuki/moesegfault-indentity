/** Existing selectors only; not a worldwide numbering database. */
export const MOBILE_CALLING_CODES = ["+86", "+81", "+1", "+44", "+65", "+852"] as const;
/** Selected country is authoritative and is never inferred from user input. */
export type MobileCallingCode = (typeof MOBILE_CALLING_CODES)[number];
/** Canonical contact/signup payload, without display formatting. */
export interface NormalizedMobile { country_calling_code: MobileCallingCode; national_number: string; }
/** Empty is valid for optional signup; callers decide whether a value is required. */
export type MobileInputResult = { kind: "empty" } | { kind: "valid"; mobile: NormalizedMobile } | { kind: "invalid"; reason: "invalid" | "country-mismatch" | "international-prefix" };

/**
 * Accepts national input or a matching explicit +country prefix, preserving single trunk-zero removal.
 * Enforces the backend's digits/15-digit limit, not carrier allocations or legacy login semantics.
 * @example normalizeMobileInput("+81", "090-1234-5678") yields national_number "9012345678".
 */
export function normalizeMobileInput(callingCode: string, input: string): MobileInputResult {
  if (!input.trim()) return { kind: "empty" };
  if (!(MOBILE_CALLING_CODES as readonly string[]).includes(callingCode)) return { kind: "invalid", reason: "invalid" };
  const compact = input.replace(/[\s()-]/gu, "");
  if (!/^\+?[0-9]+$/u.test(compact)) return { kind: "invalid", reason: "invalid" };
  if (compact.startsWith("+") && !compact.startsWith(callingCode)) return { kind: "invalid", reason: "country-mismatch" };
  const nationalInput = compact.startsWith("+") ? compact.slice(callingCode.length) : compact;
  // 00 is not a universal international prefix: require explicit + rather than silently misrouting it.
  if (nationalInput.startsWith("00")) return { kind: "invalid", reason: "international-prefix" };
  const national = nationalInput.replace(/^0/u, "");
  if (!national || callingCode.length - 1 + national.length > 15) return { kind: "invalid", reason: "invalid" };
  return { kind: "valid", mobile: { country_calling_code: callingCode as MobileCallingCode, national_number: national } };
}
