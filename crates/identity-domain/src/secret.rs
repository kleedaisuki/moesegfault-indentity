//! 不透明秘密的生成后处理与摘要。/ Opaque-secret post-processing and digests.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// 32 字节秘密的摘要，适用于 session、code 与 token 存储。
/// Digest of a 32-byte secret for session, code, and token storage.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SecretDigest(#[serde(with = "digest_serde")] pub [u8; 32]);

impl core::fmt::Debug for SecretDigest {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("SecretDigest([REDACTED])")
    }
}

impl SecretDigest {
    /// 用用途隔离的 pepper 计算 HMAC-SHA-256。
    /// Computes HMAC-SHA-256 with a purpose-separated pepper.
    #[must_use]
    pub fn hmac(pepper: &[u8], secret: &[u8]) -> Self {
        let mut mac = Hmac::<Sha256>::new_from_slice(pepper).expect("HMAC accepts any key length");
        mac.update(secret);
        Self(mac.finalize().into_bytes().into())
    }

    /// 常量时间比较。/ Constant-time comparison.
    #[must_use]
    pub fn ct_eq(&self, other: &Self) -> bool {
        bool::from(self.0.ct_eq(&other.0))
    }

    /// D1 友好的 base64url 编码。/ D1-friendly base64url encoding.
    #[must_use]
    pub fn to_base64url(self) -> String {
        URL_SAFE_NO_PAD.encode(self.0)
    }
}

/// 生成后由调用方唯一持有的 bearer secret。
/// Bearer secret solely owned by the caller after generation.
pub struct OpaqueSecret([u8; 32]);

impl OpaqueSecret {
    /// 从平台 CSPRNG 提供的 32 字节构造。
    /// Constructs from 32 bytes supplied by the platform CSPRNG.
    #[must_use]
    pub const fn from_random_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// 返回 cookie/token 线格式。/ Returns the cookie/token wire format.
    #[must_use]
    pub fn expose_base64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0)
    }

    /// 派生只存服务端的摘要。/ Derives the server-stored digest.
    #[must_use]
    pub fn digest(&self, pepper: &[u8]) -> SecretDigest {
        SecretDigest::hmac(pepper, &self.0)
    }
}

impl core::fmt::Debug for OpaqueSecret {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("OpaqueSecret([REDACTED])")
    }
}

mod digest_serde {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use serde::{Deserialize, Deserializer, Serializer, de};

    pub fn serialize<S>(value: &[u8; 32], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&URL_SAFE_NO_PAD.encode(value))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<[u8; 32], D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = String::deserialize(deserializer)?;
        let bytes = URL_SAFE_NO_PAD.decode(wire).map_err(de::Error::custom)?;
        bytes
            .try_into()
            .map_err(|_| de::Error::custom("digest must be 32 bytes"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_deterministic_and_purpose_separated() {
        let secret = OpaqueSecret::from_random_bytes([7; 32]);
        let sessions = secret.digest(b"session pepper");
        assert!(sessions.ct_eq(&secret.digest(b"session pepper")));
        assert!(!sessions.ct_eq(&secret.digest(b"refresh pepper")));
        assert!(!format!("{secret:?}").contains('7'));
        assert!(!format!("{sessions:?}").contains(&sessions.to_base64url()));
    }

    #[test]
    fn digest_json_round_trips() {
        let digest = SecretDigest::hmac(b"pepper", b"secret");
        let wire = serde_json::to_string(&digest).unwrap();
        let decoded: SecretDigest = serde_json::from_str(&wire).unwrap();
        assert!(digest.ct_eq(&decoded));
    }
}
