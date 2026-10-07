// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type IdentityApiClient } from "./api/client";
import { renderPage } from "./pages";
import { translate, type Locale } from "./i18n";
import { createPasskey, getPasskey } from "./webauthn/ceremony";

const execute = vi.hoisted(() => vi.fn(async (action: (controls: unknown) => Promise<unknown>) => action({ csrfToken: "step-up-csrf", idempotencyKey: "synthetic" })));
vi.mock("./step-up", () => ({ InlineStepUpCoordinator: class { execute = execute; } }));
vi.mock("./webauthn/ceremony", () => ({ isWebAuthnAvailable: () => true, createPasskey: vi.fn(), getPasskey: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(createPasskey).mockResolvedValue({} as never); });
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

/** Explicit synthetic structured rejection; title must not drive the fallback decision. */
function rejection(status = 403, code = "reauthentication_required") {
  return new ApiError(status, { status, error_code: code, type: `https://identity.moesegfault.dev/problems/${code}`, title: "Synthetic server error" });
}

/** Render the enrollment UI with controlled requests and no real platform credential. */
async function fixture(locale: Locale = "en") {
  vi.stubGlobal("location", { hostname: "login-staging.moesegfault.dev", href: "https://login-staging.moesegfault.dev/passkey/enroll?return_uri=https%3A%2F%2Faccount-staging.moesegfault.dev%2Fsecurity" });
  const principal = vi.fn(async () => ({ csrf_token: "current-session-csrf", account: { principal_id: "expected", identifiers: [{ kind: "username", value: "expected-user" }] } }));
  const list = vi.fn(async () => ({ items: [] as { revoked_at?: string | null }[] }));
  const start = vi.fn(async () => ({ transaction_id: "addition", csrf_token: "transaction-csrf", public_key: {} }));
  const complete = vi.fn(async () => ({ csrf_token: "completed-session" }));
  const password = vi.fn(async () => ({ csrf_token: "password-session-csrf", account: { principal_id: "expected" } }));
  const browser = vi.fn(async () => ({ csrf_token: "browser-csrf" }));
  const api = { getPrincipal: principal, listAuthenticators: list, startAuthenticatorRegistration: start, completeAuthenticatorRegistration: complete, authenticateWithPassword: password, getBrowserContext: browser } as unknown as IdentityApiClient;
  const main = document.createElement("main"); document.body.append(main); const abort = new AbortController();
  await renderPage("/passkey/enroll", main, api, abort.signal, { locale });
  const forms = main.querySelectorAll<HTMLFormElement>("form");
  const send = (form: HTMLFormElement) => form.dispatchEvent(new Event("submit", { cancelable: true }));
  const label = main.querySelector<HTMLInputElement>('[name="label"]')!; label.value = "Preserved key label";
  const fallback = main.querySelector<HTMLDetailsElement>("details")!;
  const login = main.querySelector<HTMLInputElement>('[name="login"]')!;
  const passwordInput = main.querySelector<HTMLInputElement>('[name="password"]')!;
  return { main, principal, list, start, complete, password, browser, abort, forms, send, label, fallback, login, passwordInput };
}

describe("first Passkey enrollment bootstrap", () => {
  it("uses current session authorization directly for a recent zero-key account", async () => {
    const f = await fixture(); f.send(f.forms[0]!);
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce());
    expect(f.principal).toHaveBeenCalledTimes(2);
    expect(f.start).toHaveBeenCalledWith("Preserved key label", expect.objectContaining({ csrfToken: "current-session-csrf", signal: f.abort.signal, idempotencyKey: expect.any(String) }));
    expect(execute).not.toHaveBeenCalled(); expect(getPasskey).not.toHaveBeenCalled(); expect(createPasskey).toHaveBeenCalledOnce();
    expect(f.main.querySelector('a[href="https://account-staging.moesegfault.dev/security"]')).not.toBeNull();
  });

  it.each(["zh-CN", "en", "ja"] as const)("opens password confirmation for a stale zero-key session in %s", async locale => {
    const f = await fixture(locale); f.start.mockRejectedValueOnce(rejection()); f.send(f.forms[0]!);
    await vi.waitFor(() => expect(f.fallback.open).toBe(true));
    expect(f.main.textContent).toContain(translate(locale, "firstPasskeyConfirmation"));
    expect(document.activeElement).toBe(f.passwordInput); expect(f.login.readOnly).toBe(true); expect(f.login.value).toBe("expected-user"); expect(f.label.value).toBe("Preserved key label");
    expect(execute).not.toHaveBeenCalled(); expect(getPasskey).not.toHaveBeenCalled(); expect(createPasskey).not.toHaveBeenCalled();
    expect(f.password).not.toHaveBeenCalled();
    f.login.value = "synthetic-user"; f.passwordInput.value = "synthetic-password";
    f.send(f.forms[1]!); await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce());
    expect(f.start).toHaveBeenLastCalledWith("Preserved key label", expect.objectContaining({ csrfToken: "password-session-csrf" }));
    expect(createPasskey).toHaveBeenCalledOnce();
  });

  it("retains the existing step-up coordinator for active keys", async () => {
    const f = await fixture(); f.list.mockResolvedValueOnce({ items: [{ revoked_at: null }] }); f.send(f.forms[0]!);
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledOnce(); expect(f.principal).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledWith("Preserved key label", expect.objectContaining({ csrfToken: "step-up-csrf" }));
  });

  it.each([rejection(403, "invalid_request"), rejection(429), rejection(401)])("does not treat other structured errors as first-key reauthentication", async error => {
    const f = await fixture(); f.start.mockRejectedValueOnce(error); f.send(f.forms[0]!);
    await vi.waitFor(() => expect(f.main.textContent).toContain("Synthetic server error"));
    expect(f.fallback.open).toBe(false); expect(f.main.textContent).toContain(translate("en", "enrollFailed"));
    expect(createPasskey).not.toHaveBeenCalled(); expect(getPasskey).not.toHaveBeenCalled();
  });

  it("keeps a failed key-list read as an error, not a first-key assumption", async () => {
    const f = await fixture(); f.list.mockRejectedValueOnce(new Error("List unavailable")); f.send(f.forms[0]!);
    await vi.waitFor(() => expect(f.main.textContent).toContain("List unavailable"));
    expect(f.start).not.toHaveBeenCalled(); expect(f.fallback.open).toBe(false); expect(execute).not.toHaveBeenCalled();
  });

  it("stops enrollment if the current session changes account while the page is open", async () => {
    const f = await fixture();
    f.principal.mockResolvedValueOnce({ csrf_token: "different-session", account: { principal_id: "different", identifiers: [] } });
    f.send(f.forms[0]!);
    await vi.waitFor(() => expect(f.main.textContent).toContain(translate("en", "managementAccountChanged")));
    expect(f.start).not.toHaveBeenCalled(); expect(createPasskey).not.toHaveBeenCalled();
  });

  it("does not enroll another account after password-manager identity substitution", async () => {
    const f = await fixture();
    // Readonly is an affordance, not a security boundary: simulate a changed submitted identity.
    f.login.value = "another-user"; f.passwordInput.value = "synthetic-password";
    f.password.mockResolvedValueOnce({ csrf_token: "other-password-session", account: { principal_id: "different" } });
    f.send(f.forms[1]!);
    await vi.waitFor(() => expect(f.main.textContent).toContain(translate("en", "managementAccountChanged")));
    expect(f.password).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled();
    expect(createPasskey).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    expect(f.main.querySelector('a[href="https://account-staging.moesegfault.dev/security"]')).not.toBeNull();
  });

  it.each(["add", "password"] as const)("locks both forms during %s ownership, including repeated synthetic submits", async owner => {
    const f = await fixture(); let reject!: (error: unknown) => void;
    const pending = new Promise<never>((_ok, fail) => { reject = fail; });
    if (owner === "add") f.list.mockReturnValueOnce(pending); else f.password.mockReturnValueOnce(pending);
    f.send(f.forms[owner === "add" ? 0 : 1]!);
    await vi.waitFor(() => expect(owner === "add" ? f.list : f.password).toHaveBeenCalledOnce());
    for (const form of f.forms) { expect(form.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true); f.send(form); }
    expect(f.list).toHaveBeenCalledTimes(owner === "add" ? 1 : 0);
    expect(f.password).toHaveBeenCalledTimes(owner === "password" ? 1 : 0);
    reject(new Error("Retry allowed"));
    await vi.waitFor(() => expect([...f.forms].every(form => !form.querySelector<HTMLButtonElement>("button")!.disabled)).toBe(true));
  });

  it.each(["list", "start", "native", "password"] as const)("ignores a late %s response after route abort", async phase => {
    const f = await fixture(); let resolve!: (value: never) => void;
    const pending = new Promise<never>(ok => { resolve = ok; });
    if (phase === "list") f.list.mockReturnValueOnce(pending);
    if (phase === "start") f.start.mockReturnValueOnce(pending);
    if (phase === "native") vi.mocked(createPasskey).mockReturnValueOnce(pending);
    if (phase === "password") f.password.mockReturnValueOnce(pending);
    f.send(f.forms[phase === "password" ? 1 : 0]!);
    const gate = phase === "list" ? f.list : phase === "start" ? f.start : phase === "native" ? createPasskey : f.password;
    await vi.waitFor(() => expect(gate).toHaveBeenCalledOnce());
    const startsBeforeAbort = f.start.mock.calls.length;
    f.abort.abort(); f.main.replaceChildren(document.createTextNode("New route"));
    resolve((phase === "list" ? { items: [] } : phase === "password" ? { csrf_token: "late-password" } : { transaction_id: "late", public_key: {}, csrf_token: "late" }) as never);
    await new Promise(ok => setTimeout(ok, 0));
    expect(f.start).toHaveBeenCalledTimes(startsBeforeAbort); expect(f.complete).not.toHaveBeenCalled();
    expect(f.main.textContent).toBe("New route");
  });
});
