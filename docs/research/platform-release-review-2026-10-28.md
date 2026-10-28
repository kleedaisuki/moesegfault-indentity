# Platform release review — 2026-10-28

## Scope and status

Independent source review of the in-progress Notifications/Decisions Workers, their D1
schemas and shared crypto/security utilities, Identity's notification handoff, and
Actions packaging/deployment/cache changes. Review is against the shared working tree,
not a final immutable release SHA. This note does not claim hosted CI or staging delivery.

## Findings sent to owners

### P1: accepted decisions can be permanently unmail-able

`apps/decisions/src/model.ts` and create handling initially accept a 30-day expiry,
200-character titles, optional body, and slug shapes that
`apps/notifications/src/message.ts` / `outbox.ts` reject (seven-day expiry,
160-character titles, required non-verification body, stricter slug).
`apps/decisions/src/outbox.ts` forwards those values unchanged. Such create requests
return 202 with a durable decision, but every notification attempt fails 422;
no user receives its link. Align the caller/receiver accepted domain and test
omitted body, maximum title/expiry, and slug boundaries through the actual binding.
Platform lead acknowledged and is coordinating corrections.

### P1: placeholder D1 UUID prevents first Notifications deployment

`wrangler.notifications.jsonc` initially contains all-zero nonempty database IDs.
`scripts/provision-platform.mjs` correctly treats any nonempty ID as a reviewed pin
and refuses to replace or auto-create a missing pinned database. New Notifications
therefore cannot bootstrap. Use the provisioner's explicit empty/unresolved
representation until deployment discovers the durable database, never treat an
arbitrary mismatched UUID as replaceable. Delivery owner notified.

### P2: Login source cache can misattribute failure receipts

`.github/workflows/ci.yml` caches frontend output by source hash and skips build on
exact hits, while `apps/login/vite.config.ts` embeds `GITHUB_SHA` as
`__LOGIN_BUILD_REVISION__`. A new commit with unchanged Login sources can then ship
an older revision in receipts. Cache validated test results separately from the
cheap revision-sensitive build, or explicitly define a source revision identifier
and retain that distinct contract. Delivery owner notified.

## Assessed invariants

- Public default entrypoints do not route to named private create/send APIs. The
  named entrypoints are deployment capabilities, not publicly bearer-authenticated
  send endpoints.
- Notification sender registration and message enqueue use one D1 batch; sender
  conflict reuses the existing identity and message uniqueness scopes by service/key.
- Notification payloads are authenticated encrypted with per-message additional
  data. Delivery leases condition state updates on a lease token, retries preserve
  the same logical message, terminal records clear ciphertext, and scheduled work
  observes expiry/attempt bounds.
- Identity keeps its original absolute verification expiry and committed outbox ID
  when handing off, with explicit queued/sent acceptance. Existing browser API and
  encrypted local retry boundary are retained.
- Decision GET does not submit. The POST requires exact configured Origin,
  an encrypted expiring CSRF token bound to a host-only Secure HttpOnly Strict
  cookie, validates fields/options, and atomically creates one submission/outbox.
  Unique decision submissions plus transactional rollback protect concurrent POSTs.
- Callback routes must match a deployment-owned service/binding/path registry;
  dispatch goes through that binding with redirects disabled, not arbitrary Internet
  URLs. Consumers receive a stable event ID/idempotency key and must deduplicate:
  delivery is at least once, not exactly once.
- Capability pages have no third-party resources, no-store/no-referrer/noindex,
  restrictive CSP and anti-framing headers. Dynamic values are HTML escaped.
- Release retains staged checksummed artifact promotion, stale-main rejection and
  expand-only schema semantics. Provisioning reuses fixed environment database names
  and rejects unexpected nonempty pins. Rollback does not restore database snapshots.

## Remaining delivery checks

Run the final-SHA hosted workflow, Miniflare binding/D1 journey, actual staging
mail receipt and browser form/explicit-submit/callback journey after corrections.
Preserve staging callback fixture's private entrypoint capability and never expose
unrestricted sending while enabling its test driver. Existing Cloudflare Email
Service send acceptance is not proof of inbox delivery.

## Correction readback

Subsequent source readback confirmed Notifications now uses empty unresolved D1
IDs and Login build runs even on a validated test-cache hit. Decision title length
and slug validation now align, and Notifications decision messages allow omitted
body. A remaining single-line title mismatch (Decisions accepted embedded CR/LF/NUL
while Notifications rejects it) was sent to the platform lead for the same domain
alignment correction. Expiry correction and final journey assertions remain owned
by the platform lead; review this note against the final source before release.
