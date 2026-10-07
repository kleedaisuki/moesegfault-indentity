// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountApiClient } from "./api/client";
import type { Account } from "./api/types";
import { translator, type Locale } from "./i18n";
import { renderPage, type PageContext } from "./pages";
import { hasUnsavedChanges } from "./draft";

afterEach(() => document.body.replaceChildren());

describe("profile deterministic preflight", () => {
  it.each([
    ["links", Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`).join("\n"), "profileLinksCount"],
    ["interests", Array.from({ length: 21 }, (_, i) => `Tag${i}`).join(", "), "profileInterestsCount"],
    ["interests", "Linux, Linux", "profileInterestDuplicate"],
    ["interests", "🦊".repeat(41), "profileInterestLength"],
    ["links", "https://example.com/\nnot-a-url", "profileLinkInvalid"],
    ["links", "https://example.com/" + "a".repeat(2048), "profileLinkLength"],
    ["display_name", "\u0085 \t", "profileDisplayNameInvalid"],
    ["display_name", "🦊".repeat(81), "profileDisplayNameInvalid"],
    ["bio", "🦊".repeat(501), "profileTextTooLong"],
    ["status_message", "🦊".repeat(101), "profileTextTooLong"],
    ["pronouns", "🦊".repeat(41), "profileTextTooLong"],
    ["favorite_character", "🦊".repeat(101), "profileTextTooLong"],
    ["timezone", "", "profileTimezoneInvalid"],
    ["timezone", "x".repeat(65), "profileTimezoneInvalid"],
    ["timezone", "界".repeat(22), "profileTimezoneInvalid"],
  ] as const)("preserves invalid %s and blocks BOTH writes (%#)", async (name, value, key) => {
    const f = await fixture();
    const field = f.field(name); field.value = value;
    submit(f.form);
    expect(f.api.updateMe).not.toHaveBeenCalled(); expect(f.api.updatePreferences).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled(); expect(field.value).toBe(value);
    expect(hasUnsavedChanges(f.main)).toBe(true);
    expect(document.activeElement).toBe(field); expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(f.message.getAttribute("role")).toBe("alert");
    expect(f.message.textContent).toBe(f.t(key).replace("{item}", name === "links" && key === "profileLinkInvalid" ? "2" : key === "profileInterestDuplicate" ? "2" : "1").replace("{limit}", String(({ bio: 500, status_message: 100, pronouns: 40, favorite_character: 100 } as Record<string, number>)[name] ?? "")));
  });

  it("accepts full maximum lists and astral text without native UTF-16 truncation", async () => {
    const f = await fixture();
    const links = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
    const interests = Array.from({ length: 20 }, (_, i) => String(i).padStart(2, "0") + "🦊".repeat(38));
    for (const [name, limit] of [["display_name", 80], ["bio", 500], ["status_message", 100], ["pronouns", 40], ["favorite_character", 100]] as const) {
      f.field(name).value = "🦊".repeat(limit);
      expect(f.field(name).getAttribute("maxlength")).toBeNull();
    }
    f.field("interests").value = interests.join("， "); f.field("links").value = links.join("\n");
    f.field("timezone").value = "x".repeat(64); submit(f.form);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledWith("profile-saved"));
    expect(f.api.updateMe.mock.calls[0]?.[0]).toMatchObject({ interests, links, display_name: "🦊".repeat(80), bio: "🦊".repeat(500) });
    expect(f.api.updatePreferences.mock.calls[0]?.[0].timezone).toBe("x".repeat(64));
  });

  it("retains backend-supported legacy URL schemes and exact-case interest distinction", async () => {
    const f = await fixture();
    const prefix = "https://example.com/";
    const links = ["mailto:test@example.invalid", "ftp://example.com/file", "urn:example:thing", "custom:value", prefix + "x".repeat(2048 - prefix.length)];
    f.field("links").value = links.join("\n"); f.field("interests").value = "Linux, linux";
    f.field("timezone").value = "🦊".repeat(16); submit(f.form);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
    expect(f.api.updateMe.mock.calls[0]?.[0]).toMatchObject({ links, interests: ["Linux", "linux"] });
    expect(f.api.updatePreferences.mock.calls[0]?.[0].timezone).toBe("🦊".repeat(16));
  });

  it.each(["zh-CN", "en", "ja"] as const)("corrects a localized error without losing other profile/preference drafts (%s)", async (locale) => {
    const f = await fixture(locale);
    f.field("locale").value = locale;
    f.field("display_name").value = "New display"; f.field("timezone").value = "Custom/BackendAllowed";
    f.field("links").value = "bad-link"; submit(f.form);
    expect(f.message.textContent).toBe(f.t("profileLinkInvalid").replace("{item}", "1"));
    f.field("links").value = "https://example.com/fixed"; f.field("links").dispatchEvent(new Event("input", { bubbles: true }));
    submit(f.form);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledWith("profile-saved"));
    expect(f.api.updateMe.mock.calls[0]?.[0]).toMatchObject({ display_name: "New display", links: ["https://example.com/fixed"] });
    expect(f.api.updatePreferences.mock.calls[0]?.[0]).toMatchObject({ timezone: "Custom/BackendAllowed", locale });
    expect(f.field("links").hasAttribute("aria-invalid")).toBe(false);
  });

  it("ignores a submit after page abort before making either request", async () => {
    const f = await fixture(); f.abort.abort(); submit(f.form);
    expect(f.api.updateMe).not.toHaveBeenCalled(); expect(f.api.updatePreferences).not.toHaveBeenCalled();
  });
});

describe("profile two-write ownership and acknowledgement", () => {
  it.each(["details", "preferences"] as const)("keeps Save owned until the sibling settles after %s rejection", async (rejected) => {
    const f = await fixture();
    let finish!: () => void;
    if (rejected === "details") {
      f.api.updateMe.mockRejectedValueOnce(new Error("Unconfirmed profile"));
      f.api.updatePreferences.mockReturnValueOnce(new Promise((resolve) => { finish = () => resolve(undefined as never); }));
    } else {
      f.api.updatePreferences.mockRejectedValueOnce(new Error("Unconfirmed preferences"));
      f.api.updateMe.mockReturnValueOnce(new Promise((resolve) => { finish = () => resolve({} as Account); }));
    }
    f.field("display_name").value = "Submitted"; f.field("timezone").value = "Custom/Submitted";
    submit(f.form); await Promise.resolve(); await Promise.resolve();
    expect(f.form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    f.field("display_name").value = "Newer edit"; submit(f.form);
    expect(f.api.updateMe).toHaveBeenCalledOnce(); expect(f.api.updatePreferences).toHaveBeenCalledOnce();
    expect(f.refresh).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledWith(rejected === "details" ? "profile-partial-preferences" : "profile-partial-details"));
    expect(hasUnsavedChanges(f.main)).toBe(true); expect(f.field("display_name").value).toBe("Newer edit");
    expect(f.message.textContent).toBe(f.t(rejected === "details" ? "profilePartialPreferences" : "profilePartialDetails"));
    expect(f.message.textContent).not.toBe(f.t("saved"));
  });

  it("waits for both unconfirmed results, retains the entire draft, and unlocks only deliberate retry", async () => {
    const f = await fixture(); let fail!: (error: Error) => void;
    f.api.updateMe.mockRejectedValueOnce(new Error("Unconfirmed profile"));
    f.api.updatePreferences.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    f.field("display_name").value = "Retained draft"; submit(f.form);
    await Promise.resolve(); await Promise.resolve();
    expect(f.form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    fail(new Error("Unconfirmed preferences"));
    await vi.waitFor(() => expect(f.form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false));
    expect(f.message.textContent).toContain(f.t("profileSaveUnconfirmed"));
    expect(hasUnsavedChanges(f.main)).toBe(true); expect(f.refresh).not.toHaveBeenCalled();
    submit(f.form); await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledWith("profile-saved"));
    expect(f.api.updateMe).toHaveBeenCalledTimes(2); expect(f.api.updatePreferences).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("never repeats settled writes just because canonical refresh failed (partial=%s)", async (partial) => {
    const f = await fixture();
    if (partial) f.api.updatePreferences.mockRejectedValueOnce(new Error("Unconfirmed preference"));
    f.refresh.mockRejectedValueOnce(new Error("Refresh failed"));
    f.field("display_name").value = "Confirmed profile"; f.field("timezone").value = "Unconfirmed/Timezone";
    submit(f.form);
    await vi.waitFor(() => expect(f.message.textContent).toBe(f.t(partial ? "profilePartialRefreshFailed" : "profileSavedRefreshFailed")));
    expect(f.form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    submit(f.form); expect(f.api.updateMe).toHaveBeenCalledOnce(); expect(f.api.updatePreferences).toHaveBeenCalledOnce();
    expect(hasUnsavedChanges(f.main)).toBe(partial);
  });

  it.each([false, true])("does not acknowledge a late settled outcome after route abort (partial=%s)", async (partial) => {
    const f = await fixture(); let finish!: () => void;
    f.api.updateMe.mockReturnValueOnce(new Promise((resolve) => { finish = () => resolve({} as Account); }));
    if (partial) f.api.updatePreferences.mockRejectedValueOnce(new Error("Late error"));
    f.field("display_name").value = "Still a draft"; submit(f.form); f.abort.abort(); finish();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.refresh).not.toHaveBeenCalled(); expect(f.message.textContent).toBe("");
    expect(hasUnsavedChanges(f.main)).toBe(true);
    submit(f.form); expect(f.api.updateMe).toHaveBeenCalledOnce(); expect(f.api.updatePreferences).toHaveBeenCalledOnce();
  });
});

/** Dispatches submit directly so all validation and pending-owner checks must work without native UI. */
function submit(form: HTMLFormElement): void { form.dispatchEvent(new Event("submit", { cancelable: true })); }

/** Real profile DOM, isolated API boundary; no account/network/mail mutations occur. */
async function fixture(locale: Locale = "en") {
  const account = { principal_id: "fixture", profile: { display_name: "Test", locale, links: [] }, identifiers: [] } as unknown as Account;
  const api = { listContacts: vi.fn(async () => []), updateMe: vi.fn<AccountApiClient["updateMe"]>(async () => account), updatePreferences: vi.fn<AccountApiClient["updatePreferences"]>(async () => undefined as never) };
  const main = document.createElement("main"); document.body.append(main);
  const abort = new AbortController(); const refresh = vi.fn<NonNullable<PageContext["refresh"]>>(async () => undefined); const t = translator(locale);
  await renderPage("/profile", main, { api: api as unknown as AccountApiClient, account, csrfToken: "csrf", locale, t, signal: abort.signal, refresh, preferences: { locale, theme: "system", timezone: "UTC", reduced_motion: false, compact_mode: false, notifications: { security_email: true } } });
  const form = main.querySelector<HTMLFormElement>(".form-card")!;
  return { main, form, api, abort, refresh, t, message: form.querySelector<HTMLElement>(".inline-message")!, field: (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement };
}
