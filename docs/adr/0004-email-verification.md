# ADR-0004: Bounded Email Verification with a Durable Cloudflare Outbox

- Status: Accepted
- Date: 2026-09-16
- Owner: Identity service
- Scope: the email-verification implementation introduced by migration `0004`

## Context

The repository already has contacts, an Account UI for entering a verification code, and a verification-completion handler. The missing start handler deliberately returned `503 delivery_unavailable`; no transaction or email was created. Two adjacent defects also matter to this feature:

1. Password authentication accepted unverified email/mobile identifiers because the lookup did not test verification state.
2. `UNIQUE(kind, normalized_value)` let an unverified contact reserve an address globally, so an attacker could squat somebody else's email before proving control.

Registration currently creates an unverified email and a usable Identity session. This ADR does not change registration: account creation stays independent of email delivery, and the user starts verification from the Account UI.

ADR-0003 describes a broader target for contact replacement, recovery, primary contacts, and notification pipelines. This decision intentionally implements a smaller coherent slice.

## Implementation scope

### Accepted now

| Area | Decision |
| --- | --- |
| Channel | Email only, sent from `identity@moesegfault.dev` by Cloudflare Email Service |
| Challenge | Random eight-digit decimal code, valid for 600 seconds |
| Resend policy | 60-second cooldown; at most 5 starts per normalized destination in a rolling hour |
| Attempts | Lock after 10 incorrect codes |
| Persistence | D1 transaction, single-use consumption claim, and encrypted delivery outbox |
| Email uniqueness | Duplicate unverified contacts may exist across principals; verified email/mobile values are globally unique |
| Login authority | Username remains usable; email/mobile password login requires `verification_state='verified'` |
| Contact edits | Existing mutable-contact behavior remains; a destination digest invalidates an in-flight code after an edit |
| Session | Starting/completing verification requires the existing authenticated session and CSRF contract; success does not rotate or upgrade the session |

### Explicitly deferred

- automatic verification email during registration;
- requiring a primary email to be verified, changing current `is_primary` behavior, or automatically promoting a verified contact;
- immutable contacts or a create-verify-promote email-replacement workflow;
- old-primary-address change notifications;
- recovery-policy changes and OIDC email-claim changes;
- notification types other than verification codes;
- multi-revision outbox-key rotation machinery beyond the fixed V1 schema;
- Cloudflare Queue adoption; D1 plus the existing scheduled Worker is sufficient for this bounded volume.

These are future product/architecture choices, not partially implemented promises.

## Decision

Use a single normal flow:

```text
Account UI
  | POST start: session + CSRF + Idempotency-Key
  v
D1 batch
  |-- terminalize stale prior transaction
  |-- insert one pending transaction
  `-- insert one encrypted outbox row
  |
  +-- immediate best-effort drain -- Cloudflare Email Service
  `-- scheduled drain retries

Account UI
  | POST completion: session + CSRF + Idempotency-Key + code
  v
D1 batch: unique consumption claim + verified transaction + verified contact + audit
```

The provider call is always after the authoritative D1 commit. A mail outage therefore creates backlog instead of losing an accepted transaction or rolling back unrelated identity state.

## Data model and invariants

### Identifiers

Migration `0004` rebuilds `identifiers` with two distinct uniqueness rules:

```sql
UNIQUE (principal_id, kind, normalized_value)

CREATE UNIQUE INDEX ... ON identifiers(normalized_value)
WHERE kind = 'username';

CREATE UNIQUE INDEX ... ON identifiers(kind, normalized_value)
WHERE kind IN ('email', 'mobile') AND verified_at IS NOT NULL;
```

Consequences:

- one principal cannot add the same normalized contact twice;
- two principals may collect the same unverified address, so unproven data cannot squat global ownership;
- the first transaction that verifies a normalized email wins the database uniqueness claim;
- a competing completion rolls back and returns the generic `identifier_conflict` problem;
- username behavior remains globally unique;
- password authentication uses username or a **verified** email/mobile. Unknown and unverified contacts follow the same dummy-password-verifier and failure path.

This slice retains `verification_state` (`unverified`, `pending`, `verified`) and `verified_at` because existing account projections use both. Their consistency check remains enforced in D1. It also retains current primary-contact semantics; this ADR does not add `CHECK (is_primary => verified)`.

Email canonicalization keeps the user-facing value separately, preserves the local part, and lowercases the domain. Provider-specific transformations such as Gmail dot or plus-tag removal are not performed.

### Verification transaction

`identifier_verification_transactions` contains:

| Field | Invariant |
| --- | --- |
| `transaction_id` | Opaque primary key |
| `identifier_id` | Owned email contact; one pending transaction per contact |
| `destination_digest` | 32-byte domain-separated HMAC binding the transaction to the current normalized destination |
| `code_digest` | 32-byte domain-separated HMAC binding transaction, destination, and code |
| `attempt_count` | Integer from 0 through 10 |
| `state` | `pending`, `verified`, `expired`, `cancelled`, or `locked` |
| `created_at`, `expires_at`, `consumed_at` | `expires_at <= created_at + 600`; terminal states have `consumed_at` |

The current state machine is:

```text
                 wrong code (< 10)
                +------------------+
                |                  |
created ------> pending ----------> verified
                   |                 valid code + consumption PK
                   +-- 10th wrong -> locked
                   +-- timeout ---> expired
                   +-- resend/edit --> cancelled
```

The user-facing API may report every non-pending transaction as no longer active without exposing why it became terminal.
Deleting the contact deletes its ephemeral verification transaction and outbox through their scoped cascades; authoritative principal/audit data retains restrictive lifecycle semantics.

### Single-use completion

`identifier_verification_consumptions` has `transaction_id` as its primary key. A successful completion batch first inserts this claim, then updates the pending, unexpired transaction and exact contact. The claim is the concurrency arbiter: two valid concurrent completions cannot both commit. A unique-verified-contact conflict also rolls the entire batch back, including the claim.

Do not rely only on a conditional update. In D1, an update that changes zero rows does not by itself abort the rest of a batch.

### Encrypted delivery outbox

`email_verification_outbox` contains one row per verification transaction. Neither recipient nor code is stored in plaintext. The payload is JSON `{recipient, code}` encrypted with XChaCha20-Poly1305 using:

- Worker Secret `EMAIL_OUTBOX_KEY_V1`, a 32-byte base64url key;
- a fresh 24-byte nonce per row;
- AAD binding `outbox_id`, `transaction_id`, key revision 1, and template revision 1.

The verification transaction stores only HMAC digests using `CONTACT_VERIFICATION_PEPPER`. Codes and decrypted payloads never enter logs, traces, metrics, audit context, URLs, or responses.

The outbox state/lease contract is:

| State | Required fields | Transition |
| --- | --- | --- |
| `pending` | ciphertext, nonce, `next_attempt_at`; no lease/delivery time | An atomic due-row claim moves it to `sending` |
| `sending` | ciphertext, nonce, `next_attempt_at`, future `lease_expires_at` | Provider success -> `delivered`; transient failure -> `pending`; exhausted/permanent/expired -> `dead` |
| `delivered` | `delivered_at`; ciphertext/nonce/schedule/lease cleared | Terminal |
| `dead` | last bounded error code allowed; ciphertext/nonce/schedule/lease cleared | Terminal |

A claim may take a due `pending` row or reclaim a `sending` row whose lease expired. The claim is a conditional D1 update, and the worker sends only after confirming that it changed the row. Starting an attempt increments `attempt_count`; retryable failures use capped backoff while attempts remain. The schema caps attempts at 10.

Leasing prevents concurrent scheduled/request drains from normally sending the same row. It cannot make the external boundary exactly once: if Cloudflare accepts the email and the Worker dies before marking D1 delivered, a later lease owner can send the same code again. The duplicate carries no second capability, so this at-least-once behavior is acceptable and observable.

Rows whose verification transaction is terminal or expired are moved to `dead` without sending. Any terminal outbox state erases ciphertext and nonce.

## Start flow

`POST /v1/me/contacts/{contact_id}/verification-transactions`:

1. Uses the existing session, allowed-Origin, JSON content, session-bound CSRF, and `Idempotency-Key` middleware.
2. Confirms the contact belongs to the principal. Verified contacts return `409`; mobile returns the currently documented `503` because mobile delivery is outside this slice.
3. Reads policy from `EMAIL_VERIFICATION_TTL_SECONDS=600`, `EMAIL_VERIFICATION_COOLDOWN_SECONDS=60`, and `EMAIL_VERIFICATION_HOURLY_LIMIT=5`.
4. Generates an unbiased eight-digit code with a cryptographic RNG; stores only domain-separated HMAC digests in the transaction.
5. Encrypts the recipient/code payload with `EMAIL_OUTBOX_KEY_V1`.
6. Executes one D1 batch that expires timed-out work, atomically rechecks the owned contact snapshot, conditionally cancels an old pending transaction only when its replacement is eligible, inserts the new transaction under destination-wide cooldown/hourly-limit and one-pending checks, inserts its outbox row, and marks the contact `pending`.
7. Checks the conditional insert result. A changed/missing/verified contact maps to its stable contact problem; a quota rejection maps to `429` with `Retry-After` without invalidating the still-active code. D1 serializes writing batches, so different idempotency keys cannot bypass the authoritative insert predicates.
8. Attempts an immediate drain after commit. Provider failure is logged by reason class and left for the scheduler; the API still returns the committed `201` transaction metadata.

Repeating the same idempotency key replays the original result without creating or sending another transaction. A resend with a new key succeeds only after cooldown, cancels the previous pending transaction, and leaves exactly one valid code.

Registration does **not** invoke this flow in the current scope. It continues to create a usable account with an unverified email; the Account UI presents the verification action.

## Completion flow

`POST /v1/me/contacts/{contact_id}/verification-transactions/{transaction_id}/completion`:

1. Requires an active session for the owning principal, CSRF, allowed Origin, exact eight-digit input, and idempotency.
2. Rejects missing, terminal, or expired transactions without revealing contact ownership to another principal.
3. Recomputes the destination HMAC from the contact's **current** normalized value. A contact edit makes the transaction `cancelled`; an old code can never verify a new destination.
4. Recomputes the code HMAC and compares fixed-length digests in constant time.
5. A wrong code atomically increments the counter and locks on the tenth failure.
6. A correct code commits the consumption primary-key claim, transaction state, contact state/timestamp, and security audit in one D1 batch.
7. A verified-email uniqueness conflict returns generic `409 identifier_conflict`; no partial verification commits.

Success does not create, rotate, revoke, or raise the assurance of an Identity session. It only changes contact verification and therefore makes that email eligible for the already-supported password-identifier lookup.

## Cloudflare email boundary

Both staging and production configure a `send_email` binding named `EMAIL`, restricted to `allowed_sender_addresses: ["identity@moesegfault.dev"]`. Non-secret configuration is:

- `EMAIL_FROM_ADDRESS=identity@moesegfault.dev`;
- `EMAIL_FROM_NAME=moeSegFault Identity`;
- the three numeric policy variables listed above.

Required Worker Secrets are `CONTACT_VERIFICATION_PEPPER` and `EMAIL_OUTBOX_KEY_V1`. Release scripts verify their presence before migration/deploy. The sending domain must be onboarded to Cloudflare Email Sending with its Cloudflare-managed SPF, DKIM, bounce, and DMARC records.

Use the structured Cloudflare send API rather than hand-built MIME. Each bilingual message includes plain-text and escaped HTML alternatives, contains no remote assets or tracking pixels, and tells the user not to share the code.

Cloudflare provider acceptance is not proof of inbox delivery. The outbox records application-level acceptance/retry state; Cloudflare Email Service logs remain the delivery diagnostic source.

## Failure semantics

| Failure | Result |
| --- | --- |
| Current pepper/key missing or invalid | Start fails before D1 acceptance; release gate should prevent this configuration |
| D1 batch fails | No transaction/outbox is claimed; return a retryable Problem response |
| Cooldown/hour limit/one-pending predicate rejects insert | `429` plus `Retry-After`; no orphan outbox row |
| Cloudflare fails after D1 commit | Return the committed transaction; outbox retries asynchronously |
| Worker dies after Cloudflare accepts | A duplicate of the same code is possible after lease expiry |
| Contact edited after send | Destination digest mismatch cancels transaction |
| Code expires | Completion returns no-longer-active; dispatcher dead-letters without decrypting/sending again |
| Tenth wrong code | Transaction locks atomically |
| Another principal verified the same email first | Completion batch rolls back and returns generic `identifier_conflict` |
| Payload authentication/decryption fails | Retain bounded retry state until attempts/expiry; then move to `dead`, erase ciphertext, and expose the bounded error class operationally |

No provider failure blocks registration or existing password/passkey sessions.

## Observability

Track low-cardinality counts and latency for starts, `429` rejections, provider acceptance/failure classes, completion outcomes, lease reclamation, oldest pending age, retry count, and dead rows. Do not use addresses, principal/contact/transaction/outbox IDs, or message IDs as metric labels. Logs contain correlation IDs and bounded error codes, never codes, ciphertext plaintext, or full destinations.

The operational objective inherited from ADR-0003 is that 99% of accepted verification notifications are handed to the provider within five minutes. Alert on oldest due-row age rather than making the HTTP request wait for provider recovery.

## Rollout and validation

The feature is greenfield, but migration/Worker version skew still exists because `scripts/release.sh` applies D1 migrations before deploying the Worker. Migration `0004` is safe for the current rows: it copies existing primary and verification state without imposing verified-primary-only behavior, and the old verification start was a stub.

Delivery order:

1. onboard `moesegfault.dev` in Cloudflare Email Sending and reconcile DNS/sender binding;
2. create both required secrets in staging and production;
3. land migration, Worker, OpenAPI, Account UI, configuration, and scheduled drain as one tested artifact;
4. GitHub Actions run Rust format/clippy/unit/Wasm checks, OpenAPI lint, fresh-migration assertions, frontend tests, and Wrangler dry runs;
5. deploy staging, test an external recipient, cooldown, wrong-code lock, contact edit, lease retry, and successful login only after verification;
6. promote the identical artifact to production through the existing environment gate.

Focused database tests must prove:

- duplicate unverified email across principals succeeds;
- duplicate verified email fails atomically;
- same-principal duplicate fails;
- only one pending transaction exists per contact;
- hourly/cooldown rejection creates no outbox orphan;
- only one consumption primary-key claim wins;
- delivered/dead rows contain no ciphertext;
- expired leases are reclaimable.

PR tests use a fake delivery adapter and never send external mail. Staging smoke tests validate real Cloudflare provider acceptance; inbox arrival remains a separate synthetic/operational observation.

## Alternatives rejected for this slice

| Alternative | Reason |
| --- | --- |
| Send before committing D1 | A delivered code could have no valid transaction. |
| Send synchronously and roll back on provider failure | D1 cannot transact with an email provider; it would discard accepted work. |
| Store the code or recipient in plaintext | A D1 read would expose every live verification capability and destination. |
| Store only a digest with no encrypted outbox | The scheduled Worker could not retry delivery. |
| Self-contained JWT/link | Single use, attempt limits, resend cancellation, and contact-edit binding still require server state. |
| Several simultaneously valid resend codes | Adds user confusion and state without a dominant-use-case benefit. |
| Globally unique unverified email | Enables unproven-address squatting. |
| Provider-specific dot/plus canonicalization | Provider alias rules are inconsistent and can cause mistaken account merges. |
| Cloudflare Queue now | Adds a second delivery system without demonstrated volume need; it would still be at least once. |

## Evidence and confidence

- Cloudflare documents the structured Workers send binding, sender restrictions, and sending-domain onboarding: [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/), [send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/), [domain onboarding](https://developers.cloudflare.com/email-service/get-started/send-emails/).
- D1 documents batched statements as a transaction that rolls back the sequence on failure: [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/).
- OWASP recommends random, time-limited, single-use material, consistent canonicalization, rate limiting, and keeping codes/full addresses out of logs: [Email Validation and Verification Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html).
- RFC 6530 and RFC 8398 support preserving the local part and treating the domain case-insensitively: [RFC 6530](https://www.rfc-editor.org/rfc/rfc6530.html), [RFC 8398](https://www.rfc-editor.org/rfc/rfc8398.html).
- The peer-reviewed NDSS 2026 study *One Email, Many Faces* found inconsistent and often undocumented alias behavior, supporting the decision not to guess provider rules: [paper](https://www.ndss-symposium.org/wp-content/uploads/2026-s148-paper.pdf).
- A USENIX Security 2021 study found exploitable inconsistencies across email sender-authentication chains. This supports authenticated domain onboarding and unambiguous message construction, but does not imply guaranteed delivery: [Weak Links in Authentication Chains](https://www.usenix.org/system/files/sec21-shen-kaiwen.pdf).

Confidence is high in the D1 transaction/consumption/outbox boundaries and verified-only password lookup. The 600-second lifetime, 60-second cooldown, five-per-hour threshold, ten-attempt limit, and lease/backoff values are policy choices with moderate confidence; production completion rates, delivery latency, dead-row volume, and abuse data should drive later adjustment.

## Consequences

The implementation adds a small explicit state machine and encrypted outbox, but removes worse special cases: lost delivery work, plaintext live codes, replayable completion, unverified email login, and global squatting by unverified contacts. Registration and existing authentication remain available when mail delivery is down. Broader primary-email, recovery, and registration-verification policy remains deliberately open for a later ADR.
