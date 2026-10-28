//! Durable handoff to the platform notification center, not a mail provider.

use serde::{Deserialize, Serialize};
use worker::{Env, Error, Headers, Method, RequestInit, RequestRedirect, Result};

#[derive(Serialize)]
struct VerificationNotification<'a> {
    service: &'static str,
    sender: &'static str,
    to: &'a str,
    template: &'static str,
    code: &'a str,
    expires_at: i64,
    locale: &'static str,
}

#[derive(Deserialize)]
struct AcceptedNotification {
    message_id: String,
    state: String,
}

/// Retries use the committed outbox ID and absolute expiry, so their payload is stable.
pub(crate) async fn send_verification(
    env: &Env,
    outbox_id: &str,
    recipient: &str,
    code: &str,
    expires_at: i64,
    correlation: &str,
) -> Result<()> {
    let notification = VerificationNotification {
        service: "identity",
        sender: "identity",
        to: recipient,
        template: "verification",
        code,
        expires_at,
        locale: "zh-CN",
    };
    let headers = Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("idempotency-key", outbox_id)?;
    headers.set("x-moesegfault-correlation-id", correlation)?;
    // Workers only supports follow/manual; requiring 202 below also rejects redirects.
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Manual)
        .with_body(Some(serde_json::to_string(&notification)?.into()));
    let mut response = env
        .service("NOTIFICATIONS")?
        .fetch("https://notifications.internal/v1/messages", Some(init))
        .await
        .map_err(|error| transport_error(&error))?;
    if response.status_code() != 202 {
        return Err(Error::RustError(format!(
            "notification_handoff_http_{}",
            response.status_code()
        )));
    }
    let accepted: AcceptedNotification = response
        .json()
        .await
        .map_err(|_| Error::RustError("notification_handoff_invalid_response".into()))?;
    if accepted.message_id.is_empty() || !matches!(accepted.state.as_str(), "queued" | "sent") {
        return Err(Error::RustError("notification_handoff_not_accepted".into()));
    }
    Ok(())
}

fn transport_error(error: &Error) -> Error {
    let (class, message) = match error {
        Error::UnknownJsError { name, message, .. } => {
            (js_error_class(name.as_deref()), message.as_str())
        }
        Error::JsError(message) => ("js_error", message.as_str()),
        Error::BindingError(_) => ("binding_error", ""),
        Error::Internal(_) => ("internal_js_value", ""),
        _ => ("worker_error", ""),
    };
    let reason = if message.starts_with("Invalid redirect value") {
        "invalid_redirect_mode"
    } else if message.contains("Network connection lost") {
        "connection_lost"
    } else if message.contains("The script will never generate a response") {
        "receiver_no_response"
    } else {
        "unclassified"
    };
    // Runtime exception messages may contain request data. Retain their useful
    // class and known failure reason without echoing arbitrary payload fragments.
    Error::RustError(format!(
        "notification_transport_unavailable binding=NOTIFICATIONS operation=fetch class={class} reason={reason}"
    ))
}

fn js_error_class(name: Option<&str>) -> &'static str {
    match name {
        Some("TypeError") => "type_error",
        Some("RangeError") => "range_error",
        Some("AbortError") => "abort_error",
        Some("TimeoutError") => "timeout_error",
        Some("Error") => "error",
        _ => "unknown_js_error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_diagnostics_preserve_actionable_reason_not_request_data() {
        let error = Error::JsError(
            "Invalid redirect value, recipient=klee@example.test code=01234567".into(),
        );
        let diagnostic = transport_error(&error).to_string();
        assert!(diagnostic.contains("reason=invalid_redirect_mode"));
        assert!(diagnostic.contains("class=js_error"));
        assert!(diagnostic.contains("binding=NOTIFICATIONS operation=fetch"));
        assert!(!diagnostic.contains("klee@example.test"));
        assert!(!diagnostic.contains("01234567"));
        assert_eq!(js_error_class(Some("TypeError")), "type_error");
        assert_eq!(
            js_error_class(Some("secret-bearing-name")),
            "unknown_js_error"
        );
    }

    #[test]
    fn verification_handoff_uses_stable_absolute_expiry_and_platform_template() {
        let request = VerificationNotification {
            service: "identity",
            sender: "identity",
            to: "klee@example.test",
            template: "verification",
            code: "01234567",
            expires_at: 1_800_000_600,
            locale: "zh-CN",
        };
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["sender"], "identity");
        assert_eq!(value["service"], "identity");
        assert_eq!(value["template"], "verification");
        assert_eq!(value["to"], "klee@example.test");
        assert_eq!(value["code"], "01234567");
        assert_eq!(value["expires_at"], 1_800_000_600_i64);
        assert!(value.get("html").is_none());
        assert!(value.get("text").is_none());
    }
}
