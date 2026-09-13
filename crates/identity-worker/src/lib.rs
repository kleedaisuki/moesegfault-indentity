//! moeSegFault Identity 的 Cloudflare Workers 适配器。
//! Cloudflare Workers adapter for moeSegFault Identity.

#![forbid(unsafe_code)]

mod api;
mod guard;
mod problem;
mod repository;

use worker::*;

/// Worker fetch 入口；每个请求只从绑定解析状态，不保存全局可变数据。
/// Worker fetch entry point; request state comes from bindings, never mutable globals.
#[event(fetch)]
pub async fn fetch(request: Request, env: Env, _context: Context) -> Result<Response> {
    Router::new()
        .get_async("/healthz", api::health)
        .get_async("/.well-known/openid-configuration", api::discovery)
        .get_async("/.well-known/jwks.json", api::jwks)
        .get_async("/v1/meta/capabilities", api::capabilities)
        .get_async("/v1/browser-context", api::browser_context)
        .options_async("/*path", api::preflight)
        .post_async("/v1/registration-transactions", api::start_registration)
        .post_async(
            "/v1/registration-transactions/:id/completion",
            api::finish_registration,
        )
        .post_async("/v1/authentication-transactions", api::start_authentication)
        .post_async(
            "/v1/authentication-transactions/:id/completion",
            api::finish_authentication,
        )
        .get_async("/v1/principals/self", api::get_self)
        .get_async(
            "/v1/principals/self/authenticators",
            api::list_authenticators,
        )
        .get_async("/v1/principals/self/sessions", api::list_sessions)
        .delete_async("/v1/principals/self/sessions/:id", api::revoke_session)
        .post_async("/v1/principals/self/sessions/revoke-all", api::revoke_all)
        .get_async("/v1/principals/self/bindings", api::unavailable)
        .post_async("/v1/binding-transactions", api::unavailable)
        .post_async("/v1/recovery-transactions", api::unavailable)
        .post_async("/v1/oauth/tokens", api::unavailable)
        .get_async("/v1/oauth/authorizations", api::unavailable)
        .post_async("/v1/oauth/revocations", api::unavailable)
        .get_async("/v1/oidc/user-claims", api::unavailable)
        .get_async("/v1/oidc/logout-requests", api::unavailable)
        .post_async("/v1/oidc/logout-requests", api::unavailable)
        .run(request, env)
        .await
}

/// 定时归档不可变安全审计；失败留在 outbox，绝不阻塞登录。
/// Scheduled immutable audit archival; failures remain in the outbox and never block login.
#[event(scheduled)]
pub async fn scheduled(_event: ScheduledEvent, env: Env, _context: ScheduleContext) {
    if let Err(error) = repository::drain_audit_archive(&env, 50).await {
        console_error!("audit_archive_drain_failed error={error}");
    }
}
