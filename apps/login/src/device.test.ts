// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, IdentityApiClient } from "./api/client";
import type { Account, AccountSessionEnvelope } from "./api/types";
import { renderPage } from "./pages";
import { PageLifecycle } from "./page-lifecycle";
import { authRouteHref, deviceContinuation } from "./environment";

const aborts: AbortController[] = [];
afterEach(() => {
  aborts.splice(0).forEach(abort => abort.abort());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fixture(query = "?user_code=ABCD-EFGH", authenticated = true) {
  const href = `https://login-staging.moesegfault.dev/device${query}`;
  vi.stubGlobal("location", new URL(href));
  const account: Account = { principal_id: "principal-klee", lifecycle_state: "active", profile: { display_name: "Klee", locale: "en" }, identifiers: [], created_at: "2026-11-05T00:00:00Z", updated_at: "2026-11-05T00:00:00Z" };
  const session: AccountSessionEnvelope = { account, csrf_token: "session-csrf", csrf_expires_at: "2026-11-05T01:00:00Z" };
  const api = {
    getPrincipal: vi.fn(async () => {
      if (!authenticated) throw new ApiError(401);
      return session;
    }),
    lookupDeviceAuthorization: vi.fn(async () => ({ user_code: "ABCD-EFGH", client_id: "moe-cli", client_name: "moeSegFault CLI", scope: "openid profile", expires_in: 600, state: "pending" as const })),
    decideDeviceAuthorization: vi.fn(async (_code: string, decision: "approve" | "deny") => ({ state: decision === "approve" ? "approved" as const : "denied" as const })),
  } as unknown as IdentityApiClient;
  const abort = new AbortController(); aborts.push(abort);
  const main = document.createElement("main"); document.body.append(main);
  const lifecycle = new PageLifecycle("en");
  await renderPage("/device", main, api, abort.signal, lifecycle);
  const button = (text: string) => [...main.querySelectorAll("button")].find(node => node.textContent === text)!;
  return { main, api, abort, lifecycle, button, session };
}

describe("device browser journey", () => {
  it.each(["approve", "deny"] as const)("reviews a complete URL without granting access, then explicitly chooses %s", async decision => {
    const f = await fixture();
    expect(f.main.textContent).toContain("moeSegFault CLI");
    expect(f.main.textContent).toContain("Klee");
    expect(f.main.textContent).toContain("ABCD-EFGH");
    expect(f.main.textContent).toContain("openid profile");
    expect(f.api.decideDeviceAuthorization).not.toHaveBeenCalled();
    f.lifecycle.relocalize("ja");
    expect(f.main.textContent).toContain("自分が開始したログインか確認");
    expect(f.api.lookupDeviceAuthorization).toHaveBeenCalledOnce();
    f.lifecycle.relocalize("en");
    f.button(decision === "approve" ? "Confirm and allow sign-in" : "Deny sign-in").click();
    await vi.waitFor(() => expect(f.main.textContent).toContain(decision === "approve" ? "Device sign-in approved" : "Sign-in denied"));
    expect(f.api.decideDeviceAuthorization).toHaveBeenCalledWith("ABCD-EFGH", decision, expect.objectContaining({ csrfToken: "session-csrf", signal: f.abort.signal }));
    f.lifecycle.relocalize("zh-CN");
    expect(f.main.querySelector("button")).toBeNull();
    expect(f.api.decideDeviceAuthorization).toHaveBeenCalledOnce();
  });

  it("requires sign-in before lookup and retains only the public code in the continuation", async () => {
    const f = await fixture("?user_code=ABCD-EFGH", false);
    expect(f.api.lookupDeviceAuthorization).not.toHaveBeenCalled();
    expect(f.api.decideDeviceAuthorization).not.toHaveBeenCalled();
    expect(f.main.querySelector("a")?.getAttribute("href")).toBe("/login?device_user_code=ABCD-EFGH");
    const continuation = new URL("https://login-staging.moesegfault.dev/login?device_user_code=ABCD-EFGH&return_uri=https://other.test");
    expect(authRouteHref("/register", { href: continuation.href, hostname: continuation.hostname })).toBe("/register?device_user_code=ABCD-EFGH");
    expect(authRouteHref("/recovery", { href: continuation.href, hostname: continuation.hostname })).toBe("/recovery?device_user_code=ABCD-EFGH");
    expect(deviceContinuation(continuation)).toBe("https://login-staging.moesegfault.dev/device?user_code=ABCD-EFGH");
  });

  it("retains manually entered code through language changes, then looks it up on submit", async () => {
    const f = await fixture("");
    expect(f.api.getPrincipal).not.toHaveBeenCalled();
    const input = f.main.querySelector("input")!;
    input.value = "abcd-efgh"; input.dispatchEvent(new Event("input"));
    f.lifecycle.relocalize("ja");
    expect(f.main.querySelector("input")?.value).toBe("abcd-efgh");
    f.main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(f.api.lookupDeviceAuthorization).toHaveBeenCalledWith("abcd-efgh", expect.objectContaining({ csrfToken: "session-csrf" })));
    expect(f.api.decideDeviceAuthorization).not.toHaveBeenCalled();
  });

  it("returns password sign-in to review instead of implicitly approving the device", async () => {
    const f = await fixture("", false);
    f.abort.abort();
    const assign = vi.fn();
    vi.stubGlobal("location", Object.assign(new URL("https://login-staging.moesegfault.dev/login?device_user_code=ABCD-EFGH"), { assign }));
    f.api.getBrowserContext = vi.fn(async () => ({ csrf_token: "browser-csrf", csrf_expires_at: "later", has_identity_session: false }));
    f.api.authenticateWithPassword = vi.fn(async () => ({ ...f.session, session: {} as never }));
    const abort = new AbortController(); aborts.push(abort);
    await renderPage("/login", f.main, f.api, abort.signal, { locale: "en" });
    f.main.querySelector<HTMLInputElement>('[name="login"]')!.value = "klee";
    f.main.querySelector<HTMLInputElement>('[name="password"]')!.value = "device-journey-password";
    f.main.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("https://login-staging.moesegfault.dev/device?user_code=ABCD-EFGH"));
    expect(f.api.decideDeviceAuthorization).not.toHaveBeenCalled();
  });

  it("offers sign-in again when the session expires before a decision", async () => {
    const f = await fixture();
    vi.mocked(f.api.getPrincipal).mockRejectedValueOnce(new ApiError(401, {
      type: "urn:moesegfault:problem:login_required", title: "Sign-in required", status: 401,
      detail: "Your session expired", error_code: "login_required", correlation_id: "expired-session-correlation",
    }));
    f.button("Confirm and allow sign-in").click();
    await vi.waitFor(() => expect(f.main.querySelector("a")?.getAttribute("href")).toBe("/login?device_user_code=ABCD-EFGH"));
    expect(f.api.decideDeviceAuthorization).not.toHaveBeenCalled();
    expect(f.main.textContent).toContain("Your session expired");
    expect(f.main.textContent).toContain("expired-session-correlation");
    expect(f.main.querySelector("button")).toBeNull();
  });

  it("does not authorize a different account after another tab changes the shared session", async () => {
    const f = await fixture();
    vi.mocked(f.api.getPrincipal).mockResolvedValueOnce({ ...f.session, account: { ...f.session.account, principal_id: "other-account" }, csrf_token: "other-csrf" });
    f.button("Confirm and allow sign-in").click();
    await vi.waitFor(() => expect(f.main.textContent).toContain("The signed-in account changed"));
    expect(f.api.decideDeviceAuthorization).not.toHaveBeenCalled();
    expect(f.main.querySelector("input")?.value).toBe("ABCD-EFGH");
  });

  it("expires the confirmation without polling or allowing a late decision", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.main.textContent).toContain("Device request expired");
    expect(f.button("Confirm and allow sign-in").disabled).toBe(true);
    expect(f.button("Deny sign-in").disabled).toBe(true);
    expect(f.api.lookupDeviceAuthorization).toHaveBeenCalledOnce();
    expect(f.api.decideDeviceAuthorization).not.toHaveBeenCalled();
    f.abort.abort(); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an unresolved decision single-owned and cannot project it into a later route", async () => {
    const f = await fixture();
    let resolve!: (result: { state: "approved" }) => void;
    vi.mocked(f.api.decideDeviceAuthorization).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.button("Confirm and allow sign-in").click();
    await vi.waitFor(() => expect(f.api.decideDeviceAuthorization).toHaveBeenCalledOnce());
    expect(f.button("Deny sign-in").disabled).toBe(true);
    f.lifecycle.relocalize("ja");
    f.abort.abort(); f.main.textContent = "Next route";
    resolve({ state: "approved" });
    await new Promise(done => setTimeout(done, 0));
    expect(f.main.textContent).toBe("Next route");
    expect(f.api.decideDeviceAuthorization).toHaveBeenCalledOnce();
  });
});
