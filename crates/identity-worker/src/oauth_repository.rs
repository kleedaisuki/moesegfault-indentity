//! OAuth/OIDC 的 D1 状态机。/ D1 state machines for OAuth/OIDC.
//!
//! 所有 bearer 凭据只以摘要落库；一次性消费由 D1 约束和事务批处理裁决。
//! Bearer credentials are persisted only as digests; D1 constraints and
//! transactional batches arbitrate every one-shot transition.

use serde::Deserialize;
use worker::{D1Database, D1SessionConstraint, Result, wasm_bindgen::JsValue};

const CODE_CONSUME_SQL: &str = "INSERT INTO oauth_authorization_code_uses(authorization_code_id,request_digest,used_at) SELECT c.authorization_code_id,?2,?3 FROM oauth_authorization_codes c JOIN identity_sessions s ON s.session_id=c.identity_session_id JOIN principals p ON p.principal_id=c.principal_id JOIN oauth_clients o ON o.client_id=c.client_id WHERE c.authorization_code_id=?1 AND c.client_id=?4 AND c.principal_id=?5 AND c.identity_session_id=?6 AND c.consumed_at IS NULL AND c.revoked_at IS NULL AND c.expires_at>?3 AND s.principal_id=c.principal_id AND s.revoked_at IS NULL AND s.idle_expires_at>?3 AND s.absolute_expires_at>?3 AND p.lifecycle_state='active' AND o.state='enabled'";
const REFRESH_ROTATE_INSERT_SQL: &str = "INSERT INTO oauth_refresh_tokens(refresh_token_id,refresh_token_family_id,token_digest,generation,issued_at,expires_at,state) SELECT ?1,f.refresh_token_family_id,?3,?4,?5,?6,'revoked' FROM oauth_refresh_token_families f JOIN identity_sessions s ON s.session_id=f.identity_session_id JOIN principals p ON p.principal_id=f.principal_id JOIN oauth_clients c ON c.client_id=f.client_id WHERE f.refresh_token_family_id=?2 AND f.client_id=?7 AND f.principal_id=?8 AND f.identity_session_id=?9 AND f.revoked_at IS NULL AND f.absolute_expires_at>?5 AND s.principal_id=f.principal_id AND s.revoked_at IS NULL AND s.idle_expires_at>?5 AND s.absolute_expires_at>?5 AND p.lifecycle_state='active' AND c.state='enabled' AND EXISTS(SELECT 1 FROM oauth_refresh_tokens old WHERE old.refresh_token_id=?10 AND old.refresh_token_family_id=f.refresh_token_family_id AND old.state='active' AND old.expires_at>?5)";
const REFRESH_ROTATE_GUARD_SQL: &str = "INSERT INTO oauth_refresh_tokens(refresh_token_id,refresh_token_family_id,token_digest,generation,issued_at,expires_at,state) SELECT '__invalid_refresh_commit_guard__',?2,x'',-1,0,0,'revoked' WHERE NOT EXISTS(SELECT 1 FROM oauth_refresh_tokens WHERE refresh_token_id=?1 AND refresh_token_family_id=?2 AND state='active')";
const AUTHORIZATION_RELINK_DELETE_SQL: &str = "DELETE FROM webauthn_authorization_links WHERE authorization_transaction_id=?1 AND EXISTS(SELECT 1 FROM oauth_authorization_transactions WHERE authorization_transaction_id=?1 AND state='awaiting_authentication' AND expires_at>?2)";
const AUTHORIZATION_RELINK_INSERT_SQL: &str = "INSERT INTO webauthn_authorization_links(webauthn_transaction_id,authorization_transaction_id) SELECT ?1,authorization_transaction_id FROM oauth_authorization_transactions WHERE authorization_transaction_id=?2 AND state='awaiting_authentication' AND expires_at>?3";

/// 已启用 OAuth client 及其部署策略。/ Enabled OAuth client and deployment policy.
#[derive(Debug, Deserialize)]
pub struct OAuthClient {
    pub client_id: String,
    pub client_type: String,
    pub token_endpoint_auth_method: String,
}

/// 待恢复的授权事务。/ Authorization transaction waiting to be resumed.
#[derive(Debug, Deserialize)]
pub struct AuthorizationTransaction {
    pub authorization_transaction_id: String,
    pub redirect_uri: String,
    pub state_value: String,
    pub principal_id: Option<String>,
    pub identity_session_id: Option<String>,
    pub state: String,
    pub expires_at: i64,
}

/// 可消费 authorization code 的完整上下文。/ Complete consumable authorization-code context.
#[derive(Debug, Deserialize)]
pub struct AuthorizationCodeGrant {
    pub authorization_code_id: String,
    pub client_id: String,
    pub principal_id: String,
    pub identity_session_id: String,
    pub redirect_uri: String,
    pub scope: String,
    pub nonce: String,
    pub code_challenge: String,
    pub expires_at: i64,
    pub authenticated_at: i64,
    pub session_idle_expires_at: i64,
    pub session_absolute_expires_at: i64,
    pub session_revoked_at: Option<i64>,
    pub amr_json: String,
    pub acr: String,
    pub display_name: String,
    pub username: String,
    pub sector_identifier: String,
    pub subject_salt_revision: i64,
}

/// 可轮换 refresh token 的完整上下文。/ Complete refresh-token rotation context.
#[derive(Debug, Deserialize)]
pub struct RefreshGrant {
    pub refresh_token_id: String,
    pub refresh_token_family_id: String,
    pub generation: i64,
    pub token_state: String,
    pub token_expires_at: i64,
    pub client_id: String,
    pub principal_id: String,
    pub identity_session_id: String,
    pub scope: String,
    pub absolute_expires_at: i64,
    pub family_revoked_at: Option<i64>,
    pub authenticated_at: i64,
    pub session_idle_expires_at: i64,
    pub session_absolute_expires_at: i64,
    pub session_revoked_at: Option<i64>,
    pub amr_json: String,
    pub acr: String,
    pub display_name: String,
    pub username: String,
    pub sector_identifier: String,
    pub subject_salt_revision: i64,
}

/// 访问 client assertion 验证所需公钥。/ Public key used to verify a client assertion.
#[derive(Debug, Deserialize)]
pub struct ClientKey {
    pub algorithm: String,
    pub public_jwk_json: String,
}

/// Client 的一条 authorization redirect 登记。/ One registered authorization redirect for a client.
#[derive(Debug, Deserialize)]
pub struct RedirectRegistration {
    pub redirect_uri: String,
    pub match_mode: String,
}

/// 根据 client ID 读取活动配置。/ Reads enabled configuration by client ID.
pub async fn client(db: &D1Database, client_id: &str) -> Result<Option<OAuthClient>> {
    primary(db)?
        .prepare("SELECT client_id,client_type,token_endpoint_auth_method FROM oauth_clients WHERE client_id=?1 AND state='enabled'")
        .bind(&[text(client_id)])?
        .first(None)
        .await
}

/// 读取 client 的 redirect 登记；匹配策略由纯协议层执行。
/// Reads a client's redirect registrations; the pure protocol layer applies matching policy.
pub async fn redirect_registrations(
    db: &D1Database,
    client_id: &str,
) -> Result<Vec<RedirectRegistration>> {
    primary(db)?
        .prepare("SELECT redirect_uri,match_mode FROM oauth_redirect_uris WHERE client_id=?1")
        .bind(&[text(client_id)])?
        .all()
        .await?
        .results()
}

/// 精确验证登记的 post-logout redirect URI。/ Exactly validates a registered post-logout redirect URI.
pub async fn exact_post_logout_redirect(
    db: &D1Database,
    client_id: &str,
    uri: &str,
) -> Result<bool> {
    Ok(primary(db)?.prepare("SELECT 1 AS found FROM oauth_post_logout_redirect_uris WHERE client_id=?1 AND redirect_uri=?2")
        .bind(&[text(client_id), text(uri)])?.first::<i64>(Some("found")).await?.is_some())
}

/// 检查 client 是否获授全部 scope。/ Checks that the client has every requested scope.
pub async fn scopes_allowed(db: &D1Database, client_id: &str, scopes: &[&str]) -> Result<bool> {
    for scope in scopes {
        let found = primary(db)?
            .prepare("SELECT 1 AS found FROM oauth_client_scopes WHERE client_id=?1 AND scope=?2")
            .bind(&[text(client_id), text(scope)])?
            .first::<i64>(Some("found"))
            .await?;
        if found.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

/// 创建服务端保存的原始 authorization request。/ Creates a server-held original authorization request.
#[allow(clippy::too_many_arguments)]
pub async fn insert_authorization_transaction(
    db: &D1Database,
    id: &str,
    client_id: &str,
    redirect_uri: &str,
    scope: &str,
    state: &str,
    nonce: &str,
    challenge: &str,
    principal_id: Option<&str>,
    identity_session_id: Option<&str>,
    now: i64,
    expires_at: i64,
) -> Result<()> {
    let transaction_state = if principal_id.is_some() {
        "authenticated"
    } else {
        "awaiting_authentication"
    };
    db.prepare("INSERT INTO oauth_authorization_transactions(authorization_transaction_id,client_id,redirect_uri,response_type,scope,state_value,nonce,code_challenge,code_challenge_method,principal_id,identity_session_id,state,created_at,expires_at) VALUES(?1,?2,?3,'code',?4,?5,?6,?7,'S256',?8,?9,?10,?11,?12)")
        .bind(&[text(id),text(client_id),text(redirect_uri),text(scope),text(state),text(nonce),text(challenge),optional_text(principal_id),optional_text(identity_session_id),text(transaction_state),integer(now),integer(expires_at)])?
        .run().await?;
    Ok(())
}

/// 将 WebAuthn ceremony 与待认证 authorization transaction 连接。
/// Links a WebAuthn ceremony to an authorization transaction awaiting authentication.
pub async fn link_webauthn_authorization(
    db: &D1Database,
    authorization_transaction_id: &str,
    webauthn_transaction_id: &str,
    now: i64,
) -> Result<bool> {
    let results = db
        .batch(vec![
            db.prepare(AUTHORIZATION_RELINK_DELETE_SQL)
                .bind(&[text(authorization_transaction_id), integer(now)])?,
            db.prepare(AUTHORIZATION_RELINK_INSERT_SQL).bind(&[
                text(webauthn_transaction_id),
                text(authorization_transaction_id),
                integer(now),
            ])?,
        ])
        .await?;
    Ok(results
        .get(1)
        .and_then(|result| result.meta().ok())
        .flatten()
        .and_then(|meta| meta.changes)
        .is_some_and(|changes| changes > 0))
}

/// 读取已与新 session 原子提交的 authorization transaction ID。
/// Reads the authorization transaction ID atomically committed with the new session.
pub async fn authenticate_linked_authorization(
    db: &D1Database,
    webauthn_transaction_id: &str,
    principal_id: &str,
    identity_session_id: &str,
    now: i64,
) -> Result<Option<String>> {
    #[derive(Deserialize)]
    struct Link {
        authorization_transaction_id: String,
    }
    primary(db)?.prepare("SELECT l.authorization_transaction_id FROM webauthn_authorization_links l JOIN oauth_authorization_transactions a ON a.authorization_transaction_id=l.authorization_transaction_id WHERE l.webauthn_transaction_id=?1 AND a.state='authenticated' AND a.principal_id=?2 AND a.identity_session_id=?3 AND a.expires_at>?4")
        .bind(&[text(webauthn_transaction_id),text(principal_id),text(identity_session_id),integer(now)])?.first::<Link>(None).await
        .map(|row| row.map(|link| link.authorization_transaction_id))
}

/// 读取 authorization transaction（primary-first）。/ Reads an authorization transaction primary-first.
pub async fn authorization_transaction(
    db: &D1Database,
    id: &str,
) -> Result<Option<AuthorizationTransaction>> {
    primary(db)?.prepare("SELECT authorization_transaction_id,redirect_uri,state_value,principal_id,identity_session_id,state,expires_at FROM oauth_authorization_transactions WHERE authorization_transaction_id=?1")
        .bind(&[text(id)])?.first(None).await
}

/// 原子完成授权事务并写入一次性 code。/ Atomically completes an authorization transaction and inserts a one-shot code.
#[allow(clippy::too_many_arguments)]
pub async fn issue_authorization_code(
    db: &D1Database,
    tx: &AuthorizationTransaction,
    code_id: &str,
    code_digest: &[u8],
    session_id: &str,
    principal_id: &str,
    now: i64,
    expires_at: i64,
) -> Result<bool> {
    let statements = vec![
        db.prepare("UPDATE oauth_authorization_transactions SET state='completed',consumed_at=?2 WHERE authorization_transaction_id=?1 AND state='authenticated' AND identity_session_id=?3 AND principal_id=?4 AND expires_at>?2 AND EXISTS(SELECT 1 FROM identity_sessions s JOIN principals p ON p.principal_id=s.principal_id JOIN oauth_clients c ON c.client_id=oauth_authorization_transactions.client_id WHERE s.session_id=?3 AND s.principal_id=?4 AND s.revoked_at IS NULL AND s.idle_expires_at>?2 AND s.absolute_expires_at>?2 AND p.lifecycle_state='active' AND c.state='enabled')")
            .bind(&[text(&tx.authorization_transaction_id),integer(now),text(session_id),text(principal_id)])?,
        db.prepare("INSERT INTO oauth_authorization_codes(authorization_code_id,code_digest,authorization_transaction_id,client_id,principal_id,identity_session_id,redirect_uri,scope,nonce,code_challenge,code_challenge_method,issued_at,expires_at) SELECT ?1,?2,authorization_transaction_id,client_id,principal_id,identity_session_id,redirect_uri,scope,nonce,code_challenge,code_challenge_method,?4,?5 FROM oauth_authorization_transactions WHERE authorization_transaction_id=?3 AND state='completed' AND consumed_at=?4")
            .bind(&[text(code_id),blob(code_digest),text(&tx.authorization_transaction_id),integer(now),integer(expires_at)])?,
    ];
    let results = db.batch(statements).await?;
    Ok(results
        .get(1)
        .and_then(|r| r.meta().ok())
        .flatten()
        .and_then(|m| m.changes)
        .is_some_and(|changes| changes > 0))
}

/// 读取尚未消费的 authorization code。/ Reads an unconsumed authorization code.
pub async fn authorization_code(
    db: &D1Database,
    digest: &[u8],
) -> Result<Option<AuthorizationCodeGrant>> {
    primary(db)?.prepare("SELECT c.authorization_code_id,c.client_id,c.principal_id,c.identity_session_id,c.redirect_uri,c.scope,c.nonce,c.code_challenge,c.expires_at,s.authenticated_at,s.idle_expires_at AS session_idle_expires_at,s.absolute_expires_at AS session_absolute_expires_at,s.revoked_at AS session_revoked_at,s.amr_json,s.acr,h.display_name,i.value AS username,o.sector_identifier,o.subject_salt_revision FROM oauth_authorization_codes c JOIN identity_sessions s ON s.session_id=c.identity_session_id JOIN human_profiles h ON h.principal_id=c.principal_id JOIN identifiers i ON i.principal_id=c.principal_id AND i.kind='username' JOIN oauth_clients o ON o.client_id=c.client_id WHERE c.code_digest=?1 AND c.consumed_at IS NULL AND c.revoked_at IS NULL")
        .bind(&[blob(digest)])?.first(None).await
}

/// 消费 code，并按 offline_access 决定是否创建 refresh family。
/// Consumes a code and optionally creates a refresh family for offline_access.
#[allow(clippy::too_many_arguments)]
pub async fn consume_code(
    db: &D1Database,
    grant: &AuthorizationCodeGrant,
    request_digest: &[u8],
    family: Option<(&str, &str, &[u8])>,
    now: i64,
    refresh_expires_at: i64,
) -> Result<()> {
    let mut statements = vec![db.prepare(CODE_CONSUME_SQL).bind(&[
        text(&grant.authorization_code_id),
        blob(request_digest),
        integer(now),
        text(&grant.client_id),
        text(&grant.principal_id),
        text(&grant.identity_session_id),
    ])?];
    let authorization_id = identity_domain::TransactionId::new_v7((now as u64) * 1_000).to_string();
    let scopes_json =
        serde_json::to_string(&grant.scope.split_ascii_whitespace().collect::<Vec<_>>())?;
    statements.push(db.prepare("INSERT OR IGNORE INTO oauth_user_authorizations(authorization_id,principal_id,client_id,scopes_json,granted_at,updated_at,last_used_at) SELECT ?1,?2,?3,?4,?5,?5,?5 WHERE EXISTS(SELECT 1 FROM oauth_authorization_code_uses WHERE authorization_code_id=?6 AND request_digest=?7 AND used_at=?5)")
        .bind(&[text(&authorization_id),text(&grant.principal_id),text(&grant.client_id),text(&scopes_json),integer(now),text(&grant.authorization_code_id),blob(request_digest)])?);
    statements.push(db.prepare("UPDATE oauth_user_authorizations SET scopes_json=?3,updated_at=?4,last_used_at=?4 WHERE principal_id=?1 AND client_id=?2 AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM oauth_authorization_code_uses WHERE authorization_code_id=?5 AND request_digest=?6 AND used_at=?4)")
        .bind(&[text(&grant.principal_id),text(&grant.client_id),text(&scopes_json),integer(now),text(&grant.authorization_code_id),blob(request_digest)])?);
    if let Some((family_id, token_id, token_digest)) = family {
        statements.push(db.prepare("INSERT INTO oauth_refresh_token_families(refresh_token_family_id,client_id,principal_id,identity_session_id,scope,audience,created_at,absolute_expires_at) SELECT ?1,?2,?3,?4,?5,?2,?6,?7 WHERE EXISTS(SELECT 1 FROM oauth_authorization_code_uses WHERE authorization_code_id=?8 AND request_digest=?9 AND used_at=?6)")
            .bind(&[text(family_id),text(&grant.client_id),text(&grant.principal_id),text(&grant.identity_session_id),text(&grant.scope),integer(now),integer(refresh_expires_at),text(&grant.authorization_code_id),blob(request_digest)])?);
        statements.push(db.prepare("INSERT INTO oauth_refresh_tokens(refresh_token_id,refresh_token_family_id,token_digest,generation,issued_at,expires_at,state) SELECT ?1,?2,?3,0,?4,?5,'active' WHERE EXISTS(SELECT 1 FROM oauth_refresh_token_families WHERE refresh_token_family_id=?2)")
            .bind(&[text(token_id),text(family_id),blob(token_digest),integer(now),integer(refresh_expires_at)])?);
    }
    // 故意非法的 row 把零行 gate 转为事务失败，从而回滚整个 D1 batch。
    // The invalid row turns a zero-row gate into failure and rolls back the batch.
    statements.push(db.prepare("INSERT INTO oauth_authorization_code_uses(authorization_code_id,request_digest,used_at) SELECT '__invalid_code_commit_guard__',x'',0 WHERE NOT EXISTS(SELECT 1 FROM oauth_authorization_code_uses WHERE authorization_code_id=?1 AND request_digest=?2 AND used_at=?3)")
        .bind(&[text(&grant.authorization_code_id),blob(request_digest),integer(now)])?);
    db.batch(statements).await?;
    Ok(())
}

/// 读取 refresh token，包括已轮换 token，以支持重用检测。
/// Reads a refresh token, including rotated tokens, so reuse can be detected.
pub async fn refresh_grant(db: &D1Database, digest: &[u8]) -> Result<Option<RefreshGrant>> {
    primary(db)?.prepare("SELECT t.refresh_token_id,t.refresh_token_family_id,t.generation,t.state AS token_state,t.expires_at AS token_expires_at,f.client_id,f.principal_id,f.identity_session_id,f.scope,f.absolute_expires_at,f.revoked_at AS family_revoked_at,s.authenticated_at,s.idle_expires_at AS session_idle_expires_at,s.absolute_expires_at AS session_absolute_expires_at,s.revoked_at AS session_revoked_at,s.amr_json,s.acr,h.display_name,i.value AS username,o.sector_identifier,o.subject_salt_revision FROM oauth_refresh_tokens t JOIN oauth_refresh_token_families f ON f.refresh_token_family_id=t.refresh_token_family_id JOIN identity_sessions s ON s.session_id=f.identity_session_id JOIN human_profiles h ON h.principal_id=f.principal_id JOIN identifiers i ON i.principal_id=f.principal_id AND i.kind='username' JOIN oauth_clients o ON o.client_id=f.client_id WHERE t.token_digest=?1")
        .bind(&[blob(digest)])?.first(None).await
}

/// 检测重用后撤销整个 family。/ Revokes the entire family after detecting reuse.
pub async fn revoke_family_for_reuse(db: &D1Database, family_id: &str, now: i64) -> Result<()> {
    db.prepare("UPDATE oauth_refresh_token_families SET revoked_at=COALESCE(revoked_at,?2),revocation_reason=COALESCE(revocation_reason,'refresh_token_reuse'),reuse_detected_at=COALESCE(reuse_detected_at,?2) WHERE refresh_token_family_id=?1")
        .bind(&[text(family_id),integer(now)])?.run().await?;
    Ok(())
}

/// 用三步状态转换轮换 token，避开 FK 与“每 family 一个 active”约束的环。
/// Rotates a token in three states to satisfy both the replacement FK and one-active index.
pub async fn rotate_refresh(
    db: &D1Database,
    grant: &RefreshGrant,
    new_token_id: &str,
    new_digest: &[u8],
    now: i64,
    expires_at: i64,
) -> Result<()> {
    db.batch(vec![
        db.prepare(REFRESH_ROTATE_INSERT_SQL)
            .bind(&[text(new_token_id),text(&grant.refresh_token_family_id),blob(new_digest),integer(grant.generation+1),integer(now),integer(expires_at),text(&grant.client_id),text(&grant.principal_id),text(&grant.identity_session_id),text(&grant.refresh_token_id)])?,
        db.prepare("UPDATE oauth_refresh_tokens SET state='rotated',consumed_at=?2,replacement_token_id=?3 WHERE refresh_token_id=?1 AND refresh_token_family_id=?4 AND state='active' AND EXISTS(SELECT 1 FROM oauth_refresh_tokens replacement WHERE replacement.refresh_token_id=?3 AND replacement.refresh_token_family_id=?4 AND replacement.state='revoked')")
            .bind(&[text(&grant.refresh_token_id),integer(now),text(new_token_id),text(&grant.refresh_token_family_id)])?,
        db.prepare("UPDATE oauth_refresh_tokens SET state='active' WHERE refresh_token_id=?1 AND refresh_token_family_id=?2 AND state='revoked' AND EXISTS(SELECT 1 FROM oauth_refresh_tokens old WHERE old.refresh_token_id=?3 AND old.state='rotated' AND old.replacement_token_id=?1)")
            .bind(&[text(new_token_id),text(&grant.refresh_token_family_id),text(&grant.refresh_token_id)])?,
        // commit-time authority gate 未产生活动 token 时，用非法 CHECK/FK 值回滚。
        // Invalid CHECK/FK values roll back when the authority gate produced no active token.
        db.prepare(REFRESH_ROTATE_GUARD_SQL)
            .bind(&[text(new_token_id),text(&grant.refresh_token_family_id)])?,
    ]).await?;
    Ok(())
}

/// 按 refresh token 摘要和 client 撤销 family；未知 token 仍成功。
/// Revokes a family by refresh digest and client; an unknown token still succeeds.
pub async fn revoke_by_refresh_digest(
    db: &D1Database,
    digest: &[u8],
    client_id: &str,
    now: i64,
) -> Result<()> {
    db.prepare("UPDATE oauth_refresh_token_families SET revoked_at=COALESCE(revoked_at,?3),revocation_reason=COALESCE(revocation_reason,'client_revocation') WHERE client_id=?2 AND refresh_token_family_id IN (SELECT refresh_token_family_id FROM oauth_refresh_tokens WHERE token_digest=?1)")
        .bind(&[blob(digest),text(client_id),integer(now)])?.run().await?;
    Ok(())
}

/// 读取 client assertion 的活动 JWK。/ Reads an active JWK for a client assertion.
pub async fn client_key(db: &D1Database, client_id: &str, kid: &str) -> Result<Option<ClientKey>> {
    primary(db)?.prepare("SELECT algorithm,public_jwk_json FROM oauth_client_keys WHERE client_id=?1 AND kid=?2 AND retired_at IS NULL")
        .bind(&[text(client_id),text(kid)])?.first(None).await
}

/// 记录 client assertion jti；唯一约束拒绝重放。/ Records a client assertion jti; uniqueness rejects replay.
pub async fn record_client_assertion(
    db: &D1Database,
    client_id: &str,
    digest: &[u8],
    expires_at: i64,
) -> Result<()> {
    db.prepare("INSERT INTO oauth_client_assertion_replays(client_id,jti_digest,expires_at) VALUES(?1,?2,?3)")
        .bind(&[text(client_id),blob(digest),integer(expires_at)])?.run().await?;
    Ok(())
}

/// 幂等持久化并读取 pairwise subject。/ Idempotently persists and reads a pairwise subject.
pub async fn ensure_pairwise_subject(
    db: &D1Database,
    sector: &str,
    principal_id: &str,
    subject: &str,
    revision: i64,
    now: i64,
) -> Result<String> {
    db.prepare("INSERT OR IGNORE INTO pairwise_subjects(sector_identifier,principal_id,pairwise_subject,salt_revision,created_at) VALUES(?1,?2,?3,?4,?5)")
        .bind(&[text(sector),text(principal_id),text(subject),integer(revision),integer(now)])?.run().await?;
    #[derive(Deserialize)]
    struct Row {
        pairwise_subject: String,
    }
    let row = primary(db)?.prepare("SELECT pairwise_subject FROM pairwise_subjects WHERE sector_identifier=?1 AND principal_id=?2")
        .bind(&[text(sector),text(principal_id)])?.first::<Row>(None).await?;
    row.map(|r| r.pairwise_subject)
        .ok_or_else(|| worker::Error::RustError("pairwise subject disappeared".into()))
}

/// 以 session ID 撤销 Identity session 与关联 refresh families。
/// Revokes an Identity session and all refresh families linked to it.
pub async fn logout_session(db: &D1Database, session_id: &str, now: i64) -> Result<()> {
    db.batch(vec![
        db.prepare("UPDATE identity_sessions SET revoked_at=COALESCE(revoked_at,?2),revocation_reason=COALESCE(revocation_reason,'oidc_logout') WHERE session_id=?1")
            .bind(&[text(session_id),integer(now)])?,
        db.prepare("UPDATE oauth_refresh_token_families SET revoked_at=COALESCE(revoked_at,?2),revocation_reason=COALESCE(revocation_reason,'identity_session_logout') WHERE identity_session_id=?1")
            .bind(&[text(session_id),integer(now)])?,
    ]).await?;
    Ok(())
}

fn primary(db: &D1Database) -> Result<worker::D1DatabaseSession> {
    db.with_session_constraint(D1SessionConstraint::FirstPrimary)
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
fn optional_text(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_commits_gate_every_mutable_authority() {
        for clause in [
            "f.revoked_at IS NULL",
            "f.absolute_expires_at>?5",
            "s.revoked_at IS NULL",
            "s.idle_expires_at>?5",
            "s.absolute_expires_at>?5",
            "p.lifecycle_state='active'",
            "c.state='enabled'",
            "old.state='active'",
        ] {
            assert!(
                REFRESH_ROTATE_INSERT_SQL.contains(clause),
                "missing {clause}"
            );
        }
        assert!(REFRESH_ROTATE_GUARD_SQL.contains("WHERE NOT EXISTS"));
        for clause in [
            "c.consumed_at IS NULL",
            "s.revoked_at IS NULL",
            "p.lifecycle_state='active'",
            "o.state='enabled'",
        ] {
            assert!(CODE_CONSUME_SQL.contains(clause), "missing {clause}");
        }
    }

    #[test]
    fn authorization_relink_is_limited_to_pending_transactions() {
        for sql in [
            AUTHORIZATION_RELINK_DELETE_SQL,
            AUTHORIZATION_RELINK_INSERT_SQL,
        ] {
            assert!(sql.contains("state='awaiting_authentication'"));
            assert!(sql.contains("expires_at>"));
        }
    }
}
