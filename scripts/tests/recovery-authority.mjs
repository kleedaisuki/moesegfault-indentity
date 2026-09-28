/**
 * Exercise the recovery authority SQL against the real foundation schema.
 * 用真实基础 schema 验证恢复操作会撤销旧的密码和联合登录权限。
 *
 * Run / 运行：node scripts/tests/recovery-authority.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../../", import.meta.url);
const source = readFileSync(new URL("crates/identity-worker/src/repository.rs", root), "utf8");

/** Read the exact SQL used by recovery, so this regression test follows implementation changes. / 提取恢复实现实际使用的 SQL。 */
function recoverySql(name) {
  const match = source.match(new RegExp(`const ${name}: &str =\\s*"([^"]+)";`));
  assert.ok(match, `Missing recovery SQL constant ${name}`);
  return match[1];
}

/** Construct an FK-enforced database with the deployed foundation tables. / 用部署的基础表建立强制外键的数据库。 */
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of [
    "0001_identity_foundation.sql",
    "0002_account_foundation.sql",
    "0003_open_registration.sql",
    "0004_email_verification.sql",
    "0005_oauth_pairwise_session.sql",
    "0006_password_rate_limit.sql",
  ]) {
    db.exec(readFileSync(new URL(`migrations/${file}`, root), "utf8"));
  }
  return db;
}

/** Seed old login authorities and a referenced provider binding. / 创建旧登录权限及带外键引用的提供者绑定。 */
function seed(db) {
  db.exec(`
    INSERT INTO principals(principal_id,kind,lifecycle_state,webauthn_user_handle,created_at,updated_at,state_changed_at)
      VALUES('owner','human','active',randomblob(32),1000,1000,1000),
            ('other','human','active',randomblob(32),1000,1000,1000);
    INSERT INTO password_credentials(principal_id,password_hash,created_at,updated_at)
      VALUES('owner','abcdefghijklmnopqrstuvwxyzABCDEF',1000,1000),
            ('other','abcdefghijklmnopqrstuvwxyzABCDEF',1000,1000);
    INSERT INTO identifiers(identifier_id,principal_id,kind,value,normalized_value,is_primary,verification_state,verified_at,created_at,updated_at)
      VALUES('owner-name','owner','username','owner','owner',1,'verified',1000,1000,1000);
    INSERT INTO binding_providers(provider_id,issuer,display_name,authorization_endpoint,token_endpoint,jwks_uri,client_id,scope,policy_revision,authentication_enabled,state,created_at,updated_at)
      VALUES('provider','https://provider.example','Provider','https://provider.example/auth',
             'https://provider.example/token','https://provider.example/jwks','client','openid',1,1,'enabled',1000,1000);
    INSERT INTO identity_bindings(binding_id,principal_id,provider_id,issuer,subject,kind,authentication_enabled,created_at)
      VALUES('old-binding','owner','provider','https://provider.example','old-sub','federated_human',1,1000),
            ('other-binding','other','provider','https://provider.example','other-sub','federated_human',1,1000);
    INSERT INTO authenticators(authenticator_id,principal_id,credential_id,public_key_cose,sign_count,aaguid,backup_eligible,backup_state,label,created_at)
      VALUES('old-key','owner',randomblob(32),randomblob(64),0,randomblob(16),0,0,'Old key',1000),
            ('new-key','owner',randomblob(32),randomblob(64),0,randomblob(16),0,0,'New key',2000);
    INSERT INTO identity_sessions(session_id,session_digest,principal_id,authenticator_id,binding_id,auth_method,amr_json,acr,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES('old-session',randomblob(32),'owner',NULL,'old-binding','federated','["federated"]','urn:test',1000,1000,3000,4000);
    INSERT INTO binding_transactions(transaction_id,principal_id,provider_id,identity_session_id,provider_state_digest,pkce_verifier_ciphertext,pkce_verifier_nonce,pkce_key_revision,csrf_digest,redirect_uri,policy_revision,state,created_at,expires_at,consumed_at,result_binding_id)
      VALUES('old-link','owner','provider','old-session',randomblob(32),randomblob(32),randomblob(12),1,randomblob(32),
             'https://identity.example/callback',1,'consumed_success',1000,1500,1200,'old-binding');
    INSERT INTO recovery_code_sets(recovery_code_set_id,principal_id,created_at)
      VALUES('old-set','owner',1000);
    INSERT INTO recovery_codes(recovery_code_id,recovery_code_set_id,public_id,secret_digest,created_at)
      VALUES('used-code','old-set','USED1234',randomblob(32),1000);
    INSERT INTO recovery_transactions(transaction_id,recovery_code_id,principal_id,browser_binding_digest,csrf_digest,challenge_digest,rp_id,expected_origin,authenticator_label,request_json,created_at,expires_at)
      VALUES('old-recovery','used-code','owner',randomblob(32),randomblob(32),randomblob(32),
             'login.example','https://login.example','New key','{}',1000,3000);
    INSERT INTO recovery_code_uses(recovery_code_id,recovery_transaction_id,request_digest,used_at)
      VALUES('used-code','old-recovery',randomblob(32),1500);
  `);
}

const deletePassword = recoverySql("RECOVERY_DELETE_PASSWORD_SQL");
const revokeBindings = recoverySql("RECOVERY_REVOKE_BINDINGS_SQL");
const db = database();
seed(db);
const passwordLogin = db.prepare("SELECT count(*) AS n FROM identifiers i JOIN principals p ON p.principal_id=i.principal_id JOIN password_credentials c ON c.principal_id=p.principal_id WHERE i.kind='username' AND i.normalized_value='owner' AND p.lifecycle_state='active'");
const providerLogin = db.prepare("SELECT count(*) AS n FROM identity_bindings b JOIN binding_providers p ON p.provider_id=b.provider_id WHERE b.issuer='https://provider.example' AND b.subject='old-sub' AND b.revoked_at IS NULL AND b.authentication_enabled=1 AND p.state='enabled' AND p.authentication_enabled=1");
assert.equal(passwordLogin.get().n, 1);
assert.equal(providerLogin.get().n, 1);

// A committed recovery removes the old password and deauthorizes, rather than deletes,
// the referenced binding. / 已提交恢复删除旧密码并禁用（不删除）有外键引用的绑定。
db.exec("BEGIN IMMEDIATE");
db.prepare("UPDATE authenticators SET revoked_at=?3 WHERE principal_id=?1 AND authenticator_id<>?2 AND revoked_at IS NULL")
  .run("owner", "new-key", 2000);
db.prepare(deletePassword).run("owner");
db.prepare(revokeBindings).run("owner", 2000);
db.prepare("UPDATE identity_sessions SET revoked_at=?2,revocation_reason='account_recovery' WHERE principal_id=?1 AND revoked_at IS NULL")
  .run("owner", 2000);
db.exec("COMMIT");

assert.equal(db.prepare("SELECT count(*) AS n FROM password_credentials WHERE principal_id='owner'").get().n, 0);
assert.equal(db.prepare("SELECT count(*) AS n FROM password_credentials WHERE principal_id='other'").get().n, 1);
assert.equal(passwordLogin.get().n, 0, "the password login lookup must no longer find the old verifier");
assert.equal(providerLogin.get().n, 0, "the provider binding must no longer carry login authority");
assert.deepEqual({ ...db.prepare("SELECT authentication_enabled,revoked_at FROM identity_bindings WHERE binding_id='old-binding'").get() },
  { authentication_enabled: 0, revoked_at: 2000 });
assert.deepEqual({ ...db.prepare("SELECT authentication_enabled,revoked_at FROM identity_bindings WHERE binding_id='other-binding'").get() },
  { authentication_enabled: 1, revoked_at: null });
assert.equal(db.prepare("SELECT result_binding_id FROM binding_transactions WHERE transaction_id='old-link'").get().result_binding_id,
  "old-binding", "revocation must preserve audit/transaction FKs");
assert.deepEqual(db.prepare("SELECT authenticator_id,revoked_at FROM authenticators WHERE principal_id='owner' ORDER BY authenticator_id").all().map((row) => ({ ...row })),
  [{ authenticator_id: "new-key", revoked_at: null }, { authenticator_id: "old-key", revoked_at: 2000 }]);
assert.equal(db.prepare("SELECT revoked_at FROM identity_sessions WHERE session_id='old-session'").get().revoked_at, 2000);
assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

// A later constraint failure rolls back an earlier authority mutation in the
// same batch. / 同批次后续约束失败须回滚先前的权限变更。
db.exec("BEGIN IMMEDIATE");
db.prepare(deletePassword).run("other");
assert.throws(() => db.prepare("INSERT INTO recovery_code_uses(recovery_code_id,recovery_transaction_id,request_digest,used_at) VALUES(?1,?2,randomblob(32),?3)").run("used-code", "old-recovery", 2000), /recovery_code_not_consumable|UNIQUE constraint failed/);
db.exec("ROLLBACK");
assert.equal(db.prepare("SELECT count(*) AS n FROM password_credentials WHERE principal_id='other'").get().n, 1);
assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
console.log("Recovery authority SQL: old password and binding revoked; new key and FK history preserved.");
