import { describe, expect, it, vi } from "vitest";
import { AccountApiClient, ApiError } from "./api/client";
import { signOutCurrentSession } from "./sign-out";

/** Verifies current-session revocation without OIDC tokens, cookie reads, or unrelated-device logout. */
describe("first-party sign out", () => {
  it("revokes only the current active session with a CSRF proof and fresh idempotency key", async () => {
    const revokeSession = vi.fn(async () => undefined);
    const api = { listSessions: vi.fn(async () => ({ items: [
      { session_id: "other", is_current: false },
      { session_id: "old", is_current: true, revoked_at: "2026-10-04T00:00:00Z" },
      { session_id: "current", is_current: true, revoked_at: null },
    ] })), revokeSession } as unknown as AccountApiClient;
    await signOutCurrentSession(api, "csrf");
    expect(revokeSession).toHaveBeenCalledExactlyOnceWith("current", { csrfToken: "csrf", idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
  });
  it.each(["list", "revoke"])("treats an expired session during %s as already signed out", async (stage) => {
    const unauthorized = new ApiError(401);
    const api = {
      listSessions: vi.fn(async () => { if (stage === "list") throw unauthorized; return { items: [{ session_id: "current", is_current: true }] }; }),
      revokeSession: vi.fn(async () => { throw unauthorized; }),
    } as unknown as AccountApiClient;
    await expect(signOutCurrentSession(api, "csrf")).resolves.toBeUndefined();
  });
  it("does not claim success or revoke another device when current session data is absent", async () => {
    const revokeSession = vi.fn();
    const api = { listSessions: vi.fn(async () => ({ items: [{ session_id: "other", is_current: false }] })), revokeSession } as unknown as AccountApiClient;
    await expect(signOutCurrentSession(api, "csrf")).rejects.toThrow("Current Identity session was not found");
    expect(revokeSession).not.toHaveBeenCalled();
  });
  it("propagates transport and CSRF failures so the application can offer retry", async () => {
    const failure = new ApiError(403);
    const api = { listSessions: vi.fn(async () => ({ items: [{ session_id: "current", is_current: true }] })), revokeSession: vi.fn(async () => { throw failure; }) } as unknown as AccountApiClient;
    await expect(signOutCurrentSession(api, "csrf")).rejects.toBe(failure);
  });
});
