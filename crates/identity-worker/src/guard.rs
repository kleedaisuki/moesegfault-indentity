//! 浏览器边界检查。/ Browser-boundary checks.

use identity_domain::SecretDigest;
use subtle::ConstantTimeEq;
use worker::{Env, Headers, Request};

pub const SESSION_COOKIE: &str = "__Host-identity_session";
pub const BROWSER_COOKIE: &str = "__Host-identity_browser";

/// 请求边界拒绝原因。/ Request-boundary rejection reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardError {
    Origin,
    ContentType,
    FetchMetadata,
    Csrf,
    BrowserBinding,
}

/// 校验浏览器 JSON mutation 的 Origin、内容类型与 Fetch Metadata。
/// Validates Origin, content type, and Fetch Metadata for browser JSON mutations.
pub fn validate_browser_mutation(request: &Request, env: &Env) -> Result<(), GuardError> {
    let headers = request.headers();
    let expected = login_origin(env);
    if header(headers, "origin").as_deref() != Some(expected.as_str()) {
        return Err(GuardError::Origin);
    }
    let content_type = header(headers, "content-type").unwrap_or_default();
    if !content_type
        .split(';')
        .next()
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(GuardError::ContentType);
    }
    if header(headers, "sec-fetch-site").as_deref() != Some("same-site")
        || header(headers, "sec-fetch-mode").as_deref() != Some("cors")
    {
        return Err(GuardError::FetchMetadata);
    }
    if header(headers, "x-moesegfault-csrf").is_none() {
        return Err(GuardError::Csrf);
    }
    Ok(())
}

/// 验证事务绑定 cookie 和 CSRF token 的摘要。
/// Verifies transaction-bound cookie and CSRF-token digests.
pub fn validate_transaction_secrets(
    request: &Request,
    csrf_digest: &[u8],
    browser_digest: &[u8],
    pepper: &[u8],
) -> Result<(), GuardError> {
    let csrf = header(request.headers(), "x-moesegfault-csrf").ok_or(GuardError::Csrf)?;
    let browser = cookie(request, BROWSER_COOKIE).ok_or(GuardError::BrowserBinding)?;
    let expected_csrf = SecretDigest::hmac(pepper, csrf.as_bytes());
    let expected_browser = SecretDigest::hmac(pepper, browser.as_bytes());
    let stored_csrf = digest_from_slice(csrf_digest).ok_or(GuardError::Csrf)?;
    let stored_browser = digest_from_slice(browser_digest).ok_or(GuardError::BrowserBinding)?;
    if !expected_csrf.ct_eq(&stored_csrf) {
        return Err(GuardError::Csrf);
    }
    if !expected_browser.ct_eq(&stored_browser) {
        return Err(GuardError::BrowserBinding);
    }
    Ok(())
}

/// 从 Cookie header 中提取严格命名项。/ Extracts an exactly named item from Cookie.
#[must_use]
pub fn cookie(request: &Request, name: &str) -> Option<String> {
    header(request.headers(), "cookie")?
        .split(';')
        .find_map(|pair| {
            let (key, value) = pair.trim().split_once('=')?;
            (key == name).then(|| value.to_owned())
        })
}

/// 事务浏览器绑定 Cookie。/ Transaction browser-binding cookie.
#[must_use]
pub fn browser_cookie(value: &str) -> String {
    format!("{BROWSER_COOKIE}={value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=300")
}

/// Identity SSO 会话 Cookie。/ Identity SSO session cookie.
#[must_use]
pub fn session_cookie(value: &str) -> String {
    format!("{SESSION_COOKIE}={value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000")
}

/// 清除会话 Cookie。/ Clears the identity-session cookie.
#[must_use]
pub fn clear_session_cookie() -> &'static str {
    "__Host-identity_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
}

/// 从会话 bearer secret 派生仅用于同会话 mutation 的 CSRF token。
/// Derives a CSRF token usable only with the same session bearer secret.
#[must_use]
pub fn session_csrf_token(session_wire: &str, csrf_pepper: &[u8]) -> String {
    SecretDigest::hmac(csrf_pepper, session_wire.as_bytes()).to_base64url()
}

/// 常量时间验证会话绑定 CSRF header。/ Constant-time verifies the session-bound CSRF header.
#[must_use]
pub fn validate_session_csrf(request: &Request, session_wire: &str, csrf_pepper: &[u8]) -> bool {
    let Some(presented) = header(request.headers(), "x-moesegfault-csrf") else {
        return false;
    };
    let expected = session_csrf_token(session_wire, csrf_pepper);
    presented.as_bytes().ct_eq(expected.as_bytes()).into()
}

/// 验证匿名 browser-context 绑定的 CSRF token。
/// Verifies the CSRF token bound to the anonymous browser context.
#[must_use]
pub fn validate_browser_csrf(request: &Request, csrf_pepper: &[u8]) -> bool {
    let Some(browser_wire) = cookie(request, BROWSER_COOKIE) else {
        return false;
    };
    validate_session_csrf(request, &browser_wire, csrf_pepper)
}

/// 配置的精确 login Origin。/ Configured exact login origin.
#[must_use]
pub fn login_origin(env: &Env) -> String {
    env.var("LOGIN_ORIGIN")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "https://login.moesegfault.dev".to_owned())
}

pub fn header(headers: &Headers, name: &str) -> Option<String> {
    headers.get(name).ok().flatten()
}

fn digest_from_slice(value: &[u8]) -> Option<SecretDigest> {
    Some(SecretDigest(value.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookies_never_set_domain_and_have_expected_same_site() {
        let session = session_cookie("opaque");
        assert!(session.contains("SameSite=Lax"));
        assert!(!session.to_ascii_lowercase().contains("domain="));
        let browser = browser_cookie("opaque");
        assert!(browser.contains("SameSite=Strict"));
        assert!(browser.contains("Max-Age=300"));
    }
}
