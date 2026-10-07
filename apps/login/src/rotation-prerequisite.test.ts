// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityApiClient } from "./api/client";
import { renderPage } from "./pages";
import { translate, type Locale } from "./i18n";

const execute = vi.hoisted(() => vi.fn(async (action: (controls: unknown) => Promise<unknown>) => action({ csrfToken: "synthetic", idempotencyKey: "synthetic" })));
vi.mock("./step-up", () => ({ InlineStepUpCoordinator: class { execute = execute; } }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

/** Use server-list and mutation seams; there are no platform requests or real recovery codes. */
async function fixture(locale: Locale = "en", target = "https://account-staging.moesegfault.dev/security") {
  vi.stubGlobal("location", { hostname: "login-staging.moesegfault.dev", href: `https://login-staging.moesegfault.dev/recovery-codes/rotate?return_uri=${encodeURIComponent(target)}` });
  const list = vi.fn<IdentityApiClient["listAuthenticators"]>(async () => ({ items: [] }));
  const rotate = vi.fn(async () => ({ recovery_codes: ["synthetic-code"] }));
  const api = { getPrincipal: vi.fn(async () => ({ csrf_token: "synthetic", account: { principal_id: "expected", identifiers: [] } })), listAuthenticators: list, rotateRecoveryCodes: rotate } as unknown as IdentityApiClient;
  const main = document.createElement("main"); document.body.append(main);
  const abort = new AbortController();
  await renderPage("/recovery-codes/rotate", main, api, abort.signal, { locale });
  const button = main.querySelector<HTMLButtonElement>("button")!;
  return { main, list, rotate, button, abort };
}

describe("recovery rotation Passkey prerequisite", () => {
  it.each(["zh-CN", "en", "ja"] as const)("offers bootstrap rather than an impossible chooser in %s", async locale => {
    const f = await fixture(locale); f.button.click();
    await vi.waitFor(() => expect(f.main.textContent).toContain(translate(locale, "recoveryNeedsPasskey")));
    expect(f.button.disabled).toBe(false);
    expect(execute).not.toHaveBeenCalled(); expect(f.rotate).not.toHaveBeenCalled();
    const enroll = f.main.querySelector<HTMLAnchorElement>('a[href^="/passkey/enroll"]')!;
    expect(enroll.textContent).toBe(translate(locale, "enroll"));
    expect(new URL(enroll.getAttribute("href")!, "https://login-staging.moesegfault.dev").searchParams.get("return_uri")).toBe("https://account-staging.moesegfault.dev/security");
    expect(f.main.querySelector('a[href="https://account-staging.moesegfault.dev/security"]')).not.toBeNull();
    expect(f.list).toHaveBeenCalledExactlyOnceWith(f.abort.signal);
  });

  it("does not treat revoked keys as usable", async () => {
    const f = await fixture(); f.list.mockResolvedValueOnce({ items: [{ revoked_at: "2026-10-07T00:00:00Z" } as never] });
    f.button.click(); await vi.waitFor(() => expect(f.button.disabled).toBe(false));
    expect(f.main.textContent).toContain(translate("en", "recoveryNeedsPasskeyTitle"));
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps the existing step-up path for any active key without weakening server policy", async () => {
    const f = await fixture(); f.list.mockResolvedValueOnce({ items: [{ revoked_at: "revoked" } as never, { revoked_at: null } as never] });
    f.button.click(); await vi.waitFor(() => expect(f.rotate).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledOnce();
    expect(f.main.textContent).toContain("synthetic-code");
  });

  it("does not infer missing Passkeys from list failure and permits an explicit retry", async () => {
    const f = await fixture(); f.list.mockRejectedValueOnce(new Error("Synthetic list unavailable"));
    f.button.click(); await vi.waitFor(() => expect(f.main.textContent).toContain("Synthetic list unavailable"));
    expect(f.main.textContent).not.toContain(translate("en", "recoveryNeedsPasskeyTitle"));
    expect(f.button.disabled).toBe(false); expect(execute).not.toHaveBeenCalled();
    f.button.click(); await vi.waitFor(() => expect(f.main.textContent).toContain(translate("en", "recoveryNeedsPasskeyTitle")));
    expect(f.list).toHaveBeenCalledTimes(2); expect(f.rotate).not.toHaveBeenCalled();
  });

  it("locks duplicate checks and suppresses a late active-key reply after navigation abort", async () => {
    const f = await fixture(); let resolve!: (value: { items: never[] }) => void;
    f.list.mockReturnValueOnce(new Promise(ok => { resolve = ok; }));
    f.button.click(); f.button.dispatchEvent(new Event("click")); await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    f.abort.abort(); f.main.replaceChildren(document.createTextNode("Next route"));
    resolve({ items: [{} as never] }); await new Promise(ok => setTimeout(ok, 0));
    expect(execute).not.toHaveBeenCalled(); expect(f.rotate).not.toHaveBeenCalled(); expect(f.main.textContent).toBe("Next route");
  });

  it("never propagates an unsafe return destination into the bootstrap link", async () => {
    const f = await fixture("en", "https://evil.example/security?secret=synthetic");
    f.button.click(); await vi.waitFor(() => expect(f.main.querySelector('a[href="/passkey/enroll"]')).not.toBeNull());
    expect(f.main.querySelector('a[href="https://account-staging.moesegfault.dev"]')).not.toBeNull();
  });
});
