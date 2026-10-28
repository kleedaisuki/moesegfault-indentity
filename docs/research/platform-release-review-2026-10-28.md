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

Integration readback at `9ac2f89` confirms the title/control-character and sender
slug rules align. Decisions and their invitation delivery share a seven-day
maximum lifetime; accepted decisions no longer fall outside the notification
contract. The real named-binding/D1 journey passes
with the actual staging callback receiver, including a body-less invitation,
single consumption under concurrent submissions, and stable-event retry.

## Hosted advisory remediation follow-up

Hosted first-run advisory failure identified `RUSTSEC-2026-0387` in the old
`crypto-bigint 0.5.5` transitive P-256 dependency. Independent upstream advisory
readback confirms patched versions are `>=0.7.6`; the proposed stable `0.7.10`
therefore addresses the reported advisory without an ignore-list exception.
See [RustSec advisory](https://rustsec.org/advisories/RUSTSEC-2026-0387.html).

Reviewed in-progress vendor migration: `p256 0.14.0`, `elliptic-curve 0.14.3`,
`crypto-bigint 0.7.10`, and `x509-cert 0.3`/`const-oid 0.10` trait-family alignment.
The installed primary-source crate manifests declare Rust 1.85 for P-256/X509 and
1.87 for elliptic-curve/crypto-bigint, within repository Rust 1.88. Runtime P-256
has defaults disabled and enables `ecdsa,alloc`; native test RNG is separate.

The persisted COSE X/Y byte representation, SEC1 uncompressed point construction,
DER signature parsing and SHA-256 digest remain unchanged. Public-key conversion
still rejects invalid points. Signature trait 2 (Ed25519) and trait 3 (P-256)
imports are explicit and separate. Upstream `p256 0.14.0/src/ecdsa.rs` sets
`NistP256::NORMALIZE_S=false`, preserving both high-S and low-S acceptance; the
new static legacy fixture is being added by the owner to guard that contract.
No source-level credential compatibility blocker found in these production edits.
Actual native/WASM compile and fixed legacy/attestation tests remain hosted gates,
not implied by this source review.

Also reviewed `a0bb1bf` Decisions retry repair: scans pass only job IDs, the atomic
claim returns the authoritative incremented attempt and enforces `<12`, settlement
matches its unique lease, and exhausted crashed leases become terminal only after
lease expiry. This addresses stale-scan extra-attempt behavior without interrupting
an active final attempt. No actionable regression found in that bounded diff.

## Native form Origin hotfix — ace4cba

Focused independent review found no actionable security or test-validity blocker.
The [WHATWG Fetch Origin-header algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header)
explicitly serializes non-CORS native POST origins as `null` under `no-referrer`.
Using `strict-origin` preserves the HTTPS same-origin native POST Origin while
limiting Referer to scheme/host/port, never the capability path or query. HTTPS
transport downgrade still suppresses the origin/referrer; the implementation does
not accept `Origin:null`, weaken exact-origin validation, change CSRF cookies or
relax CSP. The shared policy change is broader than a single page but has no
capability-path disclosure: Notifications/Decisions retain no-store, noindex,
anti-framing and restrictive resource policies.

The Chromium regression consumes actual Worker HTML and browser-managed Secure,
HttpOnly, Strict host cookies. It clicks radio/text controls then the separate
submit button, forwards browser-computed headers/body without injecting Origin
or Cookie, and reaches actual Miniflare D1 plus registered callback persistence.
The legacy response-policy-only override is a useful negative control: the same
native browser request must fail 403 with `Origin:null` and leave the decision
pending. The corrected case asserts origin-only Referer, 303 redirect, completion
heading, one persisted consumption and callback event identity. This is materially
stronger than manually supplying Origin in an HTTP test. Route interception still
does not test live Cloudflare DNS/TLS/edge configuration; retain the real staging
in-app browser submit/callback acceptance gate.

CI restores pinned Playwright-version Chromium binaries, always installs system
dependencies, saves browser files only after successful installation and before
assertions, then runs the native journey. Installation cache cannot turn failed
browser assertions into a successful job. OS key is sufficient for the current
fixed ubuntu-24.04/x64 runner; no local browser installation was performed during
this source review. Hosted Chromium completion remains a separate run result.

## Long-lived decision lifecycle candidate (working tree)

Focused review of optional/default business deadlines, immutable invitation
snapshots and DB-only staging callback cleanup found no actionable blocker.
New create requests fingerprint the parsed caller request before resolving a
missing deadline, and lookup/replay precedes current lifetime-policy validation;
therefore omitted-deadline retries retain the original expiry and valid old
records are not shortened by later policy changes. Explicit legacy expiry keeps
the existing schema field order/HMAC serialization. The encrypted snapshot owns
its notification delivery deadline, original URL and action deadline; the caller
cannot supply that snapshot because the request schema is strict. The legacy
adapter retains the exact pre-snapshot envelope/property order with no added
`action.expires_at`, allowing the receiver's accepted message key to replay.

The default business deadline is seven days, configurable admission ceiling is
365 days, and new snapshots cap mail delivery at creation plus seven days while
showing the independent action deadline in the email. Expiry uses integer Unix
seconds; the schema's 8,640,000,000,000-second maximum maps to JavaScript Date's
8.64e15-millisecond inclusive bound. Normal admission ceilings also reject common
millisecond mistakes. Existing payloads/deadlines are not migrated or rewritten.

Cleanup now retains only the private CallbackReceiver's DB binding; public
send/status controls lose their notification/decision bindings and one-time
credential. Removing the former one-day callback-receipt deletion avoids making
late callback retries conflict with the unique decision receipt. The caller's
CI observation timeout reports failure without expiring the business decision or
removing its callback consumer. Actual scheduled callback delivery still has its
explicit retry budget; a permanently failing downstream consumer remains an
observable failed outbox, not an exactly-once delivery promise. Added tests seed
legacy ciphertext/HMAC and receiver acceptance, verify 30/90/365-day invitations,
unchanged omitted-deadline replay and DB-only late callback idempotency. This
review did not independently rerun the owner's reported 38 tests/Miniflare run.
