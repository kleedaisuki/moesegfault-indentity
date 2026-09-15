import { describe, expect, it, vi } from "vitest";
import { AccountApiClient, ApiError, type FetchLike } from "./client";

const account = {
  principal_id: "00000000-0000-4000-8000-000000000001",
  lifecycle_state: "active" as const,
  profile: { display_name: "Klee", locale: "zh-CN", bio: "Spark!" },
  identifiers: [{ identifier_id: "id", kind: "username" as const, value: "klee", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

/** 创建 JSON mock response。Creates a JSON mock response. */
function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } }); }

describe("AccountApiClient", () => {
  it("bootstraps /v1/me with cookies and no cache", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(json({ account, csrf_token: "x".repeat(32), csrf_expires_at: "2026-01-01T01:00:00Z" }));
    const api = new AccountApiClient("https://identity.example");
    const result = await new AccountApiClient("https://identity.example", fetch).getMe();
    expect(result.account.profile.display_name).toBe("Klee");
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://identity.example/v1/me"); expect(init).toMatchObject({ method: "GET", credentials: "include", cache: "no-store", redirect: "error" });
    expect(() => new AccountApiClient("javascript:alert(1)")) .toThrow(TypeError);
    void api;
  });

  it("sends merge patch, CSRF, and an idempotency key", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(json(account));
    await new AccountApiClient("https://identity.example", fetch).updateMe({ display_name: "Klee!" }, { csrfToken: "csrf" });
    const [, init] = fetch.mock.calls[0]!; const headers = init?.headers as Headers;
    expect(init?.method).toBe("PATCH"); expect(init?.body).toBe('{"display_name":"Klee!"}');
    expect(headers.get("content-type")).toBe("application/merge-patch+json"); expect(headers.get("x-moesegfault-csrf")).toBe("csrf"); expect(headers.get("idempotency-key")).toBeTruthy();
  });

  it("uses exact contact and session paths and escapes IDs", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 204 })); const api = new AccountApiClient("https://identity.example", fetch);
    await api.deleteContact("a/b", { csrfToken: "csrf" }); await api.revokeSession("s/b", { csrfToken: "csrf" });
    expect(String(fetch.mock.calls[0]![0])).toContain("/v1/me/contacts/a%2Fb"); expect(String(fetch.mock.calls[1]![0])).toContain("/v1/principals/self/sessions/s%2Fb");
  });

  it("preserves RFC 9457 details and correlation IDs", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(json({ type: "urn:test", title: "Nope", status: 409, detail: "Already exists" }, 409, { "x-moesegfault-correlation-id": "corr" }));
    const error = await new AccountApiClient("https://identity.example", fetch).listContacts().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiError); expect(error).toMatchObject({ status: 409, message: "Already exists", correlationId: "corr" });
  });

  it("normalizes network failures without exposing causes", async () => {
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new Error("secret request data"));
    const error = await new AccountApiClient("https://identity.example", fetch).getSecurity().catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 0, message: "Unable to reach the identity service." }); expect(String(error)).not.toContain("secret request data");
  });
});
