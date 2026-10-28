---
name: moesegfault-notifications
description: Integrate trusted moeSegFault services with the notification center to send branded transactional email, choose sender identities and templates, or diagnose delivery. Not for personal mail, inbound mailboxes, or browser-driven sending.
---

# moeSegFault Notifications

Use the platform notification center, not a second mail-provider integration.
This skill is portable: its bundled references contain the consumer contract;
no checkout of the platform repository is required.

## Read only what the task needs

- **Connect a service or implement sending:** read [integration](references/integration.md)
  for environment-matched Wrangler bindings and a typed fetch example.
- **Choose content, sender, language, or deadlines:** read [templates](references/templates.md).
- **Investigate delayed mail, retry policy, or a failed receipt:** read
  [operations](references/operations.md). Do not preload operational detail for an ordinary integration.

## Essential boundaries

- Sending uses a Cloudflare Worker service binding named `NOTIFICATIONS` to the
  private **`NotificationsApi`** entrypoint. The public domains expose a landing
  page and health check, not a send API. Do not invent bearer tokens, OAuth
  grants, public proxies, or a direct-provider fallback. For non-Worker callers,
  report the missing transport capability and obtain an explicit platform design.
- This binding grants **all sender identities**, not a per-service permission.
  Provision it only to trusted first-party services; keep recipient, template,
  and sender selection under server-owned business authorization.
- A sender is a lowercase local-part such as `accounts` or `security`; the center
  creates/reuses `<sender>@moesegfault.dev`. It does not create an inbound inbox.
- Persist the business event's idempotency key, message fields, and absolute
  delivery expiry before sending. Retries reuse those values, not a new key or
  a recalculated deadline. Pair staging and production bindings correctly.
- `202` is a durable receipt, not inbox delivery. Inspect its state: a replay
  can already be `failed`. Do not manufacture a new event to hide failure or
  an idempotency conflict; retain the receipt for diagnosis.

For emails collecting decisions or forms, use the Decisions service's registered
workflow and explicit confirmation; merely adding a notification action URL does
not provide callback or single-use decision semantics. Its authoritative
[consumer contract](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/apps/decisions/README.md)
is separate from sending mail.
