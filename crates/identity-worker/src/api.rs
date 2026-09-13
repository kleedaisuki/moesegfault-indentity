//! HTTP 资源处理器。/ HTTP resource handlers.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use identity_domain::{
    AuditEventId, AuthenticatorId, IdentifierId, PrincipalId, SecretDigest, SessionId,
    TransactionId, normalize_username,
};
use passkey_auth::{
    Attachment, AuthenticationResponse, AuthenticationState, CosePublicKey, CredentialId,
    PasskeyCredential, RegistrationResponse, RegistrationState, Webauthn,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use worker::*;

use crate::{guard, problem, repository};

const RP_NAME: &str = "moeSegFault";
const MAX_JSON_BYTES: u64 = 64 * 1024;

#[derive(Serialize)]
struct Health<'a> {
    status: &'a str,
    version: &'a str,
    checks: HealthChecks<'a>,
}

#[derive(Serialize)]
struct HealthChecks<'a> {
    d1: &'a str,
}

/// 稳定的进程级健康检查，不把 D1/R2 短暂故障变成流量切断。
/// Stable process-level health check; transient D1/R2 failures do not cut traffic.
pub async fn health(_request: Request, context: RouteContext<()>) -> Result<Response> {
    let d1 = match context
        .d1("DB")?
        .prepare("SELECT 1 AS healthy")
        .first::<i64>(Some("healthy"))
        .await
    {
        Ok(Some(1)) => "ok",
        _ => "unavailable",
    };
    public_json(
        &Health {
            status: if d1 == "ok" { "ok" } else { "degraded" },
            version: env!("CARGO_PKG_VERSION"),
            checks: HealthChecks { d1 },
        },
        &correlation_id(),
    )
}

pub async fn discovery(_request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    if !context
        .env
        .var("OAUTH_ENABLED")
        .is_ok_and(|v| v.to_string() == "true")
    {
        return problem::response(
            "service_unavailable",
            "OIDC issuance is not enabled in this release",
            503,
            &correlation,
        );
    }
    let issuer = issuer(&context.env);
    public_json(
        &serde_json::json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{issuer}/v1/oauth/authorizations"),
            "token_endpoint": format!("{issuer}/v1/oauth/tokens"),
            "revocation_endpoint": format!("{issuer}/v1/oauth/revocations"),
            "userinfo_endpoint": format!("{issuer}/v1/oidc/user-claims"),
            "end_session_endpoint": format!("{issuer}/v1/oidc/logout-requests"),
            "jwks_uri": format!("{issuer}/.well-known/jwks.json"),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "subject_types_supported": ["pairwise"],
            "id_token_signing_alg_values_supported": ["RS256"],
            "scopes_supported": ["openid", "profile", "offline_access"],
        }),
        &correlation,
    )
}

pub async fn jwks(_request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let value = context
        .env
        .var("PUBLIC_JWKS")
        .ok()
        .and_then(|v| serde_json::from_str::<serde_json::Value>(&v.to_string()).ok())
        .unwrap_or_else(|| serde_json::json!({ "keys": [] }));
    public_json(&value, &correlation)
}

pub async fn capabilities(_request: Request, context: RouteContext<()>) -> Result<Response> {
    json(
        &serde_json::json!({
            "passkeys": true,
            "registration": true,
            "authentication": true,
            "sessions": true,
            "account_read": true,
            "recovery": false,
            "bindings": false,
            "oauth_issuance": false,
            "audit_archive": true,
            "api_revision": 1,
        }),
        200,
        &correlation_id(),
        Some(&guard::login_origin(&context.env)),
        None,
    )
}

pub async fn browser_context(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let origin = guard::login_origin(&context.env);
    if guard::header(request.headers(), "origin").as_deref() != Some(origin.as_str()) {
        return problem::response(
            "invalid_request",
            "Origin is not allowed",
            403,
            &correlation,
        );
    }
    let browser_wire =
        guard::cookie(&request, guard::BROWSER_COOKIE).unwrap_or_else(random_secret_wire);
    let csrf_token = guard::session_csrf_token(
        &browser_wire,
        secret(&context.env, "CSRF_PEPPER")?.as_bytes(),
    );
    let has_identity_session = authenticated_session(&request, &context.env)
        .await?
        .is_some();
    json(
        &serde_json::json!({
            "csrf_token": csrf_token,
            "csrf_expires_at": date_time(now_seconds() + 300),
            "has_identity_session": has_identity_session
        }),
        200,
        &correlation,
        Some(&origin),
        Some(&guard::browser_cookie(&browser_wire)),
    )
}

pub async fn preflight(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let origin = guard::header(request.headers(), "origin");
    let expected = guard::login_origin(&context.env);
    if origin.as_deref() != Some(expected.as_str()) {
        return problem::response(
            "invalid_request",
            "Origin is not allowed",
            403,
            &correlation,
        );
    }
    let headers = Headers::new();
    headers.set("access-control-allow-origin", &expected)?;
    headers.set("access-control-allow-credentials", "true")?;
    headers.set(
        "access-control-allow-methods",
        "GET, POST, PATCH, DELETE, OPTIONS",
    )?;
    headers.set(
        "access-control-allow-headers",
        "content-type, x-moesegfault-csrf, idempotency-key",
    )?;
    headers.set("access-control-max-age", "600")?;
    headers.set("vary", "Origin")?;
    headers.set("x-moesegfault-correlation-id", &correlation)?;
    Ok(Response::empty()?.with_status(204).with_headers(headers))
}

#[derive(Deserialize)]
struct StartRegistrationRequest {
    username: String,
    display_name: String,
    authenticator_label: String,
    #[serde(default = "default_locale")]
    locale: String,
    #[serde(default)]
    registration_capability: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StoredRegistration {
    username: String,
    display_name: String,
    user_handle: Vec<u8>,
    authenticator_label: String,
    locale: String,
    state: RegistrationState,
    policy_revision: i64,
}

#[derive(Serialize)]
struct TransactionResponse {
    transaction_id: String,
    csrf_token: String,
    public_key: serde_json::Value,
    expires_at: String,
}

pub async fn start_registration(
    mut request: Request,
    context: RouteContext<()>,
) -> Result<Response> {
    let correlation = correlation_id();
    if let Err(error) = mutation_guard(&request, &context.env) {
        return error_response(error, &correlation);
    }
    if !guard::validate_browser_csrf(&request, secret(&context.env, "CSRF_PEPPER")?.as_bytes()) {
        return problem::response(
            "invalid_request",
            "CSRF validation failed",
            403,
            &correlation,
        );
    }
    if body_too_large(&request) {
        return problem::response(
            "invalid_request",
            "Request body is too large",
            413,
            &correlation,
        );
    }
    let input: StartRegistrationRequest = match request.json().await {
        Ok(input) => input,
        Err(_) => {
            return problem::response("invalid_request", "Invalid JSON request", 400, &correlation);
        }
    };
    let username = match normalize_username(&input.username) {
        Ok(value) => value,
        Err(_) => {
            return problem::response(
                "invalid_request",
                "Invalid registration request",
                400,
                &correlation,
            );
        }
    };
    let display_name = input.display_name.trim();
    if display_name.is_empty() || display_name.chars().count() > 80 {
        return problem::response(
            "invalid_request",
            "Invalid registration request",
            400,
            &correlation,
        );
    }
    let authenticator_label = input.authenticator_label.trim();
    if authenticator_label.is_empty() || authenticator_label.chars().count() > 80 {
        return problem::response(
            "invalid_request",
            "Invalid authenticator label",
            400,
            &correlation,
        );
    }
    if !(2..=35).contains(&input.locale.len()) {
        return problem::response("invalid_request", "Invalid locale", 400, &correlation);
    }
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
        .map_or((None, None), |(p, d)| (Some(p), Some(d)));
    let db = context.d1("DB")?;
    let now = now_seconds();
    let decision = repository::registration_decision(
        &db,
        invite_public,
        invite_digest.as_ref().map(|d| d.0.as_slice()),
        now,
    )
    .await?;
    let Some(decision) = decision else {
        return problem::response(
            "registration_disabled",
            "Registration is not available",
            403,
            &correlation,
        );
    };

    let browser_wire = guard::cookie(&request, guard::BROWSER_COOKIE)
        .ok_or_else(|| Error::RustError("validated browser cookie disappeared".into()))?;
    let csrf_wire = random_secret_wire();
    let transaction_pepper = secret(&context.env, "TRANSACTION_PEPPER")?;
    let browser_digest = SecretDigest::hmac(transaction_pepper.as_bytes(), browser_wire.as_bytes());
    let csrf_digest = SecretDigest::hmac(transaction_pepper.as_bytes(), csrf_wire.as_bytes());
    let user_handle = random_bytes();
    let webauthn = webauthn(&context.env);
    let (challenge, state) =
        webauthn.start_registration(&user_handle, &username, display_name, &[]);
    let mut public_key = serde_json::to_value(challenge)?;
    // passkey-auth 0.1.3 exposes "preferred" only; the RP policy is stronger.
    public_key["authenticatorSelection"]["residentKey"] = serde_json::json!("required");
    public_key["authenticatorSelection"]["requireResidentKey"] = serde_json::json!(true);
    let public_key = registration_options_to_wire(public_key);
    let stored = StoredRegistration {
        username,
        display_name: display_name.to_owned(),
        user_handle,
        authenticator_label: authenticator_label.to_owned(),
        locale: input.locale,
        state,
        policy_revision: decision.policy_revision,
    };
    let tx_id = TransactionId::new_v7(worker::Date::now().as_millis()).to_string();
    let expires_at = now + 300;
    repository::insert_webauthn_transaction(
        &db,
        &tx_id,
        "account_registration",
        None,
        decision.capability_id.as_deref(),
        &Sha256::digest(stored.state.challenge.as_bytes()),
        &browser_digest.0,
        &csrf_digest.0,
        &rp_id(&context.env),
        &guard::login_origin(&context.env),
        &serde_json::to_string(&stored)?,
        decision.policy_revision,
        now,
        expires_at,
    )
    .await?;
    json(
        &TransactionResponse {
            transaction_id: tx_id,
            csrf_token: csrf_wire,
            public_key,
            expires_at: date_time(expires_at),
        },
        201,
        &correlation,
        Some(&guard::login_origin(&context.env)),
        None,
    )
}

#[derive(Deserialize)]
struct FinishRegistrationRequest {
    credential: RegistrationCredentialWire,
}

#[derive(Deserialize, Serialize)]
struct RegistrationCredentialWire {
    id: String,
    raw_id: String,
    #[serde(rename = "type")]
    kind: String,
    response: RegistrationCredentialResponseWire,
}

#[derive(Deserialize, Serialize)]
struct RegistrationCredentialResponseWire {
    client_data_json: String,
    attestation_object: String,
    #[serde(default)]
    transports: Vec<String>,
}

impl RegistrationCredentialWire {
    fn into_passkey(self) -> Option<RegistrationResponse> {
        (self.kind == "public-key" && self.id == self.raw_id).then_some(RegistrationResponse {
            id: self.id,
            transports: self.response.transports,
            attestation_object: self.response.attestation_object,
            client_data_json: self.response.client_data_json,
        })
    }
}

pub async fn finish_registration(
    mut request: Request,
    context: RouteContext<()>,
) -> Result<Response> {
    finish_registration_inner(&mut request, &context).await
}

async fn finish_registration_inner(
    request: &mut Request,
    context: &RouteContext<()>,
) -> Result<Response> {
    let correlation = correlation_id();
    if let Err(error) = mutation_guard(request, &context.env) {
        return error_response(error, &correlation);
    }
    let id = match context.param("id") {
        Some(value) => value,
        None => {
            return problem::response(
                "invalid_transaction",
                "Invalid transaction",
                404,
                &correlation,
            );
        }
    };
    let db = context.d1("DB")?;
    let Some(tx) = repository::webauthn_transaction(&db, id).await? else {
        return problem::response(
            "invalid_transaction",
            "Invalid transaction",
            404,
            &correlation,
        );
    };
    if tx.kind != "account_registration" || tx.principal_id.is_some() {
        return problem::response(
            "invalid_transaction",
            "Invalid transaction",
            404,
            &correlation,
        );
    }
    if let Some(response) = transaction_problem(&tx, now_seconds(), &correlation)? {
        return Ok(response);
    }
    let transaction_pepper = secret(&context.env, "TRANSACTION_PEPPER")?;
    if guard::validate_transaction_secrets(
        request,
        &tx.csrf_digest,
        &tx.browser_binding_digest,
        transaction_pepper.as_bytes(),
    )
    .is_err()
    {
        return problem::response(
            "invalid_transaction",
            "Invalid transaction",
            403,
            &correlation,
        );
    }
    let input: FinishRegistrationRequest = match request.json().await {
        Ok(value) => value,
        Err(_) => {
            return problem::response("invalid_request", "Invalid JSON request", 400, &correlation);
        }
    };
    let request_digest = Sha256::digest(serde_json::to_vec(&input.credential)?);
    let stored: StoredRegistration = serde_json::from_str(&tx.request_json)?;
    if Sha256::digest(stored.state.challenge.as_bytes())[..] != tx.challenge_digest {
        return problem::response(
            "invalid_transaction",
            "Invalid transaction",
            409,
            &correlation,
        );
    }
    let Some(registration_response) = input.credential.into_passkey() else {
        return problem::response(
            "authentication_failed",
            "Credential verification failed",
            400,
            &correlation,
        );
    };
    let credential =
        match webauthn(&context.env).finish_registration(&stored.state, &registration_response) {
            Ok(value) => value,
            Err(_) => {
                return problem::response(
                    "authentication_failed",
                    "Credential verification failed",
                    400,
                    &correlation,
                );
            }
        };
    let principal_id = PrincipalId::new_v4().to_string();
    let identifier_id = IdentifierId::new_v7(worker::Date::now().as_millis()).to_string();
    let authenticator_id = AuthenticatorId::new_v7(worker::Date::now().as_millis()).to_string();
    let session_id = SessionId::new_v7(worker::Date::now().as_millis()).to_string();
    let session_wire = random_secret_wire();
    let session_digest = SecretDigest::hmac(
        secret(&context.env, "SESSION_PEPPER")?.as_bytes(),
        session_wire.as_bytes(),
    );
    let audit_id = AuditEventId::new_v7(worker::Date::now().as_millis()).to_string();
    let now = now_seconds();
    repository::commit_registration(
        &db,
        &tx,
        &request_digest,
        &principal_id,
        &stored.user_handle,
        &stored.display_name,
        &stored.locale,
        &identifier_id,
        &stored.username,
        &authenticator_id,
        credential.id.as_bytes(),
        credential.public_key_cose.as_bytes(),
        credential.counter,
        &credential.aaguid,
        &serde_json::to_string(&credential.transports)?,
        &stored.authenticator_label,
        &session_id,
        &session_digest.0,
        &audit_id,
        &correlation,
        now,
    )
    .await?;
    let csrf_token = guard::session_csrf_token(
        &session_wire,
        secret(&context.env, "CSRF_PEPPER")?.as_bytes(),
    );
    let created_at = date_time(now);
    json(
        &serde_json::json!({
            "account": {
                "principal_id": principal_id,
                "lifecycle_state": "active",
                "profile": {"display_name": stored.display_name, "locale": stored.locale},
                "identifiers": [{"identifier_id": identifier_id, "kind":"username", "value":stored.username, "created_at":created_at, "updated_at":created_at}],
                "created_at": created_at, "updated_at": created_at
            },
            "authenticator": {
                "authenticator_id": authenticator_id, "label":stored.authenticator_label,
                "transports":credential.transports, "backup_eligible":false, "backup_state":false,
                "is_current":true, "created_at":created_at, "last_used_at":null, "revoked_at":null
            },
            "csrf_token":csrf_token, "csrf_expires_at":date_time(now + 43_200)
        }),
        201,
        &correlation,
        Some(&guard::login_origin(&context.env)),
        Some(&guard::session_cookie(&session_wire)),
    )
}

#[derive(Serialize, Deserialize)]
struct StoredAuthentication {
    state: AuthenticationState,
    policy_revision: i64,
}

pub async fn start_authentication(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    if let Err(error) = mutation_guard(&request, &context.env) {
        return error_response(error, &correlation);
    }
    if !guard::validate_browser_csrf(&request, secret(&context.env, "CSRF_PEPPER")?.as_bytes()) {
        return problem::response(
            "invalid_request",
            "CSRF validation failed",
            403,
            &correlation,
        );
    }
    let mut request = request;
    let input: StartAuthenticationRequest = match request.json().await {
        Ok(value) => value,
        Err(_) => {
            return problem::response("invalid_request", "Invalid JSON request", 400, &correlation);
        }
    };
    if input.purpose != "login" {
        return problem::response(
            "service_unavailable",
            "Step-up is not enabled",
            503,
            &correlation,
        );
    }
    let browser_wire = guard::cookie(&request, guard::BROWSER_COOKIE)
        .ok_or_else(|| Error::RustError("validated browser cookie disappeared".into()))?;
    let csrf_wire = random_secret_wire();
    let pepper = secret(&context.env, "TRANSACTION_PEPPER")?;
    let browser_digest = SecretDigest::hmac(pepper.as_bytes(), browser_wire.as_bytes());
    let csrf_digest = SecretDigest::hmac(pepper.as_bytes(), csrf_wire.as_bytes());
    let (challenge, state) = webauthn(&context.env).start_authentication(&[]);
    let stored = StoredAuthentication {
        state,
        policy_revision: 1,
    };
    let now = now_seconds();
    let expires_at = now + 300;
    let id = TransactionId::new_v7(worker::Date::now().as_millis()).to_string();
    repository::insert_webauthn_transaction(
        &context.d1("DB")?,
        &id,
        "authentication",
        None,
        None,
        &Sha256::digest(stored.state.challenge.as_bytes()),
        &browser_digest.0,
        &csrf_digest.0,
        &rp_id(&context.env),
        &guard::login_origin(&context.env),
        &serde_json::to_string(&stored)?,
        1,
        now,
        expires_at,
    )
    .await?;
    json(
        &TransactionResponse {
            transaction_id: id,
            csrf_token: csrf_wire,
            public_key: authentication_options_to_wire(serde_json::to_value(challenge)?),
            expires_at: date_time(expires_at),
        },
        201,
        &correlation,
        Some(&guard::login_origin(&context.env)),
        None,
    )
}

#[derive(Deserialize)]
struct StartAuthenticationRequest {
    purpose: String,
}

#[derive(Deserialize)]
struct FinishAuthenticationRequest {
    credential: AuthenticationCredentialWire,
}

#[derive(Deserialize, Serialize)]
struct AuthenticationCredentialWire {
    id: String,
    raw_id: String,
    #[serde(rename = "type")]
    kind: String,
    response: AuthenticationCredentialResponseWire,
}

#[derive(Deserialize, Serialize)]
struct AuthenticationCredentialResponseWire {
    client_data_json: String,
    authenticator_data: String,
    signature: String,
    user_handle: Option<String>,
}

impl AuthenticationCredentialWire {
    fn into_passkey(self) -> Option<AuthenticationResponse> {
        (self.kind == "public-key" && self.id == self.raw_id).then_some(AuthenticationResponse {
            id: self.id,
            authenticator_data: self.response.authenticator_data,
            signature: self.response.signature,
            client_data_json: self.response.client_data_json,
            user_handle: self.response.user_handle,
        })
    }
}

pub async fn finish_authentication(
    mut request: Request,
    context: RouteContext<()>,
) -> Result<Response> {
    let correlation = correlation_id();
    if let Err(error) = mutation_guard(&request, &context.env) {
        return error_response(error, &correlation);
    }
    let Some(id) = context.param("id") else {
        return problem::response(
            "invalid_transaction",
            "Invalid transaction",
            404,
            &correlation,
        );
    };
    let db = context.d1("DB")?;
    let Some(tx) = repository::webauthn_transaction(&db, id).await? else {
        return problem::response(
            "invalid_transaction",
            "Invalid transaction",
            404,
            &correlation,
        );
    };
    if tx.kind != "authentication" || tx.principal_id.is_some() {
        return problem::response(
            "invalid_transaction",
            "Invalid transaction",
            404,
            &correlation,
        );
    }
    if let Some(response) = transaction_problem(&tx, now_seconds(), &correlation)? {
        return Ok(response);
    }
    let pepper = secret(&context.env, "TRANSACTION_PEPPER")?;
    if guard::validate_transaction_secrets(
        &request,
        &tx.csrf_digest,
        &tx.browser_binding_digest,
        pepper.as_bytes(),
    )
    .is_err()
    {
        return problem::response(
            "invalid_transaction",
            "Invalid transaction",
            403,
            &correlation,
        );
    }
    let input: FinishAuthenticationRequest = match request.json().await {
        Ok(v) => v,
        Err(_) => {
            return problem::response("invalid_request", "Invalid JSON request", 400, &correlation);
        }
    };
    let request_digest = Sha256::digest(serde_json::to_vec(&input.credential)?);
    let Some(authentication_response) = input.credential.into_passkey() else {
        return problem::response(
            "authentication_failed",
            "Credential verification failed",
            401,
            &correlation,
        );
    };
    let credential_id = match CredentialId::from_b64url(&authentication_response.id) {
        Ok(v) => v,
        Err(_) => {
            return problem::response(
                "authentication_failed",
                "Credential verification failed",
                401,
                &correlation,
            );
        }
    };
    let Some(row) = repository::credential_by_id(&db, credential_id.as_bytes()).await? else {
        return problem::response(
            "authentication_failed",
            "Credential verification failed",
            401,
            &correlation,
        );
    };
    if row.lifecycle_state != "active" {
        return problem::response(
            "principal_suspended",
            "Authentication is unavailable",
            403,
            &correlation,
        );
    }
    let stored: StoredAuthentication = serde_json::from_str(&tx.request_json)?;
    let aaguid: [u8; 16] = row
        .aaguid
        .clone()
        .try_into()
        .map_err(|_| Error::RustError("invalid stored AAGUID".into()))?;
    let saved = PasskeyCredential {
        id: CredentialId(row.credential_id.clone()),
        public_key_cose: CosePublicKey(row.public_key_cose.clone()),
        counter: row.sign_count,
        transports: serde_json::from_str(&row.transports_json)?,
        aaguid,
    };
    let outcome = match webauthn(&context.env).finish_authentication(
        &stored.state,
        &authentication_response,
        &saved,
    ) {
        Ok(v) => v,
        Err(_) => {
            return problem::response(
                "authentication_failed",
                "Credential verification failed",
                401,
                &correlation,
            );
        }
    };
    let session_id = SessionId::new_v7(worker::Date::now().as_millis()).to_string();
    let session_wire = random_secret_wire();
    let session_digest = SecretDigest::hmac(
        secret(&context.env, "SESSION_PEPPER")?.as_bytes(),
        session_wire.as_bytes(),
    );
    let audit_id = AuditEventId::new_v7(worker::Date::now().as_millis()).to_string();
    repository::commit_authentication(
        &db,
        &tx,
        &request_digest,
        &row,
        outcome.new_counter,
        &session_id,
        &session_digest.0,
        &audit_id,
        &correlation,
        now_seconds(),
    )
    .await?;
    let principal = repository::principal(&db, &row.principal_id)
        .await?
        .ok_or_else(|| Error::RustError("authenticated principal disappeared".into()))?;
    let csrf_token = guard::session_csrf_token(
        &session_wire,
        secret(&context.env, "CSRF_PEPPER")?.as_bytes(),
    );
    let now = now_seconds();
    json(
        &serde_json::json!({
            "account": {"principal_id":principal.principal_id,"lifecycle_state":principal.lifecycle_state,"profile":{"display_name":principal.display_name,"locale":principal.locale},"identifiers":[],"created_at":date_time(now),"updated_at":date_time(now)},
            "session":{"session_id":session_id,"authentication_method":"passkey","authenticator_id":row.authenticator_id,"binding_id":null,"amr":["passkey"],"acr":"urn:moesegfault:acr:passkey-uv","is_current":true,"authenticated_at":date_time(now),"last_seen_at":date_time(now),"expires_at":date_time(now+2_592_000),"revoked_at":null},
            "csrf_token":csrf_token,"csrf_expires_at":date_time(now+43_200)
        }),
        200,
        &correlation,
        Some(&guard::login_origin(&context.env)),
        Some(&guard::session_cookie(&session_wire)),
    )
}

pub async fn get_self(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(session) = authenticated_session(&request, &context.env).await? else {
        return problem::response(
            "authentication_failed",
            "Authentication is required",
            401,
            &correlation,
        );
    };
    let Some(principal) = repository::principal(&context.d1("DB")?, &session.principal_id).await?
    else {
        return problem::response(
            "authentication_failed",
            "Authentication is required",
            401,
            &correlation,
        );
    };
    let csrf_token = session_csrf(&request, &context.env)?;
    json(
        &serde_json::json!({"principal_id":principal.principal_id,"state":principal.lifecycle_state,"display_name":principal.display_name,"locale":principal.locale,"username":principal.username,"csrf_token":csrf_token}),
        200,
        &correlation,
        Some(&guard::login_origin(&context.env)),
        None,
    )
}

pub async fn list_authenticators(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(session) = authenticated_session(&request, &context.env).await? else {
        return problem::response(
            "authentication_failed",
            "Authentication is required",
            401,
            &correlation,
        );
    };
    let values = repository::authenticators(&context.d1("DB")?, &session.principal_id).await?;
    json(
        &serde_json::json!({"authenticators":values}),
        200,
        &correlation,
        Some(&guard::login_origin(&context.env)),
        None,
    )
}

pub async fn list_sessions(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(current) = authenticated_session(&request, &context.env).await? else {
        return problem::response(
            "authentication_failed",
            "Authentication is required",
            401,
            &correlation,
        );
    };
    let mut values = repository::sessions(&context.d1("DB")?, &current.principal_id).await?;
    let payload:Vec<_>=values.drain(..).map(|s|serde_json::json!({"session_id":s.session_id,"authenticator_id":s.authenticator_id,"authenticated_at":s.authenticated_at,"last_seen_at":s.last_seen_at,"expires_at":s.expires_at,"revoked_at":s.revoked_at,"current":s.session_id==current.session_id})).collect();
    json(
        &serde_json::json!({"sessions":payload}),
        200,
        &correlation,
        Some(&guard::login_origin(&context.env)),
        None,
    )
}

pub async fn revoke_session(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    if let Err(error) = mutation_guard(&request, &context.env) {
        return error_response(error, &correlation);
    }
    let Some(current) = authenticated_session(&request, &context.env).await? else {
        return problem::response(
            "authentication_failed",
            "Authentication is required",
            401,
            &correlation,
        );
    };
    if !valid_session_csrf(&request, &context.env)? {
        return problem::response(
            "invalid_request",
            "CSRF validation failed",
            403,
            &correlation,
        );
    }
    let Some(id) = context.param("id") else {
        return problem::response("invalid_request", "Invalid session", 400, &correlation);
    };
    repository::revoke_session(&context.d1("DB")?, &current.principal_id, id, now_seconds())
        .await?;
    json(
        &serde_json::json!({"revoked":true}),
        200,
        &correlation,
        Some(&guard::login_origin(&context.env)),
        if id == &current.session_id {
            Some(guard::clear_session_cookie())
        } else {
            None
        },
    )
}

pub async fn revoke_all(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    if let Err(error) = mutation_guard(&request, &context.env) {
        return error_response(error, &correlation);
    }
    let Some(current) = authenticated_session(&request, &context.env).await? else {
        return problem::response(
            "authentication_failed",
            "Authentication is required",
            401,
            &correlation,
        );
    };
    if !valid_session_csrf(&request, &context.env)? {
        return problem::response(
            "invalid_request",
            "CSRF validation failed",
            403,
            &correlation,
        );
    }
    repository::revoke_all(&context.d1("DB")?, &current.principal_id, now_seconds()).await?;
    json(
        &serde_json::json!({"revoked":true}),
        200,
        &correlation,
        Some(&guard::login_origin(&context.env)),
        Some(guard::clear_session_cookie()),
    )
}

pub async fn unavailable(_request: Request, _context: RouteContext<()>) -> Result<Response> {
    problem::response(
        "service_unavailable",
        "This feature is not enabled in this release",
        503,
        &correlation_id(),
    )
}

async fn authenticated_session(
    request: &Request,
    env: &Env,
) -> Result<Option<repository::CurrentSession>> {
    let Some(wire) = guard::cookie(request, guard::SESSION_COOKIE) else {
        return Ok(None);
    };
    let digest = SecretDigest::hmac(secret(env, "SESSION_PEPPER")?.as_bytes(), wire.as_bytes());
    repository::current_session(&env.d1("DB")?, &digest.0, now_seconds()).await
}

fn session_csrf(request: &Request, env: &Env) -> Result<String> {
    let wire = guard::cookie(request, guard::SESSION_COOKIE)
        .ok_or_else(|| Error::RustError("authenticated request lost its session cookie".into()))?;
    Ok(guard::session_csrf_token(
        &wire,
        secret(env, "CSRF_PEPPER")?.as_bytes(),
    ))
}

fn valid_session_csrf(request: &Request, env: &Env) -> Result<bool> {
    let Some(wire) = guard::cookie(request, guard::SESSION_COOKIE) else {
        return Ok(false);
    };
    Ok(guard::validate_session_csrf(
        request,
        &wire,
        secret(env, "CSRF_PEPPER")?.as_bytes(),
    ))
}

fn webauthn(env: &Env) -> Webauthn {
    Webauthn::new(&rp_id(env), RP_NAME, &guard::login_origin(env))
        .require_user_verification(true)
        .strict_base64(true)
        .authenticator_attachment(Attachment::Any)
}
fn issuer(env: &Env) -> String {
    env.var("ISSUER")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "https://identity.moesegfault.dev".to_owned())
}
fn rp_id(env: &Env) -> String {
    env.var("WEBAUTHN_RP_ID")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "login.moesegfault.dev".to_owned())
}
fn default_locale() -> String {
    "zh-CN".to_owned()
}
fn now_seconds() -> i64 {
    (worker::Date::now().as_millis() / 1_000) as i64
}
fn correlation_id() -> String {
    TransactionId::new_v7(worker::Date::now().as_millis()).to_string()
}
fn random_bytes() -> Vec<u8> {
    let mut bytes = vec![0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
}
fn random_secret_wire() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes())
}
fn date_time(seconds: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .expect("Workers clock is in the RFC 3339 range")
        .format(&time::format_description::well_known::Rfc3339)
        .expect("RFC 3339 formatting is infallible for a valid timestamp")
}

fn registration_options_to_wire(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(parameters) = value
        .get_mut("pubKeyCredParams")
        .and_then(|v| v.as_array_mut())
    {
        parameters.retain(|parameter| parameter.get("alg").and_then(|v| v.as_i64()) == Some(-7));
    }
    rename(&mut value, "pubKeyCredParams", "pub_key_cred_params");
    rename(&mut value, "excludeCredentials", "exclude_credentials");
    rename(
        &mut value,
        "authenticatorSelection",
        "authenticator_selection",
    );
    if let Some(user) = value.get_mut("user") {
        rename(user, "displayName", "display_name");
    }
    if let Some(selection) = value.get_mut("authenticator_selection") {
        rename(
            selection,
            "authenticatorAttachment",
            "authenticator_attachment",
        );
        rename(selection, "residentKey", "resident_key");
        rename(selection, "requireResidentKey", "require_resident_key");
        rename(selection, "userVerification", "user_verification");
    }
    value
}

fn authentication_options_to_wire(mut value: serde_json::Value) -> serde_json::Value {
    rename(&mut value, "rpId", "rp_id");
    rename(&mut value, "allowCredentials", "allow_credentials");
    rename(&mut value, "userVerification", "user_verification");
    value
}

fn rename(value: &mut serde_json::Value, from: &str, to: &str) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if let Some(item) = object.remove(from) {
        object.insert(to.to_owned(), item);
    }
}
fn secret(env: &Env, name: &str) -> Result<String> {
    env.secret(name)
        .map(|s| s.to_string())
        .map_err(|_| Error::BindingError(format!("missing required secret binding {name}")))
}
fn body_too_large(request: &Request) -> bool {
    guard::header(request.headers(), "content-length")
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|n| n > MAX_JSON_BYTES)
}

fn mutation_guard(request: &Request, env: &Env) -> std::result::Result<(), guard::GuardError> {
    if body_too_large(request) {
        return Err(guard::GuardError::ContentType);
    }
    guard::validate_browser_mutation(request, env)
}
fn error_response(error: guard::GuardError, correlation: &str) -> Result<Response> {
    let (code, title, status) = match error {
        guard::GuardError::Origin => ("invalid_request", "Origin is not allowed", 403),
        guard::GuardError::ContentType => ("invalid_request", "JSON content type is required", 415),
        guard::GuardError::FetchMetadata => {
            ("invalid_request", "Invalid browser request context", 403)
        }
        guard::GuardError::Csrf => ("invalid_request", "CSRF validation failed", 403),
        guard::GuardError::BrowserBinding => ("invalid_transaction", "Invalid transaction", 403),
    };
    problem::response(code, title, status, correlation)
}
fn transaction_problem(
    tx: &repository::WebauthnTransactionRow,
    now: i64,
    correlation: &str,
) -> Result<Option<Response>> {
    if now >= tx.expires_at {
        return problem::response(
            "transaction_expired",
            "Transaction has expired",
            410,
            correlation,
        )
        .map(Some);
    }
    if tx.state != "pending" {
        return problem::response(
            "transaction_consumed",
            "Transaction has already been consumed",
            409,
            correlation,
        )
        .map(Some);
    }
    Ok(None)
}

fn json<T: Serialize>(
    value: &T,
    status: u16,
    correlation: &str,
    origin: Option<&str>,
    cookie: Option<&str>,
) -> Result<Response> {
    let headers = Headers::new();
    headers.set("content-type", "application/json; charset=utf-8")?;
    headers.set("cache-control", "no-store")?;
    headers.set("x-content-type-options", "nosniff")?;
    headers.set("x-moesegfault-correlation-id", correlation)?;
    if let Some(origin) = origin {
        headers.set("access-control-allow-origin", origin)?;
        headers.set("access-control-allow-credentials", "true")?;
        headers.set("vary", "Origin")?;
    }
    if let Some(cookie) = cookie {
        headers.append("set-cookie", cookie)?;
    }
    Ok(Response::from_json(value)?
        .with_status(status)
        .with_headers(headers))
}
fn public_json<T: Serialize>(value: &T, correlation: &str) -> Result<Response> {
    let response = json(value, 200, correlation, None, None)?;
    response.headers().set("access-control-allow-origin", "*")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn random_secret_has_256_bits_in_wire_format() {
        let wire = random_secret_wire();
        assert_eq!(wire.len(), 43);
        assert_eq!(URL_SAFE_NO_PAD.decode(wire).unwrap().len(), 32);
    }
    #[test]
    fn discovery_lifetimes_are_server_owned() {
        assert_eq!(MAX_JSON_BYTES, 65_536);
    }

    #[test]
    fn webauthn_options_use_contract_snake_case() {
        let value = serde_json::json!({"pubKeyCredParams":[{"type":"public-key","alg":-7},{"type":"public-key","alg":-8}],"user":{"displayName":"Klee"},"authenticatorSelection":{"residentKey":"required","requireResidentKey":true,"userVerification":"required"}});
        let wire = registration_options_to_wire(value);
        assert!(wire.get("pub_key_cred_params").is_some());
        assert_eq!(wire["pub_key_cred_params"].as_array().unwrap().len(), 1);
        assert_eq!(wire["user"]["display_name"], "Klee");
        assert_eq!(wire["authenticator_selection"]["resident_key"], "required");
    }
}
