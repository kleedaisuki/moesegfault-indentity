// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentityApiClient } from "./api/client";
import { translate, type Locale } from "./i18n";

const sentinel = "SECRET-FORM-COOKIE-OAUTH-URL";
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.doUnmock("./webauthn/ceremony"); });

/** Render a fresh module so page-lifetime CSRF state cannot bleed across cases. */
async function login(fetchImpl: ConstructorParameters<typeof IdentityApiClient>[1], mode: "password" | "passkey" = "password", locale: Locale = "en") {
  vi.resetModules();
  const { IdentityApiClient: Client } = await import("./api/client");
  const { renderPage } = await import("./pages");
  const main = document.createElement("main"); document.body.append(main);
  const assign = vi.fn();
  vi.stubGlobal("location", { hostname: "login-staging.moesegfault.dev", href: `https://login-staging.moesegfault.dev/login?state=${sentinel}#${sentinel}`, assign });
  await renderPage("/login", main, new Client("https://identity-staging.moesegfault.dev", fetchImpl), new AbortController().signal, { locale });
  main.querySelector<HTMLInputElement>('input[name="login"]')!.value = sentinel;
  main.querySelector<HTMLInputElement>('input[name="password"]')!.value = sentinel;
  if (mode === "password") main.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  else main.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
  return { main, assign };
}

describe("Login failure receipt integration", () => {
  it.each([401, 413])("localizes only credential rejection, bounds the receipt and never retries HTTP %s", async (status) => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/v1/browser-context")
      ? new Response(JSON.stringify({ csrf_token: sentinel }), { status: 200 })
      : new Response(JSON.stringify({ type: "urn:moesegfault:problem:authentication_failed", title: "Authentication failed", status, detail: "Authentication failed", instance: sentinel }), { status, headers: { "content-type": "application/problem+json" } }));
    const { main, assign } = await login(fetchImpl);
    await vi.waitFor(() => expect(main.querySelector("details")).not.toBeNull());
    const receipt = JSON.parse(main.querySelector("pre")!.textContent!);
    expect(receipt).toMatchObject({ operation: "password_authentication", realm: "staging", status, problem: "authentication_failed" });
    expect(main.querySelector("pre")!.textContent).not.toContain(sentinel);
    expect(main.textContent).toContain("Sign-in wasn't completed");
    expect(main.textContent).toContain(status === 401 ? translate("en", "passwordCredentialsRejected") : "Authentication failed");
    expect(main.querySelector("details")!.hasAttribute("open")).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(assign).not.toHaveBeenCalled();
  });


  it.each(["zh-CN", "en", "ja"] as const)("gives actionable non-enumerating password feedback in %s and preserves retry drafts", async (locale) => {
    vi.doMock("./webauthn/ceremony", () => ({ isWebAuthnAvailable: () => true, getPasskey: vi.fn(), createPasskey: vi.fn() }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/v1/browser-context")
      ? new Response(JSON.stringify({ csrf_token: sentinel }), { status: 200 })
      : new Response(JSON.stringify({ type: "https://identity.moesegfault.dev/problems/authentication_failed", error_code: "authentication_failed", title: "Different server prose", status: 401 }), { status: 401, headers: { "content-type": "application/problem+json" } }));
    const { main, assign } = await login(fetchImpl, "password", locale);
    await vi.waitFor(() => expect(main.querySelector("details")).not.toBeNull());
    expect(main.querySelector('[role="alert"]')?.textContent).toContain(translate(locale, "passwordCredentialsRejected"));
    expect(main.textContent).not.toContain("Different server prose");
    expect(main.querySelector<HTMLInputElement>('[name="login"]')!.value).toBe(sentinel);
    expect(main.querySelector<HTMLInputElement>('[name="password"]')!.value).toBe(sentinel);
    expect(main.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(main.querySelector<HTMLButtonElement>('button[type="button"]')!.disabled).toBe(false);
    expect(main.querySelector("details")!.hasAttribute("open")).toBe(false);
    expect(main.querySelector("pre")!.textContent).not.toContain(sentinel);
    main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401, code: "not_authenticated", type: "https://identity.moesegfault.dev/problems/authentication_failed", mode: "password" as const },
    { status: 403, code: "authentication_failed", type: "https://identity.moesegfault.dev/problems/authentication_failed", mode: "password" as const },
    { status: 429, code: "rate_limited", type: "https://identity.moesegfault.dev/problems/rate_limited", mode: "password" as const },
    { status: 401, code: "authentication_failed", type: "https://identity.moesegfault.dev/problems/authentication_failed", mode: "passkey" as const },
  ])("preserves non-password-rejection error $status/$code/$mode", async ({ status, code, type, mode }) => {
    vi.doMock("./webauthn/ceremony", () => ({ isWebAuthnAvailable: () => true, getPasskey: vi.fn(), createPasskey: vi.fn() }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/v1/browser-context")
      ? new Response(JSON.stringify({ csrf_token: sentinel }), { status: 200 })
      : new Response(JSON.stringify({ type, error_code: code, title: "Authentication failed", status }), { status, headers: { "content-type": "application/problem+json" } }));
    const { main } = await login(fetchImpl, mode);
    await vi.waitFor(() => expect(main.querySelector("details")).not.toBeNull());
    expect(main.querySelector('[role="alert"]')?.textContent).toContain("Authentication failed");
    expect(main.textContent).not.toContain(translate("en", "passwordCredentialsRejected"));
  });

  it.each(["browser_context", "network"] as const)("does not translate credential-like prose from %s failures", async (source) => {
    const fetchImpl = vi.fn(async () => {
      if (source === "network") throw new TypeError("Authentication failed");
      return new Response(JSON.stringify({ type: "https://identity.moesegfault.dev/problems/authentication_failed", error_code: "authentication_failed", title: "Authentication failed", status: 401 }), { status: 401, headers: { "content-type": "application/problem+json" } });
    });
    const { main } = await login(fetchImpl);
    await vi.waitFor(() => expect(main.querySelector("details")).not.toBeNull());
    expect(main.querySelector('[role="alert"]')?.textContent).toContain(source === "network" ? "请检查网络后重试。没有任何凭据被保存到此浏览器。" : "Authentication failed");
    expect(main.textContent).not.toContain(translate("en", "passwordCredentialsRejected"));
    expect(fetchImpl).toHaveBeenCalledOnce();
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
