// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";
import type { Account, AccountPreferences } from "./api/types";

const service = vi.hoisted(() => ({
  getMe: vi.fn(), getPreferences: vi.fn(), listContacts: vi.fn(async () => []),
  updateMe: vi.fn(), updatePreferences: vi.fn(), deleteAvatar: vi.fn(async () => undefined),
}));

vi.mock("./api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api/client")>(),
  AccountApiClient: vi.fn(function () { return service; }),
}));

it("Profile owner: prevents avatar refresh from replacing a pending Save owner and overtaking its write", async () => {
  let account: Account = {
    principal_id: "isolated-race-fixture", lifecycle_state: "active", identifiers: [],
    profile: { display_name: "Original", locale: "en", avatar_url: "https://example.com/avatar.webp" },
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  let preferences: AccountPreferences = { locale: "en", theme: "system", timezone: "UTC", reduced_motion: false, compact_mode: false, notifications: { security_email: true } };
  service.getMe.mockImplementation(async () => ({ account, csrf_token: "fixture-csrf" }));
  service.getPreferences.mockImplementation(async () => preferences);
  service.updatePreferences.mockImplementation(async (patch: Partial<AccountPreferences>) => { preferences = { ...preferences, ...patch }; return preferences; });
  service.updateMe.mockImplementation(async (patch: Partial<Account["profile"]>) => {
    account = { ...account, profile: { ...account.profile, ...patch } };
    return account;
  });
  let commitOld!: () => void;
  service.updateMe.mockImplementationOnce((patch: Partial<Account["profile"]>) => new Promise<Account>((resolve) => {
    // A server write already admitted is not rolled back by a later client render abort.
    commitOld = () => { account = { ...account, profile: { ...account.profile, ...patch } }; resolve(account); };
  }));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn() }));
  const storage = new Map([["moe.account.locale", "en"]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  history.replaceState(null, "", "/profile");
  document.body.innerHTML = '<div id="app"></div>';
  await import("./main");
  const currentForm = () => document.querySelector<HTMLFormElement>("#main .form-card")!;
  const name = () => currentForm().querySelector<HTMLInputElement>('[name="display_name"]')!;
  const save = () => currentForm().querySelector<HTMLButtonElement>('[type="submit"]')!;
  const avatarRemove = () => document.querySelector<HTMLButtonElement>(".avatar-controls .button.danger")!;
  await vi.waitFor(() => expect(currentForm()).not.toBeNull());
  const originalForm = currentForm();
  name().value = "Old submitted";
  originalForm.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(service.updateMe).toHaveBeenCalledOnce());
  expect(save().disabled).toBe(true);
  const oldSignal = service.updateMe.mock.calls[0]![1].signal as AbortSignal;
  name().value = "Newer draft";
  expect(avatarRemove().disabled).toBe(true);
  avatarRemove().dispatchEvent(new Event("click"));
  expect(service.deleteAvatar).not.toHaveBeenCalled();
  expect(currentForm()).toBe(originalForm);
  expect(oldSignal.aborted).toBe(false);
  originalForm.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(service.updateMe).toHaveBeenCalledOnce();
  commitOld();
  await vi.waitFor(() => expect(currentForm()).not.toBe(originalForm));
  expect(name().value).toBe("Newer draft");
  expect(account.profile.display_name).toBe("Old submitted");
  const freshForm = currentForm();
  name().value = "Newest submitted";
  freshForm.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(currentForm()).not.toBe(freshForm));
  expect(account.profile.display_name).toBe("Newest submitted");
  expect(name().value).toBe("Newest submitted");
  expect(currentForm().querySelector(".inline-message")?.textContent).toBe("Saved");
});
