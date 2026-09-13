//! OAuth 2.0 / OpenID Connect HTTP 协议适配器。/ OAuth 2.0 / OpenID Connect HTTP adapter.
//!
//! 浏览器只携带不可解释的事务句柄；原始请求、code 与 refresh family 状态全部保留在 D1。
//! The browser carries only opaque transaction handles; original requests,
//! codes, and refresh-family state remain authoritative in D1.

use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use identity_domain::{SecretDigest, TokenFamilyId, TransactionId};
use rand::{RngCore as _, rngs::OsRng};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;
use uuid::Uuid;
use worker::*;

use crate::{guard, oauth_repository as repo, repository, webcrypto};

const FORM_LIMIT: u64 = 16 * 1024;
const CLIENT_ASSERTION_TYPE: &str = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/// 仅在签发配置完整时公开 OIDC discovery。/ Publishes discovery only when issuance configuration is complete.
pub async fn discovery(_request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some((issuer, _, _, _)) = issuance_config(&context.env) else {
        return oauth_problem(
            "temporarily_unavailable",
            "OIDC issuance is not configured",
            503,
            &correlation,
        );
    };
    public_json(
        &json!({
            "issuer":issuer,
            "authorization_endpoint":format!("{issuer}/v1/oauth/authorizations"),
            "token_endpoint":format!("{issuer}/v1/oauth/tokens"),
            "revocation_endpoint":format!("{issuer}/v1/oauth/revocations"),
            "userinfo_endpoint":format!("{issuer}/v1/oidc/user-claims"),
            "jwks_uri":format!("{issuer}/.well-known/jwks.json"),
            "end_session_endpoint":format!("{issuer}/v1/oidc/logout-requests"),
            "authorization_response_iss_parameter_supported":true,
            "response_types_supported":["code"], "response_modes_supported":["query"],
            "grant_types_supported":["authorization_code","refresh_token"],
            "subject_types_supported":["pairwise"], "id_token_signing_alg_values_supported":["RS256"],
            "scopes_supported":["openid","profile","offline_access"],
            "token_endpoint_auth_methods_supported":["private_key_jwt","none"],
            "token_endpoint_auth_signing_alg_values_supported":["RS256","ES256"],
            "code_challenge_methods_supported":["S256"],
            "claims_supported":["sub","name","preferred_username"]
        }),
        &correlation,
    )
}

/// 发布不包含私钥参数的 JWK Set。/ Publishes a JWK Set containing no private parameters.
pub async fn jwks(_request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some((_, _, _, jwks)) = issuance_config(&context.env) else {
        return oauth_problem(
            "temporarily_unavailable",
            "OIDC signing keys are not configured",
            503,
            &correlation,
        );
    };
    public_json(&jwks, &correlation)
}

/// 验证 authorization request 并创建服务端事务。/ Validates an authorization request and creates server-side state.
pub async fn authorize(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some((issuer, _, _, _)) = issuance_config(&context.env) else {
        return oauth_problem(
            "temporarily_unavailable",
            "OIDC issuance is not configured",
            503,
            &correlation,
        );
    };
    if !is_top_navigation(&request) {
        return protocol_problem(
            "invalid_request",
            "Authorization requires a top-level navigation",
            400,
            &correlation,
        );
    }
    let query = match unique_fields(request.url()?.query().unwrap_or_default(), 12) {
        Ok(fields) => fields,
        Err(_) => {
            return protocol_problem(
                "invalid_request",
                "Malformed authorization request",
                400,
                &correlation,
            );
        }
    };
    if !only_fields(
        &query,
        &[
            "client_id",
            "redirect_uri",
            "response_type",
            "scope",
            "state",
            "nonce",
            "code_challenge",
            "code_challenge_method",
            "prompt",
        ],
    ) {
        return protocol_problem(
            "invalid_request",
            "Unexpected authorization parameter",
            400,
            &correlation,
        );
    }
    let required = |name: &str| {
        query
            .get(name)
            .map(String::as_str)
            .filter(|v| !v.is_empty())
    };
    let (
        Some(client_id),
        Some(redirect_uri),
        Some(response_type),
        Some(scope),
        Some(state),
        Some(nonce),
        Some(challenge),
        Some(method),
    ) = (
        required("client_id"),
        required("redirect_uri"),
        required("response_type"),
        required("scope"),
        required("state"),
        required("nonce"),
        required("code_challenge"),
        required("code_challenge_method"),
    )
    else {
        return protocol_problem(
            "invalid_request",
            "Missing authorization parameter",
            400,
            &correlation,
        );
    };
    if client_id.len() > 255
        || redirect_uri.len() > 2048
        || url::Url::parse(redirect_uri).is_err()
        || url::Url::parse(redirect_uri).is_ok_and(|url| url.fragment().is_some())
        || state.len() < 8
        || state.len() > 1024
        || nonce.len() < 8
        || nonce.len() > 1024
        || response_type != "code"
        || method != "S256"
        || identity_domain::validate_pkce_s256(challenge).is_err()
    {
        return protocol_problem(
            "invalid_request",
            "Invalid authorization parameter",
            400,
            &correlation,
        );
    }
    let db = context.d1("DB")?;
    let Some(client) = repo::client(&db, client_id).await? else {
        return protocol_problem(
            "invalid_redirect_uri",
            "Client or redirect URI is invalid",
            400,
            &correlation,
        );
    };
    let redirects = repo::redirect_registrations(&db, client_id).await?;
    if !authorization_redirect_allowed(&client, redirect_uri, &redirects) {
        return protocol_problem(
            "invalid_redirect_uri",
            "Client or redirect URI is invalid",
            400,
            &correlation,
        );
    }
    let scopes = match canonical_scopes(scope) {
        Some(value) if value.split(' ').next() == Some("openid") => value,
        _ => {
            return authorization_error(
                redirect_uri,
                "invalid_scope",
                state,
                &issuer,
                &correlation,
            );
        }
    };
    let scope_items: Vec<_> = scopes.split(' ').collect();
    if !repo::scopes_allowed(&db, client_id, &scope_items).await? {
        return authorization_error(redirect_uri, "invalid_scope", state, &issuer, &correlation);
    }
    let prompt = query.get("prompt").map(String::as_str);
    if prompt.is_some_and(|v| !matches!(v, "none" | "login" | "select_account")) {
        return authorization_error(
            redirect_uri,
            "invalid_request",
            state,
            &issuer,
            &correlation,
        );
    }
    let current = authenticated_session(&request, &context.env).await?;
    if prompt == Some("none") && current.is_none() {
        return authorization_error(redirect_uri, "login_required", state, &issuer, &correlation);
    }
    let reuse_session = current
        .as_ref()
        .filter(|_| !matches!(prompt, Some("login" | "select_account")));
    let id = TransactionId::new_v7(worker::Date::now().as_millis()).to_string();
    let now = now_seconds();
    repo::insert_authorization_transaction(
        &db,
        &id,
        client_id,
        redirect_uri,
        &scopes,
        state,
        nonce,
        challenge,
        reuse_session.map(|s| s.principal_id.as_str()),
        reuse_session.map(|s| s.session_id.as_str()),
        now,
        now + 300,
    )
    .await?;
    let location = if reuse_session.is_some() {
        format!("{issuer}/v1/oauth/authorization-transactions/{id}/resume")
    } else {
        append_query(
            &format!("{}/login", login_origin(&context.env)),
            &[("tx", &id)],
        )?
    };
    redirect(&location, &correlation, None)
}

/// 用当前 Identity session 将事务变为一次性 authorization code。
/// Resumes a transaction with the current Identity session into a one-shot authorization code.
pub async fn resume(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some((issuer, _, _, _)) = issuance_config(&context.env) else {
        return oauth_problem(
            "temporarily_unavailable",
            "OIDC issuance is not configured",
            503,
            &correlation,
        );
    };
    let Some(id) = context.param("id") else {
        return protocol_problem(
            "invalid_transaction",
            "Invalid authorization transaction",
            404,
            &correlation,
        );
    };
    let db = context.d1("DB")?;
    let Some(tx) = repo::authorization_transaction(&db, id).await? else {
        return protocol_problem(
            "invalid_transaction",
            "Invalid authorization transaction",
            404,
            &correlation,
        );
    };
    let Some(session) = authenticated_session(&request, &context.env).await? else {
        return redirect(
            &append_query(
                &format!("{}/login", login_origin(&context.env)),
                &[("tx", id)],
            )?,
            &correlation,
            None,
        );
    };
    if tx.state != "authenticated"
        || tx.expires_at <= now_seconds()
        || tx.principal_id.as_deref() != Some(&session.principal_id)
        || tx.identity_session_id.as_deref() != Some(&session.session_id)
    {
        return protocol_problem(
            "invalid_transaction",
            "Authorization transaction cannot be resumed",
            409,
            &correlation,
        );
    }
    let code = random_secret();
    let digest = SecretDigest::hmac(
        secret(&context.env, "AUTHORIZATION_CODE_PEPPER")?.as_bytes(),
        code.as_bytes(),
    );
    let now = now_seconds();
    let code_id = Uuid::now_v7().to_string();
    let issued = repo::issue_authorization_code(
        &db,
        &tx,
        &code_id,
        &digest.0,
        &session.session_id,
        &session.principal_id,
        now,
        now + config_seconds(&context.env, "AUTHORIZATION_CODE_TTL_SECONDS", 60, 600),
    )
    .await;
    if matches!(&issued, Ok(false))
        || (issued.is_err()
            && repo::authorization_transaction(&db, id)
                .await?
                .is_some_and(|current| current.state == "completed"))
    {
        return protocol_problem(
            "transaction_consumed",
            "Authorization transaction was already consumed",
            409,
            &correlation,
        );
    }
    issued?;
    let location = append_query(
        &tx.redirect_uri,
        &[
            ("code", &code),
            ("state", &tx.state_value),
            ("iss", &issuer),
        ],
    )?;
    redirect(&location, &correlation, None)
}

/// 兑换 authorization code 或轮换 refresh token。/ Exchanges an authorization code or rotates a refresh token.
pub async fn token(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some((issuer, kid, private_key, _)) = issuance_config(&context.env) else {
        return oauth_problem(
            "temporarily_unavailable",
            "OIDC issuance is not configured",
            503,
            &correlation,
        );
    };
    let fields = match read_form(&mut request).await {
        Ok(v) => v,
        Err(code) => return oauth_problem(code, "Malformed token request", 400, &correlation),
    };
    let allowed = match fields.get("grant_type").map(String::as_str) {
        Some("authorization_code") => &[
            "grant_type",
            "code",
            "redirect_uri",
            "code_verifier",
            "client_id",
            "client_assertion_type",
            "client_assertion",
        ][..],
        Some("refresh_token") => &[
            "grant_type",
            "refresh_token",
            "client_id",
            "client_assertion_type",
            "client_assertion",
        ][..],
        _ => &[][..],
    };
    if !allowed.is_empty() && !only_fields(&fields, allowed) {
        return oauth_problem(
            "invalid_request",
            "Unexpected token parameter",
            400,
            &correlation,
        );
    }
    let Some(client_id) = fields.get("client_id") else {
        return oauth_problem(
            "invalid_request",
            "client_id is required",
            400,
            &correlation,
        );
    };
    let db = context.d1("DB")?;
    let client = match authenticate_client(&db, client_id, &fields, &issuer, &context.env).await {
        Ok(v) => v,
        Err(_) => {
            return oauth_problem(
                "invalid_client",
                "Client authentication failed",
                401,
                &correlation,
            );
        }
    };
    match fields.get("grant_type").map(String::as_str) {
        Some("authorization_code") => {
            exchange_code(
                &context.env,
                &db,
                &client,
                &fields,
                &issuer,
                &kid,
                &private_key,
                &correlation,
            )
            .await
        }
        Some("refresh_token") => {
            exchange_refresh(
                &context.env,
                &db,
                &client,
                &fields,
                &issuer,
                &kid,
                &private_key,
                &correlation,
            )
            .await
        }
        _ => oauth_problem(
            "unsupported_grant_type",
            "Unsupported grant type",
            400,
            &correlation,
        ),
    }
}

/// RFC 7009 revocation；未知 token 维持成功语义。/ RFC 7009 revocation; unknown tokens retain success semantics.
pub async fn revoke(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let fields = match read_form(&mut request).await {
        Ok(v) => v,
        Err(code) => return oauth_problem(code, "Malformed revocation request", 400, &correlation),
    };
    if !only_fields(
        &fields,
        &[
            "token",
            "token_type_hint",
            "client_id",
            "client_assertion_type",
            "client_assertion",
        ],
    ) {
        return oauth_problem(
            "invalid_request",
            "Unexpected revocation parameter",
            400,
            &correlation,
        );
    }
    let (Some(client_id), Some(token)) = (fields.get("client_id"), fields.get("token")) else {
        return oauth_problem(
            "invalid_request",
            "token and client_id are required",
            400,
            &correlation,
        );
    };
    let issuer = issuer(&context.env);
    let db = context.d1("DB")?;
    if authenticate_client(&db, client_id, &fields, &issuer, &context.env)
        .await
        .is_err()
    {
        return oauth_problem(
            "invalid_client",
            "Client authentication failed",
            401,
            &correlation,
        );
    }
    let digest = SecretDigest::hmac(
        secret(&context.env, "REFRESH_TOKEN_PEPPER")?.as_bytes(),
        token.as_bytes(),
    );
    repo::revoke_by_refresh_digest(&db, &digest.0, client_id, now_seconds()).await?;
    empty_ok(&correlation)
}

/// 返回 access token scope 允许的最小 UserInfo。/ Returns minimal UserInfo allowed by the access-token scope.
pub async fn userinfo(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let Some(wire) = bearer(&request) else {
        return bearer_error(
            "invalid_token",
            "Bearer token is required",
            401,
            &correlation,
        );
    };
    let claims = match verify_our_jwt(&wire, &context.env, true).await {
        Ok(v) => v,
        Err(_) => {
            return bearer_error(
                "invalid_token",
                "Access token is invalid",
                401,
                &correlation,
            );
        }
    };
    let scope = claims
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !scope.split(' ').any(|v| v == "openid") {
        return bearer_error(
            "insufficient_scope",
            "openid scope is required",
            403,
            &correlation,
        );
    }
    let Some(sub) = claims.get("sub").and_then(Value::as_str) else {
        return bearer_error(
            "invalid_token",
            "Access token is invalid",
            401,
            &correlation,
        );
    };
    let mut output = json!({"sub":sub});
    if scope.split(' ').any(|v| v == "profile") {
        if let Some(pid) = claims.get("pid").and_then(Value::as_str) {
            if let Some(profile) = repository::principal(&context.d1("DB")?, pid).await? {
                output["name"] = json!(profile.display_name);
                output["preferred_username"] = json!(profile.username);
            }
        }
    }
    json_response(&output, 200, &correlation)
}

/// 处理 GET RP-Initiated Logout。/ Handles GET RP-Initiated Logout.
pub async fn logout_get(request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let fields = match unique_fields(request.url()?.query().unwrap_or_default(), 4) {
        Ok(fields)
            if only_fields(
                &fields,
                &["id_token_hint", "post_logout_redirect_uri", "state"],
            ) =>
        {
            fields
        }
        _ => {
            return protocol_problem(
                "invalid_request",
                "Malformed logout request",
                400,
                &correlation,
            );
        }
    };
    logout(request, context, fields).await
}

/// 处理 POST RP-Initiated Logout。/ Handles POST RP-Initiated Logout.
pub async fn logout_post(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = correlation_id();
    let fields = match read_form(&mut request).await {
        Ok(v) => v,
        Err(_) => {
            return protocol_problem(
                "invalid_request",
                "Malformed logout request",
                400,
                &correlation,
            );
        }
    };
    if !only_fields(
        &fields,
        &["id_token_hint", "post_logout_redirect_uri", "state"],
    ) {
        return protocol_problem(
            "invalid_request",
            "Unexpected logout parameter",
            400,
            &correlation,
        );
    }
    logout(request, context, fields).await
}

async fn logout(
    request: Request,
    context: RouteContext<()>,
    fields: BTreeMap<String, String>,
) -> Result<Response> {
    let correlation = correlation_id();
    let db = context.d1("DB")?;
    let mut client_id = None;
    let mut sid = None;
    if let Some(hint) = fields.get("id_token_hint") {
        if let Ok(claims) = verify_our_jwt(hint, &context.env, false).await {
            client_id = audience_one(&claims).map(str::to_owned);
            sid = claims.get("sid").and_then(Value::as_str).map(str::to_owned);
        }
    }
    if sid.is_none() {
        if let Some(session) = authenticated_session(&request, &context.env).await? {
            sid = Some(session.session_id);
        }
    }
    if let Some(id) = sid.as_deref() {
        repo::logout_session(&db, id, now_seconds()).await?;
    }
    let cookie = guard::clear_session_cookie();
    if let Some(uri) = fields.get("post_logout_redirect_uri") {
        let Some(client) = client_id.as_deref() else {
            return protocol_problem(
                "invalid_redirect_uri",
                "A valid id_token_hint is required for redirect",
                400,
                &correlation,
            );
        };
        if !repo::exact_post_logout_redirect(&db, client, uri).await? {
            return protocol_problem(
                "invalid_redirect_uri",
                "Post-logout redirect URI is invalid",
                400,
                &correlation,
            );
        }
        let location = if let Some(state) = fields.get("state") {
            append_query(uri, &[("state", state)])?
        } else {
            uri.clone()
        };
        return redirect(&location, &correlation, Some(cookie));
    }
    let response = json_response(&json!({"logged_out":true}), 200, &correlation)?;
    response.headers().append("set-cookie", cookie)?;
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
async fn exchange_code(
    env: &Env,
    db: &D1Database,
    client: &repo::OAuthClient,
    fields: &BTreeMap<String, String>,
    issuer: &str,
    kid: &str,
    key: &str,
    correlation: &str,
) -> Result<Response> {
    let (Some(code), Some(redirect), Some(verifier)) = (
        fields.get("code"),
        fields.get("redirect_uri"),
        fields.get("code_verifier"),
    ) else {
        return oauth_problem(
            "invalid_request",
            "Missing authorization-code parameter",
            400,
            correlation,
        );
    };
    if !valid_verifier(verifier) {
        return oauth_problem(
            "invalid_grant",
            "PKCE verification failed",
            400,
            correlation,
        );
    }
    let digest = SecretDigest::hmac(
        secret(env, "AUTHORIZATION_CODE_PEPPER")?.as_bytes(),
        code.as_bytes(),
    );
    let Some(grant) = repo::authorization_code(db, &digest.0).await? else {
        return oauth_problem(
            "invalid_grant",
            "Authorization code is invalid",
            400,
            correlation,
        );
    };
    let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    if grant.client_id != client.client_id
        || grant.redirect_uri != *redirect
        || grant.expires_at <= now_seconds()
        || grant.session_revoked_at.is_some()
        || grant.session_idle_expires_at <= now_seconds()
        || grant.session_absolute_expires_at <= now_seconds()
        || !bool::from(expected.as_bytes().ct_eq(grant.code_challenge.as_bytes()))
    {
        return oauth_problem(
            "invalid_grant",
            "Authorization code is invalid",
            400,
            correlation,
        );
    }
    let now = now_seconds();
    let subject = pairwise(
        db,
        env,
        &grant.sector_identifier,
        &grant.principal_id,
        grant.subject_salt_revision,
        now,
    )
    .await?;
    let refresh = if grant.scope.split(' ').any(|v| v == "offline_access") {
        let wire = random_secret();
        let pepper = secret(env, "REFRESH_TOKEN_PEPPER")?;
        let digest = SecretDigest::hmac(pepper.as_bytes(), wire.as_bytes());
        Some((
            wire,
            TokenFamilyId::new_v7(worker::Date::now().as_millis()).to_string(),
            Uuid::now_v7().to_string(),
            digest,
        ))
    } else {
        None
    };
    let request_digest =
        Sha256::digest(format!("{}\0{}\0{}", client.client_id, code, verifier).as_bytes());
    let refresh_exp = now + config_seconds(env, "REFRESH_TOKEN_TTL_SECONDS", 2_592_000, 31_536_000);
    if let Err(_error) = repo::consume_code(
        db,
        &grant,
        &request_digest,
        refresh
            .as_ref()
            .map(|(_, f, t, d)| (f.as_str(), t.as_str(), d.0.as_slice())),
        now,
        refresh_exp,
    )
    .await
    {
        match repo::authorization_code(db, &digest.0).await? {
            None => {
                return oauth_problem(
                    "invalid_grant",
                    "Authorization code was already consumed",
                    400,
                    correlation,
                );
            }
            Some(_) => {
                return oauth_problem(
                    "invalid_grant",
                    "Authorization authority is no longer active",
                    400,
                    correlation,
                );
            }
        }
    }
    let tokens = sign_tokens(
        key,
        kid,
        issuer,
        &subject,
        &grant.client_id,
        &grant.principal_id,
        &grant.identity_session_id,
        &grant.scope,
        Some(&grant.nonce),
        grant.authenticated_at,
        &grant.amr_json,
        &grant.acr,
        &grant.display_name,
        &grant.username,
        now,
        config_seconds(env, "TOKEN_TTL_SECONDS", 300, 300),
    )
    .await?;
    token_response(tokens, refresh.map(|v| v.0), correlation)
}

#[allow(clippy::too_many_arguments)]
async fn exchange_refresh(
    env: &Env,
    db: &D1Database,
    client: &repo::OAuthClient,
    fields: &BTreeMap<String, String>,
    issuer: &str,
    kid: &str,
    key: &str,
    correlation: &str,
) -> Result<Response> {
    let Some(wire) = fields.get("refresh_token") else {
        return oauth_problem(
            "invalid_request",
            "refresh_token is required",
            400,
            correlation,
        );
    };
    let digest = SecretDigest::hmac(
        secret(env, "REFRESH_TOKEN_PEPPER")?.as_bytes(),
        wire.as_bytes(),
    );
    let Some(grant) = repo::refresh_grant(db, &digest.0).await? else {
        return oauth_problem(
            "invalid_grant",
            "Refresh token is invalid",
            400,
            correlation,
        );
    };
    let now = now_seconds();
    if grant.token_state != "active" {
        repo::revoke_family_for_reuse(db, &grant.refresh_token_family_id, now).await?;
        return oauth_problem(
            "invalid_grant",
            "Refresh-token reuse detected",
            400,
            correlation,
        );
    }
    if grant.client_id != client.client_id
        || grant.family_revoked_at.is_some()
        || grant.token_expires_at <= now
        || grant.absolute_expires_at <= now
        || grant.session_revoked_at.is_some()
        || grant.session_idle_expires_at <= now
        || grant.session_absolute_expires_at <= now
    {
        return oauth_problem(
            "invalid_grant",
            "Refresh token is invalid",
            400,
            correlation,
        );
    }
    let subject = pairwise(
        db,
        env,
        &grant.sector_identifier,
        &grant.principal_id,
        grant.subject_salt_revision,
        now,
    )
    .await?;
    let new_wire = random_secret();
    let new_digest = SecretDigest::hmac(
        secret(env, "REFRESH_TOKEN_PEPPER")?.as_bytes(),
        new_wire.as_bytes(),
    );
    let new_id = Uuid::now_v7().to_string();
    if let Err(error) = repo::rotate_refresh(
        db,
        &grant,
        &new_id,
        &new_digest.0,
        now,
        grant.absolute_expires_at,
    )
    .await
    {
        if let Some(current) = repo::refresh_grant(db, &digest.0).await? {
            if current.token_state != "active" {
                repo::revoke_family_for_reuse(db, &grant.refresh_token_family_id, now).await?;
                return oauth_problem(
                    "invalid_grant",
                    "Refresh-token reuse detected",
                    400,
                    correlation,
                );
            }
            return oauth_problem(
                "invalid_grant",
                "Refresh-token authority is no longer active",
                400,
                correlation,
            );
        }
        return Err(error);
    }
    let tokens = sign_tokens(
        key,
        kid,
        issuer,
        &subject,
        &grant.client_id,
        &grant.principal_id,
        &grant.identity_session_id,
        &grant.scope,
        None,
        grant.authenticated_at,
        &grant.amr_json,
        &grant.acr,
        &grant.display_name,
        &grant.username,
        now,
        config_seconds(env, "TOKEN_TTL_SECONDS", 300, 300),
    )
    .await?;
    token_response(tokens, Some(new_wire), correlation)
}

struct SignedTokens {
    access: String,
    id: String,
    scope: String,
    expires: i64,
}
#[allow(clippy::too_many_arguments)]
async fn sign_tokens(
    key: &str,
    kid: &str,
    issuer: &str,
    sub: &str,
    client: &str,
    pid: &str,
    sid: &str,
    scope: &str,
    nonce: Option<&str>,
    auth_time: i64,
    amr_json: &str,
    acr: &str,
    name: &str,
    username: &str,
    now: i64,
    ttl: i64,
) -> Result<SignedTokens> {
    let exp = now + ttl;
    let amr: Value = serde_json::from_str(amr_json).unwrap_or(json!([]));
    let access = json!({"iss":issuer,"sub":sub,"aud":client,"client_id":client,"pid":pid,"sid":sid,"scope":scope,"iat":now,"exp":exp,"jti":Uuid::new_v4().to_string(),"token_use":"access"});
    let mut id = json!({"iss":issuer,"sub":sub,"aud":client,"sid":sid,"iat":now,"exp":exp,"auth_time":auth_time,"amr":amr,"acr":acr,"token_use":"id"});
    if scope.split(' ').any(|value| value == "profile") {
        id["name"] = json!(name);
        id["preferred_username"] = json!(username);
    }
    if let Some(n) = nonce {
        id["nonce"] = json!(n)
    }
    Ok(SignedTokens {
        access: webcrypto::sign_rs256(key, kid, &access).await?,
        id: webcrypto::sign_rs256(key, kid, &id).await?,
        scope: scope.to_owned(),
        expires: ttl,
    })
}
fn token_response(
    tokens: SignedTokens,
    refresh: Option<String>,
    correlation: &str,
) -> Result<Response> {
    let mut value = json!({"access_token":tokens.access,"token_type":"Bearer","expires_in":tokens.expires,"scope":tokens.scope,"id_token":tokens.id});
    if let Some(v) = refresh {
        value["refresh_token"] = json!(v)
    };
    let response = json_response(&value, 200, correlation)?;
    response.headers().set("pragma", "no-cache")?;
    Ok(response)
}

async fn authenticate_client(
    db: &D1Database,
    client_id: &str,
    fields: &BTreeMap<String, String>,
    issuer: &str,
    _env: &Env,
) -> Result<repo::OAuthClient> {
    let client = repo::client(db, client_id)
        .await?
        .ok_or_else(|| Error::RustError("unknown client".into()))?;
    if client.client_type == "native" && client.token_endpoint_auth_method == "none" {
        if fields.contains_key("client_assertion") || fields.contains_key("client_assertion_type") {
            return Err(Error::RustError("native assertion not accepted".into()));
        }
        return Ok(client);
    }
    if fields.get("client_assertion_type").map(String::as_str) != Some(CLIENT_ASSERTION_TYPE) {
        return Err(Error::RustError("missing assertion type".into()));
    }
    let parsed = webcrypto::parse_jwt(
        fields
            .get("client_assertion")
            .ok_or_else(|| Error::RustError("missing assertion".into()))?,
    )?;
    let kid = parsed
        .header
        .get("kid")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::RustError("missing kid".into()))?;
    let alg = parsed
        .header
        .get("alg")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::RustError("missing alg".into()))?;
    let public = repo::client_key(db, client_id, kid)
        .await?
        .ok_or_else(|| Error::RustError("unknown key".into()))?;
    if public.algorithm != alg
        || !webcrypto::verify_jwt_signature(&parsed, alg, &public.public_jwk_json).await?
    {
        return Err(Error::RustError("invalid assertion signature".into()));
    }
    let now = now_seconds();
    let c = &parsed.claims;
    let exp = c.get("exp").and_then(Value::as_i64).unwrap_or(0);
    let iat = c.get("iat").and_then(Value::as_i64).unwrap_or(0);
    let jti = c
        .get("jti")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::RustError("missing jti".into()))?;
    if c.get("iss").and_then(Value::as_str) != Some(client_id)
        || c.get("sub").and_then(Value::as_str) != Some(client_id)
        || !aud_contains(c, &format!("{issuer}/v1/oauth/tokens"))
        || exp <= now
        || exp > now + 300
        || iat > now + 60
        || iat < now - 300
    {
        return Err(Error::RustError("invalid assertion claims".into()));
    }
    repo::record_client_assertion(db, client_id, &Sha256::digest(jti.as_bytes()), exp).await?;
    Ok(client)
}

async fn verify_our_jwt(wire: &str, env: &Env, require_access: bool) -> Result<Value> {
    let parsed = webcrypto::parse_jwt(wire)?;
    if parsed.header.get("alg").and_then(Value::as_str) != Some("RS256") {
        return Err(Error::RustError("wrong alg".into()));
    }
    let kid = parsed
        .header
        .get("kid")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::RustError("missing kid".into()))?;
    let set: Value = serde_json::from_str(&env.var("PUBLIC_JWKS")?.to_string())?;
    let jwk = set
        .get("keys")
        .and_then(Value::as_array)
        .and_then(|keys| {
            keys.iter()
                .find(|k| k.get("kid").and_then(Value::as_str) == Some(kid))
        })
        .ok_or_else(|| Error::RustError("unknown kid".into()))?;
    if !webcrypto::verify_jwt_signature(&parsed, "RS256", &serde_json::to_string(jwk)?).await? {
        return Err(Error::RustError("bad signature".into()));
    }
    let c = parsed.claims;
    if c.get("iss").and_then(Value::as_str) != Some(issuer(env).as_str()) {
        return Err(Error::RustError("invalid claims".into()));
    }
    let expected_use = if require_access { "access" } else { "id" };
    if c.get("token_use").and_then(Value::as_str) != Some(expected_use)
        || audience_one(&c).is_none()
        || (require_access && c.get("exp").and_then(Value::as_i64).unwrap_or(0) <= now_seconds())
    {
        return Err(Error::RustError("invalid access-token claims".into()));
    }
    Ok(c)
}
async fn pairwise(
    db: &D1Database,
    env: &Env,
    sector: &str,
    pid: &str,
    revision: i64,
    now: i64,
) -> Result<String> {
    let input = format!("v{revision}\0{sector}\0{pid}");
    let subject = SecretDigest::hmac(
        secret(env, "PAIRWISE_SUBJECT_KEY")?.as_bytes(),
        input.as_bytes(),
    )
    .to_base64url();
    repo::ensure_pairwise_subject(db, sector, pid, &subject, revision, now).await
}

fn issuance_config(env: &Env) -> Option<(String, String, String, Value)> {
    if env.var("OAUTH_ENABLED").ok()?.to_string() != "true" {
        return None;
    }
    let issuer = env.var("ISSUER").ok()?.to_string();
    let kid = env.var("OIDC_ACTIVE_KID").ok()?.to_string();
    let key = env.secret("OIDC_PRIVATE_KEY_PKCS8").ok()?.to_string();
    let jwks: Value = serde_json::from_str(&env.var("PUBLIC_JWKS").ok()?.to_string()).ok()?;
    let keys = jwks.get("keys")?.as_array()?;
    if !keys.iter().any(|key| publishable_jwk(key, &kid)) {
        return None;
    }
    Some((issuer, kid, key, jwks))
}
fn publishable_jwk(key: &Value, kid: &str) -> bool {
    key.get("kid").and_then(Value::as_str) == Some(kid)
        && key.get("alg").and_then(Value::as_str) == Some("RS256")
        && key.get("kty").and_then(Value::as_str) == Some("RSA")
        && key.get("n").and_then(Value::as_str).is_some()
        && key.get("e").and_then(Value::as_str).is_some()
        && ["d", "p", "q", "dp", "dq", "qi"]
            .iter()
            .all(|name| key.get(name).is_none())
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
async fn read_form(
    request: &mut Request,
) -> std::result::Result<BTreeMap<String, String>, &'static str> {
    let content = guard::header(request.headers(), "content-type").unwrap_or_default();
    if !content.split(';').next().is_some_and(|v| {
        v.trim()
            .eq_ignore_ascii_case("application/x-www-form-urlencoded")
    }) {
        return Err("invalid_request");
    }
    if request
        .headers()
        .get("content-length")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|n| n > FORM_LIMIT)
    {
        return Err("invalid_request");
    }
    let bytes = request.bytes().await.map_err(|_| "invalid_request")?;
    if bytes.len() as u64 > FORM_LIMIT {
        return Err("invalid_request");
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "invalid_request")?;
    unique_fields(text, 20).map_err(|_| "invalid_request")
}
fn unique_fields(input: &str, max: usize) -> std::result::Result<BTreeMap<String, String>, ()> {
    let mut out = BTreeMap::new();
    for (k, v) in url::form_urlencoded::parse(input.as_bytes()) {
        if out.len() >= max || k.is_empty() || out.insert(k.into_owned(), v.into_owned()).is_some()
        {
            return Err(());
        }
    }
    Ok(out)
}
fn only_fields(fields: &BTreeMap<String, String>, allowed: &[&str]) -> bool {
    fields.keys().all(|name| allowed.contains(&name.as_str()))
}

/// 应用 RFC 8252 loopback 端口例外；其他 URI 仍为精确字符串匹配。
/// Applies the RFC 8252 loopback-port exception; every other URI remains an exact string match.
fn authorization_redirect_allowed(
    client: &repo::OAuthClient,
    requested: &str,
    registrations: &[repo::RedirectRegistration],
) -> bool {
    registrations.iter().any(|registered| {
        if registered.match_mode == "exact" {
            return registered.redirect_uri == requested;
        }
        client.client_type == "native"
            && registered.match_mode == "native_loopback_any_port"
            && loopback_redirect_matches(&registered.redirect_uri, requested)
    })
}

fn loopback_redirect_matches(registered: &str, requested: &str) -> bool {
    let (Ok(registered_url), Ok(requested_url)) =
        (url::Url::parse(registered), url::Url::parse(requested))
    else {
        return false;
    };
    let host = registered_url.host_str();
    registered_url.scheme() == "http"
        && requested_url.scheme() == "http"
        && matches!(host, Some("127.0.0.1" | "::1" | "[::1]"))
        && requested_url.host_str() == host
        && requested_url.username() == registered_url.username()
        && requested_url.password() == registered_url.password()
        && loopback_uri_tail(registered) == loopback_uri_tail(requested)
        && requested_url.fragment().is_none()
        && registered_url.fragment().is_none()
}

fn loopback_uri_tail(uri: &str) -> Option<&str> {
    let authority = uri.strip_prefix("http://")?;
    let path = authority.find('/')?;
    Some(&authority[path..])
}
fn canonical_scopes(input: &str) -> Option<String> {
    if input.len() > 1024 {
        return None;
    }
    let mut values = Vec::new();
    for value in input.split(' ') {
        if value.is_empty()
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            || values.contains(&value)
        {
            return None;
        }
        values.push(value)
    }
    Some(values.join(" "))
}
fn valid_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
}
fn is_top_navigation(request: &Request) -> bool {
    let h = request.headers();
    guard::header(h, "sec-fetch-mode").is_none_or(|v| v == "navigate")
        && guard::header(h, "sec-fetch-dest").is_none_or(|v| v == "document")
}
fn bearer(request: &Request) -> Option<String> {
    let value = guard::header(request.headers(), "authorization")?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return None;
    }
    (!token.is_empty() && !token.bytes().any(|b| b.is_ascii_whitespace())).then(|| token.to_owned())
}
fn aud_contains(claims: &Value, expected: &str) -> bool {
    match claims.get("aud") {
        Some(Value::String(v)) => v == expected,
        Some(Value::Array(v)) => v.iter().any(|x| x.as_str() == Some(expected)),
        _ => false,
    }
}
fn audience_one(claims: &Value) -> Option<&str> {
    match claims.get("aud")? {
        Value::String(v) => Some(v),
        Value::Array(v) if v.len() == 1 => v[0].as_str(),
        _ => None,
    }
}
fn secret(env: &Env, name: &str) -> Result<String> {
    env.secret(name)
        .map(|v| v.to_string())
        .map_err(|_| Error::RustError(format!("missing secret binding: {name}")))
}
fn issuer(env: &Env) -> String {
    env.var("ISSUER")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "https://identity.moesegfault.dev".into())
}
fn login_origin(env: &Env) -> String {
    env.var("LOGIN_ORIGIN")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "https://login.moesegfault.dev".into())
}
fn config_seconds(env: &Env, name: &str, default: i64, max: i64) -> i64 {
    env.var(name)
        .ok()
        .and_then(|v| v.to_string().parse().ok())
        .filter(|v| *v > 0 && *v <= max)
        .unwrap_or(default)
}
fn now_seconds() -> i64 {
    (worker::Date::now().as_millis() / 1000) as i64
}
fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn correlation_id() -> String {
    correlation_id_at(worker::Date::now().as_millis())
}
fn correlation_id_at(unix_millis: u64) -> String {
    TransactionId::new_v7(unix_millis).to_string()
}
fn append_query(base: &str, items: &[(&str, &str)]) -> Result<String> {
    let mut url = url::Url::parse(base)
        .map_err(|_| Error::RustError("invalid configured redirect URI".into()))?;
    {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in items {
            pairs.append_pair(k, v);
        }
    }
    Ok(url.into())
}
fn authorization_error(
    uri: &str,
    error: &str,
    state: &str,
    issuer: &str,
    correlation: &str,
) -> Result<Response> {
    redirect(
        &append_query(uri, &[("error", error), ("state", state), ("iss", issuer)])?,
        correlation,
        None,
    )
}
fn redirect(location: &str, correlation: &str, cookie: Option<&str>) -> Result<Response> {
    let headers = Headers::new();
    headers.set("location", location)?;
    headers.set("cache-control", "no-store")?;
    headers.set("x-moesegfault-correlation-id", correlation)?;
    if let Some(v) = cookie {
        headers.append("set-cookie", v)?
    }
    Ok(Response::empty()?.with_status(302).with_headers(headers))
}
fn protocol_problem(code: &str, title: &str, status: u16, correlation: &str) -> Result<Response> {
    let value = json!({"type":format!("urn:moesegfault:problem:{code}"),"title":title,"status":status,"code":code,"correlation_id":correlation});
    response_json(
        &value,
        status,
        "application/problem+json; charset=utf-8",
        correlation,
    )
}
fn oauth_problem(
    code: &str,
    description: &str,
    status: u16,
    correlation: &str,
) -> Result<Response> {
    response_json(
        &json!({"error":code,"error_description":description}),
        status,
        "application/json; charset=utf-8",
        correlation,
    )
}
fn bearer_error(code: &str, description: &str, status: u16, correlation: &str) -> Result<Response> {
    let response = oauth_problem(code, description, status, correlation)?;
    response.headers().set(
        "www-authenticate",
        &format!("Bearer realm=\"userinfo\", error=\"{code}\""),
    )?;
    Ok(response)
}
fn empty_ok(correlation: &str) -> Result<Response> {
    let h = Headers::new();
    h.set("cache-control", "no-store")?;
    h.set("x-moesegfault-correlation-id", correlation)?;
    Ok(Response::empty()?.with_status(200).with_headers(h))
}
fn json_response<T: Serialize>(value: &T, status: u16, correlation: &str) -> Result<Response> {
    response_json(
        value,
        status,
        "application/json; charset=utf-8",
        correlation,
    )
}
fn public_json<T: Serialize>(value: &T, correlation: &str) -> Result<Response> {
    let response = json_response(value, 200, correlation)?;
    response.headers().set("access-control-allow-origin", "*")?;
    Ok(response)
}
fn response_json<T: Serialize>(
    value: &T,
    status: u16,
    content_type: &str,
    correlation: &str,
) -> Result<Response> {
    let h = Headers::new();
    h.set("content-type", content_type)?;
    h.set("cache-control", "no-store")?;
    h.set("x-content-type-options", "nosniff")?;
    h.set("x-moesegfault-correlation-id", correlation)?;
    Ok(Response::from_json(value)?
        .with_status(status)
        .with_headers(h))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicated_protocol_parameters_are_rejected() {
        assert!(unique_fields("client_id=a&client_id=b", 10).is_err())
    }
    #[test]
    fn scope_parser_rejects_empty_duplicates_and_non_ascii() {
        assert_eq!(
            canonical_scopes("openid profile").as_deref(),
            Some("openid profile")
        );
        for bad in ["openid  profile", "openid openid", "openid 中"] {
            assert!(canonical_scopes(bad).is_none())
        }
    }
    #[test]
    fn pkce_verifier_shape_is_exact() {
        assert!(valid_verifier(&"a".repeat(43)));
        assert!(!valid_verifier(&"a".repeat(42)));
        assert!(!valid_verifier(&format!("{}=", "a".repeat(42))))
    }
    #[test]
    fn authorization_response_preserves_existing_query_and_encodes_values() {
        let value =
            append_query("https://client.example/cb?tenant=1", &[("state", "a&b")]).unwrap();
        assert_eq!(value, "https://client.example/cb?tenant=1&state=a%26b")
    }
    #[test]
    fn public_jwks_rejects_private_rsa_parameters() {
        let public = json!({"kty":"RSA","kid":"k1","alg":"RS256","n":"modulus","e":"AQAB"});
        assert!(publishable_jwk(&public, "k1"));
        let mut private = public;
        private["d"] = json!("secret");
        assert!(!publishable_jwk(&private, "k1"));
    }

    #[test]
    fn native_loopback_redirect_changes_only_port() {
        let client = repo::OAuthClient {
            client_id: "native".into(),
            client_type: "native".into(),
            token_endpoint_auth_method: "none".into(),
        };
        let registrations = [repo::RedirectRegistration {
            redirect_uri: "http://127.0.0.1:49152/callback?channel=desktop".into(),
            match_mode: "native_loopback_any_port".into(),
        }];
        assert!(authorization_redirect_allowed(
            &client,
            "http://127.0.0.1:61234/callback?channel=desktop",
            &registrations,
        ));
        assert!(loopback_redirect_matches(
            "http://[::1]:49152/callback",
            "http://[::1]:61234/callback",
        ));
        for rejected in [
            "http://localhost:61234/callback?channel=desktop",
            "http://127.0.0.1:61234/other?channel=desktop",
            "http://127.0.0.1:61234/a/../callback?channel=desktop",
            "http://127.0.0.1:61234/%63allback?channel=desktop",
            "http://127.0.0.1:61234/callback?channel=web",
            "https://127.0.0.1:61234/callback?channel=desktop",
        ] {
            assert!(!authorization_redirect_allowed(
                &client,
                rejected,
                &registrations,
            ));
        }
        let confidential = repo::OAuthClient {
            client_id: "server".into(),
            client_type: "confidential".into(),
            token_endpoint_auth_method: "private_key_jwt".into(),
        };
        assert!(!authorization_redirect_allowed(
            &confidential,
            "http://127.0.0.1:61234/callback?channel=desktop",
            &registrations,
        ));
    }

    #[test]
    fn correlation_id_is_uuid_v7() {
        let parsed = Uuid::parse_str(&correlation_id_at(1_700_000_000_123)).unwrap();
        assert_eq!(parsed.get_version_num(), 7);
    }
}
