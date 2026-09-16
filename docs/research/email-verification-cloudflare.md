# Production email verification on Cloudflare

**Research date:** 2026-09-16

**Scope:** ownership verification for account email contacts, using Cloudflare Workers and
Cloudflare Email Service's `send_email` binding. This note is implementation guidance, not a
normative product contract. It distinguishes observations from inferences and recommendations.

## Executive judgment

The shortest production-shaped design for this repository is:

1. Onboard `moesegfault.dev` (or a dedicated transactional subdomain) to **Email Sending**,
   not merely Email Routing. Configure the Worker binding with
   `allowed_sender_addresses: ["identity@moesegfault.dev"]`.
2. Keep the existing manual-code UX rather than changing to a bearer link. Generate an unbiased
   eight-decimal-digit code, valid for about 30 minutes, allow at most ten failed completion
   attempts, and HMAC it with a dedicated, rotatable Worker secret before persistence.
3. Commit the verification transaction, notification outbox item, and audit event together in D1.
   Send asynchronously. Complete verification with one atomic conditional state transition so
   racing/replayed attempts cannot both succeed.
4. Rate-limit both **issuance** and **completion**. Use durable D1 counters/state for the
   per-contact security invariant; an edge rate-limit binding or WAF rule is only a coarse outer
   shield because Cloudflare documents its counters as per-location, permissive, and eventually
   consistent.
5. In normal application logs, retain only a pseudonymous contact digest, transaction outcome,
   provider error class, and Cloudflare message ID. Never record the code, its digest, the full
   email address, or a token-bearing URL. Disable Cloudflare Email Preview for the sending domain
   in production because new sending domains have it enabled by default and full message content
   is retained for about seven days.
6. PR CI uses a fake mail transport plus Wrangler's local email simulation; it must not send real
   messages. A protected staging environment may use the remote binding and controlled seed
   mailboxes. Production promotion follows the repository's existing test-once/promote-the-same-
   artifact pipeline.

This is a provisional judgment. Cloudflare currently labels Email Sending **Beta**, and its
current documentation contains a destination-policy wording inconsistency described below.
Staging delivery to arbitrary recipients is therefore a release gate, not an assumption.

## 1. What the Cloudflare products do

### 1.1 Email Sending is the required capability

**Observed.** Cloudflare Email Service supports a Workers binding, REST API, and SMTP. A sender
domain must be onboarded to Email Sending, the zone must use Cloudflare DNS, and Cloudflare adds
records for the `cf-bounce` return path, SPF, DKIM, and DMARC. DNS propagation may take up to 24
hours, though Cloudflare says it usually takes 5-15 minutes on its DNS. See
[Send emails](https://developers.cloudflare.com/email-service/get-started/send-emails/) and
[Domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/).

**Observed.** Before a sending domain is onboarded, the service can send only to account-level
verified destination addresses. After onboarding, Cloudflare says it can send to arbitrary
recipients. Verified destinations remain a useful no-quota test path. See
[Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/).

**Observed.** Email Routing is the inbound/forwarding product. It requires verified forwarding
destinations and routing rules, but it is not necessary merely to emit verification mail. Sending
already configures Cloudflare's `cf-bounce` return path. See
[Route emails](https://developers.cloudflare.com/email-service/get-started/route-emails/).

**Recommended.** Onboard the apex `moesegfault.dev` if `From: identity@moesegfault.dev` is a hard
product requirement. If sender-reputation isolation matters more than the exact address, prefer a
dedicated subdomain such as `identity@mail.moesegfault.dev`; Cloudflare explicitly recommends
separating mail purposes by domain/subdomain. The requested exact address makes apex onboarding
the likely first choice. Do not enable inbound Email Routing unless replies to
`identity@moesegfault.dev` are intentionally handled. If replies are unsupported, say so clearly
in the message; do not imply that an unmonitored mailbox is a support channel.

### 1.2 Binding semantics

**Observed.** The current structured Workers API is:

```text
env.EMAIL.send({ to, from, subject, html?, text?, cc?, bcc?, replyTo?, ... })
    -> Promise<{ messageId: string }>
```

The binding sends one email, returns a provider message ID, and throws ordinary error objects with
a `code`. Documented errors include validation failures, unverified/unavailable sender domain,
disallowed/suppressed recipient, delivery failure, rate/daily quota exhaustion, and internal
service failure. For new code Cloudflare recommends the structured builder rather than the legacy
raw RFC 5322 `EmailMessage` API. See
[Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).

**Observed.** Binding configuration can restrict a single destination, an allowed destination
set, and/or allowed senders. The sender must belong to an onboarded domain. See
[Configure send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/).

**Recommended configuration shape:**

```jsonc
{
  "send_email": [
    {
      "name": "EMAIL",
      "allowed_sender_addresses": ["identity@moesegfault.dev"]
    }
  ]
}
```

Do not configure a fixed `destination_address` or `allowed_destination_addresses` for the
production verification binding: application recipients are dynamic. Restricting `From` at the
binding boundary is useful defense in depth and makes accidental use as a general-purpose mailer
less likely.

**Important documentation uncertainty.** The dedicated binding page currently says a binding
without a destination restriction sends to “any verified destination address,” while the limits
page says an onboarded sending domain can immediately send to any recipient. The latter is
necessary for an identity service and is also consistent with the Email Sending getting-started
example. Treat successful arbitrary-recipient delivery in a staging sending domain as a rollout
criterion. Do not infer this behavior solely from local simulation.

**Observed project fit.** `workers-rs` 0.8.5 exposes
`Env::send_email(&str) -> Result<SendEmail>` and can send either a structured `Email` or legacy
`EmailMessage`; support entered the upstream SDK in the 0.8.3 release. This repository already
pins `worker = 0.8.5`, so no JavaScript bridge or third-party SMTP client is inherently required.
See [workers-rs `Env`](https://docs.rs/worker/latest/worker/struct.Env.html),
[workers-rs release history](https://github.com/cloudflare/workers-rs/releases), and
`crates/identity-worker/Cargo.toml`.

### 1.3 Limits and beta risk

**Observed.** Cloudflare currently labels Email Sending Beta. New accounts begin with conservative
daily quotas that change with reputation/account standing. The documented message limits include
50 combined recipients, a 5 MiB message, and a 16 KiB custom-header budget. Verification mail is
one-recipient, tiny transactional traffic, so content limits are not the practical concern;
account quota and service maturity are. See
[Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/) and the
[Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).

**Recommended.** Isolate Cloudflare behind a narrow internal `VerificationMailer`/notification
adapter. Do not spread platform error strings or JavaScript binding types into account-domain
logic. Classify errors into stable application categories such as permanent recipient failure,
configuration failure, throttled/quota, and transient provider failure. This is not a call to add
a second provider now; it is a cheap boundary around a beta dependency.

## 2. Sender-domain and deliverability prerequisites

| Concern | Observed evidence | Project action |
| --- | --- | --- |
| DNS authority | Email Service requires Cloudflare DNS. | Verify `moesegfault.dev` is on Cloudflare DNS before coding against real delivery. |
| Return path | Sending uses MX under `cf-bounce.<domain>`. | Let Cloudflare create/manage the exact records it presents; do not invent them from this note. |
| SPF | Cloudflare provisions an SPF record for the sending return-path domain. RFC 7208 limits SPF mechanisms/modifiers that cause DNS lookup to 10. | Ensure there is one valid SPF policy per DNS name and inspect combined lookup count if other senders exist. See [RFC 7208](https://www.rfc-editor.org/rfc/rfc7208.html). |
| DKIM | Cloudflare provisions and manages a DKIM selector/key for sending. | Verify DKIM pass in real received headers and Email Service analytics. See [RFC 6376](https://www.rfc-editor.org/rfc/rfc6376.html). |
| DMARC | DMARC requires SPF or DKIM success **and identifier alignment** with the RFC 5322 From domain. RFC 9989 replaced RFC 7489 in May 2026. | Start with reporting/observation if this domain has other legitimate senders; move to enforcement only after all legitimate streams align. See [RFC 9989](https://www.rfc-editor.org/info/rfc9989/). |
| Reputation | Cloudflare automatically handles retries, hard-bounce suppression, and complaints, but recipient providers still decide inbox placement. | Send only user-triggered transactional mail; never turn this stream into marketing. Monitor delivery, hard-bounce, and complaint rates. |
| Content | Cloudflare recommends both plain text and HTML, legitimate URLs, and clear sender identification. | Produce localized `text/plain` and minimal escaped HTML from the same typed template data. No tracking pixels or URL shorteners. |

Cloudflare's deliverability page suggests operational targets of delivery above 95%, hard bounces
below 2%, and complaints below 0.1%. These are provider guidance, not proof that a particular
message reached the inbox. “Delivered” means the recipient mail server accepted it. See
[Email deliverability](https://developers.cloudflare.com/email-service/concepts/deliverability/)
and [Email lifecycle](https://developers.cloudflare.com/email-service/concepts/email-lifecycle/).

**Recommended deployment check.** Test headers and latency against controlled Gmail, Outlook,
QQ Mail, and NetEase 163 mailboxes if mainland-China users are an intended population. This is a
recommended empirical matrix, not an assertion that those four providers represent all users.
Record acceptance latency and inbox/spam placement separately: SMTP acceptance is observable;
inbox placement generally is not.

## 3. Verification semantics and threat boundary

### 3.1 What verification proves — and does not prove

**Observed.** OWASP describes email ownership verification as evidence that the address is
syntactically usable, the application can deliver to it, and the actor had access to the mailbox.
It does not prove a legal identity or permanent ownership. OWASP recommends cryptographically
random, single-use, time-limited tokens and delaying activation/privilege until verification.
See [OWASP Email Validation and Verification Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html)
and [OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html#email-address-validation).

**Observed.** NIST SP 800-63B-4 explicitly prohibits email as an out-of-band **authenticator**, but
also explicitly says confirmation codes used to validate email addresses are not authentication
processes and are outside that prohibition. For email recovery-address confirmation, NIST requires
at least six decimal digits (or equivalent), an approved random source, throttling, and no more
than 24 hours validity. See
[NIST SP 800-63B-4, out-of-band authenticators](https://pages.nist.gov/800-63-4/sp800-63b.html#out-of-band-authenticators)
and [account recovery](https://pages.nist.gov/800-63-4/sp800-63b/events/#account-recovery).

**Recommended.** A verified email may become an allowed login identifier or recovery contact under
product policy, but the verification event itself must not silently upgrade the current session,
satisfy MFA, or authorize an unrelated high-risk operation. An email change should require recent
authentication and notify the old verified address; OWASP treats changing an email as an identity
change.

### 3.2 Preserve and compare addresses deliberately

**Observed.** SMTP requires the local part to be treated as case-sensitive, even though most large
providers behave case-insensitively; the domain is case-insensitive. OWASP recommends retaining
the entered form, lowercasing the domain for comparison, avoiding provider-specific Gmail-style
dot/plus rewriting, and defining one comparison policy across registration, login, recovery, and
linking. See [RFC 5321](https://www.rfc-editor.org/rfc/rfc5321.html#section-2.4) and the
[OWASP email cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html).

**Observed project fit.** `normalize_email` already preserves local-part case and lowercases the
domain; `identifiers.value` retains display spelling while `normalized_value` is unique. That is a
defensible conservative policy. The code intentionally accepts a narrower ASCII-domain subset
than the full email standards; changing internationalized-address support is a separate product
decision, not a prerequisite for verification.

## 4. Recommended state machine and data flow

The repository already has a good base: `identifiers.verification_state`, a separate
`identifier_verification_transactions` table with a 32-byte digest, ten-attempt bound, explicit
terminal states, a single-use transaction API, and an ADR that assigns notification work to an
outbox/queue rather than the authentication transaction.

```text
unverified identifier
       |
       | create transaction + notification outbox + audit (one D1 commit)
       v
pending ---- resend ----> cancel/supersede old pending tx, create new pending tx
   |  \
   |   \ expiry / too many failures
   |    v
   |  expired / locked
   |
   | correct code, not expired, pending, attempts below cap
   v
verified  (transaction consume + identifier update + audit in one atomic mutation)
```

### 4.1 Issuance

**Recommended transaction:**

1. Require an authenticated account session, CSRF protection, and the repository's recent-auth
   proof where contact changes are classified as high risk.
2. Resolve the contact by `(principal_id, identifier_id)`; never trust a destination supplied to
   the send endpoint independently of the stored contact.
3. Apply resend cooldown and durable per-contact/per-account daily budgets before generating a
   code. Generating a new code must not reset accumulated failed-attempt abuse state.
4. Generate the code with Web Crypto randomness and avoid modulo bias. Store
   `HMAC-SHA-256(CONTACT_VERIFICATION_PEPPER, purpose || transaction_id || identifier_id || code)`;
   do not store a bare SHA-256 digest of a low-entropy decimal code.
5. Cancel/supersede prior pending transactions for that identifier, insert the new transaction,
   add an immutable notification outbox record, and append an audit event in one D1 commit.
6. Return the transaction handle, expiry, and masked delivery hint. “Accepted for delivery” is not
   “delivered to inbox.”

Why HMAC: eight decimal digits have only about 26.6 bits. If a D1 snapshot leaks, a bare digest is
cheap to exhaust offline. A separate secret pepper prevents offline validation while it remains
secret. Domain-separate it from session, recovery, registration, and OAuth peppers. Rotation
should invalidate only pending contact-verification transactions, not sessions or unrelated
capabilities.

### 4.2 Delivery

**Recommended.** The mail consumer should re-read the transaction before sending and suppress
work for a transaction that is no longer pending or has expired. Render immutable typed template
data, call the binding once, and persist the returned Cloudflare `messageId` and a stable outcome
class. Retry throttling and internal errors with bounded exponential backoff plus jitter; do not
retry permanent validation, sender-configuration, suppressed-recipient, or hard-delivery errors.

Cloudflare itself retries SMTP soft bounces with exponential backoff and does not retry hard
bounces. Application retry is for failure to submit/accept the message, not for reimplementing
Cloudflare's SMTP retry loop.

**At-least-once caveat.** D1 state, a Queue/outbox consumer, and the external mail provider cannot
form one atomic transaction, and the binding does not document an idempotency key. A worker can
crash after Cloudflare accepted a message but before D1 records that acceptance, so an identical
duplicate is possible. Make duplicates harmless: reuse the same transaction/code for a delivery
retry, do not generate a fresh code inside the consumer, and ensure the message clearly identifies
its expiry. An explicit user resend should supersede the prior transaction; a consumer must check
that fact before a late first-send attempt.

The outbox needs enough protected information to render the code later. Do not put plaintext codes
in ordinary logs or audit payloads. Practical choices are a short-lived AEAD-encrypted notification
payload with a versioned Worker secret, or an equivalently protected derivation scheme. Delete or
cryptographically erase this payload after terminal delivery/expiry. Merely storing `code_digest`
cannot support a durable retry because it cannot reconstruct the code.

### 4.3 Completion and replay resistance

**Recommended.** Completion should perform one correctness-critical D1 mutation, logically:

```text
UPDATE transaction
SET state='verified', consumed_at=now
WHERE transaction_id=? AND identifier_id=? AND state='pending'
  AND expires_at>now AND attempt_count<10 AND digest_matches=true;

UPDATE identifier
SET verification_state='verified', verified_at=now, updated_at=now
WHERE identifier_id=?;

INSERT audit event ...;
```

The exact SQL may need a preliminary constant-time application comparison, but success must still
be claimed by a conditional update/uniqueness rule. A read-then-write sequence is insufficient:
two concurrent requests could both observe `pending`. Wrong guesses increment `attempt_count`
durably and atomically; reaching the cap transitions to `locked`. Expired rows transition to
`expired`. A repeated completion returns a stable consumed/expired result and never performs the
business mutation twice.

Bind the transaction to the immutable identifier row (and, if values can be edited in place, to an
identifier version/value digest). Otherwise a code issued for address A could verify address B
after a concurrent edit.

## 5. Code versus bearer link

| Design | Entropy and expiry | Operational properties | Judgment here |
| --- | --- | --- | --- |
| Manual decimal code | Recommend 8 unbiased digits, 30-minute TTL, 10 total failures. NIST's recovery-address floor is 6 digits and ceiling is 24 hours; the exact 8/30 choice is project policy, not a NIST mandate. | Works with `autocomplete="one-time-code"`; no secret in URL/history/referrer; requires returning to the originating UI; needs strict online throttling. | **Preferred**, because the contract/UI already use a code and the authenticated transaction ID supplies context. |
| Opaque URL token | At least 32 random characters per OWASP; a 32-byte random value encoded as unpadded base64url is 43 characters/256 bits. Single use and time limited. | Easier click flow, but bearer secret appears in email and usually URL infrastructure. Build URL from a fixed trusted origin, use HTTPS and `Referrer-Policy: no-referrer`, and never log it. | Viable later, but unnecessary now. |
| JWT link | Signed claims can be stateless, but replay prevention still requires state; key/algorithm/audience mistakes expand the attack surface. OWASP explicitly notes JWT introduces additional vulnerabilities. | More moving pieces and no benefit over an opaque capability for one application. | Do not choose for this feature. |

OWASP's detailed reset guidance calls for a cryptographically secure generator, sufficient length,
secure storage, per-user binding, one-time consumption, trusted hard-coded/allowlisted HTTPS
origins, `no-referrer`, and brute-force controls. See
[OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
Password reset is higher impact than contact verification, but these token-handling mechanisms
transfer directly.

If a link is ever added, avoid performing the irreversible transition on a bare GET. Enterprise
mail products scan and rewrite links; Microsoft documents pre-delivery and time-of-click URL
scanning in Safe Links. A scanner-safe flow lands on a confirmation page and consumes via a
user-initiated POST, or exchanges the bearer secret into a restricted HttpOnly cookie before the
confirmation step. See
[Microsoft Safe Links](https://learn.microsoft.com/en-us/defender-office-365/safe-links-about).

## 6. Enumeration and abuse resistance

### 6.1 Responses and timing

**Observed.** OWASP recommends consistent responses and comparable timing for existent and
non-existent accounts, plus asynchronous work or equivalent code paths, to reduce enumeration.
It also recommends per-account rate limiting/CAPTCHA or other automation controls to prevent
mailbox flooding. See the
[OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

**Project interpretation.** The self-service endpoint is already authenticated and scoped to the
caller's contact, so anonymous account enumeration is not its primary risk. Registration,
recovery, resend, and “add an already-used email” surfaces can still reveal account existence or
become mail-bomb amplifiers. Public-facing responses should not say whether an address belongs to
another principal. Authenticated account UI may say that the requested operation could not be
completed, but should not reveal the other account.

Do not fake constant time with arbitrary sleeps. Move sending off the response path, use the same
database-shaped work for sensitive positive/negative cases where practical, and return the same
accepted envelope before delivery. Measure latency distributions to verify the control rather than
assuming it.

### 6.2 Layered rate limits

Recommended controls, starting with correctness-critical state:

| Key/scope | Purpose | Suggested initial policy (tune from evidence) |
| --- | --- | --- |
| Transaction | Stop code guessing | 10 total wrong attempts, already supported by the schema; new issuance does not erase account/contact abuse history. |
| Contact | Stop mailbox flooding | 60-second resend cooldown; about 5 sends/hour and 10/day. |
| Principal | Stop rotating contacts | About 10 sends/hour and 20/day across contacts. |
| Source/network risk | Slow automation without punishing shared NATs as the only identity | Coarse edge budget; escalate suspicious unauthenticated traffic to Turnstile rather than relying solely on IP. |
| Service/global | Protect quota/reputation | Alert and shed abusive issuance before the provider daily quota is exhausted. Keep legitimate completion available. |

These numeric values are starting hypotheses, not standards. Instrument legitimate resend
distributions, provider latency, and abuse before tightening them.

**Observed Cloudflare limitation.** Workers Rate Limiting bindings are per Cloudflare location,
permissive, asynchronously updated, and explicitly not accurate accounting. Cloudflare advises
stable user/tenant identifiers rather than IP alone because IPs are often shared. See
[Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

**Recommended.** Use D1 transaction/account counters for the global attempt and issuance
invariants. Optionally put a Rate Limiting binding or WAF rule in front as a cheap high-volume
shield. Cloudflare's WAF guidance specifically identifies OTP/verification endpoints as brute-force
targets, but response-based WAF counting may require paid-plan features; see
[WAF rate-limiting best practices](https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/).

## 7. Message construction

Recommended template contract:

- From: `moeSegFault Identity <identity@moesegfault.dev>`.
- Subject: localized, stable, and unambiguous (for example, “Verify your moeSegFault email”).
- Both text and HTML bodies, generated from the same escaped values.
- Prominent code, explicit expiry, and the destination/account context only to the extent needed.
- “If you did not request this, you can ignore it; no account change has occurred.”
- The canonical visible domain and support/report-abuse instructions.
- No password, session identifier, principal ID, raw transaction ID, analytics pixel, third-party
  image, or unnecessary personal data.
- Do not echo user-controlled display names into HTML unless the renderer escapes them by
  construction. A static greeting is simpler and avoids an injection special case.

This is transactional and user-triggered mail, not a marketing subscription. Keep product
announcements out of this stream. Cloudflare says Email Service is currently intended only for
transactional mail; see the [Email Service FAQ](https://developers.cloudflare.com/email-service/reference/faq/).

## 8. Observability, privacy, and delivery feedback

### 8.1 Application events

Use separate events for:

```text
verification_requested
notification_enqueued
provider_submission_accepted
provider_submission_failed {class}
message_delivered | message_deferred | message_bounced | message_rejected | message_complained
verification_completed | verification_failed {expired|wrong|locked|consumed}
```

Allowed correlation fields should be low-risk opaque IDs or irreversible keyed pseudonyms with
bounded retention. Never use contact, principal, transaction, or message ID as a metric label;
high-cardinality identifiers belong only in restricted diagnostic/audit records when needed.
Do not log email body/subject if the subject ever carries user data. Never log a verification
code, code digest, encrypted outbox payload, or full verification URL.

**Observed.** Cloudflare exposes 31 days of Email Service analytics via GraphQL, including status,
sending domain, auth results, message ID, sender/recipient, subject, and failure detail. Email logs
distinguish sent, delivered, delivery failed, rejected, and configuration/authentication failure.
See [Metrics and analytics](https://developers.cloudflare.com/email-service/observability/metrics-analytics/)
and [Email logs](https://developers.cloudflare.com/email-service/observability/logs/).

**Observed.** Cloudflare warns that messages emitted through a Worker's `send_email` binding can
appear as “dropped” in the **Email Routing** summary even when they were delivered. Outbound truth
must come from Email **Sending** metrics/logs (or sending lifecycle events), not the Routing
summary. See [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/#emails-sent-from-workers).

**Observed.** Event subscriptions can publish delivered, deferred, bounced, failed, rejected, and
complained lifecycle events to a Cloudflare Queue. Event payloads include recipient and subject,
so the consumer and queue are privacy-sensitive. See
[Email Sending event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/).

**Recommended.** Phase one can use binding submission result plus Cloudflare dashboards/GraphQL
for operational review. Add event subscriptions when automated suppression/user-facing delivery
status materially improves operations. Treat duplicate/out-of-order lifecycle events as normal;
deduplicate on event ID and order by provider event time/state semantics rather than arrival time.

### 8.2 Disable production message preview

**Observed.** Email Preview exposes HTML, text, headers, attachments, and the full raw message in
Cloudflare's activity log for about seven days. New sending domains have Preview enabled by
default. A verification code in the message is therefore readable to anyone with access to this
dashboard capability. See
[Email logs: Message preview](https://developers.cloudflare.com/email-service/observability/logs/#message-preview).

**Recommended.** Set `preview_enabled = false` for the production sending domain after template
validation. It may be temporarily enabled in a tightly controlled staging domain. Cloudflare's
Terraform resource exposes this flag; see
[`cloudflare_email_sending_subdomain`](https://developers.cloudflare.com/api/terraform/resources/email_sending/).
Also constrain Cloudflare dashboard/API access and audit configuration/suppression changes. Email
Service writes domain onboarding, enable/disable, and suppression changes to Cloudflare audit logs:
[Email Service audit logs](https://developers.cloudflare.com/email-service/observability/audit-logs/).

## 9. Testing strategy

### 9.1 Pure unit/contract tests (every PR)

- Code generation: exact alphabet/length, unbiased sampling method, no deterministic fallback.
- Digest: domain-separated HMAC, correct secret binding, constant-time fixed-length comparison,
  and rotation behavior.
- State machine table tests for pending/verified/expired/cancelled/locked.
- Concurrency test: two correct completions of one transaction yield exactly one state change.
- Wrong-attempt boundary: attempt 10 locks; resend does not reset durable abuse accounting.
- Expiry boundaries with an injected clock (just before, exactly at, and after expiry).
- Resend supersedes the old pending transaction and stale delivery work is suppressed.
- Contact mutation/race: a code cannot verify a changed or different identifier.
- Idempotency replay returns the same logical issuance result and does not enqueue a second mail.
- Renderer snapshots for `zh-CN`, `en`, and `ja`, both text and HTML, with adversarial display data.
- Logging test: captured logs contain neither the code, address, digest, nor rendered body.
- Adapter error table for every documented Cloudflare error family.

Use a typed fake mailer that records an envelope in memory; application tests should not import the
real binding. This preserves fast native Rust tests even though the binding exists only under
`workerd`/Wasm.

### 9.2 Local integration

**Observed.** `wrangler dev` locally simulates the email binding: no email is sent; content is
logged and saved to local files for inspection. `remote: true` sends real email through Email
Service. Remote binding calls affect real resources and quota. See
[Local email sending](https://developers.cloudflare.com/email-service/local-development/sending/)
and [supported development bindings](https://developers.cloudflare.com/workers/local-development/bindings-per-env/).

**Recommended.** Default local and CI configuration must stay simulated. Put any `remote: true`
setting in a staging-only Wrangler environment, never the shared default. Add a fixture-level
integration that creates a verification, inspects the simulated text/HTML output, completes it,
and proves replay rejection. Do not put generated test artifacts outside repository `.temp` or
`.cache`.

### 9.3 Staging end-to-end

A protected, non-PR workflow may:

1. deploy the tested artifact to staging;
2. request a code for one or more controlled test mailboxes;
3. receive/parse the message through a test mailbox mechanism that does not expose credentials to
   untrusted PR code;
4. complete verification, replay it, and verify only the first succeeds;
5. verify SPF/DKIM/DMARC results, sender, both MIME alternatives, expiry, and observed latency.

If there is no safely automated mailbox, make external delivery a scheduled/manual synthetic and
keep deployment health checks independent. A provider/mailbox outage should show as a delivery
SLO incident, not falsely mark the identity Worker itself unavailable.

## 10. GitHub Actions and deployment

**Observed project state.** `.github/workflows/ci.yml` already:

- grants only `contents: read` globally;
- pins third-party actions to full commit SHAs;
- builds/tests once, packages a checksummed immutable artifact, deploys staging, then promotes the
  same revision to production;
- uses GitHub environments and non-overlapping deployment concurrency;
- rejects a stale production run whose SHA is no longer `main`.

This is stronger than replacing the workflow with a generic Wrangler action example. Extend the
existing pipeline rather than creating a second deployment authority.

**Cloudflare guidance.** Non-interactive Wrangler deployment uses a Cloudflare API token and
account ID stored as CI secrets, and the token should be restricted to the required account/zone.
See [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

**GitHub guidance.** Use environment secrets/protection rules, prevent self-review where
available, serialize deployments, grant the `GITHUB_TOKEN` least privilege, and pin third-party
actions to full commit SHAs. See
[GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[deployment control](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments),
and [secure use](https://docs.github.com/en/actions/reference/security/secure-use).

**Recommended pipeline changes:**

- Add fake-mail/domain tests to the existing Rust job and a `wrangler deploy --dry-run` assertion
  that both staging and production resolve the `EMAIL` binding.
- Never use real remote email in `pull_request` workflows. GitHub intentionally withholds ordinary
  secrets from untrusted forks, and no workaround should weaken that boundary.
- Give the staging environment only staging resources/test recipients. Production credentials
  remain environment-scoped and available only after protection rules pass.
- Keep Email Sending domain onboarding/DNS and Preview policy in a separately reviewed bootstrap/
  infrastructure step. The Cloudflare Terraform provider exposes the sending-subdomain resource;
  the REST API also exposes sending-domain endpoints. Do not let every application deploy mutate
  DNS or domain onboarding.
- Separate the application deploy token from any one-time broader bootstrap token if the latter
  needs Email Sending/DNS configuration rights. The steady-state app binding itself needs no API
  token in Worker code.
- Run post-deploy staging contract checks before production promotion. A real-mail canary should
  be bounded, controlled, and tagged; never send to arbitrary user input from CI.

## 11. Failure and retry decisions

| Cloudflare/provider outcome | User-visible/application behavior | Retry? |
| --- | --- | --- |
| Binding missing, sender domain unavailable/unverified | Configuration incident; keep transaction pending or mark delivery failed; expose a generic temporary failure/resend path. | No blind retry until config fixed; alert. |
| Validation/field/header error | Code/template defect. | No; alert and fix. |
| Recipient not allowed | Likely binding/domain misconfiguration given dynamic verification recipients. | No; alert. |
| Recipient suppressed / hard bounce | Do not hammer the address; show that delivery could not be completed without exposing provider internals. | No automatic resend until address corrected or suppression is legitimately reviewed. |
| Rate/daily limit | Preserve pending work; apply `Retry-After`/backoff and alert before quota exhaustion. | Yes, bounded and delayed. |
| Internal/transient submission failure | Keep outbox work retryable. | Yes, exponential backoff + jitter, bounded by transaction expiry. |
| Provider accepted (`messageId`) | Mark submitted. This is not proof of inbox delivery. | No application resubmit. Cloudflare owns SMTP soft-bounce retries. |
| Deferred lifecycle event | Keep delivery status pending. | Cloudflare retries; application does not create a new transaction. |
| Delivered lifecycle event | Record mail-server acceptance; do not mark contact verified. | N/A. User must still present the code. |

Do not roll back an otherwise valid account registration solely because email delivery is down;
that matches the repository ADR. Equally, do not grant verified-email login/recovery authority
until the verification transition succeeds.

## 12. Evidence-strength ledger

| Claim | Status | Confidence / caveat |
| --- | --- | --- |
| Cloudflare DNS and Email Sending domain onboarding are prerequisites for arbitrary-recipient sends. | **Observed** in official Cloudflare docs. | High, but service is Beta. |
| `identity@moesegfault.dev` can be constrained with `allowed_sender_addresses`. | **Observed** in current binding docs. | High; must still stage-test the Rust binding path. |
| Arbitrary recipients work after domain onboarding. | **Observed** in limits/get-started docs. | Medium-high because the binding-config page still says “verified destinations”; staging validation required. |
| Eight digits and a 30-minute TTL are the right initial UX/security balance here. | **Recommended**, derived from NIST floor/ceiling, OWASP mechanisms, current ten-attempt schema, and expected email delays. | Medium; measure delivery latency and resend behavior. |
| HMAC rather than bare hashing is required for low-entropy stored codes. | **Inferred/recommended** from offline-guessability mechanics; OWASP only says store securely. | High mechanistic confidence. |
| D1 must enforce completion and issuance budgets, not only edge rate limiting. | **Inferred/recommended** from Cloudflare's stated per-location/eventual counter semantics. | High. |
| Disable production Email Preview. | **Recommended** from the observed seven-day full-message retention/default-on behavior. | High unless operational/legal requirements explicitly accept that exposure. |
| Queue/event subscriptions are needed on day one. | **Not established.** | The repository ADR favors outbox/queue, but Cloudflare dashboards plus binding outcomes may suffice for initial delivery observability. Durable notification dispatch still needs a reviewed mechanism. |
| SMTP “delivered” means the user saw the message. | **Rejected.** | It only means the receiving server accepted it; inbox placement/read are different facts. |

## 13. Acceptance checklist

### Cloudflare / infrastructure

- [ ] Correct sending domain onboarded; DNS shows ready.
- [ ] SPF, DKIM, and DMARC pass/alignment verified from real received headers.
- [ ] Binding exists in staging and production and restricts sender to
      `identity@moesegfault.dev`.
- [ ] Arbitrary-recipient staging test passes; verified-destination-only ambiguity resolved.
- [ ] Production Email Preview disabled; Cloudflare access and audit logs reviewed.
- [ ] Quota, bounce, complaint, suppression, and delivery dashboards/alerts exist.

### Domain and data

- [ ] Code generated without modulo bias from Web Crypto randomness.
- [ ] Dedicated versioned contact-verification pepper; no bare digest.
- [ ] One active logical verification transaction per contact; resend semantics explicit.
- [ ] Attempt count and issuance budgets durable and not reset to aid an attacker.
- [ ] Expiry, consume, identifier verification, and audit transition are atomic.
- [ ] Notification payload can be retried without plaintext code in ordinary storage/logging.
- [ ] Duplicate provider submission is harmless; terminal errors are not retried.

### API and UX

- [ ] Accepted/submitted/delivered/verified are not conflated.
- [ ] Enumeration-safe public responses and masked hints.
- [ ] `autocomplete="one-time-code"`, paste supported, localized expiry/resend states.
- [ ] HTML escaped and a complete plain-text alternative included.
- [ ] Unexpected-message guidance and a real support/report path.

### Tests and delivery

- [ ] Unit, expiry, race, replay, supersession, rate-limit, renderer, and log-redaction tests.
- [ ] Local simulated-binding integration test.
- [ ] No real email from PR CI.
- [ ] Protected staging real-delivery synthetic or documented manual gate.
- [ ] Existing immutable-artifact staging-to-production promotion preserved.

## Most valuable remaining checks

1. Confirm in the actual Cloudflare account that Email Sending Beta entitlement is enabled and
   whether apex `moesegfault.dev` is already used by another outbound provider; this determines
   SPF/DMARC migration risk.
2. Exercise `worker` 0.8.5 structured `Email` sending in this exact Wasm build and capture the
   actual JS error-code mapping; docs.rs proves SDK surface existence, not this application's glue.
3. Verify arbitrary-recipient behavior with `allowed_sender_addresses` in staging because official
   destination wording is inconsistent.
4. Decide the durable notification payload protection and retry contract before implementing the
   outbox; the current digest-only transaction cannot reconstruct a code after a crash.
5. Measure real delivery latency and inbox placement for the target provider mix before finalizing
   the 30-minute TTL and resend thresholds.
