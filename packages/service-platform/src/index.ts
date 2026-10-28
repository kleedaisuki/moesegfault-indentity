const encoder = new TextEncoder();

function bytes(encoded: string): Uint8Array<ArrayBuffer> {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normalized), character => character.charCodeAt(0));
}

function base64(value: ArrayBuffer | Uint8Array): string {
  const raw = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function outboxKey(encoded: string): Promise<CryptoKey> {
  const raw = bytes(encoded);
  if (raw.length !== 32) throw new Error("OUTBOX_KEY must encode exactly 32 bytes");
  return crypto.subtle.importKey("raw", raw, {name: "AES-GCM"}, false, ["encrypt", "decrypt"]);
}

export async function encryptJson(keyBase64: string, payload: unknown, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {name: "AES-GCM", iv, additionalData: encoder.encode(aad)},
    await outboxKey(keyBase64), encoder.encode(JSON.stringify(payload)),
  );
  return `v1.${base64(iv)}.${base64(encrypted)}`;
}

export async function decryptJson<T>(keyBase64: string, envelope: string, aad: string): Promise<T> {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) throw new Error("Invalid encrypted envelope");
  const iv = bytes(parts[1]);
  if (iv.length !== 12) throw new Error("Invalid encrypted envelope nonce");
  const plaintext = await crypto.subtle.decrypt(
    {name: "AES-GCM", iv, additionalData: encoder.encode(aad)},
    await outboxKey(keyBase64), bytes(parts[2]),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function keyedDigest(keyBase64: string, text: string): Promise<string> {
  const raw = bytes(keyBase64);
  if (raw.length !== 32) throw new Error("Digest key must encode exactly 32 bytes");
  const key = await crypto.subtle.importKey("raw", raw, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[character]!);
}

export function correlationId(request: Request): string {
  const supplied = request.headers.get("x-moesegfault-correlation-id");
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json; charset=utf-8"}});
}

export function problem(status: number, code: string, detail?: string): Response {
  return new Response(JSON.stringify({type: `urn:moesegfault:problem:${code}`, title: code, status, code, ...(detail ? {detail} : {})}), {
    status, headers: {"Content-Type": "application/problem+json; charset=utf-8"},
  });
}

export function secure(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("Cache-Control", "no-store");
  // Fetch serializes native form POST Origin as null under no-referrer.
  secured.headers.set("Referrer-Policy", "strict-origin");
  secured.headers.set("X-Content-Type-Options", "nosniff");
  secured.headers.set("X-Frame-Options", "DENY");
  secured.headers.set("X-Robots-Tag", "noindex, nofollow");
  secured.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  return secured;
}

export function retryDelay(attempt: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, Math.min(attempt, 7)));
}

export function providerError(error: unknown): {code: string; message: string} {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof record.code === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(record.code) ? record.code : "provider_error";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Provider operation failed";
  return {code, message: message.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[recipient]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/\b\d{6,10}\b/g, "[code]").slice(0, 320)};
}
