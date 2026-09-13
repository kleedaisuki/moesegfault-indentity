//! 输入与时限策略。/ Input and lifetime policy.

use serde::{Deserialize, Serialize};

/// 服务端时限策略。/ Server-side lifetime policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifetimePolicy {
    pub transaction_seconds: u64,
    pub recent_authentication_seconds: u64,
    pub session_idle_seconds: u64,
    pub session_absolute_seconds: u64,
    pub authorization_code_seconds: u64,
    pub access_token_seconds: u64,
    pub refresh_token_seconds: u64,
}

impl Default for LifetimePolicy {
    fn default() -> Self {
        Self {
            transaction_seconds: 5 * 60,
            recent_authentication_seconds: 5 * 60,
            session_idle_seconds: 12 * 60 * 60,
            session_absolute_seconds: 30 * 24 * 60 * 60,
            authorization_code_seconds: 60,
            access_token_seconds: 5 * 60,
            refresh_token_seconds: 30 * 24 * 60 * 60,
        }
    }
}

/// 规范化并验证首期 username。/ Normalizes and validates a first-release username.
///
/// 允许 3–32 个 ASCII 小写字母、数字和 `_`，首字符必须为字母。
/// Allows 3–32 lowercase ASCII letters, digits, and `_`; the first character
/// must be a letter.
pub fn normalize_username(input: &str) -> Result<String, PolicyError> {
    let value = input.trim().to_ascii_lowercase();
    let bytes = value.as_bytes();
    if !(3..=32).contains(&bytes.len()) {
        return Err(PolicyError::InvalidUsername);
    }
    if !bytes.first().is_some_and(u8::is_ascii_lowercase)
        || bytes
            .iter()
            .any(|c| !(c.is_ascii_alphanumeric() || *c == b'_'))
    {
        return Err(PolicyError::InvalidUsername);
    }
    Ok(value)
}

/// 验证 PKCE S256 challenge 的 RFC 7636 线格式。
/// Validates the RFC 7636 wire format of a PKCE S256 challenge.
pub fn validate_pkce_s256(challenge: &str) -> Result<(), PolicyError> {
    if challenge.len() != 43
        || challenge
            .bytes()
            .any(|b| !(b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    {
        return Err(PolicyError::InvalidPkce);
    }
    Ok(())
}

/// 检查登记的 redirect URI 精确匹配。/ Checks exact registered redirect-URI match.
#[must_use]
pub fn redirect_uri_matches(requested: &str, registered: &[String]) -> bool {
    registered.iter().any(|item| item == requested)
}

/// 稳定策略错误。/ Stable policy errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PolicyError {
    #[error("invalid username")]
    InvalidUsername,
    #[error("invalid PKCE S256 challenge")]
    InvalidPkce,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_normalization_has_one_canonical_form() {
        assert_eq!(normalize_username(" Klee_42 ").unwrap(), "klee_42");
        for invalid in ["ab", "_abc", "abc-", "1abc", "a.b", "中午好"] {
            assert_eq!(
                normalize_username(invalid),
                Err(PolicyError::InvalidUsername)
            );
        }
    }

    #[test]
    fn pkce_requires_sha256_output_shape() {
        assert!(validate_pkce_s256("0123456789012345678901234567890123456789012").is_ok());
        assert_eq!(validate_pkce_s256("plain"), Err(PolicyError::InvalidPkce));
        assert_eq!(
            validate_pkce_s256("01234567890123456789012345678901234567890=2"),
            Err(PolicyError::InvalidPkce)
        );
    }

    #[test]
    fn redirects_are_not_prefix_or_case_matches() {
        let allowed = vec!["https://client.example/callback".to_owned()];
        assert!(redirect_uri_matches(
            "https://client.example/callback",
            &allowed
        ));
        assert!(!redirect_uri_matches(
            "https://client.example/callback/evil",
            &allowed
        ));
        assert!(!redirect_uri_matches(
            "HTTPS://client.example/callback",
            &allowed
        ));
    }
}
