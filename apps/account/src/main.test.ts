// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import type { Account, AccountPreferences } from "./api/types";
import { captureProfileDraft, hasUnsavedChanges } from "./draft";
import { translator } from "./i18n";

const state = vi.hoisted(() => ({
  api: {
    getMe: vi.fn(), getPreferences: vi.fn(), listContacts: vi.fn(async () => []),
    deleteAvatar: vi.fn<() => Promise<void>>(async () => undefined), updateMe: vi.fn(), updatePreferences: vi.fn(),
    listConnectedApps: vi.fn(async () => ({ items: [] })),
    listSessions: vi.fn(async () => ({ items: [{ session_id: "current", is_current: true }] })),
    revokeSession: vi.fn(async () => undefined),
  },
}));

vi.mock("./api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api/client")>(),
  AccountApiClient: vi.fn(function () { return state.api; }),
}));

describe("Account refresh draft lifecycle", () => {
  it("preserves drafts through refresh/history, scopes mutation feedback, and guards sign-out before revocation", async () => {
    let account: Account = {
      principal_id: "first", lifecycle_state: "active", profile: { display_name: "Klee", locale: "en", avatar_url: "https://example.com/avatar.webp", links: ["https://example.com/old"] },
      identifiers: [], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    };
    let preferences: AccountPreferences = { locale: "en", theme: "system", timezone: "UTC", reduced_motion: false, compact_mode: false, notifications: { security_email: true } };
    let csrf = "initial-csrf";
    state.api.getMe.mockImplementation(async () => ({ account, csrf_token: csrf }));
    state.api.getPreferences.mockImplementation(async () => preferences);
    state.api.updateMe.mockImplementation(async (changes: Partial<Account["profile"]>) => {
      account = { ...account, profile: { ...account.profile, ...changes } };
      return account;
    });
    state.api.updatePreferences.mockImplementation(async (patch: Partial<AccountPreferences>) => { preferences = { ...preferences, ...patch }; return preferences; });
    const media = { matches: false, addEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", () => media);
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), clear: () => stored.clear() });
    document.body.innerHTML = '<div id="app"></div>';
    window.localStorage.clear(); window.localStorage.setItem("moe.account.locale", "en");
    history.replaceState(null, "", "/profile");
    const confirm = vi.fn(() => false);
    const decide = (approved = false) => {
      const dialog = document.querySelector<HTMLDialogElement>(".draft-dialog")!;
      expect(dialog?.open).toBe(true);
      dialog.querySelector<HTMLButtonElement>(approved ? ".danger" : ".primary")!.click();
    };
    vi.stubGlobal("confirm", confirm);
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector('.form-card [name="display_name"]')).not.toBeNull());
    const main = document.querySelector<HTMLElement>("#main")!;
    const originalForm = main.querySelector(".form-card")!;
    originalForm.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Local draft";

    const locale = document.querySelector<HTMLSelectElement>(".compact-select")!;
    locale.value = "ja"; locale.dispatchEvent(new Event("change"));
    decide();
    expect(confirm).not.toHaveBeenCalled();
    expect(locale.value).toBe("en");
    expect(window.localStorage.getItem("moe.account.locale")).toBe("en");
    for (let index = 0; index < 3; index++) document.querySelector<HTMLButtonElement>('.header-controls button')!.click();
    expect(media.addEventListener).toHaveBeenCalledOnce();

    const actualClient = await vi.importActual<typeof import("./api/client")>("./api/client");
    const failingTransport = new actualClient.AccountApiClient("https://identity.example.test", async () => { throw new TypeError("Failed to fetch"); });
    const networkError = await failingTransport.getMe().catch((error: unknown) => error);
    expect(networkError).toBeInstanceOf(actualClient.ApiError);
    expect((networkError as InstanceType<typeof actualClient.ApiError>).status).toBe(0);
    state.api.getMe.mockRejectedValueOnce(networkError);
    main.querySelector<HTMLButtonElement>(".avatar-controls .button.danger")!.click();
    await vi.waitFor(() => expect(main.querySelector(".failure")).not.toBeNull());
    expect(main.querySelector(".failure p")?.textContent).toBe(translator("en")("networkUnavailable"));
    expect(main.querySelector(".failure")?.textContent).not.toContain("Unable to reach the identity service.");
    const exitDuringFailure = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(exitDuringFailure);
    expect(exitDuringFailure.defaultPrevented).toBe(true);
    document.querySelector<HTMLAnchorElement>('a[data-route="/apps"]')!.click();
    expect(location.pathname).toBe("/profile");
    decide();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const serviceError = new actualClient.ApiError(503, { type: "urn:moesegfault:problem:unavailable", title: "Unavailable", status: 503, detail: "Profile service is temporarily unavailable." }, "retained-correlation-id");
    state.api.getMe.mockRejectedValueOnce(serviceError);
    main.querySelector<HTMLButtonElement>(".failure button")!.click();
    await vi.waitFor(() => expect(main.querySelector(".failure p")?.textContent).toBe(serviceError.message));
    expect(serviceError.correlationId).toBe("retained-correlation-id");
    account = { ...account, profile: { ...account.profile, display_name: "Server name", links: ["https://example.com/server-new"] } };
    csrf = "fresh-csrf";
    main.querySelector<HTMLButtonElement>(".failure button")!.click();
    await vi.waitFor(() => expect(main.querySelector('.form-card [name="display_name"]')).not.toBeNull());
    const restoredForm = main.querySelector<HTMLFormElement>(".form-card")!;
    expect(restoredForm).not.toBe(originalForm);
    expect(restoredForm.querySelector<HTMLInputElement>('[name="display_name"]')!.value).toBe("Local draft");
    expect(restoredForm.querySelector<HTMLTextAreaElement>('[name="links"]')!.value).toBe("https://example.com/server-new");
    expect(hasUnsavedChanges(main)).toBe(true);
    restoredForm.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(state.api.updateMe).toHaveBeenCalledOnce());
    expect(state.api.updateMe.mock.calls[0]?.[1].csrfToken).toBe("fresh-csrf");
    await vi.waitFor(() => expect(main.querySelector(".form-card")).not.toBe(restoredForm));
    expect(main.querySelector(".form-card .inline-message")?.textContent).toBe(translator("en")("saved"));

    const savingForm = main.querySelector<HTMLFormElement>(".form-card")!;
    let finishSave!: () => void;
    state.api.updateMe.mockImplementationOnce((changes: Partial<Account["profile"]>) => new Promise<Account>((resolve) => {
      finishSave = () => { account = { ...account, profile: { ...account.profile, ...changes } }; resolve(account); };
    }));
    savingForm.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Saved while pending";
    savingForm.dispatchEvent(new Event("submit", { cancelable: true }));
    savingForm.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Newer unsaved";
    finishSave();
    await vi.waitFor(() => expect(main.querySelector(".form-card")).not.toBe(savingForm));
    expect(main.querySelector<HTMLInputElement>('[name="display_name"]')!.value).toBe("Newer unsaved");
    expect(hasUnsavedChanges(main)).toBe(true);
    expect(main.querySelector(".form-card .inline-message")?.textContent).toBe(translator("en")("savedWithNewChanges"));
    document.querySelector<HTMLAnchorElement>('a[data-route="/apps"]')!.click();
    decide(true);
    await vi.waitFor(() => expect(location.pathname).toBe("/apps"));
    document.querySelector<HTMLAnchorElement>('a[data-route="/profile"]')!.click();
    await vi.waitFor(() => expect(main.querySelector<HTMLInputElement>('[name="display_name"]')?.value).toBe("Saved while pending"));
    expect(hasUnsavedChanges(main)).toBe(false);

    main.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "History draft";
    confirm.mockClear();
    document.querySelector<HTMLButtonElement>(".user-chip")!.click();
    const staleApproval = document.querySelector<HTMLButtonElement>(".draft-dialog .danger")!;
    expect(staleApproval).not.toBeNull();
    history.back();
    await vi.waitFor(() => expect(location.pathname).toBe("/apps"));
    await vi.waitFor(() => expect(main.querySelector(".app-grid")).not.toBeNull());
    expect(document.querySelector(".draft-dialog")).toBeNull();
    staleApproval.click();
    expect(state.api.listSessions).not.toHaveBeenCalled();
    expect(state.api.revokeSession).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    account = { ...account, profile: { ...account.profile, links: ["https://example.com/history-server-update"] } };
    csrf = "history-csrf";
    history.forward();
    await vi.waitFor(() => expect(main.querySelector<HTMLInputElement>('[name="display_name"]')?.value).toBe("History draft"));
    expect(main.querySelector<HTMLTextAreaElement>('[name="links"]')!.value).toBe("https://example.com/history-server-update");
    expect(hasUnsavedChanges(main)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();

    history.back();
    await vi.waitFor(() => expect(main.querySelector(".app-grid")).not.toBeNull());
    document.querySelector<HTMLAnchorElement>('a[data-route="/"]')!.click();
    await vi.waitFor(() => expect(main.querySelector(".hero-card")).not.toBeNull());
    expect(confirm).not.toHaveBeenCalled();
    const hiddenExit = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(hiddenExit);
    expect(hiddenExit.defaultPrevented).toBe(true);
    const hiddenLocale = document.querySelector<HTMLSelectElement>(".compact-select")!;
    hiddenLocale.value = "ja"; hiddenLocale.dispatchEvent(new Event("change"));
    expect(hiddenLocale.value).toBe("en");
    decide();
    expect(confirm).not.toHaveBeenCalled();
    document.querySelector<HTMLAnchorElement>('a[data-route="/profile"]')!.click();
    await vi.waitFor(() => expect(main.querySelector<HTMLInputElement>('[name="display_name"]')?.value).toBe("History draft"));
    // An explicit discard must not be recaptured or resurrected by a later native traversal.
    document.querySelector<HTMLAnchorElement>('a[data-route="/apps"]')!.click();
    decide(true);
    await vi.waitFor(() => expect(main.querySelector(".app-grid")).not.toBeNull());
    history.back();
    await vi.waitFor(() => expect(main.querySelector<HTMLInputElement>('[name="display_name"]')?.value).toBe("Saved while pending"));
    expect(hasUnsavedChanges(main)).toBe(false);

    const beforeAvatarRefresh = main.querySelector(".avatar-card");
    main.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Unsaved during avatar refresh";
    csrf = "avatar-csrf";
    main.querySelector<HTMLButtonElement>(".avatar-controls .button.danger")!.click();
    await vi.waitFor(() => expect(main.querySelector(".avatar-card")).not.toBe(beforeAvatarRefresh));
    expect(main.querySelector(".avatar-card .inline-message")?.textContent).toBe(translator("en")("saved"));
    expect(main.querySelector(".form-card .inline-message")?.textContent).toBe("");
    expect(main.querySelector<HTMLInputElement>('[name="display_name"]')!.value).toBe("Unsaved during avatar refresh");
    expect(hasUnsavedChanges(main)).toBe(true);
    main.querySelector<HTMLFormElement>(".form-card")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(main.querySelector(".form-card .inline-message")?.textContent).toBe(translator("en")("saved")));
    expect(state.api.updateMe.mock.lastCall?.[1].csrfToken).toBe("avatar-csrf");

    main.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "First account draft";
    state.api.getMe.mockImplementationOnce(async () => {
      account = { ...account, principal_id: "second", profile: { ...account.profile, display_name: "Other account" } };
      return { account, csrf_token: "other-csrf" };
    });
    main.querySelector<HTMLFormElement>(".form-card")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(main.querySelector<HTMLInputElement>('[name="display_name"]')?.value).toBe("Other account"));
    expect(hasUnsavedChanges(main)).toBe(false);
    expect(main.querySelector(".form-card .inline-message")?.textContent).toBe("");

    const otherAvatarCard = main.querySelector(".avatar-card");
    state.api.getMe.mockImplementationOnce(async () => {
      account = { ...account, principal_id: "third", profile: { ...account.profile, display_name: "Third account" } };
      return { account, csrf_token: "third-csrf" };
    });
    main.querySelector<HTMLButtonElement>(".avatar-controls .button.danger")!.click();
    await vi.waitFor(() => expect(main.querySelector(".avatar-card")).not.toBe(otherAvatarCard));
    expect(main.querySelector(".avatar-card .inline-message")?.textContent).toBe("");
    expect(main.querySelector<HTMLInputElement>('[name="display_name"]')!.value).toBe("Third account");

    let finishDelete!: () => void;
    state.api.deleteAvatar.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDelete = resolve; }));
    main.querySelector<HTMLButtonElement>(".avatar-controls .button.danger")!.click();
    document.querySelector<HTMLAnchorElement>('a[data-route="/apps"]')!.click();
    await vi.waitFor(() => expect(location.pathname).toBe("/apps"));
    const reloadCount = state.api.getMe.mock.calls.length;
    finishDelete();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.api.getMe).toHaveBeenCalledTimes(reloadCount);

    document.querySelector<HTMLAnchorElement>('a[data-route="/profile"]')!.click();
    await vi.waitFor(() => expect(main.querySelector(".form-card")).not.toBeNull());
    let finishAvatarRefresh!: () => void;
    state.api.getMe.mockImplementationOnce(() => new Promise((resolve) => { finishAvatarRefresh = () => resolve({ account, csrf_token: "late-avatar-csrf" }); }));
    main.querySelector<HTMLButtonElement>(".avatar-controls .button.danger")!.click();
    await vi.waitFor(() => expect(finishAvatarRefresh).toBeTypeOf("function"));
    document.querySelector<HTMLAnchorElement>('a[data-route="/apps"]')!.click();
    await vi.waitFor(() => expect(main.querySelector(".app-grid")).not.toBeNull());
    finishAvatarRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(main.querySelector(".avatar-card")).toBeNull();
    expect(main.textContent).not.toContain(translator("en")("saved"));
    document.querySelector<HTMLAnchorElement>('a[data-route="/profile"]')!.click();
    await vi.waitFor(() => expect(main.querySelector(".form-card")).not.toBeNull());
    let finishRefresh!: () => void;
    state.api.getMe.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = () => resolve({ account, csrf_token: "late-csrf" }); }));
    main.querySelector<HTMLFormElement>(".form-card")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(finishRefresh).toBeTypeOf("function"));
    document.querySelector<HTMLAnchorElement>('a[data-route="/apps"]')!.click();
    await vi.waitFor(() => expect(main.querySelector(".app-grid")).not.toBeNull());
    finishRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(location.pathname).toBe("/apps");
    expect(main.querySelector(".form-card")).toBeNull();
    expect(main.textContent).not.toContain(translator("en")("saved"));
    document.querySelector<HTMLAnchorElement>('a[data-route="/profile"]')!.click();
    await vi.waitFor(() => expect(main.querySelector(".form-card")).not.toBeNull());
    // Partial writes acknowledge only their fulfilled group and keep ownership until BOTH settle.
    const partialForm = main.querySelector<HTMLFormElement>(".form-card")!;
    let finishPartial!: () => void;
    state.api.updateMe.mockImplementationOnce((changes: Partial<Account["profile"]>) => new Promise<Account>((resolve) => {
      finishPartial = () => { account = { ...account, profile: { ...account.profile, ...changes } }; resolve(account); };
    }));
    state.api.updatePreferences.mockRejectedValueOnce(new Error("Unconfirmed preferences"));
    partialForm.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Confirmed profile";
    partialForm.querySelector<HTMLInputElement>('[name="timezone"]')!.value = "Custom/Unconfirmed";
    const callsBeforePartial = state.api.updateMe.mock.calls.length;
    partialForm.dispatchEvent(new Event("submit", { cancelable: true }));
    partialForm.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Newer profile draft";
    await Promise.resolve(); await Promise.resolve();
    expect(partialForm.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    partialForm.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(state.api.updateMe).toHaveBeenCalledTimes(callsBeforePartial + 1);
    finishPartial();
    await vi.waitFor(() => expect(main.querySelector(".form-card")).not.toBe(partialForm));
    expect(main.querySelector<HTMLInputElement>('[name="display_name"]')!.value).toBe("Newer profile draft");
    expect(main.querySelector<HTMLInputElement>('[name="timezone"]')!.value).toBe("Custom/Unconfirmed");
    expect(main.querySelector(".form-card .inline-message")?.textContent).toBe(translator("en")("profilePartialDetails"));
    expect(main.querySelector(".form-card .inline-message")?.getAttribute("role")).toBe("alert");
    main.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Confirmed profile";
    expect(Array.from(captureProfileDraft(main)!.keys())).toEqual(["timezone"]);
    main.querySelector<HTMLFormElement>(".form-card")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(main.querySelector(".form-card .inline-message")?.textContent).toBe(translator("en")("saved")));

    const reversePartial = main.querySelector<HTMLFormElement>(".form-card")!;
    state.api.updateMe.mockRejectedValueOnce(new Error("Unconfirmed profile"));
    reversePartial.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Unconfirmed profile draft";
    reversePartial.querySelector<HTMLInputElement>('[name="timezone"]')!.value = "Custom/Confirmed";
    reversePartial.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(main.querySelector(".form-card")).not.toBe(reversePartial));
    expect(main.querySelector(".form-card .inline-message")?.textContent).toBe(translator("en")("profilePartialPreferences"));
    expect(main.querySelector<HTMLInputElement>('[name="timezone"]')!.value).toBe("Custom/Confirmed");
    expect(Array.from(captureProfileDraft(main)!.keys())).toEqual(["display_name"]);
    main.querySelector<HTMLFormElement>(".form-card")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(main.querySelector(".form-card .inline-message")?.textContent).toBe(translator("en")("saved")));
    const signOutButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".user-chip, .mobile-sign-out"));
    main.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Sign-out draft";
    confirm.mockClear();
    signOutButtons[0]!.click();
    decide();
    await vi.waitFor(() => expect(signOutButtons.every((button) => !button.disabled)).toBe(true));
    expect(confirm).not.toHaveBeenCalled();
    expect(state.api.listSessions).not.toHaveBeenCalled();
    expect(state.api.revokeSession).not.toHaveBeenCalled();
    expect(main.querySelector<HTMLInputElement>('[name="display_name"]')!.value).toBe("Sign-out draft");

    history.back();
    await vi.waitFor(() => expect(main.querySelector(".app-grid")).not.toBeNull());
    confirm.mockClear();
    signOutButtons[1]!.click();
    decide();
    await vi.waitFor(() => expect(signOutButtons.every((button) => !button.disabled)).toBe(true));
    expect(confirm).not.toHaveBeenCalled();
    expect(state.api.listSessions).not.toHaveBeenCalled();
    expect(state.api.revokeSession).not.toHaveBeenCalled();
    history.forward();
    await vi.waitFor(() => expect(main.querySelector<HTMLInputElement>('[name="display_name"]')?.value).toBe("Sign-out draft"));
    main.querySelector<HTMLFormElement>(".form-card")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(main.querySelector(".form-card .inline-message")?.textContent).toBe(translator("en")("saved")));

    // Clean sign-out does not ask for discard; ordinary server failure remains retryable.
    confirm.mockClear();
    state.api.revokeSession.mockRejectedValueOnce(new Error("Revocation failed"));
    signOutButtons[0]!.click();
    await vi.waitFor(() => expect(main.querySelector(".failure")).not.toBeNull());
    expect(confirm).not.toHaveBeenCalled();
    expect(state.api.revokeSession).toHaveBeenCalledWith("current", expect.objectContaining({ csrfToken: csrf }));
    main.querySelector<HTMLButtonElement>(".failure button")!.click();
    await vi.waitFor(() => expect(main.querySelector(".form-card")).not.toBeNull());
    main.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Approved hidden discard";
    history.back();
    await vi.waitFor(() => expect(main.querySelector(".app-grid")).not.toBeNull());
    confirm.mockClear();
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    signOutButtons[1]!.click();
    decide(true);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(confirm).not.toHaveBeenCalled();
    expect(state.api.revokeSession).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledWith("http://localhost:5173/login");
    expect(document.querySelector(".app-shell")?.getAttribute("data-session")).toBe("anonymous");
    const approvedExit = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(approvedExit);
    expect(approvedExit.defaultPrevented).toBe(false);
    expect(signOutButtons.every((button) => !button.disabled)).toBe(true);
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    const anonymousLocale = document.querySelector<HTMLSelectElement>(".compact-select")!;
    anonymousLocale.value = "ja"; anonymousLocale.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(document.documentElement.lang).toBe("ja"));
    expect(reload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("moe.account.locale")).toBe("ja");
    expect(document.querySelector(".draft-dialog")).toBeNull();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
