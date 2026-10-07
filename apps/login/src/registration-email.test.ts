// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentityApiClient, ApiError } from "./api/client";
import { translate } from "./i18n";
import { createRegistrationEmailVerifier } from "./registration-email";
import { renderPage } from "./pages";
import { captureAndScrubTransaction } from "./transaction";
import type { AvatarFilePicker } from "./ui/file-picker";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("inline registration email verification", () => {
  it("shows the full profile, avatar and credential form immediately without sending mail", async () => {
    const fixture = await setup();
    for (const name of ["display_name", "username", "password", "password_confirm", "email", "avatar"]) expect(fixture.main.querySelector(`[name="${name}"]`)).not.toBeNull();
    expect(fixture.main.querySelectorAll("form")).toHaveLength(1);
    expect(fixture.main.querySelector<HTMLInputElement>('[name="code"]')!.disabled).toBe(true);
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.register).not.toHaveBeenCalled();
    fixture.abort.abort();
  });

  it("starts verification on submission without creating an account or replacing any draft controls", async () => {
    const fixture = await setup(); fillDraft(fixture.main);
    const form = fixture.main.querySelector("form")!;
    const avatar = fixture.main.querySelector(".file-picker");
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledOnce());
    expect(fixture.register).not.toHaveBeenCalled();
    expect(fixture.main.querySelector("form")).toBe(form);
    expect(fixture.main.querySelector(".file-picker")).toBe(avatar);
    expect(fixture.main.querySelector<HTMLInputElement>('[name="username"]')!.value).toBe("klee_test");
    expect(fixture.main.querySelector<HTMLInputElement>('[name="password"]')!.value).toBe("fixture-only-long-password");
    fixture.abort.abort();
  });

  it("verifies in place and creates an account only on a subsequent explicit submit", async () => {
    const fixture = await setup(); fillDraft(fixture.main);
    const form = fixture.main.querySelector("form")!;
    await send(fixture.main); await confirm(fixture.main);
    expect(fixture.register).not.toHaveBeenCalled();
    expect(fixture.main.querySelector("form")).toBe(form);
    expect(fixture.main.querySelector<HTMLInputElement>('[name="email"]')!.readOnly).toBe(true);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.register).toHaveBeenCalledOnce());
    expect(fixture.register.mock.calls[0]?.[0]).toMatchObject({ username: "klee_test", email: "klee@example.test", email_verification_token: "fixture-proof" });
    expect(fixture.register.mock.calls[0]?.[0]).not.toHaveProperty("authorization_transaction_id");
    await vi.waitFor(() => expect(fixture.main.querySelector('[name="password"]')).toBeNull());
    expect(fixture.main.textContent).toContain(translate("zh-CN", "signedIn"));
    fixture.abort.abort();
  });

  it("continues OAuth password signup through the server's absolute issuer resume URI", async () => {
    const resume = "https://identity-staging.moesegfault.dev/v1/oauth/authorization-transactions/oauth-fixture/resume";
    const assign = vi.fn();
    vi.stubGlobal("location", { hostname: "login-staging.moesegfault.dev", href: "https://login-staging.moesegfault.dev/register", assign });
    const fixture = await setup("oauth-fixture", resume);
    fillDraft(fixture.main);
    await send(fixture.main); await confirm(fixture.main);
    expect(fixture.start.mock.calls[0]?.[3]).toEqual({ authorization_transaction_id: "oauth-fixture" });
    expect(fixture.complete.mock.calls[0]?.[4]).toEqual({ authorization_transaction_id: "oauth-fixture" });
    fixture.main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(resume));
    expect(fixture.register.mock.calls[0]?.[0]).toMatchObject({ authorization_transaction_id: "oauth-fixture", email_verification_token: "fixture-proof" });
    expect(assign).toHaveBeenCalledOnce();
    fixture.abort.abort();
  });

  it.each(["start", "completion"] as const)("retains drafts and does not create an account when OAuth context expires at %s", async (operation) => {
    const fixture = await setup("expired-oauth");
    fillDraft(fixture.main);
    const error = new ApiError(400, { type: "urn:test", title: "Expired transaction", status: 400, error_code: "authorization_transaction_expired" });
    if (operation === "start") {
      fixture.start.mockRejectedValueOnce(error);
      fixture.main.querySelector<HTMLButtonElement>(".registration-email__address button")!.click();
    } else {
      await send(fixture.main);
      fixture.complete.mockRejectedValueOnce(error);
      fixture.main.querySelector<HTMLInputElement>('[name="code"]')!.value = "01234567";
      fixture.main.querySelector<HTMLButtonElement>(".registration-email__code button")!.click();
    }
    await vi.waitFor(() => expect(fixture.main.querySelector('[role="alert"]')?.textContent).toContain(translate("zh-CN", "signupAuthorizationExpired")));
    expect(fixture.main.querySelector<HTMLButtonElement>(".registration-email__address button")!.disabled).toBe(true);
    expect(fixture.main.querySelector<HTMLButtonElement>(".registration-email__code button")!.disabled).toBe(true);
    fixture.main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(fixture.register).not.toHaveBeenCalled();
    expect(fixture.main.querySelector<HTMLInputElement>('[name="password"]')!.value).toBe("fixture-only-long-password");
    expect(fixture.main.querySelector<HTMLInputElement>('[name="username"]')!.value).toBe("klee_test");
    fixture.abort.abort();
  });

  it("keeps drafts and the avatar node across wrong codes and mailbox correction", async () => {
    const fixture = await setup(); fillDraft(fixture.main);
    const avatar = fixture.main.querySelector(".file-picker");
    fixture.complete.mockRejectedValueOnce(new ApiError(400, { type: "urn:test", title: "Wrong code", status: 400 }));
    await send(fixture.main);
    fixture.main.querySelector<HTMLInputElement>('[name="code"]')!.value = "11111111";
    fixture.main.querySelector<HTMLButtonElement>(".registration-email__code button")!.click();
    await vi.waitFor(() => expect(fixture.main.querySelector('[role="alert"]')?.textContent).toContain("Wrong code"));
    expect(fixture.register).not.toHaveBeenCalled();
    Array.from(fixture.main.querySelectorAll<HTMLButtonElement>("button")).find(btn => btn.textContent === "换一个邮箱")!.click();
    expect(fixture.main.querySelector<HTMLInputElement>('[name="email"]')!.readOnly).toBe(false);
    expect(fixture.main.querySelector<HTMLInputElement>('[name="username"]')!.value).toBe("klee_test");
    expect(fixture.main.querySelector(".file-picker")).toBe(avatar);
    fixture.abort.abort();
  });

  it("can confirm an entered code and create the account on the user's final submit", async () => {
    const fixture = await setup(); fillDraft(fixture.main);
    await send(fixture.main);
    fixture.main.querySelector<HTMLInputElement>('[name="code"]')!.value = "01234567";
    fixture.main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.register).toHaveBeenCalledOnce());
    expect(fixture.complete).toHaveBeenCalledOnce();
    fixture.abort.abort();
  });

  it("owns one final registration and releases both methods after a failed attempt", async () => {
    const fixture = await setup(); fillDraft(fixture.main);
    await send(fixture.main); await confirm(fixture.main);
    let reject!: (error: Error) => void;
    fixture.register.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const form = fixture.main.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.register).toHaveBeenCalledOnce());
    const password = form.querySelector<HTMLButtonElement>('button[value="password"]')!;
    expect(password.disabled).toBe(true);
    reject(new Error("Temporary registration failure"));
    await vi.waitFor(() => expect(password.disabled).toBe(false));
    expect(form.querySelector<HTMLInputElement>('[name="password"]')!.value).toBe("fixture-only-long-password");
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.register).toHaveBeenCalledTimes(2));
    fixture.abort.abort();
  });

  it("recovers from local avatar preparation errors without trapping registration controls", async () => {
    const fixture = await setup(); fillDraft(fixture.main);
    await send(fixture.main); await confirm(fixture.main);
    const picker = fixture.main.querySelector<AvatarFilePicker>(".file-picker")!;
    picker.processedFile = vi.fn().mockRejectedValueOnce(new Error("Avatar preparation failed")).mockResolvedValue(undefined);
    const form = fixture.main.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.main.querySelector('[role="alert"]')?.textContent).toContain("Avatar preparation failed"));
    expect(fixture.register).not.toHaveBeenCalled();
    expect(form.querySelector<HTMLButtonElement>('button[value="password"]')!.disabled).toBe(false);
    expect(form.querySelector<HTMLInputElement>('[name="email"]')!.disabled).toBe(false);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.register).toHaveBeenCalledOnce());
    fixture.abort.abort();
  });

  it("never creates an account when navigation aborts pending local preparation", async () => {
    const fixture = await setup(); fillDraft(fixture.main);
    await send(fixture.main); await confirm(fixture.main);
    let finish!: () => void;
    fixture.main.querySelector<AvatarFilePicker>(".file-picker")!.processedFile = () => new Promise(resolve => { finish = () => resolve(undefined); });
    fixture.main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    fixture.abort.abort();
    finish();
    await Promise.resolve(); await Promise.resolve();
    expect(fixture.register).not.toHaveBeenCalled();
  });

  it("renews an expired proof in the same form without discarding the profile or preview", async () => {
    vi.useFakeTimers();
    const fixture = await setup(); fillDraft(fixture.main);
    const form = fixture.main.querySelector("form")!;
    const avatar = fixture.main.querySelector(".file-picker");
    await send(fixture.main); await confirm(fixture.main);
    await vi.advanceTimersByTimeAsync(600_001);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledTimes(2));
    expect(fixture.register).not.toHaveBeenCalled();
    expect(fixture.main.querySelector("form")).toBe(form);
    expect(fixture.main.querySelector(".file-picker")).toBe(avatar);
    expect(fixture.main.querySelector<HTMLInputElement>('[name="password"]')!.value).toBe("fixture-only-long-password");
    fixture.abort.abort();
  });

  it("allows an immediate retry after a transient send failure without losing the draft", async () => {
    const fixture = await setup(); fillDraft(fixture.main);
    fixture.start.mockRejectedValueOnce(new TypeError("Network unavailable"));
    const sendButton = fixture.main.querySelector<HTMLButtonElement>(".registration-email button")!;
    sendButton.click();
    await vi.waitFor(() => expect(fixture.main.querySelector('[role="alert"]')).not.toBeNull());
    expect(sendButton.disabled).toBe(false);
    sendButton.click();
    await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledTimes(2));
    expect(fixture.main.querySelector<HTMLInputElement>('[name="username"]')!.value).toBe("klee_test");
    fixture.abort.abort();
  });

  it("shows the remaining resend wait and releases it exactly at the deadline", async () => {
    vi.useFakeTimers();
    const fixture = await setup();
    await send(fixture.main);
    const button = fixture.main.querySelector<HTMLButtonElement>(".registration-email button")!;
    expect(button.textContent).toBe("重新发送 (60s)");
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.textContent).toBe("重新发送 (59s)");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(button.textContent).toBe("重新发送");
    expect(button.disabled).toBe(false);
    fixture.abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a cooldown for explicit server rate limits", async () => {
    vi.useFakeTimers();
    const fixture = await setup(); fillDraft(fixture.main);
    fixture.start.mockRejectedValueOnce(new ApiError(429, { type: "urn:test", title: "Slow down", status: 429, error_code: "rate_limited" }));
    const button = fixture.main.querySelector<HTMLButtonElement>(".registration-email button")!;
    button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("发送验证码 (60s)");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(button.disabled).toBe(false);
    fixture.abort.abort();
  });

  it("refreshes only the CSRF capability before one explicit confirmation and retains the challenge", async () => {
    const fixture = await setup(); fillDraft(fixture.main);
    await send(fixture.main);
    vi.mocked(fixture.api.getBrowserContext).mockResolvedValueOnce({ csrf_token: "current-tab-context" } as never);
    const form = fixture.main.querySelector("form");
    const avatar = fixture.main.querySelector(".file-picker");
    await confirm(fixture.main);
    expect(fixture.complete).toHaveBeenCalledOnce();
    expect(fixture.complete.mock.calls[0]?.slice(0, 3)).toEqual(["tx", "01234567", "current-tab-context"]);
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(fixture.register).not.toHaveBeenCalled();
    expect(fixture.main.querySelector("form")).toBe(form);
    expect(fixture.main.querySelector(".file-picker")).toBe(avatar);
    fixture.abort.abort();
  });

  it("shows known challenge expiry before context initialization or any completion request", async () => {
    vi.useFakeTimers();
    const fixture = await setup(); fillDraft(fixture.main);
    await send(fixture.main);
    const before = vi.mocked(fixture.api.getBrowserContext).mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_001);
    fixture.main.querySelector<HTMLInputElement>('[name="code"]')!.value = "01234567";
    fixture.main.querySelector<HTMLButtonElement>(".registration-email__code button")!.click();
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.api.getBrowserContext).toHaveBeenCalledTimes(before);
    expect(fixture.main.querySelector('[role="alert"]')?.textContent).toContain(translate("zh-CN", "signupCodeExpired"));
    expect(fixture.main.querySelector<HTMLInputElement>('[name="password"]')!.value).toBe("fixture-only-long-password");
    expect(fixture.main.querySelector<HTMLInputElement>('[name="code"]')!.value).toBe("01234567");
    expect(fixture.main.querySelector<HTMLButtonElement>(".registration-email button")!.disabled).toBe(false);
    fixture.abort.abort();
  });

  it("keeps draft and code after a stable CSRF/context rejection, without automatic mutation retry", async () => {
    const fixture = await setup(); fillDraft(fixture.main);
    await send(fixture.main);
    fixture.complete.mockRejectedValueOnce(new ApiError(403, { type: "https://identity.moesegfault.dev/problems/invalid_request", title: "CSRF validation failed", status: 403, error_code: "invalid_request" }));
    fixture.main.querySelector<HTMLInputElement>('[name="code"]')!.value = "01234567";
    fixture.main.querySelector<HTMLButtonElement>(".registration-email__code button")!.click();
    await vi.waitFor(() => expect(fixture.main.querySelector('[role="alert"]')?.textContent).toContain(translate("zh-CN", "signupContextChanged")));
    expect(fixture.main.querySelector('[role="alert"]')?.textContent).not.toContain("CSRF validation failed");
    expect(fixture.complete).toHaveBeenCalledOnce();
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(fixture.register).not.toHaveBeenCalled();
    expect(fixture.main.querySelector<HTMLInputElement>('[name="code"]')!.value).toBe("01234567");
    expect(fixture.main.querySelector<HTMLInputElement>('[name="password"]')!.value).toBe("fixture-only-long-password");
    fixture.abort.abort();
  });

  it("does not confirm if navigation aborts while refreshing browser context", async () => {
    const fixture = await setup(); fillDraft(fixture.main);
    await send(fixture.main);
    let resolve!: (value: never) => void;
    vi.mocked(fixture.api.getBrowserContext).mockImplementationOnce(() => new Promise(ok => { resolve = ok; }));
    fixture.main.querySelector<HTMLInputElement>('[name="code"]')!.value = "01234567";
    fixture.main.querySelector<HTMLButtonElement>(".registration-email__code button")!.click();
    fixture.abort.abort();
    resolve({ csrf_token: "late" } as never);
    await Promise.resolve(); await Promise.resolve();
    expect(fixture.complete).not.toHaveBeenCalled();
    fixture.abort.abort();
  });

  it("holds resend cooldown and never lets its timer unlock final account submission", async () => {
    vi.useFakeTimers();
    const fixture = await setup();
    const verifier = createRegistrationEmailVerifier(fixture.api, fixture.signal, key => translate("en", key));
    verifier.element.querySelector<HTMLInputElement>('[name="email"]')!.value = "klee@example.test";
    const send = verifier.element.querySelector<HTMLButtonElement>("button")!;
    send.click(); send.click(); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(send.disabled).toBe(true);
    verifier.setDisabled(true); await vi.advanceTimersByTimeAsync(60_000);
    expect(send.disabled).toBe(true);
    verifier.setDisabled(false); expect(send.disabled).toBe(false);
    fixture.abort.abort();
  });
});

/** Creates a signup HTTP seam and renders the complete registration form. */
async function setup(authorizationTransactionId?: string, authorizationResumeUri?: string) {
  const url = new URL("https://login-staging.moesegfault.dev/login");
  if (authorizationTransactionId) url.searchParams.set("tx", authorizationTransactionId);
  captureAndScrubTransaction({ href: url.href, pathname: url.pathname, search: url.search, hash: "" } as Location, { state: null, replaceState: vi.fn() } as unknown as History);
  const abort = new AbortController();
  const main = document.createElement("main");
  const start = vi.fn<IdentityApiClient["startRegistrationEmail"]>(async () => ({ transaction_id: "tx", expires_at: new Date(Date.now()+600_000).toISOString(), resend_after: new Date(Date.now()+60_000).toISOString(), delivery_hint: "k***@example.test" }));
  const complete = vi.fn<IdentityApiClient["completeRegistrationEmail"]>(async () => ({ email_verification_token: "fixture-proof", expires_at: new Date(Date.now()+600_000).toISOString() }));
  const register = vi.fn<IdentityApiClient["registerWithPassword"]>(async () => ({ account: { principal_id: "principal", lifecycle_state: "active", profile: { display_name: "Klee", locale: "zh-CN" }, identifiers: [], created_at: "now", updated_at: "now" }, session: {} as never, ...(authorizationResumeUri ? { authorization_resume_uri: authorizationResumeUri } : {}), csrf_token: "session-csrf", csrf_expires_at: "later" }));
  const api = { getBrowserContext: vi.fn(async () => ({ csrf_token: "browser-csrf" })), startRegistrationEmail: start, completeRegistrationEmail: complete, registerWithPassword: register } as unknown as IdentityApiClient;
  await renderPage("/register", main, api, abort.signal, { locale: "zh-CN" });
  return { main, api, start, complete, register, abort, signal: abort.signal };
}

/** Fills a draft without performing any account-creation operation. */
function fillDraft(main: HTMLElement): void {
  const values = { username: "klee_test", display_name: "Klee", email: "klee@example.test", password: "fixture-only-long-password", password_confirm: "fixture-only-long-password" };
  for (const [name, value] of Object.entries(values)) main.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
}

/** Sends from the inline control without submitting the enclosing profile form. */
async function send(main: HTMLElement): Promise<void> {
  main.querySelector<HTMLInputElement>('[name="email"]')!.value = "klee@example.test";
  main.querySelector<HTMLButtonElement>(".registration-email button")!.click();
  await vi.waitFor(() => expect(main.querySelector<HTMLElement>(".registration-email__code")!.hidden).toBe(false));
}

/** Confirms a code while retaining all draft nodes. */
async function confirm(main: HTMLElement): Promise<void> {
  main.querySelector<HTMLInputElement>('[name="code"]')!.value = "01234567";
  main.querySelector<HTMLButtonElement>(".registration-email__code button")!.click();
  await vi.waitFor(() => expect(main.querySelector<HTMLElement>(".registration-email__code")!.hidden).toBe(true));
}
