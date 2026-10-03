# Inline Registration Email Verification: Staging Delivery

## Product correction

The owner rejected the initial verification-first landing screen. Mailbox proof before
**account creation** must not imply mailbox proof before **showing the registration form**.
The corrected UI immediately displays profile, avatar, email, password and Passkey controls.
Sending and confirming the code happen inline; verification failures, address correction,
and proof expiry preserve draft controls and the avatar preview. Final submission creates
the account only after server-authorized mailbox proof. See ADR-0006 for the backend contract.

## Deployed candidate

- Branch: `codex/registration-email-first-20261003`.
- Code revision: `c2f41b877a01ba4fd5f775d139ce6a6840c5e09f`.
- [Staging-only delivery run 37132451150](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/37132451150)
  completed successfully; `gh run watch ... --exit-status` exited 0.
- The staging job deployed its checksummed bundle and finished smoke checks at
  `2026-10-03T15:17:22Z` (23:17:22 Asia/Singapore).
- Production promotion was skipped by the workflow condition. No main merge or production
  release was performed for this preview.

| Release unit | Staging Worker version |
| --- | --- |
| Identity | `6857bbda-a581-4ad6-87ec-a8834ccff6f8` |
| Login | `47df2c69-e639-47ed-a3c7-8a99b1ef5c6f` |
| Account | `696cd149-a36c-48b1-9ff7-70d602530262` |

The additive `0008_registration_email_proof.sql` migration was applied by the preceding
staging-only run 37131192110. The corrected candidate uses that same backend authority;
its follow-up changes are the registration presentation and interaction.

## Validation

- Login: 14 files, 65 tests; TypeScript and production build passed locally and in CI.
- Account: 55 tests, shared frontend: 51 tests; both passed in the candidate CI.
- CI also passed Rust quality/build, dependency and contract gates, populated migrations,
  real Worker mailbox proof, request boundary, contact verification, password security,
  session performance, deployment packaging, and staging smoke.
- The live browser snapshot of `/register` confirms the full form is present immediately,
  with a "Send verification code" button in the Email region and no verification-first page.
  A native full-page screenshot is saved locally at `.temp/signup-inline-staging.jpg`.
- Draft-preservation tests compare form/avatar node identity across failure and expiry,
  rather than merely checking that replacement controls display similar values.
- No live test email or account was created during this browser inspection. Actual inbox
  receipt and a user-completed deployed registration remain distinct from CI and visual checks.

## User-facing previews

- [Registration](https://login-staging.moesegfault.dev/register)
- [Account Center](https://account-staging.moesegfault.dev/)

Local execution logs and synthetic fixtures remain under repository `.temp`. The unrelated
pre-existing `pr19-production-rollout-2026-10-01.md` working-tree document was left untouched.
