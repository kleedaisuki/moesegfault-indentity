# Account profile read/write restoration (2026-10-07)

## Authoritative defect and scope

At inspection, `account_repository::AccountView` and its D1 query omitted the
optional `account_profile_details` row. `account::ProfileWire` consequently omitted
all seven existing extended profile fields: `bio`, `status_message`, `pronouns`,
`favorite_character`, `interests`, `links`, and `profile_visibility`.
`UpdateAccountRequest` accepted only `display_name` and `locale` with
`deny_unknown_fields`; the Account profile form sends the extended fields, so its
normal save payload was rejected instead of being persisted. Registration already
writes status/favorite character/interests. This extends the earlier observation
in `registration-real-amail-e2e-2026-10-04.md` from missing readback to missing edit
support. Existing migration 0002 and OpenAPI HumanProfile/UpdateAccountRequest
already establish the complete fields; no new migration or protocol is needed.

## Implementation and compatibility

- The account read model LEFT JOINs optional details. Accounts predating details
  remain readable with nullable text, empty arrays, and `members` visibility.
- GET `/v1/me`, PATCH `/v1/me`, and handlers using the shared Account wire projector
  return all seven fields. Stored JSON arrays are decoded at the adapter boundary.
- PATCH validates existing maximum lengths, array item limits, unique interests,
  URI syntax for links, and the existing visibility enum. Unknown fields continue
  to be rejected rather than silently discarded.
- Presence is retained separately from JSON null: omitted fields preserve existing
  values, null clears nullable text, empty arrays clear interests/links. Arrays and
  visibility reject null. Length validation counts Unicode scalar values, matching
  existing SQLite length checks rather than counting UTF-8 bytes.
- Human-profile updates, optional details upsert, and principal timestamps use one
  existing D1 atomic batch gated to active human principals. Missing optional rows
  are initialized during the first profile edit. No existing field is removed.
- Authentication/registration response objects manually assembled outside the shared
  Account wire projector retain their existing optional-field subsets; the durable
  Account Center read/write contract is exercised through `/v1/me`.

## Actual verification

Environment: Windows workspace, Rust release Worker compiled through worker-build,
Miniflare running actual generated Wasm and isolated D1; Node 24.18.0 via fnm.

Commands:

```text
npm run build:identity
cargo test -p identity-worker --lib
fnm exec --using=24.18.0 -- node scripts/tests/registration-email.mjs
```

Results: release Wasm build succeeded; 90 Rust unit tests passed; real Worker
registration-email harness passed, including existing mailbox-proof/security tests
and new assertions covering:

1. Verified password registration and durable status/favorite/interests GET readback.
2. All seven extended fields PATCH -> fresh GET persistence.
3. Display-name-only PATCH preserves details.
4. Null clears four nullable texts; empty arrays clear lists; omitted visibility survives.
5. Invalid null/type/length/array cardinality/duplicate/URL/policy/unknown-key payloads
   return 400 and leave existing profile unchanged.
6. 500-character Chinese biography and 100-character Chinese status are accepted.
7. A fixture trigger intentionally aborts the details update: PATCH returns 500 and
   fresh GET proves display name, details, and account timestamp were rolled back.
8. Removing the optional row only in isolated fixture proves legacy GET defaults
   and first-edit reconstruction.

Registration's existing canonical interest sorting is preserved. The local mail
outbox reports deferred delivery because this fixture has no mail transport; this
harness is not evidence of external mailbox delivery. An expected route-failure
log is produced by the deliberate atomic-rollback trigger.

Build outputs: `crates/identity-worker/build/index.js` and `index_bg.wasm` (generated,
not committed). All fixture state is under repository `.temp/registration-email`.
No production/staging deployment, commit, push, or browser interaction was performed
by this bounded backend task. Parent-led real staging browser retest remains required.
