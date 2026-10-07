// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityApiClient } from "./api/client";
import { PageLifecycle } from "./page-lifecycle";
import { renderPage } from "./pages";
import { translate, type Locale } from "./i18n";
import { getPasskey } from "./webauthn/ceremony";

vi.mock("./webauthn/ceremony", () => ({ isWebAuthnAvailable: () => true, getPasskey: vi.fn(), createPasskey: vi.fn() }));
const aborts: AbortController[] = [];
beforeEach(() => vi.resetAllMocks());
afterEach(() => { aborts.splice(0).forEach(abort => abort.abort()); vi.unstubAllGlobals(); document.body.replaceChildren(); });

/** Model native promises that deliberately ignore the abort signal. */
function pending<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/** Render Login using synthetic credentials and controlled server/platform boundaries. */
async function fixture(locale: Locale = "en") {
  const native = pending<Awaited<ReturnType<typeof getPasskey>>>();
  vi.mocked(getPasskey).mockReturnValueOnce(native.promise);
  const start = vi.fn(async () => ({ transaction_id: "attempt", csrf_token: "csrf", public_key: {} }));
  const complete = vi.fn(async () => ({ csrf_token: "session" }));
  const password = vi.fn(async () => ({ csrf_token: "session" }));
  const api = { getBrowserContext: vi.fn(async () => ({ csrf_token: "csrf" })), startAuthentication: start, completeAuthentication: complete, authenticateWithPassword: password } as unknown as IdentityApiClient;
  const assign = vi.fn();
  vi.stubGlobal("location", { hostname: "login-staging.moesegfault.dev", href: "https://login-staging.moesegfault.dev/login?return_uri=https%3A%2F%2Faccount-staging.moesegfault.dev%2Fprofile", assign });
  const abort = new AbortController(); aborts.push(abort);
  const lifecycle = new PageLifecycle(locale); const main = document.createElement("main"); document.body.append(main);
  await renderPage("/login", main, api, abort.signal, lifecycle);
  const input = (name: string) => main.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  input("login").value = "synthetic-user"; input("password").value = "synthetic-password";
  const passkey = main.querySelector<HTMLButtonElement>('button[type="button"]')!;
  const cancel = [...main.querySelectorAll<HTMLButtonElement>('button[type="button"]')][1]!;
  const submit = () => main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  const wait = async () => { passkey.click(); await vi.waitFor(() => expect(cancel.hidden).toBe(false)); };
  return { main, input, passkey, cancel, abort, lifecycle, native, start, complete, password, assign, submit, wait };
}

describe("explicit Login Passkey cancellation", () => {
  it.each(["zh-CN", "en", "ja"] as const)("releases a never-settling chooser in %s without submitting a password", async locale => {
    const f = await fixture(locale); await f.wait();
    const nativeSignal = vi.mocked(getPasskey).mock.calls[0]![1]!;
    expect(f.cancel.textContent).toBe(translate(locale, "cancelPasskey"));
    f.cancel.click();
    expect(nativeSignal.aborted).toBe(true); expect(f.abort.signal.aborted).toBe(false);
    expect(f.passkey.disabled).toBe(false);
    expect(f.main.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(f.cancel.hidden).toBe(true);
    expect(f.input("login").value).toBe("synthetic-user"); expect(f.input("password").value).toBe("synthetic-password");
    expect(document.activeElement).toBe(f.input("password"));
    expect(f.main.textContent).toContain(translate(locale, "passwordFallbackReady"));
    expect(f.complete).not.toHaveBeenCalled(); expect(f.password).not.toHaveBeenCalled(); expect(f.assign).not.toHaveBeenCalled();
    f.submit(); await vi.waitFor(() => expect(f.assign).toHaveBeenCalledWith("https://account-staging.moesegfault.dev/profile"));
    expect(f.password).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)("ignores late %s and repeated cancellation during a newer password attempt", async outcome => {
    const f = await fixture(); await f.wait(); f.cancel.click();
    const newer = pending<Awaited<ReturnType<IdentityApiClient["authenticateWithPassword"]>>>();
    f.password.mockReturnValueOnce(newer.promise as never); f.submit();
    await vi.waitFor(() => expect(f.password).toHaveBeenCalledOnce());
    f.cancel.dispatchEvent(new Event("click"));
    if (outcome === "resolve") f.native.resolve({} as never); else f.native.reject(new Error("stale-native-failure"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.complete).not.toHaveBeenCalled(); expect(f.assign).not.toHaveBeenCalled();
    expect(f.main.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect(f.main.textContent).not.toContain("stale-native-failure");
  });

  it("flushes deferred locale projection on cancellation without losing drafts", async () => {
    const f = await fixture("zh-CN"); await f.wait(); const oldForm = f.main.querySelector("form");
    f.lifecycle.relocalize("ja"); expect(f.main.querySelector("form")).toBe(oldForm);
    f.cancel.click(); expect(f.main.querySelector("form")).not.toBe(oldForm);
    expect(f.main.textContent).toContain(translate("ja", "passwordFallbackReady"));
    expect(f.input("password").value).toBe("synthetic-password");
    f.native.resolve({} as never); await new Promise(resolve => setTimeout(resolve, 0));
    expect(getPasskey).toHaveBeenCalledOnce(); expect(f.complete).not.toHaveBeenCalled();
    expect(f.main.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });

  it("aborts the native attempt with the route and ignores late credentials", async () => {
    const f = await fixture(); await f.wait(); f.abort.abort();
    expect(vi.mocked(getPasskey).mock.calls[0]![1]!.aborted).toBe(true);
    f.main.replaceChildren(document.createTextNode("New route"));
    f.native.resolve({} as never); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.complete).not.toHaveBeenCalled(); expect(f.main.textContent).toBe("New route"); expect(f.assign).not.toHaveBeenCalled();
  });

  it("cannot cancel the start mutation and never opens a chooser after route abort", async () => {
    const f = await fixture(); const starting = pending<Awaited<ReturnType<IdentityApiClient["startAuthentication"]>>>();
    f.start.mockReturnValueOnce(starting.promise as never); f.passkey.click();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    expect(f.cancel.hidden).toBe(true); f.cancel.dispatchEvent(new Event("click"));
    expect(f.passkey.disabled).toBe(true);
    f.abort.abort(); starting.resolve({ transaction_id: "late", csrf_token: "csrf", public_key: {} } as never);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getPasskey).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  });

  it("removes cancellation before server completion and keeps its lock until success", async () => {
    const f = await fixture(); const completing = pending<Awaited<ReturnType<IdentityApiClient["completeAuthentication"]>>>();
    f.complete.mockReturnValueOnce(completing.promise as never); await f.wait(); f.native.resolve({} as never);
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce());
    expect(f.cancel.hidden).toBe(true); f.cancel.dispatchEvent(new Event("click"));
    expect(vi.mocked(getPasskey).mock.calls[0]![1]!.aborted).toBe(false);
    expect(f.passkey.disabled).toBe(true); f.submit(); expect(f.password).not.toHaveBeenCalled();
    completing.resolve({ csrf_token: "session" } as never);
    await vi.waitFor(() => expect(f.assign).toHaveBeenCalledWith("https://account-staging.moesegfault.dev/profile"));
  });
});
