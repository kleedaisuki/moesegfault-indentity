// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentityApiClient, ApiError } from "./api/client";
import { translate } from "./i18n";
import { renderRegistrationEmailGate } from "./registration-email";
import { renderPage } from "./pages";

afterEach(() => { vi.useRealTimers(); });

describe("email-first registration", () => {
  it("shows no credential or profile controls before a successful email proof", async () => {
    const fixture = setup();
    await renderPage("/register", fixture.main, fixture.api, fixture.signal, { locale: "zh-CN" });
    expect(fixture.main.querySelector('[name="password"]')).toBeNull();
    expect(fixture.main.querySelector('[name="username"]')).toBeNull();
    expect(fixture.main.textContent).toContain("验证前不会创建账号");
    await send(fixture.main);
    expect(fixture.register).not.toHaveBeenCalled();
    expect(fixture.main.querySelector('[name="password"]')).toBeNull();

    fixture.main.querySelector<HTMLInputElement>('[name="code"]')!.value = "01234567";
    fixture.main.querySelectorAll("form")[1]!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.main.querySelector('[name="username"]')).not.toBeNull());
    const email = fixture.main.querySelector<HTMLInputElement>('[name="email"]')!;
    expect(email.readOnly).toBe(true);
    expect(email.value).toBe("klee@example.test");
    fixture.main.querySelector<HTMLInputElement>('[name="username"]')!.value = "klee_test";
    fixture.main.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Klee";
    for (const name of ["password", "password_confirm"]) fixture.main.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = "fixture-only-long-password";
    // A modified readonly input cannot change the mailbox bound to the registration proof.
    email.value = "tampered@example.test";
    fixture.main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.register).toHaveBeenCalledOnce());
    expect(fixture.register.mock.calls[0]?.[0]).toMatchObject({ email: "klee@example.test", email_verification_token: "fixture-proof" });
    fixture.abort.abort();
  });

  it("does not advance on wrong codes and lets the user correct the mailbox", async () => {
    const fixture = setup();
    const verified = vi.fn();
    fixture.complete.mockRejectedValueOnce(new ApiError(400, { type: "urn:test", title: "Wrong code", status: 400 }));
    renderRegistrationEmailGate(fixture.main, fixture.api, fixture.signal, key => translate("zh-CN", key), verified);
    await send(fixture.main);
    fixture.main.querySelector<HTMLInputElement>('[name="code"]')!.value = "11111111";
    fixture.main.querySelectorAll("form")[1]!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.main.querySelector('[role="alert"]')?.textContent).toContain("Wrong code"));
    expect(verified).not.toHaveBeenCalled();
    const change = Array.from(fixture.main.querySelectorAll<HTMLButtonElement>("button")).find(btn => btn.textContent === "换一个邮箱")!;
    change.click();
    expect(fixture.main.querySelector<HTMLInputElement>('[name="email"]')!.readOnly).toBe(false);
    expect(fixture.main.querySelectorAll<HTMLFormElement>("form")[1]!.hidden).toBe(true);
    fixture.abort.abort();
  });

  it("disables duplicate sends and holds resend until the server cooldown", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    renderRegistrationEmailGate(fixture.main, fixture.api, fixture.signal, key => translate("en", key), vi.fn());
    const email = fixture.main.querySelector<HTMLInputElement>('[name="email"]')!;
    email.value = "klee@example.test";
    const form = fixture.main.querySelector("form")!;
    form.dispatchEvent(new Event("submit")); form.dispatchEvent(new Event("submit"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.start).toHaveBeenCalledOnce();
    const resend = Array.from(fixture.main.querySelectorAll<HTMLButtonElement>("button")).find(btn => btn.textContent === "Resend code")!;
    expect(resend.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resend.disabled).toBe(false);
    fixture.abort.abort();
  });
});

/** Creates a signup HTTP seam; no passwords or proofs persist outside this test realm. */
function setup() {
  const abort = new AbortController();
  const main = document.createElement("main");
  const start = vi.fn<IdentityApiClient["startRegistrationEmail"]>(async () => ({ transaction_id: "tx", expires_at: new Date(Date.now()+600_000).toISOString(), resend_after: new Date(Date.now()+60_000).toISOString(), delivery_hint: "k***@example.test" }));
  const complete = vi.fn<IdentityApiClient["completeRegistrationEmail"]>(async () => ({ email_verification_token: "fixture-proof", expires_at: new Date(Date.now()+600_000).toISOString() }));
  const register = vi.fn<IdentityApiClient["registerWithPassword"]>(async () => ({ account: { principal_id: "principal", lifecycle_state: "active", profile: { display_name: "Klee", locale: "zh-CN" }, identifiers: [], created_at: "now", updated_at: "now" }, session: {} as never, csrf_token: "session-csrf", csrf_expires_at: "later" }));
  const api = { getBrowserContext: vi.fn(async () => ({ csrf_token: "browser-csrf" })), startRegistrationEmail: start, completeRegistrationEmail: complete, registerWithPassword: register } as unknown as IdentityApiClient;
  return { main, api, start, complete, register, abort, signal: abort.signal };
}

/** Submits an email and waits for the server-accepted code form. */
async function send(main: HTMLElement): Promise<void> {
  main.querySelector<HTMLInputElement>('[name="email"]')!.value = "klee@example.test";
  main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(main.querySelectorAll<HTMLFormElement>("form")[1]!.hidden).toBe(false));
}
