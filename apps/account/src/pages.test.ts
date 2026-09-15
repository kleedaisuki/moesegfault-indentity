import { describe, expect, it } from "vitest";
import { errorText, mutationErrorPresentation, reauthenticationUrl, securityAttention } from "./pages";
import { ApiError } from "./api/client";

describe("page policies", () => {
  it("flags accounts with no login method or no recovery readiness", () => { const base = { password: true, passkey_count: 1, mfa_methods: ["passkey" as const], verified_email_count: 1, verified_mobile_count: 0, recovery_ready: true }; expect(securityAttention(base)).toBe(false); expect(securityAttention({ ...base, recovery_ready: false })).toBe(true); expect(securityAttention({ ...base, password: false, passkey_count: 0 })).toBe(true); });
  it("shows safe correlation IDs on typed errors", () => { expect(errorText(new ApiError(500, { type: "urn:test", title: "Failure", status: 500 }, "abc"))).toBe("Failure · ID abc"); });
});

describe("recent-authentication mutation UX", () => {
  const t = (key: string) => ({ reauthenticationBody: "Confirm again", reauthenticate: "Go to Login", unexpectedError: "Unexpected" })[key] ?? key;

  it("offers a localized Login action that returns to the exact current Account page", () => {
    const error = new ApiError(403, { type: "urn:moesegfault:problem:reauthentication_required", title: "Recent authentication required", status: 403, error_code: "reauthentication_required" });
    expect(mutationErrorPresentation(error, t as never, { hostname: "account-staging.moesegfault.dev", pathname: "/security" })).toEqual({
      message: "Confirm again",
      actionLabel: "Go to Login",
      actionHref: "https://login-staging.moesegfault.dev/login?return_uri=https%3A%2F%2Faccount-staging.moesegfault.dev%2Fsecurity",
    });
  });

  it("does not add the reauthentication action for another RFC 9457 code", () => {
    const error = new ApiError(409, { type: "urn:test", title: "Last authenticator", status: 409, error_code: "last_authenticator" });
    expect(mutationErrorPresentation(error, t as never, { hostname: "account.moesegfault.dev", pathname: "/security" })).toEqual({ message: "Last authenticator" });
  });

  it("normalizes unknown Account paths before constructing the strict return URI", () => {
    expect(reauthenticationUrl({ hostname: "account.moesegfault.dev", pathname: "/security/other" })).toBe("https://login.moesegfault.dev/login?return_uri=https%3A%2F%2Faccount.moesegfault.dev%2F");
  });
});
