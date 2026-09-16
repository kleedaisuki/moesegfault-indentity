import { describe, expect, it } from "vitest";
import { authenticatedSession, type AccountSession } from "./session";

const account = {
  principal_id: "principal", lifecycle_state: "active" as const,
  profile: { display_name: "Klee", locale: "zh-CN" }, identifiers: [],
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};
const preferences = { locale: "zh-CN" as const, theme: "system" as const, timezone: "Asia/Shanghai", reduced_motion: false, compact_mode: false, notifications: { security_email: true } };

describe("AccountSession", () => {
  it("assembles account, preferences, and CSRF as one authenticated state", () => {
    const session = authenticatedSession({ account, csrf_token: "csrf", csrf_expires_at: "2026-01-01T01:00:00Z" }, preferences);
    expect(session).toEqual({ status: "authenticated", account, preferences, csrfToken: "csrf" });
  });

  it("represents pending and anonymous states without misleading user data", () => {
    const states: AccountSession[] = [{ status: "pending" }, { status: "anonymous" }];
    expect(states.every((state) => !("account" in state) && !("csrfToken" in state))).toBe(true);
  });
});
