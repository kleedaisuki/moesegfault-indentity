// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate, type Locale } from "./i18n";

const draft = "msf_rc_synthetic.invalid-test-only";
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.doUnmock("./webauthn/ceremony"); });

/** Exercise real client error parsing without real recovery material or platform credentials. */
async function recover(locale: Locale, stage = "start", status = 400, code = "invalid_transaction", type?: string) {
  vi.resetModules();
  const createPasskey = vi.fn(async () => ({}));
  vi.doMock("./webauthn/ceremony", () => ({ isWebAuthnAvailable: () => true, createPasskey, getPasskey: vi.fn() }));
  const { IdentityApiClient } = await import("./api/client");
  const { renderPage } = await import("./pages");
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/browser-context" && stage !== "browser_context") return new Response(JSON.stringify({ csrf_token: "synthetic-csrf" }));
    if (path === "/v1/recovery-transactions" && stage === "completion") return new Response(JSON.stringify({ transaction_id: "synthetic", csrf_token: "synthetic-csrf", public_key: {} }));
    return new Response(JSON.stringify({ type: type ?? `https://identity.moesegfault.dev/problems/${code}`, error_code: code, title: "Different recovery server prose", status }), { status, headers: { "content-type": "application/problem+json" } });
  });
  vi.stubGlobal("location", { hostname: "login-staging.moesegfault.dev", href: "https://login-staging.moesegfault.dev/recovery" });
  const main = document.createElement("main"); document.body.append(main);
  await renderPage("/recovery", main, new IdentityApiClient("https://identity-staging.moesegfault.dev", fetchImpl), new AbortController().signal, { locale });
  main.querySelector<HTMLInputElement>('[name="recovery_code"]')!.value = draft;
  main.querySelector<HTMLInputElement>('[name="authenticator_label"]')!.value = "Synthetic label";
  main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(main.querySelector('[role="alert"]')).not.toBeNull());
  return { main, fetchImpl, createPasskey };
}

describe("rejected recovery material guidance", () => {
  it.each(["zh-CN", "en", "ja"] as const)("localizes only start rejection in %s while keeping retry drafts", async locale => {
    const { main, fetchImpl, createPasskey } = await recover(locale);
    expect(main.querySelector('[role="alert"]')?.textContent).toContain(translate(locale, "recoveryMaterialInvalid"));
    expect(main.textContent).not.toContain("Different recovery server prose");
    expect(main.querySelector<HTMLInputElement>('[name="recovery_code"]')!.value).toBe(draft);
    expect(main.querySelector<HTMLInputElement>('[name="authenticator_label"]')!.value).toBe("Synthetic label");
    expect(main.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(createPasskey).not.toHaveBeenCalled();
    main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
  });

  it.each([
    { stage: "browser_context", status: 400, code: "invalid_transaction" },
    { stage: "completion", status: 400, code: "invalid_transaction" },
    { stage: "start", status: 403, code: "invalid_request" },
    { stage: "start", status: 429, code: "rate_limited" },
    { stage: "start", status: 400, code: "invalid_request" },
  ])("keeps other errors unchanged: $stage/$status/$code", async ({ stage, status, code }) => {
    const { main } = await recover("zh-CN", stage, status, code, "https://identity.moesegfault.dev/problems/invalid_transaction");
    expect(main.querySelector('[role="alert"]')?.textContent).toContain("Different recovery server prose");
    expect(main.textContent).not.toContain(translate("zh-CN", "recoveryMaterialInvalid"));
    expect(main.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });
});
