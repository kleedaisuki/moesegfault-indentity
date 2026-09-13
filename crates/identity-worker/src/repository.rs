//! D1/R2 持久化适配器。/ D1/R2 persistence adapter.

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use worker::{
    Conditional, D1Database, D1SessionConstraint, Env, Error, Result, wasm_bindgen::JsValue,
};

/// D1 中待完成的 WebAuthn 事务。/ Pending WebAuthn transaction stored in D1.
#[derive(Debug, Deserialize)]
pub struct WebauthnTransactionRow {
    pub transaction_id: String,
    pub kind: String,
    pub principal_id: Option<String>,
    pub registration_capability_id: Option<String>,
    pub challenge_digest: Vec<u8>,
    pub browser_binding_digest: Vec<u8>,
    pub csrf_digest: Vec<u8>,
    pub request_json: String,
    pub policy_revision: i64,
    pub state: String,
    pub expires_at: i64,
}

/// 已登记 credential 与主体信息。/ Registered credential plus principal information.
#[derive(Debug, Deserialize)]
pub struct CredentialRow {
    pub authenticator_id: String,
    pub principal_id: String,
    pub credential_id: Vec<u8>,
    pub public_key_cose: Vec<u8>,
    pub sign_count: u32,
    pub transports_json: String,
    pub aaguid: Vec<u8>,
    pub lifecycle_state: String,
}

/// 当前会话查询结果。/ Current-session query result.
#[derive(Debug, Deserialize)]
pub struct CurrentSession {
    pub session_id: String,
    pub principal_id: String,
}

#[derive(Debug, Deserialize)]
pub struct PrincipalView {
    pub principal_id: String,
    pub lifecycle_state: String,
    pub display_name: String,
    pub locale: String,
    pub username: String,
}

/// 可启动恢复 ceremony 的一次性恢复码投影。
/// Projection of a one-time recovery code eligible to start a ceremony.
#[derive(Debug, Deserialize)]
pub struct RecoveryIdentityRow {
    pub recovery_code_id: String,
    pub principal_id: String,
    pub webauthn_user_handle: Vec<u8>,
    pub username: String,
    pub display_name: String,
}

/// 待完成的恢复事务。/ Pending recovery transaction.
#[derive(Debug, Deserialize)]
pub struct RecoveryTransactionRow {
    pub transaction_id: String,
    pub recovery_code_id: String,
    pub principal_id: String,
    pub browser_binding_digest: Vec<u8>,
    pub csrf_digest: Vec<u8>,
    pub challenge_digest: Vec<u8>,
    pub authenticator_label: String,
    pub request_json: String,
    pub state: String,
    pub expires_at: i64,
}

/// 新生成且只展示一次的恢复码持久化材料。
/// Persistence material for a newly generated, one-time-disclosed recovery code.
pub struct NewRecoveryCode {
    pub recovery_code_id: String,
    pub public_id: String,
    pub secret_digest: [u8; 32],
}

#[derive(Debug, Deserialize)]
struct RegistrationPolicyRow {
    mode: String,
    revision: i64,
}

/// 可公开披露的注册策略。/ Publicly disclosable registration policy.
#[derive(Debug, Serialize)]
pub struct RegistrationPolicyView {
    pub mode: String,
    pub capability_required: bool,
    pub policy_revision: i64,
}

/// 读取当前公开注册模式。/ Reads the current public registration mode.
pub async fn registration_policy(db: &D1Database) -> Result<Option<RegistrationPolicyView>> {
    let row = db
        .with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare("SELECT mode,revision FROM registration_policy WHERE policy_id=1")
        .first::<RegistrationPolicyRow>(None)
        .await?;
    Ok(row.map(|row| RegistrationPolicyView {
        capability_required: row.mode == "invite_only",
        mode: row.mode,
        policy_revision: row.revision,
    }))
}

/// 注册入口的策略决定。/ Registration-entry policy decision.
pub struct RegistrationDecision {
    pub policy_revision: i64,
    pub capability_id: Option<String>,
}

/// 读取并验证 open/invite-only 注册策略。
/// Reads and validates the open/invite-only registration policy.
pub async fn registration_decision(
    db: &D1Database,
    invite_public_id: Option<&str>,
    invite_digest: Option<&[u8]>,
    now: i64,
) -> Result<Option<RegistrationDecision>> {
    let session = db.with_session_constraint(D1SessionConstraint::FirstPrimary)?;
    let policy = session
        .prepare("SELECT mode, revision FROM registration_policy WHERE policy_id = 1")
        .first::<RegistrationPolicyRow>(None)
        .await?;
    let Some(policy) = policy else {
        return Ok(None);
    };
    if policy.mode == "open" {
        return Ok(Some(RegistrationDecision {
            policy_revision: policy.revision,
            capability_id: None,
        }));
    }
    if policy.mode != "invite_only" {
        return Ok(None);
    }
    let (Some(public_id), Some(digest)) = (invite_public_id, invite_digest) else {
        return Ok(None);
    };
    #[derive(Deserialize)]
    struct Capability {
        capability_id: String,
        policy_revision: i64,
    }
    let row = session
        .prepare(
            "SELECT capability_id, policy_revision FROM registration_capabilities \
             WHERE public_id = ?1 AND secret_digest = ?2 AND consumed_at IS NULL \
             AND revoked_at IS NULL AND expires_at > ?3",
        )
        .bind(&[text(public_id), blob(digest), integer(now)])?
        .first::<Capability>(None)
        .await?;
    Ok(row.map(|c| RegistrationDecision {
        policy_revision: c.policy_revision,
        capability_id: Some(c.capability_id),
    }))
}

/// 插入 WebAuthn transaction。/ Inserts a WebAuthn transaction.
#[allow(clippy::too_many_arguments)]
pub async fn insert_webauthn_transaction(
    db: &D1Database,
    id: &str,
    kind: &str,
    principal_id: Option<&str>,
    capability_id: Option<&str>,
    challenge_digest: &[u8],
    browser_digest: &[u8],
    csrf_digest: &[u8],
    rp_id: &str,
    expected_origin: &str,
    request_json: &str,
    policy_revision: i64,
    now: i64,
    expires_at: i64,
) -> Result<()> {
    db.prepare(
        "INSERT INTO webauthn_transactions(\
         transaction_id,kind,principal_id,registration_capability_id,challenge_digest,\
         browser_binding_digest,csrf_digest,rp_id,expected_origin,policy_revision,request_json,\
         state,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,\
         ?8,?9,?10,?11,'pending',?12,?13)",
    )
    .bind(&[
        text(id),
        text(kind),
        optional_text(principal_id),
        optional_text(capability_id),
        blob(challenge_digest),
        blob(browser_digest),
        blob(csrf_digest),
        text(rp_id),
        text(expected_origin),
        integer(policy_revision),
        text(request_json),
        integer(now),
        integer(expires_at),
    ])?
    .run()
    .await?;
    Ok(())
}

/// 从主库读取待消费事务。/ Reads a transaction to be consumed from the primary.
pub async fn webauthn_transaction(
    db: &D1Database,
    id: &str,
) -> Result<Option<WebauthnTransactionRow>> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare("SELECT * FROM webauthn_transactions WHERE transaction_id = ?1")
        .bind(&[text(id)])?
        .first(None)
        .await
}

/// 按 credential ID 读取活动认证器。/ Reads an active authenticator by credential ID.
pub async fn credential_by_id(
    db: &D1Database,
    credential_id: &[u8],
) -> Result<Option<CredentialRow>> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare(
            "SELECT a.authenticator_id,a.principal_id,a.credential_id,a.public_key_cose,\
             a.sign_count,a.transports_json,a.aaguid,p.lifecycle_state FROM authenticators a \
             JOIN principals p ON p.principal_id=a.principal_id \
             WHERE a.credential_id=?1 AND a.revoked_at IS NULL",
        )
        .bind(&[blob(credential_id)])?
        .first(None)
        .await
}

pub async fn recovery_identity(
    db: &D1Database,
    public_id: &str,
    secret_digest: &[u8],
) -> Result<Option<RecoveryIdentityRow>> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare("SELECT c.recovery_code_id,s.principal_id,p.webauthn_user_handle,COALESCE(i.value,p.principal_id) AS username,h.display_name FROM recovery_codes c JOIN recovery_code_sets s ON s.recovery_code_set_id=c.recovery_code_set_id JOIN principals p ON p.principal_id=s.principal_id LEFT JOIN identifiers i ON i.principal_id=p.principal_id AND i.kind='username' JOIN human_profiles h ON h.principal_id=p.principal_id WHERE c.public_id=?1 AND c.secret_digest=?2 AND c.used_at IS NULL AND s.invalidated_at IS NULL AND p.lifecycle_state='active'")
        .bind(&[text(public_id),blob(secret_digest)])?.first(None).await
}

pub async fn active_credential_ids(db: &D1Database, principal_id: &str) -> Result<Vec<Vec<u8>>> {
    #[derive(Deserialize)]
    struct Row {
        credential_id: Vec<u8>,
    }
    Ok(db
        .prepare(
            "SELECT credential_id FROM authenticators WHERE principal_id=?1 AND revoked_at IS NULL",
        )
        .bind(&[text(principal_id)])?
        .all()
        .await?
        .results::<Row>()?
        .into_iter()
        .map(|r| r.credential_id)
        .collect())
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_recovery_transaction(
    db: &D1Database,
    id: &str,
    identity: &RecoveryIdentityRow,
    browser_digest: &[u8],
    csrf_digest: &[u8],
    challenge_digest: &[u8],
    rp_id: &str,
    expected_origin: &str,
    authenticator_label: &str,
    request_json: &str,
    audit_id: &str,
    correlation: &str,
    now: i64,
    expires_at: i64,
) -> Result<()> {
    db.batch(vec![
        db.prepare("INSERT INTO recovery_transactions(transaction_id,recovery_code_id,principal_id,browser_binding_digest,csrf_digest,challenge_digest,rp_id,expected_origin,authenticator_label,request_json,state,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11,?12)")
            .bind(&[text(id),text(&identity.recovery_code_id),text(&identity.principal_id),blob(browser_digest),blob(csrf_digest),blob(challenge_digest),text(rp_id),text(expected_origin),text(authenticator_label),text(request_json),integer(now),integer(expires_at)])?,
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,subject_principal_id,outcome,correlation_id,policy_revision) VALUES(?1,'identity.recovery.started',?2,?2,?3,'success',?4,1)")
            .bind(&[text(audit_id),integer(now),text(&identity.principal_id),text(correlation)])?,
        db.prepare("INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) VALUES(?1,?2,?3)")
            .bind(&[text(audit_id),text(&format!("security-audit/{}/{audit_id}.json",day_bucket(now))),integer(now)])?,
    ]).await?;
    Ok(())
}

pub async fn recovery_transaction(
    db: &D1Database,
    id: &str,
) -> Result<Option<RecoveryTransactionRow>> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare("SELECT * FROM recovery_transactions WHERE transaction_id=?1")
        .bind(&[text(id)])?
        .first(None)
        .await
}

/// 插入注册结果、会话、审计、归档 outbox，并通过约束消费事务。
/// Inserts registration result, session, audit and archive outbox while constraint-consuming the transaction.
#[allow(clippy::too_many_arguments)]
pub async fn commit_registration(
    db: &D1Database,
    tx: &WebauthnTransactionRow,
    request_digest: &[u8],
    principal_id: &str,
    user_handle: &[u8],
    display_name: &str,
    locale: &str,
    identifier_id: &str,
    username: &str,
    authenticator_id: &str,
    credential_id: &[u8],
    public_key_cose: &[u8],
    counter: u32,
    aaguid: &[u8],
    transports_json: &str,
    label: &str,
    session_id: &str,
    session_digest: &[u8],
    code_set_id: &str,
    codes: &[NewRecoveryCode],
    audit_id: &str,
    correlation: &str,
    now: i64,
) -> Result<()> {
    let mut statements = vec![
        db.prepare("INSERT INTO webauthn_transaction_consumptions(transaction_id,request_digest,outcome,result_reference,consumed_at) VALUES(?1,?2,'success',?3,?4)")
            .bind(&[text(&tx.transaction_id),blob(request_digest),text(principal_id),integer(now)])?,
        db.prepare("INSERT INTO principals(principal_id,kind,lifecycle_state,webauthn_user_handle,created_at,updated_at,state_changed_at) VALUES(?1,'human','active',?2,?3,?3,?3)")
            .bind(&[text(principal_id), blob(user_handle), integer(now)])?,
        db.prepare("INSERT INTO human_profiles(principal_id,display_name,locale,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)")
            .bind(&[text(principal_id), text(display_name), text(locale), integer(now)])?,
        db.prepare("INSERT INTO identifiers(identifier_id,principal_id,kind,value,normalized_value,created_at,updated_at) VALUES(?1,?2,'username',?3,?3,?4,?4)")
            .bind(&[text(identifier_id), text(principal_id), text(username), integer(now)])?,
        db.prepare("INSERT INTO authenticators(authenticator_id,principal_id,credential_id,public_key_cose,sign_count,aaguid,transports_json,backup_eligible,backup_state,label,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,0,0,?8,?9)")
            .bind(&[text(authenticator_id),text(principal_id),blob(credential_id),blob(public_key_cose),integer(counter as i64),blob(aaguid),text(transports_json),text(label),integer(now)])?,
        db.prepare("INSERT INTO identity_sessions(session_id,session_digest,principal_id,authenticator_id,auth_method,amr_json,acr,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?1,?2,?3,?4,'passkey','[\"passkey\"]','urn:moesegfault:acr:passkey-uv',?5,?5,?6,?7)")
            .bind(&[text(session_id),blob(session_digest),text(principal_id),text(authenticator_id),integer(now),integer(now+43_200),integer(now+2_592_000)])?,
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,subject_principal_id,outcome,authenticator_id,correlation_id,policy_revision) VALUES(?1,'identity.registration.completed',?2,?2,?3,'success',?4,?5,?6)")
            .bind(&[text(audit_id),integer(now),text(principal_id),text(authenticator_id),text(correlation),integer(tx_policy(tx))])?,
        db.prepare("INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) VALUES(?1,?2,?3)")
            .bind(&[text(audit_id),text(&format!("security-audit/{}/{audit_id}.json", day_bucket(now))),integer(now)])?,
    ];
    if let Some(capability) = tx.registration_capability_id.as_deref() {
        statements.insert(2, db.prepare("INSERT INTO registration_capability_uses(capability_id,webauthn_transaction_id,consumed_by_principal_id,request_digest,used_at) VALUES(?1,?2,?3,?4,?5)")
            .bind(&[text(capability),text(&tx.transaction_id),text(principal_id),blob(request_digest),integer(now)])?);
    }
    statements.push(
        db.prepare("INSERT INTO recovery_code_sets(recovery_code_set_id,principal_id,created_at) VALUES(?1,?2,?3)")
            .bind(&[text(code_set_id), text(principal_id), integer(now)])?,
    );
    for code in codes {
        statements.push(
            db.prepare("INSERT INTO recovery_codes(recovery_code_id,recovery_code_set_id,public_id,secret_digest,created_at) VALUES(?1,?2,?3,?4,?5)")
                .bind(&[text(&code.recovery_code_id),text(code_set_id),text(&code.public_id),blob(&code.secret_digest),integer(now)])?,
        );
    }
    db.batch(statements).await?;
    Ok(())
}

/// 提交认证、计数器与新会话。/ Commits authentication, counter, and new session.
#[allow(clippy::too_many_arguments)]
pub async fn commit_authentication(
    db: &D1Database,
    tx: &WebauthnTransactionRow,
    request_digest: &[u8],
    credential: &CredentialRow,
    new_counter: u32,
    session_id: &str,
    session_digest: &[u8],
    audit_id: &str,
    correlation: &str,
    now: i64,
) -> Result<()> {
    let statements = vec![
        db.prepare("INSERT INTO webauthn_transaction_consumptions(transaction_id,request_digest,outcome,result_reference,consumed_at) VALUES(?1,?2,'success',?3,?4)")
            .bind(&[text(&tx.transaction_id),blob(request_digest),text(session_id),integer(now)])?,
        db.prepare("UPDATE authenticators SET sign_count=CASE WHEN sign_count<=?2 THEN ?2 ELSE sign_count END,last_used_at=?3 WHERE authenticator_id=?1 AND revoked_at IS NULL")
            .bind(&[text(&credential.authenticator_id),integer(new_counter as i64),integer(now)])?,
        db.prepare("INSERT INTO identity_sessions(session_id,session_digest,principal_id,authenticator_id,auth_method,amr_json,acr,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) SELECT ?1,?2,p.principal_id,a.authenticator_id,'passkey','[\"passkey\"]','urn:moesegfault:acr:passkey-uv',?5,?5,?6,?7 FROM authenticators a JOIN principals p ON p.principal_id=a.principal_id WHERE p.principal_id=?3 AND p.lifecycle_state='active' AND a.authenticator_id=?4 AND a.revoked_at IS NULL")
            .bind(&[text(session_id),blob(session_digest),text(&credential.principal_id),text(&credential.authenticator_id),integer(now),integer(now+43_200),integer(now+2_592_000)])?,
        // 条件 INSERT 影响零行不会让 D1 batch 失败；若新 session 不存在，故意重复
        // ceremony consumption 的主键，使整批回滚而不是复活已撤销 authority。
        // A zero-row conditional INSERT does not fail a D1 batch. If the new session
        // is absent, deliberately duplicate the ceremony-consumption PK so the batch
        // rolls back instead of resurrecting revoked authority.
        db.prepare("INSERT INTO webauthn_transaction_consumptions(transaction_id,request_digest,outcome,result_reference,consumed_at) SELECT transaction_id,request_digest,outcome,result_reference,consumed_at FROM webauthn_transaction_consumptions WHERE transaction_id=?1 AND NOT EXISTS(SELECT 1 FROM identity_sessions WHERE session_id=?2 AND principal_id=?3 AND authenticator_id=?4)")
            .bind(&[text(&tx.transaction_id),text(session_id),text(&credential.principal_id),text(&credential.authenticator_id)])?,
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,actor_principal_id,subject_principal_id,outcome,authenticator_id,correlation_id,policy_revision) VALUES(?1,'identity.authentication.succeeded',?2,?2,?3,?3,'success',?4,?5,?6)")
            .bind(&[text(audit_id),integer(now),text(&credential.principal_id),text(&credential.authenticator_id),text(correlation),integer(tx_policy(tx))])?,
        db.prepare("INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) VALUES(?1,?2,?3)")
            .bind(&[text(audit_id),text(&format!("security-audit/{}/{audit_id}.json", day_bucket(now))),integer(now)])?,
    ];
    db.batch(statements).await?;
    Ok(())
}

/// 原子记录一次失败的 ceremony 消费与不可变审计。
/// Atomically records a failed ceremony consumption and immutable audit fact.
pub async fn commit_webauthn_failure(
    db: &D1Database,
    tx: &WebauthnTransactionRow,
    request_digest: &[u8],
    audit_id: &str,
    correlation: &str,
    now: i64,
) -> Result<()> {
    let event_name = if tx.kind == "account_registration" {
        "identity.registration.failed"
    } else {
        "identity.authentication.failed"
    };
    db.batch(vec![
        db.prepare("INSERT INTO webauthn_transaction_consumptions(transaction_id,request_digest,outcome,consumed_at) VALUES(?1,?2,'failure',?3)")
            .bind(&[text(&tx.transaction_id),blob(request_digest),integer(now)])?,
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,subject_principal_id,outcome,reason_code,correlation_id,policy_revision) VALUES(?1,?2,?3,?3,?4,'failure','invalid_credential',?5,?6)")
            .bind(&[text(audit_id),text(event_name),integer(now),optional_text(tx.principal_id.as_deref()),text(correlation),integer(tx_policy(tx))])?,
        db.prepare("INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) VALUES(?1,?2,?3)")
            .bind(&[text(audit_id),text(&format!("security-audit/{}/{audit_id}.json",day_bucket(now))),integer(now)])?,
    ]).await?;
    Ok(())
}

/// 在一个 D1 batch 中从旧认证能力切换到新 Passkey、session 与恢复码。
/// Switches from old authority to a new Passkey, session, and recovery codes in one D1 batch.
#[allow(clippy::too_many_arguments)]
pub async fn commit_recovery(
    db: &D1Database,
    tx: &RecoveryTransactionRow,
    request_digest: &[u8],
    authenticator_id: &str,
    credential_id: &[u8],
    public_key_cose: &[u8],
    counter: u32,
    aaguid: &[u8],
    transports_json: &str,
    session_id: &str,
    session_digest: &[u8],
    code_set_id: &str,
    codes: &[NewRecoveryCode],
    audit_id: &str,
    correlation: &str,
    now: i64,
) -> Result<()> {
    let mut statements = vec![
        db.prepare("INSERT INTO recovery_code_uses(recovery_code_id,recovery_transaction_id,request_digest,used_at) VALUES(?1,?2,?3,?4)")
            .bind(&[text(&tx.recovery_code_id),text(&tx.transaction_id),blob(request_digest),integer(now)])?,
        // INSERT .. SELECT makes active principal state part of the atomic write predicate.
        db.prepare("INSERT INTO authenticators(authenticator_id,principal_id,credential_id,public_key_cose,sign_count,aaguid,transports_json,backup_eligible,backup_state,label,created_at) SELECT ?1,principal_id,?3,?4,?5,?6,?7,0,0,?8,?9 FROM principals WHERE principal_id=?2 AND lifecycle_state='active'")
            .bind(&[text(authenticator_id),text(&tx.principal_id),blob(credential_id),blob(public_key_cose),integer(counter as i64),blob(aaguid),text(transports_json),text(&tx.authenticator_label),integer(now)])?,
        // FK to the new authenticator turns a zero-row principal gate into a batch rollback.
        db.prepare("INSERT INTO recovery_transaction_consumptions(transaction_id,request_digest,outcome,result_authenticator_id,consumed_at) VALUES(?1,?2,'success',?3,?4)")
            .bind(&[text(&tx.transaction_id),blob(request_digest),text(authenticator_id),integer(now)])?,
        db.prepare("UPDATE authenticators SET revoked_at=?3 WHERE principal_id=?1 AND authenticator_id<>?2 AND revoked_at IS NULL")
            .bind(&[text(&tx.principal_id),text(authenticator_id),integer(now)])?,
        db.prepare("UPDATE identity_sessions SET revoked_at=?2,revocation_reason='account_recovery' WHERE principal_id=?1 AND revoked_at IS NULL")
            .bind(&[text(&tx.principal_id),integer(now)])?,
        db.prepare("UPDATE oauth_authorization_codes SET revoked_at=?2 WHERE principal_id=?1 AND revoked_at IS NULL")
            .bind(&[text(&tx.principal_id),integer(now)])?,
        db.prepare("UPDATE oauth_refresh_token_families SET revoked_at=?2,revocation_reason='account_recovery' WHERE principal_id=?1 AND revoked_at IS NULL")
            .bind(&[text(&tx.principal_id),integer(now)])?,
        db.prepare("UPDATE recovery_code_sets SET invalidated_at=?2 WHERE principal_id=?1 AND invalidated_at IS NULL")
            .bind(&[text(&tx.principal_id),integer(now)])?,
        db.prepare("INSERT INTO recovery_code_sets(recovery_code_set_id,principal_id,created_at) VALUES(?1,?2,?3)")
            .bind(&[text(code_set_id),text(&tx.principal_id),integer(now)])?,
    ];
    for code in codes {
        statements.push(db.prepare("INSERT INTO recovery_codes(recovery_code_id,recovery_code_set_id,public_id,secret_digest,created_at) VALUES(?1,?2,?3,?4,?5)")
            .bind(&[text(&code.recovery_code_id),text(code_set_id),text(&code.public_id),blob(&code.secret_digest),integer(now)])?);
    }
    statements.extend([
        db.prepare("INSERT INTO identity_sessions(session_id,session_digest,principal_id,authenticator_id,auth_method,amr_json,acr,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?1,?2,?3,?4,'passkey','[\"passkey\",\"recovery_code\"]','urn:moesegfault:acr:passkey-uv',?5,?5,?6,?7)")
            .bind(&[text(session_id),blob(session_digest),text(&tx.principal_id),text(authenticator_id),integer(now),integer(now+43_200),integer(now+2_592_000)])?,
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,actor_principal_id,subject_principal_id,outcome,authenticator_id,correlation_id,policy_revision) VALUES(?1,'identity.recovery.completed',?2,?2,?3,?3,'success',?4,?5,1)")
            .bind(&[text(audit_id),integer(now),text(&tx.principal_id),text(authenticator_id),text(correlation)])?,
        db.prepare("INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) VALUES(?1,?2,?3)")
            .bind(&[text(audit_id),text(&format!("security-audit/{}/{audit_id}.json",day_bucket(now))),integer(now)])?,
    ]);
    db.batch(statements).await?;
    Ok(())
}

/// 消费失败的恢复 ceremony，但不消费恢复码，允许用户重新开始。
/// Consumes a failed recovery ceremony without consuming the recovery code, allowing a restart.
pub async fn commit_recovery_failure(
    db: &D1Database,
    tx: &RecoveryTransactionRow,
    request_digest: &[u8],
    audit_id: &str,
    correlation: &str,
    now: i64,
) -> Result<()> {
    db.batch(vec![
        db.prepare("INSERT INTO recovery_transaction_consumptions(transaction_id,request_digest,outcome,consumed_at) VALUES(?1,?2,'failure',?3)")
            .bind(&[text(&tx.transaction_id),blob(request_digest),integer(now)])?,
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,subject_principal_id,outcome,reason_code,correlation_id,policy_revision) VALUES(?1,'identity.recovery.failed',?2,?2,?3,'failure','invalid_credential',?4,1)")
            .bind(&[text(audit_id),integer(now),text(&tx.principal_id),text(correlation)])?,
        db.prepare("INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) VALUES(?1,?2,?3)")
            .bind(&[text(audit_id),text(&format!("security-audit/{}/{audit_id}.json",day_bucket(now))),integer(now)])?,
    ]).await?;
    Ok(())
}

/// 通过摘要解析未过期会话。/ Resolves an unexpired session by digest.
pub async fn current_session(
    db: &D1Database,
    digest: &[u8],
    now: i64,
) -> Result<Option<CurrentSession>> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)?
        .prepare("SELECT s.session_id,s.principal_id FROM identity_sessions s JOIN principals p ON p.principal_id=s.principal_id WHERE s.session_digest=?1 AND s.revoked_at IS NULL AND s.idle_expires_at>?2 AND s.absolute_expires_at>?2 AND p.lifecycle_state='active'")
        .bind(&[blob(digest),integer(now)])?.first(None).await
}

pub async fn principal(db: &D1Database, id: &str) -> Result<Option<PrincipalView>> {
    db.prepare("SELECT p.principal_id,p.lifecycle_state,h.display_name,h.locale,COALESCE(i.value,p.principal_id) AS username FROM principals p JOIN human_profiles h ON h.principal_id=p.principal_id LEFT JOIN identifiers i ON i.principal_id=p.principal_id AND i.kind='username' WHERE p.principal_id=?1")
        .bind(&[text(id)])?.first(None).await
}

#[derive(Debug, Deserialize, Serialize)]
struct ArchiveRow {
    audit_event_id: String,
    r2_object_key: String,
    event_name: String,
    occurred_at: i64,
    outcome: String,
    reason_code: Option<String>,
    correlation_id: String,
    policy_revision: i64,
}

/// 把 D1 outbox 归档到只按事件 ID 写入的 R2 immutable key。
/// Archives the D1 outbox to an R2 immutable key derived only from event ID.
pub async fn drain_audit_archive(env: &Env, limit: u32) -> Result<()> {
    let db = env.d1("DB")?;
    let bucket = env.bucket("AUDIT_ARCHIVE")?;
    let now = (worker::Date::now().as_millis() / 1000) as i64;
    let query = format!(
        "SELECT o.audit_event_id,o.r2_object_key,e.event_name,e.occurred_at,e.outcome,e.reason_code,e.correlation_id,e.policy_revision FROM audit_archive_outbox o JOIN security_audit_events e ON e.audit_event_id=o.audit_event_id WHERE o.state='pending' AND o.next_attempt_at<={now} ORDER BY o.audit_event_id LIMIT {}",
        limit.min(100)
    );
    let rows = db.prepare(query).all().await?.results::<ArchiveRow>()?;
    for row in rows {
        let body = serde_json::to_vec(&row)?;
        if let Some(existing) = bucket.get(&row.r2_object_key).execute().await? {
            let existing_body = existing
                .body()
                .ok_or_else(|| Error::RustError("R2 archive object has no body".into()))?
                .bytes()
                .await?;
            if existing_body != body {
                return Err(Error::RustError("immutable R2 audit key collision".into()));
            }
        } else {
            bucket
                .put(&row.r2_object_key, body.clone())
                .sha256(Sha256::digest(&body).to_vec())
                .only_if(Conditional {
                    etag_does_not_match: Some("*".to_owned()),
                    ..Conditional::default()
                })
                .execute()
                .await?;
        }
        db.prepare("UPDATE audit_archive_outbox SET state='delivered',delivered_at=?2,attempt_count=attempt_count+1 WHERE audit_event_id=?1 AND state='pending'").bind(&[text(&row.audit_event_id),integer(now)])?.run().await?;
    }
    Ok(())
}

fn tx_policy(tx: &WebauthnTransactionRow) -> i64 {
    tx.policy_revision
}
fn day_bucket(now: i64) -> String {
    format!("unix-day-{}", now / 86_400)
}
fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}
fn integer(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}
fn optional_text(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, text)
}
fn blob(value: &[u8]) -> JsValue {
    worker::js_sys::Uint8Array::from(value).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_key_uses_stable_day_bucket() {
        assert_eq!(day_bucket(172_800), "unix-day-2");
    }
}
