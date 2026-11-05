//! D1 state transitions for device authorization. Only digests of device and user codes persist.

use serde::Deserialize;
use worker::{D1Database, D1SessionConstraint, Result, wasm_bindgen::JsValue};

#[derive(Debug, Deserialize)]
pub struct DeviceRequest {
    pub id: String,
    pub client_id: String,
    pub client_name: String,
    pub scope: String,
    pub state: String,
    pub expires_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct DevicePoll {
    pub id: String,
    pub state: String,
    pub expires_at: i64,
    pub poll_interval: i64,
    pub slow_down: i64,
}

#[derive(Debug, Deserialize)]
pub struct DeviceGrant {
    pub id: String,
    pub client_id: String,
    pub principal_id: String,
    pub identity_session_id: String,
    pub scope: String,
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

#[allow(clippy::too_many_arguments)]
pub async fn insert(
    db: &D1Database,
    id: &str,
    device_digest: &[u8],
    user_digest: &[u8],
    client_id: &str,
    scope: &str,
    now: i64,
    expires: i64,
) -> Result<()> {
    db.prepare("INSERT INTO oauth_device_authorizations(device_authorization_id,device_code_digest,user_code_digest,client_id,scope,created_at,expires_at,next_poll_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?6+5)")
        .bind(&[text(id),blob(device_digest),blob(user_digest),text(client_id),text(scope),integer(now),integer(expires)])?
        .run().await?;
    Ok(())
}

pub async fn lookup(
    db: &D1Database,
    user_digest: &[u8],
    _now: i64,
) -> Result<Option<DeviceRequest>> {
    primary(db)?.prepare("SELECT d.device_authorization_id AS id,d.client_id,c.display_name AS client_name,d.scope,d.state,d.expires_at FROM oauth_device_authorizations d JOIN oauth_clients c ON c.client_id=d.client_id WHERE d.user_code_digest=?1 AND c.state='enabled' AND c.device_authorization_enabled=1")
        .bind(&[blob(user_digest)])?.first(None).await
}

pub async fn decide(
    db: &D1Database,
    user_digest: &[u8],
    principal_id: &str,
    session_id: &str,
    decision: &str,
    now: i64,
) -> Result<bool> {
    let result = db.prepare("UPDATE oauth_device_authorizations SET state=CASE WHEN ?4='approve' THEN 'approved' ELSE 'denied' END,principal_id=CASE WHEN ?4='approve' THEN ?2 ELSE NULL END,identity_session_id=CASE WHEN ?4='approve' THEN ?3 ELSE NULL END WHERE user_code_digest=?1 AND state='pending' AND expires_at>?5 AND EXISTS(SELECT 1 FROM identity_sessions s JOIN principals p ON p.principal_id=s.principal_id WHERE s.session_id=?3 AND s.principal_id=?2 AND s.revoked_at IS NULL AND s.idle_expires_at>?5 AND s.absolute_expires_at>?5 AND p.lifecycle_state='active') AND EXISTS(SELECT 1 FROM oauth_clients c WHERE c.client_id=oauth_device_authorizations.client_id AND c.state='enabled' AND c.device_authorization_enabled=1)")
        .bind(&[blob(user_digest),text(principal_id),text(session_id),text(decision),integer(now)])?
        .run().await?;
    Ok(result
        .meta()?
        .and_then(|meta| meta.changes)
        .is_some_and(|n| n > 0))
}

/// The old next_poll_at is tested inside the same update that advances it, including concurrent polls.
pub async fn poll(
    db: &D1Database,
    device_digest: &[u8],
    client_id: &str,
    now: i64,
) -> Result<Option<DevicePoll>> {
    db.prepare("UPDATE oauth_device_authorizations SET last_poll_early=CASE WHEN state IN ('pending','approved') AND expires_at>?3 AND ?3<next_poll_at THEN 1 ELSE 0 END,next_poll_at=CASE WHEN state IN ('pending','approved') AND expires_at>?3 THEN ?3+poll_interval+CASE WHEN ?3<next_poll_at THEN 5 ELSE 0 END ELSE next_poll_at END,poll_interval=poll_interval+CASE WHEN state IN ('pending','approved') AND expires_at>?3 AND ?3<next_poll_at THEN 5 ELSE 0 END WHERE device_code_digest=?1 AND client_id=?2 RETURNING device_authorization_id AS id,state,expires_at,poll_interval,last_poll_early AS slow_down")
        .bind(&[blob(device_digest),text(client_id),integer(now)])?.first(None).await
}

pub async fn grant(db: &D1Database, id: &str) -> Result<Option<DeviceGrant>> {
    primary(db)?.prepare("SELECT d.device_authorization_id AS id,d.client_id,d.principal_id,d.identity_session_id,d.scope,d.expires_at,s.authenticated_at,s.idle_expires_at AS session_idle_expires_at,s.absolute_expires_at AS session_absolute_expires_at,s.revoked_at AS session_revoked_at,s.amr_json,s.acr,h.display_name,i.value AS username,c.sector_identifier,c.subject_salt_revision FROM oauth_device_authorizations d JOIN identity_sessions s ON s.session_id=d.identity_session_id JOIN human_profiles h ON h.principal_id=d.principal_id JOIN identifiers i ON i.principal_id=d.principal_id AND i.kind='username' JOIN oauth_clients c ON c.client_id=d.client_id WHERE d.device_authorization_id=?1 AND d.state='approved'")
        .bind(&[text(id)])?.first(None).await
}

/// A fresh consumption marker gates every write in the batch, so a losing concurrent request writes nothing.
pub async fn consume(
    db: &D1Database,
    grant: &DeviceGrant,
    family: Option<(&str, &str, &[u8])>,
    now: i64,
    refresh_expires_at: i64,
) -> Result<bool> {
    let marker = uuid::Uuid::new_v4().to_string();
    let scopes = serde_json::to_string(&grant.scope.split_ascii_whitespace().collect::<Vec<_>>())?;
    let mut statements = vec![db.prepare("UPDATE oauth_device_authorizations SET state='consumed',consumption_id=?2 WHERE device_authorization_id=?1 AND state='approved' AND expires_at>?3 AND client_id=?4 AND principal_id=?5 AND identity_session_id=?6 AND EXISTS(SELECT 1 FROM identity_sessions s JOIN principals p ON p.principal_id=s.principal_id WHERE s.session_id=?6 AND s.principal_id=?5 AND s.revoked_at IS NULL AND s.idle_expires_at>?3 AND s.absolute_expires_at>?3 AND p.lifecycle_state='active') AND EXISTS(SELECT 1 FROM oauth_clients c WHERE c.client_id=?4 AND c.state='enabled' AND c.device_authorization_enabled=1)")
        .bind(&[text(&grant.id),text(&marker),integer(now),text(&grant.client_id),text(&grant.principal_id),text(&grant.identity_session_id)])?];
    let authorization_id = uuid::Uuid::new_v4().to_string();
    statements.push(db.prepare("INSERT OR IGNORE INTO oauth_user_authorizations(authorization_id,principal_id,client_id,scopes_json,granted_at,updated_at,last_used_at) SELECT ?1,?2,?3,?4,?5,?5,?5 WHERE EXISTS(SELECT 1 FROM oauth_device_authorizations WHERE device_authorization_id=?6 AND consumption_id=?7)")
        .bind(&[text(&authorization_id),text(&grant.principal_id),text(&grant.client_id),text(&scopes),integer(now),text(&grant.id),text(&marker)])?);
    statements.push(db.prepare("UPDATE oauth_user_authorizations SET scopes_json=?3,updated_at=?4,last_used_at=?4 WHERE principal_id=?1 AND client_id=?2 AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM oauth_device_authorizations WHERE device_authorization_id=?5 AND consumption_id=?6)")
        .bind(&[text(&grant.principal_id),text(&grant.client_id),text(&scopes),integer(now),text(&grant.id),text(&marker)])?);
    if let Some((family_id, token_id, token_digest)) = family {
        statements.push(db.prepare("INSERT INTO oauth_refresh_token_families(refresh_token_family_id,client_id,principal_id,identity_session_id,scope,audience,created_at,absolute_expires_at) SELECT ?1,?2,?3,?4,?5,?2,?6,?7 WHERE EXISTS(SELECT 1 FROM oauth_device_authorizations WHERE device_authorization_id=?8 AND consumption_id=?9)")
            .bind(&[text(family_id),text(&grant.client_id),text(&grant.principal_id),text(&grant.identity_session_id),text(&grant.scope),integer(now),integer(refresh_expires_at),text(&grant.id),text(&marker)])?);
        statements.push(db.prepare("INSERT INTO oauth_refresh_tokens(refresh_token_id,refresh_token_family_id,token_digest,generation,issued_at,expires_at,state) SELECT ?1,?2,?3,0,?4,?5,'active' WHERE EXISTS(SELECT 1 FROM oauth_refresh_token_families WHERE refresh_token_family_id=?2)")
            .bind(&[text(token_id),text(family_id),blob(token_digest),integer(now),integer(refresh_expires_at)])?);
    }
    let results = db.batch(statements).await?;
    Ok(results
        .first()
        .and_then(|result| result.meta().ok())
        .flatten()
        .and_then(|meta| meta.changes)
        .is_some_and(|n| n > 0))
}

pub async fn reserve_attempt(
    db: &D1Database,
    bucket: &[u8],
    now: i64,
    window: i64,
    limit: i64,
) -> Result<bool> {
    let row = db.prepare("INSERT INTO oauth_device_verification_attempts(bucket_digest,bucket_start,attempt_count) VALUES(?1,?2,1) ON CONFLICT(bucket_digest,bucket_start) DO UPDATE SET attempt_count=attempt_count+1 WHERE attempt_count<?3 RETURNING attempt_count")
        .bind(&[blob(bucket),integer(now / window * window),integer(limit)])?.first::<i64>(Some("attempt_count")).await?;
    Ok(row.is_some())
}

pub async fn purge_expired(db: &D1Database, now: i64, limit: i64) -> Result<()> {
    db.batch(vec![
        db.prepare("DELETE FROM oauth_device_authorizations WHERE device_authorization_id IN (SELECT device_authorization_id FROM oauth_device_authorizations WHERE expires_at<=?1 ORDER BY expires_at LIMIT ?2)")
            .bind(&[integer(now - 86_400),integer(limit)])?,
        db.prepare("DELETE FROM oauth_device_verification_attempts WHERE (bucket_digest,bucket_start) IN (SELECT bucket_digest,bucket_start FROM oauth_device_verification_attempts WHERE bucket_start<?1 LIMIT ?2)")
            .bind(&[integer(now - 3600),integer(limit)])?,
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
