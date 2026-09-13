//! 外部身份 Binding 的 D1 持久化。/ D1 persistence for external identity bindings.

use serde::{Deserialize, Serialize};
use worker::{D1Database, D1SessionConstraint, Result, wasm_bindgen::JsValue};

/// 满足近期 Passkey 再认证要求的当前会话。
/// Current session satisfying the recent-Passkey step-up requirement.
#[derive(Debug, Deserialize)]
pub struct StepUpSession {
    pub session_id: String,
    pub principal_id: String,
}

/// 返回给账号管理 UI 的非敏感 Binding 投影。
/// Non-sensitive binding projection returned to the account-management UI.
#[derive(Debug, Deserialize, Serialize)]
pub struct BindingView {
    pub binding_id: String,
    pub provider_id: String,
    pub metadata_json: String,
    pub authentication_enabled: bool,
    pub created_at: i64,
    pub last_authenticated_at: Option<i64>,
}

/// Callback 完成所需的最小事务材料。/ Minimal transaction material needed by the callback.
#[derive(Debug, Deserialize)]
pub struct BindingTransactionRow {
    pub transaction_id: String,
    pub principal_id: String,
    pub provider_id: String,
    pub pkce_verifier_ciphertext: Vec<u8>,
    pub pkce_verifier_nonce: Vec<u8>,
    pub pkce_key_revision: i64,
    pub redirect_uri: String,
    pub policy_revision: i64,
    pub state: String,
    pub expires_at: i64,
}

/// 已完成 POST 的幂等索引。/ Idempotency index for a completed POST.
#[derive(Debug, Deserialize)]
pub struct IdempotencyResult {
    pub request_digest: Vec<u8>,
    pub result_reference: Option<String>,
}

/// 由 Worker 配置生成、用于同步 D1 外键目标的 provider 记录。
/// Provider row derived from Worker configuration and used to synchronize the D1 FK target.
pub struct RegistryProvider<'a> {
    pub provider_id: &'a str,
    pub issuer: &'a str,
    pub display_name: &'a str,
    pub authorization_endpoint: &'a str,
    pub token_endpoint: &'a str,
    pub jwks_uri: &'a str,
    pub client_id: &'a str,
    pub scope: &'a str,
    pub policy_revision: i64,
    pub authentication_enabled: bool,
}

/// 读取仍有效且由近期 UV Passkey 建立的会话。
/// Resolves an unexpired session established by a recent user-verified Passkey.
pub async fn recent_passkey_session(
    db: &D1Database,
    session_digest: &[u8],
    now: i64,
    earliest_authentication: i64,
) -> Result<Option<StepUpSession>> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare(
            "SELECT s.session_id,s.principal_id FROM identity_sessions s \
             JOIN principals p ON p.principal_id=s.principal_id \
             WHERE s.session_digest=?1 AND s.revoked_at IS NULL \
               AND s.idle_expires_at>?2 AND s.absolute_expires_at>?2 \
               AND s.auth_method='passkey' AND s.acr='urn:moesegfault:acr:passkey-uv' \
               AND s.authenticated_at>=?3 AND p.lifecycle_state='active'",
        )
        .bind(&[
            blob(session_digest),
            integer(now),
            integer(earliest_authentication),
        ])?
        .first(None)
        .await
}

/// 读取任意有效会话，供只读 Binding 资源使用。
/// Resolves any valid session for read-only binding resources.
pub async fn current_session(
    db: &D1Database,
    session_digest: &[u8],
    now: i64,
) -> Result<Option<StepUpSession>> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare(
            "SELECT s.session_id,s.principal_id FROM identity_sessions s \
             JOIN principals p ON p.principal_id=s.principal_id \
             WHERE s.session_digest=?1 AND s.revoked_at IS NULL \
               AND s.idle_expires_at>?2 AND s.absolute_expires_at>?2 \
               AND p.lifecycle_state='active'",
        )
        .bind(&[blob(session_digest), integer(now)])?
        .first(None)
        .await
}

/// 验证显式 Worker 配置与 deployment-owned D1 外键目标完全一致。
/// Verifies that explicit Worker configuration exactly matches the deployment-owned D1 FK target.
///
/// HTTP 输入从不进入此函数；配置始终是 issuer 与 endpoint 的唯一权威来源。
/// HTTP input never reaches this function; configuration remains the sole authority for issuer
/// and endpoint values.
pub async fn provider_configuration_matches(
    db: &D1Database,
    provider: &RegistryProvider<'_>,
) -> Result<bool> {
    let present = db
        .with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare(
            "SELECT 1 AS present FROM binding_providers WHERE provider_id=?1 AND issuer=?2 \
         AND display_name=?3 AND authorization_endpoint=?4 AND token_endpoint=?5 AND jwks_uri=?6 \
         AND client_id=?7 AND scope=?8 AND policy_revision=?9 AND authentication_enabled=?10 \
         AND state='enabled'",
        )
        .bind(&[
            text(provider.provider_id),
            text(provider.issuer),
            text(provider.display_name),
            text(provider.authorization_endpoint),
            text(provider.token_endpoint),
            text(provider.jwks_uri),
            text(provider.client_id),
            text(provider.scope),
            integer(provider.policy_revision),
            integer(i64::from(provider.authentication_enabled)),
        ])?
        .first::<i64>(Some("present"))
        .await?;
    Ok(present == Some(1))
}

/// 插入一次性 state 与静态加密的 PKCE/nonce 材料。
/// Inserts one-time state and statically encrypted PKCE/nonce material.
#[allow(clippy::too_many_arguments)]
pub async fn insert_transaction(
    db: &D1Database,
    transaction_id: &str,
    principal_id: &str,
    provider_id: &str,
    identity_session_id: &str,
    state_digest: &[u8],
    ciphertext: &[u8],
    nonce: &[u8],
    key_revision: i64,
    csrf_digest: &[u8],
    redirect_uri: &str,
    policy_revision: i64,
    now: i64,
    expires_at: i64,
    idempotency_record_id: &str,
    idempotency_key: &str,
    request_digest: &[u8],
) -> Result<()> {
    db.batch(vec![
        // Expired rows no longer own the key. Keeping this delete in the same batch makes reuse
        // linearizable with the new transaction and completed idempotency record.
        db.prepare(
            "DELETE FROM idempotency_records WHERE caller_fingerprint=?1 \
             AND operation='createBindingTransaction' AND idempotency_key=?2 AND expires_at<=?3",
        )
        .bind(&[
            text(principal_id),
            text(idempotency_key),
            integer(now),
        ])?,
        db.prepare(
            "INSERT INTO binding_transactions(transaction_id,principal_id,provider_id,identity_session_id,provider_state_digest,pkce_verifier_ciphertext,pkce_verifier_nonce,pkce_key_revision,csrf_digest,redirect_uri,policy_revision,created_at,expires_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        )
        .bind(&[
            text(transaction_id),
            text(principal_id),
            text(provider_id),
            text(identity_session_id),
            blob(state_digest),
            blob(ciphertext),
            blob(nonce),
            integer(key_revision),
            blob(csrf_digest),
            text(redirect_uri),
            integer(policy_revision),
            integer(now),
            integer(expires_at),
        ])?,
        db.prepare(
            "INSERT INTO idempotency_records(idempotency_record_id,caller_fingerprint,operation,idempotency_key,request_digest,state,response_status,result_reference,created_at,expires_at,completed_at) \
             VALUES(?1,?2,'createBindingTransaction',?3,?4,'completed',201,?5,?6,?7,?6)",
        )
        .bind(&[
            text(idempotency_record_id),
            text(principal_id),
            text(idempotency_key),
            blob(request_digest),
            text(transaction_id),
            integer(now),
            integer(now + 86_400),
        ])?,
    ])
    .await?;
    Ok(())
}

/// 读取 POST 幂等结果；调用方仍须恒时比较 request digest。
/// Loads a POST idempotency result; the caller must still compare the request digest in constant
/// time.
pub async fn idempotency_result(
    db: &D1Database,
    principal_id: &str,
    idempotency_key: &str,
    now: i64,
) -> Result<Option<IdempotencyResult>> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare(
            "SELECT request_digest,result_reference FROM idempotency_records \
             WHERE caller_fingerprint=?1 AND operation='createBindingTransaction' \
               AND idempotency_key=?2 AND expires_at>?3 AND state='completed'",
        )
        .bind(&[text(principal_id), text(idempotency_key), integer(now)])?
        .first(None)
        .await
}

/// 读取幂等重放需要的未过期事务。/ Loads an unexpired transaction needed for idempotent replay.
pub async fn transaction_by_id(
    db: &D1Database,
    transaction_id: &str,
    principal_id: &str,
    now: i64,
) -> Result<Option<BindingTransactionRow>> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare(
            "SELECT transaction_id,principal_id,provider_id,pkce_verifier_ciphertext,pkce_verifier_nonce,pkce_key_revision,redirect_uri,policy_revision,state,expires_at \
             FROM binding_transactions WHERE transaction_id=?1 AND principal_id=?2 AND expires_at>?3",
        )
        .bind(&[text(transaction_id), text(principal_id), integer(now)])?
        .first(None)
        .await
}

/// 通过不可逆 state digest 读取事务，并再次确认原 Passkey 会话仍有效。
/// Loads a transaction by irreversible state digest and rechecks its originating Passkey session.
pub async fn transaction_by_state(
    db: &D1Database,
    state_digest: &[u8],
    now: i64,
    earliest_authentication: i64,
) -> Result<Option<BindingTransactionRow>> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare(
            "SELECT t.transaction_id,t.principal_id,t.provider_id,t.pkce_verifier_ciphertext,t.pkce_verifier_nonce,t.pkce_key_revision,t.redirect_uri,t.policy_revision,t.state,t.expires_at \
             FROM binding_transactions t \
             JOIN identity_sessions s ON s.session_id=t.identity_session_id AND s.principal_id=t.principal_id \
             JOIN principals p ON p.principal_id=t.principal_id \
             WHERE t.provider_state_digest=?1 AND t.state='pending' \
               AND t.expires_at>?2 AND s.revoked_at IS NULL \
               AND s.idle_expires_at>?2 AND s.absolute_expires_at>?2 \
               AND s.auth_method='passkey' AND s.acr='urn:moesegfault:acr:passkey-uv' \
               AND s.authenticated_at>=?3 AND p.lifecycle_state='active'",
        )
        .bind(&[
            blob(state_digest),
            integer(now),
            integer(earliest_authentication),
        ])?
        .first(None)
        .await
}

/// 列出账号的有效外部身份 Binding。/ Lists active external identity bindings for an account.
pub async fn bindings(db: &D1Database, principal_id: &str) -> Result<Vec<BindingView>> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)?.prepare(
        "SELECT binding_id,provider_id,metadata_json,authentication_enabled,created_at,last_authenticated_at \
         FROM identity_bindings WHERE principal_id=?1 AND revoked_at IS NULL ORDER BY binding_id",
    )
    .bind(&[text(principal_id)])?
    .all()
    .await?
    .results()
}

/// 判断指定 Binding 是否属于该账号（含已撤销记录），以保持 DELETE 重放为 204。
/// Checks whether a binding belongs to the account, including revoked rows, so DELETE replay stays
/// a 204 response.
pub async fn binding_active(
    db: &D1Database,
    principal_id: &str,
    binding_id: &str,
) -> Result<Option<bool>> {
    let value = db
        .with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare(
            "SELECT revoked_at IS NULL AS active FROM identity_bindings WHERE principal_id=?1 AND binding_id=?2",
        )
        .bind(&[text(principal_id), text(binding_id)])?
        .first::<bool>(Some("active"))
        .await?;
    Ok(value)
}

/// 原子创建唯一 `(issuer, subject)` Binding 并消费 callback 事务。
/// Atomically creates the unique `(issuer, subject)` binding and consumes the callback transaction.
#[allow(clippy::too_many_arguments)]
pub async fn commit_binding(
    db: &D1Database,
    tx: &BindingTransactionRow,
    binding_id: &str,
    issuer: &str,
    subject: &str,
    authentication_enabled: bool,
    request_digest: &[u8],
    audit_id: &str,
    correlation: &str,
    now: i64,
    earliest_authentication: i64,
) -> Result<()> {
    let context = serde_json::to_string(&serde_json::json!({"provider_id":tx.provider_id}))?;
    db.batch(vec![
        // INSERT .. SELECT makes callback-time session authority an atomic write predicate.
        db.prepare("INSERT INTO identity_bindings(binding_id,principal_id,provider_id,issuer,subject,kind,metadata_json,authentication_enabled,created_at) \
                    SELECT ?1,t.principal_id,t.provider_id,?4,?5,'federated_human','{}',?6,?7 \
                    FROM binding_transactions t \
                    JOIN identity_sessions s ON s.session_id=t.identity_session_id AND s.principal_id=t.principal_id \
                    JOIN principals p ON p.principal_id=t.principal_id \
                    WHERE t.transaction_id=?8 AND t.principal_id=?2 AND t.provider_id=?3 \
                      AND t.state='pending' AND t.expires_at>=?7 \
                      AND s.revoked_at IS NULL AND s.idle_expires_at>?7 AND s.absolute_expires_at>?7 \
                      AND s.auth_method='passkey' AND s.acr='urn:moesegfault:acr:passkey-uv' \
                      AND s.authenticated_at>=?9 AND p.lifecycle_state='active'")
            .bind(&[text(binding_id),text(&tx.principal_id),text(&tx.provider_id),text(issuer),text(subject),integer(i64::from(authentication_enabled)),integer(now),text(&tx.transaction_id),integer(earliest_authentication)])?,
        db.prepare("INSERT INTO binding_transaction_consumptions(transaction_id,request_digest,outcome,result_binding_id,consumed_at) VALUES(?1,?2,'success',?3,?4)")
            .bind(&[text(&tx.transaction_id),blob(request_digest),text(binding_id),integer(now)])?,
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision,context_json) VALUES(?1,'identity.binding.created',?2,?2,?3,?3,'success',?4,?5,?6)")
            .bind(&[text(audit_id),integer(now),text(&tx.principal_id),text(correlation),integer(tx.policy_revision),text(&context)])?,
        db.prepare("INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) VALUES(?1,?2,?3)")
            .bind(&[text(audit_id),text(&archive_key(now,audit_id)),integer(now)])?,
    ]).await?;
    Ok(())
}

/// 原子记录 callback 失败，使 state 不能再次消费。
/// Atomically records callback failure so the state cannot be consumed again.
pub async fn commit_callback_failure(
    db: &D1Database,
    tx: &BindingTransactionRow,
    request_digest: &[u8],
    audit_id: &str,
    correlation: &str,
    reason: &str,
    now: i64,
) -> Result<()> {
    let context = serde_json::to_string(&serde_json::json!({"provider_id":tx.provider_id}))?;
    db.batch(vec![
        db.prepare("INSERT INTO binding_transaction_consumptions(transaction_id,request_digest,outcome,consumed_at) VALUES(?1,?2,'failure',?3)")
            .bind(&[text(&tx.transaction_id),blob(request_digest),integer(now)])?,
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,actor_principal_id,subject_principal_id,outcome,reason_code,correlation_id,policy_revision,context_json) VALUES(?1,'identity.binding.failed',?2,?2,?3,?3,'failure',?4,?5,?6,?7)")
            .bind(&[text(audit_id),integer(now),text(&tx.principal_id),text(reason),text(correlation),integer(tx.policy_revision),text(&context)])?,
        db.prepare("INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) VALUES(?1,?2,?3)")
            .bind(&[text(audit_id),text(&archive_key(now,audit_id)),integer(now)])?,
    ]).await?;
    Ok(())
}

/// 撤销 Binding 以及所有由它建立的会话。/ Revokes a binding and every session established by it.
#[allow(clippy::too_many_arguments)]
pub async fn revoke_binding(
    db: &D1Database,
    principal_id: &str,
    binding_id: &str,
    identity_session_id: &str,
    audit_id: &str,
    correlation: &str,
    now: i64,
    earliest_authentication: i64,
) -> Result<bool> {
    db.batch(vec![
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision,context_json) SELECT ?1,'identity.binding.revoked',?2,?2,b.principal_id,b.principal_id,'success',?3,1,json_object('binding_id',b.binding_id) FROM identity_bindings b JOIN identity_sessions s ON s.session_id=?6 AND s.principal_id=b.principal_id JOIN principals p ON p.principal_id=b.principal_id WHERE b.principal_id=?4 AND b.binding_id=?5 AND b.revoked_at IS NULL AND s.revoked_at IS NULL AND s.idle_expires_at>?2 AND s.absolute_expires_at>?2 AND s.auth_method='passkey' AND s.acr='urn:moesegfault:acr:passkey-uv' AND s.authenticated_at>=?7 AND p.lifecycle_state='active'")
            .bind(&[text(audit_id),integer(now),text(correlation),text(principal_id),text(binding_id),text(identity_session_id),integer(earliest_authentication)])?,
        db.prepare("UPDATE identity_bindings SET revoked_at=?3 WHERE principal_id=?1 AND binding_id=?2 AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM security_audit_events WHERE audit_event_id=?4)")
            .bind(&[text(principal_id),text(binding_id),integer(now),text(audit_id)])?,
        db.prepare("UPDATE identity_sessions SET revoked_at=?3,revocation_reason='binding_revoked' WHERE principal_id=?1 AND binding_id=?2 AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM security_audit_events WHERE audit_event_id=?4)")
            .bind(&[text(principal_id),text(binding_id),integer(now),text(audit_id)])?,
        db.prepare("INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM security_audit_events WHERE audit_event_id=?1)")
            .bind(&[text(audit_id),text(&archive_key(now,audit_id)),integer(now)])?,
    ]).await?;
    let committed = db
        .with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare("SELECT 1 AS present FROM security_audit_events WHERE audit_event_id=?1")
        .bind(&[text(audit_id)])?
        .first::<i64>(Some("present"))
        .await?;
    Ok(committed == Some(1))
}

fn archive_key(now: i64, audit_id: &str) -> String {
    format!("security-audit/unix-day-{}/{audit_id}.json", now / 86_400)
}

fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

fn integer(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}

fn blob(value: &[u8]) -> JsValue {
    worker::js_sys::Uint8Array::from(value).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_keys_are_stable_and_partitioned() {
        assert_eq!(
            archive_key(172_800, "audit"),
            "security-audit/unix-day-2/audit.json"
        );
    }
}
