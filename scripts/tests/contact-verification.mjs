/**
 * Exercise the public contact-ID contract through a real local Worker and isolated D1.
 * 通过真实本地 Worker 与隔离 D1 验证公开联系方式 ID 契约。
 *
 * Run / 运行：npm run build:identity && node scripts/tests/contact-verification.mjs.
 * Wrangler's local EMAIL binding cannot deliver external mail. Completion uses a
 * synthetic code digest written only to this test's isolated D1. / Wrangler 本地邮件
 * 绑定不会向外部发送邮件；完成验证时仅向隔离 D1 写入合成验证码摘要。
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const shim = join(root, "crates", "identity-worker", "build", "worker", "shim.mjs");
const origin = "http://localhost:5174";
const sessionPepper = "test-only-session-pepper";
const csrfPepper = "test-only-csrf-pepper";
const verificationPepper = "test-contact-verification-pepper";
const sessionWire = "test-local-session-wire-not-a-production-secret";
const stateRoot = join(root, ".temp");

assert.ok(existsSync(wrangler), "Run npm ci before this test");
assert.ok(existsSync(shim), "Run npm run build:identity before this test");
mkdirSync(stateRoot, { recursive: true });
const state = mkdtempSync(join(stateRoot, "contact-verification-"));

/** Execute Wrangler against this test's private D1 state. / 对本测试私有 D1 状态运行 Wrangler。 */
function runWrangler(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root, encoding: "utf8", timeout: 90_000,
  });
  assert.equal(result.status, 0, `Wrangler failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}

/** Execute one SQL statement and decode Wrangler's JSON result. / 执行 SQL 并解析 Wrangler JSON 结果。 */
function query(sql) {
  const output = runWrangler([
    "d1", "execute", "moesegfault-identity-staging", "--local", `--persist-to=${state}`,
    "--config=wrangler.identity.jsonc", `--command=${sql}`, "--json",
  ]);
  return JSON.parse(output)[0].results;
}

/** Reserve an ephemeral loopback port. / 分配本机临时端口。 */
async function freePort() {
  const server = createServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  await new Promise((ok) => server.close(ok));
  return port;
}

/** Parse JSON before status assertions so failures retain server evidence. / 先解析响应以保留错误证据。 */
async function jsonResponse(response, status) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

/** Bind the synthetic code to transaction and destination exactly as the Worker does. / 与 Worker 一致地绑定测试验证码、事务和目的地。 */
function verificationCodeDigest(transactionId, destination, code) {
  const hmac = createHmac("sha256", verificationPepper);
  hmac.update(Buffer.from("moesegfault.contact-verification.code.v1\0"));
  for (const value of [transactionId, destination, code]) {
    const field = Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(field.length));
    hmac.update(length);
    hmac.update(field);
  }
  return hmac.digest("hex");
}

runWrangler([
  "d1", "migrations", "apply", "moesegfault-identity-staging", "--local",
  `--persist-to=${state}`, "--config=wrangler.identity.jsonc",
]);

// Seed only the authenticated principal; exercise contact creation through HTTP.
// 只预置认证主体；联系方式必须经真实 HTTP 路径创建。
const now = Math.floor(Date.now() / 1_000);
const principalId = randomUUID();
const sessionId = randomUUID();
const sessionDigest = createHmac("sha256", sessionPepper).update(sessionWire).digest("hex");
query(`INSERT INTO principals(principal_id,kind,lifecycle_state,webauthn_user_handle,created_at,updated_at,state_changed_at) VALUES('${principalId}','human','active',X'${"11".repeat(32)}',${now},${now},${now})`);
query(`INSERT INTO identity_sessions(session_id,session_digest,principal_id,auth_method,amr_json,acr,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES('${sessionId}',X'${sessionDigest}','${principalId}','password','["password"]','urn:moesegfault:acr:password',${now},${now},${now + 43_200},${now + 2_592_000})`);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const worker = spawn(process.execPath, [wrangler, "dev", "--local", "--config=wrangler.identity.jsonc",
  "--ip=127.0.0.1", `--port=${port}`, `--persist-to=${state}`,
  "--var=LOGIN_ORIGIN:http://localhost:5173", `--var=ACCOUNT_ORIGIN:${origin}`,
  `--var=SESSION_PEPPER:${sessionPepper}`, `--var=CSRF_PEPPER:${csrfPepper}`,
  `--var=CONTACT_VERIFICATION_PEPPER:${verificationPepper}`,
  "--var=EMAIL_OUTBOX_KEY_V1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
// Local EMAIL simulation may print the code. Consume logs but never retain/echo them.
// 本地邮件模拟可能输出验证码；消耗日志，但绝不保存或回显。
for (const stream of [worker.stdout, worker.stderr]) stream.resume();

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited early with status ${worker.exitCode}`);
    try {
      const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1_000) });
      if (health.ok) { ready = true; break; }
    } catch { /* Worker is starting. / Worker 尚在启动。 */ }
    await new Promise((ok) => setTimeout(ok, 200));
  }
  assert.ok(ready, "Local Worker did not start within 20s");
  const cookie = `__Host-identity_session=${sessionWire}`;
  const csrf = createHmac("sha256", csrfPepper).update(sessionWire).digest("base64url");
  const headers = { cookie, origin, "x-moesegfault-csrf": csrf };
  const email = "validator@example.invalid";
  const created = await jsonResponse(await fetch(`${base}/v1/me/contacts`, {
    method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "test-contact-create-v1" },
    body: JSON.stringify({ kind: "email", email, is_primary: true }),
  }), 201);
  assert.match(created.contact_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(created.identifier_id, created.contact_id, "legacy alias must identify the same contact");
  const listed = await jsonResponse(await fetch(`${base}/v1/me/contacts`, { headers: { cookie, origin } }), 200);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].contact_id, created.contact_id);
  assert.equal(listed[0].identifier_id, created.contact_id);
  assert.equal(listed[0].value, email);
  const started = await jsonResponse(await fetch(`${base}/v1/me/contacts/${listed[0].contact_id}/verification-transactions`, {
    method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "test-contact-verify-start-v1" }, body: "{}",
  }), 201);
  assert.match(started.transaction_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(started.delivery_hint, "v***@example.invalid");
  const replayed = await jsonResponse(await fetch(`${base}/v1/me/contacts/${listed[0].contact_id}/verification-transactions`, {
    method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "test-contact-verify-start-v1" }, body: "{}",
  }), 201);
  assert.equal(replayed.transaction_id, started.transaction_id, "same operation must replay without new delivery");
  const limited = await jsonResponse(await fetch(`${base}/v1/me/contacts/${listed[0].contact_id}/verification-transactions`, {
    method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "test-contact-verify-start-v2" }, body: "{}",
  }), 429);
  assert.equal(limited.error_code, "rate_limited");
  assert.equal(query(`SELECT COUNT(*) AS n FROM identifier_verification_transactions WHERE identifier_id='${listed[0].contact_id}' AND state='pending'`)[0].n, 1);
  assert.equal(query(`SELECT COUNT(*) AS n FROM email_verification_outbox WHERE transaction_id='${started.transaction_id}'`)[0].n, 1);
  // The simulated mailer is not an inbox. Replace only this test transaction's code
  // digest with a known synthetic value; never read, print, or persist a delivered code.
  // 模拟邮件不是收件箱；只替换本次事务的摘要，不读取、输出或保存投递验证码。
  const code = "13579024";
  const digest = verificationCodeDigest(started.transaction_id, email, code);
  query(`UPDATE identifier_verification_transactions SET code_digest=X'${digest}' WHERE transaction_id='${started.transaction_id}' AND identifier_id='${created.contact_id}' AND state='pending'`);
  const completionUrl = `${base}/v1/me/contacts/${created.contact_id}/verification-transactions/${started.transaction_id}/completion`;
  const completionBody = JSON.stringify({ code });
  const completionHeaders = { ...headers, "content-type": "application/json", "idempotency-key": "test-contact-verify-complete-v1" };
  const completed = await jsonResponse(await fetch(completionUrl, {
    method: "POST", headers: completionHeaders, body: completionBody,
  }), 200);
  assert.equal(completed.contact_id, created.contact_id);
  assert.equal(completed.identifier_id, created.contact_id);
  assert.equal(completed.verification_state, "verified");
  const completionReplay = await jsonResponse(await fetch(completionUrl, {
    method: "POST", headers: completionHeaders, body: completionBody,
  }), 200);
  assert.equal(completionReplay.contact_id, completed.contact_id, "same-key replay must retain the verified projection");
  const reused = await jsonResponse(await fetch(completionUrl, {
    method: "POST", headers: { ...completionHeaders, "idempotency-key": "test-contact-verify-complete-v2" }, body: completionBody,
  }), 410);
  assert.equal(reused.error_code, "transaction_expired", "a consumed code cannot verify again");
  assert.deepEqual(query(`SELECT verification_state,verified_at IS NOT NULL AS has_verified_at FROM identifiers WHERE identifier_id='${created.contact_id}'`), [
    { verification_state: "verified", has_verified_at: 1 },
  ]);
  assert.equal(query(`SELECT COUNT(*) AS n FROM identifier_verification_consumptions WHERE transaction_id='${started.transaction_id}'`)[0].n, 1);
  console.log(`contact create/list/start/replay/cooldown/complete/replay/reuse: 201/200/201/201/429/200/200/410; contact_id=${created.contact_id}; one verification consumption`);
} finally {
  worker.kill();
  if (worker.exitCode === null) await new Promise((resolveClose) => worker.once("close", resolveClose));
}
