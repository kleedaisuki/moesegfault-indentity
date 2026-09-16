/**
 * Exercise populated D1 migrations instead of only the empty-database happy path.
 * 对含真实依赖行的 D1 执行迁移，避免只验证空数据库而漏掉外键重建错误。
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const stateDir = ".temp/migration-regression";
const database = "moesegfault-identity-staging";
const config = "wrangler.identity.jsonc";
const wrangler = "node_modules/wrangler/bin/wrangler.js";

// The target is a fixed repository-local directory, never caller-controlled.
// 目标是固定的仓库内目录，绝不使用调用方输入拼接删除路径。
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

/**
 * Run Wrangler against the isolated local D1 and enforce the expected outcome.
 * 对隔离的本地 D1 运行 Wrangler，并严格检查预期的成功或失败结果。
 *
 * @param {string[]} arguments_ Wrangler arguments after the executable path.
 * @param {boolean} [shouldSucceed=true] Whether a zero exit status is required.
 */
function runWrangler(arguments_, shouldSucceed = true) {
  const result = spawnSync(process.execPath, [wrangler, ...arguments_], {
    encoding: shouldSucceed ? undefined : "utf8",
    stdio: shouldSucceed ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;

  const succeeded = result.status === 0;
  if (succeeded === shouldSucceed) return;

  if (!shouldSucceed) {
    console.error("Expected D1 statement to fail, but it succeeded.");
  } else {
    process.stderr.write(result.stderr ?? "");
  }
  process.exit(result.status ?? 1);
}

/**
 * Execute a repository SQL file against the isolated migration database.
 * 对隔离的迁移数据库执行仓库中的 SQL 文件。
 *
 * @param {string} file Repository-relative SQL path.
 */
function executeFile(file) {
  runWrangler([
    "d1", "execute", database,
    "--local", `--persist-to=${stateDir}`, `--config=${config}`, `--file=${file}`,
  ]);
}

/**
 * Execute inline SQL, optionally asserting that a database constraint rejects it.
 * 执行内联 SQL，并可断言数据库约束必须拒绝该语句。
 *
 * @param {string} sql SQL statement.
 * @param {boolean} [shouldSucceed=true] Whether execution must succeed.
 */
function executeSql(sql, shouldSucceed = true) {
  runWrangler([
    "d1", "execute", database,
    "--local", `--persist-to=${stateDir}`, `--config=${config}`, `--command=${sql}`,
  ], shouldSucceed);
}

for (const file of [
  "migrations/0001_identity_foundation.sql",
  "migrations/tests/0002_populated_seed.sql",
  "migrations/0002_account_foundation.sql",
  "migrations/tests/0002_populated_assert.sql",
  "migrations/0003_open_registration.sql",
]) {
  executeFile(file);
}

// Exercise a populated upgrade from the deliberately replaced v1 transaction table.
// 对包含旧事务数据的数据库执行升级，验证有意替换 v1 临时事务表的路径。
executeSql("INSERT INTO identifiers(identifier_id,principal_id,kind,value,normalized_value,is_primary,verification_state,verified_at,created_at,updated_at) VALUES('email1','p1','email','klee@example.net','klee@example.net',1,'unverified',NULL,1000,1000)");
executeSql("INSERT INTO identifier_verification_transactions(transaction_id,identifier_id,code_digest,attempt_count,state,created_at,expires_at) VALUES('legacy-email-txn','email1',randomblob(32),0,'pending',1000,1600)");
executeFile("migrations/0004_email_verification.sql");

// Unverified contact values may coexist across accounts, but account-local duplicates
// and a second verified owner are rejected by distinct database constraints.
// 未验证联系方式可跨账号共存；同账号重复值和第二个已验证所有者由不同数据库约束拒绝。
executeSql("INSERT INTO principals VALUES('p2','human','active',randomblob(32),1000,1000,1000,NULL); INSERT INTO principals VALUES('p3','human','active',randomblob(32),1000,1000,1000,NULL)");
executeSql("INSERT INTO identifiers(identifier_id,principal_id,kind,value,normalized_value,is_primary,verification_state,verified_at,created_at,updated_at) VALUES('shared2','p2','email','shared@example.net','shared@example.net',0,'unverified',NULL,1000,1000); INSERT INTO identifiers(identifier_id,principal_id,kind,value,normalized_value,is_primary,verification_state,verified_at,created_at,updated_at) VALUES('shared3','p3','email','shared@example.net','shared@example.net',0,'unverified',NULL,1000,1000)");
executeSql("INSERT INTO identifiers(identifier_id,principal_id,kind,value,normalized_value,is_primary,verification_state,verified_at,created_at,updated_at) VALUES('same-account','p2','email','shared@example.net','shared@example.net',0,'unverified',NULL,1000,1000)", false);
executeSql("UPDATE identifiers SET verification_state='verified',verified_at=1100,updated_at=1100 WHERE identifier_id='shared2'");
executeSql("UPDATE identifiers SET verification_state='verified',verified_at=1100,updated_at=1100 WHERE identifier_id='shared3'", false);

const assertionFile = `${stateDir}/0004_assert.sql`;
writeFileSync(assertionFile, `
CREATE TABLE _0004_assertion (
    assertion TEXT PRIMARY KEY,
    passed INTEGER NOT NULL CHECK (passed = 1)
);
INSERT INTO _0004_assertion VALUES (
    'populated replacement is clean',
    (SELECT count(*) = 0 FROM identifier_verification_transactions)
);
INSERT INTO _0004_assertion VALUES (
    'cascade foreign key',
    (SELECT count(*) = 1 FROM pragma_foreign_key_list('identifier_verification_transactions')
     WHERE "table" = 'identifiers' AND "from" = 'identifier_id' AND on_delete = 'CASCADE')
);
INSERT INTO _0004_assertion VALUES (
    'required indexes',
    (SELECT count(*) = 5 FROM sqlite_schema WHERE type = 'index' AND name IN (
        'idx_identifier_verifications_one_pending',
        'idx_identifier_verifications_identifier_created',
        'idx_identifier_verifications_destination_created',
        'idx_identifier_verifications_expiry',
        'idx_email_verification_outbox_due'
    ))
);
INSERT INTO _0004_assertion VALUES (
    'identifier ownership indexes',
    (SELECT count(*) = 5 FROM sqlite_schema WHERE type = 'index' AND name IN (
        'idx_identifiers_principal',
        'idx_identifiers_primary_kind',
        'idx_identifiers_one_username',
        'idx_identifiers_unique_username_value',
        'idx_identifiers_unique_verified_contact'
    ))
);
INSERT INTO _0004_assertion VALUES (
    'foreign key integrity',
    (SELECT count(*) = 0 FROM pragma_foreign_key_check)
);
DROP TABLE _0004_assertion;
`, "utf8");
executeFile(assertionFile);

const validPending = "INSERT INTO identifier_verification_transactions(transaction_id,identifier_id,destination_digest,code_digest,attempt_count,state,created_at,expires_at) VALUES('email-txn','email1',randomblob(32),randomblob(32),0,'pending',2000,2600)";
executeSql(validPending);
executeSql("INSERT INTO email_verification_outbox(outbox_id,transaction_id,payload_ciphertext,payload_nonce,key_revision,template_revision,state,attempt_count,next_attempt_at,created_at) VALUES('outbox1','email-txn',randomblob(64),randomblob(24),1,1,'pending',0,2000,2000)");

// Constraint probes must be rejected without changing the valid pending transaction.
// 下列约束探针都必须被拒绝，且不得改变有效的待处理事务。
executeSql("INSERT INTO identifier_verification_transactions VALUES('duplicate-pending','email1',randomblob(32),randomblob(32),0,'pending',2001,2601,NULL)", false);
executeSql("INSERT INTO identifier_verification_transactions VALUES('text-digest','email1',printf('%032d',0),randomblob(32),0,'verified',2000,2600,2100)", false);
executeSql("INSERT INTO identifier_verification_transactions VALUES('short-code','email1',randomblob(32),randomblob(31),0,'verified',2000,2600,2100)", false);
executeSql("INSERT INTO identifier_verification_transactions VALUES('long-expiry','email1',randomblob(32),randomblob(32),0,'verified',2000,2601,2100)", false);
executeSql("INSERT INTO identifier_verification_transactions VALUES('pending-consumed','email1',randomblob(32),randomblob(32),0,'pending',2000,2600,2100)", false);
executeSql("INSERT INTO identifier_verification_transactions VALUES('finished-unconsumed','email1',randomblob(32),randomblob(32),0,'verified',2000,2600,NULL)", false);
executeSql("UPDATE email_verification_outbox SET payload_nonce=randomblob(12) WHERE outbox_id='outbox1'", false);
executeSql("UPDATE email_verification_outbox SET state='delivered',delivered_at=2100,next_attempt_at=NULL WHERE outbox_id='outbox1'", false);
executeSql("UPDATE email_verification_outbox SET state='sending' WHERE outbox_id='outbox1'", false);
executeSql("UPDATE email_verification_outbox SET state='delivered',payload_ciphertext=NULL,payload_nonce=NULL,next_attempt_at=NULL WHERE outbox_id='outbox1'", false);
executeSql("INSERT INTO identifier_verification_consumptions(transaction_id,consumed_at) VALUES('email-txn',2100)");
executeSql("INSERT INTO identifier_verification_consumptions(transaction_id,consumed_at) VALUES('email-txn',2101)", false);

// ON DELETE CASCADE is part of the contact lifecycle contract, not cleanup best effort.
// ON DELETE CASCADE 是联系方式生命周期契约，而不是尽力清理。
executeSql("DELETE FROM identifiers WHERE identifier_id='email1'");
executeSql("CREATE TABLE _cascade_assert(passed INTEGER CHECK(passed=1)); INSERT INTO _cascade_assert VALUES((SELECT (SELECT count(*) FROM identifier_verification_transactions WHERE identifier_id='email1')=0 AND (SELECT count(*) FROM identifier_verification_consumptions WHERE transaction_id='email-txn')=0 AND (SELECT count(*) FROM email_verification_outbox WHERE outbox_id='outbox1')=0)); DROP TABLE _cascade_assert");
