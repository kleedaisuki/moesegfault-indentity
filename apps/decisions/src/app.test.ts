import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptJson, encryptJson, sha256 } from "@moesegfault/service-platform";
import { privateApp, publicApp } from "./app";
import { decisionSchema, type DecisionRow, type Env } from "./model";

const key = btoa("x".repeat(32));
const token = "a".repeat(43);
const origin = "https://decisions.example.com";
const input = decisionSchema.parse({ service: "accounts", sender: "accounts", to: "user@example.com", title: "Respond", expires_at: 2000000000, callback: { binding: "CALLBACK", path: "/v1/results" }, choices: [{ value: "yes", label: "Yes" }] });
let row: DecisionRow;
const bind = vi.fn();
const first = vi.fn();
const batch = vi.fn();
const db = { prepare: vi.fn(() => ({ bind, first })), batch };
const env = { DB: db, OUTBOX_KEY: key, PUBLIC_ORIGIN: origin, CALLBACK_SERVICES: "{}" } as unknown as Env;

beforeEach(async () => {
  vi.clearAllMocks();
  bind.mockReturnValue({ bind, first });
  row = { decision_id: "decision-test", service: "accounts", request_digest: "digest", token_digest: await sha256(token), payload: await encryptJson(key, { input, token }, "decision-test"), state: "pending", expires_at: 2000000000, submitted_at: null };
  first.mockResolvedValue(row);
});

describe("public decision journey boundaries", () => {
  it("never exposes the private create API", async () => {
    const response = await publicApp.request(`${origin}/v1/decisions`, { method: "POST" }, env);
    expect(response.status).toBe(404);
    expect(db.prepare).not.toHaveBeenCalled();
  });
  it("GET renders a separate confirm button without writing decision state", async () => {
    const response = await publicApp.request(`${origin}/d/${token}`, undefined, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/__Host-decision-.*HttpOnly.*Secure.*SameSite=Strict/);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(batch).not.toHaveBeenCalled();
    const body = await response.text();
    expect(body).toContain('type="submit">Confirm and submit');
    const csrf = /name="csrf" value="([^"]+)"/.exec(body)?.[1];
    expect(csrf).toBeTruthy();
    const proof = await decryptJson<{ decision_id: string; nonce: string }>(key, csrf!, "decision-csrf");
    expect(proof.decision_id).toBe(row.decision_id);
    expect(response.headers.get("set-cookie")).toContain(proof.nonce);
  });
  it("rejects cross-origin submissions before accessing D1", async () => {
    const response = await publicApp.request(`${origin}/d/${token}/submit`, { method: "POST", headers: { origin: "https://evil.example" } }, env);
    expect(response.status).toBe(403);
    expect(db.prepare).not.toHaveBeenCalled();
  });
  it("rejects forged or missing browser confirmation proof before mutation", async () => {
    const response = await publicApp.request(`${origin}/d/${token}/submit`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "choice=yes&csrf=forged" }, env);
    expect(response.status).toBe(403);
    expect(batch).not.toHaveBeenCalled();
  });
  it("does not render response form for expired or submitted capabilities", async () => {
    row.expires_at = 1;
    const expired = await publicApp.request(`${origin}/d/${token}`, undefined, env);
    expect(expired.status).toBe(410);
    row.state = "submitted";
    const submitted = await publicApp.request(`${origin}/d/${token}`, undefined, env);
    expect(await submitted.text()).toContain("Response submitted");
    expect(batch).not.toHaveBeenCalled();
  });
  it("applies secure headers to private idempotency errors too", async () => {
    const response = await privateApp.request("https://decisions.internal/v1/decisions", { method: "POST" }, env);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-moesegfault-correlation-id")).toBeTruthy();
  });
});
