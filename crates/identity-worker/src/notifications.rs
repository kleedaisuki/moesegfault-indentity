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
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error)
        .with_body(Some(serde_json::to_string(&notification)?.into()));
    let mut response = env
        .service("NOTIFICATIONS")?
        .fetch("https://notifications.internal/v1/messages", Some(init))
        .await
        .map_err(|_| Error::RustError("notification_transport_unavailable".into()))?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
