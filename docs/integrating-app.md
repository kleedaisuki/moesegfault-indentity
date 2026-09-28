# Integrating a new application / 新应用接入

This is the **implemented** first-release contract, not the larger target in ADR-0003.
本指南描述**当前已实现**的首期契约，而非 ADR-0003 中的远期目标。

## Choose a client / 选择客户端

| Application / 应用 | Registration / 登记 | Token endpoint authentication / 令牌端点认证 | Recommended boundary / 推荐边界 |
| --- | --- | --- | --- |
| Server-backed web app | `confidential` | `private_key_jwt` (`RS256` or `ES256`) | Backend for Frontend (BFF): hold tokens server-side and issue a host-only, HttpOnly, Secure, SameSite application cookie. |
| Installed desktop/mobile app | `native` | `none` plus mandatory PKCE S256 | External system browser; exact claimed HTTPS redirect or a registered loopback URI. |
| Browser-only SPA | **Not yet registered as a client type** | — | Put a BFF in front of it; do not assume `client_secret_basic`, token CORS, or browser token storage is supported. |

There is **no dynamic client registration or ordinary user-facing client-management API**. A deployment operator must review and provision the D1 client rows before an app can sign in. Migrations create scopes but **no application client**. This is the largest current onboarding friction; it is not solved by discovering the issuer alone. Do not insert keys or clients through an ordinary account session. See [configuration ownership](configuration.md#bootstrap-与部署配置--bootstrap-and-deployment-owned-configuration).

当前没有动态客户端注册或面向普通用户的客户端管理 API。部署管理员须先评审并写入 D1 客户端数据；迁移仅创建 scope，不创建应用客户端。单靠发现发行方无法完成接入。

## Registration handoff / 登记交接

Give the Identity operator the following non-secret manifest. The operator should encode it as a reviewed, forward-only deployment change and test it in staging first. Client **private** keys stay in the application secret store; Identity receives only public JWKs. Do not paste private key material into D1, the manifest, or this repository.

向 Identity 管理员提交以下非秘密清单，经预发布环境验证后再部署。客户端私钥只留在应用密钥存储中，Identity 只接收公钥。

```json
{
  "client_id": "new-app-staging",
  "display_name": "New App (staging)",
  "client_type": "confidential",
  "token_endpoint_auth_method": "private_key_jwt",
  "sector_identifier": "app-staging.example.com",
  "subject_salt_revision": 1,
  "redirect_uris": [{"uri": "https://app-staging.example.com/auth/callback", "match_mode": "exact"}],
  "post_logout_redirect_uris": [{"uri": "https://app-staging.example.com/"}],
  "scopes": ["openid", "profile", "offline_access"],
  "public_jwks": [{"kty": "EC", "crv": "P-256", "x": "PUBLIC_BASE64URL_X", "y": "PUBLIC_BASE64URL_Y", "alg": "ES256", "use": "sig", "kid": "new-app-2026-09"}]
}
```

Required D1 rows are `oauth_clients`, `oauth_redirect_uris`, `oauth_client_scopes`, and, for confidential clients, `oauth_client_keys`; optional logout redirects go in `oauth_post_logout_redirect_uris`. The `oauth_scopes` table already contains the implemented `openid`, `profile`, and `offline_access` grants. Use an exact redirect URI including its scheme, case, path, and query; no wildcard. A native loopback redirect may use `native_loopback_any_port` only for `http://127.0.0.1/...` or `http://[::1]/...`, with the same path and query. For other native redirects, register exact strings. Choose and retain the sector deliberately: changing it changes the app-visible pairwise `sub` and can sever accounts.

管理员应写入 `oauth_clients`、`oauth_redirect_uris`、`oauth_client_scopes`，机密客户端还需 `oauth_client_keys`；登出回调可选。redirect URI 须逐字匹配，不接受通配符。`sector_identifier` 一旦改变会改变应用看到的成对 `sub`，不可当作普通配置重命名。

**Executable provisioning path / 可执行的配置流程.** Place the manifest JSON in `.temp/new-app-staging.json`, replace the sample JWK with a real **public** key, then generate a create-only migration. The generator validates client type, supported scopes, redirect URI mode, and public JWK; it has no database access. Review the generated SQL and commit it under the next numbered filename in `migrations/environments/staging/`. Do not put ephemeral test or generated files outside repository `.temp` or `.cache`. A separate reviewed production manifest/migration belongs in `migrations/environments/production/` and must use production metadata. Shared schema changes continue to live at the top level of `migrations/`; the generator picks a number beyond both environment overlays to avoid a later collision.

**Environment isolation / 环境隔离.** Both issuers previously used the same migration directory. Provisioning two clients there would register *both* client IDs in *both* D1 databases, despite their distinct issuer contracts. `scripts/prepare-migrations.mjs <staging|production>` now composes the common migrations and exactly one reviewed environment overlay into `.temp/migration-streams/<target>`; each Wrangler D1 binding points to its corresponding stream. The composition retains the original `0001`–`0006` basenames, which are the already-applied D1 history keys. Run preparation before every manual `d1 migrations list/apply`; the release script and local migration command do this automatically. Do not invoke `d1 migrations apply` against an unprepared or wrong-environment stream.

```bash
node scripts/generate-oauth-client-migration.mjs .temp/new-app-staging.json
# Prints .temp/NNNN_oauth_client_new-app-staging.sql with the next available migration number.
# Review that file, recheck that its number is still free, then copy it into migrations/environments/staging/ for review.
node scripts/prepare-migrations.mjs staging
npx --no-install wrangler d1 migrations apply moesegfault-identity-staging --local --config wrangler.identity.jsonc
npx --no-install wrangler d1 migrations list moesegfault-identity-staging --remote --config wrangler.identity.jsonc
# After code review and local tests, deploy using the existing reviewed release process.
```

The generated migration writes the reviewed client facts **and** an immutable `identity.oauth_client.created` security audit event with an R2 archive-outbox row. The release script applies migrations before deploying Workers. In particular, `0005_oauth_pairwise_session.sql` must precede the Worker that issues client-scoped session IDs. Cloudflare documents rollback of a **failed migration file**, while previously successful migrations remain applied. The corresponding recovery is a new forward-only migration to set `oauth_clients.state='disabled'` (with its own audit/outbox event) or correct the client; do not delete an already deployed migration or assume a Worker rollback removes the client. Disabling blocks new authorizations and token/client authentication, but existing short-lived self-contained access tokens may remain accepted until expiry. Keep a client's private key outside this repository and rotate its registered public keys with an overlapping verification window.

**Provisioning verification / 配置核查** (use the reviewed database name and environment; read-only commands):

```bash
npx --no-install wrangler d1 execute moesegfault-identity-staging --remote --config wrangler.identity.jsonc \
  --command="SELECT client_id,client_type,token_endpoint_auth_method,sector_identifier,state FROM oauth_clients WHERE client_id='new-app-staging'"
npx --no-install wrangler d1 execute moesegfault-identity-staging --remote --config wrangler.identity.jsonc \
  --command="SELECT redirect_uri,match_mode FROM oauth_redirect_uris WHERE client_id='new-app-staging'"
npx --no-install wrangler d1 execute moesegfault-identity-staging --remote --config wrangler.identity.jsonc \
  --command="SELECT scope FROM oauth_client_scopes WHERE client_id='new-app-staging' ORDER BY scope"
```

The production environment uses `node scripts/prepare-migrations.mjs production`, `moesegfault-identity-production`, `--env production`, and **different** app IDs, origins, key material, and redirect URIs. Neither the example manifest nor read-only queries create the client. A reviewed provisioning operation is still required. Avoid ad-hoc partial multi-statement writes: D1's Worker `batch()` is transactional, whereas separate CLI invocations are not one transaction.

## Sign-in interaction / 登录交互

1. Discover `ISSUER/.well-known/openid-configuration`; reject a discovery document whose `issuer` differs **exactly** from the configured issuer. Follow its endpoint URLs rather than hardcoding production paths. Discovery returns 503 when issuance is not configured; local `.dev.vars.example` has `OAUTH_ENABLED=false` by default.
2. Generate a fresh random `state`, `nonce`, and 43–128-character PKCE `code_verifier`; store them in the application's short-lived server-side login transaction. Compute `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))` without padding. Include `response_type=code`, `client_id`, exact `redirect_uri`, `scope` beginning with `openid`, `state`, `nonce`, `code_challenge`, and `code_challenge_method=S256` in a **top-level browser navigation** to `authorization_endpoint`. Do not fetch this URL from JavaScript.
3. Identity sends the browser through Login and finally to the registered callback with `code`, original `state`, and `iss`. Compare `state` and `iss` before exchanging the code. On an error callback, do not redeem a code. The code is one-use and short-lived.
4. POST form data to `token_endpoint`: `grant_type=authorization_code`, `client_id`, `code`, the same `redirect_uri`, and `code_verifier`. A confidential client also sends `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and a fresh signed `client_assertion`; a native client sends neither assertion field. Identity does not support `client_secret_basic` or `client_secret_post`.
5. Verify the ID token with the discovered JWKS and fixed allowed algorithm `RS256`: signature, `iss`, `aud == client_id`, `exp`, and the original `nonce` (also check `iat`/`auth_time` as appropriate). Associate the application's local user with **(`issuer`, `sub`)**, not username, email, or Identity's internal `pid`. `sub` is pairwise per registered sector. Establish an app-local session; the app owns its business roles.
6. If `offline_access` was granted, store the refresh token server-side or in the native app's protected storage. Replace it **atomically** on every refresh; reuse of an old token revokes its family. Revoke it on application sign-out through the discovered revocation endpoint, using the same client authentication. The Identity session and app-local session are distinct.

机密客户端的 assertion 是以登记公钥对应私钥签名的 JWT：header 含登记的 `kid` 和 `alg`；claims 含 `iss=sub=client_id`、`aud=token_endpoint`、当前附近的 `iat`、不超过 5 分钟的 `exp`、每请求唯一的 `jti`。令牌与撤销请求都必须使用新的 assertion。不要复用一次性 `jti`。

For native apps, use the operating system's external browser, not an embedded WebView. For a BFF, allowlist the post-login return destination **inside the app**, and keep its session cookie separate from Identity's cookie. Do not add the new app origin to Identity's first-party `LOGIN_ORIGIN`/`ACCOUNT_ORIGIN` CORS list; this OAuth redirect flow does not need it.

## What is and is not available / 当前能力边界

| Surface / 能力 | Implemented today / 当前实现 |
| --- | --- |
| Discovery / JWKS | Issuer-specific metadata, RS256 signing JWKS; require issuance configuration. |
| OAuth | Authorization Code + PKCE S256; refresh rotation; revocation; RP-initiated logout; `private_key_jwt` or native `none`. |
| Advertised scopes | `openid`, `profile`, `offline_access`. The latter controls refresh issuance; `profile` currently yields `name` and `preferred_username`. |
| UserInfo | `sub`, and only with `profile`, `name` and `preferred_username`. Do not design onboarding around `email` or `phone` claims yet, even though their scope rows exist in D1. |
| Not implemented | Dynamic registration, client credentials, introspection, generic consent UI, account API bearer scopes, `email`/`phone` claims, browser-only OAuth client type, `client_secret_*` authentication. |
| Access JWT | Current `aud` is the OAuth `client_id`; it is **not** a general resource-server token or an RFC 9068 profile promise. Do not use it as cross-service authorization without a separate contract. |

Privacy/compatibility: newly issued access JWTs do **not** expose Identity's internal `pid` or global Identity session `sid`. The ID token's `sid` is client-scoped and opaque (`csid_...`); applications must not treat it as a cross-app identifier. Legacy access JWTs remain usable until their original expiry (at most 300 seconds). Identity still accepts already-issued raw-session-ID ID-token logout hints for compatibility; this is not limited to the access-token window, and new tokens never expose the raw ID. Existing `sub` and UserInfo semantics are unchanged. / 新 access JWT 不再泄露内部 `pid`、全局 `sid`；ID token 的 `sid` 仅在客户端范围内有意义。旧 access JWT 最多在原有 300 秒内有效；旧 ID-token 登出 hint 的兼容受理不受该窗口限制。

The only credentialed browser CORS origins are the deployment's Login and Account origins. Application authorization belongs to each application; an ID token proves authentication to the registered client, not permission to use unrelated services. There are no outbound application webhooks in this release.

For the existing first-party Account contact UI, `/v1/me/contacts` responses use canonical `contact_id` in subsequent `/v1/me/contacts/{contact_id}/verification-transactions` calls. The same-valued `identifier_id` is a deprecated response alias kept for deployed clients; new code must not build a path from a missing field or treat an ID from `/v1/me`'s separate identifier projection as a contact without checking its kind. This contact API is **not** an OAuth resource API for arbitrary new apps.

## Acceptance checklist / 接入验收

- [ ] Staging discovery returns 200, its exact issuer and every endpoint URL use staging, and JWKS contains the signing `kid`.
- [ ] Operator verifies client, redirect, key, and scope rows; unknown client or unregistered redirect fails without forwarding the browser to an attacker URL.
- [ ] A login round-trip validates `state`, `iss`, PKCE, and ID token `nonce`; repeat exchange of the same code fails.
- [ ] A new refresh token replaces the old value atomically; old-token replay is treated as session compromise.
- [ ] App session remains HttpOnly and host-only; no Identity tokens appear in browser storage, logs, URLs, or frontend bundles.
- [ ] Production uses distinct issuer, client ID, keys, and redirect URI; no staging credential is reused.

**References / 依据.** [OIDC Discovery](https://openid.net/specs/openid-connect-discovery-1_0-22.html) defines issuer-based metadata; [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) requires PKCE for public clients and exact redirect matching with the native loopback-port exception; [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html) defines authorization-response `iss`; [RFC 10017](https://www.rfc-editor.org/rfc/rfc10017.html) explains BFF's browser-token protection and its cookie/CSRF obligations; [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html) recommends external user agents for native apps. The formal analysis behind issuer mix-up defense is [Fett et al., ACM CCS 2016](https://doi.org/10.1145/2976749.2978385); it supports binding responses to the expected issuer, not skipping the ordinary `state` and PKCE checks. For D1 provisioning atomicity, see [Cloudflare D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). These standards do not imply this implementation already supports every optional extension.
