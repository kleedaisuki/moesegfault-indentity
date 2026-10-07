// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { AccountApiClient, ApiError } from "./api/client";
import type { Account } from "./api/types";
import { translator, type Locale } from "./i18n";
import { renderPage, type PageContext } from "./pages";
import { isValidNewPassword } from "./password-policy";
import { captureProfileDraft, hasUnsavedChanges } from "./draft";

describe("backend-aligned password policy", () => {
  it.each([
    ["a".repeat(14), false], ["a".repeat(15), true], ["a".repeat(128), true], ["a".repeat(129), false],
    ["🦊".repeat(8), false], ["🦊".repeat(15), true], ["🦊".repeat(128), true], ["🦊".repeat(129), false],
    [" ".repeat(15), true], ["a".repeat(15) + "\u0000", false], ["a".repeat(15) + "\u0085", false],
    ["a".repeat(15) + "\uD800", false], ["a".repeat(15) + "\n", false],
  ])("validates scalars and control characters without normalizing credentials (%#)", (password, valid) => {
    expect(isValidNewPassword(password as string)).toBe(valid);
  });
});

describe("password operation owner", () => {
  it.each(["set", "remove"] as const)("serializes %s against duplicate submission and the opposite action", async (kind) => {
    const f = await fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    if (kind === "set") f.setPassword.mockReturnValueOnce(pending);
    else f.deletePassword.mockReturnValueOnce(pending);
    f.next.value = "  exact new password  ";
    f.current.value = "exact current password";
    if (kind === "set") submit(f.form);
    else f.remove.click();
    submit(f.form); f.remove.dispatchEvent(new MouseEvent("click"));
    expect(f.setPassword).toHaveBeenCalledTimes(kind === "set" ? 1 : 0);
    expect(f.deletePassword).toHaveBeenCalledTimes(kind === "remove" ? 1 : 0);
    expect([f.save, f.remove, f.current, f.next].every((control) => control.disabled)).toBe(true);
    expect(f.form.getAttribute("aria-busy")).toBe("true");
    if (kind === "set") expect(f.setPassword).toHaveBeenCalledWith("  exact new password  ", { csrfToken: "fresh-csrf", signal: f.abort.signal }, "exact current password");
    finish();
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
    expect(f.current.value).toBe(""); expect(f.next.value).toBe("");
    expect(f.message.textContent).toBe(f.t(kind === "set" ? "passwordUpdated" : "passwordRemoved"));
    submit(f.form); f.remove.dispatchEvent(new MouseEvent("click"));
    expect(f.setPassword).toHaveBeenCalledTimes(kind === "set" ? 1 : 0);
    expect(f.deletePassword).toHaveBeenCalledTimes(kind === "remove" ? 1 : 0);
  });

  it("unlocks after failed mutation, preserves credentials for deliberate retry, and resets accessible errors", async () => {
    const f = await fixture();
    f.setPassword.mockRejectedValueOnce(new ApiError(0, { type: "urn:moesegfault:problem:network", title: "Network unavailable", status: 0 }));
    f.next.value = "a valid new password"; f.current.value = "current password";
    submit(f.form);
    await vi.waitFor(() => expect(f.message.getAttribute("role")).toBe("alert"));
    expect(f.message.textContent).toBe(f.t("networkUnavailable"));
    expect(f.save.disabled).toBe(false); expect(f.remove.disabled).toBe(false);
    expect(f.next.value).toBe("a valid new password");
    expect(f.refresh).not.toHaveBeenCalled();
    submit(f.form);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
    expect(f.setPassword).toHaveBeenCalledTimes(2);
    expect(f.message.getAttribute("role")).toBe("status");
  });

  it.each(["set", "remove"] as const)("never replays committed %s when refreshing its canonical state fails", async (kind) => {
    const f = await fixture();
    f.refresh.mockRejectedValueOnce(new Error("Refresh failed"));
    f.next.value = "a valid new password"; f.current.value = "current password";
    if (kind === "set") submit(f.form); else f.remove.click();
    await vi.waitFor(() => expect(f.message.textContent).toBe(f.t("passwordRefreshFailed")));
    expect(f.message.getAttribute("role")).toBe("alert");
    expect(f.form.getAttribute("aria-busy")).toBe("false");
    expect(f.save.disabled && f.remove.disabled).toBe(true);
    expect(f.current.value).toBe(""); expect(f.next.value).toBe("");
    submit(f.form); f.remove.dispatchEvent(new MouseEvent("click"));
    expect(f.setPassword).toHaveBeenCalledTimes(kind === "set" ? 1 : 0);
    expect(f.deletePassword).toHaveBeenCalledTimes(kind === "remove" ? 1 : 0);
  });

  it.each(["set", "remove"] as const)("clears secrets on abort and ignores late %s completion", async (kind) => {
    const f = await fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    if (kind === "set") f.setPassword.mockReturnValueOnce(pending);
    else f.deletePassword.mockReturnValueOnce(pending);
    f.next.value = "a valid new password"; f.current.value = "current password";
    if (kind === "set") submit(f.form); else f.remove.click();
    f.abort.abort();
    expect(f.current.value).toBe(""); expect(f.next.value).toBe("");
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.message.textContent).toBe("");
    submit(f.form); f.remove.dispatchEvent(new MouseEvent("click"));
    expect(f.setPassword).toHaveBeenCalledTimes(kind === "set" ? 1 : 0);
    expect(f.deletePassword).toHaveBeenCalledTimes(kind === "remove" ? 1 : 0);
  });

  it("ignores activation after an idle page abort and excludes credentials from draft preservation", async () => {
    const f = await fixture();
    f.next.value = "a valid new password"; f.current.value = "current password";
    expect(hasUnsavedChanges(f.main)).toBe(false);
    expect(captureProfileDraft(f.main)).toBeUndefined();
    f.abort.abort(); submit(f.form); f.remove.dispatchEvent(new MouseEvent("click"));
    expect(f.setPassword).not.toHaveBeenCalled(); expect(f.deletePassword).not.toHaveBeenCalled();
    expect(f.next.value).toBe(""); expect(f.current.value).toBe("");
    expect(f.save.getAttribute("aria-busy")).toBe("false");
    expect(f.remove.getAttribute("aria-busy")).toBe("false");
  });

  it("does not render a late rejected mutation into an aborted security card", async () => {
    const f = await fixture();
    let fail!: (error: Error) => void;
    f.setPassword.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { fail = reject; }));
    f.next.value = "a valid new password"; f.current.value = "current password";
    submit(f.form); f.abort.abort(); fail(new Error("Late failure"));
    await Promise.resolve(); await Promise.resolve();
    expect(f.message.textContent).toBe("");
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.save.disabled && f.remove.disabled).toBe(true);
  });

  it.each(["zh-CN", "en", "ja"] as const)("shows localized policy and validates scalars without UTF-16 limits (%s)", async (locale) => {
    const f = await fixture(false, locale);
    expect(f.next.getAttribute("minlength")).toBeNull();
    expect(f.next.getAttribute("maxlength")).toBeNull();
    expect(f.next.getAttribute("aria-describedby")).toBe("password-policy");
    expect(f.main.querySelector("#password-policy")?.textContent).toBe(f.t("passwordPolicy"));
    f.next.value = "🦊".repeat(8); submit(f.form);
    expect(f.setPassword).not.toHaveBeenCalled();
    expect(f.next.getAttribute("aria-invalid")).toBe("true");
    expect(f.message.textContent).toBe(f.t("passwordPolicy"));
    f.next.value = "🦊".repeat(128); f.next.dispatchEvent(new Event("input"));
    submit(f.form);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
    expect(f.setPassword.mock.calls[0]?.[0]).toBe("🦊".repeat(128));
  });

  it("retains backend last-method rejection and requires no credential fields to remove a password", async () => {
    const f = await fixture();
    f.deletePassword.mockRejectedValueOnce(new ApiError(409, { type: "urn:test", status: 409, title: "Last authenticator", error_code: "last_authenticator" }));
    f.remove.click();
    await vi.waitFor(() => expect(f.message.textContent).toBe("Last authenticator"));
    expect(f.deletePassword).toHaveBeenCalledWith({ csrfToken: "fresh-csrf", signal: f.abort.signal });
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.save.disabled).toBe(false); expect(f.remove.disabled).toBe(false);
  });
});

/** Dispatches submit directly to cover queued/duplicate Enter events independently of button disabled state. */
function submit(form: HTMLFormElement): void { form.dispatchEvent(new Event("submit", { cancelable: true })); }

/** Renders the real security card with only its API boundary replaced. */
async function fixture(password = true, locale: Locale = "en") {
  const setPassword = vi.fn<AccountApiClient["setPassword"]>(async () => undefined);
  const deletePassword = vi.fn<AccountApiClient["deletePassword"]>(async () => undefined);
  const api = {
    getSecurity: vi.fn(async () => ({ password, passkey_count: 1, mfa_methods: ["passkey"], verified_email_count: 1, verified_mobile_count: 0, recovery_ready: true })),
    listCredentials: vi.fn(async () => ({ items: [] })), setPassword, deletePassword,
  } as unknown as AccountApiClient;
  const main = document.createElement("main");
  const abort = new AbortController();
  const refresh = vi.fn<() => Promise<void>>(async () => undefined);
  const t = translator(locale);
  await renderPage("/security", main, { api, account: {} as Account, preferences: {} as PageContext["preferences"], csrfToken: "fresh-csrf", locale, t, signal: abort.signal, refresh });
  const form = main.querySelector<HTMLFormElement>(".password-form")!;
  return {
    main, form, abort, refresh, t, setPassword, deletePassword,
    next: form.querySelector<HTMLInputElement>('[name="password"]')!,
    current: form.querySelector<HTMLInputElement>('[name="current_password"]')!,
    save: form.querySelector<HTMLButtonElement>('[type="submit"]')!,
    remove: form.querySelector<HTMLButtonElement>(".danger")!,
    message: form.querySelector<HTMLElement>(".inline-message")!,
  };
}
