//! WebAuthn ceremony 状态的静态加密。/ Encryption at rest for WebAuthn ceremony state.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    Key, XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use rand::RngCore;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use worker::{Error, Result};

const VERSION: u8 = 1;
const ALGORITHM: &str = "XChaCha20-Poly1305";

/// 版本化的认证加密信封；nonce 与 ciphertext 使用无填充 Base64URL。
/// Versioned authenticated-encryption envelope; nonce and ciphertext use unpadded Base64URL.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    algorithm: String,
    nonce: String,
    ciphertext: String,
}

/// 使用 XChaCha20-Poly1305 封装可序列化 ceremony 状态。
/// Seals serializable ceremony state with XChaCha20-Poly1305.
///
/// `transaction_id` 与 `kind` 作为附加认证数据（Additional Authenticated Data, AAD），
/// 因而密文不能在事务或流程类型之间互换。每次调用都使用新的 192-bit nonce。
/// `transaction_id` and `kind` are AAD, so ciphertext cannot be moved across transactions
/// or ceremony kinds. Every call uses a fresh 192-bit nonce.
pub fn seal<T: Serialize>(
    value: &T,
    key_wire: &str,
    transaction_id: &str,
    kind: &str,
) -> Result<String> {
    let key = decode_key(key_wire)?;
    let mut nonce = [0_u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let plaintext = serde_json::to_vec(value)?;
    let key = Key::from(key);
    let nonce = XNonce::from(nonce);
    let cipher = XChaCha20Poly1305::new(&key);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: &plaintext,
                aad: &aad(transaction_id, kind),
            },
        )
        .map_err(|_| Error::RustError("failed to encrypt ceremony state".into()))?;
    serde_json::to_string(&Envelope {
        version: VERSION,
        algorithm: ALGORITHM.to_owned(),
        nonce: URL_SAFE_NO_PAD.encode(&nonce[..]),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
    .map_err(Into::into)
}

/// 打开并验证 ceremony 状态信封。/ Opens and authenticates a ceremony-state envelope.
///
/// 未知版本、算法、错误 key、被篡改密文或不匹配的 AAD 都只产生同一种内部错误；
/// callers 不得把密码学细节暴露给客户端。
/// Unknown versions/algorithms, wrong keys, tampering, and mismatched AAD all produce an
/// internal error; callers must not expose cryptographic detail to clients.
pub fn open<T: DeserializeOwned>(
    envelope_json: &str,
    key_wire: &str,
    transaction_id: &str,
    kind: &str,
) -> Result<T> {
    let envelope: Envelope = serde_json::from_str(envelope_json)
        .map_err(|_| Error::RustError("invalid ceremony state envelope".into()))?;
    if envelope.version != VERSION || envelope.algorithm != ALGORITHM {
        return Err(Error::RustError(
            "unsupported ceremony state envelope".into(),
        ));
    }
    let key = decode_key(key_wire)?;
    let nonce = URL_SAFE_NO_PAD
        .decode(envelope.nonce)
        .map_err(|_| Error::RustError("invalid ceremony state envelope".into()))?;
    let nonce: [u8; 24] = nonce
        .try_into()
        .map_err(|_| Error::RustError("invalid ceremony state envelope".into()))?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(envelope.ciphertext)
        .map_err(|_| Error::RustError("invalid ceremony state envelope".into()))?;
    let key = Key::from(key);
    let nonce = XNonce::from(nonce);
    let cipher = XChaCha20Poly1305::new(&key);
    let plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &ciphertext,
                aad: &aad(transaction_id, kind),
            },
        )
        .map_err(|_| Error::RustError("ceremony state authentication failed".into()))?;
    serde_json::from_slice(&plaintext)
        .map_err(|_| Error::RustError("invalid ceremony state plaintext".into()))
}

fn decode_key(value: &str) -> Result<[u8; 32]> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| Error::BindingError("TRANSACTION_STATE_KEY must be base64url".into()))?
        .try_into()
        .map_err(|_| Error::BindingError("TRANSACTION_STATE_KEY must decode to 32 bytes".into()))
}

fn aad(transaction_id: &str, kind: &str) -> Vec<u8> {
    format!("moesegfault.identity.ceremony-state.v{VERSION}:{kind}:{transaction_id}").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct Fixture {
        challenge: String,
    }

    fn key(byte: u8) -> String {
        URL_SAFE_NO_PAD.encode([byte; 32])
    }

    #[test]
    fn envelope_round_trips_without_plaintext_challenge() {
        let value = Fixture {
            challenge: "plaintext-challenge-canary".into(),
        };
        let envelope = seal(&value, &key(7), "tx-1", "authentication").unwrap();
        assert!(!envelope.contains(&value.challenge));
        let opened: Fixture = open(&envelope, &key(7), "tx-1", "authentication").unwrap();
        assert_eq!(opened, value);
    }

    #[test]
    fn aad_prevents_cross_transaction_replay() {
        let envelope = seal(
            &Fixture {
                challenge: "challenge".into(),
            },
            &key(7),
            "tx-1",
            "registration",
        )
        .unwrap();
        assert!(open::<Fixture>(&envelope, &key(7), "tx-2", "registration").is_err());
        assert!(open::<Fixture>(&envelope, &key(7), "tx-1", "authentication").is_err());
        assert!(open::<Fixture>(&envelope, &key(8), "tx-1", "registration").is_err());
    }

    #[test]
    fn rejects_malformed_key_and_envelope() {
        assert!(
            seal(
                &Fixture {
                    challenge: "x".into()
                },
                "short",
                "tx",
                "kind"
            )
            .is_err()
        );
        assert!(open::<Fixture>("{}", &key(7), "tx", "kind").is_err());
    }
}
