# Independent validation: contact verification and integration readiness

**Date:** 2026-09-28
**Environment:** Windows PowerShell, Node.js 26.8.2, npm 11.19.1, Rust 1.88.0, Wrangler 4.131.1.
**Scope:** Local Worker + D1 contact verification, repository quality gates, and OAuth client provisioning. No production or staging mutation was performed.

## Contract and reported failure

The reported browser error was `Contact was not found` on starting email verification. The established frontend contract uses `Contact.contact_id` in the verification URL. The old contact response projected only `identifier_id`, so a frontend consuming the declared shape could send `/v1/me/contacts/undefined/verification-transactions`. The Worker validates a canonical UUIDv7 path parameter and returns 404 before reading the contact. This is a response-shape defect rather than an email-provider failure. The corrected response carries canonical `contact_id` and retains `identifier_id` as an equal-valued compatibility alias.

## Reproducible contact workflow

Artifact: [`scripts/tests/contact-verification.mjs`](../../scripts/tests/contact-verification.mjs). Run `npm run build:identity && node scripts/tests/contact-verification.mjs` from the repository root. It creates an isolated D1 state directory under `.temp`, applies migrations, seeds only a local authenticated principal/session, and launches the built Worker through local Wrangler. The contact and verification operations themselves use real HTTP routes, CORS origin, CSRF, and idempotency headers. It never calls a remote Worker or sends mail externally. Wrangler's local EMAIL binding may emit message content, so this harness drains but neither buffers nor prints Worker logs.

Observed after the contact response fix: contact creation 201, listing 200, verification start 201, same-key replay 201 returning the same transaction ID, and a fresh-key immediate resend 429. The response `contact_id` was canonical UUIDv7; `identifier_id` matched it; D1 contained exactly one pending verification transaction and one outbox row. The fixture's recipient is `validator@example.invalid`, and the D1 location is isolated per run.

The harness was subsequently extended to exercise **completion through the real local Worker HTTP route**. It chooses a synthetic eight-digit code, computes the Worker's exact domain-separated HMAC input (`moesegfault.contact-verification.code.v1\0` followed by eight-byte big-endian field lengths and the transaction ID, normalized destination, and code), and replaces only that test-local transaction's `code_digest` in D1. It never reads or logs simulated email content. Completion returned 200 with equal canonical `contact_id` and compatibility `identifier_id`, `verification_state='verified'`, and a non-null verification time. Same-idempotency-key replay returned 200 without another consumption; a fresh-key attempt to reuse the consumed code returned 410 `transaction_expired`. D1 contained exactly one consumption claim. The focused rerun `npm run test:contact-verification` exited 0 with status sequence **201/200/201/201/429/200/200/410**. This proves local completion authority, **not** actual Cloudflare Email Service acceptance or recipient delivery; staging with a controlled mailbox is still required for that release gate.

An initial harness run received `400 Invalid Idempotency-Key` because the test key was shorter than the established 16-character minimum. That was a test-fixture error and was corrected without weakening the contract. It did not indicate a product defect.

## Quality gate snapshot

At the time of this snapshot, the following commands exited 0:

| Area | Commands | Result |
| --- | --- | --- |
| Rust | `cargo fmt --all -- --check`; `cargo test --workspace --all-features --locked`; `cargo deny --locked check` | Pass |
| Frontends | `npm run lint:login`; `npm run lint:account`; `npm run typecheck:login`; `npm run typecheck:account`; `npm run typecheck:frontend-shared`; `npm run test:login`; `npm run test:account`; `npm run test:frontend-shared`; `npm run build:login`; `npm run build:account` | Pass; Login 54, Account 47, shared 51 tests |
| Contracts/migrations | `npm run lint:openapi`; `npm run test:migrations` | Pass |
| Local request boundary | `node scripts/tests/security-boundary.mjs` | Pass, with expected 400/403 outcomes and D1 preclaim counts |

`cargo clippy --workspace --all-targets --all-features --locked -- -D warnings` initially exited 101 with six dead-code diagnostics in `oauth.rs`/`oauth_repository.rs` while a separate agent was editing those files. An immediate subsequent run exited 0 after those edits became visible. This was a concurrent working-tree snapshot, not a reproducible final-state failure. It is not appropriate to claim that the first failure was a test flake.

## OAuth provisioning and final migration-chain validation

An independent probe, `.temp/validate-oauth.mjs`, generated a native client (`none`, variable-port loopback redirect, no key) and a confidential client (`private_key_jwt`, exact HTTPS redirect, generated P-256 public JWK) with `renderClientMigration`. It applied the repository's migration chain to a fresh isolated local D1, then applied both generated SQL files with Wrangler. The observed `oauth_clients` types/authentication methods, redirect modes, key cardinality (confidential 1, native 0), scope cardinality (3 and 2), and `pragma_foreign_key_check` all matched the independent manifest expectations. Command `node .temp/validate-oauth.mjs` exited 0. This was rerun **only because migration `0006` was added after the first run**. The final isolated state contained both `oauth_client_session_ids` from `0005` and `password_auth_attempts` from `0006`; `wrangler d1 migrations list ... --local --persist-to=<that state>` reported no remaining migrations.

Generator negative checks independently rejected a non-loopback HTTP redirect, unsupported `email` scope, and a native client carrying a key. The committed generator tests were initially five of five; after its author expanded the suite, the **final** `npm run test:oauth-client-migration` was eight of eight. It covers create-only rows, private-key rejection, unsupported scopes, native loopback restrictions, SQL quote escaping, duplicate redirects, RSA public-key acceptance, pairwise-sector restrictions, staging/production separation, migration slot discovery, and actual isolated local D1 application. These tests do not prove an OAuth authorization-code browser round trip or confidential JWT client authentication; those remain staging integration checks.

## Final security-change gate

After the security implementation streams settled, the following commands were executed in this order; every command exited 0:

1. `cargo fmt --all -- --check`
2. `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`
3. `cargo test --workspace --all-features --locked`
4. `npm run build:identity` (release Wasm artifact built)
5. `npm run test:password-security` (local Worker: stale challenge 403; add/change password 204; old sessions and refresh family revoked; secret replay refused)
6. `npm run test:contact-verification` (local Worker+D1: create/list/start/replay/cooldown 201/200/201/201/429, one transaction and one outbox row)
7. `npm run test:recovery-authority` (old password and federated binding revoked while new key and FK history remain)
8. `npm run test:password-rate-limit` (bounded SQL policy, expiry, bucket isolation, and stale-credential authority)
9. `npm run test:migrations` (populated migration regression)
10. `npm run test:oauth-client-migration` (eight of eight, including local D1 application)
11. `npm run lint:openapi` (valid contract)

After this gate, the focused contact harness was expanded from issuance through completion and rerun separately, as described above. Unrelated suites were not repeated.

The password/recovery scripts exercise important authority and SQL invariants, but only `test:password-security` and `test:contact-verification` start a local Worker. Thus their results should not be misrepresented as full browser or deployed integration coverage. Frontend suites already passed earlier; they were not repeated for untouched areas. The Account owner separately reported focused password-step-up page tests (10/10) and typecheck after its latest UX change; those are **owner-reported**, not independently rerun here.

The root agent's non-mutating live reachability probe found production and staging `/healthz` both returning 200 with healthy D1, and production OIDC discovery returning 200. No authenticated contact request or controlled mailbox was available. This evidence establishes only live endpoint reachability, **not** that the new contact fix is deployed, that email delivery works, or that the new app can yet complete a production OAuth round trip.

## Final packaging dry-runs

After the final local gate, the root agent ran `npm run package:identity`, `npm run dry-run:login`, and `npm run dry-run:account` against the built production-config artifacts. Because the Account password-step-up UX changed after its earlier build, the root agent then ran `npm run build:account && npm run dry-run:account` again. Every command exited 0 with Wrangler 4.131.1. Identity's dry-run reported the expected production D1, R2, Email Sending, issuer, and paired Login/Account origin bindings; Login and Account each found their static asset directory. These commands did not upload, migrate remote D1, set secrets, or validate a real mailbox, and therefore are packaging evidence rather than a production release.
