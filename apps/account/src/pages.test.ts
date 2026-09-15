import { describe, expect, it } from "vitest";
import { errorText, securityAttention } from "./pages";
import { ApiError } from "./api/client";

describe("page policies", () => {
  it("flags accounts with no login method or no recovery readiness", () => { const base = { password: true, passkey_count: 1, mfa_methods: ["passkey" as const], verified_email_count: 1, verified_mobile_count: 0, recovery_ready: true }; expect(securityAttention(base)).toBe(false); expect(securityAttention({ ...base, recovery_ready: false })).toBe(true); expect(securityAttention({ ...base, password: false, passkey_count: 0 })).toBe(true); });
  it("shows safe correlation IDs on typed errors", () => { expect(errorText(new ApiError(500, { type: "urn:test", title: "Failure", status: 500 }, "abc"))).toBe("Failure · ID abc"); });
});
