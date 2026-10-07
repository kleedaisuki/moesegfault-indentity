// @vitest-environment happy-dom

import { AvatarImageError, type ProcessedAvatar } from "@moesegfault/frontend-shared";
import { describe, expect, it, vi } from "vitest";
import { avatarPreparationError, errorText, formatAvatarOutput, mutationErrorPresentation, reauthenticationUrl, renderPage, securityAttention, type PageContext } from "./pages";
import { AccountApiClient, ApiError } from "./api/client";
import type { Account, Avatar, MutationProof } from "./api/types";
import { translator } from "./i18n";
import { hasUnsavedChanges } from "./draft";

describe("page policies", () => {
  it("retains legacy errorText behavior and correlation IDs when opting into network localization", () => {
    const network = new ApiError(0, { type: "urn:moesegfault:problem:network", title: "Network unavailable", detail: "Unable to reach the identity service.", status: 0 }, "network-id");
    expect(errorText(network, "Fallback")).toBe("Unable to reach the identity service. · ID network-id");
    expect(errorText(network, "Fallback", "Localized network retry")).toBe("Localized network retry · ID network-id");
    expect(errorText(new ApiError(503, { type: "urn:moesegfault:problem:network", title: "Network unavailable", status: 503 }), "Fallback", "Localized network retry")).toBe("Localized network retry");
    const other = new ApiError(503, { type: "urn:test", title: "Unavailable", detail: "Original service detail", status: 503 }, "service-id");
    expect(errorText(other, "Fallback", "Localized network retry")).toBe("Original service detail · ID service-id");
    expect(errorText(new Error("Ordinary error"), "Fallback", "Network")).toBe("Ordinary error");
    expect(errorText(undefined, "Fallback", "Network")).toBe("Fallback");
  });
  it("flags accounts with no login method or no recovery readiness", () => { const base = { password: true, passkey_count: 1, mfa_methods: ["passkey" as const], verified_email_count: 1, verified_mobile_count: 0, recovery_ready: true }; expect(securityAttention(base)).toBe(false); expect(securityAttention({ ...base, recovery_ready: false })).toBe(true); expect(securityAttention({ ...base, password: false, passkey_count: 0 })).toBe(true); });
  it("shows safe correlation IDs on typed errors", () => { expect(errorText(new ApiError(500, { type: "urn:test", title: "Failure", status: 500 }, "abc"))).toBe("Failure · ID abc"); });
});

describe("session mutation network feedback", () => {
  it.each(["zh-CN", "en", "ja"] as const)("localizes actual transport failure in %s and retries only on a new user activation", async (locale) => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new AccountApiClient("https://identity.example.test", transport);
    const refresh = vi.fn(async () => undefined);
    const api = { listSessions: vi.fn(async () => ({ items: [{ session_id: "other", is_current: false, authentication_method: "password", amr: ["pwd"], last_seen_at: "2026-01-01T00:00:00Z" }] })), revokeSession: client.revokeSession.bind(client) } as unknown as AccountApiClient;
    const main = document.createElement("main");
    const t = translator(locale);
    await renderPage("/sessions", main, { api, account: {} as Account, preferences: {} as PageContext["preferences"], csrfToken: "csrf", locale, t, signal: new AbortController().signal, refresh });
    const revoke = main.querySelector<HTMLButtonElement>(".entity-row button")!;
    revoke.click();
    await vi.waitFor(() => expect(main.querySelector('[role="alert"]')?.textContent).toBe(t("networkUnavailable")));
    expect(main.textContent).not.toContain("Unable to reach the identity service.");
    expect(revoke.disabled).toBe(false);
    expect(transport).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    revoke.click();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(transport).toHaveBeenCalledTimes(2);
    expect(main.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("recent-authentication mutation UX", () => {
  const t = (key: string) => ({ reauthenticationBody: "Confirm again", reauthenticate: "Go to Login", unexpectedError: "Unexpected" })[key] ?? key;

  it("offers a localized Login action that returns to the exact current Account page", () => {
    const error = new ApiError(403, { type: "urn:moesegfault:problem:reauthentication_required", title: "Recent authentication required", status: 403, error_code: "reauthentication_required" });
    expect(mutationErrorPresentation(error, t as never, { hostname: "account-staging.moesegfault.dev", pathname: "/security" })).toEqual({
      message: "Confirm again",
      actionLabel: "Go to Login",
      actionHref: "https://login-staging.moesegfault.dev/login?return_uri=https%3A%2F%2Faccount-staging.moesegfault.dev%2Fsecurity",
    });
  });

  it("does not add the reauthentication action for another RFC 9457 code", () => {
    const error = new ApiError(409, { type: "urn:test", title: "Last authenticator", status: 409, error_code: "last_authenticator" });
    expect(mutationErrorPresentation(error, t as never, { hostname: "account.moesegfault.dev", pathname: "/security" })).toEqual({ message: "Last authenticator" });
  });

  it("normalizes unknown Account paths before constructing the strict return URI", () => {
    expect(reauthenticationUrl({ hostname: "account.moesegfault.dev", pathname: "/security/other" })).toBe("https://login.moesegfault.dev/login?return_uri=https%3A%2F%2Faccount.moesegfault.dev%2F");
  });

  it("offers the Login step-up link when adding a password requires recent authentication", async () => {
    const setPassword = vi.fn(async () => { throw new ApiError(403, { type: "urn:moesegfault:problem:reauthentication_required", title: "Recent authentication required", status: 403, error_code: "reauthentication_required" }); });
    const api = {
      getSecurity: vi.fn(async () => ({ password: false, passkey_count: 1, mfa_methods: ["passkey"], verified_email_count: 1, verified_mobile_count: 0, recovery_ready: true })),
      listCredentials: vi.fn(async () => ({ items: [] })),
      setPassword,
    } as unknown as AccountApiClient;
    const main = document.createElement("main");
    const context = {
      api, account: {} as Account, preferences: {} as PageContext["preferences"], csrfToken: "csrf", locale: "en", t: translator("en"),
      signal: new AbortController().signal, refresh: vi.fn(async () => undefined),
    } satisfies PageContext;
    await renderPage("/security", main, context);
    const form = main.querySelector<HTMLFormElement>(".password-form")!;
    form.querySelector<HTMLInputElement>('input[name="password"]')!.value = "a very long new password";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(setPassword).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(form.querySelector<HTMLAnchorElement>(".inline-message a")?.href).toBe(reauthenticationUrl(location)));
    expect(form.querySelector(".inline-message")?.textContent).toContain(translator("en")("reauthenticationBody"));
    expect(context.refresh).not.toHaveBeenCalled();
  });
});

describe("avatar preparation UX", () => {
  it("previews metadata without uploading, then uploads the exact confirmed WebP and disposes it", async () => {
    const prepared = preparedAvatar("blob:prepared-one", "one.webp");
    const fixture = await profileFixture(vi.fn(async () => prepared));
    const input = fixture.main.querySelector<HTMLInputElement>('input[type="file"]')!;

    await chooseFile(input, new File(["source"], "source.png", { type: "image/png" }));

    expect(fixture.uploadAvatar).not.toHaveBeenCalled();
    expect(fixture.main.querySelector<HTMLImageElement>(".avatar-card .avatar")?.src).toBe("blob:prepared-one");
    expect(fixture.main.querySelector(".avatar-details")?.textContent).toContain("1,024 × 1,024 px");
    expect(fixture.main.querySelector(".avatar-details")?.textContent).toContain("2 KiB");
    expect(fixture.main.querySelector<HTMLElement>(".avatar-prepared-actions")?.hidden).toBe(false);

    fixture.main.querySelector<HTMLButtonElement>(".avatar-prepared-actions .primary")!.click();
    await vi.waitFor(() => expect(fixture.uploadAvatar).toHaveBeenCalledOnce());
    expect(fixture.uploadAvatar.mock.calls[0]?.[0]).toBe(prepared.file);
    await vi.waitFor(() => expect(prepared.dispose).toHaveBeenCalledOnce());
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(fixture.refresh).toHaveBeenCalledWith("avatar-saved");
  });

  it("requests canonical acknowledgement after removal and suppresses a late upload after navigation", async () => {
    const prepared = preparedAvatar("blob:late-upload", "late.webp");
    const fixture = await profileFixture(vi.fn(async () => prepared));
    fixture.main.querySelector<HTMLButtonElement>(".avatar-controls .button.danger")!.click();
    await vi.waitFor(() => expect(fixture.refresh).toHaveBeenCalledWith("avatar-saved"));
    fixture.refresh.mockClear();
    let finish!: (avatar: Avatar) => void;
    fixture.uploadAvatar.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await chooseFile(fixture.main.querySelector<HTMLInputElement>('input[type="file"]')!, new File(["source"], "source.png", { type: "image/png" }));
    fixture.main.querySelector<HTMLButtonElement>(".avatar-prepared-actions .primary")!.click();
    fixture.abort.abort();
    finish({ avatar_id: "late", url: "https://avatars.example/late.webp", media_type: "image/webp", width: 1024, height: 1024, updated_at: "2026-01-01T00:00:00Z" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.refresh).not.toHaveBeenCalled();
    expect(fixture.main.querySelector(".avatar-message")?.textContent).toBe("");
    expect(prepared.dispose).toHaveBeenCalledOnce();
  });

  it("disposes previews on reselect, cancel, and page abort", async () => {
    const first = preparedAvatar("blob:first", "first.webp");
    const second = preparedAvatar("blob:second", "second.webp");
    const third = preparedAvatar("blob:third", "third.webp");
    const prepare = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(third);
    const fixture = await profileFixture(prepare);
    const input = fixture.main.querySelector<HTMLInputElement>('input[type="file"]')!;

    await chooseFile(input, new File(["1"], "one.png", { type: "image/png" }));
    await chooseFile(input, new File(["2"], "two.png", { type: "image/png" }));
    expect(first.dispose).toHaveBeenCalledOnce();

    fixture.main.querySelectorAll<HTMLButtonElement>(".avatar-prepared-actions .button")[1]!.click();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(fixture.main.querySelector<HTMLImageElement>(".avatar-card .avatar")?.src).toBe("https://avatars.example/current.webp");

    await chooseFile(input, new File(["3"], "three.png", { type: "image/png" }));
    fixture.abort.abort();
    expect(third.dispose).toHaveBeenCalledOnce();
    expect(fixture.uploadAvatar).not.toHaveBeenCalled();
  });

  it("serializes removal after in-flight preparation and unlocks selection after failure", async () => {
    let resolvePreparation!: (value: ProcessedAvatar) => void;
    const next = preparedAvatar("blob:late", "late.webp");
    const fixture = await profileFixture(() => new Promise((resolve) => { resolvePreparation = resolve; }));
    fixture.deleteAvatar.mockRejectedValueOnce(new Error("delete failed"));
    const input = fixture.main.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "x.png", { type: "image/png" })] });

    input.dispatchEvent(new Event("change"));
    const select = input.closest(".button-row")!.querySelector<HTMLButtonElement>(".button.quiet")!;
    expect(select.disabled).toBe(true);
    const remove = fixture.main.querySelector<HTMLButtonElement>(".avatar-controls .button.danger")!;
    remove.dispatchEvent(new MouseEvent("click"));
    expect(select.disabled).toBe(true);
    expect(fixture.deleteAvatar).not.toHaveBeenCalled();
    resolvePreparation(next);
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    remove.click();
    await vi.waitFor(() => expect(next.dispose).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    expect(fixture.deleteAvatar).toHaveBeenCalledOnce();
    expect(fixture.uploadAvatar).not.toHaveBeenCalled();
  });

  it("formats output sizes and localizes stable processing failures", () => {
    expect(formatAvatarOutput({ edge: 512, outputBytes: 1536, mediaType: "image/webp" }, "en")).toBe("512 × 512 px · 1.5 KiB · WebP");
    expect(formatAvatarOutput({ edge: 512, outputBytes: 2048, mediaType: "image/png" }, "en")).toBe("512 × 512 px · 2 KiB · PNG");
    const t = translator("en");
    expect(avatarPreparationError(new AvatarImageError("INPUT_TOO_LARGE", "large"), t)).toBe(t("avatarTooLarge"));
    expect(avatarPreparationError(new AvatarImageError("UNSUPPORTED_TYPE", "type"), t)).toBe(t("avatarInvalidType"));
    expect(avatarPreparationError(new Error("decoder internals"), t)).toBe(t("avatarProcessingFailed"));
  });
});

describe("profile links editing", () => {
  it("retains newer edits as dirty while requesting canonical session refresh after each save", async () => {
    const fixture = await profileFixture(undefined);
    let finish!: (account: Account) => void;
    fixture.updateMe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const form = fixture.main.querySelector<HTMLFormElement>(".form-card")!;
    const name = form.querySelector<HTMLInputElement>('[name="display_name"]')!;
    name.value = "Submitted";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    name.value = "Typed while saving";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(fixture.updateMe).toHaveBeenCalledOnce();
    finish({} as Account);
    await vi.waitFor(() => expect(form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false));
    expect(name.value).toBe("Typed while saving");
    expect(hasUnsavedChanges(fixture.main)).toBe(true);
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(fixture.refresh).toHaveBeenCalledWith("profile-saved");
    expect(form.querySelector(".inline-message")?.textContent).toBe(translator("en")("savedWithNewChanges"));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(2));
    expect(hasUnsavedChanges(fixture.main)).toBe(false);
  });

  it("localizes an actual profile transport failure, keeps the draft dirty and retries the same values", async () => {
    const fixture = await profileFixture(undefined);
    const client = new AccountApiClient("https://identity.example.test", async () => { throw new TypeError("Failed to fetch"); });
    fixture.updateMe.mockImplementationOnce((patch, proof) => client.updateMe(patch, proof));
    fixture.updatePreferences.mockImplementationOnce((patch, proof) => client.updatePreferences(patch, proof));
    const form = fixture.main.querySelector<HTMLFormElement>(".form-card")!;
    form.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "Unsaved";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(form.querySelector(".inline-message")?.textContent).toContain(translator("en")("networkUnavailable")));
    expect(form.querySelector(".inline-message")?.textContent).toContain(translator("en")("profileSaveUnconfirmed"));
    expect(hasUnsavedChanges(fixture.main)).toBe(true);
    expect(fixture.refresh).not.toHaveBeenCalled();
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fixture.refresh).toHaveBeenCalledWith("profile-saved"));
    expect(fixture.updateMe).toHaveBeenCalledTimes(2);
    expect(fixture.updateMe.mock.calls[1]?.[0]).toMatchObject({ display_name: "Unsaved" });
    expect(hasUnsavedChanges(fixture.main)).toBe(false);
  });
  it("preserves multiple existing links when saving unrelated profile changes", async () => {
    const links = ["https://example.com/about", "https://example.org/projects"];
    const fixture = await profileFixture(undefined, links);
    const form = fixture.main.querySelector<HTMLFormElement>(".form-card")!;
    const field = form.querySelector<HTMLTextAreaElement>('[name="links"]')!;
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.value).toBe(links.join("\n"));
    form.querySelector<HTMLInputElement>('[name="display_name"]')!.value = "New display name";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fixture.updateMe).toHaveBeenCalledOnce());
    expect(fixture.updateMe.mock.calls[0]?.[0]).toMatchObject({ links, display_name: "New display name" });
  });

  it("accepts newline-separated links and allows clearing the whole list", async () => {
    const fixture = await profileFixture(undefined);
    const form = fixture.main.querySelector<HTMLFormElement>(".form-card")!;
    const field = form.querySelector<HTMLTextAreaElement>('[name="links"]')!;
    field.value = " https://example.com \n\n https://example.org ";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fixture.updateMe).toHaveBeenCalledOnce());
    expect(fixture.updateMe.mock.calls[0]?.[0]).toMatchObject({ links: ["https://example.com", "https://example.org"] });
    await vi.waitFor(() => expect(form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false));
    field.value = "";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fixture.updateMe).toHaveBeenCalledTimes(2));
    expect(fixture.updateMe.mock.calls[1]?.[0]).toMatchObject({ links: [] });
  });
});

/** 创建已处理头像替身。Creates a processed-avatar test double. */
function preparedAvatar(previewUrl: string, name: string): ProcessedAvatar & { dispose: ReturnType<typeof vi.fn<() => void>> } {
  const file = new File([new Uint8Array(2048)], name, { type: "image/webp" });
  const dispose = vi.fn<() => void>();
  return {
    file,
    blob: file,
    previewUrl,
    metadata: { inputBytes: 4096, outputBytes: 2048, sourceWidth: 1600, sourceHeight: 900, edge: 1024, mediaType: "image/webp" },
    dispose,
  };
}

/** 渲染可交互的资料页夹具。Renders an interactive profile-page fixture. */
async function profileFixture(prepareAvatar: PageContext["prepareAvatar"], links: string[] = []) {
  const account: Account = {
    principal_id: "principal",
    lifecycle_state: "active",
    profile: { display_name: "Klee", locale: "en", avatar_url: "https://avatars.example/current.webp", links },
    identifiers: [{ identifier_id: "username", kind: "username", value: "klee", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const uploadAvatar = vi.fn<(file: File, proof: MutationProof) => Promise<Avatar>>(async () => ({ avatar_id: "avatar", url: "https://avatars.example/new.webp", media_type: "image/webp", width: 1024, height: 1024, updated_at: "2026-01-01T00:00:00Z" }));
  const deleteAvatar = vi.fn<(proof: MutationProof) => Promise<void>>(async () => undefined);
  const updateMe = vi.fn<AccountApiClient["updateMe"]>(async () => account);
  const updatePreferences = vi.fn<AccountApiClient["updatePreferences"]>(async () => undefined as never);
  const api = {
    listContacts: vi.fn(async () => []),
    uploadAvatar,
    deleteAvatar,
    updateMe,
    updatePreferences,
  } as unknown as AccountApiClient;
  const abort = new AbortController();
  const refresh = vi.fn(async () => undefined);
  const main = document.createElement("main");
  await renderPage("/profile", main, {
    api,
    account,
    preferences: { locale: "en", theme: "system", timezone: "UTC", reduced_motion: false, compact_mode: false, notifications: { security_email: true } },
    csrfToken: "csrf",
    locale: "en",
    t: translator("en"),
    signal: abort.signal,
    refresh,
    prepareAvatar,
  });
  return { main, uploadAvatar, deleteAvatar, updateMe, updatePreferences, refresh, abort };
}

/** 选择文件并等待异步准备完成。Selects a file and waits for asynchronous preparation. */
async function chooseFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change"));
  const actions = input.closest(".avatar-controls")!.querySelector<HTMLElement>(".avatar-prepared-actions")!;
  await vi.waitFor(() => expect(actions.hidden).toBe(false));
}
