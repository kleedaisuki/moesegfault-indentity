//! 浏览器边界检查。/ Browser-boundary checks.

use identity_domain::SecretDigest;
use subtle::ConstantTimeEq;
use worker::{Env, Headers, Request};

pub const SESSION_COOKIE: &str = "__Host-identity_session";
pub const BROWSER_COOKIE: &str = "__Host-identity_browser";

/// 校验幂等键的公共线路语法；缺失键与错误响应仍由各路由自行处理。
/// Validates shared Idempotency-Key wire syntax; routes retain their own missing-key responses.
#[must_use]
pub fn valid_idempotency_key(value: &str) -> bool {
    (16..=128).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_graphic())
}

/// 请求边界拒绝原因。/ Request-boundary rejection reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardError {
    Origin,
    ContentType,
    FetchMetadata,
    Csrf,
    BrowserBinding,
}

/// 浏览器端点可接受的第一方 Origin 集合。/ First-party Origin set accepted by a browser endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginScope {
    /// 仅 Login 可发起匿名 ceremony。/ Only Login may initiate anonymous ceremonies.
    LoginOnly,
    /// Login 与 Account 均可管理已认证会话。/ Both Login and Account may manage a session.
    PairedFrontends,
}

/// 校验浏览器 JSON mutation 的精确 Origin、内容类型和 CSRF header；显式跨站信号被拒绝。
/// Validates exact Origin, content type, and CSRF header for browser JSON mutations; explicit cross-site signals are rejected.
pub fn validate_browser_mutation(request: &Request, env: &Env) -> Result<(), GuardError> {
    let headers = request.headers();
    if allowed_origin(env, header(headers, "origin").as_deref()).is_none() {
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
    if !fetch_site_allowed(header(headers, "sec-fetch-site").as_deref()) {
        return Err(GuardError::FetchMetadata);
    }
    if header(headers, "x-moesegfault-csrf").is_none() {
        return Err(GuardError::Csrf);
    }
    Ok(())
}

/// Fetch Metadata 缺失时回退到精确 Origin 与 CSRF 校验；只拒绝显式跨站请求。
/// Falls back to exact Origin and CSRF checks when Fetch Metadata is absent; rejects only explicit cross-site requests.
#[must_use]
pub fn fetch_site_allowed(site: Option<&str>) -> bool {
    site != Some("cross-site")
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
    let presented = header(request.headers(), "x-moesegfault-csrf");
    csrf_token_matches(presented.as_deref(), session_wire, csrf_pepper)
}

/// 在请求解析后仍用常量时间比较，不把 Fetch Metadata 当作凭据。
/// Uses a constant-time comparison after header extraction; Fetch Metadata is not a credential.
fn csrf_token_matches(presented: Option<&str>, session_wire: &str, csrf_pepper: &[u8]) -> bool {
    let Some(presented) = presented else {
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

/// 配置的精确 account Origin。/ Configured exact account origin.
#[must_use]
pub fn account_origin(env: &Env) -> String {
    env.var("ACCOUNT_ORIGIN")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "https://account.moesegfault.dev".to_owned())
}

/// 将请求 Origin 映射到部署允许列表中的规范值。
/// Maps a request Origin to its canonical value in the deployment allowlist.
#[must_use]
pub fn allowed_origin(env: &Env, presented: Option<&str>) -> Option<String> {
    allowed_origin_for(env, presented, OriginScope::PairedFrontends)
}

/// 按端点能力范围映射可信 Origin。/ Maps a trusted Origin under an endpoint capability scope.
#[must_use]
pub fn allowed_origin_for(
    env: &Env,
    presented: Option<&str>,
    scope: OriginScope,
) -> Option<String> {
    configured_origin(presented, &login_origin(env), &account_origin(env), scope)
}

/// 按能力范围在环境配对的前端 Origin 中精确匹配。
/// Exactly matches an Origin against the environment-paired frontends permitted by the scope.
///
/// Keeping the capability matrix in one helper prevents middleware and handlers from drifting.
fn configured_origin(
    presented: Option<&str>,
    login: &str,
    account: &str,
    scope: OriginScope,
) -> Option<String> {
    let presented = presented?;
    [
        Some(login),
        (scope == OriginScope::PairedFrontends).then_some(account),
    ]
    .into_iter()
    .flatten()
    .find(|allowed| *allowed == presented)
    .map(str::to_owned)
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
    fn idempotency_key_syntax_matches_all_mutation_boundaries() {
        assert!(valid_idempotency_key("!234567890abc,;~"));
        assert!(valid_idempotency_key(&"~".repeat(128)));
        for invalid in [
            "",
            "short",
            &"x".repeat(129),
            "1234567890abcde ",
            "1234567890abcde\u{7f}",
            "1234567890abcd\u{00e9}",
        ] {
            assert!(!valid_idempotency_key(invalid), "accepted {invalid:?}");
        }
    }

    #[test]
    fn cookies_never_set_domain_and_have_expected_same_site() {
        let session = session_cookie("opaque");
        assert!(session.contains("SameSite=Lax"));
        assert!(!session.to_ascii_lowercase().contains("domain="));
        let browser = browser_cookie("opaque");
        assert!(browser.contains("SameSite=Strict"));
        assert!(browser.contains("Max-Age=300"));
    }

    #[test]
    fn default_origins_are_distinct_https_sites() {
        // Env cannot be constructed natively; keep the invariant exercised by its defaults.
        assert_ne!(
            "https://login.moesegfault.dev",
            "https://account.moesegfault.dev"
        );
    }

    #[test]
    fn configured_origin_accepts_both_exact_first_party_origins() {
        let login = "https://login.moesegfault.dev";
        let account = "https://account.moesegfault.dev";

        assert_eq!(
            configured_origin(Some(login), login, account, OriginScope::PairedFrontends).as_deref(),
            Some(login)
        );
        assert_eq!(
            configured_origin(Some(account), login, account, OriginScope::PairedFrontends)
                .as_deref(),
            Some(account)
        );
    }

    #[test]
    fn configured_origin_rejects_missing_or_deceptive_origins() {
        let login = "https://login.moesegfault.dev";
        let account = "https://account.moesegfault.dev";

        assert_eq!(
            configured_origin(None, login, account, OriginScope::PairedFrontends),
            None
        );
        assert_eq!(
            configured_origin(
                Some("https://account.moesegfault.dev.evil.example"),
                login,
                account,
                OriginScope::PairedFrontends
            ),
            None
        );
        assert_eq!(
            configured_origin(
                Some("https://moesegfault.dev"),
                login,
                account,
                OriginScope::PairedFrontends
            ),
            None
        );
    }

    #[test]
    fn configured_origin_scope_encodes_the_endpoint_capability_matrix() {
        let login = "https://login.moesegfault.dev";
        let account = "https://account.moesegfault.dev";

        assert_eq!(
            configured_origin(Some(login), login, account, OriginScope::LoginOnly).as_deref(),
            Some(login)
        );
        assert_eq!(
            configured_origin(Some(account), login, account, OriginScope::LoginOnly),
            None
        );
        assert_eq!(
            configured_origin(Some(account), login, account, OriginScope::PairedFrontends)
                .as_deref(),
            Some(account)
        );
    }

    #[test]
    fn fetch_metadata_is_optional_but_explicit_cross_site_is_denied() {
        assert!(fetch_site_allowed(None));
        assert!(fetch_site_allowed(Some("same-site")));
        assert!(fetch_site_allowed(Some("same-origin")));
        assert!(fetch_site_allowed(Some("none")));
        assert!(fetch_site_allowed(Some("future-value")));
        assert!(!fetch_site_allowed(Some("cross-site")));
    }

    #[test]
    fn metadata_fallback_does_not_bypass_origin_or_token_requirements() {
        let login = "https://login.moesegfault.dev";
        let account = "https://account.moesegfault.dev";
        let accepted_origin =
            configured_origin(Some(login), login, account, OriginScope::LoginOnly);
        let token = session_csrf_token("browser wire", b"csrf pepper");
        assert!(fetch_site_allowed(None));
        assert_eq!(accepted_origin.as_deref(), Some(login));
        assert!(csrf_token_matches(
            Some(&token),
            "browser wire",
            b"csrf pepper"
        ));
        assert!(!csrf_token_matches(None, "browser wire", b"csrf pepper"));
        assert!(!csrf_token_matches(
            Some("wrong"),
            "browser wire",
            b"csrf pepper"
        ));
        assert!(!csrf_token_matches(
            Some(&token),
            "other browser",
            b"csrf pepper"
        ));
        assert!(configured_origin(None, login, account, OriginScope::LoginOnly).is_none());
        assert!(configured_origin(Some(account), login, account, OriginScope::LoginOnly).is_none());
    }
}
