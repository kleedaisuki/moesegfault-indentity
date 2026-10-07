# Login locale lifetime and draft ownership — 2026-10-07

## Problem and scope

The real in-app Browser reproduction is recorded in
`login-locale-browser-2026-10-07.md`: selecting English on registration silently
cleared nickname/status and focused main. This implementation repairs the cause,
not just the tested nickname fields. No production deployment, backend contract,
credential storage, or OAuth transaction representation changes are involved.

## Ownership decision

A display-language change is not navigation. `main.ts` now retains the same main
node, route AbortController, and `PageLifecycle` while rebuilding localized chrome.
Only actual router navigation aborts the route. The selector regains focus, and
document title updates; locale change no longer focuses main or reruns renderPage.

`PageLifecycle` owns a replaceable projection callback. Forms install form
projections; successful account creation/recovery installs terminal projections.
This distinction prevents changing language from resurrecting signup, replaying
creation, or discarding one-time recovery codes. Terminal success views without
codes are intentionally retained unchanged while chrome changes language.

Operation holds are reference-counted and released idempotently. While an email
send/confirmation, authentication, registration, or recovery operation is pending,
chrome can change immediately but form reconstruction is deferred until the
operation settles. Event handlers read the current locale, so arriving results use
the selected language. Cosmetic changes never cancel unresolved mutations or
restore an unknown operation as though it had not happened. Multiple language
changes collapse to the last selected language. Actual navigation still aborts.

## Draft and resource ownership

- Registration draft fields are explicitly named and typed: nickname, username,
  status, favorite character, interests, calling code, phone, password and its
  confirmation. Login and recovery have their own small explicit drafts.
- Drafts are captured only when rebuilding the same route. No HTML serialization,
  sessionStorage/localStorage credential persistence, logging, or token copying is
  used. Existing preference storage still contains display preferences only.
- Email verification keeps the **same verifier instance and DOM controls**. Its
  actual server-issued proof, challenge, CSRF capability, entered code, cooldown
  deadline, and OAuth context remain with their existing owner. Relocalization
  does not send mail, verify a code, or fabricate a proof. Expired proof becomes
  unverified with explicit expiry copy, without an automatic resend.
- Avatar selection keeps the **same picker instance**, including pending decoding,
  prepared bytes and preview URL. Copy changes in place. There is no transfer
  window where the old abort signal could revoke a newly transferred URL. Real
  navigation and explicit disposal retain the established exactly-once cleanup.
- Existing Login/registration failure state nodes are retained with draft values;
  server-authored error detail need not be retranslated. No credential value is
  used as a localization lookup.

## Focused verification

Node 24.18.0 through fnm; Windows workspace:

```powershell
fnm exec --using=24.18.0 -- npm.cmd --workspace @moesegfault/login test
fnm exec --using=24.18.0 -- npm.cmd --workspace @moesegfault/login run build
```

Final local result: **20 test files / 136 tests passed**, TypeScript and Vite build
passed. The pre-change journey repair suite had 124 tests; all remain passing.

Additional coverage:

1. Profile/password drafts survive with identical verifier/avatar owners.
2. Challenge, partial code and server cooldown survive; no extra mail is sent.
3. Actual verified proof and page-realm OAuth handle survive; only explicit submit
   consumes the proof, and request locale matches the selected display language.
4. Proof expiry invalidates state without creating a proof or resending.
5. An unresolved mailbox mutation keeps the original form until settling, then
   projects the selected locale without replay.
6. Ordinary Login/recovery credential fields survive.
7. Terminal Passkey recovery-code screen relocalizes with the same codes and only
   one registration completion; no signup form reappears.
8. Avatar keeps exact upload File identity/preview URL through localization; abort
   plus explicit disposal invokes resource disposal once.
9. Main integration confirms locale change does not call renderPage again, does
   not abort current route, and keeps focus on the new language selector.

These are local seam/integration tests, not a substitute for staging Browser
acceptance. Parent owns candidate staging deployment and real Browser verification.
The Browser reproduction document should receive candidate acceptance separately.

## Deliberate limits

This iteration reconstructs idle registration/Login/recovery forms. Enrollment and
rotation forms keep their actual DOM and credentials when chrome changes locale;
their existing labels remain until a subsequent state projection/navigation.
Existing generic failure nodes and terminal no-code success copy may likewise
remain in the previous language. This is preferable to losing state or replaying
security operations; it is explicitly not a claim that every visible historical
message is immediately translated. Pending avatar decoding does not block locale
changes because its owner and nodes are not replaced.

## Follow-up: navigation disposal and complete submit ownership

Independent review found two cross-await ownership windows; both are now closed.

1. `renderPage` centrally binds PageLifecycle to the actual route AbortSignal for
   both its normal caller and external/plain context callers. Disposal permanently
   clears pending projection and renderer ownership; late `present`, `relocalize`
   and idempotent hold release cannot revive the route. A pending locale change
   during avatar upload followed by real navigation must not let the old terminal
   renderer write recovery codes into the new route's reused main. A formal test
   exercises exactly this sequence. Late enrollment `getPrincipal` initialization,
   enrollment completion and recovery-code rotation also check abort before their
   awaited main projections; late initialization has a separate regression test.
2. Registration's submit owns the complete continuation **before** awaiting
   mailbox verification, rather than acquiring ownership only after obtaining a
   proof. Its `registering` gate and outer lifecycle hold now cover confirmation,
   proof consumption, account creation and secondary upload. A nested verifier
   release cannot rebuild a new unlocked form between email confirmation and the
   original submit's continuation. One outer `finally` releases the owner for
   no-proof early return and error paths; completed account creation remains
   terminal. Two regression cases combine pending submit-driven confirmation,
   queued language change and a duplicate visible-form submit, then independently
   settle account creation with success/failure. Both allow exactly one request.
   A mailbox-only early-return test confirms controls and queued language recover.

Final local follow-up validation (2026-10-07): **20 files / 139 tests passed**;
TypeScript and Vite build passed. Current generated JS is `index-C13Yh2T0.js`.
No production deployment or source commit was performed by this worker.
