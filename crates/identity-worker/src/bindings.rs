//! 标准 OIDC 外部身份 Binding HTTP 适配器。
//! Standard-OIDC external identity binding HTTP adapter.
//!
//! Provider issuer、endpoint、client 与允许的签名算法只来自显式 Worker 配置。
//! Provider issuer, endpoints, client, and allowed signing algorithms come exclusively from
//! explicit Worker configuration. This module deliberately does not implement email linking or
//! generic OAuth providers that do not issue ID Tokens.

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chacha20poly1305::{
    Key, XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use futures_util::TryStreamExt as _;
use identity_domain::{AuditEventId, BindingId, SecretDigest, TransactionId};
use rand::RngCore as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;
use url::Url;
use worker::{
    Env, Error, Fetch, Headers, Method, Request, RequestInit, RequestRedirect, Response,
    ResponseBody, Result, RouteContext,
};

use crate::{binding_repository as repo, guard, problem, webcrypto};

const CONFIG_BINDING: &str = "BINDING_PROVIDERS_JSON";
const TRANSACTION_KEY_BINDING: &str = "BINDING_PKCE_AEAD_KEY_V1";
const TRANSACTION_KEY_REVISION: i64 = 1;
const CALLBACK_PATH: &str = "/v1/binding-transactions/callback";
const COMPLETION_PATH: &str = "/account/bindings";
const STEP_UP_SECONDS: i64 = 300;
const TRANSACTION_SECONDS: i64 = 300;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_METADATA_BYTES: usize = 32 * 1024;
const MAX_TOKEN_BYTES: usize = 32 * 1024;
const MAX_JWKS_BYTES: usize = 128 * 1024;
const CLOCK_SKEW_SECONDS: i64 = 60;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderRegistry {
    #[serde(default)]
    providers: Vec<ProviderConfig>,
}

/// 一个显式允许的标准 OIDC provider。/ One explicitly allowlisted standard OIDC provider.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderConfig {
    provider_id: String,
    display_name: String,
    issuer: String,
    discovery_endpoint: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    client_id: String,
    client_secret_binding: String,
    scope: String,
    allowed_signing_algorithms: Vec<String>,
    policy_revision: i64,
    #[serde(default)]
    authentication_enabled: bool,
    #[serde(default)]
    enabled: bool,
}

#[derive(Serialize)]
struct ProviderView<'a> {
    provider_id: &'a str,
    display_name: &'a str,
    authentication_enabled: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CreateTransactionRequest {
    provider_id: String,
}

#[derive(Serialize)]
struct TransactionView<'a> {
    transaction_id: &'a str,
    provider_id: &'a str,
    authorization_uri: &'a str,
    expires_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtectedTransaction {
    provider_state: String,
    pkce_verifier: String,
    oidc_nonce: String,
}

#[derive(Debug, Deserialize)]
struct DiscoveryDocument {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    #[serde(default)]
    id_token_signing_alg_values_supported: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    id_token: String,
}

#[derive(Debug, Deserialize)]
struct JsonWebKeySet {
    keys: Vec<Value>,
}

#[derive(Debug)]
enum ProviderFailure {
    Invalid(&'static str),
    Temporary(&'static str),
}

/// 当前部署是否声明了至少一个结构有效的 enabled provider。
/// Whether this deployment declares at least one structurally valid enabled provider.
#[must_use]
pub fn is_enabled(env: &Env) -> bool {
    env.secret(TRANSACTION_KEY_BINDING).is_ok()
        && provider_registry(env).is_ok_and(|registry| {
            registry.providers.iter().any(|provider| {
                provider.enabled && env.secret(&provider.client_secret_binding).is_ok()
            })
        })
}

/// 列出显式启用的 provider；无用户输入能够添加 issuer。
/// Lists explicitly enabled providers; no user input can introduce an issuer.
pub async fn list_providers(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    if authenticated_session(&request, &context.env, false)
        .await?
        .is_none()
    {
        return problem::response(
            "authentication_failed",
            "Authentication is required",
            401,
            &correlation,
        );
    }
    let registry = match provider_registry(&context.env) {
        Ok(value) => value,
        Err(_) => return unavailable(&correlation),
    };
    let db = context.d1("DB")?;
    let mut items = Vec::new();
    for provider in &registry.providers {
        if provider.enabled
            && context.env.secret(&provider.client_secret_binding).is_ok()
            && context.env.secret(TRANSACTION_KEY_BINDING).is_ok()
            && repo::provider_configuration_matches(&db, &provider.repository_view()).await?
        {
            items.push(ProviderView {
                provider_id: &provider.provider_id,
                display_name: &provider.display_name,
                authentication_enabled: provider.authentication_enabled,
            });
        }
    }
    json(
        &serde_json::json!({"items":items}),
        200,
        &correlation,
        &context.env,
    )
}

/// 列出当前账号的非敏感 Binding 投影。
/// Lists non-sensitive binding projections for the current account.
pub async fn list_self(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(session) = authenticated_session(&request, &context.env, false).await? else {
        return problem::response(
            "authentication_failed",
            "Authentication is required",
            401,
            &correlation,
        );
    };
    let values = repo::bindings(&context.d1("DB")?, &session.principal_id).await?;
    let items: Vec<_> = values
        .into_iter()
        .map(|binding| {
            let display_label = serde_json::from_str::<Value>(&binding.metadata_json)
                .ok()
                .and_then(|value| value.get("display_label")?.as_str().map(str::to_owned));
            serde_json::json!({
                "binding_id":binding.binding_id,
                "provider_id":binding.provider_id,
                "kind":"federated_human",
                "display_label":display_label,
                "authentication_enabled":binding.authentication_enabled,
                "created_at":date_time(binding.created_at),
                "last_authenticated_at":binding.last_authenticated_at.map(date_time),
            })
        })
        .collect();
    json(
        &serde_json::json!({"items":items}),
        200,
        &correlation,
        &context.env,
    )
}

/// 在近期 Passkey 再认证后撤销 Binding 及其 federated sessions。
/// Revokes a binding and its federated sessions after recent Passkey reauthentication.
pub async fn revoke_self(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    if let Err(response) = mutation_boundary(&request, &context.env, &correlation, false) {
        return response;
    }
    let Some(session) = authenticated_session(&request, &context.env, true).await? else {
        return problem::response(
            "reauthentication_required",
            "Recent Passkey authentication is required",
            401,
            &correlation,
        );
    };
    let Some(binding_id) = context.param("binding_id") else {
        return problem::response("invalid_request", "Invalid binding", 400, &correlation);
    };
    if binding_id.parse::<BindingId>().is_err() {
        return problem::response("invalid_request", "Invalid binding", 400, &correlation);
    }
    let db = context.d1("DB")?;
    match repo::binding_active(&db, &session.principal_id, binding_id).await? {
        None => return problem::response("not_found", "Binding was not found", 404, &correlation),
        Some(false) => return no_content(&correlation, &context.env),
        Some(true) => {}
    }
    let now = now_seconds();
    let audit_id = AuditEventId::new_v7(worker::Date::now().as_millis()).to_string();
    let committed = repo::revoke_binding(
        &db,
        &session.principal_id,
        binding_id,
        &session.session_id,
        &audit_id,
        &correlation,
        now,
        now - STEP_UP_SECONDS,
    )
    .await?;
    if !committed
        && repo::binding_active(&db, &session.principal_id, binding_id).await? != Some(false)
    {
        return problem::response(
            "reauthentication_required",
            "Recent Passkey authentication is required",
            401,
            &correlation,
        );
    }
    no_content(&correlation, &context.env)
}

/// 创建 browser-bound OIDC Authorization Code + PKCE S256 Binding 事务。
/// Creates a browser-bound OIDC Authorization Code + PKCE S256 binding transaction.
pub async fn create_transaction(
    mut request: Request,
    context: RouteContext<()>,
) -> Result<Response> {
    let correlation = correlation_id();
    if let Err(response) = mutation_boundary(&request, &context.env, &correlation, true) {
        return response;
    }
    let Some(session) = authenticated_session(&request, &context.env, true).await? else {
        return problem::response(
            "reauthentication_required",
            "Recent Passkey authentication is required",
            401,
            &correlation,
        );
    };
    let input: CreateTransactionRequest = match request.json().await {
        Ok(value) => value,
        Err(_) => {
            return problem::response("invalid_request", "Invalid JSON request", 400, &correlation);
        }
    };
    let registry = match provider_registry(&context.env) {
        Ok(value) => value,
        Err(_) => return unavailable(&correlation),
    };
    let Some(provider) = registry
        .providers
        .iter()
        .find(|provider| provider.enabled && provider.provider_id == input.provider_id)
    else {
        return problem::response("not_found", "Provider was not found", 404, &correlation);
    };
    if context.env.secret(&provider.client_secret_binding).is_err()
        || context.env.secret(TRANSACTION_KEY_BINDING).is_err()
    {
        return unavailable(&correlation);
    }

    let db = context.d1("DB")?;
    let now = now_seconds();
    if !repo::provider_configuration_matches(&db, &provider.repository_view()).await? {
        return unavailable(&correlation);
    }
    let idempotency_key = guard::header(request.headers(), "idempotency-key")
        .ok_or_else(|| Error::RustError("validated Idempotency-Key disappeared".into()))?;
    let request_digest = Sha256::digest(serde_json::to_vec(&input)?);
    if let Some(existing) =
        repo::idempotency_result(&db, &session.principal_id, &idempotency_key, now).await?
    {
        return replay_transaction(
            &db,
            provider,
            &session.principal_id,
            &existing,
            &request_digest,
            &context.env,
            &correlation,
            now,
        )
        .await;
    }
    let transaction_id = TransactionId::new_v7(worker::Date::now().as_millis()).to_string();
    let provider_state = random_wire(32);
    let protected = ProtectedTransaction {
        provider_state: provider_state.clone(),
        pkce_verifier: random_wire(32),
        oidc_nonce: random_wire(32),
    };
    let (ciphertext, nonce) = seal_transaction(
        &protected,
        &secret(&context.env, TRANSACTION_KEY_BINDING)?,
        &transaction_id,
        provider.policy_revision,
    )?;
    let redirect_uri = callback_uri(&context.env)?;
    let csrf = guard::header(request.headers(), "x-moesegfault-csrf")
        .ok_or_else(|| Error::RustError("validated CSRF header disappeared".into()))?;
    let csrf_digest = SecretDigest::hmac(
        secret(&context.env, "TRANSACTION_PEPPER")?.as_bytes(),
        csrf.as_bytes(),
    );
    let expires_at = now + TRANSACTION_SECONDS;
    let insert = repo::insert_transaction(
        &db,
        &transaction_id,
        &session.principal_id,
        &provider.provider_id,
        &session.session_id,
        &Sha256::digest(provider_state.as_bytes()),
        &ciphertext,
        &nonce,
        TRANSACTION_KEY_REVISION,
        &csrf_digest.0,
        redirect_uri.as_str(),
        provider.policy_revision,
        now,
        expires_at,
        &TransactionId::new_v7(worker::Date::now().as_millis()).to_string(),
        &idempotency_key,
        &request_digest,
    )
    .await;
    if let Err(error) = insert {
        if is_unique_conflict(&error)
            && let Some(existing) =
                repo::idempotency_result(&db, &session.principal_id, &idempotency_key, now).await?
        {
            return replay_transaction(
                &db,
                provider,
                &session.principal_id,
                &existing,
                &request_digest,
                &context.env,
                &correlation,
                now,
            )
            .await;
        }
        return Err(error);
    }

    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(protected.pkce_verifier.as_bytes()));
    let authorization_uri = provider.authorization_uri(
        redirect_uri.as_str(),
        &provider_state,
        &challenge,
        &protected.oidc_nonce,
    )?;
    json(
        &TransactionView {
            transaction_id: &transaction_id,
            provider_id: &provider.provider_id,
            authorization_uri: authorization_uri.as_str(),
            expires_at: date_time(expires_at),
        },
        201,
        &correlation,
        &context.env,
    )
}

/// 从加密事务材料重建同一授权 URL，不把 state 放入幂等表。
/// Reconstructs the same authorization URL from encrypted transaction material without placing
/// state in the idempotency table.
#[allow(clippy::too_many_arguments)]
async fn replay_transaction(
    db: &worker::D1Database,
    provider: &ProviderConfig,
    principal_id: &str,
    record: &repo::IdempotencyResult,
    request_digest: &[u8],
    env: &Env,
    correlation: &str,
    now: i64,
) -> Result<Response> {
    if record.request_digest.len() != request_digest.len()
        || !bool::from(record.request_digest.ct_eq(request_digest))
    {
        return problem::response(
            "idempotency_conflict",
            "Idempotency-Key was used for another request",
            409,
            correlation,
        );
    }
    let Some(transaction_id) = record.result_reference.as_deref() else {
        return problem::response(
            "idempotency_result_unavailable",
            "Idempotent result is unavailable",
            409,
            correlation,
        );
    };
    let Some(tx) = repo::transaction_by_id(db, transaction_id, principal_id, now).await? else {
        return problem::response(
            "idempotency_result_unavailable",
            "Idempotent result is unavailable",
            409,
            correlation,
        );
    };
    if tx.state != "pending"
        || tx.provider_id != provider.provider_id
        || tx.policy_revision != provider.policy_revision
        || tx.redirect_uri != callback_uri(env)?.as_str()
    {
        return problem::response(
            "idempotency_result_unavailable",
            "Idempotent result is unavailable",
            409,
            correlation,
        );
    }
    let protected = open_transaction(
        &tx.pkce_verifier_ciphertext,
        &tx.pkce_verifier_nonce,
        &secret(env, TRANSACTION_KEY_BINDING)?,
        &tx.transaction_id,
        tx.pkce_key_revision,
    )?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(protected.pkce_verifier.as_bytes()));
    let authorization_uri = provider.authorization_uri(
        &tx.redirect_uri,
        &protected.provider_state,
        &challenge,
        &protected.oidc_nonce,
    )?;
    json(
        &TransactionView {
            transaction_id: &tx.transaction_id,
            provider_id: &provider.provider_id,
            authorization_uri: authorization_uri.as_str(),
            expires_at: date_time(tx.expires_at),
        },
        201,
        correlation,
        env,
    )
}

/// 验证 provider metadata、code、ID Token 与原会话后原子建立 Binding。
/// Validates provider metadata, code, ID Token, and the originating session before atomically
/// creating a binding.
pub async fn callback(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let query = request
        .url()?
        .query_pairs()
        .into_owned()
        .collect::<Vec<_>>();
    let state = unique_query(&query, "state");
    if !state.is_some_and(|value| (32..=1024).contains(&value.len())) {
        return problem::response(
            "invalid_request",
            "Invalid provider callback",
            400,
            &correlation,
        );
    }
    let state = state.expect("validated option");
    let now = now_seconds();
    let db = context.d1("DB")?;
    let Some(tx) = repo::transaction_by_state(
        &db,
        &Sha256::digest(state.as_bytes()),
        now,
        now - STEP_UP_SECONDS,
    )
    .await?
    else {
        return problem::response(
            "invalid_transaction",
            "Invalid or expired binding transaction",
            404,
            &correlation,
        );
    };

    let request_digest = Sha256::digest(
        query
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&")
            .as_bytes(),
    );
    if ["code", "iss", "error"]
        .iter()
        .any(|name| query_count(&query, name) > 1)
    {
        consume_failure(
            &db,
            &tx,
            &request_digest,
            &correlation,
            "duplicate_callback_parameter",
            now,
        )
        .await?;
        return problem::response(
            "invalid_request",
            "Invalid provider callback",
            400,
            &correlation,
        );
    }
    let registry = match provider_registry(&context.env) {
        Ok(value) => value,
        Err(_) => return unavailable(&correlation),
    };
    let Some(provider) = registry
        .providers
        .iter()
        .find(|provider| provider.enabled && provider.provider_id == tx.provider_id)
    else {
        return unavailable(&correlation);
    };
    if !repo::provider_configuration_matches(&db, &provider.repository_view()).await? {
        return unavailable(&correlation);
    }
    if provider.policy_revision != tx.policy_revision
        || callback_uri(&context.env)?.as_str() != tx.redirect_uri
    {
        return unavailable(&correlation);
    }

    if let Some(authorization_issuer) = unique_query(&query, "iss")
        && authorization_issuer != provider.issuer
    {
        consume_failure(
            &db,
            &tx,
            &request_digest,
            &correlation,
            "issuer_mismatch",
            now,
        )
        .await?;
        return redirect_to_completion(&context.env, "failed", &correlation);
    }
    if unique_query(&query, "error").is_some() {
        consume_failure(
            &db,
            &tx,
            &request_digest,
            &correlation,
            "provider_denied",
            now,
        )
        .await?;
        return redirect_to_completion(&context.env, "cancelled", &correlation);
    }
    let Some(code) = unique_query(&query, "code").filter(|value| (1..=2048).contains(&value.len()))
    else {
        consume_failure(
            &db,
            &tx,
            &request_digest,
            &correlation,
            "invalid_callback",
            now,
        )
        .await?;
        return problem::response(
            "invalid_request",
            "Invalid provider callback",
            400,
            &correlation,
        );
    };
    let protected = open_transaction(
        &tx.pkce_verifier_ciphertext,
        &tx.pkce_verifier_nonce,
        &secret(&context.env, TRANSACTION_KEY_BINDING)?,
        &tx.transaction_id,
        tx.pkce_key_revision,
    )?;
    if protected.provider_state.len() != state.len()
        || !bool::from(protected.provider_state.as_bytes().ct_eq(state.as_bytes()))
    {
        return problem::response(
            "invalid_transaction",
            "Invalid binding transaction",
            409,
            &correlation,
        );
    }

    let validation = validate_provider_callback(
        provider,
        code,
        &tx.redirect_uri,
        &protected.pkce_verifier,
        &protected.oidc_nonce,
        &context.env,
        now_seconds(),
    )
    .await;
    let subject = match validation {
        Ok(subject) => subject,
        Err(ProviderFailure::Temporary(reason)) => {
            worker::console_warn!(
                "binding_provider_temporarily_unavailable provider_id={} reason={} correlation_id={}",
                provider.provider_id,
                reason,
                correlation
            );
            return unavailable(&correlation);
        }
        Err(ProviderFailure::Invalid(reason)) => {
            consume_failure(&db, &tx, &request_digest, &correlation, reason, now).await?;
            return redirect_to_completion(&context.env, "failed", &correlation);
        }
    };

    let commit_now = now_seconds();
    let binding_id = BindingId::new_v7(worker::Date::now().as_millis()).to_string();
    let audit_id = AuditEventId::new_v7(worker::Date::now().as_millis()).to_string();
    match repo::commit_binding(
        &db,
        &tx,
        &binding_id,
        &provider.issuer,
        &subject,
        provider.authentication_enabled,
        &request_digest,
        &audit_id,
        &correlation,
        commit_now,
        commit_now - STEP_UP_SECONDS,
    )
    .await
    {
        Ok(()) => redirect_to_completion(&context.env, "success", &correlation),
        Err(error) if is_transaction_not_consumable(&error) => problem::response(
            "invalid_transaction",
            "Binding transaction is no longer consumable",
            409,
            &correlation,
        ),
        Err(error) if is_unique_conflict(&error) => {
            consume_failure(
                &db,
                &tx,
                &request_digest,
                &correlation,
                "binding_conflict",
                commit_now,
            )
            .await?;
            problem::response(
                "binding_conflict",
                "External identity is already bound",
                409,
                &correlation,
            )
        }
        Err(error) => Err(error),
    }
}

impl ProviderConfig {
    fn validate(&self) -> std::result::Result<(), ()> {
        if !valid_provider_id(&self.provider_id)
            || self.display_name.trim().is_empty()
            || self.display_name.chars().count() > 80
            || self.client_id.is_empty()
            || self.client_id.len() > 255
            || !valid_secret_binding(&self.client_secret_binding)
            || self.client_secret_binding != expected_client_secret_binding(&self.provider_id)
            || self.policy_revision < 1
            || self.scope.len() > 512
            || !self
                .scope
                .split_ascii_whitespace()
                .any(|scope| scope == "openid")
            || self.allowed_signing_algorithms.is_empty()
            || self
                .allowed_signing_algorithms
                .iter()
                .any(|algorithm| !matches!(algorithm.as_str(), "RS256" | "ES256"))
        {
            return Err(());
        }
        for endpoint in [
            &self.issuer,
            &self.discovery_endpoint,
            &self.authorization_endpoint,
            &self.token_endpoint,
            &self.jwks_uri,
        ] {
            validate_https_url(endpoint)?;
        }
        if Url::parse(&self.issuer).map_err(|_| ())?.query().is_some() {
            return Err(());
        }
        Ok(())
    }

    fn repository_view(&self) -> repo::RegistryProvider<'_> {
        repo::RegistryProvider {
            provider_id: &self.provider_id,
            issuer: &self.issuer,
            display_name: &self.display_name,
            authorization_endpoint: &self.authorization_endpoint,
            token_endpoint: &self.token_endpoint,
            jwks_uri: &self.jwks_uri,
            client_id: &self.client_id,
            scope: &self.scope,
            policy_revision: self.policy_revision,
            authentication_enabled: self.authentication_enabled,
        }
    }

    fn authorization_uri(
        &self,
        redirect_uri: &str,
        state: &str,
        challenge: &str,
        nonce: &str,
    ) -> Result<Url> {
        let mut url = Url::parse(&self.authorization_endpoint)
            .map_err(|_| Error::RustError("invalid configured authorization endpoint".into()))?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("scope", &self.scope)
            .append_pair("state", state)
            .append_pair("nonce", nonce)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256");
        Ok(url)
    }
}

async fn validate_provider_callback(
    provider: &ProviderConfig,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
    nonce: &str,
    env: &Env,
    now: i64,
) -> std::result::Result<String, ProviderFailure> {
    verify_discovery(provider).await?;
    // Fetch keys before exchanging the one-time code. A transient metadata/JWKS failure can then
    // be retried without attempting to reuse a code already consumed by the provider.
    let jwks = fetch_json_get(&provider.jwks_uri, MAX_JWKS_BYTES).await?;
    let client_secret = env
        .secret(&provider.client_secret_binding)
        .map_err(|_| ProviderFailure::Temporary("missing_client_secret"))?
        .to_string();
    let token = exchange_code(provider, code, redirect_uri, verifier, &client_secret).await?;
    validate_id_token(provider, &token.id_token, nonce, now, &jwks).await
}

async fn verify_discovery(provider: &ProviderConfig) -> std::result::Result<(), ProviderFailure> {
    let bytes = fetch_json_get(&provider.discovery_endpoint, MAX_METADATA_BYTES).await?;
    let metadata: DiscoveryDocument = serde_json::from_slice(&bytes)
        .map_err(|_| ProviderFailure::Temporary("invalid_discovery_document"))?;
    if metadata.issuer != provider.issuer
        || metadata.authorization_endpoint != provider.authorization_endpoint
        || metadata.token_endpoint != provider.token_endpoint
        || metadata.jwks_uri != provider.jwks_uri
        || !provider.allowed_signing_algorithms.iter().all(|algorithm| {
            metadata
                .id_token_signing_alg_values_supported
                .contains(algorithm)
        })
    {
        return Err(ProviderFailure::Temporary(
            "discovery_configuration_mismatch",
        ));
    }
    Ok(())
}

async fn exchange_code(
    provider: &ProviderConfig,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
    client_secret: &str,
) -> std::result::Result<TokenResponse, ProviderFailure> {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer
        .append_pair("grant_type", "authorization_code")
        .append_pair("code", code)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("code_verifier", verifier);
    let body = serializer.finish();
    let encoded_id: String =
        url::form_urlencoded::byte_serialize(provider.client_id.as_bytes()).collect();
    let encoded_secret: String =
        url::form_urlencoded::byte_serialize(client_secret.as_bytes()).collect();
    let headers = Headers::new();
    headers
        .set("content-type", "application/x-www-form-urlencoded")
        .map_err(|_| ProviderFailure::Temporary("token_request_headers"))?;
    headers
        .set(
            "authorization",
            &format!(
                "Basic {}",
                STANDARD.encode(format!("{encoded_id}:{encoded_secret}"))
            ),
        )
        .map_err(|_| ProviderFailure::Temporary("token_request_headers"))?;
    headers
        .set("accept", "application/json")
        .map_err(|_| ProviderFailure::Temporary("token_request_headers"))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error)
        .with_body(Some(body.into()));
    let request = Request::new_with_init(&provider.token_endpoint, &init)
        .map_err(|_| ProviderFailure::Temporary("token_request_construction"))?;
    let mut response = Fetch::Request(request)
        .send()
        .await
        .map_err(|_| ProviderFailure::Temporary("token_endpoint_unavailable"))?;
    match response.status_code() {
        200 => {}
        400..=499 => return Err(ProviderFailure::Invalid("code_exchange_rejected")),
        _ => return Err(ProviderFailure::Temporary("token_endpoint_unavailable")),
    }
    require_json_content_type(&response)
        .map_err(|_| ProviderFailure::Invalid("invalid_token_response"))?;
    let bytes = read_limited(&mut response, MAX_TOKEN_BYTES)
        .await
        .map_err(|_| ProviderFailure::Invalid("invalid_token_response"))?;
    let token: TokenResponse = serde_json::from_slice(&bytes)
        .map_err(|_| ProviderFailure::Invalid("invalid_token_response"))?;
    if token.id_token.len() > 16 * 1024 {
        return Err(ProviderFailure::Invalid("invalid_token_response"));
    }
    Ok(token)
}

async fn validate_id_token(
    provider: &ProviderConfig,
    wire: &str,
    expected_nonce: &str,
    now: i64,
    jwks_bytes: &[u8],
) -> std::result::Result<String, ProviderFailure> {
    let parsed =
        webcrypto::parse_jwt(wire).map_err(|_| ProviderFailure::Invalid("malformed_id_token"))?;
    let header = parsed
        .header
        .as_object()
        .ok_or(ProviderFailure::Invalid("malformed_id_token"))?;
    if header.contains_key("jku")
        || header.contains_key("x5u")
        || header.contains_key("jwk")
        || header.contains_key("crit")
        || header
            .get("typ")
            .is_some_and(|value| value.as_str() != Some("JWT"))
    {
        return Err(ProviderFailure::Invalid("invalid_id_token_header"));
    }
    let algorithm = header
        .get("alg")
        .and_then(Value::as_str)
        .ok_or(ProviderFailure::Invalid("invalid_id_token_header"))?;
    if !provider
        .allowed_signing_algorithms
        .iter()
        .any(|allowed| allowed == algorithm)
    {
        return Err(ProviderFailure::Invalid("disallowed_id_token_algorithm"));
    }
    let kid = header
        .get("kid")
        .and_then(Value::as_str)
        .filter(|kid| !kid.is_empty() && kid.len() <= 255)
        .ok_or(ProviderFailure::Invalid("invalid_id_token_header"))?;
    let jwks: JsonWebKeySet =
        serde_json::from_slice(jwks_bytes).map_err(|_| ProviderFailure::Invalid("invalid_jwks"))?;
    let candidates: Vec<_> = jwks
        .keys
        .iter()
        .filter(|jwk| jwk.get("kid").and_then(Value::as_str) == Some(kid))
        .filter(|jwk| valid_jwk_for_algorithm(jwk, algorithm))
        .collect();
    let [jwk] = candidates.as_slice() else {
        return Err(ProviderFailure::Invalid("signing_key_unavailable"));
    };
    let jwk_json =
        serde_json::to_string(jwk).map_err(|_| ProviderFailure::Invalid("invalid_jwks"))?;
    let signature_valid = webcrypto::verify_jwt_signature(&parsed, algorithm, &jwk_json)
        .await
        .map_err(|_| ProviderFailure::Invalid("invalid_id_token_signature"))?;
    if !signature_valid {
        return Err(ProviderFailure::Invalid("invalid_id_token_signature"));
    }
    validate_claims(&parsed.claims, provider, expected_nonce, now)
}

fn validate_claims(
    claims: &Value,
    provider: &ProviderConfig,
    expected_nonce: &str,
    now: i64,
) -> std::result::Result<String, ProviderFailure> {
    let claims = claims
        .as_object()
        .ok_or(ProviderFailure::Invalid("invalid_id_token_claims"))?;
    if claims.get("iss").and_then(Value::as_str) != Some(provider.issuer.as_str()) {
        return Err(ProviderFailure::Invalid("issuer_mismatch"));
    }
    let audiences = audiences(
        claims
            .get("aud")
            .ok_or(ProviderFailure::Invalid("audience_mismatch"))?,
    )?;
    if !audiences
        .iter()
        .any(|audience| audience == &provider.client_id)
    {
        return Err(ProviderFailure::Invalid("audience_mismatch"));
    }
    let authorized_party = claims.get("azp").and_then(Value::as_str);
    if (audiences.len() > 1 || authorized_party.is_some())
        && authorized_party != Some(provider.client_id.as_str())
    {
        return Err(ProviderFailure::Invalid("authorized_party_mismatch"));
    }
    let exp = integer_claim(claims.get("exp"))?;
    let issued_at = integer_claim(claims.get("iat"))?;
    if exp <= now - CLOCK_SKEW_SECONDS || issued_at > now + CLOCK_SKEW_SECONDS {
        return Err(ProviderFailure::Invalid("id_token_time_invalid"));
    }
    if let Some(not_before) = claims.get("nbf") {
        if integer_claim(Some(not_before))? > now + CLOCK_SKEW_SECONDS {
            return Err(ProviderFailure::Invalid("id_token_time_invalid"));
        }
    }
    let nonce = claims
        .get("nonce")
        .and_then(Value::as_str)
        .ok_or(ProviderFailure::Invalid("nonce_mismatch"))?;
    if nonce.len() != expected_nonce.len()
        || !bool::from(nonce.as_bytes().ct_eq(expected_nonce.as_bytes()))
    {
        return Err(ProviderFailure::Invalid("nonce_mismatch"));
    }
    let subject = claims
        .get("sub")
        .and_then(Value::as_str)
        .filter(|subject| !subject.is_empty() && subject.len() <= 512)
        .ok_or(ProviderFailure::Invalid("invalid_subject"))?;
    Ok(subject.to_owned())
}

fn audiences(value: &Value) -> std::result::Result<Vec<String>, ProviderFailure> {
    if let Some(single) = value.as_str() {
        return (!single.is_empty())
            .then(|| vec![single.to_owned()])
            .ok_or(ProviderFailure::Invalid("audience_mismatch"));
    }
    let values = value
        .as_array()
        .ok_or(ProviderFailure::Invalid("audience_mismatch"))?;
    if values.is_empty() {
        return Err(ProviderFailure::Invalid("audience_mismatch"));
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .ok_or(ProviderFailure::Invalid("audience_mismatch"))
        })
        .collect()
}

fn integer_claim(value: Option<&Value>) -> std::result::Result<i64, ProviderFailure> {
    value
        .and_then(Value::as_i64)
        .ok_or(ProviderFailure::Invalid("id_token_time_invalid"))
}

fn valid_jwk_for_algorithm(jwk: &Value, algorithm: &str) -> bool {
    let Some(object) = jwk.as_object() else {
        return false;
    };
    if ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]
        .iter()
        .any(|field| object.contains_key(*field))
        || object
            .get("use")
            .is_some_and(|value| value.as_str() != Some("sig"))
        || object
            .get("alg")
            .is_some_and(|value| value.as_str() != Some(algorithm))
        || object.get("key_ops").is_some_and(|value| {
            !value
                .as_array()
                .is_some_and(|ops| ops.iter().any(|op| op.as_str() == Some("verify")))
        })
    {
        return false;
    }
    match algorithm {
        "RS256" => {
            object.get("kty").and_then(Value::as_str) == Some("RSA")
                && object
                    .get("n")
                    .and_then(Value::as_str)
                    .is_some_and(|v| !v.is_empty())
                && object
                    .get("e")
                    .and_then(Value::as_str)
                    .is_some_and(|v| !v.is_empty())
        }
        "ES256" => {
            object.get("kty").and_then(Value::as_str) == Some("EC")
                && object.get("crv").and_then(Value::as_str) == Some("P-256")
                && object
                    .get("x")
                    .and_then(Value::as_str)
                    .is_some_and(|v| !v.is_empty())
                && object
                    .get("y")
                    .and_then(Value::as_str)
                    .is_some_and(|v| !v.is_empty())
        }
        _ => false,
    }
}

async fn fetch_json_get(
    endpoint: &str,
    limit: usize,
) -> std::result::Result<Vec<u8>, ProviderFailure> {
    let headers = Headers::new();
    headers
        .set("accept", "application/json")
        .map_err(|_| ProviderFailure::Temporary("request_headers"))?;
    let mut init = RequestInit::new();
    init.with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    let request = Request::new_with_init(endpoint, &init)
        .map_err(|_| ProviderFailure::Temporary("request_construction"))?;
    let mut response = Fetch::Request(request)
        .send()
        .await
        .map_err(|_| ProviderFailure::Temporary("provider_unavailable"))?;
    if response.status_code() != 200 {
        return Err(ProviderFailure::Temporary("provider_unavailable"));
    }
    require_json_content_type(&response)?;
    read_limited(&mut response, limit).await
}

fn require_json_content_type(response: &Response) -> std::result::Result<(), ProviderFailure> {
    let content_type = response
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_default();
    let media_type = content_type.split(';').next().unwrap_or_default().trim();
    if matches!(media_type, "application/json" | "application/jwk-set+json") {
        Ok(())
    } else {
        Err(ProviderFailure::Temporary("provider_response_content_type"))
    }
}

async fn read_limited(
    response: &mut Response,
    limit: usize,
) -> std::result::Result<Vec<u8>, ProviderFailure> {
    if response
        .headers()
        .get("content-length")
        .ok()
        .flatten()
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > limit)
    {
        return Err(ProviderFailure::Temporary("provider_response_too_large"));
    }
    if let ResponseBody::Body(bytes) = response.body().clone() {
        return (bytes.len() <= limit)
            .then_some(bytes)
            .ok_or(ProviderFailure::Temporary("provider_response_too_large"));
    }
    let mut stream = response
        .stream()
        .map_err(|_| ProviderFailure::Temporary("provider_response_body"))?;
    let mut bytes = Vec::new();
    while let Some(mut chunk) = stream
        .try_next()
        .await
        .map_err(|_| ProviderFailure::Temporary("provider_response_body"))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(ProviderFailure::Temporary("provider_response_too_large"));
        }
        bytes.append(&mut chunk);
    }
    Ok(bytes)
}

fn provider_registry(env: &Env) -> std::result::Result<ProviderRegistry, ()> {
    let wire = match env.var(CONFIG_BINDING) {
        Ok(value) => value.to_string(),
        Err(_) => {
            return Ok(ProviderRegistry {
                providers: Vec::new(),
            });
        }
    };
    let registry: ProviderRegistry = serde_json::from_str(&wire).map_err(|_| ())?;
    if registry.providers.len() > 16 {
        return Err(());
    }
    for (index, provider) in registry.providers.iter().enumerate() {
        provider.validate()?;
        if registry.providers[..index].iter().any(|other| {
            other.provider_id == provider.provider_id || other.issuer == provider.issuer
        }) {
            return Err(());
        }
    }
    Ok(registry)
}

fn validate_https_url(value: &str) -> std::result::Result<(), ()> {
    let url = Url::parse(value).map_err(|_| ())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(());
    }
    Ok(())
}

fn valid_provider_id(value: &str) -> bool {
    (2..=32).contains(&value.len())
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte))
}

fn valid_secret_binding(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn expected_client_secret_binding(provider_id: &str) -> String {
    format!(
        "BINDING_PROVIDER_{}_CLIENT_SECRET",
        provider_id.replace('-', "_").to_ascii_uppercase()
    )
}

fn callback_uri(env: &Env) -> Result<Url> {
    let issuer = env
        .var("ISSUER")
        .map_err(|_| Error::BindingError("missing required ISSUER variable".into()))?
        .to_string();
    let issuer = Url::parse(&issuer)
        .map_err(|_| Error::BindingError("ISSUER must be an absolute URL".into()))?;
    if issuer.scheme() != "https"
        || issuer.host_str().is_none()
        || !issuer.username().is_empty()
        || issuer.password().is_some()
        || issuer.query().is_some()
        || issuer.fragment().is_some()
    {
        return Err(Error::BindingError(
            "ISSUER must be a canonical HTTPS issuer URL".into(),
        ));
    }
    issuer
        .join(CALLBACK_PATH)
        .map_err(|_| Error::BindingError("ISSUER cannot form callback URL".into()))
}

fn mutation_boundary(
    request: &Request,
    env: &Env,
    correlation: &str,
    requires_json: bool,
) -> std::result::Result<(), Result<Response>> {
    if requires_json
        && guard::header(request.headers(), "content-length")
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|length| length > MAX_REQUEST_BYTES)
    {
        return Err(problem::response(
            "invalid_request",
            "Request body is too large",
            413,
            correlation,
        ));
    }
    let guard_result = if requires_json {
        guard::validate_browser_mutation(request, env)
    } else {
        validate_bodyless_mutation(request, env)
    };
    if let Err(error) = guard_result {
        let (title, status) = match error {
            guard::GuardError::ContentType => ("JSON content type is required", 415),
            guard::GuardError::Origin => ("Origin is not allowed", 403),
            guard::GuardError::FetchMetadata => ("Invalid browser request context", 403),
            _ => ("CSRF validation failed", 403),
        };
        return Err(problem::response(
            "invalid_request",
            title,
            status,
            correlation,
        ));
    }
    let idempotency_key = guard::header(request.headers(), "idempotency-key");
    if !idempotency_key.as_deref().is_some_and(|value| {
        (16..=128).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_graphic())
    }) {
        return Err(problem::response(
            "invalid_request",
            "A valid Idempotency-Key is required",
            400,
            correlation,
        ));
    }
    let Some(wire) = guard::cookie(request, guard::SESSION_COOKIE) else {
        return Ok(());
    };
    let pepper = match secret(env, "CSRF_PEPPER") {
        Ok(value) => value,
        Err(error) => return Err(Err(error)),
    };
    if !guard::validate_session_csrf(request, &wire, pepper.as_bytes()) {
        return Err(problem::response(
            "invalid_request",
            "CSRF validation failed",
            403,
            correlation,
        ));
    }
    Ok(())
}

fn validate_bodyless_mutation(
    request: &Request,
    env: &Env,
) -> std::result::Result<(), guard::GuardError> {
    if guard::header(request.headers(), "origin").as_deref()
        != Some(guard::login_origin(env).as_str())
    {
        return Err(guard::GuardError::Origin);
    }
    if guard::header(request.headers(), "sec-fetch-site").as_deref() != Some("same-site")
        || guard::header(request.headers(), "sec-fetch-mode").as_deref() != Some("cors")
    {
        return Err(guard::GuardError::FetchMetadata);
    }
    if guard::header(request.headers(), "x-moesegfault-csrf").is_none() {
        return Err(guard::GuardError::Csrf);
    }
    Ok(())
}

async fn authenticated_session(
    request: &Request,
    env: &Env,
    recent_passkey: bool,
) -> Result<Option<repo::StepUpSession>> {
    let Some(wire) = guard::cookie(request, guard::SESSION_COOKIE) else {
        return Ok(None);
    };
    let digest = SecretDigest::hmac(secret(env, "SESSION_PEPPER")?.as_bytes(), wire.as_bytes());
    let db = env.d1("DB")?;
    let now = now_seconds();
    if recent_passkey {
        repo::recent_passkey_session(&db, &digest.0, now, now - STEP_UP_SECONDS).await
    } else {
        repo::current_session(&db, &digest.0, now).await
    }
}

async fn consume_failure(
    db: &worker::D1Database,
    tx: &repo::BindingTransactionRow,
    request_digest: &[u8],
    correlation: &str,
    reason: &str,
    now: i64,
) -> Result<()> {
    repo::commit_callback_failure(
        db,
        tx,
        request_digest,
        &AuditEventId::new_v7(worker::Date::now().as_millis()).to_string(),
        correlation,
        reason,
        now,
    )
    .await
}

fn seal_transaction(
    value: &ProtectedTransaction,
    key_wire: &str,
    transaction_id: &str,
    revision: i64,
) -> Result<(Vec<u8>, [u8; 24])> {
    let key = decode_transaction_key(key_wire)?;
    let mut nonce = [0_u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new(&Key::from(key));
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &serde_json::to_vec(value)?,
                aad: &transaction_aad(transaction_id, revision),
            },
        )
        .map_err(|_| Error::RustError("failed to protect binding transaction".into()))?;
    Ok((ciphertext, nonce))
}

fn open_transaction(
    ciphertext: &[u8],
    nonce: &[u8],
    key_wire: &str,
    transaction_id: &str,
    revision: i64,
) -> Result<ProtectedTransaction> {
    if revision != TRANSACTION_KEY_REVISION {
        return Err(Error::RustError(
            "unsupported binding transaction key revision".into(),
        ));
    }
    let nonce: [u8; 24] = nonce
        .try_into()
        .map_err(|_| Error::RustError("invalid binding transaction nonce".into()))?;
    let cipher = XChaCha20Poly1305::new(&Key::from(decode_transaction_key(key_wire)?));
    let plaintext = cipher
        .decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: ciphertext,
                aad: &transaction_aad(transaction_id, revision),
            },
        )
        .map_err(|_| Error::RustError("binding transaction authentication failed".into()))?;
    serde_json::from_slice(&plaintext)
        .map_err(|_| Error::RustError("invalid binding transaction plaintext".into()))
}

fn decode_transaction_key(value: &str) -> Result<[u8; 32]> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| Error::BindingError(format!("{TRANSACTION_KEY_BINDING} must be base64url")))?
        .try_into()
        .map_err(|_| {
            Error::BindingError(format!("{TRANSACTION_KEY_BINDING} must decode to 32 bytes"))
        })
}

fn transaction_aad(transaction_id: &str, revision: i64) -> Vec<u8> {
    format!("moesegfault.identity.binding-transaction.v1:{revision}:{transaction_id}").into_bytes()
}

fn unique_query<'a>(pairs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    let mut matches = pairs
        .iter()
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value.as_str());
    let value = matches.next()?;
    matches.next().is_none().then_some(value)
}

fn query_count(pairs: &[(String, String)], name: &str) -> usize {
    pairs.iter().filter(|(key, _)| key == name).count()
}

fn redirect_to_completion(env: &Env, status: &str, correlation: &str) -> Result<Response> {
    let origin = guard::login_origin(env);
    let mut target = Url::parse(&origin)
        .map_err(|_| Error::BindingError("LOGIN_ORIGIN must be an absolute URL".into()))?
        .join(COMPLETION_PATH)
        .map_err(|_| Error::BindingError("LOGIN_ORIGIN cannot form completion URL".into()))?;
    target.query_pairs_mut().append_pair("binding", status);
    let mut response = Response::redirect_with_status(target, 303)?;
    response.headers_mut().set("cache-control", "no-store")?;
    response
        .headers_mut()
        .set("x-moesegfault-correlation-id", correlation)?;
    Ok(response)
}

fn is_unique_conflict(error: &Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message
        .contains("unique constraint failed: identity_bindings.issuer, identity_bindings.subject")
}

fn is_transaction_not_consumable(error: &Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("binding_transaction_not_consumable")
        || message.contains("foreign key constraint")
}

fn unavailable(correlation: &str) -> Result<Response> {
    problem::response(
        "service_unavailable",
        "External identity providers are not available",
        503,
        correlation,
    )
}

fn json<T: Serialize>(value: &T, status: u16, correlation: &str, env: &Env) -> Result<Response> {
    let origin = guard::login_origin(env);
    let headers = Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("cache-control", "no-store")?;
    headers.set("access-control-allow-origin", &origin)?;
    headers.set("access-control-allow-credentials", "true")?;
    headers.set("vary", "Origin")?;
    headers.set("x-moesegfault-correlation-id", correlation)?;
    Ok(Response::from_json(value)?
        .with_status(status)
        .with_headers(headers))
}

fn no_content(correlation: &str, env: &Env) -> Result<Response> {
    let origin = guard::login_origin(env);
    let headers = Headers::new();
    headers.set("cache-control", "no-store")?;
    headers.set("access-control-allow-origin", &origin)?;
    headers.set("access-control-allow-credentials", "true")?;
    headers.set("vary", "Origin")?;
    headers.set("x-moesegfault-correlation-id", correlation)?;
    Ok(Response::empty()?.with_status(204).with_headers(headers))
}

fn secret(env: &Env, name: &str) -> Result<String> {
    env.secret(name)
        .map(|value| value.to_string())
        .map_err(|_| Error::BindingError(format!("missing required secret binding {name}")))
}

fn random_wire(length: usize) -> String {
    let mut bytes = vec![0_u8; length];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn now_seconds() -> i64 {
    (worker::Date::now().as_millis() / 1_000) as i64
}

fn correlation_id() -> String {
    TransactionId::new_v7(worker::Date::now().as_millis()).to_string()
}

fn date_time(seconds: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .expect("Workers clock is in the RFC 3339 range")
        .format(&time::format_description::well_known::Rfc3339)
        .expect("RFC 3339 formatting is infallible for a valid timestamp")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> ProviderConfig {
        ProviderConfig {
            provider_id: "example".into(),
            display_name: "Example".into(),
            issuer: "https://id.example.com/".into(),
            discovery_endpoint: "https://id.example.com/.well-known/openid-configuration".into(),
            authorization_endpoint: "https://id.example.com/authorize".into(),
            token_endpoint: "https://id.example.com/token".into(),
            jwks_uri: "https://id.example.com/jwks".into(),
            client_id: "client".into(),
            client_secret_binding: "BINDING_PROVIDER_EXAMPLE_CLIENT_SECRET".into(),
            scope: "openid profile".into(),
            allowed_signing_algorithms: vec!["RS256".into()],
            policy_revision: 1,
            authentication_enabled: false,
            enabled: true,
        }
    }

    #[test]
    fn provider_validation_rejects_non_https_and_non_oidc_configuration() {
        assert!(provider().validate().is_ok());
        let mut root_issuer = provider();
        root_issuer.issuer = "https://accounts.example.com".into();
        assert!(root_issuer.validate().is_ok());
        let mut invalid = provider();
        invalid.jwks_uri = "http://127.0.0.1/jwks".into();
        assert!(invalid.validate().is_err());
        let mut invalid = provider();
        invalid.scope = "profile email".into();
        assert!(invalid.validate().is_err());
        let mut invalid = provider();
        invalid.allowed_signing_algorithms = vec!["none".into()];
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn authorization_uri_contains_pkce_state_nonce_and_fixed_redirect() {
        let value = provider()
            .authorization_uri(
                "https://identity.example/callback",
                "state",
                "challenge",
                "nonce",
            )
            .unwrap();
        let pairs = value.query_pairs().collect::<Vec<_>>();
        for expected in [
            ("code_challenge_method", "S256"),
            ("code_challenge", "challenge"),
            ("state", "state"),
            ("nonce", "nonce"),
            ("redirect_uri", "https://identity.example/callback"),
        ] {
            assert!(
                pairs
                    .iter()
                    .any(|pair| pair.0 == expected.0 && pair.1 == expected.1)
            );
        }
    }

    #[test]
    fn protected_transaction_round_trips_and_binds_aad() {
        let key = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        let value = ProtectedTransaction {
            provider_state: "state-canary".into(),
            pkce_verifier: "pkce-canary".into(),
            oidc_nonce: "nonce-canary".into(),
        };
        let (ciphertext, nonce) = seal_transaction(&value, &key, "tx-1", 1).unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains("canary"));
        let opened = open_transaction(&ciphertext, &nonce, &key, "tx-1", 1).unwrap();
        assert_eq!(opened.pkce_verifier, value.pkce_verifier);
        assert!(open_transaction(&ciphertext, &nonce, &key, "tx-2", 1).is_err());
    }

    #[test]
    fn claim_validation_requires_issuer_audience_nonce_and_time() {
        let provider = provider();
        let claims = serde_json::json!({
            "iss":provider.issuer,
            "sub":"durable-subject",
            "aud":[provider.client_id,"secondary"],
            "azp":provider.client_id,
            "exp":1_700_000_600,
            "iat":1_700_000_000,
            "nonce":"expected",
            "email":"must-not-be-used@example.com"
        });
        assert_eq!(
            validate_claims(&claims, &provider, "expected", 1_700_000_100).unwrap(),
            "durable-subject"
        );
        let mut wrong = claims;
        wrong["nonce"] = Value::String("wrong".into());
        assert!(validate_claims(&wrong, &provider, "expected", 1_700_000_100).is_err());
    }

    #[test]
    fn jwk_filter_rejects_private_or_algorithm_confused_keys() {
        let public = serde_json::json!({"kty":"RSA","kid":"1","alg":"RS256","use":"sig","n":"abc","e":"AQAB"});
        assert!(valid_jwk_for_algorithm(&public, "RS256"));
        let mut private = public.clone();
        private["d"] = Value::String("secret".into());
        assert!(!valid_jwk_for_algorithm(&private, "RS256"));
        assert!(!valid_jwk_for_algorithm(&public, "ES256"));
    }

    #[test]
    fn duplicate_query_values_are_rejected() {
        let pairs = vec![("state".into(), "a".into()), ("state".into(), "b".into())];
        assert_eq!(unique_query(&pairs, "state"), None);
    }
}
