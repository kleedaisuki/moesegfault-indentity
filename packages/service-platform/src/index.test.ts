import {describe, expect, it} from "vitest";
import {correlationId, decryptJson, encryptJson, escapeHtml, keyedDigest, providerError, retryDelay, secure, sha256} from "./index";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(42))).replace(/=/g, "");

describe("encrypted durable records", () => {
  it("round trips Unicode JSON and changes nonce for every record", async () => {
    const payload = {recipient: "klee@example.com", code: "01234567", text: "萌え"};
    const first = await encryptJson(key, payload, "notification:1");
    expect(await decryptJson(key, first, "notification:1")).toEqual(payload);
    expect(await encryptJson(key, payload, "notification:1")).not.toBe(first);
    expect(first).not.toContain(payload.code);
    expect(first).not.toContain(payload.recipient);
  });
  it("rejects changed AAD, keys, envelope and ciphertext", async () => {
    const encrypted = await encryptJson(key, {ok: true}, "record:1");
    await expect(decryptJson(key, encrypted, "record:2")).rejects.toThrow();
    await expect(decryptJson(btoa("wrong"), encrypted, "record:1")).rejects.toThrow();
    await expect(decryptJson(key, "v0.invalid", "record:1")).rejects.toThrow();
    await expect(decryptJson(key, `${encrypted}a`, "record:1")).rejects.toThrow();
  });
});

describe("boundary utilities", () => {
  it("hashes deterministically and escapes HTML", async () => {
    expect(await sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(escapeHtml('<a title="a&b">\'')).toBe("&lt;a title=&quot;a&amp;b&quot;&gt;&#39;");
  });
  it("uses keyed, domain-separated digests for low-entropy idempotency payloads", async () => {
    const text = "notifications-idempotency.v1:01234567";
    const first = await keyedDigest(key, text);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await keyedDigest(key, text)).toBe(first);
    expect(await keyedDigest(key, text.replace("01234567", "01234568"))).not.toBe(first);
    expect(await keyedDigest(key, text.replace("notifications", "decisions"))).not.toBe(first);
    expect(await keyedDigest(btoa(String.fromCharCode(...new Uint8Array(32).fill(43))), text)).not.toBe(first);
    expect(await sha256(text)).not.toBe(first);
    await expect(keyedDigest(btoa("short"), text)).rejects.toThrow("32 bytes");
  });
  it("bounds correlation IDs and useful redacted diagnostics", () => {
    expect(correlationId(new Request("https://internal", {headers: {"x-moesegfault-correlation-id": "good-123"}}))).toBe("good-123");
    expect(correlationId(new Request("https://internal", {headers: {"x-moesegfault-correlation-id": "bad value"}}))).toMatch(/^[a-f0-9-]{36}$/);
    expect(providerError(Object.assign(new Error("Recipient user@example.com rejected code 01234567"), {code: "E_SENDER_NOT_VERIFIED"}))).toEqual({code: "E_SENDER_NOT_VERIFIED", message: "Recipient [recipient] rejected code [code]"});
    expect(retryDelay(100)).toBe(3600);
  });
  it("hardens every capability response", () => {
    const response = secure(new Response("ok"));
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });
});
