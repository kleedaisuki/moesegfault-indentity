# OIDC integration

Read this reference for an external web application, native application, resource service, or new relying-party registration.

## Current capability boundary

The checked-in implementation currently advertises:

- Authorization Code with S256 PKCE;
- rotating refresh tokens when `offline_access` is granted;
- confidential clients authenticated with `private_key_jwt`;
- pre-registered native clients using token endpoint authentication method `none`;
- RS256 ID and access tokens plus a public JWKS;
- UserInfo and RP-initiated logout.

It does **not** currently route a client-credentials grant, token introspection, or dynamic client registration. Discovery currently exposes `openid`, `profile`, and `offline_access`; do not promise `email` or `phone` claims merely because future-facing schemas or design documents mention them.

The current signer also fixes an access token's `aud` to its OAuth `client_id`. A separate API audience or one shared by several clients is not an implemented integration surface, even though the data model contains audience-related fields. If the consuming architecture needs that shape, report a provider-contract gap; never compensate by accepting the wrong audience.

Re-check live discovery before relying on this snapshot. When changing Identity itself, compare discovery, [`../../../openapi/identity.yaml`](../../../openapi/identity.yaml), the route table in [`../../../crates/identity-worker/src/lib.rs`](../../../crates/identity-worker/src/lib.rs), and OAuth handlers in [`../../../crates/identity-worker/src/oauth.rs`](../../../crates/identity-worker/src/oauth.rs).

## Registration contract

Request a reviewed registration from the Identity deployment owner. Supply:

| Field | Rule |
| --- | --- |
| Client type | `confidential` for a BFF; `native` for an installed public client |
| Token endpoint authentication | `private_key_jwt` for confidential; `none` for native |
| Redirect URIs | Exact, environment-specific URIs with no fragments or wildcards |
| Post-logout redirect URIs | Exact allowlist, separate from login redirects |
| Scopes | Only those the application actually consumes; always include `openid` |
| Sector | A deliberate pairwise-subject sector; coordinate related clients rather than joining accounts later by email |
| Client key | Public JWK and `kid` for confidential clients; the private key never leaves the client backend |

Registration is deployment-owned D1/configuration data. There is no supported self-service registration endpoint or checked-in registration CLI. Do not fabricate one-off SQL as an application integration step; route provisioning through the reviewed deployment workflow described in [`../../../docs/configuration.md`](../../../docs/configuration.md).

## Web/BFF login

Use a maintained OIDC client when the framework has one. Configure the library rather than rebuilding these steps manually:

1. Create a short-lived, single-use server-side login transaction containing random `state`, random `nonce`, a PKCE verifier, intended return destination, issuer, and expiry.
2. Derive `code_challenge = BASE64URL_NOPAD(SHA256(ASCII(code_verifier)))`.
3. Redirect the top-level browser to the discovered authorization endpoint with `response_type=code`, exact `client_id` and `redirect_uri`, scopes beginning with `openid`, `state`, `nonce`, the challenge, and `code_challenge_method=S256`.
4. Identity may navigate through Login and an internal resume endpoint. Treat that as opaque; a relying party neither calls Login as an API nor reproduces its transaction protocol.
5. At the callback, reject an error or code unless returned `state` and authorization-response `iss` match the stored transaction and fixed issuer. Consume the transaction once.
6. Exchange the code once at the discovered token endpoint using the exact redirect URI and original verifier. A confidential client also sends a fresh client assertion.
7. Validate the ID token before creating the application's own session: signature, pinned algorithm, exact `iss`, `aud` containing the client ID, expiry, token kind, and the stored nonce.
8. Store tokens only in the BFF's server-side session store. Give the browser a host-only, `Secure`, `HttpOnly` application-session cookie with an appropriate `SameSite` policy and CSRF protection.

An application return path is local state, not an OAuth redirect URI. Validate it against local relative paths or an exact allowlist before redirecting after login.

## Native login

Use the same authorization-code and PKCE validation, but open the system browser. A bundled secret does not make a native application confidential.

- Prefer claimed HTTPS redirects when the platform can bind them to the app.
- Desktop loopback redirects may use an ephemeral port only when the registered match mode permits it, and only on `127.0.0.1` or `[::1]`; do not substitute `localhost`.
- Bind the listener only for the login attempt, validate state before accepting the code, and close it promptly.
- Store refresh tokens only in platform-protected application storage.

## `private_key_jwt`

For each token or revocation request, create a new short-lived assertion signed by the registered client key:

```json
{
  "iss": "client_id",
  "sub": "client_id",
  "aud": "the exact discovered token endpoint",
  "iat": 0,
  "exp": 0,
  "jti": "fresh unguessable value"
}
```

Send it as `client_assertion` with:

```text
client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
```

Use only an algorithm registered for that client. Keep assertion lifetime at or below five minutes and never reuse `jti`. The current server authenticates revocation requests against the token-endpoint audience too; use the exact behavior verified from the handler until this becomes explicit in the public contract.

## Access-token validation

Use a maintained JOSE library and an issuer-pinned verifier. The acceptance policy must:

1. obtain `jwks_uri` from discovery under the configured issuer;
2. allow only RS256 for current Identity-issued tokens and select a compatible signing JWK by `kid`, `kty`, and `use`/`key_ops`;
3. verify the signature, exact issuer, the current registered `client_id` audience, `exp`, and reasonable time skew;
4. require an access-token kind and every scope needed by the operation;
5. use `(iss, sub)` as the downstream identity key.

Cache JWKS with a bounded lifetime. On an unknown `kid`, coalesce and rate-limit a single refresh, then reject if the key remains unknown. Retain old cached keys while tokens signed with them can remain valid; never use a key URL supplied by token claims.

The checked-in signer currently emits `typ=JWT` rather than the ADR's proposed `typ=at+jwt`, and includes `token_use=access`. Do not enforce `at+jwt` against the current deployment. Require the documented/current access-token discriminator and treat any token-type migration as a coordinated issuer/consumer contract change. Never accept an ID token as API authorization.

Call UserInfo only when the application actually needs standard claims and only with an access token containing `openid`. Do not make authorization decisions from display name or username.

## Refresh, revocation, and logout

Request `offline_access` only when the product needs a durable session. On refresh:

- serialize refresh operations per local session;
- persist the returned token set atomically before releasing waiting requests;
- never retry with the predecessor after a successful rotation;
- if the outcome is unknown, reconcile by ending the local session rather than racing stale and new tokens.

Old-token reuse revokes the refresh family. Access tokens are short-lived self-contained JWTs and there is currently no introspection endpoint; revocation does not guarantee immediate invalidation of one already issued.

Logout has two layers:

1. expire the application's session and discard or revoke its server-side token family;
2. navigate the browser to the discovered `end_session_endpoint`, using the original ID token as `id_token_hint` and an exact registered `post_logout_redirect_uri` when a return is needed.

Generate and validate logout `state`. Do not claim cross-application global logout: front-channel and back-channel logout are separate protocols that this integration does not currently expose.

## Error and observability contract

- Authorization errors return through the exact redirect only after the redirect URI has been validated.
- Token and revocation endpoints use OAuth error JSON.
- Identity resource endpoints use RFC 9457 `application/problem+json`.
- Capture `x-moesegfault-correlation-id`, HTTP status, OAuth `error`, or stable problem `error_code`; never log codes, assertions, tokens, cookies, passwords, verification codes, or raw personal identifiers.

## Verification matrix

At minimum, test:

- successful login and callback replay rejection;
- state, nonce, issuer, audience, signature, token-kind, and scope mismatch;
- expired authorization code and exact redirect mismatch;
- unknown `kid` refresh and failure after one bounded refresh;
- two concurrent refresh attempts without token-family self-revocation;
- local logout independent of Identity logout, plus the combined path;
- environment isolation so staging cannot accept production issuer, keys, or redirects.

## Standards

- [OAuth 2.0 Security Best Current Practice (RFC 9700)](https://www.rfc-editor.org/rfc/rfc9700.html)
- [OAuth 2.0 for Browser-Based Applications (RFC 10017)](https://www.rfc-editor.org/rfc/rfc10017.html)
- [OAuth 2.0 for Native Apps (RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252.html)
- [JWT Best Current Practices (RFC 8725)](https://www.rfc-editor.org/rfc/rfc8725.html)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0-errata2.html)
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0-errata2.html)
- [OpenID Connect RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
