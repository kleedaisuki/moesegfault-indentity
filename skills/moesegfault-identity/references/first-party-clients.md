# First-party Login and Account clients

Read this reference only when modifying `apps/login`, `apps/account`, or an explicitly trusted replacement deployed on the paired first-party origins. External products should use OIDC instead.

## Authority boundary

Identity owns principals, identifiers, contacts, authenticators, identity sessions, grants, OAuth protocol state, and signing. Login owns registration/authentication/recovery presentation. Account owns self-service account presentation. Product services own business roles and domain data.

The repository clients are implementation examples, not a package:

- [`../../../apps/login/src/api/client.ts`](../../../apps/login/src/api/client.ts) covers browser context, password/passkey ceremonies, recovery, session/authenticator/binding management, and OAuth resume.
- [`../../../apps/account/src/api/client.ts`](../../../apps/account/src/api/client.ts) covers profile, avatar, contact verification, preferences, credentials, sessions, and connected applications.

Extend or refactor the relevant client instead of creating a third subtly different request wrapper.

## Browser request model

There are two cookie-bound states:

1. an anonymous browser context used to start authentication, registration, and recovery; and
2. an authenticated Identity session used by account and security operations.

The normal client lifecycle is:

1. Resolve the Identity origin from the controlled Login/Account hostname. Keep preview overrides explicit; never fall through from staging to production.
2. Fetch `GET /v1/browser-context` before an anonymous ceremony. The response establishes the browser cookie and returns a CSRF token.
3. Keep CSRF tokens in page memory. Use `credentials: include`, `cache: no-store`, and the exact media type from OpenAPI.
4. Send `x-moesegfault-csrf` and `Idempotency-Key` on mutations. Use a new key for a new logical operation; reuse the same key only when retrying that same operation after an uncertain response.
5. Treat transaction IDs, ceremony options, CSRF values, and resume URIs as short-lived server results. Do not synthesize or decode them.
6. After authentication, use the returned session-bound CSRF token. For direct Account entry, `GET /v1/me` bootstraps both account state and mutation context.
7. On `401`, transition the entire local state to anonymous and route through the paired Login origin. Do not leave stale privileged UI state visible.

Only `LOGIN_ORIGIN` may start anonymous ceremonies. Authenticated session-management commands may allow the paired Login and Account origins. Do not broaden WebAuthn RP ID or CORS to a parent domain to make a new product work; that product should be an OIDC client.

## Capability-level API map

Use OpenAPI operation IDs and schemas rather than copying endpoint details into another client.

| Capability | Typical entry | Important invariant |
| --- | --- | --- |
| Registration/sign-in/recovery | Browser context, then a password operation or start/complete Passkey transaction | Start and completion are separate, expiring, idempotent operations; OAuth continuation uses only the server-provided resume URI |
| Profile and preferences | Account bootstrap, merge-patch profile/preferences | Presentation data never becomes an authentication identifier implicitly |
| Contacts | List/add/update, start verification, complete with delivered code | Adding a contact does not verify it or automatically grant login/recovery authority; use canonical `contact_id` in verification paths, normalizing legacy `identifier_id` responses at the API boundary during staggered rollout |
| Avatar | Multipart upload or delete | Keep upload on its media boundary; do not JSON/base64-wrap files |
| Credentials/recovery | Password set/delete, Passkey add/rename/revoke, recovery-code status/rotation | Preserve at least one usable authentication/recovery path; recovery codes are displayed once |
| Sessions and connected apps | List/revoke sessions or grants | Revoking a session, grant, refresh family, or current browser cookie has different scope |
| External identity bindings | List providers/bindings, start server-directed redirect, remove binding | Navigate only to the URL returned by Identity; the callback belongs to Identity |

Before adding a feature, inspect the relevant operations in [`../../../openapi/identity.yaml`](../../../openapi/identity.yaml), then the domain invariants and handler tests. Do not infer a mutation body from a TypeScript view model.

For the registration/account verification sequence, its ID compatibility rule, and `Contact was not found` triage, read [contact verification](contact-verification.md).

## WebAuthn ceremonies

- Pass Identity's JSON creation/request options through the existing JSON-to-WebAuthn conversion helpers.
- Let the platform authenticator choose and return the credential. Preserve user cancellation separately from server failure.
- Send the serialized credential only to the matching completion transaction.
- Conditional mediation supplements the explicit Passkey action; it never removes the password path.
- Account-origin access does not change `WEBAUTHN_RP_ID` or the expected Login origin.

## OAuth resume inside Login

When Identity sends Login an opaque authorization transaction:

1. keep it in memory and scrub it from visible/history URLs as the current router does;
2. authenticate through the normal Identity ceremony;
3. use only the response's fixed-Identity resume URI;
4. navigate the top-level browser to that URI.

The Login JavaScript must never receive or forward the authorization code itself. Identity validates and consumes the resume transaction before redirecting to the relying party's exact registered URI.
Password and Passkey completions must use the **same absolute issuer-rooted URI contract**. A root-relative `/v1/oauth/.../resume` value is not equivalent: resolving it against `login[-staging].moesegfault.dev` sends the browser to a Login page instead of the Identity Worker and leaves the transaction authenticated but unfinished. Preserve the issuer boundary when changing either ceremony or the Login navigation code; exercise the real OAuth password route in staging after deployment.

## Errors and retries

- Parse RFC 9457 problem details only when the response is JSON; proxies may return HTML or an empty body.
- Branch on stable machine fields such as problem `error_code`, not localized `title` or `detail`.
- Preserve `x-moesegfault-correlation-id` on typed errors and show it in support-ready failure UI where appropriate.
- Keep user cancellation, policy rejection, invalid input, authentication failure, rate limiting, and platform failure distinguishable.
- Do not blindly retry mutations. Retry only when the operation is designed for it, using the original idempotency key and transaction context.

### Distinguish authentication rejection from OAuth continuation failure

The Login heading `Sign-in wasn't completed` is shared presentation, not a protocol diagnosis. Classify the failed operation using only its environment, endpoint path without handles/query, HTTP status, stable problem fields, and correlation ID; never collect passwords, request bodies, cookies, full authorization URLs, codes, or tokens.

- `POST /v1/password/authentications` with `401 authentication_failed` is a rejection before a successful authentication response. Username login and verified email/mobile login are supported; an unknown/unverified identifier, inactive principal, password mismatch, or concurrent credential replacement can share this intentionally generic result. Establish the intended issuer and identifier kind without probing account existence or weakening verification policy. A production and staging account are not interchangeable.
- An invalid or expired OAuth transaction at password authentication returns `400 invalid_request` with `Invalid authorization transaction`, not the generic password `401`.
- A successful password response followed by a resume navigation on the Login origin is a continuation defect. The correction belongs in the issuer-rooted response contract, not in credential validation, client registration, CORS broadening, or relying-party password collection.

Verify the deployed revision as well as source/CI: a staging fix does not imply production is serving it. Retrying a `401` blindly can trigger the password-attempt policy and cannot establish that a separate resume fix resolved the original rejection.

## Focused verification

For a changed capability, cover the success path plus the boundary it relies on:

- correct paired origin and rejected untrusted origin;
- credentials/cookies included only where intended;
- CSRF token rotation and loss;
- duplicate mutation with the same idempotency key;
- transaction expiry or consumption;
- `401` local-state reset;
- response parsing with problem JSON and non-JSON proxy failure;
- OAuth resume as top-level navigation, not `fetch`.

Use the repository's existing Vitest suites and run only the affected workspace first. OpenAPI changes also require `npm run lint:openapi`; cross-surface contract changes require the broader repository checks documented in [`../../../README.md`](../../../README.md).
