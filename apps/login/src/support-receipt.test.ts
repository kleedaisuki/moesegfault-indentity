import { describe, expect, it } from "vitest";
import { ApiError, IdentityApiClient } from "./api/client";
import { failureReceipt, supportCorrelation, supportRealm } from "./support-receipt";

const revision = "a".repeat(40);
const now = Date.parse("2026-10-01T00:01:59.999Z");
const receipt = (error: unknown) => failureReceipt(error, "password_authentication", "login-staging.moesegfault.dev", revision, now);

describe("allowlisted failure support receipts", () => {
  it.each([400, 401, 403, 413, 429, 500])("retains HTTP %s without serializing response secrets", async (status) => {
    const sentinel = "SECRET-password-cookie-state-url";
    const api = new IdentityApiClient("https://identity-staging.moesegfault.dev", async () => new Response(JSON.stringify({
      type: "urn:moesegfault:problem:invalid_request", title: sentinel, detail: sentinel, instance: sentinel,
      account_id: sentinel, correlation_id: sentinel,
    }), { status, headers: { "content-type": "application/problem+json", "x-moesegfault-correlation-id": "b".repeat(32) } }));
    const error: unknown = await api.authenticateWithPassword({ login: sentinel, password: sentinel }, sentinel).catch((error: unknown) => error);
    expect(receipt(error)).toEqual({ schema: 1, revision, realm: "staging", operation: "password_authentication", transport: "http_problem", status, problem: "invalid_request", correlation: "b".repeat(32), observed_minute: "2026-10-01T00:01:00.000Z" });
    expect(JSON.stringify(receipt(error))).not.toContain(sentinel);
  });

  it("keeps identical generic 401 shape for known and unknown synthetic accounts", () => {
    const known = new ApiError(401, { type: "urn:moesegfault:problem:authentication_failed", title: "Authentication failed", status: 401, detail: "known-secret" });
    const unknown = new ApiError(401, { type: "urn:moesegfault:problem:authentication_failed", title: "Authentication failed", status: 401, detail: "unknown-secret" });
    expect(receipt(known)).toEqual(receipt(unknown));
  });

  it.each(["a".repeat(32), "ABCDEF01-2345-6789-abcd-0123456789ab"])("preserves accepted UUID wire form %s", (value) => {
    expect(supportCorrelation(value)).toBe(value);
  });
  it.each([undefined, null, 12, "", "a".repeat(31), "a".repeat(33), "x".repeat(32), "a".repeat(37), "https://secret.example", "a".repeat(32) + "\n"])("omits invalid correlation %s", (value) => {
    expect(supportCorrelation(value)).toBeUndefined();
  });

  it("does not interpret unknown/malformed problem values or malformed JSON", async () => {
    for (const body of ['{', JSON.stringify({ type: { secret: "sentinel" }, detail: "sentinel" }), JSON.stringify({ type: "https://sentinel.example/secret" })]) {
      const api = new IdentityApiClient("https://identity.moesegfault.dev", async () => new Response(body, { status: 413, headers: { "content-type": "application/problem+json" } }));
      const error: unknown = await api.getBrowserContext().catch((error: unknown) => error);
      expect(receipt(error).problem).toBe("unknown");
      expect(JSON.stringify(receipt(error))).not.toContain("sentinel");
    }
  });

  it("distinguishes unreadable network, abort and unexpected failures without exception text", async () => {
    const api = new IdentityApiClient("https://identity.moesegfault.dev", async () => { throw new TypeError("sentinel-url-cookie"); });
    expect(receipt(await api.getBrowserContext().catch((error: unknown) => error)).transport).toBe("network_or_cors");
    const aborted = new IdentityApiClient("https://identity.moesegfault.dev", async () => { throw new DOMException("sentinel-state", "AbortError"); });
    expect(receipt(await aborted.getBrowserContext().catch((error: unknown) => error)).transport).toBe("aborted");
    expect(receipt(new DOMException("sentinel-state", "AbortError"))).toMatchObject({ transport: "aborted", problem: "unknown" });
    expect(receipt(new Error("sentinel-password"))).toMatchObject({ transport: "unexpected", problem: "unknown" });
    expect(JSON.stringify(receipt(new Error("sentinel-password")))).not.toContain("sentinel");
  });

  it("maps only controlled hosts and immutable revisions", () => {
    expect(supportRealm("login.moesegfault.dev")).toBe("production");
    expect(supportRealm("login-staging.moesegfault.dev")).toBe("staging");
    expect(supportRealm("login.moesegfault.dev.secret.example")).toBe("unknown");
    const value = failureReceipt(new Error("secret"), "browser_context", "secret.example", "secret-revision", now);
    expect(value.realm).toBe("unknown"); expect(value.revision).toBe("unknown");
    expect(JSON.stringify(value)).not.toContain("secret");
  });
});
