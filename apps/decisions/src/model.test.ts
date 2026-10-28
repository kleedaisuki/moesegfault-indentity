import { describe, expect, it } from "vitest";
import { callbackTarget, decisionSchema, parseSubmission, randomToken, resolveDecision, type DecisionInput, type Env } from "./model";
import { decisionPage } from "./pages";

const sample = (): DecisionInput => resolveDecision(decisionSchema.parse({ service: "accounts", sender: "accounts", to: "user@example.com", title: "Choose a meeting", expires_at: 1800000000, callback: { binding: "ACCOUNTS", path: "/v1/results" }, choices: [{ value: "accept", label: "Accept" }, { value: "decline", label: "Decline" }], fields: [{ name: "note", label: "Note", type: "textarea" }] }), 1799990000);

describe("decision contracts", () => {
  it("requires a response surface and unique field / option names", () => {
    expect(decisionSchema.safeParse({ ...sample(), choices: undefined, fields: undefined }).success).toBe(false);
    expect(decisionSchema.safeParse({ ...sample(), fields: [{ name: "csrf", label: "Bad", type: "text" }] }).success).toBe(false);
    expect(decisionSchema.safeParse({ ...sample(), choices: [{ value: "yes", label: "A" }, { value: "yes", label: "B" }] }).success).toBe(false);
    expect(decisionSchema.safeParse({ ...sample(), fields: [{ name: "a", label: "A", type: "select" }] }).success).toBe(false);
    for (const title of ["A\nB", "A\rB", "A\u0000B"]) expect(decisionSchema.safeParse({ ...sample(), title }).success).toBe(false);
  });
  it("rejects arbitrary callbacks and deployment registration mismatch", () => {
    expect(decisionSchema.safeParse({ ...sample(), callback: { binding: "ACCOUNTS", path: "https://attacker.example/" } }).success).toBe(false);
    const target = { fetch: (): Promise<Response> => Promise.resolve(new Response()) };
    const env = { CALLBACK_SERVICES: JSON.stringify({ accounts: { binding: "ACCOUNTS", paths: ["/v1/results"] } }), ACCOUNTS: target } as unknown as Env;
    expect(callbackTarget(env, sample())).toBe(target);
    expect(callbackTarget(env, { ...sample(), service: "security" })).toBe(null);
    expect(callbackTarget(env, { ...sample(), callback: { binding: "ACCOUNTS", path: "/v1/admin" } })).toBe(null);
  });
  it("allows only declared response choices, fields and single values", () => {
    const form = new FormData(); form.set("choice", "accept"); form.set("note", "Hello");
    expect(parseSubmission(sample(), form)).toEqual({ choice: "accept", fields: { note: "Hello" } });
    form.set("choice", "invented"); expect(() => parseSubmission(sample(), form)).toThrow("invalid_choice");
    form.set("choice", "accept"); form.set("extra", "no"); expect(() => parseSubmission(sample(), form)).toThrow("invalid_field");
    form.delete("extra"); form.append("note", "Second"); expect(() => parseSubmission(sample(), form)).toThrow("invalid_field");
  });
  it("validates typed required fields and uses booleans/numbers in callbacks", () => {
    const input = decisionSchema.parse({ ...sample(), choices: undefined, fields: [{ name: "terms", label: "Agree", type: "checkbox", required: true }, { name: "count", label: "Count", type: "number", required: true }] });
    const form = new FormData(); form.set("count", "1");
    expect(() => parseSubmission(input, form)).toThrow("required_field");
    form.set("terms", "on"); form.set("count", "NaN"); expect(() => parseSubmission(input, form)).toThrow("invalid_number");
    form.set("count", "12.5"); expect(parseSubmission(input, form)).toEqual({ fields: { terms: true, count: 12.5 } });
  });
  it("escapes all caller-controlled HTML and has an explicit submit button", () => {
    const input = { ...sample(), title: '<img src=x onerror="alert(1)">', body: "<script>bad</script>" };
    const html = decisionPage(input, "a".repeat(43), "csrf-token");
    expect(html).not.toContain("<img"); expect(html).not.toContain("<script>");
    expect(html).toContain('type="submit">Confirm and submit');
    expect(html).not.toContain("onchange"); expect(html).not.toContain("onclick");
    expect(html).toContain('name="csrf" value="csrf-token"');
  });
  it("generates 256-bit URL capabilities without predictable characters", () => {
    const tokens = Array.from({ length: 100 }, () => randomToken());
    expect(tokens.every((token) => /^[A-Za-z0-9_-]{43}$/.test(token))).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
