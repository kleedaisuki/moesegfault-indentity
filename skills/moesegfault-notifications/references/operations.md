# Receipts, retries, and delivery diagnosis

## Interpret the HTTP result

| Result | Meaning and next action |
| --- | --- |
| `202 {message_id,state}` | Durable receipt, including replays. `queued` transfers retry responsibility to the center; `sent` means provider acceptance, not inbox delivery; `failed` is a historical terminal outcome to investigate |
| `400 invalid_idempotency_key` / `invalid_json` | Repair request construction; do not loop |
| `409 idempotency_conflict` | Same `(service,key)`, different normalized payload. Recover the originally committed envelope; do not generate a replacement key merely to bypass it |
| `413 message_too_large` | JSON body exceeds 32 KiB |
| `415 unsupported_media_type` | Send `application/json` |
| `422 invalid_message` / `invalid_expiry` | Fix schema or a new event's delivery window. Replays of retained matching events can still return their original receipt after expiry |
| `503` or uncertain transport | Retain caller outbox; retry the original event with bounded backoff, stopping at business expiry |
| `3xx`, public `404`, unexpected response | Reject, do not follow; check binding target, named entrypoint, environment, and route |

Errors use `application/problem+json` with a machine-readable `code` field. Do not
invent OAuth error fields or rely on prose for automation. Retain bounded status,
code, and operation, not arbitrary `detail` or raw upstream bodies. The successful
response includes `x-moesegfault-correlation-id`; retain the caller's correlation
and event IDs even when a failure response does not include that header.

Read delivery metadata using the **same private named binding**:

```ts
const response = await env.NOTIFICATIONS.fetch(
  `https://notifications.internal/v1/messages/${encodeURIComponent(messageId)}`,
  { method: "GET", redirect: "manual" },
);
// Require 200; 404 is message_not_found, not evidence of successful delivery.
```

The `200` body contains `message_id`, `state` (`queued`, `sending`, `sent`, or
`failed`), `attempt_count`, `last_error_code`, and `provider_message_id`. It never
returns recipient or code. This is an on-demand diagnostic read, not a reason to
poll after every send. Terminal metadata/deduplication records are retained for
30 days from creation, then eligible for cleanup; deduplication is not eternal.

## Locate the failed boundary

1. **Caller → center:** distinguish committed local business event from validated
   `202`; keep exact payload, absolute expiry, and event key stable on uncertainty.
2. **Center → provider:** inspect receipt state and bounded error/provider ID.
   The center owns immediate background delivery plus one-minute scheduled drain,
   conditional leases, at most eight attempts, and bounded backoff.
3. **Provider → inbox:** `sent` is not an inbox guarantee. With an authorized
   task-owned mailbox, inspect receipt, spam/quarantine, and provider diagnostics;
   do not repeatedly create verification challenges to test mail transport.

Provider acceptance followed by process failure before settlement can duplicate
an email. The contract is at-least-once, not provider exactly-once. Design links
and caller-owned verification/decision consumption accordingly.

Log correlation, service, sender, event/message ID, attempt, HTTP status, and
bounded error code. Preserve actionable runtime exception class/reason, especially
unsupported redirect mode or binding failure; do not dump raw requests, recipients,
codes, capability URLs, ciphertext, or keys. Escalate a terminal provider rejection
instead of hiding it with unlimited caller retries or a direct-provider fallback.

Center encryption-key rotation and migration are platform operations, not consumer
onboarding. The current key also fingerprints idempotency: drain old envelopes and
finish old caller retries before rotation. Do not alter a deployed center's secret,
sender registry, or database from a consumer integration task.

Sources: [HTTP error helper](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/packages/service-platform/src/index.ts),
[delivery implementation](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/apps/notifications/src/outbox.ts).
