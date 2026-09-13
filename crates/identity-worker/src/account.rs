//! 自助账户管理 HTTP 处理器。/ Self-service account-management HTTP handlers.
//!
//! 本模块把会话所有权、CSRF、近期 Passkey 认证和 D1 原子命令保持在同一条
//! 清晰路径上；线路模型与数据库投影刻意分离，避免泄露 R2 key 或 Unix 时间戳。
//! This module keeps session ownership, CSRF, recent-Passkey authentication, and D1
//! atomic commands on one explicit path. Wire models stay separate from database
//! projections so R2 keys and Unix timestamps cannot leak accidentally.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use identity_domain::{
    AuditEventId, AuthenticatorId, IdentifierId, LifetimePolicy, SecretDigest, TransactionId,
    normalize_username,
};
use passkey_auth::{Attachment, CredentialId, RegistrationResponse, RegistrationState, Webauthn};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use worker::*;

use crate::{account_repository as repository, ceremony_state, guard, problem};

const RP_NAME: &str = "moeSegFault";
const MAX_JSON_BYTES: u64 = 64 * 1024;
const RECOVERY_CODE_COUNT: usize = 8;

#[derive(Debug, Serialize)]
struct AccountWire {
    principal_id: String,
    lifecycle_state: String,
    profile: ProfileWire,
    identifiers: Vec<IdentifierWire>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct ProfileWire {
    display_name: String,
    avatar_url: Option<String>,
    locale: String,
}

#[derive(Debug, Serialize)]
struct IdentifierWire {
    identifier_id: String,
    kind: String,
    value: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct AuthenticatorWire {
    authenticator_id: String,
    label: String,
    transports: Vec<String>,
    backup_eligible: bool,
    backup_state: bool,
    is_current: bool,
    created_at: String,
    last_used_at: Option<String>,
    revoked_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct SessionWire {
    session_id: String,
    authentication_method: String,
    authenticator_id: Option<String>,
    binding_id: Option<String>,
    amr: Vec<String>,
    acr: String,
    is_current: bool,
    authenticated_at: String,
    last_seen_at: String,
    expires_at: String,
    revoked_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateAccountRequest {
    display_name: Option<String>,
    locale: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentifierInput {
    kind: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateAuthenticatorRegistrationRequest {
    authenticator_label: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateAuthenticatorRequest {
    label: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyObject {}

#[derive(Debug, Serialize, Deserialize)]
struct StoredAddition {
    authenticator_label: String,
    initiating_session_id: String,
    state: RegistrationState,
}

#[derive(Debug, Serialize)]
struct TransactionResponse {
    transaction_id: String,
    csrf_token: String,
    public_key: serde_json::Value,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FinishRegistrationRequest {
    credential: RegistrationCredentialWire,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RegistrationCredentialWire {
    id: String,
    raw_id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    authenticator_attachment: Option<String>,
    response: RegistrationCredentialResponseWire,
    client_extension_results: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RegistrationCredentialResponseWire {
    client_data_json: String,
    attestation_object: String,
    #[serde(default)]
    transports: Vec<String>,
}

impl RegistrationCredentialWire {
    fn into_passkey(self) -> Option<RegistrationResponse> {
        let attachment_is_valid = self
            .authenticator_attachment
            .as_deref()
            .is_none_or(|value| matches!(value, "platform" | "cross-platform"));
        let _client_extension_results = self.client_extension_results;
        (self.kind == "public-key" && self.id == self.raw_id && attachment_is_valid).then_some(
            RegistrationResponse {
                id: self.id,
                transports: self.response.transports,
                attestation_object: self.response.attestation_object,
                client_data_json: self.response.client_data_json,
            },
        )
    }
}

#[derive(Debug, Clone, Copy)]
enum MutationBody {
    Json,
    MergePatch,
    None,
}

/// 返回当前账户和与当前 session 绑定的 CSRF token。
/// Returns the current account and the CSRF token bound to its current session.
pub async fn get_self(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(session) = authenticate(&request, &context.env).await? else {
        return authentication_required(&correlation);
    };
    let Some(account) = repository::account(&context.d1("DB")?, &session.principal_id).await?
    else {
        return authentication_required(&correlation);
    };
    json(
        &serde_json::json!({
            "account": account_to_wire(account),
            "csrf_token": session_csrf(&request, &context.env)?,
            "csrf_expires_at": date_time(now_seconds() + 43_200),
        }),
        200,
        &correlation,
        &context.env,
        None,
    )
}

/// 应用严格的 JSON Merge Patch 资料更新。/ Applies a strict JSON Merge Patch profile update.
pub async fn update_self(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let session = match mutation_session(
        &request,
        &context.env,
        MutationBody::MergePatch,
        &correlation,
    )
    .await?
    {
        Ok(session) => session,
        Err(response) => return Ok(response),
    };
    let input: UpdateAccountRequest = match request.json().await {
        Ok(input) => input,
        Err(_) => return invalid_request("Invalid JSON request", &correlation),
    };
    if input.display_name.is_none() && input.locale.is_none() {
        return invalid_request("At least one profile field is required", &correlation);
    }
    let display_name = input
        .display_name
        .as_deref()
        .map(|value| valid_text(value, 1, 80).ok_or(()));
    let locale = input
        .locale
        .as_deref()
        .map(|value| valid_text(value, 2, 35).ok_or(()));
    if display_name.as_ref().is_some_and(Result::is_err)
        || locale.as_ref().is_some_and(Result::is_err)
    {
        return invalid_request("Invalid profile fields", &correlation);
    }
    let display_name = display_name.and_then(Result::ok);
    let locale = locale.and_then(Result::ok);
    let Some(account) = repository::update_account(
        &context.d1("DB")?,
        &session.principal_id,
        display_name,
        locale,
        now_seconds(),
    )
    .await?
    else {
        return authentication_required(&correlation);
    };
    json(
        &account_to_wire(account),
        200,
        &correlation,
        &context.env,
        None,
    )
}

/// 在近期 Passkey 认证后计划删除账户并撤销其全部认证能力。
/// Schedules account deletion after recent Passkey authentication and revokes all authority.
pub async fn schedule_self_deletion(
    request: Request,
    context: RouteContext<()>,
) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::None, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    if !recent_passkey(&session, now_seconds()) {
        return reauthentication_required(&correlation);
    }
    repository::schedule_self_deletion(
        &context.d1("DB")?,
        &session.principal_id,
        &audit_id(),
        &correlation,
        now_seconds(),
    )
    .await?;
    no_content(
        &correlation,
        &context.env,
        Some(guard::clear_session_cookie()),
    )
}

/// 列出当前账户的登录标识符。/ Lists login identifiers owned by the current account.
pub async fn list_identifiers(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(session) = authenticate(&request, &context.env).await? else {
        return authentication_required(&correlation);
    };
    let items = repository::identifiers(&context.d1("DB")?, &session.principal_id)
        .await?
        .into_iter()
        .map(identifier_to_wire)
        .collect::<Vec<_>>();
    json(
        &serde_json::json!({"items": items}),
        200,
        &correlation,
        &context.env,
        None,
    )
}

/// 创建首期 username 标识符。/ Creates the first-release username identifier.
pub async fn create_identifier(
    mut request: Request,
    context: RouteContext<()>,
) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::Json, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    let input: IdentifierInput = match request.json().await {
        Ok(input) => input,
        Err(_) => return invalid_request("Invalid JSON request", &correlation),
    };
    let value = match identifier_value(&input) {
        Ok(value) => value,
        Err(()) => return invalid_request("Invalid username", &correlation),
    };
    if !repository::identifiers(&context.d1("DB")?, &session.principal_id)
        .await?
        .is_empty()
    {
        return identifier_conflict(&correlation);
    }
    let id = IdentifierId::new_v7(worker::Date::now().as_millis()).to_string();
    let result = repository::create_identifier(
        &context.d1("DB")?,
        &session.principal_id,
        &id,
        &value,
        &value,
        &audit_id(),
        &correlation,
        now_seconds(),
    )
    .await;
    let item = match result {
        Ok(Some(item)) => item,
        Ok(None) => return authentication_required(&correlation),
        Err(error) if is_unique_error(&error) => return identifier_conflict(&correlation),
        Err(error) => return Err(error),
    };
    json(
        &identifier_to_wire(item),
        201,
        &correlation,
        &context.env,
        None,
    )
}

/// 替换账户拥有的 username。/ Replaces the username owned by the account.
pub async fn update_identifier(
    mut request: Request,
    context: RouteContext<()>,
) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::Json, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    let Some(id) = path_uuid_v7(&context, "identifier_id") else {
        return not_found("Identifier was not found", &correlation);
    };
    let input: IdentifierInput = match request.json().await {
        Ok(input) => input,
        Err(_) => return invalid_request("Invalid JSON request", &correlation),
    };
    let value = match identifier_value(&input) {
        Ok(value) => value,
        Err(()) => return invalid_request("Invalid username", &correlation),
    };
    let result = repository::update_identifier(
        &context.d1("DB")?,
        &session.principal_id,
        id,
        &value,
        &value,
        &audit_id(),
        &correlation,
        now_seconds(),
    )
    .await;
    let item = match result {
        Ok(Some(item)) => item,
        Ok(None) => return not_found("Identifier was not found", &correlation),
        Err(error) if is_unique_error(&error) => return identifier_conflict(&correlation),
        Err(error) => return Err(error),
    };
    json(
        &identifier_to_wire(item),
        200,
        &correlation,
        &context.env,
        None,
    )
}

/// 幂等删除账户拥有的 username。/ Idempotently deletes an account-owned username.
pub async fn delete_identifier(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::None, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    if let Some(id) = path_uuid_v7(&context, "identifier_id") {
        repository::delete_identifier(
            &context.d1("DB")?,
            &session.principal_id,
            id,
            &audit_id(),
            &correlation,
            now_seconds(),
        )
        .await?;
    }
    no_content(&correlation, &context.env, None)
}

/// 列出 Passkey，并标注建立当前 session 的一枚。/ Lists Passkeys and marks the one establishing the current session.
pub async fn list_authenticators(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(session) = authenticate(&request, &context.env).await? else {
        return authentication_required(&correlation);
    };
    let items = repository::authenticators(
        &context.d1("DB")?,
        &session.principal_id,
        session.authenticator_id.as_deref(),
    )
    .await?
    .into_iter()
    .map(authenticator_to_wire)
    .collect::<Vec<_>>();
    json(
        &serde_json::json!({"items": items}),
        200,
        &correlation,
        &context.env,
        None,
    )
}

/// 在近期 Passkey session 上启动额外 Passkey ceremony。
/// Starts an additional-Passkey ceremony from a recent Passkey session.
pub async fn start_authenticator_registration(
    mut request: Request,
    context: RouteContext<()>,
) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::Json, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    if !recent_passkey(&session, now_seconds()) {
        return reauthentication_required(&correlation);
    }
    let input: CreateAuthenticatorRegistrationRequest = match request.json().await {
        Ok(input) => input,
        Err(_) => return invalid_request("Invalid JSON request", &correlation),
    };
    let Some(label) = valid_text(&input.authenticator_label, 1, 80) else {
        return invalid_request("Invalid authenticator label", &correlation);
    };
    let db = context.d1("DB")?;
    let Some(identity) = repository::addition_identity(&db, &session.principal_id).await? else {
        return authentication_required(&correlation);
    };
    let existing = identity
        .credential_ids
        .into_iter()
        .map(CredentialId)
        .collect::<Vec<_>>();
    let (challenge, state) = webauthn(&context.env).start_registration(
        &identity.user_handle,
        &identity.username,
        &identity.display_name,
        &existing,
    );
    let id = TransactionId::new_v7(worker::Date::now().as_millis()).to_string();
    let stored = StoredAddition {
        authenticator_label: label.to_owned(),
        initiating_session_id: session.session_id,
        state,
    };
    let envelope = ceremony_state::seal(
        &stored,
        &secret(&context.env, "TRANSACTION_STATE_KEY")?,
        &id,
        "authenticator_addition",
    )?;
    let Some(browser_wire) = guard::cookie(&request, guard::BROWSER_COOKIE) else {
        return problem::response(
            "invalid_request",
            "Browser context is required",
            403,
            &correlation,
        );
    };
    let csrf_wire = random_secret_wire();
    let transaction_pepper = secret(&context.env, "TRANSACTION_PEPPER")?;
    let browser_digest = SecretDigest::hmac(transaction_pepper.as_bytes(), browser_wire.as_bytes());
    let csrf_digest = SecretDigest::hmac(transaction_pepper.as_bytes(), csrf_wire.as_bytes());
    let now = now_seconds();
    repository::insert_addition_transaction(
        &db,
        &id,
        &identity.principal_id,
        &Sha256::digest(stored.state.challenge.as_bytes()),
        &browser_digest.0,
        &csrf_digest.0,
        &rp_id(&context.env),
        &guard::login_origin(&context.env),
        &envelope,
        1,
        now,
        now + 300,
    )
    .await?;
    let mut public_key = serde_json::to_value(challenge)?;
    public_key["authenticatorSelection"]["residentKey"] = serde_json::json!("required");
    public_key["authenticatorSelection"]["requireResidentKey"] = serde_json::json!(true);
    json(
        &TransactionResponse {
            transaction_id: id,
            csrf_token: csrf_wire,
            public_key: registration_options_to_wire(public_key),
            expires_at: date_time(now + 300),
        },
        201,
        &correlation,
        &context.env,
        None,
    )
}

/// 完成 `authenticator_addition`；仅由共享 registration completion dispatcher 调用。
/// Completes `authenticator_addition`; called only by the shared registration-completion dispatcher.
pub(crate) async fn finish_authenticator_registration(
    request: &mut Request,
    context: &RouteContext<()>,
    transaction: crate::repository::WebauthnTransactionRow,
) -> Result<Response> {
    let correlation = correlation_id();
    let now = now_seconds();
    if transaction.kind != "authenticator_addition" || transaction.principal_id.is_none() {
        return not_found("Invalid transaction", &correlation);
    }
    if now >= transaction.expires_at {
        return problem::response(
            "transaction_expired",
            "Transaction has expired",
            410,
            &correlation,
        );
    }
    if transaction.state != "pending" {
        return problem::response(
            "transaction_consumed",
            "Transaction has already been consumed",
            409,
            &correlation,
        );
    }
    if guard::validate_transaction_secrets(
        request,
        &transaction.csrf_digest,
        &transaction.browser_binding_digest,
        secret(&context.env, "TRANSACTION_PEPPER")?.as_bytes(),
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
    let stored: StoredAddition = ceremony_state::open(
        &transaction.request_json,
        &secret(&context.env, "TRANSACTION_STATE_KEY")?,
        &transaction.transaction_id,
        &transaction.kind,
    )?;
    let Some(session) = authenticate(request, &context.env).await? else {
        return authentication_required(&correlation);
    };
    if session.session_id != stored.initiating_session_id
        || Some(session.principal_id.as_str()) != transaction.principal_id.as_deref()
    {
        return problem::response(
            "invalid_transaction",
            "Invalid transaction",
            403,
            &correlation,
        );
    }
    let input: FinishRegistrationRequest = match request.json().await {
        Ok(input) => input,
        Err(_) => return invalid_request("Invalid JSON request", &correlation),
    };
    let request_digest = Sha256::digest(serde_json::to_vec(&input.credential)?);
    if Sha256::digest(stored.state.challenge.as_bytes())[..] != transaction.challenge_digest {
        return problem::response(
            "invalid_transaction",
            "Invalid transaction",
            409,
            &correlation,
        );
    }
    let Some(response) = input.credential.into_passkey() else {
        commit_addition_failure(context, &transaction, &request_digest, &correlation).await?;
        return problem::response(
            "authentication_failed",
            "Credential verification failed",
            400,
            &correlation,
        );
    };
    let mut credential = match webauthn(&context.env).finish_registration(&stored.state, &response)
    {
        Ok(credential) => credential,
        Err(_) => {
            commit_addition_failure(context, &transaction, &request_digest, &correlation).await?;
            return problem::response(
                "authentication_failed",
                "Credential verification failed",
                400,
                &correlation,
            );
        }
    };
    canonicalize_transports(&mut credential.transports);
    let authenticator_id = AuthenticatorId::new_v7(worker::Date::now().as_millis()).to_string();
    let db = context.d1("DB")?;
    repository::commit_addition(
        &db,
        &transaction,
        &request_digest,
        &authenticator_id,
        credential.id.as_bytes(),
        credential.public_key_cose.as_bytes(),
        credential.counter,
        &credential.aaguid,
        &serde_json::to_string(&credential.transports)?,
        false,
        false,
        &stored.authenticator_label,
        &AuditEventId::new_v7(worker::Date::now().as_millis()).to_string(),
        &correlation,
        now,
    )
    .await?;
    let account = repository::account(&db, &session.principal_id)
        .await?
        .ok_or_else(|| Error::RustError("authenticated principal disappeared".into()))?;
    let authenticator = repository::authenticators(
        &db,
        &session.principal_id,
        session.authenticator_id.as_deref(),
    )
    .await?
    .into_iter()
    .find(|item| item.authenticator_id == authenticator_id)
    .ok_or_else(|| Error::RustError("created authenticator disappeared".into()))?;
    json(
        &serde_json::json!({
            "account": account_to_wire(account),
            "authenticator": authenticator_to_wire(authenticator),
            "csrf_token": session_csrf(request, &context.env)?,
            "csrf_expires_at": date_time(now + 43_200),
        }),
        201,
        &correlation,
        &context.env,
        None,
    )
}

/// 修改账户拥有的活动 Passkey 标签。/ Renames an active Passkey owned by the account.
pub async fn update_authenticator(
    mut request: Request,
    context: RouteContext<()>,
) -> Result<Response> {
    let correlation = correlation_id();
    let session = match mutation_session(
        &request,
        &context.env,
        MutationBody::MergePatch,
        &correlation,
    )
    .await?
    {
        Ok(session) => session,
        Err(response) => return Ok(response),
    };
    let Some(id) = path_uuid_v7(&context, "authenticator_id") else {
        return not_found("Authenticator was not found", &correlation);
    };
    let input: UpdateAuthenticatorRequest = match request.json().await {
        Ok(input) => input,
        Err(_) => return invalid_request("Invalid JSON request", &correlation),
    };
    let Some(label) = valid_text(&input.label, 1, 80) else {
        return invalid_request("Invalid authenticator label", &correlation);
    };
    let Some(item) = repository::update_authenticator_label(
        &context.d1("DB")?,
        &session.principal_id,
        id,
        label,
        session.authenticator_id.as_deref(),
    )
    .await?
    else {
        return not_found("Authenticator was not found", &correlation);
    };
    json(
        &authenticator_to_wire(item),
        200,
        &correlation,
        &context.env,
        None,
    )
}

/// 在近期 Passkey 认证后撤销非最后一枚 Passkey。
/// Revokes a non-last Passkey after recent Passkey authentication.
pub async fn revoke_authenticator(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::None, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    if !recent_passkey(&session, now_seconds()) {
        return reauthentication_required(&correlation);
    }
    let Some(id) = path_uuid_v7(&context, "authenticator_id") else {
        return no_content(&correlation, &context.env, None);
    };
    match repository::revoke_authenticator(
        &context.d1("DB")?,
        &session.principal_id,
        id,
        &audit_id(),
        &correlation,
        now_seconds(),
    )
    .await?
    {
        repository::RevokeAuthenticatorOutcome::LastAuthenticator => problem::response(
            "last_authenticator",
            "The last authenticator cannot be revoked",
            409,
            &correlation,
        ),
        repository::RevokeAuthenticatorOutcome::Revoked
        | repository::RevokeAuthenticatorOutcome::NotFound => {
            let cookie = (session.authenticator_id.as_deref() == Some(id))
                .then_some(guard::clear_session_cookie());
            no_content(&correlation, &context.env, cookie)
        }
    }
}

/// 列出当前账户的 Identity sessions。/ Lists Identity sessions for the current account.
pub async fn list_sessions(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(session) = authenticate(&request, &context.env).await? else {
        return authentication_required(&correlation);
    };
    let items = repository::sessions(
        &context.d1("DB")?,
        &session.principal_id,
        &session.session_id,
    )
    .await?
    .into_iter()
    .map(session_to_wire)
    .collect::<Vec<_>>();
    json(
        &serde_json::json!({"items":items}),
        200,
        &correlation,
        &context.env,
        None,
    )
}

/// 幂等撤销一个账户 session 及其 refresh-token families。
/// Idempotently revokes one account session and its refresh-token families.
pub async fn revoke_session(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::None, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    let Some(id) = path_uuid_v7(&context, "session_id") else {
        return no_content(&correlation, &context.env, None);
    };
    repository::revoke_session(
        &context.d1("DB")?,
        &session.principal_id,
        id,
        &audit_id(),
        &correlation,
        now_seconds(),
    )
    .await?;
    no_content(
        &correlation,
        &context.env,
        (id == session.session_id).then_some(guard::clear_session_cookie()),
    )
}

/// 撤销账户所有 session 与 refresh-token families。/ Revokes every account session and refresh-token family.
pub async fn revoke_all_sessions(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::None, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    repository::revoke_all(
        &context.d1("DB")?,
        &session.principal_id,
        &audit_id(),
        &correlation,
        now_seconds(),
    )
    .await?;
    no_content(
        &correlation,
        &context.env,
        Some(guard::clear_session_cookie()),
    )
}

/// 返回恢复码数量，绝不读取或返回 secret。/ Returns recovery-code counts without reading or returning secrets.
pub async fn recovery_code_status(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(session) = authenticate(&request, &context.env).await? else {
        return authentication_required(&correlation);
    };
    let Some(status) =
        repository::recovery_code_status(&context.d1("DB")?, &session.principal_id).await?
    else {
        return not_found("Recovery codes were not found", &correlation);
    };
    json(
        &serde_json::json!({
            "generated_at": date_time(status.generated_at),
            "total_count": status.total_count,
            "remaining_count": status.remaining_count,
        }),
        200,
        &correlation,
        &context.env,
        None,
    )
}

/// 原子轮换恢复码，并把明文仅返回一次。/ Atomically rotates recovery codes and returns plaintext exactly once.
pub async fn rotate_recovery_codes(
    mut request: Request,
    context: RouteContext<()>,
) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::Json, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    if !recent_passkey(&session, now_seconds()) {
        return reauthentication_required(&correlation);
    }
    if request.json::<EmptyObject>().await.is_err() {
        return invalid_request("An empty JSON object is required", &correlation);
    }
    let now = now_seconds();
    let (codes, rows) = new_recovery_codes(
        secret(&context.env, "RECOVERY_CODE_PEPPER")?.as_bytes(),
        RECOVERY_CODE_COUNT,
        worker::Date::now().as_millis(),
    );
    repository::rotate_recovery_codes(
        &context.d1("DB")?,
        &session.principal_id,
        &TransactionId::new_v7(worker::Date::now().as_millis()).to_string(),
        &rows,
        &AuditEventId::new_v7(worker::Date::now().as_millis()).to_string(),
        &correlation,
        now,
    )
    .await?;
    json(
        &serde_json::json!({
            "generated_at": date_time(now),
            "total_count": codes.len(),
            "remaining_count": codes.len(),
            "recovery_codes": codes,
        }),
        201,
        &correlation,
        &context.env,
        None,
    )
}

async fn mutation_session(
    request: &Request,
    env: &Env,
    body: MutationBody,
    correlation: &str,
) -> Result<std::result::Result<repository::AccountSession, Response>> {
    if let Some(response) = mutation_problem(request, env, body, correlation)? {
        return Ok(Err(response));
    }
    let Some(session) = authenticate(request, env).await? else {
        return Ok(Err(authentication_required(correlation)?));
    };
    let Some(wire) = guard::cookie(request, guard::SESSION_COOKIE) else {
        return Ok(Err(authentication_required(correlation)?));
    };
    if !guard::validate_session_csrf(request, &wire, secret(env, "CSRF_PEPPER")?.as_bytes()) {
        return Ok(Err(problem::response(
            "invalid_request",
            "CSRF validation failed",
            403,
            correlation,
        )?));
    }
    Ok(Ok(session))
}

fn mutation_problem(
    request: &Request,
    env: &Env,
    body: MutationBody,
    correlation: &str,
) -> Result<Option<Response>> {
    if guard::header(request.headers(), "content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > MAX_JSON_BYTES)
    {
        return problem::response(
            "invalid_request",
            "Request body is too large",
            413,
            correlation,
        )
        .map(Some);
    }
    if guard::header(request.headers(), "origin").as_deref()
        != Some(guard::login_origin(env).as_str())
    {
        return problem::response("invalid_request", "Origin is not allowed", 403, correlation)
            .map(Some);
    }
    if guard::header(request.headers(), "sec-fetch-site").as_deref() != Some("same-site")
        || guard::header(request.headers(), "sec-fetch-mode").as_deref() != Some("cors")
    {
        return problem::response(
            "invalid_request",
            "Invalid browser request context",
            403,
            correlation,
        )
        .map(Some);
    }
    if guard::header(request.headers(), "x-moesegfault-csrf").is_none() {
        return problem::response(
            "invalid_request",
            "CSRF validation failed",
            403,
            correlation,
        )
        .map(Some);
    }
    let Some(key) = guard::header(request.headers(), "idempotency-key") else {
        return invalid_request("Idempotency-Key is required", correlation).map(Some);
    };
    if !(16..=128).contains(&key.len()) || !key.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
        return invalid_request("Invalid Idempotency-Key", correlation).map(Some);
    }
    let expected = match body {
        MutationBody::Json => Some("application/json"),
        MutationBody::MergePatch => Some("application/merge-patch+json"),
        MutationBody::None => None,
    };
    if let Some(expected) = expected {
        let actual = guard::header(request.headers(), "content-type").unwrap_or_default();
        if !actual
            .split(';')
            .next()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case(expected))
        {
            return problem::response("invalid_request", "Invalid content type", 415, correlation)
                .map(Some);
        }
    }
    Ok(None)
}

async fn authenticate(request: &Request, env: &Env) -> Result<Option<repository::AccountSession>> {
    let Some(wire) = guard::cookie(request, guard::SESSION_COOKIE) else {
        return Ok(None);
    };
    let digest = SecretDigest::hmac(secret(env, "SESSION_PEPPER")?.as_bytes(), wire.as_bytes());
    repository::current_session(&env.d1("DB")?, &digest.0, now_seconds()).await
}

fn recent_passkey(session: &repository::AccountSession, now: i64) -> bool {
    session.auth_method == "passkey"
        && session.authenticator_id.is_some()
        && session.authenticated_at <= now
        && now - session.authenticated_at
            <= LifetimePolicy::default().recent_authentication_seconds as i64
}

fn identifier_value(input: &IdentifierInput) -> std::result::Result<String, ()> {
    if input.kind != "username" {
        return Err(());
    }
    normalize_username(&input.value).map_err(|_| ())
}

fn valid_text(value: &str, min: usize, max: usize) -> Option<&str> {
    let trimmed = value.trim();
    (min..=max)
        .contains(&trimmed.chars().count())
        .then_some(trimmed)
}

fn path_uuid_v7<'a>(context: &'a RouteContext<()>, name: &str) -> Option<&'a str> {
    let value = context.param(name)?;
    let uuid = uuid::Uuid::parse_str(value).ok()?;
    (uuid.get_version_num() == 7 && uuid.hyphenated().to_string() == *value).then_some(value)
}

async fn commit_addition_failure(
    context: &RouteContext<()>,
    transaction: &crate::repository::WebauthnTransactionRow,
    request_digest: &[u8],
    correlation: &str,
) -> Result<()> {
    repository::commit_addition_failure(
        &context.d1("DB")?,
        transaction,
        request_digest,
        &AuditEventId::new_v7(worker::Date::now().as_millis()).to_string(),
        correlation,
        now_seconds(),
    )
    .await
}

fn new_recovery_codes(
    pepper: &[u8],
    count: usize,
    unix_millis: u64,
) -> (Vec<String>, Vec<crate::repository::NewRecoveryCode>) {
    (0..count)
        .map(|_| {
            let public_id = TransactionId::new_v7(unix_millis).to_string();
            let secret = random_secret_wire();
            let wire = format!("{public_id}.{secret}");
            let row = crate::repository::NewRecoveryCode {
                recovery_code_id: TransactionId::new_v7(unix_millis).to_string(),
                public_id,
                secret_digest: SecretDigest::hmac(pepper, secret.as_bytes()).0,
            };
            (wire, row)
        })
        .unzip()
}

fn account_to_wire(value: repository::AccountView) -> AccountWire {
    let _private_avatar_key = value.avatar_r2_key;
    AccountWire {
        principal_id: value.principal_id,
        lifecycle_state: value.lifecycle_state,
        profile: ProfileWire {
            display_name: value.display_name,
            avatar_url: None,
            locale: value.locale,
        },
        identifiers: value
            .identifiers
            .into_iter()
            .map(identifier_to_wire)
            .collect(),
        created_at: date_time(value.created_at),
        updated_at: date_time(value.updated_at),
    }
}

fn identifier_to_wire(value: repository::IdentifierView) -> IdentifierWire {
    IdentifierWire {
        identifier_id: value.identifier_id,
        kind: value.kind,
        value: value.value,
        created_at: date_time(value.created_at),
        updated_at: date_time(value.updated_at),
    }
}

fn authenticator_to_wire(value: repository::AuthenticatorView) -> AuthenticatorWire {
    AuthenticatorWire {
        authenticator_id: value.authenticator_id,
        label: value.label,
        transports: value.transports,
        backup_eligible: value.backup_eligible,
        backup_state: value.backup_state,
        is_current: value.is_current,
        created_at: date_time(value.created_at),
        last_used_at: value.last_used_at.map(date_time),
        revoked_at: value.revoked_at.map(date_time),
    }
}

fn session_to_wire(value: repository::SessionView) -> SessionWire {
    SessionWire {
        session_id: value.session_id,
        authentication_method: value.auth_method,
        authenticator_id: value.authenticator_id,
        binding_id: value.binding_id,
        amr: value.amr,
        acr: value.acr,
        is_current: value.is_current,
        authenticated_at: date_time(value.authenticated_at),
        last_seen_at: date_time(value.last_seen_at),
        expires_at: date_time(value.expires_at),
        revoked_at: value.revoked_at.map(date_time),
    }
}

fn webauthn(env: &Env) -> Webauthn {
    Webauthn::new(&rp_id(env), RP_NAME, &guard::login_origin(env))
        .require_user_verification(true)
        .strict_base64(true)
        .authenticator_attachment(Attachment::Any)
}

fn registration_options_to_wire(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(parameters) = value
        .get_mut("pubKeyCredParams")
        .and_then(serde_json::Value::as_array_mut)
    {
        parameters.retain(|parameter| {
            parameter.get("alg").and_then(serde_json::Value::as_i64) == Some(-7)
        });
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

fn rename(value: &mut serde_json::Value, from: &str, to: &str) {
    if let Some(object) = value.as_object_mut()
        && let Some(item) = object.remove(from)
    {
        object.insert(to.to_owned(), item);
    }
}

/// 对 transport hints 排序去重，使存储与 OpenAPI `uniqueItems` 保持一致。
/// Sorts and deduplicates transport hints to preserve the OpenAPI `uniqueItems` contract.
fn canonicalize_transports(transports: &mut Vec<String>) {
    transports.sort_unstable();
    transports.dedup();
}

fn session_csrf(request: &Request, env: &Env) -> Result<String> {
    let wire = guard::cookie(request, guard::SESSION_COOKIE)
        .ok_or_else(|| Error::RustError("authenticated request lost its session cookie".into()))?;
    Ok(guard::session_csrf_token(
        &wire,
        secret(env, "CSRF_PEPPER")?.as_bytes(),
    ))
}

fn secret(env: &Env, name: &str) -> Result<String> {
    env.secret(name)
        .map(|secret| secret.to_string())
        .map_err(|_| Error::BindingError(format!("missing required secret binding {name}")))
}

fn rp_id(env: &Env) -> String {
    env.var("WEBAUTHN_RP_ID")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "login.moesegfault.dev".to_owned())
}

fn now_seconds() -> i64 {
    (worker::Date::now().as_millis() / 1_000) as i64
}
fn correlation_id() -> String {
    TransactionId::new_v7(worker::Date::now().as_millis()).to_string()
}

fn audit_id() -> String {
    AuditEventId::new_v7(worker::Date::now().as_millis()).to_string()
}

fn random_secret_wire() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn date_time(seconds: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .expect("D1 timestamp is in range")
        .format(&time::format_description::well_known::Rfc3339)
        .expect("RFC 3339 formatting succeeds")
}

fn authentication_required(correlation: &str) -> Result<Response> {
    problem::response(
        "authentication_failed",
        "Authentication is required",
        401,
        correlation,
    )
}
fn invalid_request(title: &'static str, correlation: &str) -> Result<Response> {
    problem::response("invalid_request", title, 400, correlation)
}
fn not_found(title: &'static str, correlation: &str) -> Result<Response> {
    problem::response("not_found", title, 404, correlation)
}
fn identifier_conflict(correlation: &str) -> Result<Response> {
    problem::response(
        "identifier_conflict",
        "Username is already in use",
        409,
        correlation,
    )
}
fn reauthentication_required(correlation: &str) -> Result<Response> {
    problem::response(
        "reauthentication_required",
        "Recent Passkey authentication is required",
        403,
        correlation,
    )
}

fn is_unique_error(error: &Error) -> bool {
    error
        .to_string()
        .to_ascii_lowercase()
        .contains("unique constraint")
}

fn json<T: Serialize>(
    value: &T,
    status: u16,
    correlation: &str,
    env: &Env,
    cookie: Option<&str>,
) -> Result<Response> {
    let headers = response_headers(correlation, env)?;
    headers.set("content-type", "application/json; charset=utf-8")?;
    if let Some(cookie) = cookie {
        headers.append("set-cookie", cookie)?;
    }
    Ok(Response::from_json(value)?
        .with_status(status)
        .with_headers(headers))
}

fn no_content(correlation: &str, env: &Env, cookie: Option<&str>) -> Result<Response> {
    let headers = response_headers(correlation, env)?;
    if let Some(cookie) = cookie {
        headers.append("set-cookie", cookie)?;
    }
    Ok(Response::empty()?.with_status(204).with_headers(headers))
}

fn response_headers(correlation: &str, env: &Env) -> Result<Headers> {
    let headers = Headers::new();
    headers.set("cache-control", "no-store")?;
    headers.set("x-content-type-options", "nosniff")?;
    headers.set("x-moesegfault-correlation-id", correlation)?;
    headers.set("access-control-allow-origin", &guard::login_origin(env))?;
    headers.set("access-control-allow-credentials", "true")?;
    headers.set("vary", "Origin")?;
    Ok(headers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_passkey_rejects_old_federated_and_future_sessions() {
        let session = |method: &str, authenticated_at| repository::AccountSession {
            session_id: "session".into(),
            principal_id: "principal".into(),
            authenticator_id: Some("authenticator".into()),
            auth_method: method.into(),
            authenticated_at,
        };
        assert!(recent_passkey(&session("passkey", 700), 1_000));
        assert!(!recent_passkey(&session("passkey", 699), 1_000));
        assert!(!recent_passkey(&session("federated", 1_000), 1_000));
        assert!(!recent_passkey(&session("passkey", 1_001), 1_000));
    }

    #[test]
    fn recovery_material_contains_no_plaintext_in_persistence_rows() {
        let (codes, rows) = new_recovery_codes(b"purpose-separated pepper", 8, 1_700_000_000_000);
        assert_eq!(codes.len(), 8);
        for (wire, row) in codes.iter().zip(rows) {
            let (_, secret) = wire.split_once('.').expect("wire format");
            assert!(!row.recovery_code_id.contains(secret));
            assert!(!row.public_id.contains(secret));
            assert_eq!(
                row.secret_digest,
                SecretDigest::hmac(b"purpose-separated pepper", secret.as_bytes()).0
            );
        }
    }

    #[test]
    fn wire_models_convert_unix_time_and_drop_private_avatar_key() {
        let wire = account_to_wire(repository::AccountView {
            principal_id: "p".into(),
            lifecycle_state: "active".into(),
            display_name: "Klee".into(),
            avatar_r2_key: Some("private/r2/key".into()),
            locale: "zh-CN".into(),
            identifiers: vec![],
            created_at: 1_700_000_000,
            updated_at: 1_700_000_001,
        });
        let json = serde_json::to_value(wire).expect("serialize");
        assert_eq!(json["profile"]["avatar_url"], serde_json::Value::Null);
        assert_eq!(json["created_at"], "2023-11-14T22:13:20Z");
        assert!(!json.to_string().contains("private/r2/key"));
    }

    #[test]
    fn addition_transports_are_stable_and_unique() {
        let mut transports = vec![
            "internal".to_owned(),
            "hybrid".to_owned(),
            "internal".to_owned(),
        ];
        canonicalize_transports(&mut transports);
        assert_eq!(transports, ["hybrid", "internal"]);
    }
}
