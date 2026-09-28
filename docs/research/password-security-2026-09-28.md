# Password-change authority and session lifecycle (2026-09-28)

## Scope and current evidence

The deployed `PUT /v1/me/password` handler previously accepted a passwordless account's
new password from any valid Identity session. This contradicted the OpenAPI contract,
which requires a recent step-up session for passwordless users. The same handler
wrote `password_credentials` alone; existing sessions and OAuth refresh-token
families remained valid after a password change. ADR-0003 instead treats sensitive
authenticator changes as reauthentication events and recovery as revoking relevant
authority. The Account SPA immediately reloads `/v1/me` after a successful change,
so it can receive a newly bound CSRF token if the session cookie is rotated.

## Decision

For passwordless accounts, accept only a recent Passkey-authenticated session with
an active authenticator. This is the present platform step-up evidence. For an
existing password, require proof of the current password even if the session is
recent, preserving the published request contract. On success, atomically:

1. Compare-and-swap the credential using the observed password version/state.
2. Revoke every existing OAuth refresh-token family and Identity session for that
   principal, including the initiating session. Outstanding authorization codes
   are revoked and authenticated-but-unfinished authorization transactions and
   pending WebAuthn/binding transactions are closed as well.
3. Create one fresh browser session with a random new secret and attach the actual
   proof method (`password` for existing-password replacement, `passkey` for
   passwordless enrollment).
4. Record a security audit event and archive outbox item.

Only return the new cookie after D1 commits. Its CSRF value is derived from the
new session secret; Account already fetches `/v1/me` before its next mutation. This
preserves the current browser's workflow while removing the old session's authority.
The route uses `SecretResult` idempotency rather than persisting its bearer cookie.
If the first 204 response is lost, an exact-key retry with the old cookie receives
409 `idempotency_result_unavailable`; the old cookie cannot be used to recover
the new one, so the user signs in with the new password or existing Passkey.
Pre-existing self-contained JWT access tokens cannot be synchronously recalled by
session revocation; resource servers needing immediate revocation must introspect or
use short expiries, as ADR-0003 already specifies.

The database batch must fail closed if the password CAS or initiating-session
replacement inserts zero rows; a zero-row write alone is not a transaction error.
This matters under concurrent password changes and session revocation. No new
schema is necessary: the existing `password_version`, session source FK,
`session_authentication_methods`, and audit/outbox tables suffice.

## Verification

`cargo test -p identity-worker` passed 85 tests, `cargo clippy -p
identity-worker --all-targets -- -D warnings` passed, and the Worker Wasm build
completed. `node scripts/tests/password-security.mjs` runs a real local Worker
against an isolated, freshly migrated D1 under `.temp`. It verified a stale
Passkey session receives 403, a recent Passkey can add a password, incorrect
current-password proof receives 403, correct current-password proof rotates it,
old cookies receive 401, the replacement cookie works, the refresh family is
revoked, and lost-response same-key replay receives the documented 409. These
results establish local behavior, not deployed edge-runtime latency or immediate
invalidation of pre-existing self-contained JWT access tokens.

## External grounding

- [Cloudflare D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
  documents transactional, ordered batches; a failing statement rolls back the batch.
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
  recommends reauthentication after sensitive account events and session renewal.
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
  treats session IDs as authentication-equivalent secrets and recommends renewal
  after privilege changes.
- [Measuring Web Session Security at Scale](https://www.sciencedirect.com/science/article/pii/S0167404821002960)
  motivates explicit server-side invalidation as an empirical security property,
  not just deleting the browser cookie. The paper is observational, not proof that
  one revocation policy fits every product.

## Remaining risk

The account-management current-password proof does not yet share the anonymous
password-login rate gate. This is bounded by an authenticated, CSRF-protected
session, but an attacker with a stolen session can make repeated guesses. A future
rate policy should key by principal and account-action rather than reuse the
anonymous identifier/IP bucket without analysis.
