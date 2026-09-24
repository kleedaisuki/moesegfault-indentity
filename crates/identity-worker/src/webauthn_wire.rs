//! WebAuthn 注册选项的公开 JSON 投影与凭据 transport 规范化。
//! Public JSON projection of WebAuthn registration options and credential transport normalization.

use serde_json::{Value, json};

/// 对所有注册仪式强制可发现凭据和 ES256，并映射为公开的 snake_case 契约。
/// Enforces discoverable credentials and ES256 for every registration ceremony, then maps to the public snake_case contract.
///
/// 输入是 passkey-auth 的 camelCase 选项；缺失的可选数组保持缺失，已有数组顺序保持不变。
/// The input is passkey-auth's camelCase options; absent optional arrays stay absent and existing array order is preserved.
///
/// # Example
/// ```ignore
/// let public_key = webauthn_wire::registration_options_to_wire(serde_json::to_value(challenge)?);
/// ```
pub(crate) fn registration_options_to_wire(mut value: Value) -> Value {
    // passkey-auth 0.1.3 只暴露 preferred；所有注册仪式要求可发现凭据。
    // passkey-auth 0.1.3 exposes "preferred" only; all registration ceremonies require discoverable credentials.
    value["authenticatorSelection"]["residentKey"] = json!("required");
    value["authenticatorSelection"]["requireResidentKey"] = json!(true);
    if let Some(parameters) = value
        .get_mut("pubKeyCredParams")
        .and_then(Value::as_array_mut)
    {
        parameters.retain(|parameter| parameter.get("alg").and_then(Value::as_i64) == Some(-7));
    }
    rename(&mut value, "pubKeyCredParams", "pub_key_cred_params");
    rename(&mut value, "excludeCredentials", "exclude_credentials");
    rename(
        &mut value,
        "authenticatorSelection",
        "authenticator_selection",
    );
    if let Some(user) = value.get_mut("user") {
        rename(user, "displayName", "display_name");
    }
    if let Some(selection) = value.get_mut("authenticator_selection") {
        rename(
            selection,
            "authenticatorAttachment",
            "authenticator_attachment",
        );
        rename(selection, "residentKey", "resident_key");
        rename(selection, "requireResidentKey", "require_resident_key");
        rename(selection, "userVerification", "user_verification");
    }
    value
}

/// 对持久化的 transport hints 排序去重，符合 OpenAPI `uniqueItems` 契约。
/// Sorts and deduplicates persisted transport hints to satisfy the OpenAPI `uniqueItems` contract.
pub(crate) fn canonicalize_transports(transports: &mut Vec<String>) {
    transports.sort_unstable();
    transports.dedup();
}

fn rename(value: &mut Value, from: &str, to: &str) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if let Some(item) = object.remove(from) {
        object.insert(to.to_owned(), item);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 所有三个注册入口共享此完整 JSON 快照；不经过 HTTP/DB 的差异由调用方测试覆盖。
    /// All three registration entries share this complete JSON snapshot; caller tests cover their HTTP/DB-independent usage.
    pub(crate) fn assert_registration_golden() {
        let input = json!({
            "rp":{"id":"login.example","name":"Example"},
            "user":{"id":"handle","name":"klee","displayName":"Klee"},
            "challenge":"challenge", "timeout":300000,
            "pubKeyCredParams":[{"type":"public-key","alg":-7},{"type":"public-key","alg":-8}],
            "excludeCredentials":[{"type":"public-key","id":"existing","transports":["hybrid","internal","hybrid"]}],
            "authenticatorSelection":{"authenticatorAttachment":"platform","residentKey":"preferred","requireResidentKey":false,"userVerification":"required"},
            "attestation":"none"
        });
        let expected = json!({
            "rp":{"id":"login.example","name":"Example"},
            "user":{"id":"handle","name":"klee","display_name":"Klee"},
            "challenge":"challenge", "timeout":300000,
            "pub_key_cred_params":[{"type":"public-key","alg":-7}],
            "exclude_credentials":[{"type":"public-key","id":"existing","transports":["hybrid","internal","hybrid"]}],
            "authenticator_selection":{"authenticator_attachment":"platform","resident_key":"required","require_resident_key":true,"user_verification":"required"},
            "attestation":"none"
        });
        let actual = registration_options_to_wire(input);
        assert_eq!(actual, expected);
        assert_eq!(
            serde_json::to_string(&actual).unwrap(),
            serde_json::to_string(&expected).unwrap()
        );
        assert_eq!(
            registration_options_to_wire(json!({"user":{"name":"klee"}})),
            json!({"user":{"name":"klee"},"authenticator_selection":{"resident_key":"required","require_resident_key":true}})
        );
    }

    #[test]
    fn registration_projection_preserves_full_wire_contract() {
        assert_registration_golden();
    }
}
