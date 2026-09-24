import { describe, expect, it, vi } from "vitest";
import { ApiError, IdentityApiClient, type FetchLike } from "./client";
import type { PublicKeyCredentialJson } from "./types";

describe("IdentityApiClient", () => {
  it("sends credentials, JSON, CSRF, and idempotency headers", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ display_name: "Klee" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = new IdentityApiClient("https://identity.moesegfault.dev", fetchMock);

    await client.updatePrincipal({ display_name: "Klee" }, {
      csrfToken: "csrf-page-memory",
      idempotencyKey: "operation-1",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://identity.moesegfault.dev/v1/principals/self");
    expect(init?.credentials).toBe("include");
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/merge-patch+json");
    expect(headers.get("x-moesegfault-csrf")).toBe("csrf-page-memory");
    expect(headers.get("idempotency-key")).toBe("operation-1");
  });

  it("parses Problem Details and correlation IDs", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => new Response(JSON.stringify({
      type: "urn:moesegfault:problem:transaction_expired",
      title: "事务过期",
      status: 409,
      detail: "请重新开始。",
    }), {
      status: 409,
      headers: {
        "content-type": "application/problem+json",
        "x-moesegfault-correlation-id": "corr-7",
      },
    }));
    const client = new IdentityApiClient("https://identity.moesegfault.dev", fetchMock);

    const error = await client.getPrincipal().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      type: "urn:moesegfault:problem:transaction_expired",
      correlationId: "corr-7",
      message: "请重新开始。",
    });
  });

  it("retains its localized fallback for non-JSON proxy errors", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => new Response("<h1>Unavailable</h1>", { status: 502, headers: { "content-type": "text/html" } }));
    const error = await new IdentityApiClient("https://identity.moesegfault.dev", fetchMock).getPrincipal().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 502, message: "请求失败（HTTP 502）" });
  });

  it("rejects origins containing paths or non-HTTP schemes", () => {
    expect(() => new IdentityApiClient("https://identity.moesegfault.dev/v1"))
      .toThrow("Identity API origin 必须是纯 HTTP(S) origin");
    expect(() => new IdentityApiClient("javascript:alert(1)"))
      .toThrow();
  });

  it("uses the shared registration completion route for an additional passkey", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => new Response(JSON.stringify({
      account: {},
      authenticator: { label: "Security key" },
      csrf_token: "csrf-current",
      csrf_expires_at: "2026-09-14T00:00:00Z",
    }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    const client = new IdentityApiClient("https://identity.moesegfault.dev", fetchMock);
    const credential = {
      id: "credential",
      raw_id: "credential",
      type: "public-key",
      authenticator_attachment: "platform",
      client_extension_results: {},
      response: {
        client_data_json: "client-data",
        attestation_object: "attestation",
        transports: ["internal"],
      },
    } satisfies PublicKeyCredentialJson;

    await client.completeAuthenticatorRegistration("tx/addition", credential, {
      csrfToken: "csrf-transaction",
      idempotencyKey: "completion-attempt",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://identity.moesegfault.dev/v1/registration-transactions/tx%2Faddition/completion");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("completion-attempt");
    expect(JSON.parse(String(init?.body))).toEqual({ credential });
  });

  it("uses the direct password registration contract with rich optional profile data", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ account: {}, session: {}, csrf_token: "next", csrf_expires_at: "later" }), { status: 201, headers: { "content-type": "application/json" } }));
    const client = new IdentityApiClient("https://identity.moesegfault.dev", fetchMock);
    await client.registerWithPassword({ username: "klee", password: "correct horse battery", display_name: "Klee", email: "klee@example.com", mobile: { country_calling_code: "+86", national_number: "13800000000" }, profile: { favorite_character: "Klee", interests: ["Linux", "ACG"] } }, "csrf");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://identity.moesegfault.dev/v1/password/registrations");
    expect(JSON.parse(String(init?.body))).toMatchObject({ email: "klee@example.com", mobile: { country_calling_code: "+86" }, profile: { interests: ["Linux", "ACG"] } });
    expect(new Headers(init?.headers).get("idempotency-key")).toBeTruthy();
  });

  it("forwards authorization context to password login", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ authorization_uri: "https://github.com/login/oauth/authorize", transaction_id: "f1", expires_at: "later" }), { headers: { "content-type": "application/json" } }));
    const client = new IdentityApiClient("https://identity.moesegfault.dev", fetchMock);
    await client.authenticateWithPassword({ login: "klee", password: "secret", authorization_transaction_id: "oauth-1" }, "csrf");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/password/authentications");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ authorization_transaction_id: "oauth-1" });
  });

  it("uploads an optional avatar as multipart after registration", async () => {
    const uploadedAvatar = { avatar_id: "a1", url: "https://media.example/avatar.webp", media_type: "image/webp", width: 900, height: 900, updated_at: "2026-09-19T00:00:00Z" } as const;
    const fetchMock = vi.fn<FetchLike>(async () => new Response(JSON.stringify(uploadedAvatar), { headers: { "content-type": "application/json" } }));
    const client = new IdentityApiClient("https://identity.moesegfault.dev", fetchMock);
    const result = await client.uploadAvatar(new File(["image"], "klee.webp", { type: "image/webp" }), "session-csrf");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://identity.moesegfault.dev/v1/me/avatar");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("avatar")).toBeInstanceOf(File);
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("x-moesegfault-csrf")).toBe("session-csrf");
    expect(result).toEqual(uploadedAvatar);
  });

  it("starts and completes registration email verification with explicit mutation controls", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ transaction_id: "verify-1", expires_at: "later", delivery_hint: "k***@example.com" }), { status: 201, headers: { "content-type": "application/json" } }));
    const client = new IdentityApiClient("https://identity.moesegfault.dev", fetchMock);

    await client.startContactVerification("email/contact", { csrfToken: "session-csrf", idempotencyKey: "send-1" });
    await client.completeContactVerification("email/contact", "verify/1", "01234567", { csrfToken: "session-csrf", idempotencyKey: "complete-1" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://identity.moesegfault.dev/v1/me/contacts/email%2Fcontact/verification-transactions");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({});
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("idempotency-key")).toBe("send-1");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://identity.moesegfault.dev/v1/me/contacts/email%2Fcontact/verification-transactions/verify%2F1/completion");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ code: "01234567" });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("idempotency-key")).toBe("complete-1");
  });
});
