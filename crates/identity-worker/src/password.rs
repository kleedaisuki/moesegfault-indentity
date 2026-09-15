//! 可选密码认证适配器。/ Optional password-authentication adapter.
//!
//! 密码与 Passkey 是并列方法：注册密码不会隐式创建 Passkey，之后可在账户站添加。
//! Password and passkeys are peer methods: password registration does not
//! implicitly create a passkey, which can be added later from the account app.

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use identity_domain::{
    AuditEventId, IdentifierId, PrincipalId, SecretDigest, SessionId, TransactionId,
    normalize_email, normalize_mobile, normalize_username, validate_password,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use worker::{Env, Error, Headers, Request, Response, Result, RouteContext, wasm_bindgen::JsValue};

use crate::{guard, problem, repository};

const MAX_BODY_BYTES: u64 = 65_536;
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
        return invalid_request("Password must contain 12 to 128 characters", &correlation);
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
        db.prepare("INSERT INTO password_registration_transactions(transaction_id,registration_capability_id,request_digest,state,created_at,expires_at,consumed_at,result_principal_id) VALUES(?1,?2,?3,'consumed_success',?4,?5,?4,?6)")
            .bind(&[text(&transaction_id), optional_text(decision.capability_id.as_deref()), blob(&transaction_digest), integer(now), integer(now + 300), text(&principal_id)])?,
        db.prepare("INSERT INTO principals(principal_id,kind,lifecycle_state,webauthn_user_handle,created_at,updated_at,state_changed_at) VALUES(?1,'human','active',?2,?3,?3,?3)")
            .bind(&[text(&principal_id), blob(&user_handle), integer(now)])?,
        db.prepare("INSERT INTO human_profiles(principal_id,display_name,locale,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)")
            .bind(&[text(&principal_id), text(display_name), text(&input.locale), integer(now)])?,
        db.prepare("INSERT INTO account_profile_details(principal_id,status_message,favorite_character,interests_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)")
            .bind(&[text(&principal_id), optional_text(input.profile.status_message.as_deref()), optional_text(input.profile.favorite_character.as_deref()), text(&interests_json), integer(now)])?,
        db.prepare("INSERT INTO account_preferences(principal_id,locale,created_at,updated_at) VALUES(?1,?2,?3,?3)")
            .bind(&[text(&principal_id), text(&input.locale), integer(now)])?,
        identifier_statement(&db, &username_id, &principal_id, "username", &username, &username, None, None, true, "verified", Some(now), now)?,
        identifier_statement(&db, &email_id, &principal_id, "email", input.email.trim(), &email, None, None, true, "unverified", None, now)?,
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
    if let Err(error) = db.batch(statements).await {
        if is_constraint_error(&error) {
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
        now,
        201,
        &correlation,
        &context.env,
    )
}

/// 使用 username、email 或 mobile 进行密码认证。/ Authenticates a password using username, email, or mobile.
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
    let normalized = normalize_login(&input.login);
    let identity = match normalized {
        Some((kind, value)) => context
            .d1("DB")?
            .prepare("SELECT p.principal_id,p.lifecycle_state,c.password_hash FROM identifiers i JOIN principals p ON p.principal_id=i.principal_id JOIN password_credentials c ON c.principal_id=p.principal_id WHERE i.kind=?1 AND i.normalized_value=?2 LIMIT 1")
            .bind(&[text(kind), text(&value)])?
            .first::<PasswordIdentity>(None)
            .await?,
        None => None,
    };
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
    let db = context.d1("DB")?;
    let now = now_seconds();
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
        db.prepare("INSERT INTO identity_sessions(session_id,session_digest,principal_id,auth_method,amr_json,acr,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?1,?2,?3,'password','[\"password\"]','urn:moesegfault:acr:password',?4,?4,?5,?6)")
            .bind(&[text(&session_id), blob(&session_digest.0), text(&identity.principal_id), integer(now), integer(now + 43_200), integer(now + 2_592_000)])?,
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
    db.batch(statements).await?;
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
        now,
        200,
        &correlation,
        &context.env,
    )
}

#[derive(Debug, Deserialize)]
struct AuthorizationRow {
    #[allow(dead_code)]
    authorization_transaction_id: String,
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

fn normalize_login(input: &str) -> Option<(&'static str, String)> {
    if input.contains('@') {
        return normalize_email(input).ok().map(|value| ("email", value));
    }
    if input.trim().starts_with('+') {
        let value = input.trim().replace([' ', '-', '(', ')'], "");
        let digits = value.strip_prefix('+')?;
        if (5..=15).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit()) {
            return Some(("mobile", value));
        }
        return None;
    }
    normalize_username(input)
        .ok()
        .map(|value| ("username", value))
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
        serde_json::json!({"identifier_id":email_id,"kind":"email","value":email,"is_primary":true,"verification_state":"unverified","verified_at":null,"created_at":created_at,"updated_at":created_at}),
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

fn authentication_response(
    account: serde_json::Value,
    session_id: &str,
    session_wire: &str,
    now: i64,
    status: u16,
    correlation: &str,
    env: &Env,
) -> Result<Response> {
    let csrf = guard::session_csrf_token(session_wire, secret(env, "CSRF_PEPPER")?.as_bytes());
    let session = SessionWire {
        session_id,
        authentication_method: "password",
        authenticator_id: None,
        binding_id: None,
        amr: ["password"],
        acr: "urn:moesegfault:acr:password",
        is_current: true,
        authenticated_at: date_time(now),
        last_seen_at: date_time(now),
        expires_at: date_time(now + 2_592_000),
        revoked_at: None,
    };
    json(
        &serde_json::json!({"account":account,"session":session,"csrf_token":csrf,"csrf_expires_at":date_time(now+43_200)}),
        status,
        correlation,
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
    fn login_discriminator_uses_canonical_identifier_kind() {
        assert_eq!(
            normalize_login(" Klee "),
            Some(("username", "klee".to_owned()))
        );
        assert_eq!(
            normalize_login("Klee@EXAMPLE.COM"),
            Some(("email", "Klee@example.com".to_owned()))
        );
        assert_eq!(
            normalize_login("+86 138-0013-8000"),
            Some(("mobile", "+8613800138000".to_owned()))
        );
    }
}
