/**
 * Verify session-renewal semantics and count actual D1 calls through the release Wasm Worker.
 * Run: npm run build:identity && node crates/identity-worker/tests/session-performance.mjs
 * Optional comparison: append --baseline=.temp/performance-2026-10-01/backend-before
 * Optional timings without a baseline: append --benchmark; password cost: --benchmark-password
 * All fixtures and instrumentation live under repository-local .temp; no remote services are used.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const tempRoot = join(root, ".temp", "performance-2026-10-01");
mkdirSync(tempRoot, { recursive: true });
const state = mkdtempSync(join(tempRoot, "session-worker-"));
const secret = "fixture-only-session-performance-pepper";
const wire = "fixture-only-session-performance-cookie";
const principal = randomUUID();
const session = randomUUID();
const digest = createHmac("sha256", secret).update(wire).digest("hex");
const cookie = `__Host-identity_session=${wire}`;
const baseBindings = { ENVIRONMENT: "staging", SESSION_PEPPER: secret, CSRF_PEPPER: secret, TRANSACTION_PEPPER: secret,
  LOGIN_ORIGIN: "https://login.example.test", ACCOUNT_ORIGIN: "https://account.example.test",
  AVATAR_PUBLIC_ORIGIN: "https://avatars.example.test", ISSUER: "https://identity.example.test" };

/** Create a real workerd instance with request-local counting around its actual D1 binding. */
async function runtime(buildDirectory, label) {
  const build = resolve(root, buildDirectory);
  const wrapper = join(state, `${label}.mjs`);
  const imported = relative(state, join(build, "index.js")).replaceAll("\\", "/");
  writeFileSync(wrapper, `
import Identity from ${JSON.stringify(imported.startsWith(".") ? imported : `./${imported}`)};
import { WorkerEntrypoint } from "cloudflare:workers";
/** Request-local instrumentation, never shared with another request. */
export default class extends WorkerEntrypoint {
  async fetch(request) {
    const calls = [];
    const delay = Number(request.headers.get("x-test-d1-delay-ms") || 0);
    const raw = new WeakMap();
    const invoke = async (target, method, args, sql) => {
      calls.push({ method, sql });
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return target[method](...args);
    };
    const statement = (target, sql) => {
      const proxy = new Proxy(target, { get(target, property) {
        if (property === "constructor") return target.constructor;
        if (property === "bind") return (...args) => statement(target.bind(...args), sql);
        if (["first", "all", "run", "raw"].includes(property))
          return (...args) => invoke(target, property, args, sql);
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      }});
      raw.set(proxy, target);
      return proxy;
    };
    const database = target => new Proxy(target, { get(target, property) {
      if (property === "constructor") return target.constructor;
      if (property === "prepare") return sql => statement(target.prepare(sql), sql);
      if (property === "withSession") return (...args) => database(target.withSession(...args));
      if (property === "batch") return statements => invoke(target, "batch", [statements.map(s => raw.get(s) || s)], "<batch>");
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }});
    const identity = new Identity(this.ctx, { ...this.env, DB: database(this.env.DB) });
    const response = await identity.fetch(request);
    response.headers.set("x-test-d1-calls", JSON.stringify(calls));
    return response;
  }
}
`);
  return new Miniflare(convertV4MiniflareOptions({ modulesRoot: root, modules: [
    { type: "ESModule", path: wrapper }, { type: "ESModule", path: join(build, "index.js") },
    { type: "CompiledWasm", path: join(build, "index_bg.wasm") },
  ], compatibilityDate: "2026-09-15", bindings: baseBindings, d1Databases: { DB: "session-performance" },
    persist: join(state, label) }));
}

/** Apply the real schema and create one synthetic password session without an HTTP registration. */
async function seed(mf) {
  const db = await mf.getD1Database("DB");
  for (const migration of readdirSync(join(root, "migrations")).filter(name => /^\d+.*\.sql$/.test(name)).sort())
    await db.exec(readFileSync(join(root, "migrations", migration), "utf8")
      .split("\n").map(line => line.replace(/--.*$/, "").trim()).filter(Boolean).join(" "));
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO principals(principal_id,kind,lifecycle_state,webauthn_user_handle,created_at,updated_at,state_changed_at) VALUES(?1,'human','active',?2,?3,?3,?3)")
    .bind(principal, new Uint8Array(32), now).run();
  await db.prepare("INSERT INTO human_profiles(principal_id,display_name,locale,created_at,updated_at) VALUES(?1,'Performance fixture','zh-CN',?2,?2)").bind(principal, now).run();
  await db.prepare("INSERT INTO identity_sessions(session_id,session_digest,principal_id,auth_method,amr_json,acr,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?1,?2,?3,'password','[\"password\"]','urn:moesegfault:acr:password',?4-1000,?4,?5,?6)")
    .bind(session, new Uint8Array(Buffer.from(digest, "hex")), principal, now, now + 43200, now + 2592000).run();
  return db;
}

/** Consume the response body so timing includes the complete local HTTP workflow. */
async function request(mf, path = "/v1/me", delay = 0) {
  const start = performance.now();
  const response = await mf.dispatchFetch(`https://identity.example.test${path}`, { headers: { cookie, origin: baseBindings.ACCOUNT_ORIGIN, "x-test-d1-delay-ms": String(delay) } });
  const body = await response.json();
  return { status: response.status, body, elapsed: performance.now() - start,
    calls: JSON.parse(response.headers.get("x-test-d1-calls")) };
}

/** Report median, tails, and median absolute deviation rather than a single noisy sample. */
function summary(samples) {
  const ordered = [...samples].sort((a, b) => a - b);
  const median = ordered[Math.floor(ordered.length / 2)];
  const deviation = ordered.map(value => Math.abs(value - median)).sort((a, b) => a - b);
  return { n: samples.length, median_ms: median, p95_ms: ordered[Math.ceil(ordered.length * 0.95) - 1], mad_ms: deviation[Math.floor(deviation.length / 2)] };
}

/** Check renewal, expiration, revocation, inactive principals, and concurrent touch behavior. */
async function verify(mf, db) {
  const fresh = await request(mf);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.calls.length, 3, "Fresh /v1/me must skip the no-op session write");
  assert.ok(fresh.calls.every(call => !call.sql.startsWith("UPDATE identity_sessions")));
  assert.ok(!JSON.stringify(fresh.body).includes("last_seen_at"), "Activity projection must stay internal");
  assert.ok(fresh.calls[0].sql.includes("s.last_seen_at"));
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("UPDATE identity_sessions SET last_seen_at=?1 WHERE session_id=?2").bind(now - 301, session).run();
  const renewed = await request(mf);
  assert.equal(renewed.status, 200);
  assert.equal(renewed.calls.length, 4, "Due session must still renew synchronously");
  const row = await db.prepare("SELECT last_seen_at,idle_expires_at,absolute_expires_at FROM identity_sessions WHERE session_id=?1").bind(session).first();
  assert.ok(row.last_seen_at >= now);
  assert.equal(row.idle_expires_at, Math.min(row.absolute_expires_at, row.last_seen_at + 43200));
  await db.prepare("UPDATE identity_sessions SET last_seen_at=?1,idle_expires_at=?2,absolute_expires_at=?2 WHERE session_id=?3").bind(now - 301, now + 600, session).run();
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => request(mf)));
  assert.ok(concurrent.every(result => result.status === 200));
  const capped = await db.prepare("SELECT idle_expires_at,absolute_expires_at FROM identity_sessions WHERE session_id=?1").bind(session).first();
  assert.equal(capped.idle_expires_at, capped.absolute_expires_at);
  for (const [column, value] of [["idle_expires_at", now - 1], ["absolute_expires_at", now - 1], ["revoked_at", now]]) {
    await db.prepare(`UPDATE identity_sessions SET idle_expires_at=?1,absolute_expires_at=?2,last_seen_at=?3,revoked_at=NULL,revocation_reason=NULL WHERE session_id=?4`).bind(now + 43200, now + 2592000, now - 100, session).run();
    const expiryAssignment = column === "absolute_expires_at" ? "absolute_expires_at=?1,idle_expires_at=?1" : column === "revoked_at" ? "revoked_at=?1,revocation_reason='test'" : `${column}=?1`;
    await db.prepare(`UPDATE identity_sessions SET ${expiryAssignment} WHERE session_id=?2`).bind(value, session).run();
    const denied = await request(mf);
    assert.equal(denied.status, 401, `${column} must still deny authentication`);
    assert.equal(denied.calls.length, 1, "Invalid sessions must not be touched");
  }
  await db.prepare("UPDATE identity_sessions SET revoked_at=NULL,revocation_reason=NULL WHERE session_id=?1").bind(session).run();
  await db.prepare("UPDATE principals SET lifecycle_state='pending_deletion' WHERE principal_id=?1").bind(principal).run();
  assert.equal((await request(mf)).status, 401);
  await db.prepare("UPDATE principals SET lifecycle_state='active' WHERE principal_id=?1").bind(principal).run();
  const generic = await request(mf, "/v1/browser-context");
  assert.equal(generic.status, 200);
  assert.equal(generic.body.has_identity_session, true);
  assert.equal(generic.calls.length, 1, "Generic session lookup must also skip the fresh write");
  await db.prepare("UPDATE identity_sessions SET last_seen_at=?1 WHERE session_id=?2").bind(now - 301, session).run();
  const genericDue = await request(mf, "/v1/browser-context");
  assert.equal(genericDue.status, 200);
  assert.equal(genericDue.body.has_identity_session, true);
  assert.equal(genericDue.calls.length, 2, "Generic due session must still renew");
}

const current = await runtime("crates/identity-worker/build", "after");
let baseline;
try {
  const currentDb = await seed(current);
  await verify(current, currentDb);
  const baselineArgument = process.argv.find(arg => arg.startsWith("--baseline="));
  if (baselineArgument) { baseline = await runtime(baselineArgument.slice(11), "before"); await seed(baseline); }
  const results = [];
  for (const delay of baselineArgument || process.argv.includes("--benchmark") ? [0, 20, 80] : []) {
    for (const mf of [baseline, current].filter(Boolean)) for (let i = 0; i < 5; i++) await request(mf, "/v1/me", delay);
    const before = [], after = [];
    for (let i = 0; i < 25; i++) {
      const order = i % 2 ? [[current, after], [baseline, before]] : [[baseline, before], [current, after]];
      for (const [mf, samples] of order) if (mf) {
        const measured = await request(mf, "/v1/me", delay);
        assert.equal(measured.status, 200);
        assert.equal(measured.calls.length, mf === current ? 3 : 4);
        samples.push(measured.elapsed);
      }
    }
    results.push({ injected_per_rpc_delay_ms: delay, before: before.length ? summary(before) : null, after: summary(after) });
  }
  let passwordTiming = null;
  if (process.argv.includes("--benchmark-password")) {
    const browser = await current.dispatchFetch("https://identity.example.test/v1/browser-context", { headers: { origin: baseBindings.LOGIN_ORIGIN } });
    const browserCookie = browser.headers.get("set-cookie").split(";")[0];
    const { csrf_token: csrf } = await browser.json();
    const samples = [];
    for (let i = 0; i < 15; i++) {
      const start = performance.now();
      const response = await current.dispatchFetch("https://identity.example.test/v1/password/authentications", {
        method: "POST", headers: { origin: baseBindings.LOGIN_ORIGIN, cookie: browserCookie,
          "content-type": "application/json", "x-moesegfault-csrf": csrf, "idempotency-key": `perf-password-${randomUUID()}` },
        body: JSON.stringify({ login: `unknown-${randomUUID()}`, password: "fixture safe password only" }),
      });
      await response.json();
      assert.equal(response.status, 401, "Unknown identifiers must exercise dummy Argon2 and deny login");
      if (i >= 3) samples.push(performance.now() - start);
    }
    passwordTiming = summary(samples);
  }
  const report = { environment: { node: process.version, platform: process.platform, miniflare: "local workerd release Wasm", repetitions: 25, warmup: 5 },
    verified: ["fresh skips write", "due renews", "generic session fresh/due", "concurrent CAS", "absolute expiry cap", "idle expired denied", "absolute expired denied", "revoked denied", "inactive principal denied", "HTTP projection unchanged"], results, password_timing: passwordTiming };
  writeFileSync(join(state, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ artifact: relative(root, join(state, "results.json")), ...report }, null, 2));
} finally {
  await current.dispose();
  if (baseline) await baseline.dispose();
}
