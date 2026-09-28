/**
 * Exercise password step-up, atomic authority revocation, cookie rotation, and lost-response replay.
 * 通过真实 Worker 和隔离 D1 验证密码 step-up、原子权限撤销、Cookie 轮换与丢失响应重试。
 *
 * Run / 运行：npm run build:identity && node scripts/tests/password-security.mjs
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
const initialWire = "test-password-security-initial-session-secret";
const stateRoot = join(root, ".temp");
assert.ok(existsSync(wrangler), "Run npm ci first");
assert.ok(existsSync(shim), "Run npm run build:identity first");
mkdirSync(stateRoot, { recursive: true });
const state = mkdtempSync(join(stateRoot, "password-security-"));

/** Run Wrangler against only this test's D1 state. / 仅对本测试隔离 D1 状态运行 Wrangler。 */
function runWrangler(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], { cwd: root, encoding: "utf8", timeout: 90_000 });
  assert.equal(result.status, 0, `Wrangler failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}

/** Execute one SQLite query via the deployed schema. / 通过已部署 schema 执行 SQLite 查询。 */
function query(sql) {
  const output = runWrangler(["d1", "execute", "moesegfault-identity-staging", "--local", `--persist-to=${state}`, "--config=wrangler.identity.jsonc", `--command=${sql}`, "--json"]);
  return JSON.parse(output)[0].results;
}

/** Reserve a local port for the test Worker. / 为测试 Worker 分配本机端口。 */
async function freePort() {
  const server = createServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  await new Promise((ok) => server.close(ok));
  return port;
}

/** Build the session-bound mutation headers. / 构造绑定会话的 mutation 请求头。 */
function proof(wire, key) {
  return { cookie: `__Host-identity_session=${wire}`, origin, "content-type": "application/json", "idempotency-key": key,
    "x-moesegfault-csrf": createHmac("sha256", csrfPepper).update(wire).digest("base64url") };
}

/** Send a password mutation and retain the new opaque cookie. / 发送密码 mutation 并保留新不透明 Cookie。 */
async function change(base, wire, key, body) {
  return fetch(`${base}/v1/me/password`, { method: "PUT", headers: proof(wire, key), body: JSON.stringify(body) });
}

/** Extract a rotated host-only session secret without logging it. / 提取轮换后的 host-only 会话密钥且不记录。 */
function rotatedWire(response) {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = cookie.match(/^__Host-identity_session=([^;]+); Secure; HttpOnly; SameSite=Lax; Path=\//);
  assert.ok(match, `Expected secure rotated session cookie, got status ${response.status}`);
  return match[1];
}

const prepared = spawnSync(process.execPath, ['scripts/prepare-migrations.mjs', 'staging'], { cwd: root, encoding: 'utf8' });
assert.equal(prepared.status, 0, `${prepared.stdout}\n${prepared.stderr}`);
runWrangler(["d1", "migrations", "apply", "moesegfault-identity-staging", "--local", `--persist-to=${state}`, "--config=wrangler.identity.jsonc"]);
const now = Math.floor(Date.now() / 1000);
const principal = randomUUID();
const authenticator = randomUUID();
const current = randomUUID();
const stale = randomUUID();
const other = randomUUID();
const resumeTransaction = randomUUID();
const digest = createHmac("sha256", sessionPepper).update(initialWire).digest("hex");
query(`INSERT INTO principals(principal_id,kind,lifecycle_state,webauthn_user_handle,created_at,updated_at,state_changed_at) VALUES('${principal}','human','active',randomblob(32),${now - 1000},${now - 1000},${now - 1000})`);
query(`INSERT INTO authenticators(authenticator_id,principal_id,credential_id,public_key_cose,sign_count,aaguid,backup_eligible,backup_state,label,created_at) VALUES('${authenticator}','${principal}',randomblob(32),randomblob(64),0,randomblob(16),0,0,'Security key',${now - 1000})`);
query(`INSERT INTO identity_sessions(session_id,session_digest,principal_id,authenticator_id,auth_method,amr_json,acr,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES('${current}',X'${digest}','${principal}','${authenticator}','passkey','["passkey"]','urn:moesegfault:acr:passkey-uv',${now - 5},${now - 5},${now + 43200},${now + 2592000}),('${stale}',randomblob(32),'${principal}','${authenticator}','passkey','["passkey"]','urn:moesegfault:acr:passkey-uv',${now - 400},${now - 400},${now + 43200},${now + 2592000}),('${other}',randomblob(32),'${principal}','${authenticator}','passkey','["passkey"]','urn:moesegfault:acr:passkey-uv',${now - 100},${now - 100},${now + 43200},${now + 2592000})`);
query(`INSERT INTO oauth_clients(client_id,display_name,client_type,token_endpoint_auth_method,sector_identifier,subject_salt_revision,created_at,updated_at) VALUES('test-client','Test client','native','none','test.example',1,${now - 1000},${now - 1000})`);
query(`INSERT INTO identifiers(identifier_id,principal_id,kind,value,normalized_value,is_primary,created_at,updated_at) VALUES('${randomUUID()}','${principal}','username','resumefixture','resumefixture',1,${now - 1000},${now - 1000})`);
query(`INSERT INTO oauth_authorization_transactions(authorization_transaction_id,client_id,redirect_uri,response_type,scope,state_value,nonce,code_challenge,code_challenge_method,created_at,expires_at) VALUES('${resumeTransaction}','test-client','http://127.0.0.1:9000/callback','code','openid','test-state-12345','test-nonce-12345','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','S256',${now},${now + 3600})`);
query(`INSERT INTO oauth_refresh_token_families(refresh_token_family_id,client_id,principal_id,identity_session_id,scope,audience,created_at,absolute_expires_at) VALUES('${randomUUID()}','test-client','${principal}','${other}','openid offline_access','test-api',${now - 100},${now + 86400})`);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const worker = spawn(process.execPath, [wrangler, "dev", "--local", "--config=wrangler.identity.jsonc", "--ip=127.0.0.1", `--port=${port}`, `--persist-to=${state}`,
  "--var=LOGIN_ORIGIN:http://localhost:5173", `--var=ACCOUNT_ORIGIN:${origin}`, `--var=SESSION_PEPPER:${sessionPepper}`, `--var=CSRF_PEPPER:${csrfPepper}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let diagnostics = "";
for (const stream of [worker.stdout, worker.stderr]) stream.on("data", (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); });

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited early with status ${worker.exitCode}`);
    try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } }
    catch { /* Starting / 启动中。 */ }
    await new Promise((ok) => setTimeout(ok, 200));
  }
  assert.ok(ready, "Local Worker did not start within 20s");
  console.log("password security: Worker ready");
  const firstBody = { new_password: "the first safe password for Klee 123" };
  // The current seeded Passkey is recent. Make it stale for this one denial, then restore it.
  // 当前预置 Passkey 近期有效；先临时置旧以测试拒绝，再恢复。
  query(`UPDATE identity_sessions SET authenticated_at=${now - 400},last_seen_at=${now - 400} WHERE session_id='${current}'`);
  const denied = await change(base, initialWire, "password-stale-passkey", firstBody);
  console.log("password security: stale challenge returned", denied.status);
  assert.equal(denied.status, 403, await denied.text());
  query(`UPDATE identity_sessions SET authenticated_at=${now - 5},last_seen_at=${now - 5} WHERE session_id='${current}'`);
  const added = await change(base, initialWire, "password-step-up-required", firstBody);
  console.log("password security: password add returned", added.status);
  assert.equal(added.status, 204, await added.text());
  const secondWire = rotatedWire(added);
  assert.notEqual(secondWire, initialWire);
  // Password-authenticated OAuth must resume at the configured Identity issuer,
  // not at the Login origin that rendered the page. / 密码 OAuth 续接必须指向固定 Identity 发行方。
  const browserContext = await fetch(`${base}/v1/browser-context`, { headers: { origin: "http://localhost:5173" } });
  assert.equal(browserContext.status, 200);
  const browserCookie = browserContext.headers.get("set-cookie")?.split(";")[0];
  assert.ok(browserCookie?.startsWith("__Host-identity_browser="));
  const { csrf_token: browserCsrf } = await browserContext.json();
  const oauthAuthentication = await fetch(`${base}/v1/password/authentications`, {
    method: "POST", headers: { origin: "http://localhost:5173", cookie: browserCookie,
      "content-type": "application/json", "x-moesegfault-csrf": browserCsrf,
      "idempotency-key": "password-oauth-resume-001" },
    body: JSON.stringify({ login: "resumefixture", password: firstBody.new_password, authorization_transaction_id: resumeTransaction }),
  });
  assert.equal(oauthAuthentication.status, 200, `Password OAuth authentication returned ${oauthAuthentication.status}`);
  const authenticated = await oauthAuthentication.json();
  assert.equal(authenticated.authorization_resume_uri,
    `https://identity-staging.moesegfault.dev/v1/oauth/authorization-transactions/${resumeTransaction}/resume`);
  assert.equal(query(`SELECT state FROM oauth_authorization_transactions WHERE authorization_transaction_id='${resumeTransaction}'`)[0].state, "authenticated");
  console.log("password security: OAuth password login returned issuer-rooted resume URI");
  assert.equal((await fetch(`${base}/v1/principals/self/sessions`, { headers: { cookie: `__Host-identity_session=${initialWire}`, origin } })).status, 401);
  assert.equal((await fetch(`${base}/v1/principals/self/sessions`, { headers: { cookie: `__Host-identity_session=${secondWire}`, origin } })).status, 200);
  const lostResponseRetry = await change(base, initialWire, "password-step-up-required", firstBody);
  const replayProblem = await lostResponseRetry.json();
  assert.equal(lostResponseRetry.status, 409, JSON.stringify(replayProblem));
  assert.equal(replayProblem.error_code, "idempotency_result_unavailable");
  const staleFreshKey = await change(base, initialWire, "password-revoked-session-new-key", firstBody);
  assert.equal(staleFreshKey.status, 401, await staleFreshKey.text());
  const secondBody = { current_password: firstBody.new_password, new_password: "the second safe password for Klee 456" };
  const wrongProof = await change(base, secondWire, "password-wrong-current", { ...secondBody, current_password: "wrong current password" });
  assert.equal(wrongProof.status, 403, await wrongProof.text());
  const replaced = await change(base, secondWire, "password-existing-replace", secondBody);
  console.log("password security: password change returned", replaced.status);
  assert.equal(replaced.status, 204, await replaced.text());
  const thirdWire = rotatedWire(replaced);
  assert.notEqual(thirdWire, secondWire);
  assert.equal((await fetch(`${base}/v1/principals/self/sessions`, { headers: { cookie: `__Host-identity_session=${secondWire}`, origin } })).status, 401);
  assert.equal((await fetch(`${base}/v1/principals/self/sessions`, { headers: { cookie: `__Host-identity_session=${thirdWire}`, origin } })).status, 200);
  assert.equal(query(`SELECT password_version AS version FROM password_credentials WHERE principal_id='${principal}'`)[0].version, 2);
  assert.equal(query(`SELECT count(*) AS n FROM identity_sessions WHERE principal_id='${principal}' AND revoked_at IS NULL`)[0].n, 1);
  assert.equal(query(`SELECT count(*) AS n FROM oauth_refresh_token_families WHERE principal_id='${principal}' AND revoked_at IS NULL`)[0].n, 0);
  console.log("password security: stale Passkey denied; add/change rotated cookie; old sessions and refresh family revoked; secret replay refused");
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  worker.kill();
  if (worker.exitCode === null) await new Promise((ok) => worker.once("close", ok));
}
