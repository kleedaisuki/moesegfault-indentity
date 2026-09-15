import { describe, expect, it, vi } from "vitest";
import { IdentityApiClient } from "./api/client";
import { reauthenticateAndStartEnrollment } from "./pages";

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
