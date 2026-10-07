// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountApiClient } from "./api/client";
import type { Account, AccountPreferences, Avatar, Contact } from "./api/types";
import { renderPage, type AvatarPreparer, type PageContext } from "./pages";
import { translator } from "./i18n";
import type { ProcessedAvatar } from "@moesegfault/frontend-shared";

afterEach(() => document.body.replaceChildren());
type Operation = "save" | "prepare" | "upload" | "avatar-remove" | "contact-add" | "contact-remove" | "contact-promote" | "verify-start" | "verify-resend" | "verify-confirm";

describe("Profile cross-operation ownership", () => {
  it.each<Operation>(["save", "prepare", "upload", "avatar-remove", "contact-add", "contact-remove", "contact-promote", "verify-start", "verify-resend", "verify-confirm"])("pending %s blocks every other mutation while retaining text editing", async (operation) => {
    const f = await fixture();
    const finish = await startPending(f, operation);
    const watched = [f.api.updateMe, f.api.updatePreferences, f.api.uploadAvatar, f.api.deleteAvatar, f.api.addContact, f.api.deleteContact, f.api.makePrimary, f.api.startContactVerification, f.api.completeContactVerification, f.prepareAvatar];
    const counts = watched.map((mock) => mock.mock.calls.length);
    expect(f.form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    expect(f.name.disabled).toBe(false); f.name.value = "Newer editable draft";
    f.contactForm.querySelector<HTMLInputElement>('[name="value"]')!.value = "new@example.invalid";
    for (const form of f.main.querySelectorAll("form")) submit(form);
    for (const button of f.main.querySelectorAll("button")) button.dispatchEvent(new MouseEvent("click", { cancelable: true }));
    chooseFile(f.file);
    expect(watched.map((mock) => mock.mock.calls.length)).toEqual(counts);
    expect(f.name.value).toBe("Newer editable draft");
    finish();
    await vi.waitFor(() => expect(f.form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false));
    expect(f.name.value).toBe("Newer editable draft");
    f.abort.abort();
  });

  it("holds the owner through canonical refresh instead of releasing at endpoint completion", async () => {
    const f = await fixture(); const reading = deferred<void>();
    f.refresh.mockReturnValueOnce(reading.promise); f.avatarRemove.click();
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
    submit(f.form); expect(f.api.updateMe).not.toHaveBeenCalled();
    expect(f.form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    reading.resolve();
    await vi.waitFor(() => expect(f.form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false));
  });

  it("does not revive terminal Save after another operation acquires and releases", async () => {
    const f = await fixture(); f.refresh.mockRejectedValueOnce(new Error("Refresh failed"));
    submit(f.form);
    await vi.waitFor(() => expect(f.form.querySelector(".inline-message")?.textContent).toBe(translator("en")("profileSavedRefreshFailed")));
    f.avatarRemove.click(); await vi.waitFor(() => expect(f.api.deleteAvatar).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.avatarRemove.disabled).toBe(false));
    expect(f.form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    submit(f.form); expect(f.api.updateMe).toHaveBeenCalledOnce();
  });

  it("disposes a late prepared preview after abort without reviving Save or refreshing", async () => {
    const f = await fixture(); const pending = deferred<ProcessedAvatar>();
    f.prepareAvatar.mockReturnValueOnce(pending.promise); chooseFile(f.file);
    const preview = prepared(); f.abort.abort(); pending.resolve(preview);
    await vi.waitFor(() => expect(preview.dispose).toHaveBeenCalledOnce());
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    submit(f.form); expect(f.api.updateMe).not.toHaveBeenCalled();
  });
});

/** Queued events must be guarded even when native disabled controls would suppress real clicks. */
function submit(form: HTMLFormElement): void { form.dispatchEvent(new Event("submit", { cancelable: true })); }
/** Selects only an in-memory fixture file; no native chooser is invoked. */
function chooseFile(input: HTMLInputElement): void {
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["source"], "fixture.png", { type: "image/png" })] });
  input.dispatchEvent(new Event("change"));
}
/** Deferred values model a server request that is not rolled back by client-side render abort. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}
/** Holds exactly one typed API/preparation response while the actual form handlers remain active. */
function hold<T>(mock: { mockReturnValueOnce(value: Promise<T>): unknown }, result: T): () => void {
  const pending = deferred<T>(); mock.mockReturnValueOnce(pending.promise); return () => pending.resolve(result);
}
/** Creates a disposable processed-image double without Canvas or any native device. */
function prepared() {
  const file = new File(["prepared"], "fixture.webp", { type: "image/webp" });
  return { file, blob: file, previewUrl: "blob:fixture", dispose: vi.fn(), metadata: { edge: 512, outputBytes: 8, inputBytes: 6, sourceWidth: 512, sourceHeight: 512, mediaType: "image/webp" as const } } satisfies ProcessedAvatar;
}

/** Starts each existing workflow through its real DOM handler, not a direct owner call. */
async function startPending(f: Awaited<ReturnType<typeof fixture>>, operation: Operation): Promise<() => void> {
  if (operation === "upload") { chooseFile(f.file); await vi.waitFor(() => expect(f.main.querySelector<HTMLElement>(".avatar-prepared-actions")!.hidden).toBe(false)); }
  if (operation === "verify-resend" || operation === "verify-confirm") {
    f.verify.click(); await vi.waitFor(() => expect(f.main.querySelector(".verification-form")).not.toBeNull());
  }
  switch (operation) {
    case "save": { const finish = hold(f.api.updateMe, f.account); submit(f.form); return finish; }
    case "prepare": { const finish = hold(f.prepareAvatar, prepared()); chooseFile(f.file); return finish; }
    case "upload": { const finish = hold(f.api.uploadAvatar, f.avatar); f.main.querySelector<HTMLButtonElement>(".avatar-prepared-actions .primary")!.click(); return finish; }
    case "avatar-remove": { const finish = hold(f.api.deleteAvatar, undefined); f.avatarRemove.click(); return finish; }
    case "contact-add": { const finish = hold(f.api.addContact, f.contact); f.contactForm.querySelector<HTMLInputElement>('[name="value"]')!.value = "new@example.invalid"; submit(f.contactForm); return finish; }
    case "contact-remove": { const finish = hold(f.api.deleteContact, undefined); f.main.querySelector<HTMLButtonElement>(".entity-row .danger")!.click(); return finish; }
    case "contact-promote": { const finish = hold(f.api.makePrimary, f.contact); f.main.querySelector<HTMLButtonElement>(".entity-row:nth-child(2) .quiet")!.click(); return finish; }
    case "verify-start": { const finish = hold(f.api.startContactVerification, f.transaction); f.verify.click(); return finish; }
    case "verify-resend": { const finish = hold(f.api.startContactVerification, f.transaction); f.main.querySelector<HTMLButtonElement>('.verification-form button[type="button"]')!.click(); return finish; }
    case "verify-confirm": { const finish = hold(f.api.completeContactVerification, f.contact); const form = f.main.querySelector<HTMLFormElement>(".verification-form")!; form.querySelector<HTMLInputElement>("input")!.value = "12345678"; submit(form); return finish; }
  }
}

/** Real Profile render with typed API doubles and a non-replacing refresh boundary. */
async function fixture() {
  const account = { principal_id: "fixture", profile: { display_name: "Initial", locale: "en", links: [], avatar_url: "https://example.com/avatar.webp" }, identifiers: [] } as unknown as Account;
  const preferences: AccountPreferences = { locale: "en", timezone: "UTC", theme: "system", reduced_motion: false, compact_mode: false, notifications: { security_email: true } };
  const contact: Contact = { contact_id: "pending", kind: "email", value: "pending@example.invalid", verification_state: "pending", is_primary: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
  const avatar: Avatar = { avatar_id: "avatar", url: "https://example.com/avatar.webp", media_type: "image/webp", width: 512, height: 512, updated_at: "2026-01-01T00:00:00Z" };
  const transaction = { transaction_id: "verification", delivery_hint: "p***@example.invalid", expires_at: "2026-01-01T00:10:00Z" };
  const api = {
    listContacts: vi.fn(async () => [contact, { ...contact, contact_id: "verified", value: "verified@example.invalid", verification_state: "verified" as const }]),
    updateMe: vi.fn<AccountApiClient["updateMe"]>(async () => account), updatePreferences: vi.fn<AccountApiClient["updatePreferences"]>(async () => preferences),
    deleteAvatar: vi.fn<AccountApiClient["deleteAvatar"]>(async () => undefined), uploadAvatar: vi.fn<AccountApiClient["uploadAvatar"]>(async () => avatar),
    addContact: vi.fn<AccountApiClient["addContact"]>(async () => contact), deleteContact: vi.fn<AccountApiClient["deleteContact"]>(async () => undefined), makePrimary: vi.fn<AccountApiClient["makePrimary"]>(async () => contact),
    startContactVerification: vi.fn<AccountApiClient["startContactVerification"]>(async () => transaction), completeContactVerification: vi.fn<AccountApiClient["completeContactVerification"]>(async () => contact),
  };
  const abort = new AbortController(); const refresh = vi.fn<PageContext["refresh"]>(async () => undefined); const prepareAvatar = vi.fn<AvatarPreparer>(async () => prepared());
  const main = document.createElement("main"); document.body.append(main);
  await renderPage("/profile", main, { api: api as unknown as AccountApiClient, account, preferences, csrfToken: "csrf", locale: "en", t: translator("en"), signal: abort.signal, refresh, prepareAvatar });
  return { main, api, account, preferences, contact, avatar, transaction, abort, refresh, prepareAvatar, form: main.querySelector<HTMLFormElement>(".form-card")!, name: main.querySelector<HTMLInputElement>('[name="display_name"]')!, file: main.querySelector<HTMLInputElement>('[type="file"]')!, avatarRemove: main.querySelector<HTMLButtonElement>(".avatar-controls .danger")!, contactForm: main.querySelector<HTMLFormElement>(".contact-form")!, verify: main.querySelector<HTMLButtonElement>(".entity-row .quiet")! };
}
