//! moeSegFault Identity 的 Cloudflare Workers 适配器。
//! Cloudflare Workers adapter for moeSegFault Identity.

#![forbid(unsafe_code)]

mod account;
mod account_repository;
mod api;
mod binding_repository;
mod bindings;
mod ceremony_state;
mod email_verification;
mod guard;
mod idempotency;
mod oauth;
pub(crate) mod oauth_repository;
mod password;
mod problem;
mod repository;
mod webcrypto;

use worker::*;

/// Worker fetch 入口；每个请求只从绑定解析状态，不保存全局可变数据。
/// Worker fetch entry point; request state comes from bindings, never mutable globals.
#[event(fetch)]
pub async fn fetch(request: Request, env: Env, _context: Context) -> Result<Response> {
    let request_origin = request.headers().get("origin")?;
    let credentialed_cors = guard::allowed_origin(&env, request_origin.as_deref()).is_some();

    macro_rules! idempotent {
        ($handler:path, $operation:ident, $caller:ident, $policy:ident) => {
            |request, context| async move {
                idempotency::run(
                    request,
                    context,
                    idempotency::Operation::$operation,
                    idempotency::Caller::$caller,
                    idempotency::ReplayPolicy::$policy,
                    $handler,
                )
                .await
            }
        };
    }

    let response = Router::new()
        .get_async("/healthz", api::health)
        .get_async("/.well-known/openid-configuration", oauth::discovery)
        .get_async("/.well-known/jwks.json", oauth::jwks)
        .get_async("/v1/meta/capabilities", api::capabilities)
        .get_async("/v1/browser-context", api::browser_context)
        .get_async("/v1/registration-policy", api::registration_policy)
        .options_async("/*path", api::preflight)
        .post_async(
            "/v1/registration-transactions",
            idempotent!(
                api::start_registration,
                CreateAccountRegistrationTransaction,
                Browser,
                SecretResult
            ),
        )
        .post_async(
            "/v1/password/registrations",
            idempotent!(
                password::register,
                PasswordRegistration,
                Browser,
                SecretResult
            ),
        )
        .post_async(
            "/v1/registration-transactions/:id/completion",
            idempotent!(
                api::finish_registration,
                CompleteRegistrationTransaction,
                Browser,
                SecretResult
            ),
        )
        .post_async(
            "/v1/authentication-transactions",
            idempotent!(
                api::start_authentication,
                CreateAuthenticationTransaction,
                Browser,
                SecretResult
            ),
        )
        .post_async(
            "/v1/password/authentications",
            idempotent!(
                password::authenticate,
                PasswordAuthentication,
                Browser,
                SecretResult
            ),
        )
        .post_async(
            "/v1/authentication-transactions/:id/completion",
            idempotent!(
                api::finish_authentication,
                CompleteAuthenticationTransaction,
                Browser,
                SecretResult
            ),
        )
        .get_async("/v1/principals/self", account::get_self)
        .get_async("/v1/me", account::get_self)
        .patch_async(
            "/v1/principals/self",
            idempotent!(account::update_self, UpdateSelf, Session, Replayable),
        )
        .patch_async(
            "/v1/me",
            idempotent!(account::update_self, UpdateSelf, Session, Replayable),
        )
        .get_async("/v1/me/contacts", account::list_contacts)
        .post_async(
            "/v1/me/contacts",
            idempotent!(account::create_contact, CreateContact, Session, Replayable),
        )
        .delete_async(
            "/v1/me/contacts/:contact_id",
            idempotent!(account::delete_contact, DeleteContact, Session, Replayable),
        )
        .patch_async(
            "/v1/me/contacts/:contact_id",
            idempotent!(account::update_contact, UpdateContact, Session, Replayable),
        )
        .get_async("/v1/me/security", account::security_posture)
        .get_async("/v1/me/preferences", account::get_preferences)
        .patch_async(
            "/v1/me/preferences",
            idempotent!(account::update_preferences, UpdatePreferences, Session, Replayable),
        )
        .post_async("/v1/me/avatar", account::upload_avatar)
        .delete_async("/v1/me/avatar", account::delete_avatar)
        .post_async(
            "/v1/me/contacts/:contact_id/verification-transactions",
            idempotent!(
                account::start_contact_verification,
                CreateContactVerification,
                Session,
                Replayable
            ),
        )
        .post_async(
            "/v1/me/contacts/:contact_id/verification-transactions/:transaction_id/completion",
            idempotent!(
                account::complete_contact_verification,
                CompleteContactVerification,
                Session,
                Replayable
            ),
        )
        .get_async("/v1/me/authorizations", account::list_authorizations)
        .delete_async(
            "/v1/me/authorizations/:authorization_id",
            account::revoke_authorization,
        )
        .put_async(
            "/v1/me/password",
            idempotent!(account::put_password, PutPassword, Session, Replayable),
        )
        .delete_async("/v1/me/password", account::delete_password)
        .delete_async(
            "/v1/principals/self",
            idempotent!(
                account::schedule_self_deletion,
                ScheduleSelfDeletion,
                Session,
                Replayable
            ),
        )
        .get_async("/v1/principals/self/identifiers", account::list_identifiers)
        .post_async(
            "/v1/principals/self/identifiers",
            idempotent!(
                account::create_identifier,
                CreateSelfIdentifier,
                Session,
                Replayable
            ),
        )
        .patch_async(
            "/v1/principals/self/identifiers/:identifier_id",
            idempotent!(
                account::update_identifier,
                UpdateSelfIdentifier,
                Session,
                Replayable
            ),
        )
        .delete_async(
            "/v1/principals/self/identifiers/:identifier_id",
            idempotent!(
                account::delete_identifier,
                DeleteSelfIdentifier,
                Session,
                Replayable
            ),
        )
        .get_async(
            "/v1/principals/self/authenticators",
            account::list_authenticators,
        )
        .post_async(
            "/v1/principals/self/authenticators/registration-transactions",
            idempotent!(
                account::start_authenticator_registration,
                CreateAuthenticatorRegistrationTransaction,
                Session,
                SecretResult
            ),
        )
        .patch_async(
            "/v1/principals/self/authenticators/:authenticator_id",
            idempotent!(
                account::update_authenticator,
                UpdateSelfAuthenticator,
                Session,
                Replayable
            ),
        )
        .delete_async(
            "/v1/principals/self/authenticators/:authenticator_id",
            idempotent!(
                account::revoke_authenticator,
                RevokeSelfAuthenticator,
                Session,
                Replayable
            ),
        )
        .get_async("/v1/principals/self/sessions", account::list_sessions)
        .delete_async(
            "/v1/principals/self/sessions",
            idempotent!(
                account::revoke_all_sessions,
                RevokeAllSelfSessions,
                Session,
                Replayable
            ),
        )
        .delete_async(
            "/v1/principals/self/sessions/:session_id",
            idempotent!(
                account::revoke_session,
                RevokeSelfSession,
                Session,
                Replayable
            ),
        )
        .get_async(
            "/v1/principals/self/recovery-codes",
            account::recovery_code_status,
        )
        .post_async(
            "/v1/principals/self/recovery-codes/rotations",
            idempotent!(
                account::rotate_recovery_codes,
                RotateSelfRecoveryCodes,
                Session,
                SecretResult
            ),
        )
        .get_async("/v1/binding-providers", bindings::list_providers)
        .get_async("/v1/principals/self/bindings", bindings::list_self)
        .delete_async(
            "/v1/principals/self/bindings/:binding_id",
            idempotent!(
                bindings::revoke_self,
                RevokeSelfBinding,
                Session,
                Replayable
            ),
        )
        // Binding creation commits its idempotency record and encrypted transaction in one D1
        // batch, so it deliberately does not use the generic pre-claim wrapper.
        // Binding 创建会在同一 D1 batch 提交幂等记录与加密事务，故不使用通用预声明 wrapper。
        .post_async("/v1/binding-transactions", bindings::create_transaction)
        .get_async("/v1/binding-transactions/callback", bindings::callback)
        .post_async(
            "/v1/recovery-transactions",
            idempotent!(
                api::start_recovery,
                CreateRecoveryTransaction,
                Browser,
                SecretResult
            ),
        )
        .post_async(
            "/v1/recovery-transactions/:id/completion",
            idempotent!(
                api::finish_recovery,
                CompleteRecoveryTransaction,
                Browser,
                SecretResult
            ),
        )
        .post_async("/v1/oauth/tokens", oauth::token)
        .get_async("/v1/oauth/authorizations", oauth::authorize)
        .get_async(
            "/v1/oauth/authorization-transactions/:id/resume",
            oauth::resume,
        )
        .post_async("/v1/oauth/revocations", oauth::revoke)
        .get_async("/v1/oidc/user-claims", oauth::userinfo)
        .get_async("/v1/oidc/logout-requests", oauth::logout_get)
        .post_async("/v1/oidc/logout-requests", oauth::logout_post)
        .run(request, env)
        .await?;

    // CORS belongs at the response boundary, not in success-only helpers. This guarantees
    // that the trusted Login SPA can read Problem Details and correlation IDs as well.
    // CORS 属于统一响应边界而不是仅成功 helper；这样可信 Login SPA 也能读取错误详情与关联 ID。
    if credentialed_cors {
        let headers = response.headers();
        headers.set(
            "access-control-allow-origin",
            request_origin.as_deref().unwrap_or_default(),
        )?;
        headers.set("access-control-allow-credentials", "true")?;
        headers.set(
            "access-control-expose-headers",
            "x-moesegfault-correlation-id",
        )?;
        headers.set("vary", "Origin")?;
    }
    Ok(response)
}

/// 定时归档不可变安全审计；失败留在 outbox，绝不阻塞登录。
/// Scheduled immutable audit archival; failures remain in the outbox and never block login.
#[event(scheduled)]
pub async fn scheduled(_event: ScheduledEvent, env: Env, _context: ScheduleContext) {
    if let Err(error) = account::drain_email_verification_outbox(&env, 25).await {
        console_error!("email_verification_outbox_drain_failed error={error}");
    }
    if let Err(error) = repository::drain_audit_archive(&env, 50).await {
        console_error!("audit_archive_drain_failed error={error}");
    }
    let now = (Date::now().as_millis() / 1_000) as i64;
    match env.d1("DB") {
        Ok(db) => {
            if let Err(error) = idempotency::purge_expired(&db, now, 500).await {
                console_error!("idempotency_expiry_purge_failed error={error}");
            }
        }
        Err(error) => console_error!("idempotency_expiry_purge_failed error={error}"),
    }
}
