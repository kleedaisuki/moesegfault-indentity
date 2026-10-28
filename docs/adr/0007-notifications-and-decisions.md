# ADR-0007: Capability-bound Notifications and Decisions

- Status: Accepted
- Date: 2026-10-28
- Release: 0.2.0

## Ownership and trust

Identity remains the only authority for mailbox verification and account state.
Notifications owns sender identities, branded rendering, and accepted email delivery.
Decisions owns expiring response capabilities, one-time submissions, and durable
delivery of responses to the registering service. Each service has a separate D1.

```text
Identity encrypted outbox ── NotificationsApi ── Notifications D1 ── Email Service
First-party service ── DecisionsApi ── Decisions D1
                            │               ├── NotificationsApi ── email link
                            │               └── registered callback binding
                            └── recipient GET → form → explicit POST confirmation
```

Machine calls use deployment-owned Cloudflare service bindings addressing named
`WorkerEntrypoint` exports. Default public handlers cannot route the internal API.
This does not invent a machine OAuth grant in Identity or distribute a shared
platform bearer credential. A binding is broad first-party platform authority:
its holder can select a service name and sender, so it must not be granted to
untrusted tenant code. Per-tenant delegated authorization is outside this release.

Public notification and decision domains provide minimal branded entry pages and
D1-backed `/healthz`. Creating messages/decisions is only available through private
bindings. Public Decisions additionally exposes the recipient capability flow.

## Sender registration is not mailbox creation

Notifications atomically inserts a sender registry entry if absent and otherwise
reuses it. `identity`, `accounts`, and `security` become the corresponding
`@moesegfault.dev` addresses. The domain must already be onboarded to Cloudflare
Email Service; domain authorization allows selecting a local part without creating
a new inbox or modifying DNS for each identity. Sender registration does not promise
that replies are received at that address. Existing Identity uses
`identity@moesegfault.dev`, preserving its established contract.

Native Email Service uses structured send payloads rather than manually constructing
MIME. Hono handles routing, cookies, and request limits; Zod validates the shared
wire boundaries. The three-language branded renderer produces escaped HTML plus
plain text for verification codes, notifications, security alerts, and decisions.

## Durable acceptance and retry semantics

Both services persist the accepted record and its outbox before any downstream call.
Unique `(service,idempotency_key)` records recover lost responses, and keyed HMAC
fingerprints reject changed payloads. AES-GCM encrypts recipients, codes, decision
capabilities, context, and submitted values at rest with record-specific associated
data. The keyed fingerprints avoid exposing an offline oracle for low-entropy OTPs.

Identity marks its encrypted local outbox delivered only when Notifications returns
durable acceptance with an accepted state. It does not retain an independent email
provider binding or renderer. Neither acceptance nor provider message ID proves inbox
receipt. Provider failures remain observable via the private message status API.

Atomic conditional lease claims prevent concurrent drains normally sending the same
job. Notifications retries at most eight attempts until its absolute expiry;
Decisions retries at most twelve attempts with a bounded exponential backoff.
The atomic lease claim returns the authoritative attempt count; queue scans carry
only job IDs so a stale scan cannot reset the budget. An expired final-attempt
lease becomes a terminal `attempts_exhausted` result instead of sending again.
Scheduling remains a simple D1 outbox at this workload instead of introducing a
second queue/state system. Workers may crash after a downstream send and before
recording acknowledgement, so delivery is **at least once**, not exactly once.
Callback consumers must durably deduplicate the stable event ID / `Idempotency-Key`.

Decisions accepts at most seven-day lifetimes, matching Notifications' envelope
horizon. Their sender syntax, single-line title limit, and optional decision body
are aligned so accepted decisions cannot deterministically fail notification
validation. Retention is bounded to 30 days; queued callbacks delay decision cleanup
until their retry policy reaches a terminal state. Outbox encryption-key rotation
requires draining old records and completing caller retries first; this release
does not implement a multi-key envelope/keyring migration.

## Recipient and callback safety

Links contain a cryptographically random 256-bit bearer capability. Only its SHA-256
digest is used for lookup; the replayable original is inside the encrypted record.
Possession authorizes responding, not authenticating as a particular Identity user.
Applications requiring recipient identity verification must add that policy at their
business boundary rather than treating mailbox delivery as user login.

GET is always read-only, including scanner/prefetch visits. A real form requires a
separate explicit confirmation submit. Submission checks exact configured Origin,
a secure HttpOnly host-only SameSite Strict cookie, and an encrypted capability-bound
CSRF proof. D1's unique submission row and one transaction with its callback outbox
arbitrate concurrent confirmations. A conditional update affecting zero rows is not
mistaken for a transaction failure.

The recipient surface uses escaped text, no external scripts/assets, restrictive
CSP, no-referrer, no-store, no framing, and noindex. Automatic invocation logging is
disabled for Decisions so capability paths are not incidentally copied into routine
request logs; explicit structured events retain decision/event IDs and diagnostic
codes without bearer links or form content.

Callbacks are deployment-registered service bindings plus exact approved paths,
associated with the registering service. No caller-supplied hostname, external URL,
redirect following, or DNS resolution enters the callback path. Production starts
with an empty callback registry: adding a service requires a reviewed binding and
registry entry. Staging alone registers the isolated journey fixture.

## Acceptance and operations

`scripts/tests/platform-journey.mjs` exercises actual named entrypoints, real local
D1, sender reuse/creation, provider retry, encrypted retention/erasure, idempotency,
GET non-consumption, cookie/CSRF/Origin rejection, concurrent confirmation, callback
allowlisting, and stable-event callback retry. It is part of the hosted platform
quality gate, rather than requiring a heavyweight local full-suite run.

The manually dispatched `Platform mailbox and browser journey` workflow has two
explicit modes. `http` sends through the native provider, submits the form with
Origin/CSRF/cookie handling, and checks the registered callback; it does not claim a
real browser or inbox receipt. `mailbox` waits for the controlled mailbox recipient
to open the email and submit the form in a real browser. Both require the staging
environment secret `PLATFORM_JOURNEY_RECIPIENT`; no arbitrary/default recipient is
invented. The one-time fixture token is masked, deleted on completion, and the
fixture is returned to an inert binding-only bootstrap. Capability links and email
addresses are not published in workflow summaries.

Deployment order is staging fixture bootstrap, Notifications, Decisions, Identity,
Login, Account. Both new public domains and D1 databases are provisioned through
GitHub Actions. State migration is forward-only; rollback must preserve accepted
outboxes and service bindings needed by the deployed Identity version.

## Engineering and research basis

- [Cloudflare service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
  provide deployment-owned capabilities without runtime shared secrets.
- [Cloudflare Email Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
  provides structured HTML/text messages and observable provider IDs/errors.
- [Email send binding restrictions](https://developers.cloudflare.com/email-service/configuration/send-bindings/)
  and [domain onboarding](https://developers.cloudflare.com/email-service/configuration/domains/)
  are provider prerequisites. A staging arbitrary-recipient check is retained because
  native unrestricted-binding documentation also describes verified-recipient
  restrictions; configuration alone is not evidence of deliverability.
- [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
  supplies the local transaction boundary; constraint violations, not zero-row
  conditional updates, abort the batch.
- [AWS transactional outbox guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
  motivates atomic state/outbox writes and idempotent consumers.
- [Pat Helland, CIDR 2007: Life beyond Distributed Transactions](https://www.cidrdb.org/cidr2007/papers/cidr07p15.pdf)
  supplies the relevant research model: keep an entity's transaction local, and
  coordinate separate authorities with messages and duplicate-aware processing.
  The useful consequence here is an explicit acceptance/acknowledgement boundary,
  rather than a misleading cross-service exactly-once promise.
- [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
  motivates Origin plus token protection rather than relying on SameSite alone.
- [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
  motivates eliminating untrusted callback destinations instead of attempting a
  fragile denylist of private network ranges.
