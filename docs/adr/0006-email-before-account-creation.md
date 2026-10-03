# ADR-0006: Verify the Mailbox Before Creating an Account

- Status: Accepted
- Date: 2026-10-03
- Supersedes: ADR-0005 section 1's account-first registration sequence
- Scope: password and initial Passkey registration; existing accounts are unchanged

## Decision

The owner explicitly requires mailbox verification **before** account creation, not a
pending account and not a client-only verification screen. Login now starts with an email
challenge; profile, avatar, password, and Passkey controls appear only after verification.

```text
email -> browser-bound challenge + encrypted mail job -> correct code
      -> short-lived email proof -> profile + credential -> atomic account creation
```

The challenge creates no principal, identifier, username reservation, password credential,
or Identity session. It is independent of account-contact challenges, whose existing foreign
keys and deletion semantics remain intact. Both queues share the established encrypted
delivery engine, leases, provider adapter, retry policy, and Cron drain.

## Authority and invariants

- Eight decimal digits, ten-minute challenge lifetime, at most ten claimed attempts.
  Attempt claims happen before comparison, including parallel guesses.
- Send budgets are enforced by a D1 trigger: one per minute and five per hour per
  normalized destination and anonymous browser. This is not a substitute for edge-level
  IP/bot controls; production should also monitor send volume and apply WAF controls.
- The server issues a ten-minute proof only after correct-code comparison. It uses
  domain-separated HMACs and constant-time comparisons and binds the normalized mailbox,
  anonymous browser cookie, and transaction. Only encrypted delivery work stores the
  mailbox and code; the transaction stores digests.
- Tokens and profile/password drafts remain in the current page realm, never URLs or
  browser persistence. A lost verification response can recover the same token with the
  same code and a fresh logical operation key, without extending expiry.
- Password registration checks the proof before expensive password hashing. Passkey
  registration checks at ceremony start and again at completion. Old in-flight ceremonies
  without a proof cannot create an account after this policy change.
- Proof consumption has a non-null primary-key claim in the **same D1 batch** as account,
  verified email, credential, session, recovery material, and audit creation. A duplicate,
  expired, cancelled, or failed claim rolls the whole batch back. Username/email conflicts
  must not consume the proof.
- Already-existing users are not required to re-register. Login, recovery, contact
  verification, password management, and session revocation retain their contracts.

## UI and avatar behavior

The email step has resend cooldown, correctable address, inline failure, and no credential
controls before successful proof. The second step displays the immutable verified mailbox
and its completion window. Expiry returns to email verification rather than attempting
account creation with an invalid proof.

The avatar is optional. Copy explains the input formats/10 MiB limit and center-square crop.
Selection previews the actual prepared output. Users can replace it or discard it with
"Skip avatar" before submitting; pending/replaced/discarded previews are disposed, including
late decoder completion. Submission locks both selection and discard. Native `hidden`
semantics are explicitly preserved despite grid/flex component styles.

## Migration and deployment

Migration `0008_registration_email_proof.sql` is additive. Existing Worker code continues
to operate against the expanded schema; apply it before deploying the new Worker. Signup
requests now require `email_verification_token`, an intentional policy tightening recorded
in OpenAPI. Deploy the matching Login asset bundle immediately after Identity. Old browser
tabs receive a structured `email_verification_required` error instead of creating an
unverified account.

Use branch `workflow_dispatch` with `delivery=staging-only`; do not merge into main or
promote to production for this preview. Staging mail acceptance and actual recipient delivery
are separate checks, and local tests do not establish either.

## Validation and sources

`scripts/tests/registration-email.mjs` executes the release Wasm Worker with real local D1.
It verifies no-account-before-proof, missing proofs for both methods, correct/wrong codes,
browser/email binding, parallel single-use registration, proof expiry, and guessing limits.
Frontend tests cover gate ordering, unchanged verified destination, wrong-code recovery,
cooldown, and avatar discard/locking. Existing contact and password suites remain regression
gates for the shared delivery engine.

The approach follows [OWASP's email verification guidance](https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html)
on bounded single-use proof before enabling use, while this project's stricter requirement
is no account row before proof. The mail adapter remains the native
[Cloudflare Workers Email API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
This is an engineering policy change, not a claim that email is a phishing-resistant
authentication factor or that provider acceptance guarantees inbox placement.
