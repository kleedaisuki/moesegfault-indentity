//! 自助账户管理的 D1 持久化适配器。/ D1 persistence adapter for self-service account management.
//!
//! 读取使用 primary-first 会话以观察刚完成的账户变更；跨表写入使用 D1 batch，
//! 由数据库约束和 trigger 统一裁决并发状态转换。
//! Reads use primary-first sessions so callers observe recent account mutations;
//! cross-table writes use D1 batches and let database constraints and triggers
//! arbitrate concurrent state transitions.

use serde::{Deserialize, Serialize};
use worker::{D1Database, D1SessionConstraint, Error, Result, wasm_bindgen::JsValue};

use crate::repository::{self, CredentialRow, NewRecoveryCode, WebauthnTransactionRow};

const CREATE_CONTACT_SQL: &str = "INSERT INTO identifiers(\
    identifier_id,principal_id,kind,value,normalized_value,country_calling_code,\
    national_number,is_primary,verification_state,verified_at,created_at,updated_at) \
    SELECT ?1,principal_id,?3,?4,?5,?6,?7,CASE WHEN ?8=1 OR NOT EXISTS(\
    SELECT 1 FROM identifiers x WHERE x.principal_id=?2 AND x.kind=?3) \
    THEN 1 ELSE 0 END,'unverified',NULL,?9,?9 FROM principals \
    WHERE principal_id=?2 AND kind='human' AND lifecycle_state='active' \
    AND ?3 IN ('email','mobile')";

const PROMOTE_CONTACT_SQL: &str = "UPDATE identifiers SET is_primary=0,updated_at=?4 WHERE principal_id=?1 AND kind=?2 AND identifier_id<>?3 AND ?5=1";
const CANCEL_CONTACT_VERIFICATION_SQL: &str = "UPDATE identifier_verification_transactions SET state='cancelled',consumed_at=?3 WHERE identifier_id=?1 AND state='pending' AND EXISTS(SELECT 1 FROM identifiers WHERE identifier_id=?1 AND principal_id=?2 AND normalized_value<>?4)";
const UPDATE_CONTACT_SQL: &str = "UPDATE identifiers SET value=?3,normalized_value=?4,country_calling_code=?5,national_number=?6,is_primary=?7,verification_state=CASE WHEN normalized_value<>?4 THEN 'unverified' ELSE verification_state END,verified_at=CASE WHEN normalized_value<>?4 THEN NULL ELSE verified_at END,updated_at=?8 WHERE identifier_id=?1 AND principal_id=?2";

const STEP_UP_SESSION_INSERT_SQL: &str = "INSERT INTO identity_sessions(\
    session_id,session_digest,principal_id,authenticator_id,auth_method,amr_json,acr,\
    authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at,created_from_session_id) \
    SELECT ?1,?2,p.principal_id,a.authenticator_id,'passkey','[\"passkey\"]',\
    'urn:moesegfault:acr:passkey-uv',?7,?7,?8,?9,s.session_id \
    FROM webauthn_transactions t JOIN principals p ON p.principal_id=t.principal_id \
    JOIN authenticators a ON a.principal_id=p.principal_id \
    JOIN identity_sessions s ON s.session_id=?5 AND s.principal_id=p.principal_id \
    WHERE t.transaction_id=?3 AND t.kind='step_up' AND t.state='consumed_success' \
    AND t.result_reference=?1 AND p.principal_id=?4 AND p.lifecycle_state='active' \
    AND a.authenticator_id=?6 AND a.revoked_at IS NULL AND s.revoked_at IS NULL \
    AND s.idle_expires_at>?7 AND s.absolute_expires_at>?7";

const STEP_UP_SESSION_GUARD_SQL: &str = "INSERT INTO webauthn_transaction_consumptions(\
    transaction_id,request_digest,outcome,result_reference,consumed_at) \
    SELECT c.transaction_id,c.request_digest,c.outcome,c.result_reference,c.consumed_at \
    FROM webauthn_transaction_consumptions c WHERE c.transaction_id=?1 AND NOT EXISTS(\
    SELECT 1 FROM identity_sessions n WHERE n.session_id=?2 AND n.session_digest=?3 \
    AND n.principal_id=?4 AND n.authenticator_id=?5 AND n.auth_method='passkey' \
    AND n.amr_json='[\"passkey\"]' AND n.acr='urn:moesegfault:acr:passkey-uv' \
    AND n.authenticated_at=?6 AND n.created_from_session_id=?7 AND n.revoked_at IS NULL)";

const STEP_UP_SOURCE_GUARD_SQL: &str = "INSERT INTO webauthn_transaction_consumptions(\
    transaction_id,request_digest,outcome,result_reference,consumed_at) \
    SELECT c.transaction_id,c.request_digest,c.outcome,c.result_reference,c.consumed_at \
    FROM webauthn_transaction_consumptions c WHERE c.transaction_id=?1 AND NOT EXISTS(\
    SELECT 1 FROM identity_sessions s WHERE s.session_id=?2 AND s.principal_id=?3 \
    AND s.revoked_at=?4 AND s.revocation_reason='step_up_replaced')";

/// 当前已认证账户会话的授权上下文。/ Authorization context for the current account session.
#[derive(Debug, Deserialize)]
pub struct AccountSession {
    /// 当前 Identity session ID。/ Current Identity session ID.
    pub session_id: String,
    /// 已认证主体 ID。/ Authenticated principal ID.
    pub principal_id: String,
    /// Passkey session 的认证器 ID；federated session 为 `None`。
    /// Authenticator ID for a Passkey session; `None` for a federated session.
    pub authenticator_id: Option<String>,
    /// 建立 session 的认证方法。/ Authentication method that established the session.
    pub auth_method: String,
    /// 最近一次完整认证的 Unix 秒。/ Unix seconds of the most recent full authentication.
    pub authenticated_at: i64,
}

/// 可公开返回的账户标识符投影。/ Account-identifier projection safe to return to the caller.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IdentifierView {
    /// 稳定 identifier ID。/ Stable identifier ID.
    pub identifier_id: String,
    /// 标识符种类；首期恒为 `username`。/ Identifier kind; always `username` in the first release.
    pub kind: String,
    /// 用户可见的规范 username。/ User-visible canonical username.
    pub value: String,
    /// 移动号码国际区号。/ Mobile country calling code.
    pub country_calling_code: Option<String>,
    /// 移动号码本地部分。/ Mobile national number.
    pub national_number: Option<String>,
    /// 是否为该类别的主标识符。/ Whether this is the primary identifier of its kind.
    pub is_primary: bool,
    /// 带外验证状态。/ Out-of-band verification state.
    pub verification_state: String,
    /// 验证时间（Unix 秒）。/ Verification time in Unix seconds.
    pub verified_at: Option<i64>,
    /// 创建时间（Unix 秒）。/ Creation time in Unix seconds.
    pub created_at: i64,
    /// 最近更新时间（Unix 秒）。/ Last-update time in Unix seconds.
    pub updated_at: i64,
}

/// 自助账户页面所需的主体、资料与标识符。/ Principal, profile, and identifiers needed by self-service account views.
#[derive(Debug, Deserialize, Serialize)]
pub struct AccountView {
    /// 稳定 principal ID。/ Stable principal ID.
    pub principal_id: String,
    /// 主体生命周期状态。/ Principal lifecycle state.
    pub lifecycle_state: String,
    /// 人类可读展示名。/ Human-readable display name.
    pub display_name: String,
    /// 可选 avatar R2 object key；不是公开 URL。
    /// Optional avatar R2 object key; this is not a public URL.
    pub avatar_r2_key: Option<String>,
    /// BCP 47 风格 locale。/ BCP 47-style locale.
    pub locale: String,
    /// 当前账户标识符；首期至多一个。/ Current account identifiers; at most one in the first release.
    pub identifiers: Vec<IdentifierView>,
    /// 账户创建时间（Unix 秒）。/ Account creation time in Unix seconds.
    pub created_at: i64,
    /// 账户级最近更新时间（Unix 秒）。/ Account-level last-update time in Unix seconds.
    pub updated_at: i64,
}

/// Passkey 的非秘密账户管理投影。/ Non-secret Passkey projection for account management.
#[derive(Debug, Deserialize, Serialize)]
pub struct AuthenticatorView {
    /// 稳定 authenticator ID。/ Stable authenticator ID.
    pub authenticator_id: String,
    /// 用户维护的设备标签。/ User-maintained device label.
    pub label: String,
    /// WebAuthn transport hints。/ WebAuthn transport hints.
    pub transports: Vec<String>,
    /// 凭据是否可备份。/ Whether the credential is backup eligible.
    pub backup_eligible: bool,
    /// 凭据当前是否已备份。/ Whether the credential is currently backed up.
    pub backup_state: bool,
    /// 此认证器是否建立了当前 session。/ Whether this authenticator established the current session.
    pub is_current: bool,
    /// 创建时间（Unix 秒）。/ Creation time in Unix seconds.
    pub created_at: i64,
    /// 最近成功使用时间（Unix 秒）。/ Last successful use in Unix seconds.
    pub last_used_at: Option<i64>,
    /// 撤销时间（Unix 秒）。/ Revocation time in Unix seconds.
    pub revoked_at: Option<i64>,
}

/// Identity session 的完整账户管理投影。/ Complete account-management projection of an Identity session.
#[derive(Debug, Deserialize, Serialize)]
pub struct SessionView {
    /// 稳定 session ID。/ Stable session ID.
    pub session_id: String,
    /// 建立 session 的认证方法。/ Authentication method that established the session.
    pub auth_method: String,
    /// Passkey session 的认证器 ID。/ Authenticator ID for a Passkey session.
    pub authenticator_id: Option<String>,
    /// Federated session 的外部 binding ID。/ External binding ID for a federated session.
    pub binding_id: Option<String>,
    /// Authentication Method References。/ Authentication Method References.
    pub amr: Vec<String>,
    /// Authentication Context Class Reference。/ Authentication Context Class Reference.
    pub acr: String,
    /// 是否为调用此 API 的 session。/ Whether this is the session calling the API.
    pub is_current: bool,
    /// 完整认证时间（Unix 秒）。/ Full-authentication time in Unix seconds.
    pub authenticated_at: i64,
    /// 最近活动时间（Unix 秒）。/ Last activity time in Unix seconds.
    pub last_seen_at: i64,
    /// 绝对过期时间（Unix 秒）。/ Absolute expiration time in Unix seconds.
    pub expires_at: i64,
    /// 撤销时间（Unix 秒）。/ Revocation time in Unix seconds.
    pub revoked_at: Option<i64>,
}

/// 创建额外 Passkey ceremony 所需的稳定账户材料。
/// Stable account material needed to create an additional-Passkey ceremony.
#[derive(Debug)]
pub struct AdditionIdentity {
    /// ceremony 绑定的主体 ID。/ Principal ID bound to the ceremony.
    pub principal_id: String,
    /// WebAuthn user handle 原始字节。/ Raw WebAuthn user-handle bytes.
    pub user_handle: Vec<u8>,
    /// WebAuthn user name；无 identifier 时回退到 principal ID。
    /// WebAuthn user name, falling back to principal ID when no identifier exists.
    pub username: String,
    /// WebAuthn 展示名。/ WebAuthn display name.
    pub display_name: String,
    /// 仍活动、须放入 exclude list 的 credential IDs。
    /// Active credential IDs to place in the exclusion list.
    pub credential_ids: Vec<Vec<u8>>,
}

/// 活动恢复码集合的计数状态；不包含任何 secret。/ Count status for the active recovery-code set; contains no secrets.
#[derive(Debug, Deserialize, Serialize)]
pub struct RecoveryCodeStatus {
    /// 当前集合生成时间（Unix 秒）。/ Current set generation time in Unix seconds.
    pub generated_at: i64,
    /// 集合中的恢复码总数。/ Total number of recovery codes in the set.
    pub total_count: u32,
    /// 尚未使用的恢复码数。/ Number of unused recovery codes.
    pub remaining_count: u32,
}

/// 撤销 Passkey 的领域结果。/ Domain outcome of revoking a Passkey.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevokeAuthenticatorOutcome {
    /// Passkey 及其派生会话已撤销。/ The Passkey and its derived sessions were revoked.
    Revoked,
    /// 此账户没有指定的活动 Passkey。/ The account has no matching active Passkey.
    NotFound,
    /// 数据库不变量拒绝撤销最后一个活动 Passkey。/ A database invariant rejected revoking the last active Passkey.
    LastAuthenticator,
}

#[derive(Debug, Deserialize)]
struct AccountRow {
    principal_id: String,
    lifecycle_state: String,
    display_name: String,
    avatar_r2_key: Option<String>,
    locale: String,
    created_at: i64,
    updated_at: i64,
    identifier_id: Option<String>,
    identifier_kind: Option<String>,
    identifier_value: Option<String>,
    identifier_created_at: Option<i64>,
    identifier_updated_at: Option<i64>,
}

/// D1 标识符行；SQLite 布尔列通过 JavaScript number 传输，而不是 JavaScript boolean。
/// D1 identifier row; SQLite boolean columns cross the boundary as JavaScript numbers, not booleans.
#[derive(Debug, Deserialize)]
struct IdentifierRow {
    /// 稳定 identifier ID。/ Stable identifier ID.
    identifier_id: String,
    /// 标识符类别。/ Identifier kind.
    kind: String,
    /// 用户可见值。/ User-visible value.
    value: String,
    /// 移动号码国际区号。/ Mobile country calling code.
    country_calling_code: Option<String>,
    /// 移动号码本地部分。/ Mobile national number.
    national_number: Option<String>,
    /// SQLite 整数布尔值。/ SQLite integer boolean.
    is_primary: i64,
    /// 带外验证状态。/ Out-of-band verification state.
    verification_state: String,
    /// 验证时间（Unix 秒）。/ Verification time in Unix seconds.
    verified_at: Option<i64>,
    /// 创建时间（Unix 秒）。/ Creation time in Unix seconds.
    created_at: i64,
    /// 最近更新时间（Unix 秒）。/ Last-update time in Unix seconds.
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
struct AdditionIdentityRow {
    principal_id: String,
    user_handle: Vec<u8>,
    username: String,
    display_name: String,
}

#[derive(Debug, Deserialize)]
struct CredentialIdRow {
    credential_id: Vec<u8>,
}

#[derive(Debug, Deserialize)]
struct AuthenticatorRow {
    authenticator_id: String,
    label: String,
    transports_json: String,
    backup_eligible: i64,
    backup_state: i64,
    is_current: i64,
    created_at: i64,
    last_used_at: Option<i64>,
    revoked_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct SessionRow {
    session_id: String,
    auth_method: String,
    authenticator_id: Option<String>,
    binding_id: Option<String>,
    amr_json: String,
    acr: String,
    is_current: i64,
    authenticated_at: i64,
    last_seen_at: i64,
    expires_at: i64,
    revoked_at: Option<i64>,
}

/// 通过摘要解析仍有效、且主体仍 active 的账户会话。
/// Resolves an unexpired account session whose principal remains active by digest.
pub async fn current_session(
    db: &D1Database,
    digest: &[u8],
    now: i64,
) -> Result<Option<AccountSession>> {
    let session = primary(db)?
        .prepare(
            "SELECT s.session_id,s.principal_id,s.authenticator_id,s.auth_method,s.authenticated_at \
             FROM identity_sessions s JOIN principals p ON p.principal_id=s.principal_id \
             WHERE s.session_digest=?1 AND s.revoked_at IS NULL AND s.idle_expires_at>?2 \
             AND s.absolute_expires_at>?2 AND p.lifecycle_state='active'",
        )
        .bind(&[blob(digest), integer(now)])?
        .first::<AccountSession>(None)
        .await?;
    if let Some(session) = &session {
        if let Err(error) = repository::touch_session(db, &session.session_id, now).await {
            worker::console_error!("session_touch_failed error={error}");
        }
    }
    Ok(session)
}

/// 读取一个人类账户；不存在的 profile 不会被伪造成空资料。
/// Reads one human account; a missing profile is never fabricated as empty data.
pub async fn account(db: &D1Database, principal_id: &str) -> Result<Option<AccountView>> {
    let row = primary(db)?
        .prepare(
            "SELECT p.principal_id,p.lifecycle_state,h.display_name,h.avatar_r2_key,h.locale,\
             p.created_at,p.updated_at,i.identifier_id,i.kind AS identifier_kind,\
             i.value AS identifier_value,i.created_at AS identifier_created_at,\
             i.updated_at AS identifier_updated_at FROM principals p \
             JOIN human_profiles h ON h.principal_id=p.principal_id \
             LEFT JOIN identifiers i ON i.principal_id=p.principal_id AND i.kind='username' \
             WHERE p.principal_id=?1 AND p.kind='human'",
        )
        .bind(&[text(principal_id)])?
        .first::<AccountRow>(None)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let mut account = account_from_row(row)?;
    account.identifiers = identifiers(db, principal_id).await?;
    Ok(Some(account))
}

/// 更新 display name 和/或 locale，并同步主体的账户级更新时间。
/// Updates the display name and/or locale and advances the account-level timestamp.
pub async fn update_account(
    db: &D1Database,
    principal_id: &str,
    display_name: Option<&str>,
    locale: Option<&str>,
    now: i64,
) -> Result<Option<AccountView>> {
    let results = db
        .batch(vec![
            db.prepare(
                "UPDATE human_profiles SET display_name=COALESCE(?2,display_name),\
                 locale=COALESCE(?3,locale),updated_at=?4 WHERE principal_id=?1 \
                 AND EXISTS(SELECT 1 FROM principals WHERE principal_id=?1 \
                 AND kind='human' AND lifecycle_state='active')",
            )
            .bind(&[
                text(principal_id),
                optional_text(display_name),
                optional_text(locale),
                integer(now),
            ])?,
            db.prepare(
                "UPDATE principals SET updated_at=?2 WHERE principal_id=?1 AND kind='human' \
                 AND lifecycle_state='active' AND EXISTS(SELECT 1 FROM human_profiles \
                 WHERE principal_id=?1 AND updated_at=?2)",
            )
            .bind(&[text(principal_id), integer(now)])?,
        ])
        .await?;
    if !changed(results.first())? {
        return Ok(None);
    }
    account(db, principal_id).await
}

/// 将主体推进到 `pending_deletion`，并原子撤销其全部认证能力。
/// Advances a principal to `pending_deletion` and atomically revokes all of its authentication authority.
///
/// 审计预先以旧 lifecycle state 为条件插入；随后任何语句失败都会回滚整个 D1 batch。
/// 将 lifecycle state 放在认证器撤销之前，使数据库的“保留最后一个 Passkey”trigger
/// 自然允许账户删除路径，无需额外特例。重复请求不会再次写审计或 outbox。
/// The audit insert is gated by the old lifecycle state and any later failure rolls
/// back the entire D1 batch. Moving lifecycle state before authenticator revocation
/// lets the database's last-Passkey trigger naturally admit account deletion. A
/// repeated request writes neither another audit nor another outbox row.
pub async fn schedule_self_deletion(
    db: &D1Database,
    principal_id: &str,
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<()> {
    db.batch(vec![
        db.prepare(
            "INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,\
             actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision) \
             SELECT ?1,'identity.principal.deletion_scheduled',?2,?2,?3,?3,'success',?4,1 \
             FROM principals WHERE principal_id=?3 AND lifecycle_state IN ('active','suspended')",
        )
        .bind(&[
            text(audit_id),
            integer(now),
            text(principal_id),
            text(correlation_id),
        ])?,
        db.prepare(
            "UPDATE principals SET lifecycle_state='pending_deletion',updated_at=?2,\
             state_changed_at=?2 WHERE principal_id=?1 AND lifecycle_state IN ('active','suspended')",
        )
        .bind(&[text(principal_id), integer(now)])?,
        db.prepare(
            "UPDATE authenticators SET revoked_at=?2 WHERE principal_id=?1 AND revoked_at IS NULL \
             AND EXISTS(SELECT 1 FROM principals WHERE principal_id=?1 \
             AND lifecycle_state='pending_deletion')",
        )
        .bind(&[text(principal_id), integer(now)])?,
        db.prepare(
            "UPDATE identity_bindings SET authentication_enabled=0,revoked_at=?2 \
             WHERE principal_id=?1 AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM principals \
             WHERE principal_id=?1 AND lifecycle_state='pending_deletion')",
        )
        .bind(&[text(principal_id), integer(now)])?,
        db.prepare(
            "UPDATE identity_sessions SET revoked_at=?2,revocation_reason='account_deletion' \
             WHERE principal_id=?1 AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM principals \
             WHERE principal_id=?1 AND lifecycle_state='pending_deletion')",
        )
        .bind(&[text(principal_id), integer(now)])?,
        db.prepare(
            "UPDATE oauth_authorization_codes SET revoked_at=?2 WHERE principal_id=?1 \
             AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM principals WHERE principal_id=?1 \
             AND lifecycle_state='pending_deletion')",
        )
        .bind(&[text(principal_id), integer(now)])?,
        db.prepare(
            "UPDATE oauth_refresh_token_families SET revoked_at=?2,\
             revocation_reason='account_deletion' WHERE principal_id=?1 AND revoked_at IS NULL \
             AND EXISTS(SELECT 1 FROM principals WHERE principal_id=?1 \
             AND lifecycle_state='pending_deletion')",
        )
        .bind(&[text(principal_id), integer(now)])?,
        db.prepare(
            "UPDATE recovery_code_sets SET invalidated_at=?2 WHERE principal_id=?1 \
             AND invalidated_at IS NULL AND EXISTS(SELECT 1 FROM principals WHERE principal_id=?1 \
             AND lifecycle_state='pending_deletion')",
        )
        .bind(&[text(principal_id), integer(now)])?,
        db.prepare(
            "UPDATE webauthn_transactions SET state='cancelled',consumed_at=?2,result_reference=NULL \
             WHERE principal_id=?1 AND state='pending' AND EXISTS(SELECT 1 FROM principals \
             WHERE principal_id=?1 AND lifecycle_state='pending_deletion')",
        )
        .bind(&[text(principal_id), integer(now)])?,
        db.prepare(
            "UPDATE recovery_transactions SET state='cancelled',consumed_at=?2 \
             WHERE principal_id=?1 AND state='pending' AND EXISTS(SELECT 1 FROM principals \
             WHERE principal_id=?1 AND lifecycle_state='pending_deletion')",
        )
        .bind(&[text(principal_id), integer(now)])?,
        db.prepare(
            "UPDATE binding_transactions SET state='cancelled',consumed_at=?2,result_binding_id=NULL \
             WHERE principal_id=?1 AND state='pending' AND EXISTS(SELECT 1 FROM principals \
             WHERE principal_id=?1 AND lifecycle_state='pending_deletion')",
        )
        .bind(&[text(principal_id), integer(now)])?,
        db.prepare(
            "UPDATE oauth_authorization_transactions SET state='denied',consumed_at=?2 \
             WHERE principal_id=?1 AND state='authenticated' AND EXISTS(SELECT 1 FROM principals \
             WHERE principal_id=?1 AND lifecycle_state='pending_deletion')",
        )
        .bind(&[text(principal_id), integer(now)])?,
        conditional_archive_outbox(db, audit_id, now)?,
    ])
    .await?;
    Ok(())
}

/// 按创建顺序列出当前账户的标识符。/ Lists the account's identifiers in creation order.
pub async fn identifiers(db: &D1Database, principal_id: &str) -> Result<Vec<IdentifierView>> {
    let rows = primary(db)?
        .prepare(
            "SELECT identifier_id,kind,value,country_calling_code,national_number,is_primary,verification_state,verified_at,created_at,updated_at FROM identifiers \
             WHERE principal_id=?1 ORDER BY created_at,identifier_id",
        )
        .bind(&[text(principal_id)])?
        .all()
        .await?
        .results::<IdentifierRow>()?;
    Ok(rows.into_iter().map(identifier_from_row).collect())
}

/// 为活动账户添加未验证联系渠道。/ Adds an unverified contact channel to an active account.
#[allow(clippy::too_many_arguments)]
pub async fn create_contact(
    db: &D1Database,
    principal_id: &str,
    identifier_id: &str,
    kind: &str,
    value: &str,
    normalized_value: &str,
    calling_code: Option<&str>,
    national_number: Option<&str>,
    is_primary: bool,
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<Option<IdentifierView>> {
    let results = db.batch(vec![
        db.prepare("UPDATE identifiers SET is_primary=0,updated_at=?4 WHERE principal_id=?1 AND kind=?2 AND is_primary=1 AND ?3=1")
            .bind(&[text(principal_id),text(kind),integer(i64::from(is_primary)),integer(now)])?,
        db.prepare(CREATE_CONTACT_SQL)
            .bind(&[text(identifier_id),text(principal_id),text(kind),text(value),text(normalized_value),optional_text(calling_code),optional_text(national_number),integer(i64::from(is_primary)),integer(now)])?,
        db.prepare("UPDATE principals SET updated_at=?3 WHERE principal_id=?1 AND EXISTS(SELECT 1 FROM identifiers WHERE identifier_id=?2 AND principal_id=?1)")
            .bind(&[text(principal_id),text(identifier_id),integer(now)])?,
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision) SELECT ?1,'identity.identifier.created',?2,?2,?3,?3,'success',?4,1 FROM identifiers WHERE identifier_id=?5 AND principal_id=?3")
            .bind(&[text(audit_id),integer(now),text(principal_id),text(correlation_id),text(identifier_id)])?,
        conditional_archive_outbox(db, audit_id, now)?,
    ]).await?;
    if !changed(results.get(1))? {
        return Ok(None);
    }
    identifier(db, principal_id, identifier_id).await
}

/// 已在 HTTP 边界验证和规范化的联系方式变更。/ Contact change validated and normalized at the HTTP boundary.
///
/// `kind` 与 `identifier_id` 来自当前账户的标识符投影，而不是请求体。
/// `kind` and `identifier_id` come from the current account projection, not the request body.
pub struct ContactUpdate<'a> {
    /// 所有者主体。/ Owner principal.
    pub principal_id: &'a str,
    /// 当前联系方式 ID。/ Existing contact identifier ID.
    pub identifier_id: &'a str,
    /// 当前联系方式类别。/ Existing contact kind.
    pub kind: &'a str,
    /// 展示值。/ Display value.
    pub value: &'a str,
    /// 规范化目的地。/ Normalized destination.
    pub normalized_value: &'a str,
    /// 可选国际区号。/ Optional country calling code.
    pub calling_code: Option<&'a str>,
    /// 可选本地号码。/ Optional national number.
    pub national_number: Option<&'a str>,
    /// 更新后的主联系方式标志。/ Resulting primary-contact flag.
    pub is_primary: bool,
    /// 当前 Unix 秒。/ Current Unix seconds.
    pub now: i64,
}

/// 原子更新联系渠道、取消旧目的地验证并读取最新投影。
/// Atomically updates a contact, cancels verification for the old destination, and reads its new projection.
///
/// D1 batch 的三个语句必须保持顺序及单事务；仅规范化值变化时取消待处理验证。
/// The three D1 batch statements must stay ordered in one transaction; only a normalized-value
/// change cancels pending verification. The readback deliberately occurs after the batch commit.
pub async fn update_contact(db: &D1Database, input: ContactUpdate<'_>) -> Result<IdentifierView> {
    db.batch(vec![
        db.prepare(PROMOTE_CONTACT_SQL).bind(&[
            text(input.principal_id),
            text(input.kind),
            text(input.identifier_id),
            integer(input.now),
            integer(i64::from(input.is_primary)),
        ])?,
        db.prepare(CANCEL_CONTACT_VERIFICATION_SQL).bind(&[
            text(input.identifier_id),
            text(input.principal_id),
            integer(input.now),
            text(input.normalized_value),
        ])?,
        db.prepare(UPDATE_CONTACT_SQL).bind(&[
            text(input.identifier_id),
            text(input.principal_id),
            text(input.value),
            text(input.normalized_value),
            optional_text(input.calling_code),
            optional_text(input.national_number),
            integer(i64::from(input.is_primary)),
            integer(input.now),
        ])?,
    ])
    .await?;
    identifier(db, input.principal_id, input.identifier_id)
        .await?
        .ok_or_else(|| Error::RustError("updated contact projection missing".into()))
}

/// 删除联系渠道但保留 username 账户锚点。/ Deletes a contact channel while retaining the username account anchor.
pub async fn delete_contact(
    db: &D1Database,
    principal_id: &str,
    identifier_id: &str,
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<bool> {
    let results = db.batch(vec![
        db.prepare("UPDATE principals SET updated_at=?3 WHERE principal_id=?1 AND lifecycle_state='active' AND EXISTS(SELECT 1 FROM identifiers WHERE identifier_id=?2 AND principal_id=?1 AND kind IN ('email','mobile'))")
            .bind(&[text(principal_id),text(identifier_id),integer(now)])?,
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision) SELECT ?1,'identity.identifier.deleted',?2,?2,?3,?3,'success',?4,1 FROM identifiers WHERE identifier_id=?5 AND principal_id=?3 AND kind IN ('email','mobile')")
            .bind(&[text(audit_id),integer(now),text(principal_id),text(correlation_id),text(identifier_id)])?,
        conditional_archive_outbox(db, audit_id, now)?,
        db.prepare("DELETE FROM identifiers WHERE identifier_id=?2 AND principal_id=?1 AND kind IN ('email','mobile')").bind(&[text(principal_id),text(identifier_id)])?,
    ]).await?;
    changed(results.get(3))
}

/// 创建首期唯一的 username 标识符；调用方须传入领域层规范化后的值。
/// Creates the sole first-release username identifier; the caller supplies its domain-normalized value.
#[allow(clippy::too_many_arguments)]
pub async fn create_identifier(
    db: &D1Database,
    principal_id: &str,
    identifier_id: &str,
    value: &str,
    normalized_value: &str,
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<Option<IdentifierView>> {
    let results = db
        .batch(vec![
            db.prepare(
                "INSERT INTO identifiers(identifier_id,principal_id,kind,value,normalized_value,is_primary,verification_state,verified_at,created_at,updated_at) \
                 SELECT ?1,principal_id,'username',?3,?4,1,'verified',?5,?5,?5 FROM principals \
                 WHERE principal_id=?2 AND kind='human' AND lifecycle_state='active'",
            )
            .bind(&[
                text(identifier_id),
                text(principal_id),
                text(value),
                text(normalized_value),
                integer(now),
            ])?,
            db.prepare(
                "UPDATE principals SET updated_at=?3 WHERE principal_id=?1 AND \
                 EXISTS(SELECT 1 FROM identifiers WHERE identifier_id=?2 AND principal_id=?1)",
            )
            .bind(&[text(principal_id), text(identifier_id), integer(now)])?,
            db.prepare(
                "INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,\
                 actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision) \
                 SELECT ?1,'identity.identifier.created',?2,?2,?3,?3,'success',?4,1 \
                 FROM identifiers WHERE identifier_id=?5 AND principal_id=?3 AND created_at=?2",
            )
            .bind(&[
                text(audit_id),
                integer(now),
                text(principal_id),
                text(correlation_id),
                text(identifier_id),
            ])?,
            conditional_archive_outbox(db, audit_id, now)?,
        ])
        .await?;
    if !changed(results.first())? {
        return Ok(None);
    }
    identifier(db, principal_id, identifier_id).await
}

/// 替换属于当前账户的 username；其他账户的 ID 与不存在的 ID 均返回 `None`。
/// Replaces the username owned by this account; foreign and unknown IDs both return `None`.
#[allow(clippy::too_many_arguments)]
pub async fn update_identifier(
    db: &D1Database,
    principal_id: &str,
    identifier_id: &str,
    value: &str,
    normalized_value: &str,
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<Option<IdentifierView>> {
    let results = db
        .batch(vec![
            db.prepare(
                "UPDATE identifiers SET value=?3,normalized_value=?4,updated_at=?5 \
                 WHERE principal_id=?1 AND identifier_id=?2 AND kind='username' \
                 AND EXISTS(SELECT 1 FROM principals WHERE principal_id=?1 \
                 AND lifecycle_state='active')",
            )
            .bind(&[
                text(principal_id),
                text(identifier_id),
                text(value),
                text(normalized_value),
                integer(now),
            ])?,
            db.prepare(
                "UPDATE principals SET updated_at=?3 WHERE principal_id=?1 AND \
                 EXISTS(SELECT 1 FROM identifiers WHERE identifier_id=?2 AND principal_id=?1 \
                 AND updated_at=?3)",
            )
            .bind(&[text(principal_id), text(identifier_id), integer(now)])?,
            db.prepare(
                "INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,\
                 actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision) \
                 SELECT ?1,'identity.identifier.updated',?2,?2,?3,?3,'success',?4,1 \
                 FROM identifiers WHERE identifier_id=?5 AND principal_id=?3 AND updated_at=?2 \
                 AND EXISTS(SELECT 1 FROM principals WHERE principal_id=?3 \
                 AND lifecycle_state='active' AND updated_at=?2)",
            )
            .bind(&[
                text(audit_id),
                integer(now),
                text(principal_id),
                text(correlation_id),
                text(identifier_id),
            ])?,
            conditional_archive_outbox(db, audit_id, now)?,
        ])
        .await?;
    if !changed(results.first())? {
        return Ok(None);
    }
    identifier(db, principal_id, identifier_id).await
}

/// 删除属于当前账户的 username，并报告是否存在活动匹配项。
/// Deletes an account-owned username and reports whether an active match existed.
pub async fn delete_identifier(
    db: &D1Database,
    principal_id: &str,
    identifier_id: &str,
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<bool> {
    let results = db
        .batch(vec![
            db.prepare(
                "UPDATE principals SET updated_at=?3 WHERE principal_id=?1 \
                 AND lifecycle_state='active' AND EXISTS(SELECT 1 FROM identifiers \
                 WHERE identifier_id=?2 AND principal_id=?1 AND kind='username')",
            )
            .bind(&[text(principal_id), text(identifier_id), integer(now)])?,
            db.prepare(
                "INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,\
                 actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision) \
                 SELECT ?1,'identity.identifier.deleted',?2,?2,?3,?3,'success',?4,1 \
                 FROM identifiers i JOIN principals p ON p.principal_id=i.principal_id \
                 WHERE i.identifier_id=?5 AND i.principal_id=?3 AND i.kind='username' \
                 AND p.lifecycle_state='active'",
            )
            .bind(&[
                text(audit_id),
                integer(now),
                text(principal_id),
                text(correlation_id),
                text(identifier_id),
            ])?,
            conditional_archive_outbox(db, audit_id, now)?,
            db.prepare(
                "DELETE FROM identifiers WHERE identifier_id=?2 AND principal_id=?1 \
                 AND kind='username' AND EXISTS(SELECT 1 FROM principals \
                 WHERE principal_id=?1 AND lifecycle_state='active')",
            )
            .bind(&[text(principal_id), text(identifier_id)])?,
        ])
        .await?;
    changed(results.get(3))
}

/// 读取创建额外 Passkey 所需的 user handle、展示字段与排除凭据列表。
/// Reads the user handle, display fields, and excluded credentials for adding a Passkey.
pub async fn addition_identity(
    db: &D1Database,
    principal_id: &str,
) -> Result<Option<AdditionIdentity>> {
    let session = primary(db)?;
    let Some(row) = session
        .prepare(
            "SELECT p.principal_id,p.webauthn_user_handle AS user_handle,\
             COALESCE(i.value,p.principal_id) AS username,h.display_name FROM principals p \
             JOIN human_profiles h ON h.principal_id=p.principal_id LEFT JOIN identifiers i \
             ON i.principal_id=p.principal_id AND i.kind='username' \
             WHERE p.principal_id=?1 AND p.kind='human' AND p.lifecycle_state='active'",
        )
        .bind(&[text(principal_id)])?
        .first::<AdditionIdentityRow>(None)
        .await?
    else {
        return Ok(None);
    };
    let credential_ids = session
        .prepare(
            "SELECT credential_id FROM authenticators WHERE principal_id=?1 \
             AND revoked_at IS NULL ORDER BY created_at,authenticator_id",
        )
        .bind(&[text(principal_id)])?
        .all()
        .await?
        .results::<CredentialIdRow>()?
        .into_iter()
        .map(|credential| credential.credential_id)
        .collect();
    Ok(Some(AdditionIdentity {
        principal_id: row.principal_id,
        user_handle: row.user_handle,
        username: row.username,
        display_name: row.display_name,
        credential_ids,
    }))
}

/// 插入绑定到当前主体的 `authenticator_addition` WebAuthn transaction。
/// Inserts an `authenticator_addition` WebAuthn transaction bound to the current principal.
#[allow(clippy::too_many_arguments)]
pub async fn insert_addition_transaction(
    db: &D1Database,
    transaction_id: &str,
    principal_id: &str,
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
    repository::insert_webauthn_transaction(
        db,
        transaction_id,
        "authenticator_addition",
        Some(principal_id),
        None,
        challenge_digest,
        browser_digest,
        csrf_digest,
        rp_id,
        expected_origin,
        request_json,
        policy_revision,
        now,
        expires_at,
    )
    .await
}

/// 插入绑定到当前主体的 `step_up` WebAuthn assertion transaction。
/// Inserts a `step_up` WebAuthn assertion transaction bound to the current principal.
///
/// 发起 session ID 由调用方封存在 ceremony 状态中，并在完成时传给
/// [`commit_step_up`]；D1 transaction 同时绑定 principal，避免账户间重放。
/// The caller seals the initiating session ID into ceremony state and passes it to
/// [`commit_step_up`] at completion; the D1 transaction also binds the principal to
/// prevent cross-account replay.
#[allow(clippy::too_many_arguments)]
pub async fn insert_step_up_transaction(
    db: &D1Database,
    transaction_id: &str,
    principal_id: &str,
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
    repository::insert_webauthn_transaction(
        db,
        transaction_id,
        "step_up",
        Some(principal_id),
        None,
        challenge_digest,
        browser_digest,
        csrf_digest,
        rp_id,
        expected_origin,
        request_json,
        policy_revision,
        now,
        expires_at,
    )
    .await
}

/// 原子完成 Passkey step-up，并以新 ID 与 secret 替换发起 session。
/// Atomically completes Passkey step-up and replaces the initiating session with a new ID and secret.
///
/// 新 session 只有在 transaction、活动 principal、活动 credential 与仍有效的发起
/// session 全部匹配时才会创建。随后旧 session 及其 refresh-token families 被撤销，
/// audit/outbox 与这些变更处于同一 D1 batch。条件插入影响零行时，guard 会故意触发
/// 一次性消费表的主键冲突，使整个 batch 回滚而不是留下部分状态。
/// The replacement is created only when the transaction, active principal, active
/// credential, and unexpired initiating session all agree. The old session and its
/// refresh-token families are then revoked in the same D1 batch as audit/outbox.
/// If a conditional insert affects zero rows, a guard deliberately collides with the
/// one-time-consumption primary key so the entire batch rolls back instead of leaving
/// partial state.
#[allow(clippy::too_many_arguments)]
pub async fn commit_step_up(
    db: &D1Database,
    transaction: &WebauthnTransactionRow,
    initiating_session_id: &str,
    request_digest: &[u8],
    credential: &CredentialRow,
    new_counter: u32,
    replacement_session_id: &str,
    replacement_session_digest: &[u8],
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<()> {
    let principal_id = transaction
        .principal_id
        .as_deref()
        .ok_or_else(|| Error::RustError("step-up transaction has no principal".into()))?;
    if transaction.kind != "step_up" {
        return Err(Error::RustError(
            "step-up commit requires a step_up transaction".into(),
        ));
    }
    if credential.principal_id != principal_id {
        return Err(Error::RustError(
            "step-up credential belongs to another principal".into(),
        ));
    }

    db.batch(vec![
        db.prepare(
            "INSERT INTO webauthn_transaction_consumptions(transaction_id,request_digest,\
             outcome,result_reference,consumed_at) VALUES(?1,?2,'success',?3,?4)",
        )
        .bind(&[
            text(&transaction.transaction_id),
            blob(request_digest),
            text(replacement_session_id),
            integer(now),
        ])?,
        db.prepare(
            "UPDATE authenticators SET sign_count=CASE WHEN sign_count<=?2 THEN ?2 ELSE sign_count END,\
             last_used_at=?3 WHERE authenticator_id=?1 AND principal_id=?4 AND revoked_at IS NULL",
        )
        .bind(&[
            text(&credential.authenticator_id),
            integer(i64::from(new_counter)),
            integer(now),
            text(principal_id),
        ])?,
        db.prepare(STEP_UP_SESSION_INSERT_SQL).bind(&[
            text(replacement_session_id),
            blob(replacement_session_digest),
            text(&transaction.transaction_id),
            text(principal_id),
            text(initiating_session_id),
            text(&credential.authenticator_id),
            integer(now),
            integer(now + 43_200),
            integer(now + 2_592_000),
        ])?,
        db.prepare(STEP_UP_SESSION_GUARD_SQL).bind(&[
            text(&transaction.transaction_id),
            text(replacement_session_id),
            blob(replacement_session_digest),
            text(principal_id),
            text(&credential.authenticator_id),
            integer(now),
            text(initiating_session_id),
        ])?,
        db.prepare(
            "UPDATE identity_sessions SET revoked_at=?3,revocation_reason='step_up_replaced' \
             WHERE session_id=?1 AND principal_id=?2 AND revoked_at IS NULL \
             AND EXISTS(SELECT 1 FROM identity_sessions n WHERE n.session_id=?4 \
             AND n.principal_id=?2 AND n.created_from_session_id=?1 AND n.revoked_at IS NULL)",
        )
        .bind(&[
            text(initiating_session_id),
            text(principal_id),
            integer(now),
            text(replacement_session_id),
        ])?,
        db.prepare(STEP_UP_SOURCE_GUARD_SQL).bind(&[
            text(&transaction.transaction_id),
            text(initiating_session_id),
            text(principal_id),
            integer(now),
        ])?,
        db.prepare(
            "UPDATE oauth_refresh_token_families SET revoked_at=COALESCE(revoked_at,?3),\
             revocation_reason=COALESCE(revocation_reason,'identity_session_step_up') \
             WHERE principal_id=?1 AND identity_session_id=?2 AND revoked_at IS NULL \
             AND EXISTS(SELECT 1 FROM identity_sessions WHERE session_id=?2 \
             AND principal_id=?1 AND revoked_at=?3 AND revocation_reason='step_up_replaced')",
        )
        .bind(&[
            text(principal_id),
            text(initiating_session_id),
            integer(now),
        ])?,
        db.prepare(
            "INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,\
             actor_principal_id,subject_principal_id,outcome,authenticator_id,correlation_id,\
             policy_revision,context_json) VALUES(?1,'identity.authentication.step_up_succeeded',\
             ?2,?2,?3,?3,'success',?4,?5,?6,json_object('replaced_session_id',?7,\
             'replacement_session_id',?8))",
        )
        .bind(&[
            text(audit_id),
            integer(now),
            text(principal_id),
            text(&credential.authenticator_id),
            text(correlation_id),
            integer(transaction.policy_revision),
            text(initiating_session_id),
            text(replacement_session_id),
        ])?,
        archive_outbox(db, audit_id, now)?,
    ])
    .await?;
    Ok(())
}

/// 消费失败的 step-up ceremony，并原子追加失败审计。
/// Consumes a failed step-up ceremony and atomically appends its failure audit.
#[allow(clippy::too_many_arguments)]
pub async fn commit_step_up_failure(
    db: &D1Database,
    transaction: &WebauthnTransactionRow,
    request_digest: &[u8],
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<()> {
    let principal_id = transaction
        .principal_id
        .as_deref()
        .ok_or_else(|| Error::RustError("step-up transaction has no principal".into()))?;
    if transaction.kind != "step_up" {
        return Err(Error::RustError(
            "step-up failure requires a step_up transaction".into(),
        ));
    }
    db.batch(vec![
        db.prepare(
            "INSERT INTO webauthn_transaction_consumptions(transaction_id,request_digest,\
             outcome,consumed_at) VALUES(?1,?2,'failure',?3)",
        )
        .bind(&[
            text(&transaction.transaction_id),
            blob(request_digest),
            integer(now),
        ])?,
        db.prepare(
            "INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,\
             actor_principal_id,subject_principal_id,outcome,reason_code,correlation_id,policy_revision) \
             SELECT ?1,'identity.authentication.step_up_failed',?2,?2,?3,?3,'failure',\
             'invalid_credential',?4,t.policy_revision FROM webauthn_transactions t \
             WHERE t.transaction_id=?5 AND t.kind='step_up' AND t.principal_id=?3 \
             AND t.state='consumed_failure'",
        )
        .bind(&[
            text(audit_id),
            integer(now),
            text(principal_id),
            text(correlation_id),
            text(&transaction.transaction_id),
        ])?,
        archive_outbox(db, audit_id, now)?,
    ])
    .await?;
    Ok(())
}

/// 原子消费 addition ceremony，并持久化新 Passkey、审计事实和 R2 outbox。
/// Atomically consumes an addition ceremony and persists the new Passkey, audit fact, and R2 outbox.
#[allow(clippy::too_many_arguments)]
pub async fn commit_addition(
    db: &D1Database,
    transaction: &WebauthnTransactionRow,
    request_digest: &[u8],
    authenticator_id: &str,
    credential_id: &[u8],
    public_key_cose: &[u8],
    counter: u32,
    aaguid: &[u8],
    transports_json: &str,
    backup_eligible: bool,
    backup_state: bool,
    label: &str,
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<()> {
    let principal_id = transaction
        .principal_id
        .as_deref()
        .ok_or_else(|| Error::RustError("addition transaction has no principal".into()))?;
    db.batch(vec![
        db.prepare(
            "INSERT INTO webauthn_transaction_consumptions(transaction_id,request_digest,\
             outcome,result_reference,consumed_at) VALUES(?1,?2,'success',?3,?4)",
        )
        .bind(&[
            text(&transaction.transaction_id),
            blob(request_digest),
            text(authenticator_id),
            integer(now),
        ])?,
        // The audit FK below turns a zero-row principal/transaction gate into a batch rollback.
        db.prepare(
            "INSERT INTO authenticators(authenticator_id,principal_id,credential_id,public_key_cose,\
             sign_count,aaguid,transports_json,backup_eligible,backup_state,label,created_at) \
             SELECT ?1,p.principal_id,?4,?5,?6,?7,?8,?9,?10,?11,?12 \
             FROM principals p JOIN webauthn_transactions t ON t.principal_id=p.principal_id \
             WHERE p.principal_id=?2 AND p.lifecycle_state='active' AND t.transaction_id=?3 \
             AND t.kind='authenticator_addition' AND t.state='consumed_success' \
             AND t.result_reference=?1",
        )
        .bind(&[
            text(authenticator_id),
            text(principal_id),
            text(&transaction.transaction_id),
            blob(credential_id),
            blob(public_key_cose),
            integer(i64::from(counter)),
            blob(aaguid),
            text(transports_json),
            boolean(backup_eligible),
            boolean(backup_state),
            text(label),
            integer(now),
        ])?,
        db.prepare(
            "INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,\
             actor_principal_id,subject_principal_id,outcome,authenticator_id,correlation_id,policy_revision) \
             VALUES(?1,'identity.authenticator.created',?2,?2,?3,?3,'success',?4,?5,?6)",
        )
        .bind(&[
            text(audit_id),
            integer(now),
            text(principal_id),
            text(authenticator_id),
            text(correlation_id),
            integer(transaction.policy_revision),
        ])?,
        archive_outbox(db, audit_id, now)?,
    ])
    .await?;
    Ok(())
}

/// 消费失败的 addition ceremony，并原子追加失败审计；不会创建 Passkey。
/// Consumes a failed addition ceremony and atomically appends its failure audit without creating a Passkey.
pub async fn commit_addition_failure(
    db: &D1Database,
    transaction: &WebauthnTransactionRow,
    request_digest: &[u8],
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<()> {
    let principal_id = transaction
        .principal_id
        .as_deref()
        .ok_or_else(|| Error::RustError("addition transaction has no principal".into()))?;
    db.batch(vec![
        db.prepare(
            "INSERT INTO webauthn_transaction_consumptions(transaction_id,request_digest,\
             outcome,consumed_at) VALUES(?1,?2,'failure',?3)",
        )
        .bind(&[
            text(&transaction.transaction_id),
            blob(request_digest),
            integer(now),
        ])?,
        // The outbox FK below turns a wrong-kind transaction into a full batch rollback.
        db.prepare(
            "INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,\
             actor_principal_id,subject_principal_id,outcome,reason_code,correlation_id,policy_revision) \
             SELECT ?1,'identity.authenticator.addition.failed',?2,?2,?3,?3,'failure',\
             'invalid_credential',?4,t.policy_revision FROM webauthn_transactions t \
             WHERE t.transaction_id=?5 AND t.kind='authenticator_addition' \
             AND t.principal_id=?3 AND t.state='consumed_failure'",
        )
        .bind(&[
            text(audit_id),
            integer(now),
            text(principal_id),
            text(correlation_id),
            text(&transaction.transaction_id),
        ])?,
        archive_outbox(db, audit_id, now)?,
    ])
    .await?;
    Ok(())
}

/// 列出 Passkey，并由数据库标注建立当前 session 的那一枚。
/// Lists Passkeys and lets the database mark the one that established the current session.
pub async fn authenticators(
    db: &D1Database,
    principal_id: &str,
    current_authenticator_id: Option<&str>,
) -> Result<Vec<AuthenticatorView>> {
    let rows = primary(db)?
        .prepare(
            "SELECT authenticator_id,label,transports_json,backup_eligible,backup_state,\
             COALESCE(authenticator_id=?2,0) AS is_current,created_at,last_used_at,revoked_at \
             FROM authenticators WHERE principal_id=?1 ORDER BY created_at DESC,authenticator_id",
        )
        .bind(&[text(principal_id), optional_text(current_authenticator_id)])?
        .all()
        .await?
        .results::<AuthenticatorRow>()?;
    rows.into_iter().map(authenticator_from_row).collect()
}

/// 更新活动 Passkey 的 label，并返回带 `is_current` 的新投影。
/// Updates an active Passkey label and returns its new projection including `is_current`.
pub async fn update_authenticator_label(
    db: &D1Database,
    principal_id: &str,
    authenticator_id: &str,
    label: &str,
    current_authenticator_id: Option<&str>,
) -> Result<Option<AuthenticatorView>> {
    let result = db
        .prepare(
            "UPDATE authenticators SET label=?3 WHERE principal_id=?1 AND authenticator_id=?2 \
             AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM principals WHERE principal_id=?1 \
             AND lifecycle_state='active')",
        )
        .bind(&[text(principal_id), text(authenticator_id), text(label)])?
        .run()
        .await?;
    if !result_changed(&result)? {
        return Ok(None);
    }
    authenticator(db, principal_id, authenticator_id, current_authenticator_id).await
}

/// 撤销一个活动 Passkey，以及由它建立的 session 与 refresh-token family。
/// Revokes an active Passkey plus sessions and refresh-token families derived from it.
///
/// `authenticator_keep_one_active` trigger 是最终并发裁决者；它使“最后一个”成为
/// 正常领域结果，而非先查后写的竞态。The `authenticator_keep_one_active` trigger
/// is the final concurrency arbiter, avoiding a check-then-write race for the last Passkey.
pub async fn revoke_authenticator(
    db: &D1Database,
    principal_id: &str,
    authenticator_id: &str,
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<RevokeAuthenticatorOutcome> {
    let result = db
        .batch(vec![
            db.prepare(
                "INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,\
                 actor_principal_id,subject_principal_id,outcome,authenticator_id,correlation_id,policy_revision) \
                 SELECT ?1,'identity.authenticator.revoked',?2,?2,?3,?3,'success',?4,?5,1 \
                 FROM authenticators WHERE principal_id=?3 AND authenticator_id=?4 AND revoked_at IS NULL",
            )
            .bind(&[
                text(audit_id),
                integer(now),
                text(principal_id),
                text(authenticator_id),
                text(correlation_id),
            ])?,
            db.prepare(
                "UPDATE authenticators SET revoked_at=?3 WHERE principal_id=?1 \
                 AND authenticator_id=?2 AND revoked_at IS NULL",
            )
            .bind(&[text(principal_id), text(authenticator_id), integer(now)])?,
            db.prepare(
                "UPDATE identity_sessions SET revoked_at=COALESCE(revoked_at,?3),\
                 revocation_reason=COALESCE(revocation_reason,'authenticator_revoked') \
                 WHERE principal_id=?1 AND authenticator_id=?2 AND EXISTS(SELECT 1 \
                 FROM authenticators WHERE principal_id=?1 AND authenticator_id=?2 AND revoked_at=?3)",
            )
            .bind(&[text(principal_id), text(authenticator_id), integer(now)])?,
            db.prepare(
                "UPDATE oauth_refresh_token_families SET revoked_at=COALESCE(revoked_at,?3),\
                 revocation_reason=COALESCE(revocation_reason,'authenticator_revoked') \
                 WHERE principal_id=?1 AND identity_session_id IN (SELECT session_id \
                 FROM identity_sessions WHERE principal_id=?1 AND authenticator_id=?2) \
                 AND EXISTS(SELECT 1 FROM authenticators WHERE principal_id=?1 \
                 AND authenticator_id=?2 AND revoked_at=?3)",
            )
            .bind(&[text(principal_id), text(authenticator_id), integer(now)])?,
            conditional_archive_outbox(db, audit_id, now)?,
        ])
        .await;
    match result {
        Ok(results) if changed(results.get(1))? => Ok(RevokeAuthenticatorOutcome::Revoked),
        Ok(_) => Ok(RevokeAuthenticatorOutcome::NotFound),
        Err(error) if is_last_authenticator_error(&error) => {
            Ok(RevokeAuthenticatorOutcome::LastAuthenticator)
        }
        Err(error) => Err(error),
    }
}

/// 列出活动 session 与近 30 天撤销的 session，并标记当前 session。
/// Lists active sessions and sessions revoked in the last 30 days, marking the current session.
pub async fn sessions(
    db: &D1Database,
    principal_id: &str,
    current_session_id: &str,
) -> Result<Vec<SessionView>> {
    let rows = primary(db)?
        .prepare(
            "SELECT session_id,auth_method,authenticator_id,binding_id,amr_json,acr,\
             session_id=?2 AS is_current,authenticated_at,last_seen_at,\
             MIN(idle_expires_at,absolute_expires_at) AS expires_at,revoked_at \
             FROM identity_sessions WHERE principal_id=?1 AND ((revoked_at IS NULL \
             AND idle_expires_at>unixepoch() AND absolute_expires_at>unixepoch()) \
             OR revoked_at>=unixepoch()-2592000) ORDER BY authenticated_at DESC,session_id",
        )
        .bind(&[text(principal_id), text(current_session_id)])?
        .all()
        .await?
        .results::<SessionRow>()?;
    rows.into_iter().map(session_from_row).collect()
}

/// 撤销账户拥有的一个 session 及其 refresh-token families；重复调用保持成功。
/// Revokes one account-owned session and its refresh-token families; repeated calls remain successful.
pub async fn revoke_session(
    db: &D1Database,
    principal_id: &str,
    session_id: &str,
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<bool> {
    let results = db
        .batch(vec![
            db.prepare(
                "INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,\
                 actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision,context_json) \
                 SELECT ?1,'identity.session.revoked',?2,?2,?3,?3,'success',?4,1,json_object('scope','single','session_id',?5) \
                 FROM identity_sessions WHERE principal_id=?3 AND session_id=?5 AND revoked_at IS NULL",
            )
            .bind(&[
                text(audit_id),
                integer(now),
                text(principal_id),
                text(correlation_id),
                text(session_id),
            ])?,
            db.prepare(
                "UPDATE identity_sessions SET revoked_at=?3,revocation_reason='user_requested' \
                 WHERE principal_id=?1 AND session_id=?2 AND revoked_at IS NULL",
            )
            .bind(&[text(principal_id), text(session_id), integer(now)])?,
            db.prepare(
                "UPDATE oauth_refresh_token_families SET revoked_at=COALESCE(revoked_at,?3),\
                 revocation_reason=COALESCE(revocation_reason,'identity_session_revoked') \
                 WHERE principal_id=?1 AND identity_session_id=?2",
            )
            .bind(&[text(principal_id), text(session_id), integer(now)])?,
            conditional_archive_outbox(db, audit_id, now)?,
        ])
        .await?;
    changed(results.get(1))
}

/// 撤销账户全部 Identity session 和 refresh-token families。
/// Revokes every Identity session and refresh-token family owned by an account.
pub async fn revoke_all(
    db: &D1Database,
    principal_id: &str,
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<()> {
    db.batch(vec![
        db.prepare(
            "INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,\
             actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision,context_json) \
             SELECT ?1,'identity.session.revoked',?2,?2,?3,?3,'success',?4,1,'{\"scope\":\"all\"}' \
             FROM principals p WHERE p.principal_id=?3 AND (EXISTS(SELECT 1 FROM identity_sessions \
             WHERE principal_id=?3 AND revoked_at IS NULL) OR EXISTS(SELECT 1 FROM oauth_refresh_token_families \
             WHERE principal_id=?3 AND revoked_at IS NULL))",
        )
        .bind(&[
            text(audit_id),
            integer(now),
            text(principal_id),
            text(correlation_id),
        ])?,
        db.prepare(
            "UPDATE identity_sessions SET revoked_at=?2,revocation_reason='user_requested_all' \
             WHERE principal_id=?1 AND revoked_at IS NULL",
        )
        .bind(&[text(principal_id), integer(now)])?,
        db.prepare(
            "UPDATE oauth_refresh_token_families SET revoked_at=?2,revocation_reason='user_requested_all' \
             WHERE principal_id=?1 AND revoked_at IS NULL",
        )
        .bind(&[text(principal_id), integer(now)])?,
        conditional_archive_outbox(db, audit_id, now)?,
    ])
    .await?;
    Ok(())
}

/// 返回最新活动恢复码集合的生成时间和计数，不读取任何 secret。
/// Returns the newest active recovery-code set's generation time and counts without reading secrets.
pub async fn recovery_code_status(
    db: &D1Database,
    principal_id: &str,
) -> Result<Option<RecoveryCodeStatus>> {
    primary(db)?
        .prepare(
            "SELECT s.created_at AS generated_at,COUNT(c.recovery_code_id) AS total_count,\
             SUM(CASE WHEN c.used_at IS NULL THEN 1 ELSE 0 END) AS remaining_count \
             FROM recovery_code_sets s JOIN recovery_codes c \
             ON c.recovery_code_set_id=s.recovery_code_set_id \
             WHERE s.principal_id=?1 AND s.invalidated_at IS NULL GROUP BY s.recovery_code_set_id \
             ORDER BY s.created_at DESC,s.recovery_code_set_id DESC LIMIT 1",
        )
        .bind(&[text(principal_id)])?
        .first(None)
        .await
}

/// 原子失效旧集合，写入新恢复码摘要，并追加审计与归档 outbox。
/// Atomically invalidates old sets, writes new recovery-code digests, and appends audit and archive outbox rows.
#[allow(clippy::too_many_arguments)]
pub async fn rotate_recovery_codes(
    db: &D1Database,
    principal_id: &str,
    recovery_code_set_id: &str,
    codes: &[NewRecoveryCode],
    audit_id: &str,
    correlation_id: &str,
    now: i64,
) -> Result<()> {
    if !(8..=16).contains(&codes.len()) {
        return Err(Error::RustError(
            "recovery-code rotation requires 8 to 16 codes".into(),
        ));
    }
    let mut statements = vec![
        db.prepare(
            "UPDATE recovery_code_sets SET invalidated_at=?2 WHERE principal_id=?1 \
             AND invalidated_at IS NULL",
        )
        .bind(&[text(principal_id), integer(now)])?,
        db.prepare(
            "INSERT INTO recovery_code_sets(recovery_code_set_id,principal_id,created_at) \
             SELECT ?1,principal_id,?3 FROM principals WHERE principal_id=?2 \
             AND kind='human' AND lifecycle_state='active'",
        )
        .bind(&[text(recovery_code_set_id), text(principal_id), integer(now)])?,
    ];
    for code in codes {
        statements.push(
            db.prepare(
                "INSERT INTO recovery_codes(recovery_code_id,recovery_code_set_id,public_id,\
                 secret_digest,created_at) VALUES(?1,?2,?3,?4,?5)",
            )
            .bind(&[
                text(&code.recovery_code_id),
                text(recovery_code_set_id),
                text(&code.public_id),
                blob(&code.secret_digest),
                integer(now),
            ])?,
        );
    }
    statements.extend([
        db.prepare(
            "INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,\
             actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision) \
             VALUES(?1,'identity.recovery_codes.rotated',?2,?2,?3,?3,'success',?4,1)",
        )
        .bind(&[
            text(audit_id),
            integer(now),
            text(principal_id),
            text(correlation_id),
        ])?,
        archive_outbox(db, audit_id, now)?,
    ]);
    db.batch(statements).await?;
    Ok(())
}

async fn identifier(
    db: &D1Database,
    principal_id: &str,
    identifier_id: &str,
) -> Result<Option<IdentifierView>> {
    let row = primary(db)?
        .prepare(
            "SELECT identifier_id,kind,value,country_calling_code,national_number,is_primary,verification_state,verified_at,created_at,updated_at FROM identifiers \
             WHERE principal_id=?1 AND identifier_id=?2",
        )
        .bind(&[text(principal_id), text(identifier_id)])?
        .first::<IdentifierRow>(None)
        .await?;
    Ok(row.map(identifier_from_row))
}

async fn authenticator(
    db: &D1Database,
    principal_id: &str,
    authenticator_id: &str,
    current_authenticator_id: Option<&str>,
) -> Result<Option<AuthenticatorView>> {
    let row = primary(db)?
        .prepare(
            "SELECT authenticator_id,label,transports_json,backup_eligible,backup_state,\
             COALESCE(authenticator_id=?3,0) AS is_current,created_at,last_used_at,revoked_at \
             FROM authenticators WHERE principal_id=?1 AND authenticator_id=?2",
        )
        .bind(&[
            text(principal_id),
            text(authenticator_id),
            optional_text(current_authenticator_id),
        ])?
        .first::<AuthenticatorRow>(None)
        .await?;
    row.map(authenticator_from_row).transpose()
}

fn account_from_row(row: AccountRow) -> Result<AccountView> {
    let identifiers = match (
        row.identifier_id,
        row.identifier_kind,
        row.identifier_value,
        row.identifier_created_at,
        row.identifier_updated_at,
    ) {
        (Some(identifier_id), Some(kind), Some(value), Some(created_at), Some(updated_at)) => {
            vec![IdentifierView {
                identifier_id,
                kind,
                value,
                country_calling_code: None,
                national_number: None,
                is_primary: true,
                verification_state: "verified".to_owned(),
                verified_at: Some(created_at),
                created_at,
                updated_at,
            }]
        }
        (None, None, None, None, None) => Vec::new(),
        _ => {
            return Err(Error::RustError(
                "identifier projection contains a partial row".into(),
            ));
        }
    };
    Ok(AccountView {
        principal_id: row.principal_id,
        lifecycle_state: row.lifecycle_state,
        display_name: row.display_name,
        avatar_r2_key: row.avatar_r2_key,
        locale: row.locale,
        identifiers,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// 将 D1 的数值布尔表示转换为公开领域模型。
/// Converts D1's numeric boolean representation to the public domain model.
fn identifier_from_row(row: IdentifierRow) -> IdentifierView {
    IdentifierView {
        identifier_id: row.identifier_id,
        kind: row.kind,
        value: row.value,
        country_calling_code: row.country_calling_code,
        national_number: row.national_number,
        is_primary: row.is_primary != 0,
        verification_state: row.verification_state,
        verified_at: row.verified_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn authenticator_from_row(row: AuthenticatorRow) -> Result<AuthenticatorView> {
    Ok(AuthenticatorView {
        authenticator_id: row.authenticator_id,
        label: row.label,
        transports: serde_json::from_str(&row.transports_json)?,
        backup_eligible: row.backup_eligible != 0,
        backup_state: row.backup_state != 0,
        is_current: row.is_current != 0,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        revoked_at: row.revoked_at,
    })
}

fn session_from_row(row: SessionRow) -> Result<SessionView> {
    Ok(SessionView {
        session_id: row.session_id,
        auth_method: row.auth_method,
        authenticator_id: row.authenticator_id,
        binding_id: row.binding_id,
        amr: serde_json::from_str(&row.amr_json)?,
        acr: row.acr,
        is_current: row.is_current != 0,
        authenticated_at: row.authenticated_at,
        last_seen_at: row.last_seen_at,
        expires_at: row.expires_at,
        revoked_at: row.revoked_at,
    })
}

fn archive_outbox(
    db: &D1Database,
    audit_id: &str,
    now: i64,
) -> Result<worker::D1PreparedStatement> {
    db.prepare(
        "INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) \
         VALUES(?1,?2,?3)",
    )
    .bind(&[
        text(audit_id),
        text(&format!(
            "security-audit/{}/{audit_id}.json",
            day_bucket(now)
        )),
        integer(now),
    ])
}

/// 仅当同一 batch 已创建 audit 时建立 outbox；零行 mutation 因而保持无副作用。
/// Creates an outbox row only when the same batch created its audit, keeping zero-row mutations side-effect free.
fn conditional_archive_outbox(
    db: &D1Database,
    audit_id: &str,
    now: i64,
) -> Result<worker::D1PreparedStatement> {
    db.prepare(
        "INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) \
         SELECT audit_event_id,?2,?3 FROM security_audit_events WHERE audit_event_id=?1",
    )
    .bind(&[
        text(audit_id),
        text(&format!(
            "security-audit/{}/{audit_id}.json",
            day_bucket(now)
        )),
        integer(now),
    ])
}

fn primary(db: &D1Database) -> Result<worker::D1DatabaseSession> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)
}

fn changed(result: Option<&worker::D1Result>) -> Result<bool> {
    result.map_or(Ok(false), result_changed)
}

fn result_changed(result: &worker::D1Result) -> Result<bool> {
    Ok(result
        .meta()?
        .and_then(|meta| meta.changes)
        .is_some_and(|changes| changes > 0))
}

fn is_last_authenticator_error(error: &Error) -> bool {
    match error {
        // D1Error 的 Display 会格式化可能为空的 JavaScript `cause`，从而 panic；直接读取
        // 外层 Error.message，workerd 会把 SQLite trigger 文本放在这里。
        // D1Error's Display formats a possibly-null JavaScript `cause` and can panic.
        // Read the outer Error.message directly; workerd includes the SQLite trigger text there.
        Error::D1(error) => <worker::D1Error as AsRef<worker::js_sys::Error>>::as_ref(error)
            .message()
            .as_string()
            .is_some_and(|message| message.contains("last_authenticator")),
        _ => false,
    }
}

fn day_bucket(now: i64) -> String {
    format!("unix-day-{}", now / 86_400)
}

fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

fn optional_text(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, text)
}

fn integer(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}

fn boolean(value: bool) -> JsValue {
    JsValue::from_bool(value)
}

fn blob(value: &[u8]) -> JsValue {
    worker::js_sys::Uint8Array::from(value).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_projection_accepts_no_identifier() {
        let view = account_from_row(AccountRow {
            principal_id: "principal".into(),
            lifecycle_state: "active".into(),
            display_name: "Klee".into(),
            avatar_r2_key: None,
            locale: "zh-CN".into(),
            created_at: 10,
            updated_at: 20,
            identifier_id: None,
            identifier_kind: None,
            identifier_value: None,
            identifier_created_at: None,
            identifier_updated_at: None,
        })
        .expect("valid account row");
        assert!(view.identifiers.is_empty());
    }

    #[test]
    fn account_projection_rejects_partial_identifier() {
        let result = account_from_row(AccountRow {
            principal_id: "principal".into(),
            lifecycle_state: "active".into(),
            display_name: "Klee".into(),
            avatar_r2_key: None,
            locale: "zh-CN".into(),
            created_at: 10,
            updated_at: 20,
            identifier_id: Some("identifier".into()),
            identifier_kind: None,
            identifier_value: None,
            identifier_created_at: None,
            identifier_updated_at: None,
        });
        assert!(result.is_err());
    }

    #[test]
    fn numeric_identifier_flags_map_to_domain_booleans() {
        let primary = identifier_from_row(IdentifierRow {
            identifier_id: "primary".into(),
            kind: "email".into(),
            value: "klee@example.com".into(),
            country_calling_code: None,
            national_number: None,
            is_primary: 1,
            verification_state: "verified".into(),
            verified_at: Some(10),
            created_at: 10,
            updated_at: 20,
        });
        assert!(primary.is_primary);

        let secondary = identifier_from_row(IdentifierRow {
            identifier_id: "secondary".into(),
            kind: "mobile".into(),
            value: "+8613800138000".into(),
            country_calling_code: Some("86".into()),
            national_number: Some("13800138000".into()),
            is_primary: 0,
            verification_state: "unverified".into(),
            verified_at: None,
            created_at: 30,
            updated_at: 30,
        });
        assert!(!secondary.is_primary);
    }

    #[test]
    fn json_columns_are_decoded_at_the_adapter_boundary() {
        let authenticator = authenticator_from_row(AuthenticatorRow {
            authenticator_id: "authenticator".into(),
            label: "Laptop".into(),
            transports_json: r#"["internal","hybrid"]"#.into(),
            backup_eligible: 1,
            backup_state: 1,
            is_current: 1,
            created_at: 10,
            last_used_at: Some(20),
            revoked_at: None,
        })
        .expect("valid transports JSON");
        assert_eq!(authenticator.transports, ["internal", "hybrid"]);

        let session = session_from_row(SessionRow {
            session_id: "session".into(),
            auth_method: "passkey".into(),
            authenticator_id: Some("authenticator".into()),
            binding_id: None,
            amr_json: r#"["passkey"]"#.into(),
            acr: "urn:moesegfault:acr:passkey-uv".into(),
            is_current: 1,
            authenticated_at: 10,
            last_seen_at: 20,
            expires_at: 30,
            revoked_at: None,
        })
        .expect("valid AMR JSON");
        assert_eq!(session.amr, ["passkey"]);
    }

    #[test]
    fn audit_partition_is_stable() {
        assert_eq!(day_bucket(172_800), "unix-day-2");
    }

    #[test]
    fn step_up_replacement_is_bound_to_all_authorities() {
        for gate in [
            "t.kind='step_up'",
            "p.lifecycle_state='active'",
            "a.revoked_at IS NULL",
            "s.revoked_at IS NULL",
            "s.idle_expires_at>?7",
            "s.absolute_expires_at>?7",
        ] {
            assert!(
                STEP_UP_SESSION_INSERT_SQL.contains(gate),
                "missing replacement-session gate: {gate}"
            );
        }
        assert!(
            STEP_UP_SESSION_INSERT_SQL.contains("created_from_session_id")
                && STEP_UP_SESSION_INSERT_SQL.contains("s.session_id")
        );
        assert!(STEP_UP_SESSION_INSERT_SQL.contains("'[\"passkey\"]'"));
        assert!(STEP_UP_SESSION_INSERT_SQL.contains("'urn:moesegfault:acr:passkey-uv'"));
    }

    #[test]
    fn step_up_zero_row_guards_collide_with_one_time_consumption() {
        for guard in [STEP_UP_SESSION_GUARD_SQL, STEP_UP_SOURCE_GUARD_SQL] {
            assert!(guard.starts_with("INSERT INTO webauthn_transaction_consumptions"));
            assert!(guard.contains("NOT EXISTS"));
        }
        assert!(STEP_UP_SESSION_GUARD_SQL.contains("n.session_digest=?3"));
        assert!(STEP_UP_SOURCE_GUARD_SQL.contains("s.revocation_reason='step_up_replaced'"));
    }

    #[test]
    fn unverified_contact_explicitly_clears_schema_verified_default() {
        assert!(CREATE_CONTACT_SQL.contains("verification_state,verified_at"));
        assert!(CREATE_CONTACT_SQL.contains("'unverified',NULL"));
    }

    #[test]
    fn contact_update_preserves_primary_and_verification_decisions() {
        assert!(PROMOTE_CONTACT_SQL.contains("identifier_id<>?3 AND ?5=1"));
        assert!(PROMOTE_CONTACT_SQL.contains("principal_id=?1 AND kind=?2"));
        assert!(CANCEL_CONTACT_VERIFICATION_SQL.contains("state='pending'"));
        assert!(
            CANCEL_CONTACT_VERIFICATION_SQL.contains("principal_id=?2 AND normalized_value<>?4")
        );
        assert!(UPDATE_CONTACT_SQL.contains("identifier_id=?1 AND principal_id=?2"));
        assert!(UPDATE_CONTACT_SQL.contains("normalized_value<>?4 THEN 'unverified'"));
        assert!(UPDATE_CONTACT_SQL.contains("normalized_value<>?4 THEN NULL"));
    }
}
