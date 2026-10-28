import { describe, expect, it } from "vitest";
import { messageSchema } from "./message";
import { providerCode } from "./outbox";
import { renderEmail } from "./templates";

const verification = { service: "identity", sender: "identity", to: "person@example.com", template: "verification", code: "12345678", expires_at: 1793180000 };

describe("notification contract", () => {
  it("normalizes one outbound sender identity and defaults locale", () => {
    const message = messageSchema.parse(verification);
    expect(message.locale).toBe("en");
    expect(renderEmail(message, "event-1").from.email).toBe("identity@moesegfault.dev");
  });
  it("accepts new sender names without provisioning a mailbox", () => {
    for (const sender of ["accounts", "security", "indentity", "build-bot", "service.notify"]) {
      expect(messageSchema.safeParse({ ...verification, sender }).success).toBe(true);
    }
  });
  it("rejects foreign addresses, malformed identities, header injection, and arbitrary HTML", () => {
    for (const sender of ["admin@elsewhere.dev", "../security", " root", "Root", "foo..bar", "x\r\nBcc: victim@example.com"]) {
      expect(messageSchema.safeParse({ ...verification, sender }).success).toBe(false);
    }
    expect(messageSchema.safeParse({ ...verification, subject: "safe\r\nBcc: victim@example.com" }).success).toBe(false);
    expect(messageSchema.safeParse({ ...verification, html: "<script>evil()</script>" }).success).toBe(false);
  });
  it("requires the scenario inputs used by the rendered email", () => {
    expect(messageSchema.safeParse({ ...verification, code: undefined }).success).toBe(false);
    expect(messageSchema.safeParse({ ...verification, expires_at: undefined }).success).toBe(false);
    expect(messageSchema.safeParse({ service: "accounts", sender: "accounts", to: "person@example.com", template: "notification" }).success).toBe(false);
    expect(messageSchema.safeParse({ ...verification, template: "decision", title: "Choose", body: "A choice" }).success).toBe(false);
  });
  it("accepts a minimal decision invitation without redundant body copy", () => {
    const message = messageSchema.parse({ service: "accounts", sender: "accounts", to: "person@example.com", template: "decision",
      title: "Choose your next step", action: { label: "Open", url: "https://decisions.moesegfault.dev/d/opaque" } });
    const email = renderEmail(message, "decision-1");
    expect(email.html).toContain("Choose your next step");
    expect(email.html).not.toContain("Enter this code");
    expect(email.html).toContain("https://decisions.moesegfault.dev/d/opaque");
  });
  it("rejects active and credential-bearing action URLs", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,hello", "http://localhost:8080/", "https://user:secret@example.com/"]) {
      expect(messageSchema.safeParse({ ...verification, action: { label: "Open", url } }).success).toBe(false);
    }
  });
  it("retains only syntactically bounded provider codes", () => {
    expect(providerCode({ code: "E_RECIPIENT_SUPPRESSED" })).toBe("E_RECIPIENT_SUPPRESSED");
    for (const error of [null, "secret", { code: "person@example.com" }, { code: "E_\n12345678" }]) {
      expect(providerCode(error)).toBe("provider_exception");
    }
  });
});

describe("branded email", () => {
  it("provides localized HTML and readable plain text without external assets", () => {
    for (const locale of ["en", "zh-CN", "ja"] as const) {
      const email = renderEmail(messageSchema.parse({ ...verification, locale }), "event-1");
      expect(email.html).toContain(`lang="${locale}"`);
      expect(email.html).toContain("12345678");
      expect(email.text).toContain("12345678");
      expect(email.text).toContain("UTC");
      expect(email.html).not.toMatch(/<script|<img|<link|@import/i);
      expect(email.headers["X-moeSegFault-Notification-ID"]).toBe("event-1");
    }
  });
  it("escapes hostile user text in all non-verification scenarios", () => {
    const hostile = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>';
    for (const template of ["notification", "decision", "security"] as const) {
      const email = renderEmail(messageSchema.parse({ service: "accounts", sender: "accounts", to: "person@example.com", template,
        title: hostile, body: `${hostile}\nSecond line`, action: { label: hostile, url: "https://decisions.moesegfault.dev/d/opaque?a=1&b=2" } }), "event-2");
      expect(email.html).not.toContain("<img");
      expect(email.html).not.toContain("<script>");
      expect(email.html).toContain("&lt;img");
      expect(email.html).toContain("Second line");
      expect(email.html).toContain("?a=1&amp;b=2");
      expect(email.text).toContain(hostile);
      expect(email.subject).toBe(hostile);
    }
  });
  it("never includes irrelevant verification codes in other scenarios", () => {
    const email = renderEmail(messageSchema.parse({ ...verification, template: "security", title: "Password changed", body: "Review your account." }), "event-3");
    expect(email.html).not.toContain("12345678");
    expect(email.text).not.toContain("12345678");
  });
});
