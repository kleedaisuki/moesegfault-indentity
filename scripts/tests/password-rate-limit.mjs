/**
 * Exercise the production SQL throttle against SQLite, including its migration.
 * 使用 SQLite 验证生产限速 SQL 及其迁移。
 *
 * Run / 运行：node scripts/tests/password-rate-limit.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const stateRoot = join(root, ".temp");
mkdirSync(stateRoot, { recursive: true });
const state = mkdtempSync(join(stateRoot, "password-rate-limit-"));
const db = new DatabaseSync(join(state, "attempts.sqlite"));
db.exec(readFileSync(join(root, "migrations/0006_password_rate_limit.sql"), "utf8"));

// Extract the actual Worker UPSERT rather than testing a second SQL copy.
// 直接提取 Worker 使用的 UPSERT，避免测试一份会漂移的 SQL 副本。
const source = readFileSync(join(root, "crates/identity-worker/src/password.rs"), "utf8");
const match = source.match(/"INSERT INTO password_auth_attempts[\s\S]*?RETURNING attempt_count"/);
assert.ok(match, "Worker attempt reservation SQL not found");
const sql = match[0].slice(1, -1).replace(/\\\r?\n\s*/g, "");
const reserve = db.prepare(sql);
const digest = Buffer.alloc(32, 7);

/** Reserve one attempt at a synthetic clock time. / 在合成时钟时间预占一次尝试。 */
function attempt(now, key = digest) {
  return reserve.get(key, now, now + 86_400)?.attempt_count ?? null;
}

assert.equal(attempt(1_000), 1);
assert.equal(attempt(1_000), 2);
assert.equal(attempt(1_000), 3);
assert.equal(attempt(1_000), 4);
assert.equal(attempt(1_000), 5);
assert.equal(attempt(1_000), null, "sixth immediate guess must be throttled");
assert.equal(attempt(1_001), 6);
assert.equal(attempt(1_001), null, "cooldown must grow after each admitted guess");

// Drive the bucket to its strict 100-attempt ceiling by advancing the clock.
// 逐步推进合成时钟，使同一桶达到严格的 100 次尝试上限。
let count = 6;
while (count < 100) {
  const row = db.prepare("SELECT next_allowed_at FROM password_auth_attempts WHERE bucket_digest=?1").get(digest);
  count = attempt(row.next_allowed_at);
  assert.ok(count <= 100);
}
let row = db.prepare("SELECT attempt_count,next_allowed_at,expires_at FROM password_auth_attempts WHERE bucket_digest=?1").get(digest);
assert.equal(row.attempt_count, 100);
assert.equal(attempt(row.next_allowed_at), null, "the cap must hold even after backoff expires");
assert.equal(attempt(row.expires_at - 1), null, "denied requests must not extend lockout");
assert.equal(attempt(row.expires_at), 1, "24h inactivity must restore access");

const another = Buffer.alloc(32, 8);
assert.equal(attempt(1_000, another), 1, "unrelated buckets must remain independent");
db.prepare("DELETE FROM password_auth_attempts WHERE bucket_digest=?1").run(digest);
assert.equal(attempt(row.expires_at + 1), 1, "successful authentication clears its bucket");

assert.throws(() => db.prepare("INSERT INTO password_auth_attempts VALUES(?1,101,1000,1000,2000)").run(Buffer.alloc(32, 9)));
db.close();

// Verify the exact session INSERT cannot resurrect a deleted or rotated credential.
// 验证实际会话 INSERT 无法复活已删除或轮换的密码凭据。
const authority = new DatabaseSync(join(state, "authority.sqlite"));
authority.exec("PRAGMA foreign_keys=ON");
for (const number of ["0001_identity_foundation", "0002_account_foundation", "0003_open_registration", "0004_email_verification", "0005_oauth_pairwise_session", "0006_password_rate_limit"]) {
  authority.exec(readFileSync(join(root, `migrations/${number}.sql`), "utf8"));
}
authority.exec("INSERT INTO principals(principal_id,kind,lifecycle_state,webauthn_user_handle,created_at,updated_at,state_changed_at) VALUES('p1','human','active',zeroblob(32),1000,1000,1000)");
const hash = "$argon2id$v=19$m=19456,t=2,p=1$c29tZS1maXhlZC1zYWx0$MeZ7LaoKcHj8oWkYckLpDrLFIW8VOfUCFSSqu2V9fcI";
authority.prepare("INSERT INTO password_credentials(principal_id,password_hash,hash_algorithm,hash_parameters_json,password_version,created_at,updated_at) VALUES('p1',?1,'argon2id','{}',1,1000,1000)").run(hash);
const sessionMatch = source.match(/"INSERT INTO identity_sessions\([^"\n]+?\) SELECT \?1,[\s\S]*?c\.password_version=\?8"/);
assert.ok(sessionMatch, "guarded Worker session SQL not found");
const sessionSql = JSON.parse(sessionMatch[0]);
const issue = authority.prepare(sessionSql);
/** Attempt session insertion with the originally verified password authority. / 用最初验证的密码权限尝试插入会话。 */
function issueSession(id) {
  return issue.run(id, Buffer.alloc(32, 1), "p1", hash, 1001, 44_201, 2_593_001, 1).changes;
}
assert.equal(issueSession("s1"), 1, "current credential must authorize a session");
authority.exec("DELETE FROM password_credentials WHERE principal_id='p1'");
assert.equal(issueSession("s2"), 0, "deleted credential must not authorize a session");
authority.prepare("INSERT INTO password_credentials(principal_id,password_hash,hash_algorithm,hash_parameters_json,password_version,created_at,updated_at) VALUES('p1',?1,'argon2id','{}',2,1000,1002)").run(hash);
assert.equal(issueSession("s3"), 0, "even the same hash with a newer version must not authorize");
authority.exec("UPDATE principals SET lifecycle_state='suspended',updated_at=1003,state_changed_at=1003 WHERE principal_id='p1'");
assert.equal(issueSession("s4"), 0, "inactive principal must not authorize");
authority.close();
console.log("password rate limit and stale-credential authority: SQL policy, migration, and constraints passed");
