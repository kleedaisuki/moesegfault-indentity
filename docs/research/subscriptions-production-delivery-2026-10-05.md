# Subscribe Identity integration: production delivery (2026-10-05)

## Authorization, baseline and bounded delta

The owner explicitly requested production launch after accepted staging user
closure. Root approved one coordinated existing main CI pipeline for Identity,
Login and Account, plus audited create-only Subscribe client registration.

Before rollout, Cloudflare's deployment API reported all three production units
at `407f6632a45a6011f896cd1de950c4665da907be`, serving 100%:

| Unit | Rollback version |
| --- | --- |
| Identity | `357bde85-5884-4688-bdfe-f1509c5e37a6` |
| Login | `a28e44f0-6bea-43f7-80ba-d582d3a9328a` |
| Account | `d81a3a10-1ef0-41b7-9226-6e0d7e09d737` |

Production D1 history had eight applied migrations through mailbox-proof 0008
(including production amail 0007), and zero clients matching `subscribe%`.
The candidate's merge base `df09d3b` and production main had identical file
contents; merging main retained its PR merge history without conflicts or code
replacement. The 32-file pre-registration delta contains only accepted Account
subscriptions/native sign-out, approved Login/password-signup OAuth continuation,
browser/mailbox deadline alignment, tests/contracts/docs and the already-applied
staging Subscribe client overlay. No new Identity redesign or unrelated defect
fix is included. Existing untracked research notes remain preserved.

## Public registration and forward-only data

The independent production RSA key's public manifest is
`../moesegfault-subscriptions/infra/subscribe-production-client.json`; private
material is generated/provisioned by the deployment workstream and never enters
this repository, SQL, logs or document. The existing audited generator produced
`migrations/environments/production/0011_oauth_client_subscribe.sql`:

- client `subscribe`, confidential, `private_key_jwt`;
- sector `subscribe.moesegfault.dev`, subject salt revision 1;
- exact callback `https://subscribe.moesegfault.dev/auth/callback`;
- exact logout callback `https://subscribe.moesegfault.dev/auth/logout/callback`;
- scopes `openid`, `profile` only;
- public RS256 key ID `subscribe-production-20261005`;
- create-only client, key, grant, redirect and audit/outbox INSERTs.

Root reviewed the manifest and exact generated SQL. Production migrations 0010
and 0011 then applied successfully: 0010 executed two migration commands in
5.22 ms; 0011 executed nine in 1.36 ms. Primary remote readback confirmed the
enabled client, exact callbacks, two scopes and key ID/algorithm. No existing
client, session, credential or signing key was overwritten. The old production
Worker is compatible with both expanded schema and newly registered client.

The ordinary authorization/session deadlines remain unchanged. Only validated
registration mailbox operations preserve same-browser binding and align a
still-live pending OAuth transaction with the mailbox deadline. Expired
transactions cannot be resurrected. Contextual proof consumption, new account,
session and OAuth binding are committed atomically. Existing independent signup
and legacy unbound proof contracts remain supported.

## Acceptance and release method

- Prior exact-source staging release `7b173e2` passed real release-Wasm/D1 signup
  and authority-loss rollback checks, 89 Rust unit tests, lint, both frontends,
  contracts and immutable packaging. User browser closure then exercised signup,
  Subscribe activation and Account subscription readback in the parent workstream.
- Account workstream reran 66 Account tests, three shared route tests, typecheck
  and a fresh production-origin-aware frontend build for accepted `fe7eec4`.
- Audited client generator's nine tests passed, including real isolated D1
  application and staging/production registration isolation.
- One existing main-push workflow builds/tests the final coordinated source,
  packages checksummed immutable artifacts, deploys staging, then promotes the
  exact bundle to production. Account is not deployed separately or twice.

## Completed production rollout and readback

The existing [main release run 37268599733](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/37268599733)
completed successfully for exact source
`c91f7a8eb780f6731777eafd4d4a2cdd83231c1c`. Every Rust/frontend/contract,
real-Worker security regression, immutable-package, staging and production job
passed. Cached hosted Rust took 2m1s, release package 1m7s, staging deployment
36s and production promotion 34s. No redundant local Rust build or second Account
deployment was performed.

Cloudflare deployment readback at 2026-10-05 13:41 Asia/Singapore confirmed all
three production units serving 100% from that exact revision:

| Unit | New production version |
| --- | --- |
| Identity | `ab243ca1-9a6b-4937-829a-900e642b1076` |
| Login | `f241f26d-d624-4612-932b-ba7eb502f84e` |
| Account | `e9348f12-5723-4778-bc0b-8ac037efc5e2` |

Post-release primary D1 readback returned ten total applied migrations. Existing
IDs 1–8 retained their original basenames; ID 9 is
`0010_registration_oauth_context.sql` and ID 10 is
`0011_oauth_client_subscribe.sql`. The query read ten rows, wrote zero and reported
0.3845 ms SQL time. A separate zero-write primary query confirmed `subscribe`
enabled, confidential/private_key_jwt, with its production sector. Earlier readback
also verified exact callback/logout URIs, two scopes, and production public key ID.

The parent workstream was notified immediately that Identity/Login/Account are
ready for actual production subscription acceptance. Product-domain TLS/readiness
and live authenticated iframe closure remain the subscriptions deployment/user
acceptance workstream, not something inferred from Identity smoke checks.

## Rollback and remaining live acceptance

### Discovery dependency triage during live acceptance

A production amail search briefly reported `Identity discovery must return JSON,
not a login page`. This wording is **not evidence of HTML or a redirect**: the
installed amail 0.1.2 source (`../moesegfault-amail/crates/amail/src/auth.rs`,
`discover`/`identity_json`) attaches that same context to network send, HTTP-status
and JSON-decoding failures. A repeated unchanged search subsequently succeeded.

An unauthenticated no-redirect HTTP probe of the exact public production discovery
URL returned 200, `application/json; charset=utf-8`, 1071 bytes, production issuer
and matching authorization/token/JWKS origins, with no Location or challenge
header. Staging separately returned its own correct JSON issuer. Deployment API
still reported production Identity 100% at c91f7a8; CLI public configuration had
the exact production issuer with no issuer override. Local proxy variables were
configured, but this did not identify a specific transport root cause. No issuer
fallback, realm switch, credential inspection or backend fix was performed.

When this generic message recurs, classify the safe underlying dependency error
and direct public endpoint status before proposing a provider route change.

Rollback uses the three recorded production version IDs through the existing
rollback workflow, restoring presentations before authority. Do not undo 0010 or
delete 0011: nullable schema expansion and unused client metadata are compatible
with previous Worker code, and database rollback would risk live data. An urgent
client suspension is a separate explicit operator action, not migration rollback.

Do not equate deployment smoke with a new production user subscribing. After
promotion, the parent workstream owns actual browser authentication/mailbox signup,
activation and Account display acceptance. Initial Passkey signup still lacks
OAuth continuation and is not represented as tested or newly implemented.
