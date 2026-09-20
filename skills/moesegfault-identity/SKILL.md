---
name: moesegfault-identity
description: Integrate applications and services with moeSegFault Identity through OIDC, validate its tokens, or extend the first-party Login and Account clients. Use for client onboarding, sign-in/session/logout flows, and Identity account API consumption; not for designing an unrelated authentication system.
---

# moeSegFault Identity

Use Identity as an identity authority, not as a bag of endpoints. Select the caller model first, then load only the reference needed for that model.

## Choose the integration surface

| Caller | Use | Do not use |
| --- | --- | --- |
| Browser application | A same-origin Backend for Frontend (BFF) registered as a confidential OIDC client; keep tokens server-side and expose only an application session cookie | Identity cookies or account endpoints directly from an unrelated browser origin; tokens in browser storage |
| Native application | A pre-registered public/native OIDC client, system browser, Authorization Code, and S256 PKCE | Embedded WebViews or a bundled client secret |
| Resource service | Only when its exact accepted audience is the registered OAuth `client_id`: locally validate access tokens, then authorize on scopes and local policy | Login as a validation API, ID tokens as bearer tokens, or a separately invented resource audience |
| Machine workload | Report the provider-contract gap and request an explicit Identity capability decision | Reusing a human token or inventing `client_credentials`; the current issuer does not advertise it |
| `apps/login` or `apps/account` | The first-party cookie, CSRF, idempotency, and ceremony/account APIs defined by OpenAPI | Treating the repository's private TypeScript clients as a published SDK |
| Deployment/control plane | Reviewed, deterministic client/key/redirect/scope configuration | Dynamic client registration or an ordinary account token; neither is supported |

For normal product integration, read [OIDC integration](references/oidc-integration.md). Read [first-party clients](references/first-party-clients.md) only when changing Login, Account, or another explicitly trusted first-party frontend.

## Work from contracts, not assumptions

1. Fix the expected issuer per environment. Never derive or accept an issuer from untrusted request or token data.
2. Fetch `/.well-known/openid-configuration`; require its `issuer` to exactly equal the configured issuer and use its advertised endpoints and capabilities.
3. Use [`../../openapi/identity.yaml`](../../openapi/identity.yaml) for HTTP payloads, status codes, media types, and error shapes. Inspect only the operations involved in the task.
4. If discovery, OpenAPI, and implementation disagree, do not silently choose the most convenient behavior. Treat discovery as deployed feature availability, preserve OpenAPI as the intended public contract, report the drift, and avoid promising the disputed capability.
5. Prefer a maintained OAuth/OIDC or JOSE library over hand-written protocol or cryptographic code. Configure it to enforce Identity's contract rather than accepting permissive defaults.

Architecture documents describe direction and rationale; they are not evidence that every proposed grant, claim, or endpoint is live. In particular, verify capability support instead of inferring it from [`../../docs/adr/0003-account-platform-redesign.md`](../../docs/adr/0003-account-platform-redesign.md).

## Integration workflow

1. **Classify the caller.** Decide web BFF, native client, resource service, first-party frontend, or deployment control plane before writing code.
2. **Declare the trust boundary.** Record the fixed issuer, client type, exact redirect and post-logout URIs, required scopes, token holder, local session boundary, and application user key.
3. **Obtain registration.** Client provisioning is deployment-owned. Do not invent a client ID, wildcard redirect, secret, scope, or registration endpoint.
4. **Implement the smallest protocol surface.** Delegate human authentication to Identity. Business services own their roles and domain data; they do not collect Identity passwords or reproduce Login ceremonies.
5. **Handle the complete lifecycle.** Cover login transaction expiry, callback validation, token refresh rotation, local-session expiry, logout/revocation, JWKS rotation, and observable protocol errors.
6. **Test behavior, not just redirects.** Exercise success, state/nonce mismatch, expired or reused code, refresh concurrency, unknown signing key, wrong issuer/audience/scope, denied login, and local plus Identity logout.

## Non-negotiable invariants

- Use Authorization Code with S256 PKCE for every human client. Generate fresh high-entropy `state`, OIDC `nonce`, and PKCE material for each attempt.
- Use exact pre-registered redirect URIs. The only variable-port exception is a registered native loopback URI on `127.0.0.1` or `[::1]`.
- Keep BFF client keys and all OAuth tokens off the browser. A static SPA is not confidential because it contains a string named `client_secret`.
- Key the application's identity mapping by `(issuer, sub)`. Username, email, phone, and undocumented internal claims are mutable or outside the caller contract.
- The current issuer sets access-token `aud` to the OAuth `client_id`; a separately addressed or shared resource audience is not implemented. Report that contract gap rather than weakening audience validation.
- Validate token signature and key metadata plus exact issuer, audience, time bounds, nonce where applicable, token kind, and required scopes. Pin allowed algorithms; never trust `alg`, key URLs, or token type merely because they came from the token.
- Serialize refreshes per local session and atomically replace the rotating refresh token. Reusing a predecessor can revoke the entire token family.
- Treat application logout, Identity SSO logout, refresh revocation, account session revocation, and connected-app grant revocation as distinct operations.
- Preserve `application/problem+json` machine fields and `x-moesegfault-correlation-id`. OAuth endpoints intentionally use OAuth error JSON instead; do not force both into one parser.
- Keep production, staging, and local issuers, client registrations, keys, redirects, and frontend origins paired. Never let a fallback cross environments.

## Expected output from an integration task

Produce code and configuration that make the trust boundary reviewable:

- identify the caller model and issuer;
- list required registration metadata without embedding private material;
- state where login transactions, application sessions, and tokens live;
- name every accepted token claim and its validation rule;
- document refresh and logout behavior;
- add focused tests for the lifecycle and failure modes actually used.

Do not copy the full Identity endpoint catalog into application documentation. Link the discovery document and OpenAPI operation IDs, and document only the selected capability and local policy.
