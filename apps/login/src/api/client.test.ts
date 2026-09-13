import { describe, expect, it, vi } from "vitest";
import { ApiError, IdentityApiClient, type FetchLike } from "./client";

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
});
