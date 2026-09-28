# New application onboarding

Use this reference when adding a new application, migrating an existing sign-in flow, or reviewing whether Identity can support an application's trust model. For protocol mechanics, read [OIDC integration](oidc-integration.md) after deciding the caller type.

## Make the contract explicit before coding

Create a short, reviewable integration record in the application's own repository:

| Decision | Record |
| --- | --- |
| Environment pair | Fixed Identity issuer and application origin for local, staging, and production separately |
| Caller | Web BFF/confidential, installed native/public, or resource service; do not label an SPA confidential |
| Registration | Reviewed `client_id`, client type, authentication method, public JWK/`kid` if confidential, exact login and post-logout URIs, allowed scopes, pairwise-subject sector |
| User key | `(issuer, sub)`; define how existing product accounts map or migrate without joining by mutable email |
| Token custody | Server-side store for BFF; platform-protected store for native; browser holds only its local application session |
| Authorization | Product-local roles/policy, with required token scopes and the exact accepted audience documented per route |
| Lifecycle | Login transaction lifetime, refresh serialization and atomic replacement, local logout, optional Identity logout, error telemetry |

Do not copy example IDs, secrets, issuer URLs, or redirects into production. Registration is deployment-owned D1 data; migrations do not provision an application client. Use the manifest, reviewed provisioning handoff, and environment acceptance checklist in [`../../../docs/integrating-app.md`](../../../docs/integrating-app.md), with configuration ownership in [`../../../docs/configuration.md`](../../../docs/configuration.md). If registration is absent, deliver the registration request and application-side code/configuration separately rather than fabricating a working client. Local `.dev.vars.example` has `OAUTH_ENABLED=false`: enabling OAuth and creating a local client are explicit setup steps, not evidence that login works out of the box.

## Choose the architecture by what must be protected

### Browser application

Put Authorization Code + S256 PKCE and tokens in a BFF. The browser receives only a host-only application session cookie (`Secure`, `HttpOnly`, appropriate `SameSite`) and application CSRF protection. Use the application backend as a same-origin boundary for business APIs. Do not expose Identity's first-party cookie API, client private key, or refresh token to the browser.

Account APIs are cookie/CSRF-bound first-party operations, not resource endpoints that accept an OIDC bearer scope. A product needing profile data should use supported OIDC claims/UserInfo, or request a new delegated API contract rather than forwarding its access token to `/v1/me`.

### Native application

Register a public/native client and use the system browser with PKCE. Prefer a platform-bound HTTPS callback; use a loopback callback only where registered and supported. Store refresh material in platform-protected storage, not a bundled secret or ordinary app preferences.

### Resource service

The current access-token `aud` is the OAuth `client_id`, not a configurable API identifier. A resource service may accept a token only if **that exact client ID is its intended audience** and it can enforce signature, issuer, time, `token_use=access`, and scopes. If several clients need one independently addressed API, do not relax audience checks: raise a provider capability decision for a resource audience/token-exchange design.

### Machine workload

No advertised `client_credentials` grant or introspection endpoint exists. Do not repurpose human refresh tokens. Treat workload identity as a separate design and provisioning request rather than a client-configuration trick.

## Implementation slice and acceptance evidence

Begin with one product login and one protected route, not every account feature. Use an established framework OIDC/JOSE client. Configure exact issuer, discovery, redirect, client authentication, PKCE, state, nonce, callback `iss`, ID-token verification, and local session creation. Then add the lifecycle needed by this product: refresh if `offline_access` is justified; otherwise short local sessions; local logout and optional RP-initiated Identity logout.

An integration is not complete merely because the login page opens. Demonstrate:

1. a successful login binds the intended `(issuer, sub)` to a local session and the protected route sees the correct local account;
2. wrong `state`, `nonce`, issuer, audience, signature, or token kind cannot create a session;
3. refresh racing, replay, and expired local sessions do not expose authenticated content;
4. logout clears the local session even when Identity navigation or revocation fails;
5. staging cannot accept production issuer, keys, cookies, or redirects;
6. logs preserve correlation IDs and stable error codes but not tokens, codes, cookies, or raw personal data.

Run these as application tests plus one environment-paired smoke test once the registration exists. Where Identity's current issuer contract blocks an acceptance item, document the precise gap and leave the failing capability unclaimed. The Identity OpenAPI file describes its own HTTP API; it is not an SDK and does not provision a relying party automatically.
