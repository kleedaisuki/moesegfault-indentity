// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPage, type PageContext } from "./pages";
import { ApiError, AccountApiClient } from "./api/client";
import type { Account, Contact } from "./api/types";
import { translator } from "./i18n";

afterEach(() => document.body.replaceChildren());

/** Creates an isolated contact panel without sending mail or touching external accounts. */
async function fixture(locale: "zh-CN" | "en" | "ja" = "en", overrides: Partial<Contact> = {}) {
  const contact: Contact = { contact_id: "contact", kind: "email", value: "test@example.invalid", verification_state: "pending", is_primary: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...overrides };
  const transaction = { transaction_id: "first", delivery_hint: "t***@example.invalid", expires_at: "2026-01-01T00:10:00Z" };
  const api = {
    listContacts: vi.fn(async () => [contact]),
    addContact: vi.fn<AccountApiClient["addContact"]>(async () => contact),
    startContactVerification: vi.fn<AccountApiClient["startContactVerification"]>(async () => transaction),
    completeContactVerification: vi.fn<AccountApiClient["completeContactVerification"]>(async () => contact),
  };
  const refresh = vi.fn(async () => undefined);
  const abort = new AbortController();
  const main = document.createElement("main");
  const account = { principal_id: "principal", profile: { display_name: "Test", locale: "en", links: [] }, identifiers: [] } as unknown as Account;
  await renderPage("/profile", main, {
    api: api as unknown as AccountApiClient, account, csrfToken: "csrf", locale, t: translator(locale),
    preferences: { locale: "en", theme: "system", timezone: "UTC", reduced_motion: false, compact_mode: false, notifications: { security_email: true } },
    signal: abort.signal, refresh,
  } satisfies PageContext);
  document.body.append(main);
  return { main, api, refresh, abort };
}

/** Uses a deferred response to expose overlapping browser events deterministically. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/** Opens the code form through its actual initial-send button. */
async function openVerification(f: Awaited<ReturnType<typeof fixture>>) {
  f.main.querySelector<HTMLButtonElement>(".entity-row .quiet")!.click();
  await vi.waitFor(() => expect(f.main.querySelector(".verification-form")).not.toBeNull());
  const form = f.main.querySelector<HTMLFormElement>(".verification-form")!;
  return { form, code: form.querySelector<HTMLInputElement>("input")!, submit: form.querySelector<HTMLButtonElement>('[type="submit"]')!, resend: form.querySelector<HTMLButtonElement>('[type="button"]')! };
}

/** Dispatches submit directly so duplicate keyboard events cannot rely on button disabling alone. */
function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}

describe("mobile verification capability", () => {
  it.each(["zh-CN", "en", "ja"] as const)("explains pending mobile state without offering a failing send in %s", async locale => {
    const f = await fixture(locale, { kind: "mobile", value: "+12025550107" });
    const row = f.main.querySelector(".entity-row")!;
    expect(row.textContent).toContain(translator(locale)("mobileVerificationUnavailable"));
    expect(Array.from(row.querySelectorAll("button"), button => button.textContent)).toEqual([translator(locale)("remove")]);
    expect(f.api.startContactVerification).not.toHaveBeenCalled();
  });

  it("describes SMS availability before adding and removes the description when switching to email", async () => {
    const f = await fixture();
    const form = f.main.querySelector<HTMLFormElement>(".contact-form")!;
    const kind = form.querySelector<HTMLSelectElement>('[name="kind"]')!;
    const value = form.querySelector<HTMLInputElement>('[name="value"]')!;
    const notice = form.querySelector<HTMLElement>("#mobile-verification-note")!;
    expect(notice.hidden).toBe(true);
    kind.value = "mobile"; kind.dispatchEvent(new Event("change"));
    expect(notice.hidden).toBe(false);
    expect(value.getAttribute("aria-describedby")?.split(" ")).toContain(notice.id);
    expect(value.getAttribute("aria-describedby")?.split(" ")).toContain("mobile-format-note");
    expect(value.type).toBe("tel");
    kind.value = "email"; kind.dispatchEvent(new Event("change"));
    expect(notice.hidden).toBe(true);
    expect(value.hasAttribute("aria-describedby")).toBe(false);
    expect(value.type).toBe("email");
    expect(f.api.addContact).not.toHaveBeenCalled();
  });

  it("retains verified mobile management without falsely downgrading existing verified contacts", async () => {
    const f = await fixture("en", { kind: "mobile", verification_state: "verified" });
    const row = f.main.querySelector(".entity-row")!;
    expect(row.textContent).not.toContain(translator("en")("mobileVerificationUnavailable"));
    expect(row.textContent).toContain(translator("en")("verified"));
    expect(Array.from(row.querySelectorAll("button"), button => button.textContent)).toEqual([translator("en")("makePrimary"), translator("en")("remove")]);
  });
});

describe("contact operation ownership", () => {
  it.each([["+1", "+1 (202) 555-0107", "2025550107"], ["+1", "(202) 555-0107", "2025550107"], ["+81", "090-1234-5678", "9012345678"], ["+44", "020 7946 0018", "2079460018"]])("normalizes actual mobile add form (%s, %s)", async (code, input, national) => {
    const f = await fixture();
    const form = f.main.querySelector<HTMLFormElement>(".contact-form")!;
    const kind = form.querySelector<HTMLSelectElement>('[name="kind"]')!;
    kind.value = "mobile"; kind.dispatchEvent(new Event("change"));
    form.querySelector<HTMLSelectElement>('[name="calling_code"]')!.value = code!;
    form.querySelector<HTMLInputElement>('[name="value"]')!.value = input!;
    submit(form);
    await vi.waitFor(() => expect(f.api.addContact).toHaveBeenCalledOnce());
    expect(f.api.addContact).toHaveBeenCalledWith({ kind: "mobile", mobile: { country_calling_code: code, national_number: national } }, { csrfToken: "csrf", signal: f.abort.signal });
    expect(f.refresh).toHaveBeenCalledOnce();
  });

  it.each(["zh-CN", "en", "ja"] as const)("rejects country mismatch locally, focuses number, and allows corrected retry (%s)", async (locale) => {
    const f = await fixture(locale);
    const form = f.main.querySelector<HTMLFormElement>(".contact-form")!;
    const kind = form.querySelector<HTMLSelectElement>('[name="kind"]')!;
    kind.value = "mobile"; kind.dispatchEvent(new Event("change"));
    const code = form.querySelector<HTMLSelectElement>('[name="calling_code"]')!;
    code.value = "+1";
    const value = form.querySelector<HTMLInputElement>('[name="value"]')!;
    value.value = "+44 20 7946 0018";
    submit(form);
    expect(f.api.addContact).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(value);
    expect(value.getAttribute("aria-invalid")).toBe("true");
    expect(code.value).toBe("+1");
    expect(form.querySelector('[role="alert"]')?.textContent).toBe(translator(locale)("mobileCountryMismatch"));
    expect(f.main.querySelector("#mobile-format-note")?.textContent).toBe(translator(locale)("mobileHint"));
    value.value = "+1 (202) 555-0107"; value.dispatchEvent(new Event("input"));
    submit(form);
    await vi.waitFor(() => expect(f.api.addContact).toHaveBeenCalledOnce());
    expect(value.hasAttribute("aria-invalid")).toBe(false);
  });

  it("rejects missing or overlong mobile locally while retaining the editable value", async () => {
    const f = await fixture();
    const form = f.main.querySelector<HTMLFormElement>(".contact-form")!;
    const kind = form.querySelector<HTMLSelectElement>('[name="kind"]')!;
    kind.value = "mobile"; kind.dispatchEvent(new Event("change"));
    form.querySelector<HTMLSelectElement>('[name="calling_code"]')!.value = "+1";
    const value = form.querySelector<HTMLInputElement>('[name="value"]')!;
    for (const input of ["", "1".repeat(15), "12a34"]) {
      value.value = input; submit(form);
      expect(f.api.addContact).not.toHaveBeenCalled();
      expect(value.value).toBe(input);
      expect(form.querySelector('[role="alert"]')?.textContent).toBe(translator("en")("mobileInvalid"));
    }
    value.value = "1".repeat(14); submit(form);
    await vi.waitFor(() => expect(f.api.addContact).toHaveBeenCalledOnce());
  });

  it("rejects pasted 00 international dialing before a contact request", async () => {
    const f = await fixture();
    const form = f.main.querySelector<HTMLFormElement>(".contact-form")!;
    const kind = form.querySelector<HTMLSelectElement>('[name="kind"]')!;
    kind.value = "mobile"; kind.dispatchEvent(new Event("change"));
    const value = form.querySelector<HTMLInputElement>('[name="value"]')!;
    value.value = "0012025550107"; submit(form);
    expect(f.api.addContact).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(value);
    expect(form.querySelector('[role="alert"]')?.textContent).toBe(translator("en")("mobileInternationalPrefix"));
    expect(form.querySelector<HTMLSelectElement>('[name="calling_code"]')!.value).toBe("+86");
  });

  it("deduplicates add and permits retry with the entered value after failure", async () => {
    const f = await fixture();
    const response = deferred<Contact>();
    f.api.addContact.mockImplementationOnce(() => response.promise);
    const form = f.main.querySelector<HTMLFormElement>(".contact-form")!;
    form.querySelector<HTMLInputElement>('[name="value"]')!.value = "new@example.invalid";
    submit(form); submit(form);
    expect(f.api.addContact).toHaveBeenCalledOnce();
    response.reject(new Error("Offline"));
    await vi.waitFor(() => expect(form.querySelector("[role=alert]")?.textContent).toBe("Offline"));
    expect(form.querySelector<HTMLInputElement>('[name="value"]')!.value).toBe("new@example.invalid");
    submit(form);
    await vi.waitFor(() => expect(f.api.addContact).toHaveBeenCalledTimes(2));
    expect(f.refresh).toHaveBeenCalledOnce();
  });

  it("blocks resend and duplicate confirm during confirmation; wrong-code retry retains the challenge", async () => {
    const f = await fixture();
    const { form, code, submit: confirm, resend } = await openVerification(f);
    const response = deferred<Contact>();
    f.api.completeContactVerification.mockImplementationOnce(() => response.promise);
    code.value = "00000000";
    submit(form); submit(form);
    resend.dispatchEvent(new Event("click"));
    expect(f.api.completeContactVerification).toHaveBeenCalledOnce();
    expect(f.api.startContactVerification).toHaveBeenCalledOnce();
    expect(confirm.disabled && resend.disabled && code.readOnly).toBe(true);
    response.reject(new ApiError(400, { type: "https://identity.moesegfault.dev/problems/invalid_verification_code", title: "Invalid verification code", status: 400, error_code: "invalid_verification_code" }));
    await vi.waitFor(() => expect(confirm.disabled).toBe(false));
    expect(resend.disabled || code.readOnly).toBe(false);
    expect(code.value).toBe("00000000");
    expect(form.querySelector('[role="alert"]')?.textContent).toContain(translator("en")("verificationWrongCode"));
    code.value = "13579024";
    submit(form);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
    expect(f.api.completeContactVerification.mock.calls[1]?.slice(0, 3)).toEqual(["contact", "first", "13579024"]);
  });

  it("blocks confirmation during resend and then confirms only the new transaction", async () => {
    const f = await fixture();
    const { form, code, resend } = await openVerification(f);
    const response = deferred<{ transaction_id: string; delivery_hint: string; expires_at: string }>();
    f.api.startContactVerification.mockImplementationOnce(() => response.promise);
    code.value = "00000000";
    resend.click();
    submit(form);
    resend.dispatchEvent(new Event("click"));
    expect(f.api.startContactVerification).toHaveBeenCalledTimes(2);
    expect(f.api.completeContactVerification).not.toHaveBeenCalled();
    response.resolve({ transaction_id: "replacement", delivery_hint: "t***@example.invalid", expires_at: "2026-01-01T00:20:00Z" });
    await vi.waitFor(() => expect(resend.disabled).toBe(false));
    expect(code.value).toBe("");
    code.value = "13579024";
    submit(form);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
    expect(f.api.completeContactVerification.mock.calls[0]?.slice(0, 3)).toEqual(["contact", "replacement", "13579024"]);
  });

  it("retains the previous code and unlocks both actions after resend cooldown rejection", async () => {
    const f = await fixture();
    const { form, code, submit: confirm, resend } = await openVerification(f);
    f.api.startContactVerification.mockRejectedValueOnce(new ApiError(429, { type: "https://identity.moesegfault.dev/problems/rate_limited", title: "Please wait before requesting another verification code", status: 429, error_code: "rate_limited" }));
    code.value = "13579024";
    resend.click();
    await vi.waitFor(() => expect(form.querySelector('[role="alert"]')?.textContent).toContain(translator("en")("verificationRateLimited")));
    expect(confirm.disabled || resend.disabled || code.readOnly).toBe(false);
    expect(code.value).toBe("13579024");
    submit(form);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
    expect(f.api.completeContactVerification.mock.calls[0]?.slice(0, 3)).toEqual(["contact", "first", "13579024"]);
  });

  it("leaves the initial send button recoverable after delivery failure", async () => {
    const f = await fixture();
    f.api.startContactVerification.mockRejectedValueOnce(new Error("Offline"));
    const verify = f.main.querySelector<HTMLButtonElement>(".entity-row .quiet")!;
    verify.click();
    await vi.waitFor(() => expect(f.main.querySelector(".mutation-feedback")?.textContent).toBe(translator("en")("verificationRetry")));
    expect(verify.disabled).toBe(false);
    expect(f.main.querySelector(".verification-form")).toBeNull();
    verify.click();
    await vi.waitFor(() => expect(f.main.querySelector(".verification-form")).not.toBeNull());
    expect(f.api.startContactVerification).toHaveBeenCalledTimes(2);
  });

  it("blocks add during initial send and never revives controls after page abort", async () => {
    const f = await fixture();
    const response = deferred<{ transaction_id: string; delivery_hint: string; expires_at: string }>();
    const add = deferred<Contact>();
    f.api.startContactVerification.mockImplementationOnce(() => response.promise);
    f.api.addContact.mockImplementationOnce(() => add.promise);
    f.main.querySelector<HTMLButtonElement>(".entity-row .quiet")!.click();
    const form = f.main.querySelector<HTMLFormElement>(".contact-form")!;
    form.querySelector<HTMLInputElement>('[name="value"]')!.value = "new@example.invalid";
    submit(form);
    expect(f.api.addContact).not.toHaveBeenCalled();
    f.abort.abort();
    response.resolve({ transaction_id: "late", delivery_hint: "t***@example.invalid", expires_at: "2026-01-01T00:20:00Z" });
    add.resolve({} as Contact);
    await Promise.resolve(); await Promise.resolve();
    expect(form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    expect(f.main.querySelector(".verification-form")).toBeNull();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("does not refresh a newly navigated page after an old contact completion", async () => {
    const f = await fixture();
    const { form, code } = await openVerification(f);
    const response = deferred<Contact>();
    f.api.completeContactVerification.mockImplementationOnce(() => response.promise);
    code.value = "13579024";
    submit(form);
    f.abort.abort();
    response.resolve({} as Contact);
    await Promise.resolve(); await Promise.resolve();
    expect(code.readOnly).toBe(true);
    expect(form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    expect(f.refresh).not.toHaveBeenCalled();
    submit(form);
    expect(f.api.completeContactVerification).toHaveBeenCalledOnce();
  });
});


describe.each(["zh-CN", "en", "ja"] as const)("localized verification recovery: %s", (locale) => {
  it.each([
    ["invalid_verification_code", 400, "verificationWrongCode"],
    ["transaction_expired", 410, "verificationExpired"],
    ["rate_limited", 429, "verificationRateLimited"],
    ["service_unavailable", 503, "verificationUnavailable"],
    ["authentication_required", 401, "verificationSignIn"],
    ["unrecognized", 500, "verificationRetry"],
  ] as const)("maps %s without displaying server prose or an expanded diagnostic", async (code, status, key) => {
    const f = await fixture(locale);
    const view = await openVerification(f);
    const correlation = "test-correlation-id";
    f.api.completeContactVerification.mockRejectedValueOnce(new ApiError(status, {
      type: `https://identity.moesegfault.dev/problems/${code}`, error_code: code,
      title: "DO NOT ECHO: supplied code and destination", status,
    }, correlation));
    view.code.value = "13579024";
    submit(view.form);
    await vi.waitFor(() => expect(view.form.querySelector('[role="alert"]')).not.toBeNull());
    const alert = view.form.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.firstChild?.textContent).toBe(translator(locale)(key));
    const details = alert.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe(translator(locale)("verificationDiagnostics"));
    expect(details.querySelector("code")?.textContent).toBe(`ID ${correlation}`);
    expect(alert.textContent).not.toContain("DO NOT ECHO");
    expect(view.code.value).toBe("13579024");
    expect(view.resend.disabled || view.submit.disabled).toBe(false);
    view.resend.click();
    await vi.waitFor(() => expect(alert.getAttribute("role")).toBe("status"));
    expect(alert.querySelector("details")).toBeNull();
  });

  it("uses the stable type URI when error_code is absent and preserves body correlation ID", async () => {
    const f = await fixture(locale);
    const view = await openVerification(f);
    f.api.completeContactVerification.mockRejectedValueOnce(new ApiError(400, {
      type: "https://identity.moesegfault.dev/problems/invalid_verification_code", title: "Server prose changed", status: 400, correlation_id: "body-support-id",
    }));
    view.code.value = "13579024";
    submit(view.form);
    await vi.waitFor(() => expect(view.form.querySelector('[role="alert"]')?.firstChild?.textContent).toBe(translator(locale)("verificationWrongCode")));
    expect(view.form.querySelector("details code")?.textContent).toBe("ID body-support-id");
  });

  it("shows an actionable network retry on initial send without exposing error text", async () => {
    const f = await fixture(locale);
    const client = new AccountApiClient("https://identity.example.invalid", vi.fn().mockRejectedValue(new TypeError("Failed to fetch private URL")));
    f.api.startContactVerification.mockImplementationOnce((contactId, proof) => client.startContactVerification(contactId, proof));
    const verify = f.main.querySelector<HTMLButtonElement>(".entity-row .quiet")!;
    verify.click();
    await vi.waitFor(() => expect(f.main.querySelector(".mutation-feedback")?.textContent).toBe(translator(locale)("verificationNetwork")));
    expect(verify.disabled).toBe(false);
    expect(f.main.querySelector(".mutation-feedback details")).toBeNull();
  });
});
