//! RFC 8628 device authorization and explicit browser consent.

use identity_domain::SecretDigest;
use rand::{Rng as _, rngs::OsRng};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::json;
use uuid::Uuid;
use worker::*;

use crate::{device_repository as repo, guard, oauth, repository};

pub(crate) const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const LIFETIME: i64 = 600;
const USER_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub async fn start(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = oauth::correlation_id();
    let Some((issuer, _, _, _)) = oauth::issuance_config(&context.env) else {
        return oauth::oauth_problem(
            "temporarily_unavailable",
            "OIDC issuance is not configured",
            503,
            &correlation,
        );
    };
    let fields = match oauth::read_form(&mut request).await {
        Ok(fields)
            if oauth::only_fields(
                &fields,
                &[
                    "client_id",
                    "scope",
                    "client_assertion_type",
                    "client_assertion",
                ],
            ) =>
        {
            fields
        }
        _ => return invalid_request(&correlation),
    };
    let Some(client_id) = fields.get("client_id") else {
        return invalid_request(&correlation);
    };
    let db = context.d1("DB")?;
    let client = match oauth::authenticate_client_at(
        &db,
        client_id,
        &fields,
        &format!("{issuer}/v1/oauth/device-authorizations"),
    )
    .await
    {
        Ok(client) => client,
        Err(_) => {
            return oauth::oauth_problem(
                "invalid_client",
                "Client authentication failed",
                401,
                &correlation,
            );
        }
    };
    if client.device_authorization_enabled != 1 {
        return oauth::oauth_problem(
            "unauthorized_client",
            "Device authorization is not enabled for this client",
            400,
            &correlation,
        );
    }
    if let Some(ip) = guard::header(request.headers(), "cf-connecting-ip") {
        let bucket = digest(&context.env, "creation", &format!("{client_id}:{ip}"))?;
        if !repo::reserve_attempt(&db, &bucket.0, oauth::now_seconds(), 600, 1000).await? {
            let response = oauth::oauth_problem(
                "slow_down",
                "Too many device authorization requests; retry later",
                429,
                &correlation,
            )?;
            response.headers().set(
                "retry-after",
                &(600 - oauth::now_seconds() % 600).to_string(),
            )?;
            return Ok(response);
        }
    }
    let scope = fields.get("scope").map_or("openid", String::as_str);
    let Some(scope) =
        oauth::canonical_scopes(scope).filter(|s| s.split(' ').any(|v| v == "openid"))
    else {
        return oauth::oauth_problem(
            "invalid_scope",
            "openid scope is required",
            400,
            &correlation,
        );
    };
    if !crate::oauth_repository::scopes_allowed(
        &db,
        client_id,
        &scope.split(' ').collect::<Vec<_>>(),
    )
    .await?
    {
        return oauth::oauth_problem(
            "invalid_scope",
            "The requested scopes are not registered for this client",
            400,
            &correlation,
        );
    }
    let device_code = oauth::random_secret();
    let user_code = random_user_code();
    let now = oauth::now_seconds();
    repo::insert(
        &db,
        &Uuid::now_v7().to_string(),
        &digest(&context.env, "device-code", &device_code)?.0,
        &digest(&context.env, "user-code", &user_code)?.0,
        client_id,
        &scope,
        now,
        now + LIFETIME,
    )
    .await?;
    let user_code = formatted_user_code(&user_code);
    let verification_uri = format!("{}/device", oauth::login_origin(&context.env));
    let complete = oauth::append_query(&verification_uri, &[("user_code", &user_code)])?;
    oauth::json_response(
        &json!({"device_code":device_code,"user_code":user_code,"verification_uri":verification_uri,"verification_uri_complete":complete,"expires_in":LIFETIME,"interval":5}),
        200,
        &correlation,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LookupRequest {
    user_code: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DecisionRequest {
    user_code: String,
    decision: Decision,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Decision {
    Approve,
    Deny,
}

pub async fn lookup(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = oauth::correlation_id();
    let session = match browser_session(&request, &context.env, &correlation).await? {
        Ok(s) => s,
        Err(r) => return Ok(r),
    };
    let Some(input) = read_json::<LookupRequest>(&mut request).await else {
        return invalid_request(&correlation);
    };
    let db = context.d1("DB")?;
    if !repo::reserve_attempt(
        &db,
        &digest(&context.env, "verification-lookup", &session.principal_id)?.0,
        oauth::now_seconds(),
        3600,
        100,
    )
    .await?
    {
        return verification_limited(&correlation);
    }
    let Some(code) = normalize_user_code(&input.user_code) else {
        return invalid_code(&correlation);
    };
    let Some(found) = repo::lookup(
        &db,
        &digest(&context.env, "user-code", &code)?.0,
        oauth::now_seconds(),
    )
    .await?
    else {
        return invalid_code(&correlation);
    };
    if found.expires_at <= oauth::now_seconds() {
        return expired(&correlation);
    }
    if found.state != "pending" {
        return invalid_code(&correlation);
    }
    oauth::json_response(
        &json!({"user_code":formatted_user_code(&code),"client_id":found.client_id,"client_name":found.client_name,"scope":found.scope,"state":found.state,"expires_in":found.expires_at-oauth::now_seconds()}),
        200,
        &correlation,
    )
}

pub async fn decide(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = oauth::correlation_id();
    let session = match browser_session(&request, &context.env, &correlation).await? {
        Ok(s) => s,
        Err(r) => return Ok(r),
    };
    let Some(input) = read_json::<DecisionRequest>(&mut request).await else {
        return invalid_request(&correlation);
    };
    let db = context.d1("DB")?;
    if !repo::reserve_attempt(
        &db,
        &digest(&context.env, "verification-decision", &session.principal_id)?.0,
        oauth::now_seconds(),
        3600,
        100,
    )
    .await?
    {
        return verification_limited(&correlation);
    }
    let Some(code) = normalize_user_code(&input.user_code) else {
        return invalid_code(&correlation);
    };
    let digest = digest(&context.env, "user-code", &code)?;
    let Some(found) = repo::lookup(&db, &digest.0, oauth::now_seconds()).await? else {
        return invalid_code(&correlation);
    };
    if found.expires_at <= oauth::now_seconds() {
        return expired(&correlation);
    }
    let (decision, state) = match input.decision {
        Decision::Approve => ("approve", "approved"),
        Decision::Deny => ("deny", "denied"),
    };
    if !repo::decide(
        &db,
        &digest.0,
        &session.principal_id,
        &session.session_id,
        decision,
        oauth::now_seconds(),
    )
    .await?
    {
        return invalid_code(&correlation);
    }
    console_log!(
        "device_authorization_decided correlation_id={correlation} authorization_id={} client_id={} decision={decision}",
        found.id,
        found.client_id
    );
    oauth::json_response(&json!({"state":state}), 200, &correlation)
}

async fn browser_session(
    request: &Request,
    env: &Env,
    correlation: &str,
) -> Result<std::result::Result<repository::CurrentSession, Response>> {
    if guard::validate_browser_mutation(request, env).is_err() {
        return Ok(Err(oauth::oauth_problem(
            "access_denied",
            "Browser origin or request validation failed",
            403,
            correlation,
        )?));
    }
    let Some(session) = oauth::authenticated_session(request, env).await? else {
        return Ok(Err(oauth::oauth_problem(
            "login_required",
            "Sign in before reviewing the device request",
            401,
            correlation,
        )?));
    };
    let wire = guard::cookie(request, guard::SESSION_COOKIE).unwrap_or_default();
    if !guard::validate_session_csrf(
        request,
        &wire,
        oauth::secret(env, "CSRF_PEPPER")?.as_bytes(),
    ) {
        return Ok(Err(oauth::oauth_problem(
            "access_denied",
            "Session CSRF validation failed",
            403,
            correlation,
        )?));
    }
    Ok(Ok(session))
}

async fn read_json<T: DeserializeOwned>(request: &mut Request) -> Option<T> {
    let bytes = request.bytes().await.ok()?;
    if bytes.len() > 1024 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

pub(crate) fn digest(env: &Env, purpose: &str, value: &str) -> Result<SecretDigest> {
    Ok(SecretDigest::hmac(
        oauth::secret(env, "AUTHORIZATION_CODE_PEPPER")?.as_bytes(),
        format!("{purpose}:{value}").as_bytes(),
    ))
}

fn random_user_code() -> String {
    (0..8)
        .map(|_| USER_ALPHABET[OsRng.gen_range(0..USER_ALPHABET.len())] as char)
        .collect()
}
fn normalize_user_code(input: &str) -> Option<String> {
    let value: String = input
        .chars()
        .filter(|c| !c.is_ascii_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    (value.len() == 8 && value.bytes().all(|b| USER_ALPHABET.contains(&b))).then_some(value)
}
fn formatted_user_code(code: &str) -> String {
    format!("{}-{}", &code[..4], &code[4..])
}
fn invalid_request(correlation: &str) -> Result<Response> {
    oauth::oauth_problem(
        "invalid_request",
        "Malformed device authorization request",
        400,
        correlation,
    )
}
fn invalid_code(correlation: &str) -> Result<Response> {
    oauth::oauth_problem(
        "invalid_grant",
        "The device code is invalid or has already been decided",
        400,
        correlation,
    )
}
fn expired(correlation: &str) -> Result<Response> {
    oauth::oauth_problem(
        "expired_token",
        "The device authorization has expired; start again on your device",
        400,
        correlation,
    )
}
fn verification_limited(correlation: &str) -> Result<Response> {
    let response = oauth::oauth_problem(
        "slow_down",
        "Too many device verification attempts; try again in the next hour",
        429,
        correlation,
    )?;
    response.headers().set(
        "retry-after",
        &(3600 - oauth::now_seconds() % 3600).to_string(),
    )?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn user_codes_round_trip_without_ambiguous_characters() {
        for _ in 0..1000 {
            let code = random_user_code();
            assert_eq!(
                normalize_user_code(&formatted_user_code(&code).to_lowercase()),
                Some(code)
            );
        }
        assert_eq!(normalize_user_code("ABCD-0123"), None);
        assert_eq!(normalize_user_code("ABCD-EFGH-Z"), None);
    }
}
