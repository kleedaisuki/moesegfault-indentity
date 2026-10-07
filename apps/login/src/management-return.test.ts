// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityApiClient } from "./api/client";
import { renderPage } from "./pages";

vi.mock("./webauthn/ceremony", () => ({ isWebAuthnAvailable: () => true, createPasskey: vi.fn(async () => ({})), getPasskey: vi.fn() }));
vi.mock("./step-up", () => ({ InlineStepUpCoordinator: class {
  execute(action: (controls: unknown) => Promise<unknown>, options: { signal: AbortSignal; onStepUpRequired?: () => void }) {
    options.onStepUpRequired?.();
    return action({ csrfToken: "synthetic", idempotencyKey: "synthetic", signal: options.signal });
  }
} }));
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

/** Set only the route and untrusted return parameter; no real credentials or requests. */
function setLocation(route: string, target?: string) {
  vi.stubGlobal("location", { hostname: "login-staging.moesegfault.dev", href: `https://login-staging.moesegfault.dev${route}${target ? `?return_uri=${encodeURIComponent(target)}` : ""}` });
}

/** Assert a real navigation anchor, not a mutation button or JavaScript command. */
function returnLink(main: HTMLElement, destination = "https://account-staging.moesegfault.dev/security") {
  const anchor = main.querySelector<HTMLAnchorElement>('a.button--secondary');
  expect(anchor?.getAttribute("href")).toBe(destination);
  expect(anchor?.textContent).toContain("Return to Account Center");
  expect(anchor?.hasAttribute("aria-disabled")).toBe(false);
}

describe.each(["/passkey/enroll", "/recovery-codes/rotate"] as const)("management return navigation on %s", route => {
  it.each([
    { target: "https://account-staging.moesegfault.dev/security", expected: "https://account-staging.moesegfault.dev/security" },
    { target: "https://evil.example/security", expected: "https://account-staging.moesegfault.dev" },
    { target: "https://account.moesegfault.dev/security", expected: "https://account-staging.moesegfault.dev" },
    { target: undefined, expected: "https://account-staging.moesegfault.dev" },
  ])("uses only the safe return destination $target", async ({ target, expected }) => {
    setLocation(route, target);
    const start = vi.fn(); const rotate = vi.fn();
    const api = { getPrincipal: vi.fn(async () => ({ csrf_token: "synthetic", account: { principal_id: "expected", identifiers: [] } })), startAuthenticatorRegistration: start, rotateRecoveryCodes: rotate } as unknown as IdentityApiClient;
    const main = document.createElement("main");
    await renderPage(route, main, api, new AbortController().signal, { locale: "en" });
    returnLink(main, expected);
    expect(start).not.toHaveBeenCalled(); expect(rotate).not.toHaveBeenCalled();
  });

  it.each(["reject", "resolve"] as const)("retains navigation through step-up/pending and %s", async outcome => {
    setLocation(route, "https://account-staging.moesegfault.dev/security");
    let resolve!: (value: unknown) => void; let reject!: (error: unknown) => void;
    const pending = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail; });
    const operation = vi.fn(() => pending);
    const api = { getPrincipal: vi.fn(async () => ({ csrf_token: "synthetic", account: { principal_id: "expected", identifiers: [] } })), startAuthenticatorRegistration: operation, rotateRecoveryCodes: operation, listAuthenticators: vi.fn(async () => ({ items: [{ authenticator_id: "synthetic-active" }] })), completeAuthenticatorRegistration: vi.fn(async () => ({ csrf_token: "synthetic" })) } as unknown as IdentityApiClient;
    const main = document.createElement("main"); document.body.append(main);
    await renderPage(route, main, api, new AbortController().signal, { locale: "en" });
    if (route === "/passkey/enroll") main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    else main.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    returnLink(main);
    expect(main.textContent).toContain("Confirm your identity once more");
    if (outcome === "reject") reject(new Error("Synthetic failure"));
    else resolve(route === "/passkey/enroll" ? { transaction_id: "synthetic", csrf_token: "synthetic", public_key: {} } : { recovery_codes: ["synthetic-not-real-code"] });
    await vi.waitFor(() => expect(main.textContent).toContain(outcome === "reject" ? "Synthetic failure" : route === "/passkey/enroll" ? "Passkey added" : "synthetic-not-real-code"));
    returnLink(main);
  });
});

it("offers safe return while enrollment session loads and if session initialization fails", async () => {
  setLocation("/passkey/enroll", "https://account-staging.moesegfault.dev/security");
  let reject!: (error: unknown) => void;
  const api = { getPrincipal: vi.fn(() => new Promise((_ok, fail) => { reject = fail; })) } as unknown as IdentityApiClient;
  const main = document.createElement("main");
  const rendering = renderPage("/passkey/enroll", main, api, new AbortController().signal, { locale: "en" });
  returnLink(main);
  reject(new Error("Synthetic unavailable session")); await rendering;
  returnLink(main); expect(main.textContent).toContain("Synthetic unavailable session");
});
