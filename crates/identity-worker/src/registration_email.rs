//! Pre-account mailbox verification, bound to a browser and consumed atomically at signup.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use identity_domain::{SecretDigest, TransactionId, normalize_email};
use serde::Deserialize;
use worker::{wasm_bindgen::JsValue, *};

use crate::{account, email_verification as email, guard, problem};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartInput {
    email: String,
    #[serde(default)]
    registration_capability: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteInput {
    code: String,
}

#[derive(Deserialize)]
struct Challenge {
    destination_digest: Vec<u8>,
    browser_digest: Vec<u8>,
    code_digest: Vec<u8>,
    state: String,
    proof_expires_at: Option<i64>,
}

/// An authorized mailbox proof; only this module can construct a consumption claim.
pub(crate) struct EmailProof {
    id: String,
    destination: Vec<u8>,
    browser: Vec<u8>,
}

/// Creates no principal, identifier, password, session, or reserved username.
pub(crate) async fn start(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = id();
    let Some(browser) = validated_browser(&request, &context.env)? else {
        return problem::response(
            "invalid_request",
            "Browser CSRF validation failed",
            403,
            &correlation,
        );
    };
    let input: StartInput = match request.json().await {
        Ok(input) => input,
        Err(_) => {
            return problem::response(
                "invalid_request",
                "Invalid email request",
                400,
                &correlation,
            );
        }
    };
    let destination = match normalize_email(&input.email) {
        Ok(value) => value,
        Err(_) => {
            return problem::response(
                "invalid_request",
                "Invalid email address",
                400,
                &correlation,
            );
        }
    };
    let db = context.d1("DB")?;
    let registration_pepper = secret(&context.env, "REGISTRATION_PEPPER")?;
    let invite = input
        .registration_capability
        .as_deref()
        .and_then(|value| value.split_once('.'));
    let invite_digest =
        invite.map(|(_, wire)| SecretDigest::hmac(registration_pepper.as_bytes(), wire.as_bytes()));
    if crate::repository::registration_decision(
        &db,
        invite.map(|(public, _)| public),
        invite_digest.as_ref().map(|digest| digest.0.as_slice()),
        now(),
    )
    .await?
    .is_none()
    {
        return problem::response(
            "registration_disabled",
            "Registration is not available",
            403,
            &correlation,
        );
    }
    let pepper = secret(&context.env, "CONTACT_VERIFICATION_PEPPER")?;
    let destination_digest = email::destination_digest(pepper.as_bytes(), &destination);
    let browser_digest = browser_digest(&pepper, &browser);
    let transaction = id();
    let outbox = id();
    let code = email::generate_code(&mut rand::thread_rng());
    let code_digest = signup_code_digest(&pepper, &transaction, &destination_digest.0, &code);
    let payload = email::seal_payload(
        &email::OutboxPayload {
            recipient: input.email.trim().to_owned(),
            code,
        },
        &secret(&context.env, "EMAIL_OUTBOX_KEY_V1")?,
        &outbox,
        &transaction,
    )?;
    let time = now();
    let result = db.batch(vec![
        db.prepare("UPDATE registration_email_transactions SET state='cancelled',consumed_at=?2 WHERE browser_digest=?1 AND state IN ('pending','verified')")
            .bind(&[blob(&browser_digest.0), integer(time)])?,
        db.prepare("INSERT INTO registration_email_transactions(transaction_id,destination_digest,browser_digest,code_digest,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6)")
            .bind(&[text(&transaction), blob(&destination_digest.0), blob(&browser_digest.0), blob(&code_digest.0), integer(time), integer(time+600)])?,
        db.prepare("INSERT INTO registration_email_outbox(outbox_id,transaction_id,payload_ciphertext,payload_nonce,next_attempt_at,created_at) VALUES(?1,?2,?3,?4,?5,?5)")
            .bind(&[text(&outbox), text(&transaction), blob(&payload.ciphertext), blob(&payload.nonce), integer(time)])?,
    ]).await;
    if let Err(error) = result {
        if error
            .to_string()
            .contains("registration_email_rate_limited")
        {
            let mut response = problem::response(
                "rate_limited",
                "Wait 60 seconds before requesting another code; limit 5 per hour",
                429,
                &correlation,
            )?;
            response.headers_mut().set("retry-after", "60")?;
            return Ok(response);
        }
        return Err(error);
    }
    if account::drain_email_job(
        &context.env,
        &outbox,
        time,
        &correlation,
        account::EmailQueue::REGISTRATION,
    )
    .await
    .is_err()
    {
        console_error!("registration_email_delivery_deferred correlation_id={correlation}");
    }
    json(
        &serde_json::json!({"transaction_id":transaction,"expires_at":date(time+600),"resend_after":date(time+60),"delivery_hint":email::mask_email(input.email.trim())}),
        201,
        &correlation,
    )
}

/// Bounds attempts and issues a short-lived, browser-bound proof after a correct code.
pub(crate) async fn complete(mut request: Request, context: RouteContext<()>) -> Result<Response> {
    let correlation = id();
    let Some(browser) = validated_browser(&request, &context.env)? else {
        return problem::response(
            "invalid_request",
            "Browser CSRF validation failed",
            403,
            &correlation,
        );
    };
    let input: CompleteInput = match request.json().await {
        Ok(input) => input,
        Err(_) => {
            return problem::response("invalid_request", "Invalid code request", 400, &correlation);
        }
    };
    if input.code.len() != 8 || !input.code.bytes().all(|v| v.is_ascii_digit()) {
        return problem::response(
            "invalid_request",
            "Enter the 8-digit code",
            400,
            &correlation,
        );
    }
    let transaction = context.param("id").map(String::as_str).unwrap_or("");
    let pepper = secret(&context.env, "CONTACT_VERIFICATION_PEPPER")?;
    let binding = browser_digest(&pepper, &browser);
    let db = context.d1("DB")?;
    let time = now();
    // Claim an attempt before checking the code so parallel guessing cannot bypass the budget.
    let Some(row) = db.prepare("UPDATE registration_email_transactions SET attempt_count=attempt_count+1 WHERE transaction_id=?1 AND browser_digest=?2 AND ((state='pending' AND expires_at>?3) OR (state='verified' AND proof_expires_at>?3)) AND attempt_count<10 AND NOT EXISTS(SELECT 1 FROM registration_email_consumptions c WHERE c.transaction_id=registration_email_transactions.transaction_id) RETURNING destination_digest,browser_digest,code_digest,state,proof_expires_at")
        .bind(&[text(transaction),blob(&binding.0),integer(time)])?.first::<Challenge>(None).await? else {
        return problem::response("invalid_transaction", "Code expired, replaced, or attempt limit reached", 400, &correlation);
    };
    // Only the encrypted outbox contains the destination. Bind comparison to the stored destination
    // digest instead, using a separate signup code domain from account-contact verification.
    let expected = signup_code_digest(&pepper, transaction, &row.destination_digest, &input.code);
    let stored: [u8; 32] = row
        .code_digest
        .clone()
        .try_into()
        .map_err(|_| Error::RustError("invalid signup digest".into()))?;
    if !expected.ct_eq(&SecretDigest(stored)) {
        db.prepare("UPDATE registration_email_transactions SET state='locked',consumed_at=?2 WHERE transaction_id=?1 AND state='pending' AND attempt_count>=10")
            .bind(&[text(transaction),integer(time)])?.run().await?;
        return problem::response(
            "verification_failed",
            "The verification code is incorrect",
            400,
            &correlation,
        );
    }
    if row.state == "verified" {
        return proof_response(
            &row,
            &pepper,
            transaction,
            row.proof_expires_at.unwrap_or(time),
            &correlation,
        );
    }
    let result = db.prepare("UPDATE registration_email_transactions SET state='verified',consumed_at=?2,proof_expires_at=?3 WHERE transaction_id=?1 AND state='pending' AND expires_at>?2")
        .bind(&[text(transaction),integer(time),integer(time+600)])?.run().await?;
    if result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 0 {
        return problem::response(
            "invalid_transaction",
            "Code is no longer valid",
            409,
            &correlation,
        );
    }
    proof_response(&row, &pepper, transaction, time + 600, &correlation)
}

/// Retrying a lost completion response recovers the same proof without extending its lifetime.
fn proof_response(
    row: &Challenge,
    pepper: &str,
    transaction: &str,
    expiry: i64,
    correlation: &str,
) -> Result<Response> {
    let token = proof_secret(
        pepper,
        transaction,
        &row.destination_digest,
        &row.browser_digest,
    );
    json(
        &serde_json::json!({"email_verification_token":format!("{transaction}.{}",token.to_base64url()),"expires_at":date(expiry)}),
        200,
        correlation,
    )
}

/// Validates an email/browser-specific proof without consuming it before credential creation.
pub(crate) async fn authorize(
    request: &Request,
    env: &Env,
    destination: &str,
    token: Option<&str>,
) -> Result<Option<EmailProof>> {
    let Some((transaction, wire)) = token.and_then(|value| value.split_once('.')) else {
        return Ok(None);
    };
    let Some(browser) = guard::cookie(request, guard::BROWSER_COOKIE) else {
        return Ok(None);
    };
    let pepper = secret(env, "CONTACT_VERIFICATION_PEPPER")?;
    let destination = email::destination_digest(pepper.as_bytes(), destination);
    let browser = browser_digest(&pepper, &browser);
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(wire) else {
        return Ok(None);
    };
    let Ok(bytes) = <[u8; 32]>::try_from(bytes) else {
        return Ok(None);
    };
    if !proof_secret(&pepper, transaction, &destination.0, &browser.0).ct_eq(&SecretDigest(bytes)) {
        return Ok(None);
    }
    let found = env.d1("DB")?.prepare("SELECT 1 AS found FROM registration_email_transactions t WHERE transaction_id=?1 AND destination_digest=?2 AND browser_digest=?3 AND state='verified' AND proof_expires_at>?4 AND NOT EXISTS(SELECT 1 FROM registration_email_consumptions c WHERE c.transaction_id=t.transaction_id)")
        .bind(&[text(transaction),blob(&destination.0),blob(&browser.0),integer(now())])?.first::<serde_json::Value>(None).await?;
    Ok(found.map(|_| EmailProof {
        id: transaction.to_owned(),
        destination: destination.0.to_vec(),
        browser: browser.0.to_vec(),
    }))
}

impl EmailProof {
    /// NULL/duplicate claims fail the whole batch, rolling back any account and session rows.
    pub(crate) fn consume(
        &self,
        db: &D1Database,
        principal: &str,
        time: i64,
    ) -> Result<D1PreparedStatement> {
        db.prepare("INSERT INTO registration_email_consumptions(transaction_id,principal_id,consumed_at) VALUES((SELECT transaction_id FROM registration_email_transactions t WHERE transaction_id=?1 AND destination_digest=?2 AND browser_digest=?3 AND state='verified' AND proof_expires_at>unixepoch()),?5,?4)")
            .bind(&[text(&self.id),blob(&self.destination),blob(&self.browser),integer(time),text(principal)])
    }
}

fn signup_code_digest(pepper: &str, id: &str, destination: &[u8], code: &str) -> SecretDigest {
    SecretDigest::hmac(
        pepper.as_bytes(),
        format!(
            "signup-code.v1:{id}:{}:{code}",
            URL_SAFE_NO_PAD.encode(destination)
        )
        .as_bytes(),
    )
}
fn proof_secret(pepper: &str, id: &str, destination: &[u8], browser: &[u8]) -> SecretDigest {
    SecretDigest::hmac(
        pepper.as_bytes(),
        format!(
            "signup-proof.v1:{id}:{}:{}",
            URL_SAFE_NO_PAD.encode(destination),
            URL_SAFE_NO_PAD.encode(browser)
        )
        .as_bytes(),
    )
}
fn browser_digest(pepper: &str, browser: &str) -> SecretDigest {
    SecretDigest::hmac(
        pepper.as_bytes(),
        format!("signup-browser.v1:{browser}").as_bytes(),
    )
}
fn validated_browser(request: &Request, env: &Env) -> Result<Option<String>> {
    if guard::validate_browser_mutation(request, env).is_err()
        || !guard::validate_browser_csrf(request, secret(env, "CSRF_PEPPER")?.as_bytes())
    {
        return Ok(None);
    }
    Ok(guard::cookie(request, guard::BROWSER_COOKIE))
}
fn secret(env: &Env, name: &str) -> Result<String> {
    Ok(env.secret(name)?.to_string())
}
fn id() -> String {
    TransactionId::new_v7(Date::now().as_millis()).to_string()
}
fn now() -> i64 {
    (Date::now().as_millis() / 1000) as i64
}
fn date(time: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(time)
        .expect("valid Worker clock")
        .format(&time::format_description::well_known::Rfc3339)
        .expect("valid timestamp")
}
fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}
fn integer(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}
fn blob(value: &[u8]) -> JsValue {
    worker::js_sys::Uint8Array::from(value).into()
}
fn json(value: &serde_json::Value, status: u16, correlation: &str) -> Result<Response> {
    let mut response = Response::from_json(value)?.with_status(status);
    response.headers_mut().set("cache-control", "no-store")?;
    response
        .headers_mut()
        .set("x-moesegfault-correlation-id", correlation)?;
    Ok(response)
}
