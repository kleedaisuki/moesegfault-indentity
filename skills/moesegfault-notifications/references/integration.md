# Connect a first-party Worker

## Deployment capability

Add the binding to the **calling service's** Wrangler configuration. This example
uses the convention where the default environment is staging; preserve the
caller's own environment layout. Service arrays are not inherited, so repeat the
correct target for production.
Merge these entries with existing service bindings rather than replacing them.

```jsonc
{
  "services": [{
    "binding": "NOTIFICATIONS",
    "service": "moesegfault-notifications-staging",
    "entrypoint": "NotificationsApi"
  }],
  "env": {
    "production": {
      "services": [{
        "binding": "NOTIFICATIONS",
        "service": "moesegfault-notifications",
        "entrypoint": "NotificationsApi"
      }]
    }
  }
}
```

The consumer needs neither an email-provider secret nor the center's database or
encryption key. Generate the caller's Cloudflare runtime types with its existing
Wrangler tooling (`wrangler types`). Never bind a production caller to staging or
replace the named entrypoint with the center's default/public entrypoint.

## Submit a committed verification event

POST JSON to `https://notifications.internal/v1/messages` **through the binding**.
The URL is an internal routing label, not an independently callable public host.
`Idempotency-Key` is required: 1–128 printable ASCII characters, no spaces. Its
namespace is `(service, key)`. An optional correlation ID joins operational traces;
it is not the event identity and may vary between attempts.

The example is one handoff attempt, not an SDK or an unbounded retry loop. Call it
from an existing durable business outbox after committing the challenge and event.
Both `idempotencyKey` and `payload` must survive process restarts unchanged.

```ts
interface Env {
  NOTIFICATIONS: Fetcher;
}

interface VerificationEvent {
  idempotencyKey: string;
  payload: {
    service: "accounts";
    sender: "accounts";
    to: string;
    template: "verification";
    locale: "en" | "zh-CN" | "ja";
    code: string;
    expires_at: number; // Original challenge expiry, integral Unix seconds.
  };
}

type Handoff =
  | { kind: "accepted"; messageId: string; state: "queued" | "sent" }
  | { kind: "terminal"; messageId: string; state: "failed" }
  | { kind: "retry"; reason: string; status?: number; code?: string | undefined; errorType?: string | undefined }
  | { kind: "rejected"; status: number; code?: string | undefined };

async function problemCode(response: Response): Promise<string | undefined> {
  if (!response.headers.get("content-type")?.startsWith("application/problem+json")) return;
  try {
    const value = await response.json() as { code?: unknown } | null;
    return typeof value?.code === "string" && /^[a-z0-9_]{1,80}$/.test(value.code)
      ? value.code : undefined;
  } catch { return; }
}

async function handoff(
  env: Env, event: VerificationEvent, correlationId: string,
): Promise<Handoff> {
  let response: Response;
  try {
    response = await env.NOTIFICATIONS.fetch(
      "https://notifications.internal/v1/messages",
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "idempotency-key": event.idempotencyKey,
          "x-moesegfault-correlation-id": correlationId,
        },
        body: JSON.stringify(event.payload),
      },
    );
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : "UnknownError";
    const errorType = /^[A-Za-z][A-Za-z0-9._]{0,79}$/.test(name) ? name : "UnknownError";
    return { kind: "retry", reason: "transport_uncertain", errorType };
  }
  if (response.status !== 202) {
    const code = await problemCode(response);
    return response.status >= 500 || response.status === 429
      ? { kind: "retry", reason: "center_unavailable", status: response.status, code }
      : { kind: "rejected", status: response.status, code };
  }
  let receipt: { message_id?: unknown; state?: unknown } | null;
  try { receipt = await response.json() as typeof receipt; }
  catch { return { kind: "retry", reason: "receipt_unreadable" }; }
  if (!receipt || typeof receipt.message_id !== "string" || !receipt.message_id) {
    return { kind: "retry", reason: "receipt_invalid" };
  }
  if (receipt.state === "failed") {
    return { kind: "terminal", messageId: receipt.message_id, state: "failed" };
  }
  if (receipt.state !== "queued" && receipt.state !== "sent") {
    return { kind: "retry", reason: "receipt_state_invalid" };
  }
  return { kind: "accepted", messageId: receipt.message_id, state: receipt.state };
}
```

Workers supports `manual` and `follow`, **not** Fetch's `error` redirect mode.
Require exact `202`; do not follow redirects with recipient/code payloads.
Log `operation: "notifications.fetch"`, `reason`, and the returned `errorType`
with the event/correlation IDs. The bounded exception name remains actionable;
raw exception messages and response details are deliberately not returned.

At event creation, choose a server-owned sender/service and recipient from the
authorized operation. For example, persist `service: "accounts"`,
`sender: "accounts"`, `to: "person@example.test"`, `template: "verification"`,
`locale: "en"`, synthetic `code: "01234567"`, and the **committed challenge's**
`expires_at`. The address/code are fixtures, not production targets or credentials.
Generate the event key once from the business event, not inside `handoff`.
Notifications does not generate/compare verification codes: the caller still owns
challenge digests, attempt limits, authorization, and verification completion.

On `accepted`, record the message ID and transfer delivery responsibility. On
`retry`, use the existing bounded outbox/backoff until business expiry; keep the
same event. On `terminal` or `rejected`, preserve the event/envelope and receipt for
diagnosis, stop automatic resubmission, and resolve the cause. A new user-requested
resend is a distinct authorized business event subject to the caller's rate limits.

## Focused acceptance checks

Exercise the actual named binding in staging: first send, same event replay with
the same message ID, changed payload with the same key (`409`), and unavailable
center retaining the caller's durable event. Verify environment pairing and a
received message in a task-owned test mailbox when authorized. A public health
check or a mocked `202` alone does not prove provider acceptance or inbox delivery.

## Authoritative sources

- [Notification service contract](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/apps/notifications/README.md)
- [Current request schema](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/apps/notifications/src/message.ts)
- [Private HTTP handlers](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/apps/notifications/src/index.ts)
- [Cloudflare service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Workers Request and redirect modes](https://developers.cloudflare.com/workers/runtime-apis/request/)
