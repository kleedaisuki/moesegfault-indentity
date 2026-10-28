# moeSegFault Decisions

Decision links collect an explicit confirmed choice or form response, then deliver a
durable event to the registered owning service. The public Worker never accepts
decision-creation requests. First-party callers bind the named `DecisionsApi`
entrypoint; this is a deployment-owned capability, not a human Identity session.

## Create a decision

Bind `DECISIONS` to `moesegfault-decisions` (`moesegfault-decisions-staging` in
staging), entrypoint `DecisionsApi`, then send:

```ts
await env.DECISIONS.fetch("https://decisions.internal/v1/decisions", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Idempotency-Key": eventId },
  body: JSON.stringify({
    service: "accounts",
    sender: "accounts",
    to: "person@example.com",
    title: "Approve this account change?",
    body: "Review this request before submitting your response.",
    locale: "en",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    choices: [
      { value: "approve", label: "Approve" },
      { value: "deny", label: "Deny" },
    ],
    fields: [{ name: "note", label: "Note", type: "textarea" }],
    callback: { binding: "ACCOUNTS_CALLBACK", path: "/v1/decision-results" },
    context: { request_id: "business-request-id" },
  }),
});
```

Accepted response: HTTP `202` with `{decision_id,state,url,expires_at}`. Replaying
the same service/idempotency key and validated payload returns the original link;
a different payload returns `409 idempotency_conflict`. Keep `expires_at` stable
across retries. New requests expire within seven days. The title is single-line,
at most 160 characters. `service` and `sender` are lowercase slugs of at most 48
characters; separators `.`, `_`, and `-` may only separate alphanumeric segments.

At least one choice or field is required. Fields support `text`, `textarea`,
`email`, `number`, `checkbox`, and `select`. Select fields require `options` with
`{value,label}` pairs. Names and option values must be unique. The names `csrf`
and `choice` are reserved. Responses reject undeclared fields, duplicate values,
unknown choices/options, missing required values, malformed emails, and non-finite
numbers. Optional blank fields are omitted; checkboxes produce booleans and number
fields produce finite JSON numbers. Requests and responses are bounded to 64 KiB.

## Register the callback capability

The operator adds a Fetcher service binding to the Decisions Worker and declares
its exact owning service and permitted paths in `CALLBACK_SERVICES`:

```json
{"accounts":{"binding":"ACCOUNTS_CALLBACK","paths":["/v1/decision-results"]}}
```

The target service should expose its receiver as a named private entrypoint.
Do not accept this callback over an unauthenticated public endpoint. Callback
URLs, redirects, arbitrary hosts and unregistered binding/path combinations are
not accepted. Production starts with an empty registry; deployments explicitly
onboard each consuming microservice. Staging includes only the isolated journey
fixture registration.

Callback `POST` payload:

```json
{
  "event_id": "opaque-stable-event-id",
  "type": "decision.submitted",
  "decision_id": "opaque-decision-id",
  "service": "accounts",
  "submitted_at": 1793170800,
  "response": {"choice":"approve","fields":{"note":"Reviewed"}},
  "context": {"request_id":"business-request-id"}
}
```

`Idempotency-Key` and `x-moesegfault-event-id` both carry the stable `event_id`.
Delivery is **at least once**: the receiver must atomically deduplicate that ID
with its business mutation and return a successful HTTP status on replay. The
correlation header carries the decision ID. Redirects are not followed. Callback
requests have a 15-second timeout; failures retry with exponential backoff up to
twelve attempts, then remain visible as failed delivery metadata.

Private `GET /v1/decisions/:id` returns decision metadata and per-kind delivery
state, attempt count and last error code. It deliberately does not return response
contents, recipient addresses or capability tokens. Operators may requeue a
failed outbox record after fixing the cause; preserve the original event ID.

## State, security and failure semantics

Each decision, original token and request context is encrypted in dedicated D1
using AES-256-GCM with a per-record associated-data binding. Capability lookup
stores a SHA-256 digest of a 256-bit random token, never the plaintext token.
`OUTBOX_KEY` is a base64-encoded random 32-byte Worker secret. Preserve it when
redeploying; rotation requires explicit re-encryption of retained records.

Creation atomically writes the decision and notification outbox. Email dispatch
uses the Notifications service's branded decision template and stable idempotency
key. A notification outage creates backlog instead of losing the accepted request.
Expired decisions are not mailed. Notification acceptance means queued by the
notification center, not proof of final inbox placement.

`GET /d/:token` never consumes or submits a decision: link scanners are harmless.
The page renders an explicit **Confirm and submit** button, with no auto-submit
behavior and no external scripts, fonts or assets. Submission requires the exact
configured Origin, a host-only Secure/HttpOnly/SameSite=Strict cookie, and an
encrypted capability-bound expiring CSRF proof. The decision, unique submission
claim and callback outbox are committed in one D1 batch. Concurrent submissions
cannot create multiple responses or callback events.

The link is a bearer capability: anyone with it may respond before it expires.
Owning services must not interpret mailbox-link possession as a recent Identity
login or MFA proof. Confidential/high-impact operations should obtain any
additional authentication in their own service before acting on the event.

Public pages are `no-store`, `no-referrer`, `noindex`, frame-denied and have a
restrictive Content Security Policy. Default invocation logs are disabled to
avoid copying capability URLs; structured events retain decision, event, service,
correlation and delivery-error IDs without response content. Application logs do
not contain capability tokens or form values.

Cron drains queued deliveries every minute and marks expired pending decisions.
Rows are retained for thirty days after expiry, unless queued work still exists;
then cascade deletion removes response and outbox records. No Identity schema is
shared. `GET /healthz` probes D1 and does not depend on an encryption secret.

## Verification and references

Run `npm run typecheck --workspace=@moesegfault/decisions` and
`npm run test --workspace=@moesegfault/decisions`. The platform journey harness
exercises named service bindings, real D1 commits, email acceptance, browser
confirmation, replay and callback delivery in staging.

- [Cloudflare service binding capabilities](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [D1 batch transaction API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
