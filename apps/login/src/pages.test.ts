import { describe, expect, it, vi } from "vitest";
import { IdentityApiClient } from "./api/client";
import { postAuthenticationDestination, reauthenticateAndStartEnrollment, registrationEmailIdentifier } from "./pages";
import type { Account } from "./api/types";

describe("ordinary login return navigation", () => {
  it("returns to Account but never overrides OAuth transaction resume", () => {
    expect(postAuthenticationDestination({}, "https://account.moesegfault.dev/security")).toBe("https://account.moesegfault.dev/security");
    expect(postAuthenticationDestination({ authorization_resume_uri: "https://client.example/callback" }, "https://account.moesegfault.dev/security")).toBe("https://client.example/callback");
    expect(postAuthenticationDestination({})).toBeUndefined();
  });
});

describe("registration email selection", () => {
  it("selects the primary email instead of username or mobile", () => {
    const base = { is_primary: false, verification_state: "unverified" as const, created_at: "now", updated_at: "now" };
    const account = { identifiers: [
      { ...base, identifier_id: "user", kind: "username", value: "klee" },
      { ...base, identifier_id: "old", kind: "email", value: "old@example.com" },
      { ...base, identifier_id: "new", kind: "email", value: "klee@example.com", is_primary: true },
      { ...base, identifier_id: "phone", kind: "mobile", value: "+8613800000000", is_primary: true },
    ] } as Account;
    expect(registrationEmailIdentifier(account)).toMatchObject({ identifier_id: "new", value: "klee@example.com" });
  });
});

describe("password reauthentication for first-passkey enrollment", () => {
  it("refreshes the session CSRF with password auth before starting enrollment", async () => {
    const calls: string[] = [];
    const api = {
      authenticateWithPassword: vi.fn(async () => { calls.push("password"); return { csrf_token: "csrf-after-password" }; }),
      startAuthenticatorRegistration: vi.fn(async () => { calls.push("enroll"); return { transaction_id: "tx-enroll", csrf_token: "csrf-tx", public_key: {} }; }),
    } as unknown as IdentityApiClient;
    const signal = new AbortController().signal;

    const result = await reauthenticateAndStartEnrollment(api, { login: "klee@example.com", password: "a long password" }, "My first passkey", "csrf-browser", signal);

    expect(calls).toEqual(["password", "enroll"]);
    expect(api.authenticateWithPassword).toHaveBeenCalledWith({ login: "klee@example.com", password: "a long password" }, "csrf-browser", signal);
    expect(api.startAuthenticatorRegistration).toHaveBeenCalledWith("My first passkey", expect.objectContaining({ csrfToken: "csrf-after-password", signal }));
    expect(result).toMatchObject({ csrfToken: "csrf-after-password", transaction: { transaction_id: "tx-enroll" } });
  });

  it("never starts enrollment when password authentication fails", async () => {
    const rejection = new Error("invalid credentials");
    const startAuthenticatorRegistration = vi.fn();
    const api = { authenticateWithPassword: vi.fn(async () => { throw rejection; }), startAuthenticatorRegistration } as unknown as IdentityApiClient;

    await expect(reauthenticateAndStartEnrollment(api, { login: "klee", password: "wrong" }, "First", "csrf-browser", new AbortController().signal)).rejects.toBe(rejection);
    expect(startAuthenticatorRegistration).not.toHaveBeenCalled();
  });
});
