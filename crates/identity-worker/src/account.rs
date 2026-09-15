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
    normalize_email, normalize_mobile, normalize_username,
};
use imagesize::{Compression, ImageType};
use passkey_auth::{Attachment, CredentialId, RegistrationResponse, RegistrationState, Webauthn};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use worker::wasm_bindgen::JsValue;
use worker::*;

use crate::{account_repository as repository, ceremony_state, guard, problem};

const RP_NAME: &str = "moeSegFault";
const MAX_JSON_BYTES: u64 = 64 * 1024;
const MAX_AVATAR_BYTES: usize = 10 * 1024 * 1024;
// Multipart headers and the boundary are bounded separately from the file payload.
// multipart 头与 boundary 的额度独立于文件载荷，避免 Content-Length 绕过内存边界。
const MAX_AVATAR_REQUEST_BYTES: u64 = MAX_AVATAR_BYTES as u64 + 64 * 1024;
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
struct AvatarWire {
    avatar_id: String,
    url: String,
    media_type: String,
    width: usize,
    height: usize,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct CurrentAvatarRow {
    r2_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AvatarImage {
    media_type: &'static str,
    extension: &'static str,
    width: usize,
    height: usize,
}

#[derive(Debug, Serialize)]
struct IdentifierWire {
    identifier_id: String,
    kind: String,
    value: String,
    country_calling_code: Option<String>,
    national_number: Option<String>,
    is_primary: bool,
    verification_state: String,
    verified_at: Option<String>,
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
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ContactInput {
    Email {
        email: String,
        #[serde(default)]
        is_primary: bool,
    },
    Mobile {
        mobile: ContactMobileInput,
        #[serde(default)]
        is_primary: bool,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContactMobileInput {
    country_calling_code: String,
    national_number: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContactPatch {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    mobile: Option<ContactMobileInput>,
    #[serde(default)]
    is_primary: Option<bool>,
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PasswordChangeRequest {
    #[serde(default)]
    current_password: Option<String>,
    new_password: String,
}

#[derive(Debug, Deserialize)]
struct PasswordCredentialRow {
    password_hash: String,
    password_version: i64,
}

#[derive(Debug, Deserialize)]
struct SecurityPostureRow {
    password_count: i64,
    passkey_count: i64,
    verified_email_count: i64,
    verified_mobile_count: i64,
}

#[derive(Debug, Deserialize)]
struct MfaKindRow {
    kind: String,
}

#[derive(Debug, Deserialize)]
struct PreferencesRow {
    locale: String,
    theme: String,
    timezone: String,
    reduced_motion: i64,
    compact_mode: i64,
    notification_preferences_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreferencesPatch {
    #[serde(default)]
    locale: Option<String>,
    #[serde(default)]
    theme: Option<String>,
    #[serde(default)]
    timezone: Option<String>,
    #[serde(default)]
    reduced_motion: Option<bool>,
    #[serde(default)]
    compact_mode: Option<bool>,
    #[serde(default)]
    notifications: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VerificationCompletionRequest {
    code: String,
}

#[derive(Debug, Deserialize)]
struct VerificationRow {
    code_digest: Vec<u8>,
    state: String,
    expires_at: i64,
}

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
    MultipartAvatar,
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
    let public_origin = avatar_public_origin(&context.env)?;
    json(
        &serde_json::json!({
            "account": account_to_wire(account, &public_origin),
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
    let public_origin = avatar_public_origin(&context.env)?;
    json(
        &account_to_wire(account, &public_origin),
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

/// 列出可验证的 email/mobile 联系渠道。/ Lists verifiable email/mobile contact channels.
pub async fn list_contacts(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(session) = authenticate(&request, &context.env).await? else {
        return authentication_required(&correlation);
    };
    let items = repository::identifiers(&context.d1("DB")?, &session.principal_id)
        .await?
        .into_iter()
        .filter(|item| matches!(item.kind.as_str(), "email" | "mobile"))
        .map(identifier_to_wire)
        .collect::<Vec<_>>();
    json(&items, 200, &correlation, &context.env, None)
}

/// 添加 email 或 mobile，初始状态为未验证。/ Adds an email or mobile in the unverified state.
pub async fn create_contact(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::Json, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    let input: ContactInput = match request.json().await {
        Ok(input) => input,
        Err(_) => return invalid_request("Invalid JSON request", &correlation),
    };
    let (kind, value, normalized, calling_code, national_number, _requested_primary) = match input {
        ContactInput::Email { email, is_primary } => match normalize_email(&email) {
            Ok(normalized) => (
                "email",
                email.trim().to_owned(),
                normalized,
                None,
                None,
                is_primary,
            ),
            Err(_) => return invalid_request("Invalid email address", &correlation),
        },
        ContactInput::Mobile { mobile, is_primary } => {
            let normalized =
                match normalize_mobile(&mobile.country_calling_code, &mobile.national_number) {
                    Ok(value) => value,
                    Err(_) => return invalid_request("Invalid mobile number", &correlation),
                };
            (
                "mobile",
                normalized.clone(),
                normalized,
                Some(mobile.country_calling_code),
                Some(mobile.national_number),
                is_primary,
            )
        }
    };
    let id = IdentifierId::new_v7(worker::Date::now().as_millis()).to_string();
    let result = repository::create_contact(
        &context.d1("DB")?,
        &session.principal_id,
        &id,
        kind,
        &value,
        &normalized,
        calling_code.as_deref(),
        national_number.as_deref(),
        _requested_primary,
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

/// 幂等删除当前账户拥有的联系渠道。/ Idempotently deletes a contact channel owned by this account.
pub async fn delete_contact(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::None, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    if let Some(id) = path_uuid_v7(&context, "contact_id") {
        repository::delete_contact(
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

/// 更新联系方式值或原子切换同类主联系方式。/ Updates a contact value or atomically promotes it within its kind.
pub async fn update_contact(mut request: Request, context: RouteContext<()>) -> Result<Response> {
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
    let Some(contact_id) = path_uuid_v7(&context, "contact_id") else {
        return not_found("Contact was not found", &correlation);
    };
    let input: ContactPatch = match request.json().await {
        Ok(input) => input,
        Err(_) => return invalid_request("Invalid JSON request", &correlation),
    };
    let db = context.d1("DB")?;
    let Some(current) = repository::identifiers(&db, &session.principal_id)
        .await?
        .into_iter()
        .find(|item| {
            item.identifier_id == contact_id && matches!(item.kind.as_str(), "email" | "mobile")
        })
    else {
        return not_found("Contact was not found", &correlation);
    };
    let replacement = match current.kind.as_str() {
        "email" if input.mobile.is_some() => {
            return invalid_request("Contact value does not match its kind", &correlation);
        }
        "email" => input
            .email
            .as_deref()
            .map(|email| {
                normalize_email(email)
                    .map(|normalized| (email.trim().to_owned(), normalized, None, None))
            })
            .transpose()
            .map_err(|_| Error::RustError("invalid email".into())),
        "mobile" if input.email.is_some() => {
            return invalid_request("Contact value does not match its kind", &correlation);
        }
        "mobile" => input
            .mobile
            .as_ref()
            .map(|mobile| {
                normalize_mobile(&mobile.country_calling_code, &mobile.national_number).map(
                    |normalized| {
                        (
                            normalized.clone(),
                            normalized,
                            Some(mobile.country_calling_code.clone()),
                            Some(mobile.national_number.clone()),
                        )
                    },
                )
            })
            .transpose()
            .map_err(|_| Error::RustError("invalid mobile".into())),
        _ => unreachable!(),
    };
    let replacement = match replacement {
        Ok(value) => value,
        Err(_) => return invalid_request("Invalid contact value", &correlation),
    };
    if replacement.is_none() && input.is_primary.is_none() {
        return invalid_request("At least one contact field is required", &correlation);
    }
    let now = now_seconds();
    let primary = input.is_primary.unwrap_or(current.is_primary);
    let current_normalized = if current.kind == "email" {
        normalize_email(&current.value).unwrap_or_else(|_| current.value.clone())
    } else {
        current.value.clone()
    };
    let (value, normalized, calling_code, national_number) = replacement.unwrap_or((
        current.value.clone(),
        current_normalized,
        current.country_calling_code.clone(),
        current.national_number.clone(),
    ));
    db.batch(vec![
        db.prepare("UPDATE identifiers SET is_primary=0,updated_at=?4 WHERE principal_id=?1 AND kind=?2 AND identifier_id<>?3 AND ?5=1").bind(&[JsValue::from_str(&session.principal_id),JsValue::from_str(&current.kind),JsValue::from_str(contact_id),JsValue::from_f64(now as f64),JsValue::from_f64(i64::from(primary) as f64)])?,
        db.prepare("UPDATE identifiers SET value=?3,normalized_value=?4,country_calling_code=?5,national_number=?6,is_primary=?7,verification_state=CASE WHEN normalized_value<>?4 THEN 'unverified' ELSE verification_state END,verified_at=CASE WHEN normalized_value<>?4 THEN NULL ELSE verified_at END,updated_at=?8 WHERE identifier_id=?1 AND principal_id=?2").bind(&[JsValue::from_str(contact_id),JsValue::from_str(&session.principal_id),JsValue::from_str(&value),JsValue::from_str(&normalized),optional_js_text(calling_code.as_deref()),optional_js_text(national_number.as_deref()),JsValue::from_f64(i64::from(primary) as f64),JsValue::from_f64(now as f64)])?,
    ]).await?;
    let item = repository::identifiers(&db, &session.principal_id)
        .await?
        .into_iter()
        .find(|item| item.identifier_id == contact_id)
        .ok_or_else(|| Error::RustError("updated contact projection missing".into()))?;
    json(
        &identifier_to_wire(item),
        200,
        &correlation,
        &context.env,
        None,
    )
}

/// 返回不含秘密材料的认证与恢复能力概览。/ Returns an authentication and recovery posture without secret material.
pub async fn security_posture(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(session) = authenticate(&request, &context.env).await? else {
        return authentication_required(&correlation);
    };
    let row = context.d1("DB")?.prepare(
        "SELECT (SELECT count(*) FROM password_credentials WHERE principal_id=?1) AS password_count,(SELECT count(*) FROM authenticators WHERE principal_id=?1 AND revoked_at IS NULL) AS passkey_count,(SELECT count(*) FROM identifiers WHERE principal_id=?1 AND kind='email' AND verification_state='verified') AS verified_email_count,(SELECT count(*) FROM identifiers WHERE principal_id=?1 AND kind='mobile' AND verification_state='verified') AS verified_mobile_count"
    ).bind(&[JsValue::from_str(&session.principal_id)])?.first::<SecurityPostureRow>(None).await?
        .ok_or_else(|| Error::RustError("security posture projection missing".into()))?;
    let mfa_methods = context.d1("DB")?.prepare("SELECT DISTINCT kind FROM mfa_methods WHERE principal_id=?1 AND state='active' ORDER BY kind")
        .bind(&[JsValue::from_str(&session.principal_id)])?.all().await?.results::<MfaKindRow>()?
        .into_iter().map(|item| item.kind).collect::<Vec<_>>();
    let recovery_ready = row.verified_email_count + row.verified_mobile_count > 0;
    let mut recommendations = Vec::new();
    if row.verified_email_count == 0 {
        recommendations.push("verify_email");
    }
    if row.passkey_count == 0 {
        recommendations.push("add_passkey");
    }
    if mfa_methods.is_empty() {
        recommendations.push("add_second_factor");
    }
    json(
        &serde_json::json!({
            "password":row.password_count > 0,
            "passkey_count":row.passkey_count,
            "mfa_methods":mfa_methods,
            "verified_email_count":row.verified_email_count,
            "verified_mobile_count":row.verified_mobile_count,
            "recovery_ready":recovery_ready,
            "recommendations":recommendations,
        }),
        200,
        &correlation,
        &context.env,
        None,
    )
}

/// 读取 account 应用的展示偏好。/ Reads account-application presentation preferences.
pub async fn get_preferences(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(session) = authenticate(&request, &context.env).await? else {
        return authentication_required(&correlation);
    };
    let row = read_preferences(&context.d1("DB")?, &session.principal_id)
        .await?
        .ok_or_else(|| Error::RustError("account preferences are missing".into()))?;
    preferences_json(row, &correlation, &context.env)
}

/// 使用严格 Merge Patch 更新 i18n、主题与无障碍偏好。
/// Updates i18n, theme, and accessibility preferences using a strict merge patch.
pub async fn update_preferences(
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
    let input: PreferencesPatch = match request.json().await {
        Ok(input) => input,
        Err(_) => return invalid_request("Invalid JSON request", &correlation),
    };
    if input
        .locale
        .as_deref()
        .is_some_and(|v| !(2..=35).contains(&v.len()))
        || input
            .theme
            .as_deref()
            .is_some_and(|v| !matches!(v, "system" | "light" | "dark"))
        || input
            .timezone
            .as_deref()
            .is_some_and(|v| v.is_empty() || v.len() > 64)
        || input
            .notifications
            .as_ref()
            .is_some_and(|values| values.values().any(|v| !v.is_boolean()))
    {
        return invalid_request("Invalid account preferences", &correlation);
    }
    let notifications = input
        .notifications
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let now = now_seconds();
    context.d1("DB")?.prepare("UPDATE account_preferences SET locale=COALESCE(?2,locale),theme=COALESCE(?3,theme),timezone=COALESCE(?4,timezone),reduced_motion=COALESCE(?5,reduced_motion),compact_mode=COALESCE(?6,compact_mode),notification_preferences_json=COALESCE(?7,notification_preferences_json),updated_at=?8 WHERE principal_id=?1")
        .bind(&[JsValue::from_str(&session.principal_id),optional_js_text(input.locale.as_deref()),optional_js_text(input.theme.as_deref()),optional_js_text(input.timezone.as_deref()),optional_js_bool(input.reduced_motion),optional_js_bool(input.compact_mode),optional_js_text(notifications.as_deref()),JsValue::from_f64(now as f64)])?.run().await?;
    let row = read_preferences(&context.d1("DB")?, &session.principal_id)
        .await?
        .ok_or_else(|| Error::RustError("account preferences are missing".into()))?;
    preferences_json(row, &correlation, &context.env)
}

/// 请求联系方式验证码；未配置投递适配器时明确报告不可用。
/// Requests contact verification; explicitly reports unavailable when no delivery adapter exists.
pub async fn start_contact_verification(
    request: Request,
    context: RouteContext<()>,
) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::None, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    let Some(contact_id) = path_uuid_v7(&context, "contact_id") else {
        return not_found("Contact was not found", &correlation);
    };
    let owned = context.d1("DB")?.prepare("SELECT identifier_id FROM identifiers WHERE identifier_id=?1 AND principal_id=?2 AND kind IN ('email','mobile')")
        .bind(&[JsValue::from_str(contact_id),JsValue::from_str(&session.principal_id)])?.first::<IdentifierIdRow>(None).await?.is_some();
    if !owned {
        return not_found("Contact was not found", &correlation);
    }
    problem::response(
        "delivery_unavailable",
        "Contact verification delivery is not configured",
        503,
        &correlation,
    )
}

/// 原子完成已有联系方式验证事务。/ Atomically completes an existing contact-verification transaction.
pub async fn complete_contact_verification(
    mut request: Request,
    context: RouteContext<()>,
) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::Json, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    let (Some(contact_id), Some(transaction_id)) = (
        path_uuid_v7(&context, "contact_id"),
        path_uuid_v7(&context, "transaction_id"),
    ) else {
        return not_found("Verification transaction was not found", &correlation);
    };
    let input: VerificationCompletionRequest =
        match request.json::<VerificationCompletionRequest>().await {
            Ok(input)
                if (4..=12).contains(&input.code.len())
                    && input.code.bytes().all(|b| b.is_ascii_alphanumeric()) =>
            {
                input
            }
            _ => return invalid_request("Invalid verification code", &correlation),
        };
    let db = context.d1("DB")?;
    let Some(row) = db.prepare("SELECT t.code_digest,t.state,t.expires_at FROM identifier_verification_transactions t JOIN identifiers i ON i.identifier_id=t.identifier_id WHERE t.transaction_id=?1 AND t.identifier_id=?2 AND i.principal_id=?3")
        .bind(&[JsValue::from_str(transaction_id),JsValue::from_str(contact_id),JsValue::from_str(&session.principal_id)])?.first::<VerificationRow>(None).await? else {
        return not_found("Verification transaction was not found", &correlation);
    };
    let now = now_seconds();
    if row.state != "pending" || row.expires_at <= now {
        return problem::response(
            "transaction_expired",
            "Verification transaction is no longer active",
            410,
            &correlation,
        );
    }
    let presented = SecretDigest::hmac(
        secret(&context.env, "CONTACT_VERIFICATION_PEPPER")?.as_bytes(),
        input.code.as_bytes(),
    );
    let expected = row.code_digest.as_slice().try_into().ok().map(SecretDigest);
    if !expected.is_some_and(|value| value.ct_eq(&presented)) {
        db.prepare("UPDATE identifier_verification_transactions SET attempt_count=attempt_count+1,state=CASE WHEN attempt_count>=9 THEN 'locked' ELSE state END,consumed_at=CASE WHEN attempt_count>=9 THEN ?2 ELSE NULL END WHERE transaction_id=?1 AND state='pending'")
            .bind(&[JsValue::from_str(transaction_id),JsValue::from_f64(now as f64)])?.run().await?;
        return problem::response(
            "invalid_verification_code",
            "Invalid verification code",
            400,
            &correlation,
        );
    }
    db.batch(vec![
        db.prepare("UPDATE identifier_verification_transactions SET state='verified',consumed_at=?2 WHERE transaction_id=?1 AND state='pending' AND expires_at>?2").bind(&[JsValue::from_str(transaction_id),JsValue::from_f64(now as f64)])?,
        db.prepare("UPDATE identifiers SET verification_state='verified',verified_at=?2,updated_at=?2 WHERE identifier_id=?1 AND principal_id=?3 AND EXISTS(SELECT 1 FROM identifier_verification_transactions WHERE transaction_id=?4 AND identifier_id=?1 AND state='verified')").bind(&[JsValue::from_str(contact_id),JsValue::from_f64(now as f64),JsValue::from_str(&session.principal_id),JsValue::from_str(transaction_id)])?,
    ]).await?;
    let item = repository::identifiers(&db, &session.principal_id)
        .await?
        .into_iter()
        .find(|item| item.identifier_id == contact_id)
        .ok_or_else(|| Error::RustError("verified contact projection missing".into()))?;
    json(
        &identifier_to_wire(item),
        200,
        &correlation,
        &context.env,
        None,
    )
}

/// 验证并把当前账户的头像作为不可变对象写入 R2。
/// Validates and stores the current account's avatar as an immutable R2 object.
///
/// R2 与 D1 不共享事务：先写新对象，再用一个 D1 batch 原子切换 current pointer；
/// D1 失败时立即补偿删除新对象。被替换对象先在 D1 标记 deleted，再尽力删除；删除
/// 失败的行会保留，供后续上传/删除重试以及运维 reaper 扫描。
/// R2 and D1 do not share a transaction. The new object is written first, then one
/// D1 batch atomically switches the current pointer. A failed D1 batch triggers an
/// immediate compensating delete. Replaced rows remain `deleted` when best-effort
/// deletion fails, making lifecycle cleanup observable and retryable.
pub async fn upload_avatar(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let session = match mutation_session(
        &request,
        &context.env,
        MutationBody::MultipartAvatar,
        &correlation,
    )
    .await?
    {
        Ok(session) => session,
        Err(response) => return Ok(response),
    };
    let form = match request.form_data().await {
        Ok(form) => form,
        Err(_) => return invalid_request("Invalid multipart form data", &correlation),
    };
    let Some(FormEntry::File(file)) = form.get("avatar") else {
        return invalid_request("A single avatar file is required", &correlation);
    };
    if file.size() == 0 || file.size() > MAX_AVATAR_BYTES {
        return problem::response(
            "invalid_request",
            "Avatar must be between 1 byte and 10 MiB",
            413,
            &correlation,
        );
    }
    let bytes = file.bytes().await?;
    if bytes.len() != file.size() || bytes.len() > MAX_AVATAR_BYTES {
        return problem::response(
            "invalid_request",
            "Avatar must be between 1 byte and 10 MiB",
            413,
            &correlation,
        );
    }
    let image = match validate_avatar(&bytes, &file.type_()) {
        Ok(image) => image,
        Err(title) => return invalid_request(title, &correlation),
    };

    let now = now_seconds();
    let avatar_id = uuid::Uuid::now_v7().to_string();
    let r2_key = format!(
        "avatars/{}/{}.{}",
        session.principal_id, avatar_id, image.extension
    );
    let digest = Sha256::digest(&bytes);
    let bucket = context.bucket("AVATARS")?;
    let metadata = HttpMetadata {
        content_type: Some(image.media_type.to_owned()),
        cache_control: Some("public, max-age=31536000, immutable".to_owned()),
        content_disposition: Some("inline".to_owned()),
        ..HttpMetadata::default()
    };
    let mut custom_metadata = std::collections::HashMap::new();
    custom_metadata.insert("avatar_id".to_owned(), avatar_id.clone());
    custom_metadata.insert("principal_id".to_owned(), session.principal_id.clone());
    let stored = bucket
        .put(&r2_key, bytes)
        .http_metadata(metadata)
        .custom_metadata(custom_metadata)
        .sha256(digest.to_vec())
        .only_if(Conditional {
            etag_does_not_match: Some("*".to_owned()),
            ..Conditional::default()
        })
        .execute()
        .await?;
    if stored.is_none() {
        return Err(Error::RustError(
            "generated avatar object key unexpectedly exists".into(),
        ));
    }

    let db = context.d1("DB")?;
    let old = db
        .prepare("SELECT r2_key FROM avatar_assets WHERE principal_id=?1 AND is_current=1")
        .bind(&[JsValue::from_str(&session.principal_id)])?
        .first::<CurrentAvatarRow>(None)
        .await?;
    let batch = db.batch(vec![
        db.prepare("UPDATE avatar_assets SET state='deleted',is_current=0,updated_at=?2 WHERE principal_id=?1 AND is_current=1")
            .bind(&[JsValue::from_str(&session.principal_id), JsValue::from_f64(now as f64)])?,
        db.prepare("INSERT INTO avatar_assets(avatar_id,principal_id,r2_key,media_type,byte_size,width,height,content_digest,state,is_current,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'ready',1,?9,?9)")
            .bind(&[
                JsValue::from_str(&avatar_id), JsValue::from_str(&session.principal_id),
                JsValue::from_str(&r2_key), JsValue::from_str(image.media_type),
                JsValue::from_f64(file.size() as f64), JsValue::from_f64(image.width as f64),
                JsValue::from_f64(image.height as f64), worker::js_sys::Uint8Array::from(&digest[..]).into(),
                JsValue::from_f64(now as f64),
            ])?,
        db.prepare("UPDATE human_profiles SET avatar_r2_key=?2,updated_at=?3 WHERE principal_id=?1")
            .bind(&[JsValue::from_str(&session.principal_id), JsValue::from_str(&r2_key), JsValue::from_f64(now as f64)])?,
    ]).await;
    if let Err(error) = batch {
        if let Err(cleanup_error) = bucket.delete(&r2_key).await {
            console_error!(
                "avatar_compensation_failed avatar_id={avatar_id} correlation_id={correlation} error={cleanup_error}"
            );
        }
        return Err(error);
    }
    if let Some(old) = old
        && let Err(error) = bucket.delete(&old.r2_key).await
    {
        console_error!(
            "avatar_old_object_cleanup_failed avatar_id={avatar_id} correlation_id={correlation} old_key={} error={error}",
            old.r2_key
        );
    }

    let public_origin = avatar_public_origin(&context.env)?;
    json(
        &AvatarWire {
            avatar_id,
            url: format!("{public_origin}/{r2_key}"),
            media_type: image.media_type.to_owned(),
            width: image.width,
            height: image.height,
            updated_at: date_time(now),
        },
        201,
        &correlation,
        &context.env,
        None,
    )
}

/// 移除当前头像元数据；不可变 R2 对象由归档生命周期异步回收。
/// Removes current-avatar metadata; immutable R2 objects are reclaimed asynchronously.
pub async fn delete_avatar(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::None, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    let now = now_seconds();
    let db = context.d1("DB")?;
    let old = db
        .prepare("SELECT r2_key FROM avatar_assets WHERE principal_id=?1 AND is_current=1")
        .bind(&[JsValue::from_str(&session.principal_id)])?
        .first::<CurrentAvatarRow>(None)
        .await?;
    db.batch(vec![
        db.prepare("UPDATE avatar_assets SET state='deleted',is_current=0,updated_at=?2 WHERE principal_id=?1 AND is_current=1").bind(&[JsValue::from_str(&session.principal_id),JsValue::from_f64(now as f64)])?,
        db.prepare("UPDATE human_profiles SET avatar_r2_key=NULL,updated_at=?2 WHERE principal_id=?1").bind(&[JsValue::from_str(&session.principal_id),JsValue::from_f64(now as f64)])?,
    ]).await?;
    if let Some(old) = old
        && let Err(error) = context.bucket("AVATARS")?.delete(&old.r2_key).await
    {
        // Metadata is already retired, so object-store cleanup must never break account UX.
        // 元数据已退役，因此对象存储清理失败绝不能破坏账户管理体验。
        console_error!(
            "avatar_delete_cleanup_failed correlation_id={correlation} old_key={} error={error}",
            old.r2_key
        );
    }
    no_content(&correlation, &context.env, None)
}

#[derive(Debug, Deserialize)]
struct IdentifierIdRow {
    #[allow(dead_code)]
    identifier_id: String,
}

async fn read_preferences(db: &D1Database, principal_id: &str) -> Result<Option<PreferencesRow>> {
    db.prepare("SELECT locale,theme,timezone,reduced_motion,compact_mode,notification_preferences_json FROM account_preferences WHERE principal_id=?1")
        .bind(&[JsValue::from_str(principal_id)])?.first(None).await
}

fn preferences_json(row: PreferencesRow, correlation: &str, env: &Env) -> Result<Response> {
    let notifications: serde_json::Value = serde_json::from_str(&row.notification_preferences_json)
        .map_err(|error| {
            Error::RustError(format!("invalid stored notification preferences: {error}"))
        })?;
    json(
        &serde_json::json!({"locale":row.locale,"theme":row.theme,"timezone":row.timezone,"reduced_motion":row.reduced_motion != 0,"compact_mode":row.compact_mode != 0,"notifications":notifications}),
        200,
        correlation,
        env,
        None,
    )
}

fn optional_js_text(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from_str)
}
fn optional_js_bool(value: Option<bool>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from_bool)
}

/// 创建或轮换可选密码；已有密码必须提交当前密码。/ Creates or rotates the optional password; an existing password requires the current password.
pub async fn put_password(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::Json, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    let input: PasswordChangeRequest = match request.json().await {
        Ok(input) => input,
        Err(_) => return invalid_request("Invalid JSON request", &correlation),
    };
    if identity_domain::validate_password(&input.new_password).is_err() {
        return invalid_request("Password must contain 12 to 128 characters", &correlation);
    }
    let db = context.d1("DB")?;
    let existing = db
        .prepare(
            "SELECT password_hash,password_version FROM password_credentials WHERE principal_id=?1",
        )
        .bind(&[JsValue::from_str(&session.principal_id)])?
        .first::<PasswordCredentialRow>(None)
        .await?;
    if let Some(existing) = existing.as_ref()
        && !input
            .current_password
            .as_deref()
            .is_some_and(|value| crate::password::verify_password(value, &existing.password_hash))
    {
        return problem::response(
            "reauthentication_required",
            "Current password is required",
            403,
            &correlation,
        );
    }
    let hash = crate::password::hash_password(&input.new_password)?;
    let now = now_seconds();
    let version = existing.as_ref().map_or(1, |row| row.password_version + 1);
    db.prepare("INSERT INTO password_credentials(principal_id,password_hash,hash_algorithm,hash_parameters_json,password_version,created_at,updated_at) VALUES(?1,?2,'argon2id','{}',?3,?4,?4) ON CONFLICT(principal_id) DO UPDATE SET password_hash=excluded.password_hash,hash_algorithm='argon2id',hash_parameters_json='{}',password_version=excluded.password_version,updated_at=excluded.updated_at,last_used_at=NULL")
        .bind(&[JsValue::from_str(&session.principal_id),JsValue::from_str(&hash),JsValue::from_f64(version as f64),JsValue::from_f64(now as f64)])?.run().await?;
    no_content(&correlation, &context.env, None)
}

/// 删除密码前确认当前密码且确保仍有其他登录方法。/ Removes a password after checking it and ensuring another login method remains.
pub async fn delete_password(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::None, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    let db = context.d1("DB")?;
    let Some(_existing) = db
        .prepare(
            "SELECT password_hash,password_version FROM password_credentials WHERE principal_id=?1",
        )
        .bind(&[JsValue::from_str(&session.principal_id)])?
        .first::<PasswordCredentialRow>(None)
        .await?
    else {
        return no_content(&correlation, &context.env, None);
    };
    let now = now_seconds();
    let recent = session.authenticated_at <= now
        && now - session.authenticated_at
            <= LifetimePolicy::default().recent_authentication_seconds as i64
        && matches!(session.auth_method.as_str(), "password" | "passkey");
    if !recent {
        return problem::response(
            "reauthentication_required",
            "Recent authentication is required",
            403,
            &correlation,
        );
    }
    let alternatives = db.prepare("SELECT (SELECT count(*) FROM authenticators WHERE principal_id=?1 AND revoked_at IS NULL)+(SELECT count(*) FROM identity_bindings WHERE principal_id=?1 AND revoked_at IS NULL AND authentication_enabled=1) AS count")
        .bind(&[JsValue::from_str(&session.principal_id)])?.first::<CountRow>(None).await?.map_or(0, |row| row.count);
    if alternatives == 0 {
        return problem::response(
            "last_authentication_method",
            "Add a passkey or connected login before removing the password",
            409,
            &correlation,
        );
    }
    db.prepare("DELETE FROM password_credentials WHERE principal_id=?1")
        .bind(&[JsValue::from_str(&session.principal_id)])?
        .run()
        .await?;
    no_content(&correlation, &context.env, None)
}

#[derive(Debug, Deserialize)]
struct CountRow {
    count: i64,
}

#[derive(Debug, Deserialize, Serialize)]
struct AuthorizationGrantRow {
    authorization_id: String,
    client_id: String,
    display_name: String,
    logo_url: Option<String>,
    scopes_json: String,
    granted_at: i64,
    last_used_at: Option<i64>,
}

/// 按 OAuth client 汇总仍可续期的授权。/ Lists renewable authorizations aggregated by OAuth client.
pub async fn list_authorizations(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(session) = authenticate(&request, &context.env).await? else {
        return authentication_required(&correlation);
    };
    let rows = context.d1("DB")?.prepare("SELECT a.authorization_id,a.client_id,c.display_name,p.logo_url,a.scopes_json,a.granted_at,a.last_used_at FROM oauth_user_authorizations a JOIN oauth_clients c ON c.client_id=a.client_id LEFT JOIN oauth_client_presentation p ON p.client_id=a.client_id WHERE a.principal_id=?1 AND a.revoked_at IS NULL ORDER BY COALESCE(a.last_used_at,a.granted_at) DESC")
        .bind(&[JsValue::from_str(&session.principal_id)])?.all().await?.results::<AuthorizationGrantRow>()?;
    let items = rows.into_iter().map(|row| -> Result<_> {
        let scopes: serde_json::Value = serde_json::from_str(&row.scopes_json).map_err(|error| Error::RustError(format!("invalid stored authorization scopes: {error}")))?;
        Ok(serde_json::json!({"authorization_id":row.authorization_id,"client_id":row.client_id,"display_name":row.display_name,"logo_url":row.logo_url,"scopes":scopes,"granted_at":date_time(row.granted_at),"last_used_at":row.last_used_at.map(date_time)}))
    }).collect::<Result<Vec<_>>>()?;
    json(
        &serde_json::json!({"items":items}),
        200,
        &correlation,
        &context.env,
        None,
    )
}

/// 撤销某 OAuth client 的全部代码和 refresh-token family。/ Revokes every code and refresh-token family for an OAuth client.
pub async fn revoke_authorization(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let session =
        match mutation_session(&request, &context.env, MutationBody::None, &correlation).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
    let Some(authorization_id) = context.param("authorization_id") else {
        return not_found("Authorization was not found", &correlation);
    };
    let now = now_seconds();
    let db = context.d1("DB")?;
    let Some(grant) = db.prepare("SELECT client_id FROM oauth_user_authorizations WHERE authorization_id=?1 AND principal_id=?2 AND revoked_at IS NULL").bind(&[JsValue::from_str(authorization_id),JsValue::from_str(&session.principal_id)])?.first::<AuthorizationClientRow>(None).await? else {
        return no_content(&correlation, &context.env, None);
    };
    db.batch(vec![
        db.prepare("UPDATE oauth_user_authorizations SET revoked_at=?3,revocation_reason='account_revoked',updated_at=?3 WHERE authorization_id=?1 AND principal_id=?2 AND revoked_at IS NULL").bind(&[JsValue::from_str(authorization_id),JsValue::from_str(&session.principal_id),JsValue::from_f64(now as f64)])?,
        db.prepare("UPDATE oauth_refresh_token_families SET revoked_at=?3,revocation_reason='account_revoked' WHERE principal_id=?1 AND client_id=?2 AND revoked_at IS NULL").bind(&[JsValue::from_str(&session.principal_id),JsValue::from_str(&grant.client_id),JsValue::from_f64(now as f64)])?,
        db.prepare("UPDATE oauth_authorization_codes SET revoked_at=?3 WHERE principal_id=?1 AND client_id=?2 AND revoked_at IS NULL").bind(&[JsValue::from_str(&session.principal_id),JsValue::from_str(&grant.client_id),JsValue::from_f64(now as f64)])?,
    ]).await?;
    no_content(&correlation, &context.env, None)
}

#[derive(Debug, Deserialize)]
struct AuthorizationClientRow {
    client_id: String,
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
    let initial_enrollment = identity.credential_ids.is_empty();
    let recently_authenticated = if initial_enrollment {
        recent_enrollment_session(&session, now_seconds())
    } else {
        recent_passkey(&session, now_seconds())
    };
    if !recently_authenticated {
        return reauthentication_required(&correlation);
    }
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
    let public_origin = avatar_public_origin(&context.env)?;
    json(
        &serde_json::json!({
            "account": account_to_wire(account, &public_origin),
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
    if !recent_enrollment_session(&session, now_seconds()) {
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
    let maximum_body_bytes = match body {
        MutationBody::MultipartAvatar => MAX_AVATAR_REQUEST_BYTES,
        _ => MAX_JSON_BYTES,
    };
    if guard::header(request.headers(), "content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > maximum_body_bytes)
    {
        return problem::response(
            "invalid_request",
            "Request body is too large",
            413,
            correlation,
        )
        .map(Some);
    }
    if guard::allowed_origin(env, guard::header(request.headers(), "origin").as_deref()).is_none() {
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
        MutationBody::MultipartAvatar => Some("multipart/form-data"),
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

/// 从真实文件签名读取受支持媒体类型和尺寸，而不信任浏览器声明。
/// Reads the supported media type and dimensions from actual file signatures rather
/// than trusting browser-provided metadata.
fn validate_avatar(
    bytes: &[u8],
    declared_media_type: &str,
) -> std::result::Result<AvatarImage, &'static str> {
    let image_type =
        imagesize::image_type(bytes).map_err(|_| "Unsupported or malformed avatar image")?;
    let (media_type, extension) = match image_type {
        ImageType::Heif(Compression::Av1) => ("image/avif", "avif"),
        ImageType::Jpeg => ("image/jpeg", "jpg"),
        ImageType::Png => ("image/png", "png"),
        ImageType::Webp => ("image/webp", "webp"),
        _ => return Err("Avatar must be AVIF, JPEG, PNG, or WebP"),
    };
    if !declared_media_type.is_empty() && !declared_media_type.eq_ignore_ascii_case(media_type) {
        return Err("Avatar media type does not match its contents");
    }
    let size = imagesize::blob_size(bytes).map_err(|_| "Unsupported or malformed avatar image")?;
    if !(1..=8192).contains(&size.width) || !(1..=8192).contains(&size.height) {
        return Err("Avatar dimensions must be between 1 and 8192 pixels");
    }
    if size.width != size.height {
        return Err("Avatar must be a square image");
    }
    Ok(AvatarImage {
        media_type,
        extension,
        width: size.width,
        height: size.height,
    })
}

/// 返回绑定到专用 R2 bucket 自定义域名的公开 origin。
/// Returns the public origin bound to the dedicated R2 bucket custom domain.
fn avatar_public_origin(env: &Env) -> Result<String> {
    let value = env.var("AVATAR_PUBLIC_ORIGIN")?.to_string();
    let parsed = url::Url::parse(&value)
        .map_err(|_| Error::BindingError("AVATAR_PUBLIC_ORIGIN must be an HTTPS origin".into()))?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(Error::BindingError(
            "AVATAR_PUBLIC_ORIGIN must be an HTTPS origin".into(),
        ));
    }
    Ok(value.trim_end_matches('/').to_owned())
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

/// 初次 Passkey 登记允许近期密码会话，后续登记仍要求 Passkey step-up。
/// Initial passkey enrollment accepts a recent password session; subsequent
/// enrollment still requires passkey step-up.
fn recent_enrollment_session(session: &repository::AccountSession, now: i64) -> bool {
    matches!(session.auth_method.as_str(), "password" | "passkey")
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

fn account_to_wire(value: repository::AccountView, avatar_public_origin: &str) -> AccountWire {
    let avatar_url = value
        .avatar_r2_key
        .map(|key| format!("{avatar_public_origin}/{key}"));
    AccountWire {
        principal_id: value.principal_id,
        lifecycle_state: value.lifecycle_state,
        profile: ProfileWire {
            display_name: value.display_name,
            avatar_url,
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
        country_calling_code: value.country_calling_code,
        national_number: value.national_number,
        is_primary: value.is_primary,
        verification_state: value.verification_state,
        verified_at: value.verified_at.map(date_time),
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
    fn initial_passkey_enrollment_accepts_only_recent_password_or_passkey() {
        let session = |method: &str, authenticated_at| repository::AccountSession {
            session_id: "session".into(),
            principal_id: "principal".into(),
            authenticator_id: None,
            auth_method: method.into(),
            authenticated_at,
        };
        assert!(recent_enrollment_session(&session("password", 700), 1_000));
        assert!(recent_enrollment_session(&session("passkey", 700), 1_000));
        assert!(!recent_enrollment_session(&session("password", 699), 1_000));
        assert!(!recent_enrollment_session(
            &session("federated", 1_000),
            1_000
        ));
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
    fn wire_models_convert_unix_time_and_publish_avatar_url() {
        let wire = account_to_wire(
            repository::AccountView {
                principal_id: "p".into(),
                lifecycle_state: "active".into(),
                display_name: "Klee".into(),
                avatar_r2_key: Some("avatars/id/avatar.png".into()),
                locale: "zh-CN".into(),
                identifiers: vec![],
                created_at: 1_700_000_000,
                updated_at: 1_700_000_001,
            },
            "https://avatars.moesegfault.dev",
        );
        let json = serde_json::to_value(wire).expect("serialize");
        assert_eq!(
            json["profile"]["avatar_url"],
            "https://avatars.moesegfault.dev/avatars/id/avatar.png"
        );
        assert_eq!(json["created_at"], "2023-11-14T22:13:20Z");
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

    #[test]
    fn avatar_validation_uses_magic_dimensions_and_declared_type() {
        let png = png_header(256, 256);
        assert_eq!(
            validate_avatar(&png, "image/png"),
            Ok(AvatarImage {
                media_type: "image/png",
                extension: "png",
                width: 256,
                height: 256,
            })
        );
        assert_eq!(
            validate_avatar(&png, "image/jpeg"),
            Err("Avatar media type does not match its contents")
        );
        assert_eq!(
            validate_avatar(&png_header(256, 128), "image/png"),
            Err("Avatar must be a square image")
        );
        assert_eq!(
            validate_avatar(&png_header(8193, 8193), "image/png"),
            Err("Avatar dimensions must be between 1 and 8192 pixels")
        );
    }

    #[test]
    fn avatar_validation_accepts_avif_brand_and_rejects_other_heif() {
        let avif = isobmff_image(*b"avif", 512, 512);
        assert_eq!(
            validate_avatar(&avif, "image/avif").unwrap().media_type,
            "image/avif"
        );
        let heic = isobmff_image(*b"heic", 512, 512);
        assert_eq!(
            validate_avatar(&heic, "image/avif"),
            Err("Avatar must be AVIF, JPEG, PNG, or WebP")
        );
    }

    #[test]
    fn avatar_validation_rejects_unrecognized_bytes() {
        assert_eq!(
            validate_avatar(b"not an image", "image/png"),
            Err("Unsupported or malformed avatar image")
        );
    }

    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }

    fn isobmff_image(brand: [u8; 4], width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&24_u32.to_be_bytes());
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(&brand);
        bytes.extend_from_slice(&0_u32.to_be_bytes());
        bytes.extend_from_slice(&brand);
        bytes.extend_from_slice(b"mif1");
        bytes.extend_from_slice(&48_u32.to_be_bytes());
        bytes.extend_from_slice(b"meta");
        bytes.extend_from_slice(&0_u32.to_be_bytes());
        bytes.extend_from_slice(&36_u32.to_be_bytes());
        bytes.extend_from_slice(b"iprp");
        bytes.extend_from_slice(&28_u32.to_be_bytes());
        bytes.extend_from_slice(b"ipco");
        bytes.extend_from_slice(&20_u32.to_be_bytes());
        bytes.extend_from_slice(b"ispe");
        bytes.extend_from_slice(&0_u32.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }
}
