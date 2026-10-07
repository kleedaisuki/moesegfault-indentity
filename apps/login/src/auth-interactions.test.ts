// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityApiClient } from "./api/client";
import type { RegistrationStart } from "./api/types";
import { renderPage } from "./pages";

vi.mock("./webauthn/ceremony", () => ({
  isWebAuthnAvailable: () => true,
  getPasskey: vi.fn(),
  createPasskey: vi.fn(async () => { throw new DOMException("Cancelled", "NotAllowedError"); }),
}));

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

/** Renders a real Login page while keeping transport and platform ceremonies controlled. */
async function render(route: "/login" | "/register", api: IdentityApiClient) {
  vi.stubGlobal("location", { hostname: "login-staging.moesegfault.dev", href: `https://login-staging.moesegfault.dev${route}` });
  const main = document.createElement("main");
  document.body.append(main);
  await renderPage(route, main, api, new AbortController().signal, { locale: "en" });
  return main;
}

describe("exclusive login submissions", () => {
  it.each(["password", "passkey"] as const)("locks both methods while %s authentication is pending and restores them on failure", async (method) => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
    const authenticateWithPassword = vi.fn(() => pending);
    const startAuthentication = vi.fn(() => pending);
    const api = { getBrowserContext: vi.fn(async () => ({ csrf_token: "csrf" })), authenticateWithPassword, startAuthentication } as unknown as IdentityApiClient;
    const main = await render("/login", api);
    const form = main.querySelector("form")!;
    const password = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const passkey = main.querySelector<HTMLButtonElement>('button[type="button"]')!;
    if (method === "password") form.dispatchEvent(new Event("submit", { cancelable: true }));
    else passkey.click();
    expect(password.disabled).toBe(true);
    expect(passkey.disabled).toBe(true);
    // Exercise guards as well as disabled native clicks (e.g. repeated Enter events).
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    passkey.dispatchEvent(new Event("click"));
    await vi.waitFor(() => expect(method === "password" ? authenticateWithPassword : startAuthentication).toHaveBeenCalledOnce());
    expect(method === "password" ? startAuthentication : authenticateWithPassword).not.toHaveBeenCalled();
    reject(new Error("Try again"));
    await vi.waitFor(() => expect(password.disabled).toBe(false));
    expect(passkey.disabled).toBe(false);
    expect(main.querySelector('[role="alert"]')?.textContent).toContain("Try again");
  });
});

describe("independent Passkey registration validation", () => {
  it("starts Passkey registration despite short, mismatched password drafts", async () => {
    const startRegistration = vi.fn(async (_input: RegistrationStart) => ({ transaction_id: "register", csrf_token: "csrf", public_key: {} }));
    const api = {
      getBrowserContext: vi.fn(async () => ({ csrf_token: "csrf" })),
      startRegistrationEmail: vi.fn(async () => ({ transaction_id: "email", delivery_hint: "test@example.test", resend_after: new Date().toISOString() })),
      completeRegistrationEmail: vi.fn(async () => ({ email_verification_token: "proof", expires_at: new Date(Date.now() + 600000).toISOString() })),
      startRegistration,
    } as unknown as IdentityApiClient;
    const main = await render("/register", api);
    for (const [name, value] of Object.entries({ display_name: "Test", username: "test_user", email: "test@example.test", password: "short", password_confirm: "other" })) main.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
    main.querySelector<HTMLButtonElement>(".registration-email button")!.click();
    await vi.waitFor(() => expect(main.querySelector<HTMLElement>(".registration-email__code")!.hidden).toBe(false));
    main.querySelector<HTMLInputElement>('[name="code"]')!.value = "12345678";
    main.querySelector<HTMLButtonElement>(".registration-email__code button")!.click();
    await vi.waitFor(() => expect(main.querySelector<HTMLElement>(".registration-email__code")!.hidden).toBe(true));
    const passkey = main.querySelector<HTMLButtonElement>('button[value="passkey"]')!;
    expect(passkey.formNoValidate).toBe(true);
    passkey.click();
    await vi.waitFor(() => expect(startRegistration).toHaveBeenCalledOnce());
    expect(startRegistration.mock.calls[0]?.[0]).not.toHaveProperty("password");
    await vi.waitFor(() => expect(passkey.disabled).toBe(false));
    // Skipping password validation must never skip required shared profile fields.
    main.querySelector<HTMLInputElement>('[name="username"]')!.value = "";
    passkey.click();
    expect(startRegistration).toHaveBeenCalledOnce();
  });
});
