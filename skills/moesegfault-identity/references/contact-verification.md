# First-party email verification and incident triage

Use only for Login/Account registration verification, account contact management, and related incidents. A separate product is an OIDC relying party; it must not call these cookie-bound endpoints or treat email verification as a login substitute.

## The authoritative sequence

1. An authenticated Identity session exists. Password or Passkey registration creates a principal and unverified primary email before verification. Account entry can list contacts with `listMyContacts`.
2. Select the current email identifier from the registration account projection or a fresh contact list. The registration account projection names its stable ID `identifier_id`; the contact API's canonical field is `contact_id`. During staggered deployment, older contact responses may contain only the equal-valued legacy `identifier_id`; normalize that alias at the client boundary, then pass the canonical contact ID through verification code. Do not substitute `principal_id`, an email address, or a transaction ID.
3. Call `createContactVerification` on `/v1/me/contacts/{contact_id}/verification-transactions` with the session cookie, `Origin`, `x-moesegfault-csrf`, and `Idempotency-Key`. A `201` returns a `transaction_id`, expiry, and masked delivery hint. It means the database transaction and durable outbox job were accepted, **not** that the inbox received a message.
4. Submit the eight-digit code to `completeContactVerification` at `/v1/me/contacts/{contact_id}/verification-transactions/{transaction_id}/completion`, with the same session/security headers and JSON `{ "code": "12345678" }`. The code here is an example shape, never a test or production value. A successful `200` returns the verified contact.
5. For a resend, start a new transaction when allowed and replace the active `transaction_id`; the old challenge is cancelled. Never retry account registration to resend mail.

The documented endpoint contract is [`../../../openapi/identity.yaml`](../../../openapi/identity.yaml), operation IDs `listMyContacts`, `createContactVerification`, and `completeContactVerification`. The state-machine rationale is [`../../../docs/adr/0004-email-verification.md`](../../../docs/adr/0004-email-verification.md); registration presentation is [`../../../docs/adr/0005-registration-email-avatar-and-anonymous-account.md`](../../../docs/adr/0005-registration-email-avatar-and-anonymous-account.md).

## Diagnose `Contact was not found`

The start handler returns this 404 before generating a code or queuing mail when `contact_id` is not a UUIDv7 or no email/mobile identifier with that ID belongs to the authenticated principal. It can also return it after a concurrent deletion/change. Therefore begin at **ID, session, and ownership**, not the mail provider. The correlation ID identifies the HTTP attempt; it is not a contact ID.

| Observation | Discriminating check | Correct next action |
| --- | --- | --- |
| 404 `Contact was not found` on start | Compare path ID with a fresh `listMyContacts` result under the same session (or the current registration account's email `identifier_id`); inspect whether UI state retained a stale ID after registration, account switch, or delete/recreate | Repair the ID/source-of-truth or session transition; do not resend to an invented ID |
| 401/403 before start | Confirm current authenticated session, paired Login/Account origin, cookie inclusion, and CSRF bootstrap/rotation | Re-bootstrap or sign in; do not broaden CORS or cookie scope |
| 201 but no email | Inspect outbox/drainer/provider acceptance through privacy-safe operational telemetry using correlation and transaction IDs; distinguish accepted job from delivered mail | Retry delivery through the existing bounded outbox path; do not create unbounded new challenges |
| 429 | Read `Retry-After`; the 60-second cooldown and rolling 5-per-hour destination limit are authoritative | Show a countdown and wait rather than looping starts |
| 503 on mobile | Mobile verification delivery is not implemented | Do not present an SMS completion flow |
| Invalid/expired/wrong code | Check active transaction ID, expiry, last resend, and error code without logging the code | Keep the form, allow bounded resend when eligible |

The start handler's ownership query is in [`../../../crates/identity-worker/src/account.rs`](../../../crates/identity-worker/src/account.rs) (`start_contact_verification`). Completion also scopes the transaction by contact and principal. Do not turn a contact-not-found error into a generic provider failure, and do not expose whether another user's contact exists.

## Invariants and tests

- Only email delivery is implemented. The challenge expires after 10 minutes, limits starts per normalized destination, and locks after 10 wrong codes.
- Editing a contact value invalidates the in-flight challenge; deleting it removes its ephemeral verification transaction. Successful verification does not upgrade or rotate the Identity session.
- A new logical start or completion gets a new idempotency key. Retry an uncertain result only with the same key and same payload; never create a fresh challenge merely because the response was lost.
- Two principals may hold the same unverified address; the first successful verification claims uniqueness. Do not infer account identity from unverified email.
- Test the real client sequence with the returned contact ID and transaction ID, plus stale ID, wrong principal, changed/deleted contact, resend, `429`, wrong/expired code, and accepted-but-delayed delivery. Assert no secret code appears in URLs or logs.
