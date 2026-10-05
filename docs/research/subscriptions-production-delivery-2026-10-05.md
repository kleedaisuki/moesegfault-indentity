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

## Rollback and remaining live acceptance

Rollback uses the three recorded production version IDs through the existing
rollback workflow, restoring presentations before authority. Do not undo 0010 or
delete 0011: nullable schema expansion and unused client metadata are compatible
with previous Worker code, and database rollback would risk live data. An urgent
client suspension is a separate explicit operator action, not migration rollback.

Do not equate deployment smoke with a new production user subscribing. After
promotion, the parent workstream owns actual browser authentication/mailbox signup,
activation and Account display acceptance. Initial Passkey signup still lacks
OAuth continuation and is not represented as tested or newly implemented.
