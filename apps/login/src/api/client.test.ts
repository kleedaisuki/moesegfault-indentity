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

  it("rejects origins containing paths or non-HTTP schemes", () => {
    expect(() => new IdentityApiClient("https://identity.moesegfault.dev/v1"))
      .toThrow(/origin/u);
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
    const fetchMock = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ principal_id: "p1" }), { headers: { "content-type": "application/json" } }));
    const client = new IdentityApiClient("https://identity.moesegfault.dev", fetchMock);
    await client.uploadAvatar(new File(["image"], "klee.png", { type: "image/png" }), "session-csrf");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://identity.moesegfault.dev/v1/me/avatar");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("avatar")).toBeInstanceOf(File);
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("x-moesegfault-csrf")).toBe("session-csrf");
  });
});
