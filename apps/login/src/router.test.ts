// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { installRouter, isAppRoute, resolveRoute } from "./router";
import { captureAndScrubTransaction, currentTransaction } from "./transaction";

describe("login router", () => {
  it("keeps account management out of the Login application", () => {
    expect(isAppRoute("/account")).toBe(false);
    expect(isAppRoute("/manage/passkeys")).toBe(false);
    expect(resolveRoute("/account/security")).toBe("/login");
  });

  it("recognizes only narrow account-initiated ceremonies", () => {
    expect(resolveRoute("/passkey/enroll")).toBe("/passkey/enroll");
    expect(resolveRoute("/recovery-codes/rotate/")).toBe("/recovery-codes/rotate");
  });

  it("preserves the scrubbed OAuth handle when following the registration link", () => {
    const href = "https://login-staging.moesegfault.dev/login?tx=oauth-fixture";
    vi.stubGlobal("location", { href, origin: "https://login-staging.moesegfault.dev", pathname: "/login", search: "?tx=oauth-fixture", hash: "" });
    const pushState = vi.spyOn(history, "pushState").mockImplementation(() => {});
    const documentListener = vi.spyOn(document, "addEventListener");
    const windowListener = vi.spyOn(window, "addEventListener");
    const render = vi.fn();
    captureAndScrubTransaction(location, { state: null, replaceState: vi.fn() } as unknown as History);
    installRouter(render);
    const anchor = document.createElement("a");
    anchor.href = "https://login-staging.moesegfault.dev/register";
    document.body.append(anchor);
    try {
      const event = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
      anchor.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(pushState).toHaveBeenCalledWith(null, "", "/register");
      expect(render).toHaveBeenCalledWith("/register");
      expect(currentTransaction()).toBe("oauth-fixture");
    } finally {
      for (const [type, listener] of documentListener.mock.calls) document.removeEventListener(type, listener);
      for (const [type, listener] of windowListener.mock.calls) window.removeEventListener(type, listener);
      anchor.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
