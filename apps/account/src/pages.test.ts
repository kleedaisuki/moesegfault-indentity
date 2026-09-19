// @vitest-environment happy-dom

import { AvatarImageError, type ProcessedAvatar } from "@moesegfault/frontend-shared";
import { describe, expect, it, vi } from "vitest";
import { avatarPreparationError, errorText, formatAvatarOutput, mutationErrorPresentation, reauthenticationUrl, renderPage, securityAttention, type PageContext } from "./pages";
import { AccountApiClient, ApiError } from "./api/client";
import type { Account, Avatar, MutationProof } from "./api/types";
import { translator } from "./i18n";

describe("page policies", () => {
  it("flags accounts with no login method or no recovery readiness", () => { const base = { password: true, passkey_count: 1, mfa_methods: ["passkey" as const], verified_email_count: 1, verified_mobile_count: 0, recovery_ready: true }; expect(securityAttention(base)).toBe(false); expect(securityAttention({ ...base, recovery_ready: false })).toBe(true); expect(securityAttention({ ...base, password: false, passkey_count: 0 })).toBe(true); });
  it("shows safe correlation IDs on typed errors", () => { expect(errorText(new ApiError(500, { type: "urn:test", title: "Failure", status: 500 }, "abc"))).toBe("Failure · ID abc"); });
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

  it("unlocks selection when removing the current avatar cancels in-flight preparation", async () => {
    let resolvePreparation!: (value: ProcessedAvatar) => void;
    const next = preparedAvatar("blob:late", "late.webp");
    const fixture = await profileFixture(() => new Promise((resolve) => { resolvePreparation = resolve; }));
    fixture.deleteAvatar.mockRejectedValueOnce(new Error("delete failed"));
    const input = fixture.main.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "x.png", { type: "image/png" })] });

    input.dispatchEvent(new Event("change"));
    const select = input.closest(".button-row")!.querySelector<HTMLButtonElement>(".button.quiet")!;
    expect(select.disabled).toBe(true);
    fixture.main.querySelector<HTMLButtonElement>(".avatar-controls .button.danger")!.click();
    expect(select.disabled).toBe(false);

    resolvePreparation(next);
    await vi.waitFor(() => expect(next.dispose).toHaveBeenCalledOnce());
    expect(fixture.uploadAvatar).not.toHaveBeenCalled();
  });

  it("formats output sizes and localizes stable processing failures", () => {
    expect(formatAvatarOutput({ edge: 512, outputBytes: 1536 }, "en")).toBe("512 × 512 px · 1.5 KiB · WebP");
    const t = translator("en");
    expect(avatarPreparationError(new AvatarImageError("INPUT_TOO_LARGE", "large"), t)).toBe(t("avatarTooLarge"));
    expect(avatarPreparationError(new AvatarImageError("UNSUPPORTED_TYPE", "type"), t)).toBe(t("avatarInvalidType"));
    expect(avatarPreparationError(new Error("decoder internals"), t)).toBe(t("avatarProcessingFailed"));
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
async function profileFixture(prepareAvatar: PageContext["prepareAvatar"]) {
  const account: Account = {
    principal_id: "principal",
    lifecycle_state: "active",
    profile: { display_name: "Klee", locale: "en", avatar_url: "https://avatars.example/current.webp" },
    identifiers: [{ identifier_id: "username", kind: "username", value: "klee", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const uploadAvatar = vi.fn<(file: File, proof: MutationProof) => Promise<Avatar>>(async () => ({ avatar_id: "avatar", url: "https://avatars.example/new.webp", media_type: "image/webp", width: 1024, height: 1024, updated_at: "2026-01-01T00:00:00Z" }));
  const deleteAvatar = vi.fn<(proof: MutationProof) => Promise<void>>(async () => undefined);
  const api = {
    listContacts: vi.fn(async () => []),
    uploadAvatar,
    deleteAvatar,
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
  return { main, uploadAvatar, deleteAvatar, refresh, abort };
}

/** 选择文件并等待异步准备完成。Selects a file and waits for asynchronous preparation. */
async function chooseFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change"));
  const actions = input.closest(".avatar-controls")!.querySelector<HTMLElement>(".avatar-prepared-actions")!;
  await vi.waitFor(() => expect(actions.hidden).toBe(false));
}
