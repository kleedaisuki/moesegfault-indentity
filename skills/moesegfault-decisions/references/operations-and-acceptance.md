# Operations and real-user acceptance

## Evidence boundaries

| Observation | What it establishes |
| --- | --- |
| Creation `202` | The decision and invitation outbox were durably accepted; replay recovers the original link. |
| Decision delivery kind `notification`, state `delivered` | Invitation work finished. For a still-pending, unexpired decision, Notifications accepted it; already submitted/expired decisions can skip an unsent invitation. Not inbox evidence. |
| Notifications message state `sent` | Native email provider accepted it; this still does not prove inbox placement. |
| Message found in the controlled inbox | Actual recipient delivery for this test. |
| Callback received and atomically applied | The response returned to the owner and its local effect committed. |

Private `GET /v1/decisions/{decision_id}` through `DecisionsApi` returns
`decision_id`, `service`, `state`, `expires_at`, `submitted_at`, and
`deliveries: [{kind,state,attempts,last_error_code}]`. Decision states are
`pending`, `submitted`, `expired`; delivery kinds are `notification` and
`callback`, with `queued`, `delivered`, `failed` states. Response values,
recipient addresses, and capabilities are deliberately absent from this status.
Public `/healthz` proves neither callback registration nor mail deliverability.

## Proportionate acceptance journey

Use an authorized staging environment and a controlled recipient. Make a harmless
test operation, not an actual financial/security approval. Reuse the operation key
if a network response is lost; do not retry an unknown outcome as a fresh action.

1. Confirm both private bindings and exact callback registration are deployed.
   Missing registration returns `403 callback_not_registered`, not an OAuth error.
2. Create a choice plus a small form; persist the returned decision ID locally.
   Confirm replay returns the same link/deadline and changed intent conflicts.
3. Wait for invitation acceptance before completing an automated test: submitting
   first can correctly suppress an invitation for an already submitted decision.
4. Find the invitation in the controlled mailbox. Check sender identity, readable
   HTML/text and the **business** response deadline. Queue expiry is not a label
   saying that an informational/security email stops being meaningful then.
5. Open the received link in a real browser. Merely viewing, choosing and typing
   must leave the operation pending. Activate the separate confirmation button.
6. Observe the automatic POST/Redirect/GET completion page, one local committed
   receipt/effect, and an identical callback replay with no additional effect.

Also exercise unregistered callbacks, expired links, duplicate/conflicting event
IDs, a mapping not yet saved, and a failed local transaction. Rollback must leave
no receipt, so a later retry can still apply the effect. A Node request with a
manually supplied Origin is useful HTTP coverage but is **not** browser acceptance.

## Browser boundaries

The platform uses `Referrer-Policy: strict-origin`: native form POSTs retain their
real Origin while Referer excludes the capability path. `no-referrer` instead
causes `Origin: null` for native navigation POSTs under the Fetch standard.
Do not "fix" a failure by accepting null Origin, disabling CSRF, manually adding
browser authentication headers, or replacing explicit submission with a GET.
The browser must retain its Secure/HttpOnly host-only SameSite Strict cookie and
the platform's capability-bound CSRF proof.

For automated Chromium regression, use the target project's browser tooling and a
real HTTPS test listener backed by actual handlers/storage. Keep isolated test
certificate trust scoped to that test context. Redirect interception can hide or
break real navigation; assert the automatic completion GET rather than forcing a
second `goto`. Prefer hosted CI for browser installation and cache its pinned
runtime. Do not download browsers locally merely to run every integration check.

## Recovery and lifecycle

- Decisions drains every minute, caps callback requests at 15 seconds, and permits
  at most twelve delivery attempts with bounded backoff. Its seven-day default
  link duration and email delivery window are not guarantees of seven days of
  retrying. Notifications has its own separate attempt budget.
- On failure, preserve operation/event/message keys. Inspect status, the error
  code and correlation IDs; distinguish registration, validation, provider and
  receiver failures. Do not log bearer URLs, mailbox contents, form data or codes.
- A callback can still arrive after a CI wait ends. Disable the public test driver
  and sending capability if appropriate, but retain the private receiver binding
  and durable receipt store for outstanding links. A test timeout neither expires
  a decision nor authorizes extending an expired one.
- Avoid independent downgrades below the snapshot/action-deadline feature floor:
  old Notifications rejects `action.expires_at`, while old Decisions regenerates
  retry JSON. Keep both compatible with accepted new envelopes; prefer rolling
  forward. Ordinary new deployments still accept retained legacy jobs.
- Provisioning registrations, changing platform ceilings, sending live emails and
  production deployment require the task's actual authorization. A copied skill
  grants none of those permissions and does not provision resources or secrets.

Maintainer source navigation: [Decisions implementation](https://github.com/kleedaisuki/moesegfault-indentity/tree/main/apps/decisions),
[hosted journey driver](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/scripts/platform-journey.mjs).
Browser semantics: [Fetch Origin algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header).
