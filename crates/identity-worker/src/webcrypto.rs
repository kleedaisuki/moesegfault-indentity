//! Workers WebCrypto 上的精简 JOSE 适配器。/ Minimal JOSE adapter over Workers WebCrypto.
//!
//! 模块只实现序列化和算法选择；RSA/ECDSA 运算始终交给平台 WebCrypto。
//! This module implements only serialization and algorithm selection; all
//! RSA/ECDSA operations are delegated to platform WebCrypto.

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use js_sys::{Array, JSON, Object, Reflect, Uint8Array};
use serde_json::Value;
use wasm_bindgen::{JsCast as _, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Crypto, CryptoKey, RsaHashedImportParams};
use worker::{Error, Result};

/// 已解析但尚未信任的 compact JWT。/ Parsed but not-yet-trusted compact JWT.
pub struct ParsedJwt {
    pub header: Value,
    pub claims: Value,
    pub signing_input: String,
    pub signature: Vec<u8>,
}

/// 使用 PKCS#8 RSA 私钥生成 RS256 compact JWT。
/// Produces an RS256 compact JWT with a PKCS#8 RSA private key.
pub async fn sign_rs256(pkcs8_wire: &str, kid: &str, claims: &Value) -> Result<String> {
    let header = serde_json::json!({"alg":"RS256","kid":kid,"typ":"JWT"});
    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header)?),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims)?),
    );
    let bytes = decode_pkcs8(pkcs8_wire)?;
    let data = Uint8Array::from(bytes.as_slice());
    let algorithm = rsa_import_algorithm()?;
    let usages = Array::new();
    usages.push(&JsValue::from_str("sign"));
    let key = JsFuture::from(
        subtle()?
            .import_key_with_object(
                "pkcs8",
                data.as_ref(),
                algorithm.as_ref(),
                false,
                usages.as_ref(),
            )
            .map_err(js_error)?,
    )
    .await
    .map_err(js_error)?
    .dyn_into::<CryptoKey>()
    .map_err(js_error)?;
    let signature = JsFuture::from(
        subtle()?
            .sign_with_str_and_u8_array("RSASSA-PKCS1-v1_5", &key, signing_input.as_bytes())
            .map_err(js_error)?,
    )
    .await
    .map_err(js_error)?;
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(Uint8Array::new(&signature).to_vec())
    ))
}

/// 解析 JWT 的三段 compact 线格式；此函数不建立信任。
/// Parses the three-part compact JWT wire format; this function establishes no trust.
pub fn parse_jwt(wire: &str) -> Result<ParsedJwt> {
    let mut parts = wire.split('.');
    let (Some(header), Some(claims), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Error::RustError("invalid compact JWT".into()));
    };
    let decode_json = |part: &str| -> Result<Value> {
        let bytes = URL_SAFE_NO_PAD
            .decode(part)
            .map_err(|_| Error::RustError("invalid JWT base64url".into()))?;
        serde_json::from_slice(&bytes).map_err(Into::into)
    };
    Ok(ParsedJwt {
        header: decode_json(header)?,
        claims: decode_json(claims)?,
        signing_input: format!("{header}.{claims}"),
        signature: URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| Error::RustError("invalid JWT signature".into()))?,
    })
}

/// 使用部署提供的公开 JWK 验证 RS256 或 ES256 JWT 签名。
/// Verifies an RS256 or ES256 JWT signature with a deployment-provided public JWK.
pub async fn verify_jwt_signature(
    parsed: &ParsedJwt,
    algorithm: &str,
    jwk_json: &str,
) -> Result<bool> {
    let jwk = JSON::parse(jwk_json)
        .map_err(js_error)?
        .dyn_into::<Object>()
        .map_err(js_error)?;
    let usages = Array::new();
    usages.push(&JsValue::from_str("verify"));
    let (import_algorithm, verify_algorithm): (Object, Object) = match algorithm {
        "RS256" => {
            let import = rsa_import_algorithm()?.unchecked_into::<Object>();
            let verify = Object::new();
            Reflect::set(&verify, &"name".into(), &"RSASSA-PKCS1-v1_5".into()).map_err(js_error)?;
            (import, verify)
        }
        "ES256" => {
            let import = Object::new();
            Reflect::set(&import, &"name".into(), &"ECDSA".into()).map_err(js_error)?;
            Reflect::set(&import, &"namedCurve".into(), &"P-256".into()).map_err(js_error)?;
            let verify = Object::new();
            Reflect::set(&verify, &"name".into(), &"ECDSA".into()).map_err(js_error)?;
            Reflect::set(&verify, &"hash".into(), &"SHA-256".into()).map_err(js_error)?;
            (import, verify)
        }
        _ => return Ok(false),
    };
    let key = JsFuture::from(
        subtle()?
            .import_key_with_object("jwk", &jwk, &import_algorithm, false, usages.as_ref())
            .map_err(js_error)?,
    )
    .await
    .map_err(js_error)?
    .dyn_into::<CryptoKey>()
    .map_err(js_error)?;
    let verified = JsFuture::from(
        subtle()?
            .verify_with_object_and_u8_array_and_u8_array(
                &verify_algorithm,
                &key,
                &parsed.signature,
                parsed.signing_input.as_bytes(),
            )
            .map_err(js_error)?,
    )
    .await
    .map_err(js_error)?;
    Ok(verified.as_bool().unwrap_or(false))
}

fn subtle() -> Result<web_sys::SubtleCrypto> {
    let global = js_sys::global();
    let crypto = Reflect::get(&global, &JsValue::from_str("crypto"))
        .map_err(js_error)?
        .dyn_into::<Crypto>()
        .map_err(js_error)?;
    Ok(crypto.subtle())
}

fn rsa_import_algorithm() -> Result<RsaHashedImportParams> {
    let algorithm = RsaHashedImportParams::new_with_str("SHA-256");
    Reflect::set(
        algorithm.as_ref(),
        &"name".into(),
        &"RSASSA-PKCS1-v1_5".into(),
    )
    .map_err(js_error)?;
    Ok(algorithm)
}

fn decode_pkcs8(wire: &str) -> Result<Vec<u8>> {
    let compact: String = wire
        .lines()
        .filter(|line| !line.trim_start().starts_with("-----"))
        .flat_map(|line| line.trim().chars())
        .collect();
    STANDARD
        .decode(&compact)
        .or_else(|_| URL_SAFE_NO_PAD.decode(&compact))
        .map_err(|_| Error::RustError("OIDC private key is not PKCS#8 base64/PEM".into()))
}

fn js_error(value: JsValue) -> Error {
    Error::RustError(
        value
            .as_string()
            .unwrap_or_else(|| format!("WebCrypto error: {value:?}")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jwt_parser_rejects_extra_or_missing_segments() {
        for invalid in ["a.b", "a.b.c.d", ""] {
            assert!(parse_jwt(invalid).is_err());
        }
    }

    #[test]
    fn pkcs8_accepts_pem_and_plain_base64() {
        let raw = [1_u8, 2, 3, 4];
        let base64 = STANDARD.encode(raw);
        assert_eq!(decode_pkcs8(&base64).unwrap(), raw);
        let pem = format!("-----BEGIN PRIVATE KEY-----\n{base64}\n-----END PRIVATE KEY-----");
        assert_eq!(decode_pkcs8(&pem).unwrap(), raw);
    }
}
