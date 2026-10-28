# moeSegFault Notifications

One domain, reusable sender identities, and one transactional-email design.
Public HTTP exposes only `/` and `/healthz`. Sending is a deployment capability:
bind a first-party Worker to the named `NotificationsApi` entrypoint, never to
the public Worker URL. No human access token or newly invented OAuth grant is used.

## Send

```json
{
  "service": "identity",
  "sender": "identity",
  "to": "person@example.com",
  "template": "verification",
  "locale": "en",
  "code": "12345678",
  "expires_at": 1793180000
}
```

POST this JSON to `/v1/messages` over the service binding with
`Idempotency-Key: <stable-business-event-id>` and optionally
`x-moesegfault-correlation-id`. The response is `202`:
`{"message_id":"...","state":"queued"}`. A replay returns the same ID/state;
reusing the key with a different normalized payload returns `409`. Keep retries
byte-semantically equivalent (especially expiry), not a fresh event per attempt.
`GET /v1/messages/:id` on that same private entrypoint returns delivery metadata,
including provider message ID and bounded error code, never the recipient/code.

`sender` is a lowercase local-part, not an arbitrary address. The first accepted
message creates the sender registry row; later messages reuse it. The address is
always `<sender>@moesegfault.dev`. This is an outbound identity, not an inbox:
Cloudflare Email Service authorizes the onboarded domain and needs no per-address
mailbox creation. Incoming mail routing is a separate capability.

The private binding grants access to all notification sender identities. Provision
it only to trusted moeSegFault services; do not expose a transparent browser proxy.
Production and staging must bind to their corresponding platform Workers.

## Templates

| Template | Required additional fields | Purpose |
| --- | --- | --- |
| `verification` | `code` (6–10 digits), `expires_at` | Short-lived verification codes |
| `notification` | `title`, `body` | General transactional updates |
| `security` | `title`, `body` | Security/account changes |
| `decision` | `title`, `action` | Decisions link invitation (`body` optional) |

All templates support `en`, `zh-CN`, and `ja` (`en` by default), optional
`subject`, `title`, `body`, and `action: {label,url}`. URLs must be HTTPS without
embedded credentials. Text is escaped, never treated as caller HTML. Emails use
an inline-styled responsive presentation table, readable plain text, no remote
fonts or images, and the same warm moeSegFault palette as Account. Every
verification email includes an explicit non-sharing warning. `expires_at` is
Unix seconds and must be in the next seven days; default TTL is one day.

## Persistence and delivery

- Dedicated D1 database and forward-only `migrations/notifications` stream.
- `OUTBOX_KEY`: base64 encoding of exactly 32 cryptographically random bytes,
  stored only in Worker secrets. AES-GCM payloads bind ciphertext to message ID.
  Domain-separated HMAC-SHA256 idempotency fingerprints prevent offline guessing
  of short verification codes from a database-only disclosure.
- D1 commit precedes provider I/O. Immediate background delivery plus a one-minute
  cron drain share conditional 90-second leases. At most eight attempts, bounded
  exponential backoff, expiry, and permanent-provider-error terminalization.
- Accepted provider sends are `sent`, not proof of inbox delivery. Delivery is
  at-least-once: a crash between provider acceptance and D1 settlement can duplicate
  an email. Business-event idempotency prevents duplicates from caller retries,
  but does not promise provider exactly-once delivery.
- Terminal rows erase encrypted message payloads; non-sensitive delivery metadata
  and deduplication keys remain for 30 days. Sender registry rows are retained.
- Logs include correlation, service, sender, message ID, attempt, and provider error
  code/message ID. Raw recipients, codes, ciphertext, and secret keys are excluded.

On key rotation, drain/terminalize pending mail before replacing `OUTBOX_KEY`.
Retain the previous secret outside the database until no old encrypted rows remain.
The current fixed envelope deliberately does not add multi-key machinery.
Idempotency fingerprints also depend on this key: finish caller retries before
rotation, because replaying an old key after rotation returns an idempotency conflict.

## Upstream references

- [Cloudflare structured Email Sending API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Email domain authorization](https://developers.cloudflare.com/email-service/configuration/domains/)
- [Send-binding restrictions](https://developers.cloudflare.com/email-service/configuration/send-bindings/)
- [Worker named entrypoints and service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [D1 batch transaction behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/)
