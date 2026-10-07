// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";
import { translator } from "./i18n";
import type { Account, AccountPreferences } from "./api/types";

const service = vi.hoisted(() => ({
  getMe: vi.fn(), getPreferences: vi.fn(), listContacts: vi.fn(async () => []),
  updateMe: vi.fn(), updatePreferences: vi.fn(),
  unauthorized: undefined as undefined | (() => void),
}));
vi.mock("./api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api/client")>(),
  AccountApiClient: vi.fn(function (_origin: string, _fetch: unknown, unauthorized: () => void) { service.unauthorized = unauthorized; return service; }),
}));

it("keeps saved Profile language consistent across current UI and authenticated bootstrap", async () => {
  let account: Account = {
    principal_id: "isolated-locale-fixture", lifecycle_state: "active", identifiers: [],
    profile: { display_name: "Locale fixture", locale: "en" },
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  let preferences: AccountPreferences = { locale: "en", theme: "system", timezone: "UTC", reduced_motion: false, compact_mode: false, notifications: { security_email: true } };
  service.getMe.mockImplementation(async () => ({ account, csrf_token: "fixture-csrf" }));
  service.getPreferences.mockImplementation(async () => preferences);
  service.updateMe.mockImplementation(async (patch: Partial<Account["profile"]>) => { account = { ...account, profile: { ...account.profile, ...patch } }; return account; });
  service.updatePreferences.mockImplementation(async (patch: Partial<AccountPreferences>) => { preferences = { ...preferences, ...patch }; return preferences; });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn() }));
  const storage = new Map([["moe.account.locale", "en"]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  history.replaceState(null, "", "/profile");
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  document.body.innerHTML = '<div id="app"></div>';
  await import("./main");
  const form = () => document.querySelector<HTMLFormElement>("#main .form-card")!;
  const profileLocale = () => form().querySelector<HTMLSelectElement>('[name="locale"]')!;
  const headerLocale = () => document.querySelector<HTMLSelectElement>(".compact-select")!;
  await vi.waitFor(() => expect(form()).not.toBeNull());
  expect(document.documentElement.lang).toBe("en");
  expect(headerLocale().value).toBe("en");
  const oldForm = form();
  profileLocale().value = "ja";
  oldForm.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(form()?.querySelector(".inline-message")?.textContent).toBe(translator("ja")("saved")));
  expect(form()).not.toBe(oldForm);
  expect(service.updatePreferences).toHaveBeenCalledOnce();
  expect(service.updatePreferences.mock.calls[0]![0].locale).toBe("ja");
  expect(preferences.locale).toBe("ja");
  // Assert the canonical renderer's selected attribute, avoiding happy-dom select-state quirks.
  expect(profileLocale().querySelector("option[selected]")?.getAttribute("value")).toBe("ja");
  expect(document.documentElement.lang).toBe("ja");
  expect(headerLocale().value).toBe("ja");
  expect(form().querySelector("h2")?.textContent).toBe(translator("ja")("editProfile"));
  expect(form().querySelector(".inline-message")?.textContent).toBe(translator("ja")("saved"));
  expect(document.title).toBe(`${translator("ja")("profile")} · moeSegFault`);
  expect(storage.get("moe.account.locale")).toBe("ja");
  const themeButton = document.querySelector<HTMLButtonElement>(".header-controls button")!;
  themeButton.focus();
  for (const expected of ["light", "dark", "system"]) {
    themeButton.click();
    expect(document.documentElement.dataset.themePreference).toBe(expected);
    expect(document.activeElement).toBe(themeButton);
    expect(document.querySelector(".header-controls button")).toBe(themeButton);
    expect(themeButton.getAttribute("aria-label")).toBe(translator("ja")("appearance"));
  }
  form().querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Retained cancelled draft";
  const selector = headerLocale(); selector.value = "en"; selector.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(document.querySelector(".draft-dialog")).not.toBeNull());
  expect(document.querySelector(".draft-dialog h2")?.textContent).toBe(translator("ja")("unsavedChangesTitle"));
  document.querySelector<HTMLButtonElement>(".draft-dialog .primary")!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(form().querySelector<HTMLInputElement>('[name="display_name"]')!.value).toBe("Retained cancelled draft");
  expect(document.documentElement.lang).toBe("ja");
  expect(headerLocale()).toBe(selector); expect(selector.value).toBe("ja");
  expect(service.updatePreferences).toHaveBeenCalledOnce();
  let finishHeader!: () => void;
  service.updatePreferences.mockImplementationOnce((patch: Partial<AccountPreferences>) => new Promise<AccountPreferences>(resolve => { finishHeader = () => { preferences = { ...preferences, ...patch }; resolve(preferences); }; }));
  const beforeHeader = form(); beforeHeader.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Approved discarded value";
  selector.value = "en"; selector.dispatchEvent(new Event("change"));
  document.querySelector<HTMLButtonElement>(".draft-dialog .danger")!.click();
  await vi.waitFor(() => expect(service.updatePreferences).toHaveBeenCalledTimes(2));
  expect(beforeHeader.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  beforeHeader.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Post-consent retained value";
  finishHeader(); await vi.waitFor(() => expect(form()).not.toBe(beforeHeader));
  expect(document.documentElement.lang).toBe("en");
  expect(form().querySelector<HTMLInputElement>('[name="display_name"]')!.value).toBe("Post-consent retained value");
  service.updatePreferences.mockRejectedValueOnce(new Error("Synthetic header failure"));
  const failureForm = form(); headerLocale().value = "ja"; headerLocale().dispatchEvent(new Event("change"));
  document.querySelector<HTMLButtonElement>(".draft-dialog .danger")!.click();
  await vi.waitFor(() => expect(document.querySelector(".locale-feedback")?.textContent).toBe(translator("en")("localeChangeFailed")));
  expect(form()).toBe(failureForm);
  expect(form().querySelector<HTMLInputElement>('[name="display_name"]')!.value).toBe("Post-consent retained value");
  expect(document.documentElement.lang).toBe("en"); expect(headerLocale().disabled).toBe(false);
  const readLatest = document.querySelector<HTMLButtonElement>(".locale-read-latest")!;
  expect(readLatest.hidden).toBe(false);
  expect(readLatest.textContent).toBe(translator("en")("readLatestState"));
  failureForm.querySelector<HTMLTextAreaElement>('[name="bio"]')!.value = "Later draft before read";
  let finishRead!: () => void;
  service.getMe.mockImplementationOnce(() => new Promise(resolve => { finishRead = () => resolve({ account, csrf_token: "fresh-read-csrf" }); }));
  const writesBeforeRead = service.updatePreferences.mock.calls.length;
  readLatest.focus(); readLatest.click();
  expect(readLatest.disabled).toBe(true); expect(headerLocale().disabled).toBe(true);
  readLatest.dispatchEvent(new Event("click"));
  headerLocale().value = "ja"; headerLocale().dispatchEvent(new Event("change"));
  expect(service.updatePreferences).toHaveBeenCalledTimes(writesBeforeRead);
  finishRead(); await vi.waitFor(() => expect(form()).not.toBeNull());
  expect(form().querySelector<HTMLInputElement>('[name="display_name"]')!.value).toBe("Post-consent retained value");
  expect(form().querySelector<HTMLTextAreaElement>('[name="bio"]')!.value).toBe("Later draft before read");
  expect(service.updatePreferences).toHaveBeenCalledTimes(writesBeforeRead);
  expect(readLatest.hidden).toBe(true); expect(readLatest.disabled).toBe(false);
  expect(document.activeElement).toBe(headerLocale());
  let finishSave!: () => void;
  service.updateMe.mockImplementationOnce((patch: Partial<Account["profile"]>) => new Promise<Account>(resolve => { finishSave = () => { account = { ...account, profile: { ...account.profile, ...patch } }; resolve(account); }; }));
  const pendingSave = form(); pendingSave.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(service.updatePreferences).toHaveBeenCalledTimes(4));
  headerLocale().value = "ja"; headerLocale().dispatchEvent(new Event("change"));
  expect(service.updatePreferences).toHaveBeenCalledTimes(4);
  expect(document.querySelector(".draft-dialog")).toBeNull();
  expect(document.querySelector(".locale-feedback")?.textContent).toBe(translator("en")("localeChangeBusy"));
  finishSave(); await vi.waitFor(() => expect(form()).not.toBe(pendingSave));
  expect(document.documentElement.lang).toBe("en");
  // A confirmed language write is not replayed when canonical readback fails.
  service.getMe.mockRejectedValueOnce(new Error("Synthetic readback failure"));
  headerLocale().value = "ja"; headerLocale().dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(document.querySelector(".locale-feedback")?.textContent).toBe(translator("ja")("localeReadbackFailed")));
  expect(document.documentElement.lang).toBe("ja");
  expect(headerLocale().disabled).toBe(false);
  const writesBeforeRetry = service.updatePreferences.mock.calls.length;
  // A recovery-read failure keeps an actionable canonical Retry and never writes.
  service.getMe.mockRejectedValueOnce(new Error("Synthetic recovery read failure"));
  document.querySelector<HTMLButtonElement>(".locale-read-latest")!.click();
  await vi.waitFor(() => expect(headerLocale().disabled).toBe(false));
  expect(document.querySelector(".failure .primary")).not.toBeNull();
  expect(service.updatePreferences).toHaveBeenCalledTimes(writesBeforeRetry);
  document.querySelector<HTMLButtonElement>(".failure .primary")!.click();
  await vi.waitFor(() => expect(form()).not.toBeNull());
  expect(service.updatePreferences).toHaveBeenCalledTimes(writesBeforeRetry);
  expect(document.querySelector<HTMLElement>(".locale-feedback")!.hidden).toBe(true);
  // Aborting a pending write promptly unlocks persistent controls; late success
  // cannot apply the old principal's locale or resurrect its private draft.
  let finishAborted!: () => void;
  service.updatePreferences.mockImplementationOnce(() => new Promise<AccountPreferences>(resolve => { finishAborted = () => resolve({ ...preferences, locale: "en" }); }));
  headerLocale().value = "en"; headerLocale().dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(headerLocale().disabled).toBe(true));
  service.unauthorized!();
  expect(headerLocale().disabled).toBe(false);
  finishAborted(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.documentElement.lang).toBe("ja");
  expect(document.querySelector(".app-shell")?.getAttribute("data-session")).toBe("anonymous");
  expect(reload).not.toHaveBeenCalled();
  // Restore persisted ja explicitly for the stale-local bootstrap probe.
  preferences = { ...preferences, locale: "ja" };
  storage.set("moe.account.locale","en");
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  await import("./main");
  await vi.waitFor(() => expect(form()).not.toBeNull());
  expect(profileLocale().querySelector("option[selected]")?.getAttribute("value")).toBe("ja");
  expect(document.documentElement.lang).toBe("ja");
  expect(headerLocale().value).toBe("ja");
  expect(form().querySelector("h2")?.textContent).toBe(translator("ja")("editProfile"));
});
