//! D1-backed HTTP command idempotency. / 基于 D1 的 HTTP 命令幂等层。
//!
//! The database uniqueness constraint is the concurrency primitive. No process-local state is
//! used because Workers isolates are neither unique nor durable.
//! 数据库唯一约束是并发原语；Workers isolate 既不唯一也不持久，因此这里不使用进程内状态。

use std::future::Future;

use futures_util::TryStreamExt;
use identity_domain::{SecretDigest, TransactionId};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq;
use worker::{
    D1Database, D1SessionConstraint, Env, Error, Headers, Request, Response, ResponseBody,
    RouteContext, wasm_bindgen::JsValue,
};

use crate::{guard, problem, repository};

const IDEMPOTENCY_TTL_SECONDS: i64 = 24 * 60 * 60;
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_REPLAY_BODY_BYTES: usize = 64 * 1024;
const DIGEST_DOMAIN: &[u8] = b"moesegfault-idempotency-request-v1\0";
const PURGE_EXPIRED_SQL: &str = "DELETE FROM idempotency_records WHERE idempotency_record_id IN (\
     SELECT idempotency_record_id FROM idempotency_records WHERE expires_at<=?1 \
     ORDER BY expires_at,idempotency_record_id LIMIT ?2)";

/// OpenAPI operation names covered by the Domain API idempotency contract.
/// 受 Domain API 幂等契约覆盖的 OpenAPI operationId。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    PasswordRegistration,
    PasswordAuthentication,
    CreateContact,
    UpdateContact,
    DeleteContact,
    CreateContactVerification,
    CompleteContactVerification,
    PutPassword,
    CreateAccountRegistrationTransaction,
    CompleteRegistrationTransaction,
    CreateAuthenticationTransaction,
    CompleteAuthenticationTransaction,
    CreateRecoveryTransaction,
    CompleteRecoveryTransaction,
    UpdateSelf,
    UpdatePreferences,
    ScheduleSelfDeletion,
    CreateSelfIdentifier,
    UpdateSelfIdentifier,
    DeleteSelfIdentifier,
    CreateAuthenticatorRegistrationTransaction,
    UpdateSelfAuthenticator,
    RevokeSelfAuthenticator,
    RevokeSelfBinding,
    RevokeAllSelfSessions,
    RevokeSelfSession,
    RotateSelfRecoveryCodes,
}

impl Operation {
    /// Returns the stable OpenAPI operationId persisted in D1.
    /// 返回持久化到 D1 的稳定 OpenAPI operationId。
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PasswordRegistration => "registerWithPassword",
            Self::PasswordAuthentication => "authenticateWithPassword",
            Self::CreateContact => "createMyContact",
            Self::UpdateContact => "updateMyContact",
            Self::DeleteContact => "deleteMyContact",
            Self::CreateContactVerification => "createContactVerification",
            Self::CompleteContactVerification => "completeContactVerification",
            Self::PutPassword => "setMyPassword",
            Self::CreateAccountRegistrationTransaction => "createAccountRegistrationTransaction",
            Self::CompleteRegistrationTransaction => "completeRegistrationTransaction",
            Self::CreateAuthenticationTransaction => "createAuthenticationTransaction",
            Self::CompleteAuthenticationTransaction => "completeAuthenticationTransaction",
            Self::CreateRecoveryTransaction => "createRecoveryTransaction",
            Self::CompleteRecoveryTransaction => "completeRecoveryTransaction",
            Self::UpdateSelf => "updateSelf",
            Self::UpdatePreferences => "updateMyPreferences",
            Self::ScheduleSelfDeletion => "scheduleSelfDeletion",
            Self::CreateSelfIdentifier => "createSelfIdentifier",
            Self::UpdateSelfIdentifier => "updateSelfIdentifier",
            Self::DeleteSelfIdentifier => "deleteSelfIdentifier",
            Self::CreateAuthenticatorRegistrationTransaction => {
                "createAuthenticatorRegistrationTransaction"
            }
            Self::UpdateSelfAuthenticator => "updateSelfAuthenticator",
            Self::RevokeSelfAuthenticator => "revokeSelfAuthenticator",
            Self::RevokeSelfBinding => "revokeSelfBinding",
            Self::RevokeAllSelfSessions => "revokeAllSelfSessions",
            Self::RevokeSelfSession => "revokeSelfSession",
            Self::RotateSelfRecoveryCodes => "rotateSelfRecoveryCodes",
        }
    }

    const fn content_type(self) -> Option<&'static str> {
        match self {
            Self::UpdateSelf
            | Self::UpdatePreferences
            | Self::UpdateContact
            | Self::UpdateSelfAuthenticator => Some("application/merge-patch+json"),
            Self::ScheduleSelfDeletion
            | Self::DeleteSelfIdentifier
            | Self::DeleteContact
            | Self::RevokeSelfAuthenticator
            | Self::RevokeSelfBinding
            | Self::RevokeAllSelfSessions
            | Self::RevokeSelfSession => None,
            _ => Some("application/json"),
        }
    }
}

/// Selects the opaque cookie from which the caller fingerprint is derived.
/// 选择用于派生调用方指纹的不透明 Cookie。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller {
    /// Anonymous WebAuthn/recovery ceremony, bound to the browser cookie.
    /// 绑定匿名浏览器 Cookie 的 WebAuthn/恢复 ceremony。
    Browser,
    /// Authenticated account command, bound to the presented session bearer.
    /// 绑定当前所呈现 session bearer 的账户命令。
    Session,
}

/// Controls whether a successful response snapshot may be retained.
/// 控制成功响应快照能否持久化。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayPolicy {
    /// A sanitized JSON/empty response can be replayed.
    /// 可重放净化后的 JSON/空响应。
    Replayable,
    /// The response contains one-time material and is never persisted.
    /// 响应含一次性材料，绝不持久化。
    SecretResult,
}

/// Runs one mutating handler behind a D1 conditional idempotency claim.
/// 在 D1 条件式幂等声明后执行一个 mutation handler。
///
/// # Example / 示例
///
/// ```ignore
/// .post_async("/v1/registration-transactions", |request, context| async move {
///     idempotency::run(
///         request,
///         context,
///         Operation::CreateAccountRegistrationTransaction,
///         Caller::Browser,
///         ReplayPolicy::SecretResult,
///         api::start_registration,
///     ).await
/// })
/// ```
///
/// A `processing` claim is deliberately retained after an isolate crash. Re-execution is allowed
/// only when the 24-hour record expires; the domain tables' own constraints remain the final
/// arbiter for one-time ceremony consumption.
/// isolate 崩溃后会刻意保留 `processing` 声明；仅 24 小时记录过期后允许重新执行，一次性
/// ceremony 的最终裁决仍由领域表约束负责。
pub async fn run<F, Fut>(
    request: Request,
    context: RouteContext<()>,
    operation: Operation,
    caller: Caller,
    replay_policy: ReplayPolicy,
    handler: F,
) -> worker::Result<Response>
where
    F: FnOnce(Request, RouteContext<()>) -> Fut,
    Fut: Future<Output = worker::Result<Response>>,
{
    let correlation = correlation_id();
    let key = match IdempotencyKey::from_request(&request) {
        Ok(key) => key,
        Err(KeyError::Missing) => {
            return cors_problem(
                &context.env,
                "invalid_request",
                "Idempotency-Key is required",
                400,
                &correlation,
            );
        }
        Err(KeyError::Invalid) => {
            return cors_problem(
                &context.env,
                "invalid_request",
                "Invalid Idempotency-Key",
                400,
                &correlation,
            );
        }
    };

    match validate_preclaim_boundary(&request, &context, operation, caller, &correlation).await? {
        Boundary::Ready => {}
        Boundary::Response(response) => return Ok(response),
        Boundary::DeferToHandler => return handler(request, context).await,
    }

    let digest = match digest_request(&request).await {
        Ok(digest) => digest,
        Err(DigestError::TooLarge) => {
            return cors_problem(
                &context.env,
                "invalid_request",
                "Request body is too large",
                413,
                &correlation,
            );
        }
        Err(DigestError::Worker(error)) => return Err(error),
    };

    // Missing cookies cannot reach a side effect in the wrapped handlers. Let the handler produce
    // its normal authentication problem rather than sharing one global "anonymous" fingerprint.
    // 缺少 Cookie 的请求无法在 handler 中产生副作用；交由 handler 返回原有认证错误，避免
    // 所有无 Cookie 请求共享一个“匿名”指纹。
    let Some(fingerprint) = caller_fingerprint(&request, &context.env, caller)? else {
        return handler(request, context).await;
    };

    let env = context.env.clone();
    let now = now_seconds();
    let db = context.d1("DB")?;
    let gate = begin(
        &db,
        &fingerprint,
        operation.as_str(),
        key.as_str(),
        &digest,
        now,
    )
    .await?;

    let lease = match gate {
        Gate::Execute(lease) => lease,
        Gate::Replay(snapshot) => return snapshot.into_response(&env),
        Gate::Conflict => {
            return cors_problem(
                &env,
                "idempotency_conflict",
                "Idempotency key was used for a different request",
                409,
                &correlation,
            );
        }
        Gate::InProgress => {
            let response = cors_problem(
                &env,
                "idempotency_in_progress",
                "The original request is still processing",
                409,
                &correlation,
            )?;
            response.headers().set("retry-after", "1")?;
            return Ok(response);
        }
        Gate::ResultUnavailable => {
            return cors_problem(
                &env,
                "idempotency_result_unavailable",
                "The one-time result cannot be replayed",
                409,
                &correlation,
            );
        }
    };

    match handler(request, context).await {
        Ok(response) => {
            let status = response.status_code();
            let snapshot = ReplaySnapshot::capture(&response, replay_policy);
            if let Err(error) = finish(&env.d1("DB")?, &lease, status, snapshot.as_ref()).await {
                worker::console_error!(
                    "idempotency_completion_failed operation={} record_id={} error={}",
                    operation.as_str(),
                    lease.record_id,
                    error
                );
            }
            Ok(response)
        }
        Err(error) => {
            if let Err(completion_error) = finish(&env.d1("DB")?, &lease, 500, None).await {
                worker::console_error!(
                    "idempotency_failure_completion_failed operation={} record_id={} error={}",
                    operation.as_str(),
                    lease.record_id,
                    completion_error
                );
            }
            Err(error)
        }
    }
}

enum Boundary {
    Ready,
    Response(Response),
    DeferToHandler,
}

async fn validate_preclaim_boundary(
    request: &Request,
    context: &RouteContext<()>,
    operation: Operation,
    caller: Caller,
    correlation: &str,
) -> worker::Result<Boundary> {
    if guard::header(request.headers(), "origin").as_deref()
        != Some(guard::login_origin(&context.env).as_str())
    {
        return cors_problem(
            &context.env,
            "invalid_request",
            "Origin is not allowed",
            403,
            correlation,
        )
        .map(Boundary::Response);
    }
    if guard::header(request.headers(), "sec-fetch-site").as_deref() != Some("same-site")
        || guard::header(request.headers(), "sec-fetch-mode").as_deref() != Some("cors")
    {
        return cors_problem(
            &context.env,
            "invalid_request",
            "Invalid browser request context",
            403,
            correlation,
        )
        .map(Boundary::Response);
    }
    if let Some(expected) = operation.content_type() {
        let actual = guard::header(request.headers(), "content-type").unwrap_or_default();
        if !actual
            .split(';')
            .next()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case(expected))
        {
            return cors_problem(
                &context.env,
                "invalid_request",
                "JSON content type is required",
                415,
                correlation,
            )
            .map(Boundary::Response);
        }
    }
    let Some(_) = guard::header(request.headers(), "x-moesegfault-csrf") else {
        return cors_problem(
            &context.env,
            "invalid_request",
            "CSRF validation failed",
            403,
            correlation,
        )
        .map(Boundary::Response);
    };

    match caller {
        Caller::Session => validate_session_preclaim(request, &context.env, correlation),
        Caller::Browser => {
            validate_browser_preclaim(request, context, operation, correlation).await
        }
    }
}

fn validate_session_preclaim(
    request: &Request,
    env: &Env,
    correlation: &str,
) -> worker::Result<Boundary> {
    let Some(wire) = guard::cookie(request, guard::SESSION_COOKIE) else {
        return Ok(Boundary::DeferToHandler);
    };
    let pepper = required_secret(env, "CSRF_PEPPER")?;
    if guard::validate_session_csrf(request, &wire, pepper.as_bytes()) {
        return Ok(Boundary::Ready);
    }
    cors_problem(
        env,
        "invalid_request",
        "CSRF validation failed",
        403,
        correlation,
    )
    .map(Boundary::Response)
}

async fn validate_browser_preclaim(
    request: &Request,
    context: &RouteContext<()>,
    operation: Operation,
    correlation: &str,
) -> worker::Result<Boundary> {
    let pepper = required_secret(&context.env, "TRANSACTION_PEPPER")?;
    let valid = match operation {
        Operation::CompleteRegistrationTransaction
        | Operation::CompleteAuthenticationTransaction => {
            let Some(id) = context.param("id") else {
                return Ok(Boundary::DeferToHandler);
            };
            let Some(transaction) =
                repository::webauthn_transaction(&context.d1("DB")?, id).await?
            else {
                return Ok(Boundary::DeferToHandler);
            };
            if matches!(
                transaction.kind.as_str(),
                "authenticator_addition" | "step_up"
            ) && guard::cookie(request, guard::SESSION_COOKIE).is_none()
            {
                return Ok(Boundary::DeferToHandler);
            }
            guard::validate_transaction_secrets(
                request,
                &transaction.csrf_digest,
                &transaction.browser_binding_digest,
                pepper.as_bytes(),
            )
            .is_ok()
        }
        Operation::CompleteRecoveryTransaction => {
            let Some(id) = context.param("id") else {
                return Ok(Boundary::DeferToHandler);
            };
            let Some(transaction) =
                repository::recovery_transaction(&context.d1("DB")?, id).await?
            else {
                return Ok(Boundary::DeferToHandler);
            };
            guard::validate_transaction_secrets(
                request,
                &transaction.csrf_digest,
                &transaction.browser_binding_digest,
                pepper.as_bytes(),
            )
            .is_ok()
        }
        _ => guard::validate_browser_csrf(
            request,
            required_secret(&context.env, "CSRF_PEPPER")?.as_bytes(),
        ),
    };
    if valid {
        return Ok(Boundary::Ready);
    }
    cors_problem(
        &context.env,
        "invalid_request",
        "CSRF validation failed",
        403,
        correlation,
    )
    .map(Boundary::Response)
}

/// Deletes a bounded page of expired records; normal requests also reclaim a matching expired key.
/// 删除一页有界的过期记录；普通请求也会原子接管同 key 的过期记录。
pub async fn purge_expired(db: &D1Database, now: i64, limit: u32) -> worker::Result<usize> {
    let result = db
        .prepare(PURGE_EXPIRED_SQL)
        .bind(&[integer(now), integer(i64::from(limit.clamp(1, 1_000)))])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IdempotencyKey(String);

impl IdempotencyKey {
    fn from_request(request: &Request) -> Result<Self, KeyError> {
        let value = guard::header(request.headers(), "idempotency-key").ok_or(KeyError::Missing)?;
        Self::parse(value)
    }

    fn parse(value: String) -> Result<Self, KeyError> {
        if !(16..=128).contains(&value.len())
            || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        {
            return Err(KeyError::Invalid);
        }
        Ok(Self(value))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyError {
    Missing,
    Invalid,
}

#[derive(Debug)]
enum DigestError {
    TooLarge,
    Worker(Error),
}

impl From<Error> for DigestError {
    fn from(value: Error) -> Self {
        Self::Worker(value)
    }
}

async fn digest_request(request: &Request) -> Result<[u8; 32], DigestError> {
    if guard::header(request.headers(), "content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_REQUEST_BYTES)
    {
        return Err(DigestError::TooLarge);
    }

    let method = request.method().to_string();
    let url = request.url()?;
    let resource = url.query().map_or_else(
        || url.path().to_owned(),
        |query| format!("{}?{query}", url.path()),
    );
    let content_type = guard::header(request.headers(), "content-type").unwrap_or_default();
    let mut hasher = request_hasher(&method, &resource, &content_type);
    let mut total = 0_usize;
    let mut cloned = request.clone()?;
    if cloned.inner().body().is_some() {
        let mut stream = cloned.stream()?;
        while let Some(chunk) = stream.try_next().await? {
            total = total
                .checked_add(chunk.len())
                .ok_or(DigestError::TooLarge)?;
            if total > MAX_REQUEST_BYTES {
                return Err(DigestError::TooLarge);
            }
            hasher.update(&chunk);
        }
    }
    Ok(hasher.finalize().into())
}

fn request_hasher(method: &str, resource: &str, content_type: &str) -> Sha256 {
    let mut hasher = Sha256::new();
    hasher.update(DIGEST_DOMAIN);
    update_frame(&mut hasher, method.as_bytes());
    update_frame(&mut hasher, resource.as_bytes());
    update_frame(
        &mut hasher,
        content_type.trim().to_ascii_lowercase().as_bytes(),
    );
    hasher
}

#[cfg(test)]
fn request_digest_for_bytes(
    method: &str,
    resource: &str,
    content_type: &str,
    body: &[u8],
) -> [u8; 32] {
    let mut hasher = request_hasher(method, resource, content_type);
    hasher.update(body);
    hasher.finalize().into()
}

fn update_frame(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn caller_fingerprint(
    request: &Request,
    env: &Env,
    caller: Caller,
) -> worker::Result<Option<String>> {
    let (cookie_name, pepper_name, prefix) = match caller {
        Caller::Browser => (guard::BROWSER_COOKIE, "TRANSACTION_PEPPER", "browser"),
        Caller::Session => (guard::SESSION_COOKIE, "SESSION_PEPPER", "session"),
    };
    let Some(wire) = guard::cookie(request, cookie_name) else {
        return Ok(None);
    };
    let pepper = required_secret(env, pepper_name)?;
    let material = format!("idempotency/{prefix}/{wire}");
    let digest = SecretDigest::hmac(pepper.as_bytes(), material.as_bytes());
    Ok(Some(format!("{prefix}:{}", digest.to_base64url())))
}

#[derive(Debug)]
enum Gate {
    Execute(Lease),
    Replay(ReplaySnapshot),
    Conflict,
    InProgress,
    ResultUnavailable,
}

#[derive(Debug)]
struct Lease {
    record_id: String,
    request_digest: [u8; 32],
}

#[derive(Debug, Deserialize)]
struct Record {
    idempotency_record_id: String,
    request_digest: Vec<u8>,
    state: String,
    response_status: Option<i64>,
    response_metadata_json: Option<String>,
    expires_at: i64,
}

async fn begin(
    db: &D1Database,
    caller_fingerprint: &str,
    operation: &str,
    key: &str,
    request_digest: &[u8; 32],
    now: i64,
) -> worker::Result<Gate> {
    let record_id = TransactionId::new_v7(worker::Date::now().as_millis()).to_string();
    let session = db.with_session_constraint(D1SessionConstraint::FirstPrimary)?;
    let claimed = session
        .prepare(
            "INSERT INTO idempotency_records(\
             idempotency_record_id,caller_fingerprint,operation,idempotency_key,request_digest,\
             state,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,'processing',?6,?7) \
             ON CONFLICT(caller_fingerprint,operation,idempotency_key) DO UPDATE SET \
             idempotency_record_id=excluded.idempotency_record_id,\
             request_digest=excluded.request_digest,state='processing',response_status=NULL,\
             response_metadata_json=NULL,result_reference=NULL,created_at=excluded.created_at,\
             expires_at=excluded.expires_at,completed_at=NULL \
             WHERE idempotency_records.expires_at<=excluded.created_at \
             RETURNING idempotency_record_id",
        )
        .bind(&[
            text(&record_id),
            text(caller_fingerprint),
            text(operation),
            text(key),
            blob(request_digest),
            integer(now),
            integer(now + IDEMPOTENCY_TTL_SECONDS),
        ])?
        .first::<String>(Some("idempotency_record_id"))
        .await?;
    if claimed.as_deref() == Some(record_id.as_str()) {
        return Ok(Gate::Execute(Lease {
            record_id,
            request_digest: *request_digest,
        }));
    }

    let row = session
        .prepare(
            "SELECT idempotency_record_id,request_digest,state,response_status,\
             response_metadata_json,expires_at FROM idempotency_records \
             WHERE caller_fingerprint=?1 AND operation=?2 AND idempotency_key=?3",
        )
        .bind(&[text(caller_fingerprint), text(operation), text(key)])?
        .first::<Record>(None)
        .await?
        .ok_or_else(|| Error::RustError("idempotency claim disappeared".into()))?;
    decide_record(row, request_digest, now)
}

fn decide_record(row: Record, request_digest: &[u8; 32], now: i64) -> worker::Result<Gate> {
    // An expired row should have been atomically replaced by begin(). Treat seeing one as a
    // transient invariant failure rather than executing without ownership.
    if row.expires_at <= now {
        return Err(Error::RustError(
            "expired idempotency record was not reclaimed".into(),
        ));
    }
    if row.request_digest.len() != 32
        || !bool::from(
            row.request_digest
                .as_slice()
                .ct_eq(request_digest.as_slice()),
        )
    {
        return Ok(Gate::Conflict);
    }
    match row.state.as_str() {
        "processing" => Ok(Gate::InProgress),
        "completed" | "failed" => {
            let Some(status) = row.response_status.and_then(valid_status) else {
                return Ok(Gate::ResultUnavailable);
            };
            let Some(metadata) = row.response_metadata_json else {
                return Ok(Gate::ResultUnavailable);
            };
            let Ok(snapshot) = serde_json::from_str::<ReplaySnapshot>(&metadata) else {
                return Ok(Gate::ResultUnavailable);
            };
            if snapshot.status != status || !snapshot.is_safe() {
                return Ok(Gate::ResultUnavailable);
            }
            Ok(Gate::Replay(snapshot))
        }
        _ => Err(Error::RustError(format!(
            "invalid idempotency state for record {}",
            row.idempotency_record_id
        ))),
    }
}

fn valid_status(value: i64) -> Option<u16> {
    let status = u16::try_from(value).ok()?;
    (200..=599).contains(&status).then_some(status)
}

async fn finish(
    db: &D1Database,
    lease: &Lease,
    status: u16,
    snapshot: Option<&ReplaySnapshot>,
) -> worker::Result<()> {
    let state = if status >= 400 { "failed" } else { "completed" };
    let metadata = snapshot.map(serde_json::to_string).transpose()?;
    let now = now_seconds();
    let result = db
        .prepare(
            "UPDATE idempotency_records SET state=?2,response_status=?3,\
             response_metadata_json=?4,result_reference=?5,completed_at=?6 \
             WHERE idempotency_record_id=?1 AND request_digest=?7 AND state='processing'",
        )
        .bind(&[
            text(&lease.record_id),
            text(state),
            integer(i64::from(status)),
            optional_text(metadata.as_deref()),
            optional_text(snapshot.is_none().then_some("unavailable")),
            integer(now),
            blob(&lease.request_digest),
        ])?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    if changes != 1 {
        return Err(Error::RustError(
            "idempotency completion lost record ownership".into(),
        ));
    }
    Ok(())
}

/// Sanitized HTTP response data; headers capable of carrying credentials are intentionally absent.
/// 净化后的 HTTP 响应；能够携带凭证的 header 被刻意排除。
#[derive(Debug, Clone, Deserialize, Serialize)]
struct ReplaySnapshot {
    status: u16,
    body: Option<String>,
    content_type: Option<String>,
    correlation_id: Option<String>,
    cors: bool,
    retry_after: Option<u32>,
    #[serde(default)]
    clear_session_cookie: bool,
}

impl ReplaySnapshot {
    fn capture(response: &Response, replay_policy: ReplayPolicy) -> Option<Self> {
        let status = response.status_code();
        if replay_policy == ReplayPolicy::SecretResult && status < 400 {
            return None;
        }
        let clear_session_cookie = match guard::header(response.headers(), "set-cookie") {
            None => false,
            Some(value) if value == guard::clear_session_cookie() => true,
            Some(_) => return None,
        };
        let body = match response.body() {
            ResponseBody::Empty => None,
            ResponseBody::Body(bytes) if bytes.len() <= MAX_REPLAY_BODY_BYTES => {
                let text = String::from_utf8(bytes.clone()).ok()?;
                let json: serde_json::Value = serde_json::from_str(&text).ok()?;
                if contains_secret_field(&json) {
                    return None;
                }
                Some(text)
            }
            ResponseBody::Body(_) | ResponseBody::Stream(_) => return None,
        };
        let content_type = guard::header(response.headers(), "content-type")
            .filter(|value| is_json_content_type(value));
        if body.is_some() && content_type.is_none() {
            return None;
        }
        Some(Self {
            status,
            body,
            content_type,
            correlation_id: guard::header(response.headers(), "x-moesegfault-correlation-id"),
            cors: guard::header(response.headers(), "access-control-allow-origin").is_some(),
            retry_after: guard::header(response.headers(), "retry-after")
                .and_then(|value| value.parse().ok()),
            clear_session_cookie,
        })
    }

    fn is_safe(&self) -> bool {
        if !(200..=599).contains(&self.status)
            || self.body.as_ref().is_some_and(|body| {
                body.len() > MAX_REPLAY_BODY_BYTES
                    || serde_json::from_str(body)
                        .map(|value| contains_secret_field(&value))
                        .unwrap_or(true)
            })
        {
            return false;
        }
        if self.body.is_some()
            && !self
                .content_type
                .as_deref()
                .is_some_and(is_json_content_type)
        {
            return false;
        }
        self.retry_after.is_none_or(|seconds| seconds <= 86_400)
    }

    fn into_response(self, env: &Env) -> worker::Result<Response> {
        if !self.is_safe() {
            return Err(Error::RustError(
                "unsafe stored idempotency response metadata".into(),
            ));
        }
        let headers = Headers::new();
        if let Some(content_type) = self.content_type {
            if !is_json_content_type(&content_type) {
                return Err(Error::RustError(
                    "invalid stored idempotency content type".into(),
                ));
            }
            headers.set("content-type", &content_type)?;
        }
        headers.set("cache-control", "no-store")?;
        headers.set("x-content-type-options", "nosniff")?;
        if let Some(correlation) = self.correlation_id {
            headers.set("x-moesegfault-correlation-id", &correlation)?;
        }
        if let Some(seconds) = self.retry_after {
            headers.set("retry-after", &seconds.to_string())?;
        }
        if self.cors {
            headers.set("access-control-allow-origin", &guard::login_origin(env))?;
            headers.set("access-control-allow-credentials", "true")?;
            headers.set("vary", "Origin")?;
        }
        if self.clear_session_cookie {
            headers.set("set-cookie", guard::clear_session_cookie())?;
        }
        let response = match self.body {
            Some(body) => Response::from_body(ResponseBody::Body(body.into_bytes()))?,
            None => Response::empty()?,
        };
        Ok(response.with_status(self.status).with_headers(headers))
    }
}

fn is_json_content_type(value: &str) -> bool {
    matches!(
        value.split(';').next().map(str::trim),
        Some("application/json" | "application/problem+json")
    )
}

fn contains_secret_field(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(
                key.as_str(),
                "access_token"
                    | "authorization_uri"
                    | "csrf_token"
                    | "id_token"
                    | "recovery_code"
                    | "recovery_codes"
                    | "refresh_token"
                    | "token"
            ) || contains_secret_field(value)
        }),
        serde_json::Value::Array(values) => values.iter().any(contains_secret_field),
        _ => false,
    }
}

fn now_seconds() -> i64 {
    (worker::Date::now().as_millis() / 1_000) as i64
}

fn correlation_id() -> String {
    TransactionId::new_v7(worker::Date::now().as_millis()).to_string()
}

fn required_secret(env: &Env, name: &str) -> worker::Result<String> {
    env.secret(name)
        .map(|secret| secret.to_string())
        .map_err(|_| Error::BindingError(format!("missing required secret binding {name}")))
}

fn cors_problem(
    env: &Env,
    code: &'static str,
    title: &'static str,
    status: u16,
    correlation: &str,
) -> worker::Result<Response> {
    let response = problem::response(code, title, status, correlation)?;
    response
        .headers()
        .set("access-control-allow-origin", &guard::login_origin(env))?;
    response
        .headers()
        .set("access-control-allow-credentials", "true")?;
    response.headers().set("vary", "Origin")?;
    Ok(response)
}

fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

fn optional_text(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from_str)
}

fn integer(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}

fn blob(value: &[u8]) -> JsValue {
    js_sys::Uint8Array::from(value).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(state: &str, digest: [u8; 32], metadata: Option<String>) -> Record {
        Record {
            idempotency_record_id: "018f0000-0000-7000-8000-000000000000".into(),
            request_digest: digest.to_vec(),
            state: state.into(),
            response_status: Some(204),
            response_metadata_json: metadata,
            expires_at: 86_500,
        }
    }

    #[test]
    fn operations_are_stable_and_fit_the_schema() {
        let operations = [
            (Operation::PasswordRegistration, "registerWithPassword"),
            (
                Operation::PasswordAuthentication,
                "authenticateWithPassword",
            ),
            (Operation::CreateContact, "createMyContact"),
            (Operation::UpdateContact, "updateMyContact"),
            (Operation::DeleteContact, "deleteMyContact"),
            (
                Operation::CreateContactVerification,
                "createContactVerification",
            ),
            (
                Operation::CompleteContactVerification,
                "completeContactVerification",
            ),
            (Operation::PutPassword, "setMyPassword"),
            (
                Operation::CreateAccountRegistrationTransaction,
                "createAccountRegistrationTransaction",
            ),
            (
                Operation::CompleteRegistrationTransaction,
                "completeRegistrationTransaction",
            ),
            (
                Operation::CreateAuthenticationTransaction,
                "createAuthenticationTransaction",
            ),
            (
                Operation::CompleteAuthenticationTransaction,
                "completeAuthenticationTransaction",
            ),
            (
                Operation::CreateRecoveryTransaction,
                "createRecoveryTransaction",
            ),
            (
                Operation::CompleteRecoveryTransaction,
                "completeRecoveryTransaction",
            ),
            (Operation::UpdateSelf, "updateSelf"),
            (Operation::UpdatePreferences, "updateMyPreferences"),
            (Operation::ScheduleSelfDeletion, "scheduleSelfDeletion"),
            (Operation::CreateSelfIdentifier, "createSelfIdentifier"),
            (Operation::UpdateSelfIdentifier, "updateSelfIdentifier"),
            (Operation::DeleteSelfIdentifier, "deleteSelfIdentifier"),
            (
                Operation::CreateAuthenticatorRegistrationTransaction,
                "createAuthenticatorRegistrationTransaction",
            ),
            (
                Operation::UpdateSelfAuthenticator,
                "updateSelfAuthenticator",
            ),
            (
                Operation::RevokeSelfAuthenticator,
                "revokeSelfAuthenticator",
            ),
            (Operation::RevokeSelfBinding, "revokeSelfBinding"),
            (Operation::RevokeAllSelfSessions, "revokeAllSelfSessions"),
            (Operation::RevokeSelfSession, "revokeSelfSession"),
            (
                Operation::RotateSelfRecoveryCodes,
                "rotateSelfRecoveryCodes",
            ),
        ];
        for (operation, expected) in operations {
            assert_eq!(operation.as_str(), expected);
            assert!((1..=128).contains(&operation.as_str().len()));
        }
        assert_eq!(
            Operation::UpdateSelf.content_type(),
            Some("application/merge-patch+json")
        );
        assert_eq!(Operation::RevokeSelfSession.content_type(), None);
        assert_eq!(
            Operation::CreateRecoveryTransaction.content_type(),
            Some("application/json")
        );
        assert_eq!(
            Operation::CreateContactVerification.content_type(),
            Some("application/json")
        );
        assert_eq!(
            Operation::CompleteContactVerification.content_type(),
            Some("application/json")
        );
    }

    #[test]
    fn key_validation_matches_the_openapi_visible_ascii_contract() {
        assert!(IdempotencyKey::parse("!234567890abc,;~".into()).is_ok());
        assert!(IdempotencyKey::parse("x".repeat(128)).is_ok());
        assert_eq!(
            IdempotencyKey::parse("x".repeat(15)),
            Err(KeyError::Invalid)
        );
        assert_eq!(
            IdempotencyKey::parse("x".repeat(129)),
            Err(KeyError::Invalid)
        );
        assert_eq!(
            IdempotencyKey::parse("1234567890abcde ".into()),
            Err(KeyError::Invalid)
        );
        assert_eq!(
            IdempotencyKey::parse("1234567890abcde\u{7f}".into()),
            Err(KeyError::Invalid)
        );
    }

    #[test]
    fn digest_covers_resource_media_type_and_exact_body() {
        let base = request_digest_for_bytes("DELETE", "/sessions/a", "", b"");
        assert_ne!(
            base,
            request_digest_for_bytes("DELETE", "/sessions/b", "", b"")
        );
        assert_ne!(
            base,
            request_digest_for_bytes("POST", "/sessions/a", "", b"")
        );
        assert_ne!(
            request_digest_for_bytes("PATCH", "/self", "application/json", b"{}"),
            request_digest_for_bytes("PATCH", "/self", "application/merge-patch+json", b"{}")
        );
        assert_ne!(
            request_digest_for_bytes("POST", "/x", "application/json", br#"{"a":1}"#),
            request_digest_for_bytes("POST", "/x", "application/json", br#"{ "a":1 }"#)
        );
    }

    #[test]
    fn record_decision_distinguishes_conflict_progress_and_replay() {
        let digest = [7_u8; 32];
        assert!(matches!(
            decide_record(record("processing", digest, None), &digest, 100).unwrap(),
            Gate::InProgress
        ));
        assert!(matches!(
            decide_record(record("processing", digest, None), &[8; 32], 100).unwrap(),
            Gate::Conflict
        ));
        let snapshot = ReplaySnapshot {
            status: 204,
            body: None,
            content_type: None,
            correlation_id: Some("018f0000-0000-7000-8000-000000000000".into()),
            cors: true,
            retry_after: None,
            clear_session_cookie: false,
        };
        assert!(matches!(
            decide_record(
                record(
                    "completed",
                    digest,
                    Some(serde_json::to_string(&snapshot).unwrap())
                ),
                &digest,
                100
            )
            .unwrap(),
            Gate::Replay(_)
        ));
        assert!(matches!(
            decide_record(record("completed", digest, None), &digest, 100).unwrap(),
            Gate::ResultUnavailable
        ));
        assert!(matches!(
            decide_record(
                record("completed", digest, Some("not-json".into())),
                &digest,
                100
            )
            .unwrap(),
            Gate::ResultUnavailable
        ));
    }

    #[test]
    fn secret_fields_are_rejected_recursively() {
        assert!(contains_secret_field(&serde_json::json!({
            "account": {"nested": [{"recovery_codes": ["secret"]}]}
        })));
        assert!(contains_secret_field(&serde_json::json!({
            "authorization_uri": "https://issuer.example/?state=secret"
        })));
        assert!(!contains_secret_field(&serde_json::json!({
            "account": {"principal_id": "safe"}, "items": []
        })));
        let unsafe_snapshot = ReplaySnapshot {
            status: 200,
            body: Some(r#"{"nested":{"access_token":"secret"}}"#.into()),
            content_type: Some("application/json".into()),
            correlation_id: None,
            cors: false,
            retry_after: None,
            clear_session_cookie: false,
        };
        assert!(!unsafe_snapshot.is_safe());
    }

    #[test]
    fn clear_cookie_replay_persists_only_a_boolean_instruction() {
        let snapshot = ReplaySnapshot {
            status: 204,
            body: None,
            content_type: None,
            correlation_id: None,
            cors: true,
            retry_after: None,
            clear_session_cookie: true,
        };
        let stored = serde_json::to_string(&snapshot).unwrap();
        assert!(stored.contains("\"clear_session_cookie\":true"));
        assert!(!stored.contains("__Host-identity_session"));
    }

    #[test]
    fn ttl_is_exactly_twenty_four_hours() {
        assert_eq!(IDEMPOTENCY_TTL_SECONDS, 86_400);
    }

    #[test]
    fn purge_is_bounded_and_uses_expiry_index_order() {
        assert!(PURGE_EXPIRED_SQL.contains("expires_at<=?1"));
        assert!(PURGE_EXPIRED_SQL.contains("ORDER BY expires_at,idempotency_record_id LIMIT ?2"));
    }
}
