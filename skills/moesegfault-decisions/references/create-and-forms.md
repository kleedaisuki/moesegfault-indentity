# Create decisions and forms

## Caller binding

The calling Cloudflare Worker needs a service binding. No platform bearer secret,
browser session, or invented machine OAuth grant is involved. A binding grants
trusted first-party platform authority; do not expose it to untrusted tenant code.

```jsonc
{
  "name": "calendar-staging",
  "services": [{
    "binding": "DECISIONS",
    "service": "moesegfault-decisions-staging",
    "entrypoint": "DecisionsApi"
  }],
  "env": {
    "production": {
      "name": "calendar",
      "services": [{
        "binding": "DECISIONS",
        "service": "moesegfault-decisions",
        "entrypoint": "DecisionsApi"
      }]
    }
  }
}
```

Workers named environments do not inherit service bindings. Declare each one.
The internal fetch URL below is a routing label, not a public API to call with
ordinary Internet fetch. Public recipient origins are
`https://decisions-staging.moesegfault.dev` and
`https://decisions.moesegfault.dev` respectively.

## Request and durable caller operation

Private `POST /v1/decisions` requires `Content-Type: application/json` and an
`Idempotency-Key` of 1–128 printable non-space ASCII characters. Persist the key
and serialized body in your business operation/outbox **before** the first call.
An uncertain response is not permission to generate another key or deadline.

```ts
const body = JSON.stringify({
  service: "calendar",
  sender: "calendar",
  to: recipientEmail,
  title: "Confirm this meeting?",
  locale: "en",
  choices: [
    {value: "approve", label: "Confirm"},
    {value: "deny", label: "Decline"},
  ],
  fields: [{name: "note", label: "Note", type: "textarea"}],
  callback: {binding: "CALENDAR_CALLBACK", path: "/v1/decision-results"},
  context: {request_id: pendingRequestId},
});
// Save body and operationKey in this service's durable operation/outbox.
```

`calendar`, the sender, binding name, callback path, and business table names in
these examples are concrete onboarding examples, not existing registrations.
Register them using [the callback reference](private-callbacks.md).

Use the target repository's generated Workers types and existing validator. This
minimal example uses Zod for the returned boundary; it is not a new SDK:

```ts
import {z} from "zod";

const acceptedSchema = z.object({
  decision_id: z.string().min(1),
  state: z.enum(["pending", "submitted", "expired"]),
  url: z.url(),
  expires_at: z.number().int().positive(),
});
type AcceptedDecision = z.infer<typeof acceptedSchema>;
interface DecisionOperation {key: string; body: string}

async function createDecision(
  env: {DECISIONS: Fetcher},
  operation: DecisionOperation,
): Promise<AcceptedDecision> {
  const response = await env.DECISIONS.fetch(
    "https://decisions.internal/v1/decisions",
    {
      method: "POST",
      redirect: "manual",
      headers: {"Content-Type": "application/json", "Idempotency-Key": operation.key},
      body: operation.body,
    },
  );
  if (response.status !== 202) {
    const correlation = response.headers.get("x-moesegfault-correlation-id");
    throw new Error(`Decision creation HTTP ${response.status}; correlation=${correlation ?? "unavailable"}`);
  }
  return acceptedSchema.parse(await response.json());
}
```

Do not follow redirects carrying recipient/context data: Workers supports
`redirect: "manual"` (not `"error"`), and the exact-202 check rejects redirects.

Save the returned `decision_id` on the pending local operation. If that save or
the response is lost, replay the same durable request to recover the same ID/link.
The email can arrive before this local save completes: the receiver must return a
retryable failure until its local decision mapping is ready, never acknowledge and
drop that event. Do not log the returned capability URL, recipient, or form data.

## Wire contract

Requests are strict objects, bounded to 64 KiB. Unknown request properties reject.

| Property | Contract |
| --- | --- |
| `service`, `sender` | Lowercase slugs, max 48 characters; `[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*`. Sender becomes `sender@moesegfault.dev`; Notifications reuses/creates its registry entry. This does not provision a reply inbox. |
| `to` | One valid email address, max 254 characters. |
| `title` | Required nonempty single line, max 160; no CR/LF/NUL. |
| `body` | Optional nonempty plain text, max 4,000 characters. Not caller HTML. |
| `locale` | `en` (default), `zh-CN`, or `ja`. |
| `expires_at` | Optional positive integer Unix **seconds**; see deadlines below. |
| `choices` | Optional 1–20 `{value,label}` entries; values max 120, labels max 160; values must be unique. |
| `fields` | Optional 1–20 field definitions; names unique. |
| `callback` | Required `{binding,path}`; must match deployment registration exactly. |
| `context` | Optional JSON object echoed in the callback. Use opaque local operation IDs; it is not authorization by itself. |

At least one of `choices` or `fields` is required. When choices exist, the user
must select a declared choice. Field names match `[a-z][a-z0-9_]{0,47}`;
`csrf` and `choice` are reserved. Every field needs `name`, `label` (max 160), and
`type`; `required` defaults to false.

| Field type | Submission behavior |
| --- | --- |
| `text`, `textarea` | Trimmed string, max 4,000 characters. |
| `email` | Valid email string. |
| `number` | Finite JSON number, not the original string. |
| `checkbox` | JSON boolean; required means it must be checked. |
| `select` | Requires 1–30 `{value,label}` options; submitted value must match one. |

Optional blank non-checkbox fields are omitted. Duplicate submitted fields,
undeclared fields, unknown choices/options and missing required values reject.

## Deadlines and idempotency

- Omit `expires_at` for a seven-day business deadline resolved once at creation.
  Replaying an omitted value does not renew the capability.
- Explicit future deadlines support 30/90/365 days. The default deployment-owned
  ceiling is 365 days from creation, set by `MAX_DECISION_LIFETIME_SECONDS=31536000`.
  Operators can raise it for a reviewed need. An individual caller cannot override
  that platform setting. Expired links never auto-extend.
- Calculate an explicit deadline once and persist it with the request. Do not use
  a fresh `Date.now()` on each retry, or change omission into an explicit value
  under the same key. Different validated payloads produce `409 idempotency_conflict`.
- The email delivery envelope lasts at most seven days, independently of the
  decision deadline and independently of retry attempt budgets. Decisions stores
  the immutable notification request; email `action.expires_at` displays the real
  response deadline, not the queue expiry.

`202` returns `{decision_id,state,url,expires_at}`. Replay may return a submitted
or expired state with the original URL; it is not a new invitation or renewed grant.
Other useful failures are `400` malformed JSON/key, `403 callback_not_registered`,
`422 invalid_decision`/`invalid_expiry`, `409 idempotency_conflict`, and retryable
`503`. Retain safe machine error codes, status and correlation IDs for diagnosis;
never retry a deterministic invalid request by changing its key.

Maintainer source navigation: [request model](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/apps/decisions/src/model.ts),
[handlers](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/apps/decisions/src/app.ts),
[immutable invitation](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/apps/decisions/src/invitation.ts).
