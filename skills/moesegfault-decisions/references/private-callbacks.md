# Register and consume private callbacks

## Two-sided deployment registration

For the `calendar` example:

1. The caller exports `CalendarDecisionReceiver` as a named `WorkerEntrypoint`.
   Its existing default public router must not expose this callback path.
2. The Decisions operator adds a binding to that entrypoint and merges the
   matching service/path registration into `CALLBACK_SERVICES`.
3. The caller sends exactly `service: "calendar"` and
   `callback: {binding: "CALENDAR_CALLBACK", path: "/v1/decision-results"}`.

These additions belong to the **Decisions operator's** configuration, not merely
the caller's outgoing `DECISIONS` binding:

```jsonc
{
  "services": [{
    "binding": "CALENDAR_CALLBACK",
    "service": "calendar-staging",
    "entrypoint": "CalendarDecisionReceiver"
  }],
  "vars": {
    "CALLBACK_SERVICES": "{\"calendar\":{\"binding\":\"CALENDAR_CALLBACK\",\"paths\":[\"/v1/decision-results\"]}}"
  },
  "env": {
    "production": {
      "services": [{
        "binding": "CALENDAR_CALLBACK",
        "service": "calendar",
        "entrypoint": "CalendarDecisionReceiver"
      }],
      "vars": {
        "CALLBACK_SERVICES": "{\"calendar\":{\"binding\":\"CALENDAR_CALLBACK\",\"paths\":[\"/v1/decision-results\"]}}"
      }
    }
  }
}
```

These are **merge fragments**: retain existing notification bindings, other
callback bindings, and other entries in the JSON registry. Service-binding arrays
and variables must be explicitly paired for each environment. The platform's
production registry starts empty; a built receiver or configuration suggestion is
not evidence of deployed registration. The operator deploys the receiver before
activating its registration. Ordinary callers cannot self-register over HTTP.

There is no arbitrary Internet callback URL, callback DNS lookup, redirect
following, bearer-token provisioning endpoint, or human OAuth login in this flow.
The named binding is the capability. Do not add a public webhook as a workaround.

## Event contract

The receiver gets a JSON `POST` to its registered exact path:

```json
{
  "event_id": "stable-event-id",
  "type": "decision.submitted",
  "decision_id": "original-decision-id",
  "service": "calendar",
  "submitted_at": 1793170800,
  "response": {"choice":"approve","fields":{"note":"Confirmed"}},
  "context": {"request_id":"local-pending-request-id"}
}
```

`Idempotency-Key` and `x-moesegfault-event-id` both equal `event_id`.
`x-moesegfault-correlation-id` carries the decision ID. `response.choice` exists
only when choices were requested; `response.fields` contains typed submitted
values. Validate the response against **this service's requested form**, not just
against a generic JSON object. Bind the decision ID and context ID to the local
pending operation; context alone is not authorization.

The service must independently authorize the resulting business action. A mailbox
capability is not an authenticated account, recent login, or step-up proof. Do not
turn an `approve` answer directly into a privileged action that needed stronger
authorization. Put any additional authenticated approval in the business flow.

## Atomic receipt and local effect: D1 example

This example applies the simple meeting choice from the creation reference. It
assumes a local pending record already exists and its returned `decision_id` is
saved. A nullable decision ID permits preparing the local record before the
platform call; callbacks arriving before mapping completion fail retryably.

```sql
CREATE TABLE calendar_approvals (
  request_id TEXT PRIMARY KEY,
  decision_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied')),
  note TEXT,
  UNIQUE (request_id, decision_id)
);

CREATE TABLE calendar_decision_receipts (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  decision_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  FOREIGN KEY (request_id, decision_id)
    REFERENCES calendar_approvals(request_id, decision_id)
);

CREATE TRIGGER calendar_receipt_requires_pending
BEFORE INSERT ON calendar_decision_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM calendar_approvals
  WHERE request_id = NEW.request_id
    AND decision_id = NEW.decision_id
    AND state = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'decision_not_ready');
END;
```

Use the target project's generated Workers types and mature schema validator.
Keep the existing application public handler unchanged; add this named export:

```ts
import {WorkerEntrypoint} from "cloudflare:workers";
import {z} from "zod";

interface Env {DB: D1Database}
interface Receipt {payload_hash: string}
const eventSchema = z.object({
  event_id: z.string().min(1).max(128),
  type: z.literal("decision.submitted"),
  decision_id: z.string().min(1).max(128),
  service: z.literal("calendar"),
  submitted_at: z.number().int().positive(),
  response: z.object({
    choice: z.enum(["approve", "deny"]),
    fields: z.object({note: z.string().max(4000).optional()}),
  }),
  context: z.object({request_id: z.string().min(1).max(128)}),
});

function receipt(db: D1Database, id: string): Promise<Receipt | null> {
  return db.prepare("SELECT payload_hash FROM calendar_decision_receipts WHERE event_id=?")
    .bind(id).first<Receipt>();
}

function replay(existing: Receipt, hash: string): Response {
  return new Response(null, {status: existing.payload_hash === hash ? 204 : 409});
}

export class CalendarDecisionReceiver extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/decision-results") {
      return new Response(null, {status: 404});
    }
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      return new Response(null, {status: 415});
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 65536) return new Response(null, {status: 413});
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return new Response(null, {status: 400}); }
    const result = eventSchema.safeParse(parsed);
    if (!result.success) return new Response(null, {status: 422});
    const event = result.data;
    if (request.headers.get("idempotency-key") !== event.event_id
      || request.headers.get("x-moesegfault-event-id") !== event.event_id) {
      return new Response(null, {status: 400});
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(event)));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const existing = await receipt(this.env.DB, event.event_id);
    if (existing) return replay(existing, hash);
    try {
      await this.env.DB.batch([
        this.env.DB.prepare("INSERT INTO calendar_decision_receipts(event_id,request_id,decision_id,payload_hash) VALUES(?,?,?,?)")
          .bind(event.event_id, event.context.request_id, event.decision_id, hash),
        this.env.DB.prepare("UPDATE calendar_approvals SET state=?,note=? WHERE request_id=? AND decision_id=?")
          .bind(event.response.choice === "approve" ? "approved" : "denied",
            event.response.fields.note ?? null, event.context.request_id, event.decision_id),
      ]);
    } catch (error) {
      const raced = await receipt(this.env.DB, event.event_id);
      if (raced) return replay(raced, hash);
      throw error;
    }
    return new Response(null, {status: 204});
  }
}
```

The unique receipt insert is the concurrency claim. It is **not** `INSERT OR
IGNORE` followed by an unconditional business update: a duplicate must abort the
batch so its effect cannot execute again. The foreign key binds both operation
and decision IDs. The trigger fails if the business operation is not ready or no
longer pending. D1 batch rollback then leaves neither a consumed receipt nor a
partially applied effect. A zero-row `UPDATE` alone would not abort a D1 batch.
Concurrent identical callbacks re-read the winning committed receipt and return
204; the same event ID with different validated content returns 409.

Genuine mapping/database failures are not acknowledgements. The example rethrows
them for normal Worker error reporting and retryable binding failure; retain
bounded safe error diagnostics with event/decision IDs, not form values. Recover
the caller's durable creation operation and mapping promptly: callback retries
are bounded. For external side effects, insert a local business outbox command in
the **same** receipt transaction, then deliver it idempotently; an HTTP side
effect cannot be made atomic by placing it between these SQL statements.

Keep the private receiver, its registration, and its receipt storage available for
outstanding decisions even when a test driver or public UI is stopped. Dedup
receipts must cover the service's retry/operator-replay horizon, not a short CI
wait or an arbitrary one-day prune.

Maintainer source navigation: [registration model](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/apps/decisions/src/model.ts),
[outbox dispatcher](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/apps/decisions/src/outbox.ts).
Platform behavior: [Cloudflare D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
