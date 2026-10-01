// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentityApiClient } from "./api/client";

const sentinel = "SECRET-FORM-COOKIE-OAUTH-URL";
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.doUnmock("./webauthn/ceremony"); });

/** Render a fresh module so page-lifetime CSRF state cannot bleed across cases. */
async function login(fetchImpl: ConstructorParameters<typeof IdentityApiClient>[1], mode: "password" | "passkey" = "password") {
  vi.resetModules();
  const { IdentityApiClient: Client } = await import("./api/client");
  const { renderPage } = await import("./pages");
  const main = document.createElement("main"); document.body.append(main);
  const assign = vi.fn();
  vi.stubGlobal("location", { hostname: "login-staging.moesegfault.dev", href: `https://login-staging.moesegfault.dev/login?state=${sentinel}#${sentinel}`, assign });
  await renderPage("/login", main, new Client("https://identity-staging.moesegfault.dev", fetchImpl), new AbortController().signal, { locale: "en" });
  main.querySelector<HTMLInputElement>('input[name="login"]')!.value = sentinel;
  main.querySelector<HTMLInputElement>('input[name="password"]')!.value = sentinel;
  if (mode === "password") main.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  else main.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
  return { main, assign };
}

describe("Login failure receipt integration", () => {
  it.each([401, 413])("preserves failure copy, bounds the receipt and never retries HTTP %s", async (status) => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/v1/browser-context")
      ? new Response(JSON.stringify({ csrf_token: sentinel }), { status: 200 })
      : new Response(JSON.stringify({ type: "urn:moesegfault:problem:authentication_failed", title: "Authentication failed", status, detail: "Authentication failed", instance: sentinel }), { status, headers: { "content-type": "application/problem+json" } }));
    const { main, assign } = await login(fetchImpl);
    await vi.waitFor(() => expect(main.querySelector("details")).not.toBeNull());
    const receipt = JSON.parse(main.querySelector("pre")!.textContent!);
    expect(receipt).toMatchObject({ operation: "password_authentication", realm: "staging", status, problem: "authentication_failed" });
    expect(main.querySelector("pre")!.textContent).not.toContain(sentinel);
    expect(main.textContent).toContain("Sign-in wasn't completed");
    expect(main.textContent).toContain("Authentication failed");
    expect(main.querySelector("details")!.hasAttribute("open")).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(assign).not.toHaveBeenCalled();
  });

  it("attributes browser-context failure before submitting any credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 403, headers: { "content-type": "application/problem+json" } }));
    const { main, assign } = await login(fetchImpl);
    await vi.waitFor(() => expect(main.querySelector("pre")).not.toBeNull());
    expect(JSON.parse(main.querySelector("pre")!.textContent!)).toMatchObject({ operation: "browser_context", status: 403 });
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(assign).not.toHaveBeenCalled();
  });


  it("attributes a cancelled browser Passkey ceremony without leaking its exception", async () => {
    vi.doMock("./webauthn/ceremony", () => ({ isWebAuthnAvailable: () => true, getPasskey: async () => { throw new DOMException(sentinel, "AbortError"); }, createPasskey: vi.fn() }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith("/v1/browser-context") ? { csrf_token: sentinel } : { transaction_id: sentinel, csrf_token: sentinel, public_key: {} }), { status: 200 }));
    const { main, assign } = await login(fetchImpl, "passkey");
    await vi.waitFor(() => expect(main.querySelector("pre")).not.toBeNull());
    expect(JSON.parse(main.querySelector("pre")!.textContent!)).toMatchObject({ operation: "passkey_completion", transport: "aborted", problem: "unknown" });
    expect(main.querySelector("pre")!.textContent).not.toContain(sentinel);
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(assign).not.toHaveBeenCalled();
  });

  it("shows no receipt or copy affordance after successful authentication", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith("/v1/browser-context") ? { csrf_token: sentinel } : { csrf_token: sentinel }), { status: 200 }));
    const { main } = await login(fetchImpl);
    await vi.waitFor(() => expect(main.querySelector(".state--success")).not.toBeNull());
    expect(main.querySelector("details")).toBeNull(); expect(main.querySelector("pre")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
