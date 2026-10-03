// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { AccountApiClient, type FetchLike } from "./api/client";
import type { Session } from "./api/types";
import { translator } from "./i18n";
import { renderPage, type PageContext } from "./pages";
import { formatTime } from "./ui/dom";

const revokedAt = "2026-10-03T12:00:00Z";

describe("device sign-out", () => {
  it("renders retained revoked history without another sign-out action", async () => {
    const fixture = await sessionsFixture([
      session("current", { is_current: true }),
      session("active"),
      session("revoked", { revoked_at: revokedAt }),
    ]);
    const rows = fixture.main.querySelectorAll(".entity-row");
    expect(rows[0]?.textContent).toContain("当前设备");
    expect(rows[0]?.querySelector("button")).toBeNull();
    expect(rows[1]?.querySelector("button")?.textContent).toBe("退出此设备");
    expect(rows[2]?.textContent).toContain("已退出");
    expect(rows[2]?.textContent).toContain(formatTime(revokedAt, "zh-CN"));
    expect(rows[2]?.querySelector("button")).toBeNull();
  });

  it("changes the device to signed out after a real client DELETE and history reload", async () => {
    const fixture = await sessionsFixture([session("current", { is_current: true }), session("remote")]);
    const button = fixture.main.querySelector<HTMLButtonElement>("button")!;
    button.click();
    button.click();
    expect(button.disabled).toBe(true);
    await vi.waitFor(() => expect(fixture.refresh).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fixture.main.textContent).toContain("已退出"));
    expect(fixture.main.querySelector("button")).toBeNull();

    const mutations = fixture.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(mutations).toHaveLength(1);
    const [url, init] = mutations[0]!;
    expect(String(url)).toBe("https://identity.example/v1/principals/self/sessions/remote");
    expect(init).toMatchObject({ credentials: "include", cache: "no-store" });
    const headers = init?.headers as Headers;
    expect(headers.get("x-moesegfault-csrf")).toBe("csrf");
    expect(headers.get("idempotency-key")).toBeTruthy();

    await fixture.refresh();
    expect(fixture.main.textContent).toContain("已退出");
    expect(fixture.main.querySelector("button")).toBeNull();
  });

  it("keeps an unsuccessful device action retryable and displays its error", async () => {
    const fixture = await sessionsFixture([session("remote")]);
    fixture.fetch.mockRejectedValueOnce(new TypeError("offline"));
    const button = fixture.main.querySelector<HTMLButtonElement>("button")!;
    button.click();
    await vi.waitFor(() => expect(fixture.main.querySelector('[role="alert"]')?.textContent).toContain("Unable to reach"));
    expect(button.disabled).toBe(false);
    expect(fixture.refresh).not.toHaveBeenCalled();
    expect(fixture.main.textContent).not.toContain("已退出");

    button.click();
    await vi.waitFor(() => expect(fixture.main.textContent).toContain("已退出"));
    expect(fixture.main.querySelector('[role="alert"]')).toBeNull();
  });

  it("still allows sign-out when an older response omits revoked_at", async () => {
    const legacy = session("legacy");
    delete legacy.revoked_at;
    const fixture = await sessionsFixture([legacy]);
    expect(fixture.main.querySelector("button")?.textContent).toBe("退出此设备");
  });
});

/** Builds a wire session, including the optional retained-history field. */
function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    session_id: id, authentication_method: "password", amr: ["pwd"], acr: "password",
    last_seen_at: "2026-10-03T10:00:00Z", authenticated_at: "2026-10-01T10:00:00Z",
    expires_at: "2026-11-01T10:00:00Z", is_current: false, revoked_at: null, ...patch,
  };
}

/** Exercises DOM clicks through the real API client; DELETE retains revoked history like Identity. */
async function sessionsFixture(items: ReturnType<typeof session>[]) {
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (init?.method === "DELETE") {
      const id = decodeURIComponent(new URL(String(url)).pathname.split("/").at(-1)!);
      items = items.map((item) => item.session_id === id ? { ...item, revoked_at: revokedAt } : item);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ items }), { headers: { "content-type": "application/json" } });
  });
  const main = document.createElement("main");
  const refresh = vi.fn(async () => renderPage("/sessions", main, context));
  const context: PageContext = {
    api: new AccountApiClient("https://identity.example", fetch),
    account: {} as PageContext["account"], preferences: {} as PageContext["preferences"],
    csrfToken: "csrf", locale: "zh-CN", t: translator("zh-CN"),
    signal: new AbortController().signal, refresh,
  };
  await renderPage("/sessions", main, context);
  return { main, fetch, refresh };
}
