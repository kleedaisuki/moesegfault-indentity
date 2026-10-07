// @vitest-environment happy-dom
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { translator } from "./i18n";
const state = vi.hoisted(() => ({ unauthorized: undefined as undefined | (() => void), api: { getMe: vi.fn(), getPreferences: vi.fn(), listContacts: vi.fn(async () => []), updatePreferences: vi.fn(), updateMe: vi.fn() } }));
vi.mock("./api/client", async (original) => ({
  ...await original<typeof import("./api/client")>(), AccountApiClient: vi.fn(function(_origin: unknown, _fetch: unknown, anonymous: () => void) {
    state.unauthorized = anonymous;
    return state.api;
  })
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
/** Boots a dirty authenticated Profile with an unconfirmed locale write and visible recovery. */
async function fixture() {
  const account = { principal_id: "A", profile: { display_name: "Initial", links: [] }, identifiers: [] };
  const preferences = { locale: "en", timezone: "UTC", theme: "system" };
  state.api.getMe.mockImplementation(async () => ({ account, csrf_token: "csrf" }));
  state.api.getPreferences.mockImplementation(async () => preferences);
  state.api.updatePreferences.mockRejectedValue(new Error("Unconfirmed locale write"));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn() }));
  const values = new Map([["moe.account.locale", "en"]]);
  vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
  history.replaceState(null, "", "/profile");
  document.body.innerHTML = '<div id="app"></div>';
  await import("./main");
  await vi.waitFor(() => expect(document.querySelector(".form-card")).not.toBeNull());
  const form = document.querySelector<HTMLFormElement>(".form-card")!;
  form.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Private retained draft";
  const select = document.querySelector<HTMLSelectElement>(".compact-select")!;
  select.value = "ja";
  select.dispatchEvent(new Event("change"));
  document.querySelector<HTMLButtonElement>(".draft-dialog .danger")!.click();
  await vi.waitFor(() => expect(document.querySelector(".locale-feedback")?.textContent).toBe(translator("en")("localeChangeFailed")));
  return { account, preferences, form, select, read: document.querySelector<HTMLButtonElement>(".locale-read-latest")! };
}
it("aborted read unlocks both headers and cannot project the old private draft or late locale", async () => {
  const f = await fixture();
  let finish!: (value: unknown) => void;
  state.api.getMe.mockImplementationOnce(() => new Promise(res => finish = res));
  f.read.click();
  expect(document.querySelectorAll('.locale-read-latest:disabled')).toHaveLength(2);
  f.read.dispatchEvent(new Event("click"));
  expect(state.api.getMe).toHaveBeenCalledTimes(2);
  f.form.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(state.api.updateMe).not.toHaveBeenCalled();
  state.unauthorized!();
  expect(f.read.disabled).toBe(false);
  expect(f.select.disabled).toBe(false);
  expect(f.read.hidden).toBe(true);
  expect(document.querySelector<HTMLElement>(".locale-feedback")!.hidden).toBe(true);
  finish({ account: f.account, csrf_token: "late" });
  await new Promise(res => setTimeout(res, 0));
  expect(document.querySelector('.app-shell[data-session="anonymous"]')).not.toBeNull();
  expect(document.querySelector(".form-card")).toBeNull();
  expect(document.documentElement.lang).toBe("en");
  expect(state.api.updatePreferences).toHaveBeenCalledOnce();
});
it("principal-changed read drops the old draft, performs no writes and focuses visible new main", async () => {
  const f = await fixture();
  state.api.getMe.mockResolvedValueOnce({ account: { ...f.account, principal_id: "B", profile: { ...f.account.profile, display_name: "New principal" } }, csrf_token: "B-csrf" });
  state.api.getPreferences.mockResolvedValueOnce({ ...f.preferences, locale: "ja" });
  f.read.focus();
  f.read.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('.form-card [name="display_name"]')?.value).toBe("New principal"));
  expect(state.api.updatePreferences).toHaveBeenCalledOnce();
  expect(state.api.updateMe).not.toHaveBeenCalled();
  expect(document.documentElement.lang).toBe("ja");
  expect(f.read.hidden).toBe(true);
  expect(document.activeElement).toBe(document.querySelector("#main"));
});
it("recovery read cannot interrupt an admitted Profile Save or dispatch extra requests", async () => {
  const f = await fixture();
  let finish!: (value: unknown) => void;
  state.api.updateMe.mockImplementationOnce(() => new Promise(res => finish = res));
  state.api.updatePreferences.mockResolvedValueOnce(f.preferences);
  f.form.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(state.api.updateMe).toHaveBeenCalledOnce();
  f.read.dispatchEvent(new Event("click"));
  expect(state.api.getMe).toHaveBeenCalledOnce();
  expect(state.api.updatePreferences).toHaveBeenCalledTimes(2);
  expect(document.querySelector(".form-card")).toBe(f.form);
  state.unauthorized!();
  finish(f.account);
  await new Promise(res => setTimeout(res, 0));
  expect(state.api.getMe).toHaveBeenCalledOnce();
});



