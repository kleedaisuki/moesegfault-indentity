// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type IdentityApiClient } from "./api/client";
import { renderPage } from "./pages";
import { createPasskey, getPasskey } from "./webauthn/ceremony";
import { translate } from "./i18n";

vi.mock("./webauthn/ceremony", () => ({ isWebAuthnAvailable: () => true, createPasskey: vi.fn(), getPasskey: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(createPasskey).mockResolvedValue({} as never); vi.mocked(getPasskey).mockResolvedValue({} as never); });
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

/** Synthetic complete account ownership is sufficient to drive the real coordinator. */
function session(principal = "A") { return { csrf_token: `${principal}-csrf`, account: { principal_id: principal, identifiers: [{ kind: "username", value: `${principal}-user` }] } }; }
function problem(code: string, title = "Synthetic step-up") { return new ApiError(403, { status: 403, error_code: code, type: `https://identity.moesegfault.dev/problems/${code}`, title }); }

/** Exercise production coordinator wiring with isolated request doubles, never native credentials. */
async function fixture(route: "/passkey/enroll" | "/recovery-codes/rotate" = "/passkey/enroll") {
  vi.stubGlobal("location", { hostname: "login-staging.moesegfault.dev", href: `https://login-staging.moesegfault.dev${route}` });
  const principal = vi.fn(async () => session());
  const start = vi.fn(async (..._args: unknown[]) => ({ transaction_id: "addition", csrf_token: "addition-csrf", public_key: {}, recovery_codes: ["synthetic-rotation"] }));
  const assertion = vi.fn(async () => ({ transaction_id: "assertion", csrf_token: "assertion-csrf", public_key: {} }));
  const authComplete = vi.fn(async () => session());
  const complete = vi.fn(async () => ({ csrf_token: "completed" }));
  const api = { getPrincipal: principal, listAuthenticators: vi.fn(async () => ({ items: [{ revoked_at: null }] })), startAuthenticatorRegistration: start, completeAuthenticatorRegistration: complete, getBrowserContext: vi.fn(async () => ({ csrf_token: "browser" })), startAuthentication: assertion, completeAuthentication: authComplete, rotateRecoveryCodes: start } as unknown as IdentityApiClient;
  const main = document.createElement("main"); document.body.append(main); const abort = new AbortController();
  await renderPage(route, main, api, abort.signal, { locale: "en" });
  const submit = () => route === "/passkey/enroll" ? main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })) : main.querySelector<HTMLButtonElement>("button")!.click();
  return { api, main, abort, principal, start, assertion, authComplete, complete, submit };
}

describe.each(["/passkey/enroll", "/recovery-codes/rotate"] as const)("principal-bound management step-up on %s", route => {
  it("validates the live account before the initial active-key mutation", async () => {
    const f = await fixture(route); f.principal.mockResolvedValueOnce(session("B")); f.submit();
    await vi.waitFor(() => expect(f.main.textContent).toContain(translate("en", "managementAccountChanged")));
    expect(f.start).not.toHaveBeenCalled(); expect(f.assertion).not.toHaveBeenCalled();
  });

  it("rejects a stale-CSRF refresh to another account before retrying the credential mutation", async () => {
    const f = await fixture(route);
    if (route === "/recovery-codes/rotate") f.principal.mockResolvedValueOnce(session("A"));
    f.principal.mockResolvedValueOnce(session("A")).mockResolvedValueOnce(session("B"));
    f.start.mockRejectedValueOnce(problem("invalid_request", "CSRF validation failed")); f.submit();
    await vi.waitFor(() => expect(f.main.textContent).toContain(translate("en", "managementAccountChanged")));
    expect(f.start).toHaveBeenCalledOnce(); expect(f.assertion).not.toHaveBeenCalled(); expect(createPasskey).not.toHaveBeenCalled();
  });

  it("rejects another-account assertion result before retry or credential creation", async () => {
    const f = await fixture(route); f.start.mockRejectedValueOnce(problem("reauthentication_required"));
    f.authComplete.mockResolvedValueOnce(session("B")); f.submit();
    await vi.waitFor(() => expect(f.main.textContent).toContain(translate("en", "managementAccountChanged")));
    expect(f.start).toHaveBeenCalledOnce(); expect(getPasskey).toHaveBeenCalledOnce();
    expect(createPasskey).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  });

  it("never completes a late native assertion after management navigation abort", async () => {
    const f = await fixture(route); f.start.mockRejectedValueOnce(problem("reauthentication_required"));
    let resolve!: (value: never) => void;
    vi.mocked(getPasskey).mockReturnValueOnce(new Promise(ok => { resolve = ok; }));
    f.submit(); await vi.waitFor(() => expect(getPasskey).toHaveBeenCalledOnce());
    f.abort.abort(); f.main.replaceChildren(document.createTextNode("Next route"));
    resolve({} as never); await new Promise(ok => setTimeout(ok, 0));
    expect(f.authComplete).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledOnce();
    expect(f.main.textContent).toBe("Next route");
  });

  it("does not reuse account A's cached coordinator when the same client intentionally renders account B", async () => {
    const f = await fixture(route); f.submit();
    await vi.waitFor(() => expect(route === "/passkey/enroll" ? f.complete.mock.calls.length : f.main.textContent?.includes("synthetic-rotation")).toBe(route === "/passkey/enroll" ? 1 : true));
    f.abort.abort(); f.principal.mockImplementation(async () => session("B"));
    await renderPage(route, f.main, f.api, new AbortController().signal, { locale: "en" });
    f.submit(); await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
    const controls = f.start.mock.calls[1]![route === "/passkey/enroll" ? 1 : 0] as { csrfToken: string };
    expect(controls.csrfToken).toBe("B-csrf");
  });
});
