/** Exercise the release Worker, real D1 transactions, and pre-account mailbox-proof boundary. */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = resolve(import.meta.dirname, "../..");
const temp = join(root, ".temp", "registration-email");
mkdirSync(temp, { recursive: true });
const state = mkdtempSync(join(temp, "worker-"));
const build = join(root, "crates/identity-worker/build");
const pepper = "fixture-only-email-pepper";
const origin = "https://login.example.test";
const mf = new Miniflare(convertV4MiniflareOptions({ modulesRoot: root, modules: [
  { type: "ESModule", path: join(build, "index.js") },
  { type: "CompiledWasm", path: join(build, "index_bg.wasm") },
], compatibilityDate: "2026-09-15", bindings: {
  ENVIRONMENT: "staging", LOGIN_ORIGIN: origin, ACCOUNT_ORIGIN: "https://account.example.test",
  ISSUER: "https://identity.example.test", OAUTH_ENABLED: "false",
  CSRF_PEPPER: "fixture-only-csrf", SESSION_PEPPER: "fixture-only-session",
  REGISTRATION_PEPPER: "fixture-only-registration", TRANSACTION_PEPPER: "fixture-only-transaction",
  TRANSACTION_STATE_KEY: Buffer.alloc(32, 8).toString("base64url"),
  CONTACT_VERIFICATION_PEPPER: pepper, EMAIL_OUTBOX_KEY_V1: Buffer.alloc(32, 7).toString("base64url"),
}, d1Databases: { DB: "signup-tests" }, persist: state }));
const db = await mf.getD1Database("DB");
const request = (path, init) => mf.dispatchFetch(`https://identity.example.test${path}`, init);

/** Keep response diagnostics useful without printing passwords, tokens, or codes. */
async function body(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, `expected ${status}, got ${response.status}: ${value.error_code ?? value.title ?? "unexpected response"}`);
  return value;
}
/** Establish a real anonymous browser cookie and CSRF proof. */
async function browser() {
  const response = await request("/v1/browser-context", { headers: { origin } });
  const value = await body(response, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  return { cookie, csrf: value.csrf_token };
}
/** Invoke a Browser mutation with a fresh logical operation key. */
function post(path, value, binding) {
  return request(path, { method: "POST", headers: {
    origin, cookie: binding.cookie, "content-type": "application/json",
    "x-moesegfault-csrf": binding.csrf, "idempotency-key": randomUUID(),
  }, body: JSON.stringify(value) });
}
/** Substitute a known code in this isolated fixture, never in a deployed environment. */
async function knownCode(transaction) {
  const row = await db.prepare("SELECT destination_digest FROM registration_email_transactions WHERE transaction_id=?").bind(transaction).first();
  const destination = Buffer.from(row.destination_digest).toString("base64url");
  const digest = createHmac("sha256", pepper).update(`signup-code.v1:${transaction}:${destination}:01234567`).digest();
  await db.prepare("UPDATE registration_email_transactions SET code_digest=? WHERE transaction_id=?").bind([...digest], transaction).run();
}
/** Mailbox proof only: assert this flow has not inserted any account rows. */
async function proof(email, binding) {
  const challenge = await body(await post("/v1/registration-email-transactions", { email }, binding), 201);
  await knownCode(challenge.transaction_id);
  const result = await body(await post(`/v1/registration-email-transactions/${challenge.transaction_id}/completion`, { code: "01234567" }, binding), 200);
  return { ...result, challenge };
}
const registration = { username: "klee_fixture", display_name: "Klee", password: "fixture-only-long-safe-password", email: "klee@example.test" };

try {
  for (const name of readdirSync(join(root, "migrations")).filter(name => /^\d{4}.*\.sql$/.test(name)).sort()) {
    await db.exec(readFileSync(join(root, "migrations", name), "utf8").split("\n").map(line => line.replace(/--.*$/, "").trim()).filter(Boolean).join(" "));
  }
  const first = await browser();
  const second = await browser();
  await body(await post("/v1/password/registrations", registration, first), 403);
  await body(await post("/v1/registration-transactions", { ...registration, password: undefined, authenticator_label: "Fixture" }, first), 403);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM principals").first("n"), 0);

  const challenge = await body(await post("/v1/registration-email-transactions", { email: registration.email }, first), 201);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM principals").first("n"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM identity_sessions").first("n"), 0);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM password_credentials").first("n"), 0);
  await body(await post("/v1/registration-email-transactions", { email: registration.email }, first), 429);
  await knownCode(challenge.transaction_id);
  await body(await post(`/v1/registration-email-transactions/${challenge.transaction_id}/completion`, { code: "01234567" }, second), 400);
  await body(await post(`/v1/registration-email-transactions/${challenge.transaction_id}/completion`, { code: "11111111" }, first), 400);
  const verified = await body(await post(`/v1/registration-email-transactions/${challenge.transaction_id}/completion`, { code: "01234567" }, first), 200);
  const recovered = await body(await post(`/v1/registration-email-transactions/${challenge.transaction_id}/completion`, { code: "01234567" }, first), 200);
  assert.deepEqual(recovered, verified, "lost responses recover the same proof without extending expiry");
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM principals").first("n"), 0);
  const input = { ...registration, email_verification_token: verified.email_verification_token };
  await body(await post("/v1/password/registrations", { ...input, email: "other@example.test" }, first), 403);
  await body(await post("/v1/password/registrations", input, second), 403);
  const passkey = await body(await post("/v1/registration-transactions", { ...input, password: undefined, authenticator_label: "Fixture" }, first), 201);
  assert.ok(passkey.public_key);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM principals").first("n"), 0);

  const responses = await Promise.all([
    post("/v1/password/registrations", input, first),
    post("/v1/password/registrations", { ...input, username: "second_fixture" }, first),
  ]);
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.ok(responses.every(response => [201, 403, 409].includes(response.status)));
  const created = await responses.find(response => response.status === 201).json();
  assert.equal(created.account.identifiers.find(item => item.kind === "email").verification_state, "verified");
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM principals").first("n"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM registration_email_consumptions").first("n"), 1);
  await body(await post("/v1/password/registrations", { ...input, username: "replay_fixture" }, first), 403);

  const third = await browser();
  const expired = await proof("expired@example.test", third);
  await db.prepare("UPDATE registration_email_transactions SET proof_expires_at=unixepoch()-1 WHERE transaction_id=?").bind(expired.challenge.transaction_id).run();
  await body(await post("/v1/password/registrations", { ...registration, email: "expired@example.test", username: "expired_fixture", email_verification_token: expired.email_verification_token }, third), 403);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM principals").first("n"), 1);

  const fourth = await browser();
  const locked = await body(await post("/v1/registration-email-transactions", { email: "locked@example.test" }, fourth), 201);
  await knownCode(locked.transaction_id);
  await Promise.all(Array.from({ length: 12 }, () => post(`/v1/registration-email-transactions/${locked.transaction_id}/completion`, { code: "11111111" }, fourth)));
  assert.equal(await db.prepare("SELECT attempt_count FROM registration_email_transactions WHERE transaction_id=?").bind(locked.transaction_id).first("attempt_count"), 10);
  await body(await post(`/v1/registration-email-transactions/${locked.transaction_id}/completion`, { code: "01234567" }, fourth), 400);

  const fifth = await browser();
  const reusable = await proof("conflict@example.test", fifth);
  const collision = { ...registration, email: "conflict@example.test", username: created.account.identifiers.find(item => item.kind === "username").value, email_verification_token: reusable.email_verification_token };
  await body(await post("/v1/password/registrations", collision, fifth), 409);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM registration_email_consumptions WHERE transaction_id=?").bind(reusable.challenge.transaction_id).first("n"), 0);
  await body(await post("/v1/password/registrations", { ...collision, username: "conflict_retry" }, fifth), 201);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM principals").first("n"), 2);

  const sixth = await browser();
  const replaced = await proof("replaced@example.test", sixth);
  await db.prepare("UPDATE registration_email_transactions SET created_at=created_at-61,expires_at=expires_at-61 WHERE transaction_id=?").bind(replaced.challenge.transaction_id).run();
  await body(await post("/v1/registration-email-transactions", { email: "corrected@example.test" }, sixth), 201);
  await body(await post("/v1/password/registrations", { ...registration, email: "replaced@example.test", email_verification_token: replaced.email_verification_token }, sixth), 403);
  console.log("registration email: no-account-before-proof, password/passkey bypass prevention, email/browser binding, atomic single-use race, expiry, and parallel guessing limits passed");
} finally { await mf.dispose(); }
