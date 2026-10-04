//! 可选密码认证适配器。/ Optional password-authentication adapter.
//!
//! 密码与 Passkey 是并列方法：注册密码不会隐式创建 Passkey，之后可在账户站添加。
//! Password and passkeys are peer methods: password registration does not
//! implicitly create a passkey, which can be added later from the account app.

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use identity_domain::{
    AuditEventId, IdentifierId, LoginIdentifier, PrincipalId, SecretDigest, SessionId,
    TransactionId, normalize_email, normalize_mobile, normalize_username, validate_password,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use worker::{Env, Error, Headers, Request, Response, Result, RouteContext, wasm_bindgen::JsValue};

use crate::{guard, oauth, problem, repository};

const MAX_BODY_BYTES: u64 = 65_536;
const PASSWORD_ATTEMPT_TTL_SECONDS: i64 = 86_400;
const PASSWORD_PARAMETERS: &str =
    r#"{"algorithm":"argon2id","version":19,"memory_kib":19456,"iterations":2,"parallelism":1}"#;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PasswordRegistrationRequest {
    username: String,
    password: String,
    display_name: String,
    email: String,
    #[serde(default)]
    email_verification_token: Option<String>,
    /// Optional OAuth transaction resumed by the new account's authenticated session.
    #[serde(default)]
    authorization_transaction_id: Option<String>,
    #[serde(default)]
    mobile: Option<MobileInput>,
    #[serde(default = "default_locale")]
    locale: String,
    #[serde(default)]
    registration_capability: Option<String>,
    #[serde(default)]
    profile: RegistrationProfileInput,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistrationProfileInput {
    #[serde(default)]
    status_message: Option<String>,
    #[serde(default)]
    favorite_character: Option<String>,
    #[serde(default)]
    interests: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MobileInput {
    country_calling_code: String,
    national_number: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PasswordAuthenticationRequest {
    login: String,
    password: String,
    #[serde(default)]
    authorization_transaction_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PasswordIdentity {
    principal_id: String,
    password_hash: String,
    password_version: i64,
    lifecycle_state: String,
}

#[derive(Debug, Serialize)]
struct SessionWire<'a> {
    session_id: &'a str,
    authentication_method: &'static str,
    authenticator_id: Option<String>,
    binding_id: Option<String>,
    amr: [&'static str; 1],
    acr: &'static str,
    is_current: bool,
    authenticated_at: String,
    last_seen_at: String,
    expires_at: String,
    revoked_at: Option<String>,
}

/// 以密码直接创建账户；邀请码与所有账户行在一个 D1 batch 中消费。
/// Directly creates a password account; the invite and all account rows are
/// consumed in one D1 batch.
pub async fn register(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    if let Some(response) = anonymous_mutation_problem(&request, &context.env, &correlation)? {
        return Ok(response);
    }
    let input: PasswordRegistrationRequest = match request.json().await {
        Ok(input) => input,
        Err(_) => return invalid_request("Invalid JSON request", &correlation),
    };
    let username = match normalize_username(&input.username) {
        Ok(value) => value,
        Err(_) => return invalid_request("Invalid registration fields", &correlation),
    };
    if validate_password(&input.password).is_err() {
        return invalid_request("Password must contain 15 to 128 characters", &correlation);
    }
    let email = match normalize_email(&input.email) {
        Ok(value) => value,
        Err(_) => return invalid_request("Invalid email address", &correlation),
    };
    let mobile = match input.mobile.as_ref() {
        Some(value) => {
            if !value.country_calling_code.starts_with('+')
                || !value.national_number.bytes().all(|b| b.is_ascii_digit())
            {
                return invalid_request("Invalid mobile number", &correlation);
            }
            match normalize_mobile(&value.country_calling_code, &value.national_number) {
                Ok(normalized) => Some((value, normalized)),
                Err(_) => return invalid_request("Invalid mobile number", &correlation),
            }
        }
        None => None,
    };
    let display_name = input.display_name.trim();
    if display_name.is_empty()
        || display_name.chars().count() > 80
        || !(2..=35).contains(&input.locale.len())
    {
        return invalid_request("Invalid registration fields", &correlation);
    }
    if !valid_optional_text(input.profile.status_message.as_deref(), 100)
        || !valid_optional_text(input.profile.favorite_character.as_deref(), 100)
        || input.profile.interests.len() > 20
        || input
            .profile
            .interests
            .iter()
            .any(|item| item.is_empty() || item.chars().count() > 40)
    {
        return invalid_request("Invalid profile fields", &correlation);
    }
    let mut interests = input.profile.interests.clone();
    interests.sort();
    interests.dedup();
    if interests.len() != input.profile.interests.len() {
        return invalid_request("Profile interests must be unique", &correlation);
    }
    let interests_json = serde_json::to_string(&interests)?;

    let registration_pepper = secret(&context.env, "REGISTRATION_PEPPER")?;
    let (invite_public, invite_digest) = input
        .registration_capability
        .as_deref()
        .and_then(|value| value.split_once('.'))
        .map(|(public, value)| {
            (
                public,
                SecretDigest::hmac(registration_pepper.as_bytes(), value.as_bytes()),
            )
        })
        .map_or((None, None), |(public, digest)| {
            (Some(public), Some(digest))
        });
    let db = context.d1("DB")?;
    let now = now_seconds();
    if let Some(authorization_id) = input.authorization_transaction_id.as_deref()
        && !registration_authorization_pending(&db, authorization_id, now).await?
    {
        return invalid_request("Invalid authorization transaction", &correlation);
    }
    let Some(decision) = repository::registration_decision(
        &db,
        invite_public,
        invite_digest.as_ref().map(|digest| digest.0.as_slice()),
        now,
    )
    .await?
    else {
        return problem::response(
            "registration_disabled",
            "Registration is not available",
            403,
            &correlation,
        );
    };

    let Some(email_proof) = crate::registration_email::authorize(
        &request,
        &context.env,
        &email,
        input.email_verification_token.as_deref(),
    )
    .await?
    else {
        return problem::response(
            "email_verification_required",
            "Verify your email before creating an account",
            403,
            &correlation,
        );
    };
    if !email_proof.allows_authorization(input.authorization_transaction_id.as_deref()) {
        return invalid_request("Invalid authorization transaction", &correlation);
    }
    let password_hash = hash_password(&input.password)?;
    let principal_id = PrincipalId::new_v4().to_string();
    let username_id = IdentifierId::new_v7(worker::Date::now().as_millis()).to_string();
    let email_id = IdentifierId::new_v7(worker::Date::now().as_millis()).to_string();
    let mobile_id = mobile
        .as_ref()
        .map(|_| IdentifierId::new_v7(worker::Date::now().as_millis()).to_string());
    let transaction_id = TransactionId::new_v7(worker::Date::now().as_millis()).to_string();
    let session_id = SessionId::new_v7(worker::Date::now().as_millis()).to_string();
    let session_wire = random_secret_wire()?;
    let session_digest = SecretDigest::hmac(
        secret(&context.env, "SESSION_PEPPER")?.as_bytes(),
        session_wire.as_bytes(),
    );
    let audit_id = AuditEventId::new_v7(worker::Date::now().as_millis()).to_string();
    let user_handle = random_bytes()?;
    let transaction_digest = Sha256::digest(random_bytes()?);
    let mut statements = vec![
        db.prepare("INSERT INTO principals(principal_id,kind,lifecycle_state,webauthn_user_handle,created_at,updated_at,state_changed_at) VALUES(?1,'human','active',?2,?3,?3,?3)")
            .bind(&[text(&principal_id), blob(&user_handle), integer(now)])?,
        db.prepare("INSERT INTO password_registration_transactions(transaction_id,registration_capability_id,request_digest,state,created_at,expires_at,consumed_at,result_principal_id) VALUES(?1,?2,?3,'consumed_success',?4,?5,?4,?6)")
            .bind(&[text(&transaction_id), optional_text(decision.capability_id.as_deref()), blob(&transaction_digest), integer(now), integer(now + 300), text(&principal_id)])?,
        db.prepare("INSERT INTO human_profiles(principal_id,display_name,locale,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)")
            .bind(&[text(&principal_id), text(display_name), text(&input.locale), integer(now)])?,
        db.prepare("INSERT INTO account_profile_details(principal_id,status_message,favorite_character,interests_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)")
            .bind(&[text(&principal_id), optional_text(input.profile.status_message.as_deref()), optional_text(input.profile.favorite_character.as_deref()), text(&interests_json), integer(now)])?,
        db.prepare("INSERT INTO account_preferences(principal_id,locale,created_at,updated_at) VALUES(?1,?2,?3,?3)")
            .bind(&[text(&principal_id), text(&input.locale), integer(now)])?,
        identifier_statement(&db, &username_id, &principal_id, "username", &username, &username, None, None, true, "verified", Some(now), now)?,
        identifier_statement(&db, &email_id, &principal_id, "email", input.email.trim(), &email, None, None, true, "verified", Some(now), now)?,
        db.prepare("INSERT INTO password_credentials(principal_id,password_hash,hash_algorithm,hash_parameters_json,password_version,created_at,updated_at) VALUES(?1,?2,'argon2id',?3,1,?4,?4)")
            .bind(&[text(&principal_id), text(&password_hash), text(PASSWORD_PARAMETERS), integer(now)])?,
        db.prepare("INSERT INTO identity_sessions(session_id,session_digest,principal_id,auth_method,amr_json,acr,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?1,?2,?3,'password','[\"password\"]','urn:moesegfault:acr:password',?4,?4,?5,?6)")
            .bind(&[text(&session_id), blob(&session_digest.0), text(&principal_id), integer(now), integer(now + 43_200), integer(now + 2_592_000)])?,
        db.prepare("INSERT INTO session_authentication_methods(session_id,sequence,method,authenticated_at) VALUES(?1,1,'password',?2)")
            .bind(&[text(&session_id), integer(now)])?,
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision,context_json) VALUES(?1,'identity.registration.completed',?2,?2,?3,?3,'success',?4,?5,'{\"method\":\"password\"}')")
            .bind(&[text(&audit_id), integer(now), text(&principal_id), text(&correlation), integer(decision.policy_revision)])?,
        db.prepare("INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) VALUES(?1,?2,?3)")
            .bind(&[text(&audit_id), text(&format!("security-audit/{}/{audit_id}.json", day_bucket(now))), integer(now)])?,
    ];
    if let (Some(value), Some(identifier_id)) = (mobile.as_ref(), mobile_id.as_ref()) {
        statements.insert(
            7,
            identifier_statement(
                &db,
                identifier_id,
                &principal_id,
                "mobile",
                &value.1,
                &value.1,
                Some(value.0.country_calling_code.trim()),
                Some(value.0.national_number.trim()),
                true,
                "unverified",
                None,
                now,
            )?,
        );
    }
    if let Some(capability_id) = decision.capability_id.as_deref() {
        statements.push(
            db.prepare("INSERT INTO registration_capability_uses(capability_id,password_registration_id,consumed_by_principal_id,request_digest,used_at) VALUES(?1,?2,?3,?4,?5)")
                .bind(&[text(capability_id), text(&transaction_id), text(&principal_id), blob(&transaction_digest), integer(now)])?,
        );
    }
    statements.push(email_proof.consume(&db, &principal_id, now)?);
    if let Some(authorization_id) = input.authorization_transaction_id.as_deref() {
        statements.push(db.prepare("UPDATE oauth_authorization_transactions SET principal_id=?2,identity_session_id=?3,state='authenticated' WHERE authorization_transaction_id=?1 AND state='awaiting_authentication' AND expires_at>unixepoch()")
            .bind(&[text(authorization_id), text(&principal_id), text(&session_id)])?);
        // The existing sequence-1 row is an atomic assertion: a failed OAuth bind
        // deliberately collides with it and rolls back the entire account batch.
        // This covers expiry and competing authentication after the preflight read.
        statements.push(db.prepare("INSERT INTO session_authentication_methods(session_id,sequence,method,authenticated_at) SELECT ?3,1,'password',?4 WHERE NOT EXISTS(SELECT 1 FROM oauth_authorization_transactions WHERE authorization_transaction_id=?1 AND state='authenticated' AND principal_id=?2 AND identity_session_id=?3 AND expires_at>unixepoch())")
            .bind(&[text(authorization_id), text(&principal_id), text(&session_id), integer(now)])?);
    }
    if let Err(error) = db.batch(statements).await {
        if is_constraint_error(&error) {
            if let Some(authorization_id) = input.authorization_transaction_id.as_deref()
                && !registration_authorization_pending(&db, authorization_id, now_seconds()).await?
            {
                return invalid_request("Invalid authorization transaction", &correlation);
            }
            return problem::response(
                "identifier_conflict",
                "An account identifier is already in use",
                409,
                &correlation,
            );
        }
        return Err(error);
    }
    let account = account_json(
        &principal_id,
        display_name,
        &input.locale,
        &username_id,
        &username,
        &email_id,
        input.email.trim(),
        mobile_id
            .as_deref()
            .zip(mobile.as_ref().map(|value| value.1.as_str())),
        now,
    );
    authentication_response(
        account,
        &session_id,
        &session_wire,
        AuthenticationResponseContext {
            now,
            status: 201,
            correlation: &correlation,
            env: &context.env,
            authorization_transaction_id: input.authorization_transaction_id.as_deref(),
        },
    )
}

/// Reject expired or already-bound transactions before hashing; batch SQL rechecks authority.
async fn registration_authorization_pending(
    db: &worker::D1Database,
    authorization_id: &str,
    now: i64,
) -> Result<bool> {
    Ok(db.prepare("SELECT authorization_transaction_id FROM oauth_authorization_transactions WHERE authorization_transaction_id=?1 AND state='awaiting_authentication' AND expires_at>?2")
        .bind(&[text(authorization_id), integer(now)])?
        .first::<AuthorizationRow>(None).await?.is_some())
}

/// 使用 username 或已验证的 email/mobile 进行密码认证。
/// Authenticates a password using a username or a verified email/mobile.
pub async fn authenticate(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    if let Some(response) = anonymous_mutation_problem(&request, &context.env, &correlation)? {
        return Ok(response);
    }
    let input: PasswordAuthenticationRequest = match request.json().await {
        Ok(input) => input,
        Err(_) => return invalid_request("Invalid JSON request", &correlation),
    };
    if input.password.chars().count() > 128 {
        return authentication_failed(&correlation);
    }
    let db = context.d1("DB")?;
    let normalized = LoginIdentifier::parse(&input.login);
    let identity = match normalized {
        Some(ref login) => db
            .prepare("SELECT p.principal_id,p.lifecycle_state,c.password_hash,c.password_version FROM identifiers i JOIN principals p ON p.principal_id=i.principal_id JOIN password_credentials c ON c.principal_id=p.principal_id WHERE i.kind=?1 AND i.normalized_value=?2 AND (i.kind='username' OR i.verification_state='verified') LIMIT 1")
            .bind(&[text(login.kind()), text(login.value())])?
            .first::<PasswordIdentity>(None)
            .await?,
        None => None,
    };
    // Reserve a slot with one primary D1 write before running Argon2. All verified
    // aliases of a principal share a bucket; unknown/unverified values use a
    // keyed, non-reversible identifier bucket to avoid storing contact PII.
    // 在运行 Argon2 前通过一次 D1 主库写入预占次数。已验证别名共用主体桶；
    // 未知或未验证值使用带密钥的不可逆标识符桶，避免保存联系方式个人信息。
    let now = now_seconds();
    let bucket = password_attempt_bucket(
        &context.env,
        identity.as_ref(),
        normalized.as_ref(),
        &input.login,
    )?;
    if let Some(retry_after) = reserve_password_attempt(&db, &bucket, now).await? {
        return password_rate_limited(&correlation, retry_after);
    }
    let candidate_hash = identity
        .as_ref()
        .map_or(DUMMY_PASSWORD_HASH, |row| row.password_hash.as_str());
    let password_matches = verify_password(&input.password, candidate_hash);
    let verified = identity
        .as_ref()
        .is_some_and(|row| row.lifecycle_state == "active" && password_matches);
    if !verified {
        return authentication_failed(&correlation);
    }
    let identity = identity.expect("verified identity exists");
    if let Some(authorization_id) = input.authorization_transaction_id.as_deref() {
        let valid = db
            .prepare("SELECT authorization_transaction_id FROM oauth_authorization_transactions WHERE authorization_transaction_id=?1 AND state='awaiting_authentication' AND expires_at>?2")
            .bind(&[text(authorization_id), integer(now)])?
            .first::<AuthorizationRow>(None)
            .await?
            .is_some();
        if !valid {
            return problem::response(
                "invalid_request",
                "Invalid authorization transaction",
                400,
                &correlation,
            );
        }
    }
    let session_id = SessionId::new_v7(worker::Date::now().as_millis()).to_string();
    let session_wire = random_secret_wire()?;
    let session_digest = SecretDigest::hmac(
        secret(&context.env, "SESSION_PEPPER")?.as_bytes(),
        session_wire.as_bytes(),
    );
    let audit_id = AuditEventId::new_v7(worker::Date::now().as_millis()).to_string();
    let mut statements = vec![
        db.prepare("DELETE FROM password_auth_attempts WHERE bucket_digest=?1")
            .bind(&[blob(&bucket)])?,
        // A recovery/password rotation may have won after the pre-hash read.
        // The session insert must prove the exact credential is still current
        // inside this atomic batch; the following FK write rolls it all back
        // if no row was inserted.
        // 恢复或密码轮换可能在哈希前读取之后已完成；会话插入必须在原子 batch 内
        // 证明所验证的凭据仍然有效。若未插入，后续外键写入会回滚整个 batch。
        db.prepare("INSERT INTO identity_sessions(session_id,session_digest,principal_id,auth_method,amr_json,acr,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) SELECT ?1,?2,p.principal_id,'password','[\"password\"]','urn:moesegfault:acr:password',?5,?5,?6,?7 FROM principals p JOIN password_credentials c ON c.principal_id=p.principal_id WHERE p.principal_id=?3 AND p.lifecycle_state='active' AND c.password_hash=?4 AND c.password_version=?8")
            .bind(&[text(&session_id), blob(&session_digest.0), text(&identity.principal_id), text(&identity.password_hash), integer(now), integer(now + 43_200), integer(now + 2_592_000), integer(identity.password_version)])?,
        db.prepare("INSERT INTO session_authentication_methods(session_id,sequence,method,authenticated_at) VALUES(?1,1,'password',?2)").bind(&[text(&session_id), integer(now)])?,
        db.prepare("UPDATE password_credentials SET last_used_at=?2 WHERE principal_id=?1").bind(&[text(&identity.principal_id), integer(now)])?,
        db.prepare("INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,actor_principal_id,subject_principal_id,outcome,correlation_id,policy_revision,context_json) VALUES(?1,'identity.authentication.succeeded',?2,?2,?3,?3,'success',?4,1,'{\"method\":\"password\"}')")
            .bind(&[text(&audit_id), integer(now), text(&identity.principal_id), text(&correlation)])?,
        db.prepare("INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) VALUES(?1,?2,?3)").bind(&[text(&audit_id), text(&format!("security-audit/{}/{audit_id}.json", day_bucket(now))), integer(now)])?,
    ];
    if let Some(authorization_id) = input.authorization_transaction_id.as_deref() {
        statements.push(db.prepare("UPDATE oauth_authorization_transactions SET principal_id=?2,identity_session_id=?3,state='authenticated' WHERE authorization_transaction_id=?1 AND state='awaiting_authentication' AND expires_at>?4")
            .bind(&[text(authorization_id), text(&identity.principal_id), text(&session_id), integer(now)])?);
    }
    if let Err(error) = db.batch(statements).await {
        if error
            .to_string()
            .to_ascii_lowercase()
            .contains("foreign key constraint")
        {
            // Only the expected authority-loss FK is an authentication failure.
            // Surface unrelated integrity failures to the route's internal-error
            // logging rather than silently misclassifying them as bad passwords.
            // 仅将预期的权限丢失外键失败映射为认证失败；其他完整性错误交给路由错误日志。
            let still_current = db.prepare("SELECT 1 AS current FROM principals p JOIN password_credentials c ON c.principal_id=p.principal_id WHERE p.principal_id=?1 AND p.lifecycle_state='active' AND c.password_hash=?2 AND c.password_version=?3")
                .bind(&[text(&identity.principal_id), text(&identity.password_hash), integer(identity.password_version)])?
                .first::<i64>(Some("current")).await?.is_some();
            if !still_current {
                return authentication_failed(&correlation);
            }
        }
        return Err(error);
    }
    let account = repository::principal(&db, &identity.principal_id).await?;
    let account = account.map_or_else(
        || serde_json::json!({"principal_id": identity.principal_id}),
        |account| {
            serde_json::json!({
                "principal_id": account.principal_id,
                "lifecycle_state": account.lifecycle_state,
                "profile": {"display_name": account.display_name, "locale": account.locale},
            })
        },
    );
    authentication_response(
        account,
        &session_id,
        &session_wire,
        AuthenticationResponseContext {
            now,
            status: 200,
            correlation: &correlation,
            env: &context.env,
            authorization_transaction_id: input.authorization_transaction_id.as_deref(),
        },
    )
}

#[derive(Debug, Deserialize)]
struct AuthorizationRow {
    #[allow(dead_code)]
    authorization_transaction_id: String,
}

/// Derive one opaque bucket for the principal, or for an unknown identifier.
/// 为主体（或未知标识符）派生一个不透明限速桶。
fn password_attempt_bucket(
    env: &Env,
    identity: Option<&PasswordIdentity>,
    normalized: Option<&LoginIdentifier>,
    raw_login: &str,
) -> Result<[u8; 32]> {
    let material = password_attempt_scope(identity, normalized, raw_login);
    Ok(SecretDigest::hmac(
        secret(env, "SESSION_PEPPER")?.as_bytes(),
        material.as_bytes(),
    )
    .0)
}

/// Resolve every known verified alias to its principal-wide throttle scope.
/// 将已知且已验证的每个别名归入同一主体限速范围。
fn password_attempt_scope(
    identity: Option<&PasswordIdentity>,
    normalized: Option<&LoginIdentifier>,
    raw_login: &str,
) -> String {
    if let Some(identity) = identity {
        format!("password-auth:principal:{}", identity.principal_id)
    } else if let Some(login) = normalized {
        format!("password-auth:unknown:{}:{}", login.kind(), login.value())
    } else {
        format!("password-auth:invalid:{raw_login}")
    }
}

/// Atomically reserve an Argon2 attempt; denied requests never run a hash.
/// 原子预占一次 Argon2 尝试；拒绝的请求绝不运行哈希。
///
/// The conditional UPSERT is the concurrency boundary. A read-then-write
/// counter would allow simultaneous guesses to bypass the cap. The 24-hour
/// inactivity expiry avoids a permanent denial of password login, while
/// exponential backoff starts after four attempts and tops out at one hour.
/// 条件 UPSERT 是并发边界。先读后写计数会让并发猜测绕过上限。
/// 24 小时无尝试即过期，避免永久拒绝密码登录；四次后开始指数退避，最长一小时。
async fn reserve_password_attempt(
    db: &worker::D1Database,
    bucket: &[u8; 32],
    now: i64,
) -> Result<Option<i64>> {
    let reserved = db.prepare(
        "INSERT INTO password_auth_attempts(bucket_digest,attempt_count,last_attempt_at,next_allowed_at,expires_at) \
         VALUES(?1,1,?2,?2,?3) \
         ON CONFLICT(bucket_digest) DO UPDATE SET \
         attempt_count=CASE WHEN password_auth_attempts.expires_at<=excluded.last_attempt_at \
             THEN 1 ELSE password_auth_attempts.attempt_count+1 END, \
         last_attempt_at=excluded.last_attempt_at, \
         next_allowed_at=CASE WHEN password_auth_attempts.expires_at<=excluded.last_attempt_at \
             OR password_auth_attempts.attempt_count<4 THEN excluded.last_attempt_at \
             ELSE excluded.last_attempt_at + min(3600, 1 << min(12, password_auth_attempts.attempt_count-4)) END, \
         expires_at=excluded.expires_at \
         WHERE password_auth_attempts.expires_at<=excluded.last_attempt_at \
             OR (password_auth_attempts.attempt_count<100 AND password_auth_attempts.next_allowed_at<=excluded.last_attempt_at) \
         RETURNING attempt_count"
    ).bind(&[blob(bucket), integer(now), integer(now + PASSWORD_ATTEMPT_TTL_SECONDS)])?
        .first::<i64>(Some("attempt_count")).await?;
    if reserved.is_some() {
        return Ok(None);
    }
    // This read is diagnostic only. The preceding write remains authoritative.
    // 此读取仅用于给出等待时间；前面的写入仍是权威判定。
    let row = db
        .prepare(
            "SELECT attempt_count,next_allowed_at,expires_at FROM password_auth_attempts WHERE bucket_digest=?1",
        )
        .bind(&[blob(bucket)])?
        .first::<PasswordAttemptWait>(None)
        .await?;
    let retry_after = row.map_or(1, |row| row.retry_after(now));
    Ok(Some(retry_after.max(1)))
}

#[derive(Debug, Deserialize)]
struct PasswordAttemptWait {
    attempt_count: i64,
    next_allowed_at: i64,
    expires_at: i64,
}

impl PasswordAttemptWait {
    /// Report the actual next admission time, including the terminal cap.
    /// 报告真实的下次可尝试时间，包括次数耗尽后的最终限制。
    fn retry_after(&self, now: i64) -> i64 {
        if self.attempt_count >= 100 {
            self.expires_at.saturating_sub(now)
        } else {
            self.next_allowed_at.saturating_sub(now)
        }
    }
}

/// Delete expired anonymous and principal buckets in a bounded cron batch.
/// 在定时任务中有界地清理过期的匿名及主体桶。
pub(crate) async fn purge_expired_attempts(
    db: &worker::D1Database,
    now: i64,
    limit: u32,
) -> Result<()> {
    db.prepare("DELETE FROM password_auth_attempts WHERE bucket_digest IN (SELECT bucket_digest FROM password_auth_attempts WHERE expires_at<=?1 ORDER BY expires_at LIMIT ?2)")
        .bind(&[integer(now), integer(i64::from(limit.min(500)))])?
        .run().await?;
    Ok(())
}

const DUMMY_PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$c29tZS1maXhlZC1zYWx0$MeZ7LaoKcHj8oWkYckLpDrLFIW8VOfUCFSSqu2V9fcI";

pub(crate) fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::encode_b64(&random_bytes()?)
        .map_err(|error| Error::RustError(format!("password salt encoding failed: {error}")))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| Error::RustError(format!("password hashing failed: {error}")))
}

pub(crate) fn verify_password(password: &str, encoded: &str) -> bool {
    PasswordHash::new(encoded).ok().is_some_and(|hash| {
        Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok()
    })
}

#[allow(clippy::too_many_arguments)]
fn identifier_statement(
    db: &worker::D1Database,
    identifier_id: &str,
    principal_id: &str,
    kind: &str,
    value: &str,
    normalized: &str,
    calling_code: Option<&str>,
    national_number: Option<&str>,
    primary: bool,
    verification_state: &str,
    verified_at: Option<i64>,
    now: i64,
) -> Result<worker::D1PreparedStatement> {
    db.prepare("INSERT INTO identifiers(identifier_id,principal_id,kind,value,normalized_value,country_calling_code,national_number,is_primary,verification_state,verified_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)")
        .bind(&[text(identifier_id), text(principal_id), text(kind), text(value), text(normalized), optional_text(calling_code), optional_text(national_number), integer(i64::from(primary)), text(verification_state), optional_integer(verified_at), integer(now)])
}

#[allow(clippy::too_many_arguments)]
fn account_json(
    principal_id: &str,
    display_name: &str,
    locale: &str,
    username_id: &str,
    username: &str,
    email_id: &str,
    email: &str,
    mobile: Option<(&str, &str)>,
    now: i64,
) -> serde_json::Value {
    let created_at = date_time(now);
    let mut identifiers = vec![
        serde_json::json!({"identifier_id":username_id,"kind":"username","value":username,"is_primary":true,"verification_state":"verified","verified_at":created_at,"created_at":created_at,"updated_at":created_at}),
        serde_json::json!({"identifier_id":email_id,"kind":"email","value":email,"is_primary":true,"verification_state":"verified","verified_at":created_at,"created_at":created_at,"updated_at":created_at}),
    ];
    if let Some((identifier_id, value)) = mobile {
        identifiers.push(serde_json::json!({"identifier_id":identifier_id,"kind":"mobile","value":value,"is_primary":true,"verification_state":"unverified","verified_at":null,"created_at":created_at,"updated_at":created_at}));
    }
    serde_json::json!({
        "principal_id": principal_id,
        "lifecycle_state":"active",
        "profile":{"display_name":display_name,"avatar_url":null,"locale":locale},
        "identifiers":identifiers,
        "created_at":created_at,
        "updated_at":created_at
    })
}

struct AuthenticationResponseContext<'a> {
    now: i64,
    status: u16,
    correlation: &'a str,
    env: &'a Env,
    authorization_transaction_id: Option<&'a str>,
}

fn authentication_response(
    account: serde_json::Value,
    session_id: &str,
    session_wire: &str,
    context: AuthenticationResponseContext<'_>,
) -> Result<Response> {
    let csrf =
        guard::session_csrf_token(session_wire, secret(context.env, "CSRF_PEPPER")?.as_bytes());
    let session = SessionWire {
        session_id,
        authentication_method: "password",
        authenticator_id: None,
        binding_id: None,
        amr: ["password"],
        acr: "urn:moesegfault:acr:password",
        is_current: true,
        authenticated_at: date_time(context.now),
        last_seen_at: date_time(context.now),
        expires_at: date_time(context.now + 2_592_000),
        revoked_at: None,
    };
    let mut body = serde_json::json!({"account":account,"session":session,"csrf_token":csrf,"csrf_expires_at":date_time(context.now+43_200)});
    if let Some(id) = context.authorization_transaction_id {
        body["authorization_resume_uri"] = serde_json::json!(oauth::authorization_resume_uri(
            &oauth::issuer(context.env),
            id
        ));
    }
    json(
        &body,
        context.status,
        context.correlation,
        Some(&guard::session_cookie(session_wire)),
    )
}

fn anonymous_mutation_problem(
    request: &Request,
    env: &Env,
    correlation: &str,
) -> Result<Option<Response>> {
    if guard::header(request.headers(), "content-length")
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|v| v > MAX_BODY_BYTES)
    {
        return problem::response(
            "invalid_request",
            "Request body is too large",
            413,
            correlation,
        )
        .map(Some);
    }
    if guard::validate_browser_mutation(request, env).is_err()
        || !guard::validate_browser_csrf(request, secret(env, "CSRF_PEPPER")?.as_bytes())
    {
        return problem::response(
            "invalid_request",
            "Invalid browser request context",
            403,
            correlation,
        )
        .map(Some);
    }
    Ok(None)
}

fn authentication_failed(correlation: &str) -> Result<Response> {
    problem::response(
        "authentication_failed",
        "Authentication failed",
        401,
        correlation,
    )
}

/// Return one generic 429 for known and unknown identifiers alike.
/// 对已知和未知标识符统一返回通用 429。
fn password_rate_limited(correlation: &str, retry_after: i64) -> Result<Response> {
    let response = problem::response(
        "rate_limited",
        "Too many authentication attempts",
        429,
        correlation,
    )?;
    response
        .headers()
        .set("retry-after", &retry_after.to_string())?;
    Ok(response)
}

fn invalid_request(title: &'static str, correlation: &str) -> Result<Response> {
    problem::response("invalid_request", title, 400, correlation)
}

fn secret(env: &Env, name: &str) -> Result<String> {
    env.secret(name)
        .map(|value| value.to_string())
        .map_err(|_| Error::RustError(format!("missing required secret binding: {name}")))
}

fn random_bytes() -> Result<[u8; 32]> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| Error::RustError(format!("secure random generation failed: {error}")))?;
    Ok(bytes)
}

fn random_secret_wire() -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes()?))
}

fn correlation_id() -> String {
    uuid::Uuid::now_v7().simple().to_string()
}

fn now_seconds() -> i64 {
    (worker::Date::now().as_millis() / 1_000) as i64
}

fn date_time(seconds: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .expect("Workers clock is in the RFC 3339 range")
        .format(&time::format_description::well_known::Rfc3339)
        .expect("RFC 3339 formatting is infallible")
}

fn day_bucket(seconds: i64) -> String {
    date_time(seconds)
        .get(..10)
        .unwrap_or("unknown-day")
        .to_owned()
}

fn json<T: Serialize>(
    value: &T,
    status: u16,
    correlation: &str,
    cookie: Option<&str>,
) -> Result<Response> {
    let headers = Headers::new();
    headers.set("content-type", "application/json; charset=utf-8")?;
    headers.set("cache-control", "no-store")?;
    headers.set("x-content-type-options", "nosniff")?;
    headers.set("x-moesegfault-correlation-id", correlation)?;
    if let Some(cookie) = cookie {
        headers.append("set-cookie", cookie)?;
    }
    Ok(Response::from_json(value)?
        .with_status(status)
        .with_headers(headers))
}

fn is_constraint_error(error: &Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("constraint") || message.contains("unique")
}

fn valid_optional_text(value: Option<&str>, maximum: usize) -> bool {
    value.is_none_or(|text| !text.chars().any(char::is_control) && text.chars().count() <= maximum)
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
fn optional_integer(value: Option<i64>) -> JsValue {
    value.map_or(JsValue::NULL, integer)
}
fn blob(value: &[u8]) -> JsValue {
    worker::js_sys::Uint8Array::from(value).into()
}

fn default_locale() -> String {
    "zh-CN".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_round_trips_and_rejects_another_password() {
        let encoded = hash_password("correct horse battery staple").unwrap();
        assert!(encoded.starts_with("$argon2id$"));
        assert!(verify_password("correct horse battery staple", &encoded));
        assert!(!verify_password("another long wrong password", &encoded));
    }

    #[test]
    fn verified_aliases_share_one_principal_attempt_scope() {
        let identity = PasswordIdentity {
            principal_id: "principal-1".into(),
            password_hash: DUMMY_PASSWORD_HASH.into(),
            password_version: 1,
            lifecycle_state: "active".into(),
        };
        let username = LoginIdentifier::parse("Klee").unwrap();
        let email = LoginIdentifier::parse("Klee@example.com").unwrap();
        assert_eq!(
            password_attempt_scope(Some(&identity), Some(&username), "Klee"),
            password_attempt_scope(Some(&identity), Some(&email), "Klee@example.com")
        );
        assert_ne!(
            password_attempt_scope(None, Some(&email), "Klee@example.com"),
            password_attempt_scope(Some(&identity), Some(&email), "Klee@example.com")
        );
    }

    #[test]
    fn retry_after_reports_expiry_after_terminal_cap() {
        let row = PasswordAttemptWait {
            attempt_count: 100,
            next_allowed_at: 4_600,
            expires_at: 87_400,
        };
        assert_eq!(row.retry_after(1_000), 86_400);
        let row = PasswordAttemptWait {
            attempt_count: 5,
            next_allowed_at: 1_010,
            expires_at: 87_400,
        };
        assert_eq!(row.retry_after(1_000), 10);
    }
}
