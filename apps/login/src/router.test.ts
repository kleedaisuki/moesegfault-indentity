import { describe, expect, it } from "vitest";
import { isAppRoute, resolveRoute } from "./router";

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
});
