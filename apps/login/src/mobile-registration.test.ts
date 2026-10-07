// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPage } from "./pages";
import { translate, type Locale } from "./i18n";
import type { IdentityApiClient } from "./api/client";

vi.mock("./webauthn/ceremony", () => ({ isWebAuthnAvailable: () => true, createPasskey: vi.fn(), getPasskey: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("signup mobile validation before email proof", () => {
  it("rejects ambiguous 00 dialing before email confirmation instead of inventing a national number", async () => {
    const f = await fixture();
    f.code.value = "+86"; f.mobile.value = "0012025550107";
    submit(f.form);
    expect(f.api.startRegistrationEmail).not.toHaveBeenCalled();
    expect(f.api.registerWithPassword).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(f.mobile);
    expect(f.main.querySelector('[role="alert"]')?.textContent).toContain(translate("en", "mobileInternationalPrefix"));
    expect(f.code.value).toBe("+86");
  });
  it.each(["password", "passkey"] as const)("rejects mismatched optional mobile before any email/creation operation (%s)", async (method) => {
    const f = await fixture();
    f.code.value = "+1"; f.mobile.value = "+44 20 7946 0018";
    submit(f.form, method);
    expect(f.api.startRegistrationEmail).not.toHaveBeenCalled();
    expect(f.api.completeRegistrationEmail).not.toHaveBeenCalled();
    expect(f.api.registerWithPassword).not.toHaveBeenCalled();
    expect(f.api.startRegistration).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(f.mobile);
    expect(f.code.value).toBe("+1");
    expect(f.main.querySelector('[role="alert"]')?.textContent).toContain(translate("en", "mobileCountryMismatch"));
  });

  it.each(["zh-CN", "en", "ja"] as const)("retains a verified proof after invalid mobile and uses it only after correction (%s)", async (locale) => {
    const f = await fixture(locale);
    await verifyEmail(f);
    f.code.value = "+1"; f.mobile.value = "1".repeat(15);
    submit(f.form);
    expect(f.api.registerWithPassword).not.toHaveBeenCalled();
    expect(f.main.querySelector('[role="alert"]')?.textContent).toContain(translate(locale, "mobileInvalid"));
    expect(document.activeElement).toBe(f.mobile);
    expect(f.mobile.getAttribute("aria-describedby")).toBe("signup-phone-hint");
    const label = f.main.querySelector<HTMLLabelElement>(`label[for="${f.mobile.id}"]`)!;
    expect(label.textContent).toBe(translate(locale, "mobile"));
    expect(label.querySelector("select")).toBeNull();
    expect(f.main.querySelector("#signup-phone-hint")?.textContent).toBe(translate(locale, "phoneHint"));
    f.mobile.value = "+1 (202) 555-0107"; f.mobile.dispatchEvent(new Event("input"));
    submit(f.form);
    await vi.waitFor(() => expect(f.api.registerWithPassword).toHaveBeenCalledOnce());
    expect(f.api.registerWithPassword.mock.calls[0]?.[0]).toMatchObject({ email_verification_token: "same-proof", mobile: { country_calling_code: "+1", national_number: "2025550107" } });
    expect(f.api.startRegistrationEmail).toHaveBeenCalledOnce();
    expect(f.api.completeRegistrationEmail).toHaveBeenCalledOnce();
  });

  it.each([["+81", "090-1234-5678", "9012345678"], ["+44", "020 7946 0018", "2079460018"], ["+1", "(202) 555-0107", "2025550107"], ["+1", "1".repeat(14), "1".repeat(14)]])("uses shared formatting in actual signup payload (%s, %s)", async (code, input, national) => {
    const f = await fixture();
    await verifyEmail(f);
    f.code.value = code!; f.mobile.value = input!;
    submit(f.form);
    await vi.waitFor(() => expect(f.api.registerWithPassword).toHaveBeenCalledOnce());
    expect(f.api.registerWithPassword.mock.calls[0]?.[0]).toMatchObject({ mobile: { country_calling_code: code, national_number: national } });
  });

  it("omits an optional blank mobile instead of sending an empty domain value", async () => {
    const f = await fixture(); await verifyEmail(f);
    f.mobile.value = "  "; submit(f.form);
    await vi.waitFor(() => expect(f.api.registerWithPassword).toHaveBeenCalledOnce());
    expect(f.api.registerWithPassword.mock.calls[0]?.[0]).not.toHaveProperty("mobile");
  });
});

/** Submit dispatch exercises the shared password/Passkey validation without any platform ceremony. */
function submit(form: HTMLFormElement, method = "password"): void {
  form.dispatchEvent(new SubmitEvent("submit", { cancelable: true, submitter: form.querySelector<HTMLButtonElement>(`button[value="${method}"]`)! }));
}

/** Completes the real inline verifier against deterministic API doubles, not a mailbox. */
async function verifyEmail(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  f.main.querySelector<HTMLButtonElement>(".registration-email button")!.click();
  await vi.waitFor(() => expect(f.main.querySelector<HTMLElement>(".registration-email__code")!.hidden).toBe(false));
  f.main.querySelector<HTMLInputElement>('[name="code"]')!.value = "12345678";
  f.main.querySelector<HTMLButtonElement>(".registration-email__code button")!.click();
  await vi.waitFor(() => expect(f.main.querySelector<HTMLElement>(".registration-email__code")!.hidden).toBe(true));
}

/** Stops deliberately at the creation boundary; no account, mail, or WebAuthn operation is real. */
async function fixture(locale: Locale = "en") {
  vi.stubGlobal("location", { hostname: "login-staging.moesegfault.dev", href: "https://login-staging.moesegfault.dev/register" });
  const api = {
    getBrowserContext: vi.fn(async () => ({ csrf_token: "csrf" })),
    startRegistrationEmail: vi.fn(async () => ({ transaction_id: "email", delivery_hint: "test@example.invalid", resend_after: new Date().toISOString() })),
    completeRegistrationEmail: vi.fn(async () => ({ email_verification_token: "same-proof", expires_at: new Date(Date.now() + 600000).toISOString() })),
    registerWithPassword: vi.fn<IdentityApiClient["registerWithPassword"]>(async () => { throw new Error("Fixture stops before creation"); }),
    startRegistration: vi.fn<IdentityApiClient["startRegistration"]>(async () => { throw new Error("Fixture stops before ceremony"); }),
  };
  const main = document.createElement("main"); document.body.append(main);
  await renderPage("/register", main, api as unknown as IdentityApiClient, new AbortController().signal, { locale });
  const form = main.querySelector<HTMLFormElement>(".register-form")!;
  for (const [name, value] of Object.entries({ display_name: "Test", username: "test_user", email: "test@example.invalid", password: "a valid long password", password_confirm: "a valid long password" })) {
    form.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
  }
  return { main, form, api, code: form.querySelector<HTMLSelectElement>('[name="calling_code"]')!, mobile: form.querySelector<HTMLInputElement>('[name="mobile"]')! };
}
