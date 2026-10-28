import { describe, expect, it } from "vitest";
import { invitationJson, snapshotInvitation } from "./invitation";
import { decisionSchema, resolveDecision } from "./model";

const createdAt = 1_800_000_000;
const day = 86400;
const request = decisionSchema.parse({ service: "accounts", sender: "accounts", to: "user@example.com", title: "Review",
  callback: { binding: "ACCOUNTS", path: "/v1/results" }, choices: [{ value: "yes", label: "Yes" }] });

describe("business decision deadlines", () => {
  it("resolves an omitted deadline once to seven days without changing request identity", () => {
    const before = JSON.stringify(request);
    expect(request.expires_at).toBeUndefined();
    expect(resolveDecision(request, createdAt).expires_at).toBe(createdAt + 7 * day);
    expect(JSON.stringify(request)).toBe(before);
    expect(resolveDecision(request, createdAt + 100).expires_at).toBe(createdAt + 100 + 7 * day);
  });
  it("accepts explicit business deadlines independently of delivery horizon", () => {
    for (const days of [30, 90, 365]) {
      const input = resolveDecision({ ...request, expires_at: createdAt + days * day }, createdAt);
      const message = JSON.parse(snapshotInvitation(input, "token", "https://decisions.example.test", createdAt));
      expect(input.expires_at).toBe(createdAt + days * day);
      expect(message.expires_at).toBe(createdAt + 7 * day);
      expect(message.action.expires_at).toBe(input.expires_at);
    }
    const soon = resolveDecision({ ...request, expires_at: createdAt + day }, createdAt);
    expect(JSON.parse(snapshotInvitation(soon, "token", "https://decisions.example.test", createdAt)).expires_at).toBe(soon.expires_at);
  });
  it("rejects expired deadlines and millisecond accidents but allows an operator-raised ceiling", () => {
    expect(() => resolveDecision({ ...request, expires_at: createdAt }, createdAt)).toThrow("invalid_expiry");
    expect(() => resolveDecision({ ...request, expires_at: createdAt + 366 * day }, createdAt)).toThrow("invalid_expiry");
    expect(() => resolveDecision({ ...request, expires_at: createdAt * 1000 }, createdAt)).toThrow("invalid_expiry");
    expect(resolveDecision({ ...request, expires_at: createdAt + 730 * day }, createdAt, String(730 * day)).expires_at).toBe(createdAt + 730 * day);
    expect(() => resolveDecision(request, createdAt, "invalid")).toThrow("invalid_decision_lifetime_configuration");
  });
});

describe("immutable invitation compatibility", () => {
  it("reuses the new snapshot without regenerating its deadline or origin", () => {
    const input = resolveDecision({ ...request, expires_at: createdAt + 90 * day }, createdAt);
    const notification_json = snapshotInvitation(input, "token", "https://decisions.example.test", createdAt);
    expect(invitationJson({ input, token: "token", notification_json }, "https://changed.example.test")).toBe(notification_json);
  });
  it("reconstructs exactly the legacy outbound JSON with no new action field", () => {
    const input = resolveDecision({ ...request, body: "Please review", locale: "zh-CN", expires_at: createdAt + day }, createdAt);
    const expected = JSON.stringify({ service: input.service, sender: input.sender, to: input.to, template: "decision", locale: input.locale,
      title: input.title, body: input.body, expires_at: input.expires_at,
      action: { label: "查看并回复", url: "https://decisions.example.test/d/token" } });
    expect(invitationJson({ input, token: "token" }, "https://decisions.example.test")).toBe(expected);
  });
});
