# Staging signup lost its browser binding and OAuth continuation

## Scope and approval

The subscription staging browser workflow exposed two defects: final signup after
more than five minutes failed browser-CSRF validation despite a ten-minute mailbox
proof; successful password signup omitted the pending Subscribe OAuth transaction
and stopped at Login's success panel. The owner explicitly approved the necessary
Identity bug fix. This candidate is staging-only, on `codex/subscription-section`;
no main push or production promotion is authorized.

## Mechanism and compatibility

The generic anonymous browser cookie lasts 300 seconds. Registration mailbox
challenges and verified proofs each last 600 seconds, and the original code never
renewed that cookie. OAuth authorization transactions also start with 300 seconds.
Renewing only the cookie would therefore leave a second five-minute failure.

The fix renews the **same** Secure, HttpOnly, host-only, SameSite=Strict cookie only
after validated registration-email operations, to the challenge/proof's remaining
lifetime (at most 600 seconds). Generic browser-context lifetime and existing
session/authentication security are unchanged. Lost completion responses recover
the original proof and remaining expiry, not another ten minutes.

Registration-email start/completion accept an optional provider-issued OAuth ID.
Only still-live `awaiting_authentication` transactions can be aligned with the
mailbox deadline: expired, authenticated, completed and unknown IDs cannot renew.
Migration 0010 stores the optional ID on the browser-bound challenge; completion
cannot substitute another ID or browser. Password signup checks contextual proofs
against that ID and atomically binds the new principal/session with account,
credential, mailbox-proof consumption and audit creation. A competing/expired
OAuth update triggers an assertion collision and rolls the whole D1 batch back.
Exact registered redirects, PKCE, state and nonce are never changed.

Optional fields preserve independent registration and already-issued unbound
proofs. Login keeps the OAuth context in the page realm, not URLs or storage;
password signup sends it and navigates the server's absolute issuer-rooted resume
URI through the existing completion helper. Expired contextual requests retain
drafts and offer useful Chinese/Japanese/English recovery text, without suggesting
that resending mail revives authorization. Initial Passkey signup's existing
contract does not support OAuth continuation; this focused fix does not pretend
otherwise or send it unsupported fields.

## Acceptance evidence before staging delivery

- Local cached build uses `CARGO_BUILD_JOBS=2`; no clean rebuild or parallel heavy
  compilation. `cargo test -p identity-worker --lib --locked`: 89 passed.
- `cargo clippy -p identity-worker --all-targets --locked -- -D warnings`: passed.
- Actual release Wasm Worker + isolated Miniflare D1 harness
  `node scripts/tests/registration-email.mjs`: passed. All fixtures and state stay
  inside root `.temp/registration-email`; no production mail adapter is present.
- The harness checks retained cookie value/lifetime, existing mailbox/browser
  binding and single-use proofs, pending OAuth renewal, expired/unknown/nonpending
  rejection, mismatched browser/context rejection, issuer-rooted resume, exact new
  principal/session association and transaction rollback after authority loss
  injected *inside* the account-creation batch.
- Focused Login tests cover request forwarding for both mailbox operations and
  password signup, ordinary no-context signup, realm-preserving signup navigation,
  server resume navigation and terminal expiry recovery. Typecheck/OpenAPI lint pass.

These are reproducible local contract tests, not a claim of completed live user
acceptance. Root subscription workstream owns the real browser + amail subscription
and Account readback after the candidate staging Actions deployment.

## Staging delivery

- GitHub [staging-only run 37219121313](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/37219121313)
  succeeded for `7b173e2b5df132644b6d5866f4ff58ee9fc8c6f9`. Rust, both frontend
  workspaces, contracts/migrations, release Worker regression tests, immutable
  packaging and staging smoke checks passed; production promotion was skipped.
- The three staging units deployed in 44 seconds. The Identity deployment API
  reports version `ddc6b4be-6d5c-4d9a-90ba-a6ff44a6b7d0` serving 100%, annotated
  with that exact GitHub revision, at 2026-10-05 01:08 Asia/Singapore.
- Non-secret remote D1 history readback confirms both unchanged
  `0009_oauth_client_subscribe-staging.sql` and new
  `0010_registration_oauth_context.sql`. Migration numbering was corrected before
  any candidate deployment; no previously-applied migration was renamed or reset.
- Actions read back enabled `subscribe-staging`, its exact callback
  `https://subscribe-staging.moesegfault.dev/auth/callback`, and scopes.
- Live browser acceptance remains the parent workstream's next operation: begin
  a fresh Subscribe OAuth transaction, rather than reusing an expired pre-fix tab.

## References

The fixed binding follows [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html):
Origin/Fetch Metadata are additional defenses, not substitutes for browser-bound
CSRF credentials. [OAuth security BCP, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)
requires transaction-specific state/nonce or PKCE binding and strict redirect
handling. The project-specific mailbox ordering remains ADR-0006.
