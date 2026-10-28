# Senders, content, and deadlines

## Sender identity

`sender` and `service` are 1–48-character slugs matching
`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`. Send `accounts`, not
`accounts@moesegfault.dev`. The first accepted message creates the sender registry
row; later messages reuse it, including when another trusted service selects that
identity. `service` owns the idempotency namespace, not a per-sender authorization
boundary. Select both from server-owned configuration, not unchecked browser input.

The From address is `<sender>@moesegfault.dev`, with display name `moeSegFault`.
This does not provision an inbox, password, incoming routing rule, or reply handler.

## Payload fields

Every message requires `service`, `sender`, `to` (one email address, at most 254
characters), and `template`. Unknown fields reject; callers cannot supply raw HTML,
attachments, arbitrary headers, custom From addresses, or a recipient array.

| Template | Additional required fields | Appropriate use |
| --- | --- | --- |
| `verification` | `code` (6–10 ASCII digits), `expires_at` | Mailbox proof or another caller-owned short-lived code |
| `notification` | `title`, `body` | Transactional product updates |
| `security` | `title`, `body` | Account/security changes |
| `decision` | `title`, `action` | Invitation to an existing decision workflow |

Optional fields shared by all templates:

- `locale`: `en` (default), `zh-CN`, or `ja`.
- `subject`, `title`: trimmed, nonempty, at most 160 characters; no CR/LF/NUL.
- `body`: trimmed, nonempty, at most 8,000 characters. Newlines become HTML breaks.
- `action`: `{label, url, expires_at?}`. Label is nonempty, at most 80 characters,
  with no CR/LF/NUL. URL is at most 2,048 characters, HTTPS, without embedded
  credentials. It must lead to a caller-authorized destination; schema acceptance
  does not validate the business authorization of a link.
- `expires_at`: integral, positive Unix seconds; see the two deadlines below.

The platform owns branded HTML, readable text, escaping, and localized structural
copy. It does not translate a caller's custom subject/title/body. Avoid duplicating
the brand wrapper or embedding markup in strings. Verification renders a prominent
code and non-sharing warning. Security uses the same branded layout with its own
localized default heading; it is not a separate delivery transport.

## Two different deadlines

| Field | Meaning | Constraint/display |
| --- | --- | --- |
| Top-level `expires_at` | Last time the notification outbox may attempt delivery | New message must expire after now and within seven days; defaults to one day except verification requires an explicit value |
| `action.expires_at` | Business deadline of the linked action | Optional positive integral Unix seconds, at most `8_640_000_000_000`; may be beyond seven days |

Persist explicit deadlines when creating the business event; never recompute them
on retry. Verification displays the top-level code expiry. Decision emails display
`action.expires_at` as “Respond by”; legacy decision payloads without it display
top-level expiry. Notification/security messages display only an explicit action
deadline (“Link valid until”), not their queue expiry.

For a 90-day decision, keep its action deadline at 90 days but a short delivery
deadline (at most seven days). Prefer having Decisions create the invitation and
its persisted notification envelope; a notification `action` field by itself
does not implement forms, explicit confirmation, or callback registration.

The action-deadline-capable Notifications consumer must precede a producer using
that field. With such messages pending, do not independently downgrade the
consumer or Decisions producer below that feature floor.

Sources: [message schema](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/apps/notifications/src/message.ts),
[template implementation](https://github.com/kleedaisuki/moesegfault-indentity/blob/main/apps/notifications/src/templates.ts).
