// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentityApiClient } from "./api/client";
import { PageLifecycle } from "./page-lifecycle";
import { renderPage } from "./pages";
import { captureAndScrubTransaction, currentTransaction } from "./transaction";
import type { AvatarFilePicker } from "./ui/file-picker";
import { translate } from "./i18n";

vi.mock("./webauthn/ceremony", () => ({ isWebAuthnAvailable: () => true, createPasskey: vi.fn(async () => ({})), getPasskey: vi.fn(async () => ({})) }));

const aborts: AbortController[] = [];
afterEach(() => { aborts.splice(0).forEach(controller => controller.abort()); document.body.replaceChildren(); vi.useRealTimers(); });

/** Isolated server seam: every challenge/proof originates from an explicit API reply. */
async function fixture(route: "/register" | "/login" | "/recovery" = "/register") {
  const abort = new AbortController(); aborts.push(abort);
  const lifecycle = new PageLifecycle("zh-CN");
  const main = document.createElement("main"); document.body.append(main);
  const start = vi.fn(async () => ({ transaction_id: "challenge", expires_at: new Date(Date.now() + 600_000).toISOString(), resend_after: new Date(Date.now() + 60_000).toISOString(), delivery_hint: "k***@example.test" }));
  const complete = vi.fn(async () => ({ email_verification_token: "actual-proof", expires_at: new Date(Date.now() + 600_000).toISOString() }));
  const register = vi.fn<IdentityApiClient["registerWithPassword"]>(async () => ({ csrf_token: "session", csrf_expires_at: "later", account: {} as never, session: {} as never }));
  const completeRegistration = vi.fn(async () => ({ csrf_token: "session", recovery_codes: ["fixture-code-one", "fixture-code-two"] }));
  const api = { startRegistration: vi.fn(async () => ({ transaction_id: "passkey", csrf_token: "browser", public_key: {} })), completeRegistration, getBrowserContext: vi.fn(async () => ({ csrf_token: "browser" })), startRegistrationEmail: start, completeRegistrationEmail: complete, registerWithPassword: register } as unknown as IdentityApiClient;
  await renderPage(route, main, api, abort.signal, lifecycle);
  const input = (name: string) => main.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  return { abort, lifecycle, main, start, complete, register, completeRegistration, input, api };
}

/** Populates only local input controls, without dispatching submit. */
function fill(f: Awaited<ReturnType<typeof fixture>>) {
  for (const [name, value] of Object.entries({ display_name: "Klee", username: "klee_locale", status_message: "Hello", favorite_character: "Klee", interests: "Linux, ACG", mobile: "13800000000", password: "long-fixture-only-password", password_confirm: "long-fixture-only-password", email: "klee@example.test" })) f.input(name).value = value;
}

describe("route-owned locale changes", () => {
  it("retains explicit profile/password drafts and the same avatar/email owners", async () => {
    const f = await fixture(); fill(f);
    const avatar = f.main.querySelector(".file-picker"); const email = f.main.querySelector(".registration-email");
    f.lifecycle.relocalize("en");
    expect(f.input("display_name").value).toBe("Klee");
    expect(f.input("status_message").value).toBe("Hello");
    expect(f.input("password").value).toBe("long-fixture-only-password");
    expect(f.main.querySelector(".file-picker")).toBe(avatar);
    expect(f.main.querySelector(".registration-email")).toBe(email);
    expect(f.main.textContent).toContain(translate("en", "newTitle"));
    expect(f.start).not.toHaveBeenCalled(); expect(f.abort.signal.aborted).toBe(false);
  });

  it("retains pending challenge, typed code and server cooldown without resending", async () => {
    vi.useFakeTimers(); const f = await fixture(); fill(f);
    f.main.querySelector<HTMLButtonElement>(".registration-email button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    f.input("code").value = "0123";
    f.lifecycle.relocalize("en");
    expect(f.input("code").value).toBe("0123");
    expect(f.main.querySelector<HTMLElement>(".registration-email__code")!.hidden).toBe(false);
    const send = f.main.querySelector<HTMLButtonElement>(".registration-email button")!;
    expect(send.disabled).toBe(true); expect(send.textContent).toContain("60s");
    await vi.advanceTimersByTimeAsync(1000); expect(send.textContent).toContain("59s");
    expect(f.start).toHaveBeenCalledOnce(); expect(f.complete).not.toHaveBeenCalled();
    f.abort.abort(); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps actual proof and OAuth handle, then submits only on explicit user action", async () => {
    const url = new URL("https://login-staging.moesegfault.dev/register?tx=oauth-locale");
    captureAndScrubTransaction({ href: url.href, pathname: url.pathname, search: url.search, hash: "" } as Location, { state: null, replaceState: vi.fn() } as unknown as History);
    const f = await fixture(); fill(f);
    f.main.querySelector<HTMLButtonElement>(".registration-email button")!.click();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    f.input("code").value = "01234567";
    f.main.querySelector<HTMLButtonElement>(".registration-email__code button")!.click();
    await vi.waitFor(() => expect(f.input("code").disabled).toBe(true));
    f.lifecycle.relocalize("ja");
    expect(f.input("email").readOnly).toBe(true); expect(currentTransaction()).toBe("oauth-locale");
    expect(f.register).not.toHaveBeenCalled();
    f.main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(f.register).toHaveBeenCalledOnce());
    expect(f.register.mock.calls[0]?.[0]).toMatchObject({ email_verification_token: "actual-proof", authorization_transaction_id: "oauth-locale", locale: "ja" });
    await vi.waitFor(() => expect(f.main.querySelector("form")).toBeNull());
    f.lifecycle.relocalize("en");
    expect(f.main.querySelector("form")).toBeNull(); expect(f.register).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledOnce(); expect(f.complete).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"] as const)("owns submit-driven confirmation through final registration and %s cleanup", async outcome => {
    const f = await fixture(); fill(f);
    f.main.querySelector<HTMLButtonElement>(".registration-email button")!.click();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    f.input("code").value = "01234567";
    let confirm!: (value: Awaited<ReturnType<typeof f.complete>>) => void;
    f.complete.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    let settle!: () => void;
    f.register.mockImplementationOnce(() => new Promise((resolve, reject) => {
      settle = () => outcome === "failure" ? reject(new Error("fixture registration failure")) : resolve({ csrf_token: "session", csrf_expires_at: "later", account: {} as never, session: {} as never });
    }));
    const form = f.main.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce());
    f.lifecycle.relocalize("en");
    confirm({ email_verification_token: "actual-proof", expires_at: new Date(Date.now() + 600_000).toISOString() });
    await vi.waitFor(() => expect(f.register).toHaveBeenCalledOnce());
    expect(f.main.querySelector("form")).toBe(form);
    expect(form.querySelector<HTMLButtonElement>('button[value="password"]')!.disabled).toBe(true);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.register).toHaveBeenCalledOnce();
    settle();
    if (outcome === "success") {
      await vi.waitFor(() => expect(f.main.querySelector("form")).toBeNull());
    } else {
      await vi.waitFor(() => expect(f.main.textContent).toContain("fixture registration failure"));
      expect(f.main.querySelector<HTMLButtonElement>('button[value="password"]')!.disabled).toBe(false);
      expect(f.input("password").value).toBe("long-fixture-only-password");
      expect(f.main.textContent).toContain(translate("en", "newTitle"));
    }
    expect(f.register).toHaveBeenCalledOnce(); expect(f.complete).toHaveBeenCalledOnce();
  });

  it("releases a mailbox-only submit before any proof exists and applies the queued language", async () => {
    const f = await fixture(); fill(f);
    let sent!: (value: Awaited<ReturnType<typeof f.start>>) => void;
    f.start.mockImplementationOnce(() => new Promise(resolve => { sent = resolve; }));
    const form = f.main.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    f.lifecycle.relocalize("en");
    sent({ transaction_id: "challenge", expires_at: "later", resend_after: new Date(Date.now() + 60_000).toISOString(), delivery_hint: "k***" });
    await vi.waitFor(() => expect(f.main.querySelector("form")).not.toBe(form));
    expect(f.register).not.toHaveBeenCalled();
    expect(f.main.querySelector<HTMLButtonElement>('button[value="password"]')!.disabled).toBe(false);
    expect(f.input("password").value).toBe("long-fixture-only-password");
  });

  it("relocalizes terminal Passkey recovery codes without resurrecting signup or replaying creation", async () => {
    const f = await fixture(); fill(f);
    f.main.querySelector<HTMLButtonElement>(".registration-email button")!.click();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    f.input("code").value = "01234567";
    f.main.querySelector<HTMLButtonElement>(".registration-email__code button")!.click();
    await vi.waitFor(() => expect(f.input("code").disabled).toBe(true));
    const submitter = f.main.querySelector<HTMLButtonElement>('button[value="passkey"]')!;
    f.main.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { cancelable: true, submitter }));
    await vi.waitFor(() => expect(f.main.textContent).toContain("fixture-code-one"));
    f.lifecycle.relocalize("en");
    expect(f.main.querySelector("form")).toBeNull();
    expect(f.main.textContent).toContain("fixture-code-one");
    expect(f.main.textContent).toContain("fixture-code-two");
    expect(f.main.textContent).toContain(translate("en", "codesTitle"));
    expect(f.completeRegistration).toHaveBeenCalledOnce();
  });

  it("cannot revive terminal registration after navigation during a pending avatar upload", async () => {
    const f = await fixture(); fill(f);
    let resolveUpload!: () => void;
    const upload = vi.fn(() => new Promise<void>(resolve => { resolveUpload = resolve; }));
    f.api.uploadAvatar = upload as unknown as IdentityApiClient["uploadAvatar"];
    const picker = f.main.querySelector(".file-picker") as AvatarFilePicker;
    const dispose = vi.spyOn(picker, "dispose");
    vi.spyOn(picker, "processedFile").mockResolvedValue(new File(["avatar"], "fixture.webp", { type: "image/webp" }));
    f.main.querySelector<HTMLButtonElement>(".registration-email button")!.click();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    f.input("code").value = "01234567";
    f.main.querySelector<HTMLButtonElement>(".registration-email__code button")!.click();
    await vi.waitFor(() => expect(f.input("code").disabled).toBe(true));
    const submitter = f.main.querySelector<HTMLButtonElement>('button[value="passkey"]')!;
    f.main.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { cancelable: true, submitter }));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    expect(f.main.textContent).toContain("fixture-code-one");
    f.lifecycle.relocalize("en");
    f.abort.abort();
    const next = new AbortController(); aborts.push(next);
    await renderPage("/login", f.main, f.api, next.signal, { locale: "en" });
    const loginForm = f.main.querySelector("form");
    resolveUpload();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(f.main.querySelector("form")).toBe(loginForm);
    expect(f.main.querySelector('[name="login"]')).not.toBeNull();
    expect(f.main.textContent).not.toContain("fixture-code-one");
    expect(f.main.textContent).not.toContain("fixture-code-two");
    expect(f.completeRegistration).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
  });

  it("does not project late enrollment initialization into a newly owned main", async () => {
    const f = await fixture("/login"); f.abort.abort();
    let resolvePrincipal!: (value: Awaited<ReturnType<IdentityApiClient["getPrincipal"]>>) => void;
    f.api.getPrincipal = vi.fn<IdentityApiClient["getPrincipal"]>(() => new Promise(resolve => { resolvePrincipal = resolve; }));
    const enrollment = new AbortController(); aborts.push(enrollment);
    const loading = renderPage("/passkey/enroll", f.main, f.api, enrollment.signal, { locale: "en" });
    enrollment.abort();
    const next = new AbortController(); aborts.push(next);
    await renderPage("/login", f.main, f.api, next.signal, { locale: "en" });
    const loginForm = f.main.querySelector("form");
    resolvePrincipal({ csrf_token: "stale-session" } as never);
    await loading;
    expect(f.main.querySelector("form")).toBe(loginForm);
    expect(f.main.querySelector('[name="login"]')).not.toBeNull();
    expect(f.main.querySelector('[name="label"]')).toBeNull();
  });

  it("drops pending and late projections permanently on route abort", () => {
    const lifecycle = new PageLifecycle("zh-CN"); const route = new AbortController();
    lifecycle.bind(route.signal);
    const project = vi.fn(); lifecycle.present(project);
    const release = lifecycle.hold(); lifecycle.relocalize("en");
    route.abort(); lifecycle.present(project); lifecycle.relocalize("ja");
    release(); release(); lifecycle.dispose();
    expect(project).not.toHaveBeenCalled(); expect(lifecycle.locale).toBe("en");
  });

  it("invalidates an expired proof without inventing or resending verification", async () => {
    vi.useFakeTimers(); const f = await fixture(); fill(f);
    f.main.querySelector<HTMLButtonElement>(".registration-email button")!.click(); await vi.advanceTimersByTimeAsync(0);
    f.input("code").value = "01234567";
    f.main.querySelector<HTMLButtonElement>(".registration-email__code button")!.click(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600_001); f.lifecycle.relocalize("en");
    expect(f.input("email").readOnly).toBe(false);
    expect(f.main.textContent).toContain(translate("en", "signupProofExpired"));
    expect(f.start).toHaveBeenCalledOnce(); expect(f.register).not.toHaveBeenCalled();
  });

  it("defers form rebuilding while a mailbox mutation is unresolved", async () => {
    const f = await fixture(); fill(f); let resolve!: (value: Awaited<ReturnType<typeof f.start>>) => void;
    f.start.mockImplementationOnce(() => new Promise(ok => { resolve = ok; }));
    const form = f.main.querySelector("form");
    f.main.querySelector<HTMLButtonElement>(".registration-email button")!.click();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    f.lifecycle.relocalize("en"); expect(f.main.querySelector("form")).toBe(form);
    resolve({ transaction_id: "challenge", expires_at: "later", resend_after: new Date(Date.now() + 60_000).toISOString(), delivery_hint: "k***" });
    await vi.waitFor(() => expect(f.main.querySelector("form")).not.toBe(form));
    expect(f.input("password").value).toBe("long-fixture-only-password"); expect(f.start).toHaveBeenCalledOnce();
  });

  it.each(["/login", "/recovery"] as const)("retains credential drafts for %s without starting an operation", async route => {
    const f = await fixture(route); const names = route === "/login" ? ["login", "password"] : ["recovery_code", "authenticator_label"];
    names.forEach(name => { f.input(name).value = `fixture-${name}`; });
    f.lifecycle.relocalize("en"); names.forEach(name => expect(f.input(name).value).toBe(`fixture-${name}`));
  });
});
