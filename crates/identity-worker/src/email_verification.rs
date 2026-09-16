//! 邮箱验证码生成、摘要和邮件呈现。
//! Email-verification code generation, digesting, and message rendering.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    Key, XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use identity_domain::SecretDigest;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use worker::{Error, Result};

const CODE_SPACE: u32 = 100_000_000;
pub(crate) const KEY_REVISION: i64 = 1;
pub(crate) const TEMPLATE_REVISION: i64 = 1;

/// 持久投递队列中的敏感明文，必须始终以 AEAD 密文存储。
/// Sensitive outbox plaintext, always persisted as AEAD ciphertext.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OutboxPayload {
    pub(crate) recipient: String,
    pub(crate) code: String,
}

/// 密文与独立 nonce，可直接写入 D1 BLOB。
/// Ciphertext and independent nonce ready for D1 BLOB storage.
pub(crate) struct SealedPayload {
    pub(crate) ciphertext: Vec<u8>,
    pub(crate) nonce: [u8; 24],
}

/// 同时包含纯文本与 HTML 的邮件内容。
/// Mail content carrying both plain-text and HTML alternatives.
pub(crate) struct VerificationEmail {
    pub(crate) text: String,
    pub(crate) html: String,
}

/// 用密码学随机源生成保留前导零的 8 位验证码。
/// Generates an eight-digit verification code, preserving leading zeroes.
pub(crate) fn generate_code(rng: &mut impl RngCore) -> String {
    // Rejection sampling avoids the modulo bias that `% CODE_SPACE` alone introduces.
    // 拒绝采样消除直接取模导致的偏差。
    let zone = u32::MAX - (u32::MAX % CODE_SPACE);
    let value = loop {
        let candidate = rng.next_u32();
        if candidate < zone {
            break candidate % CODE_SPACE;
        }
    };
    format!("{value:08}")
}

/// 把交易、当前目的地和验证码绑定到单个 HMAC 摘要。
/// Binds the transaction, current destination, and code into one HMAC digest.
pub(crate) fn code_digest(
    pepper: &[u8],
    transaction_id: &str,
    destination: &str,
    code: &str,
) -> SecretDigest {
    bound_digest(
        pepper,
        b"moesegfault.contact-verification.code.v1\0",
        &[
            transaction_id.as_bytes(),
            destination.as_bytes(),
            code.as_bytes(),
        ],
    )
}

/// 单独绑定交易与目的地，用于检测验证期间联系方式变更。
/// Binds a transaction to its destination so contact edits invalidate it.
pub(crate) fn destination_digest(pepper: &[u8], destination: &str) -> SecretDigest {
    bound_digest(
        pepper,
        b"moesegfault.contact-verification.destination.v1\0",
        &[destination.as_bytes()],
    )
}

fn bound_digest(pepper: &[u8], domain: &[u8], fields: &[&[u8]]) -> SecretDigest {
    let capacity = domain.len() + fields.iter().map(|field| 8 + field.len()).sum::<usize>();
    let mut input = Vec::with_capacity(capacity);
    input.extend_from_slice(domain);
    for field in fields {
        input.extend_from_slice(&(field.len() as u64).to_be_bytes());
        input.extend_from_slice(field);
    }
    SecretDigest::hmac(pepper, &input)
}

/// 隐藏邮箱本地部分，但保留域名以便用户识别投递目标。
/// Masks the email local part while retaining the domain as a delivery hint.
pub(crate) fn mask_email(destination: &str) -> String {
    let Some((local, domain)) = destination.rsplit_once('@') else {
        return "***".to_owned();
    };
    let first = local
        .chars()
        .next()
        .map_or(String::new(), |c| c.to_string());
    format!("{first}***@{domain}")
}

/// 呈现中英双语验证邮件；所有动态值在 HTML 中都会转义。
/// Renders a bilingual verification email with all dynamic HTML values escaped.
pub(crate) fn render_email(destination: &str, code: &str, minutes: i64) -> VerificationEmail {
    let text = format!(
        "moeSegFault 邮箱验证 / Email verification\n\n验证码 / Verification code: {code}\n收件地址 / Address: {destination}\n\n验证码将在 {minutes} 分钟后失效。\nThis code expires in {minutes} minutes.\n如果不是你发起的请求，请忽略此邮件。\nIf you did not request this, you can ignore this email."
    );
    let address = escape_html(destination);
    let code = escape_html(code);
    let html = format!(
        "<!doctype html><html lang=\"zh-CN\"><body><h1>moeSegFault 邮箱验证</h1><p>Email verification</p><p>验证码 / Verification code:</p><p><strong style=\"font-size:2em;letter-spacing:.15em\">{code}</strong></p><p>收件地址 / Address: {address}</p><p>验证码将在 {minutes} 分钟后失效。<br>This code expires in {minutes} minutes.</p><p>如果不是你发起的请求，请忽略此邮件。<br>If you did not request this, you can ignore this email.</p></body></html>"
    );
    VerificationEmail { text, html }
}

/// 使用 XChaCha20-Poly1305 加密投递负载，并把队列标识及版本放入 AAD。
/// Seals an outbox payload with XChaCha20-Poly1305 and binds IDs/revisions as AAD.
pub(crate) fn seal_payload(
    payload: &OutboxPayload,
    key_wire: &str,
    outbox_id: &str,
    transaction_id: &str,
) -> Result<SealedPayload> {
    let key = decode_key(key_wire)?;
    let mut nonce = [0_u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let plaintext = serde_json::to_vec(payload)?;
    let cipher = XChaCha20Poly1305::new(&Key::from(key));
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &plaintext,
                aad: &outbox_aad(outbox_id, transaction_id),
            },
        )
        .map_err(|_| Error::RustError("failed to encrypt email outbox payload".into()))?;
    Ok(SealedPayload { ciphertext, nonce })
}

/// 解密并验证投递负载；密码学失败不区分具体原因。
/// Opens and authenticates an outbox payload without distinguishing crypto failures.
pub(crate) fn open_payload(
    ciphertext: &[u8],
    nonce: &[u8],
    key_wire: &str,
    outbox_id: &str,
    transaction_id: &str,
) -> Result<OutboxPayload> {
    let key = decode_key(key_wire)?;
    let nonce: [u8; 24] = nonce
        .try_into()
        .map_err(|_| Error::RustError("invalid email outbox payload".into()))?;
    let cipher = XChaCha20Poly1305::new(&Key::from(key));
    let plaintext = cipher
        .decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: ciphertext,
                aad: &outbox_aad(outbox_id, transaction_id),
            },
        )
        .map_err(|_| Error::RustError("invalid email outbox payload".into()))?;
    serde_json::from_slice(&plaintext)
        .map_err(|_| Error::RustError("invalid email outbox payload".into()))
}

fn decode_key(value: &str) -> Result<[u8; 32]> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| Error::BindingError("EMAIL_OUTBOX_KEY_V1 must be base64url".into()))?
        .try_into()
        .map_err(|_| Error::BindingError("EMAIL_OUTBOX_KEY_V1 must decode to 32 bytes".into()))
}

fn outbox_aad(outbox_id: &str, transaction_id: &str) -> Vec<u8> {
    format!(
        "moesegfault.identity.email-outbox:outbox={outbox_id}:transaction={transaction_id}:key={KEY_REVISION}:template={TEMPLATE_REVISION}"
    )
    .into_bytes()
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{SeedableRng, rngs::StdRng};

    #[test]
    fn generated_code_is_exactly_eight_ascii_digits() {
        let mut rng = StdRng::seed_from_u64(7);
        for _ in 0..1_000 {
            let code = generate_code(&mut rng);
            assert_eq!(code.len(), 8);
            assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
        }
    }

    #[test]
    fn digest_is_bound_to_transaction_destination_and_code() {
        let digest = code_digest(b"pepper", "tx-a", "klee@example.net", "12345678");
        assert!(!digest.ct_eq(&code_digest(
            b"pepper",
            "tx-b",
            "klee@example.net",
            "12345678"
        )));
        assert!(!digest.ct_eq(&code_digest(
            b"pepper",
            "tx-a",
            "other@example.net",
            "12345678"
        )));
        assert!(!digest.ct_eq(&code_digest(
            b"pepper",
            "tx-a",
            "klee@example.net",
            "87654321"
        )));
    }

    #[test]
    fn destination_digest_is_stable_for_rate_limiting() {
        assert!(
            destination_digest(b"pepper", "klee@example.net")
                .ct_eq(&destination_digest(b"pepper", "klee@example.net"))
        );
        assert!(
            !destination_digest(b"pepper", "klee@example.net")
                .ct_eq(&destination_digest(b"pepper", "other@example.net"))
        );
    }

    #[test]
    fn delivery_hint_masks_local_part() {
        assert_eq!(mask_email("klee@example.net"), "k***@example.net");
        assert_eq!(mask_email("x@example.net"), "x***@example.net");
        assert_eq!(mask_email("invalid"), "***");
    }

    #[test]
    fn html_content_escapes_dynamic_values() {
        let mail = render_email("<img src=x onerror=alert(1)>@example.net", "12&<\"'", 10);
        assert!(!mail.html.contains("<img src=x"));
        assert!(
            mail.html
                .contains("&lt;img src=x onerror=alert(1)&gt;@example.net")
        );
        assert!(mail.html.contains("12&amp;&lt;&quot;&#39;"));
    }

    #[test]
    fn encrypted_payload_round_trips_and_is_bound_to_ids() {
        let key = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        let payload = OutboxPayload {
            recipient: "klee@example.net".into(),
            code: "01234567".into(),
        };
        let sealed = seal_payload(&payload, &key, "outbox-a", "tx-a").unwrap();
        assert!(
            !sealed
                .ciphertext
                .windows(payload.code.len())
                .any(|window| window == payload.code.as_bytes())
        );
        assert_eq!(
            open_payload(&sealed.ciphertext, &sealed.nonce, &key, "outbox-a", "tx-a").unwrap(),
            payload
        );
        assert!(open_payload(&sealed.ciphertext, &sealed.nonce, &key, "outbox-b", "tx-a").is_err());
    }
}
