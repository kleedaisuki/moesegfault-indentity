# Identity / Account journey review — 2026-10-07

## Scope

Independent review of the current uncommitted Account/Login frontend fixes. Inspected
changed implementation, API clients, draft helpers, routing, preference projection,
shell controls, and relevant regression tests. Browser execution belongs to the
parent's staging driver; this review did not control that browser, deploy, commit,
or modify production implementation. Unrelated untracked documents were preserved.

## Finding history (resolved after re-review)

### Resolved P2 — Preserve canonical server state as well as the in-progress draft

Location at review time: `apps/account/src/pages.ts:155–159`, with
`apps/account/src/main.ts:43–57` supplying the cached session to route renders.
Confidence: high (direct control/data-flow trace).

Trigger:

1. Load Profile with server display name O.
2. Change the name to A and save; while the request is pending, type B.
3. The successful save accepts A as the form baseline but skips `c.refresh()` because
   B is a newer edit. Both API mutation results are discarded.
4. Confirm discarding B and navigate to Overview, then back to Profile.
5. `renderCurrent(false)` reuses `session.account` and `session.preferences`, still
   containing O. Profile is rebuilt from O, although A was successfully saved.

Impact: saved changes appear to revert; saving a subsequent unrelated profile field
can submit the stale full profile and overwrite A. Preferences have the same stale
canonical-state issue. The new race regression explicitly asserts that refresh was
not called, but never exercises subsequent route navigation.

Correction: synchronize canonical account/preferences after successful mutation while
preserving newer edits. The new `refreshCurrent()` capture/restore path already offers
one mechanism: accept the submitted snapshot, then refresh and restore only edits
made afterward. Alternatively propagate authoritative API results into the owning
session. Add integration coverage through real shell navigation, not just a mocked
`refresh()` assertion. Coordinate failure/retry and principal/route binding.

## Reviewed safeguards without a substantive new finding

- Draft capture excludes credential, hidden proof, upload, and unregistered forms;
  pending restoration is principal- and route-bound and refresh loads fresh CSRF.
- Locale cancellation restores the selected language before any persistence/reload;
  theme media subscription is now installed once instead of once per control rebuild.
- Mobile and desktop sign-out share a single pending owner; mobile control is outside
  replaceable preference controls and is hidden when unauthenticated.
- Password and Passkey login share one owner; registration rechecks ownership after
  email verification and puts avatar preparation inside the error boundary.
- Passkey registration skips password-specific native constraints but individually
  validates shared controls; disabled hidden email-code controls do not block it.
- Transient email delivery errors are retryable; explicit rate limits still impose a
  local cooldown; timer projection retains locked and authorization-expired state.

These observations are source-level review, not claims of complete browser acceptance.

## Remaining objective-level acceptance gaps

- Browser Back/Forward draft loss remains explicitly unguarded in the current router;
  `beforeunload` does not run for same-document history traversal. This is a known
  product gap, not a newly introduced regression in the reviewed diff.
- Native dialogs, actual WebAuthn cancellation, mailbox delivery, mobile layout, and
  complete success/return/sign-out journeys require the parent-owned browser results.
- Integration tests for refresh retry, account switching, late callbacks after route
  changes, and fresh CSRF are being completed by the Account workstream; not assumed
  complete from helper tests alone.


## Follow-up review: correction verified

The original trigger above is retained for traceability. The current implementation
now always awaits `c.refresh()` after accepting the submitted snapshot. The refresh
coordinator captures only the still-unsaved delta, reloads authoritative account,
preferences, and CSRF state, then restores that delta into a fresh registered form.
The canonical cache therefore contains A, while B remains dirty until explicitly
saved or discarded. The P2 finding is closed.

Inspected the new `apps/account/src/main.test.ts` integration rather than assuming
helper coverage: it imports the real coordinator, performs pending-save editing,
checks B after refresh, confirms discard, follows Apps then Profile links, and asserts
A is rendered clean. The same test covers failed-refresh retry, unchanged fields
receiving fresh server values, fresh-CSRF submission, principal-mismatch draft removal,
locale cancellation, singleton media listener, and stale aborted-operation callbacks.
Pending drafts now also participate in route decisions and beforeunload warnings
while the rendered page is a refresh error rather than a form.

Independently rerun successfully:

```powershell
node node_modules/vitest/vitest.mjs run --root apps/account src/main.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --root apps/login src/main.test.ts --maxWorkers=1
```

Each command passed one integration test. The Login test proves an old, aborted render
finishing late cannot steal focus; the current render can focus. Login emitted Node's
experimental localStorage warning, not a test failure.

## Bounded backend review

Inspected the additional seven-field Account read/write change in `account.rs` and
`account_repository.rs`, plus the expanded local Worker HTTP fixture assertions.
No substantive blocker found in this bounded review:

- Explicitly present JSON null is retained by a custom deserializer for nullable text;
  omitted members remain absent. Arrays require arrays (empty clears), and visibility
  requires an explicit supported string. Invalid details are rejected before D1 writes.
- Upsert uses `json_type(...) IS NULL` to distinguish omitted from explicit JSON null;
  the latter clears nullable text through `json_extract`. Existing array/visibility
  values are preserved on omission. Legacy missing detail rows receive defaults.
- Human-profile, detail-row, and principal timestamp mutations share one D1 batch;
  all are gated to active human accounts. The fixture injects a detail-table abort
  trigger and checks the entire account readback is unchanged after HTTP 500.
- Read projection joins the existing optional details schema, retaining registration
  values and supplying complete defaults to legacy accounts.
- This profile update did not previously write a security-audit event, and the new
  patch does not introduce one. There is no new data/audit split transaction to assess;
  this review does not claim audit completeness for unrelated security mutations.

Backend fixture assertions were inspected, not independently executed by this reviewer.
No production deployment or schema migration was performed. Full journey acceptance
still belongs to the parent-owned browser work and is not inferred from these tests.

## Candidate 2 independent review

### Resolved P2 — Locale projection can split registration ownership across two forms

Locations at review time: `apps/login/src/pages.ts:185–196` and
`apps/login/src/registration-email.ts:138`. Confidence: demonstrated locally.

Reproduction (uses ordinary supported controls, not invalid transport state):

1. Fill the registration fields; send the email code and enter the full valid code.
2. Submit the registration form instead of clicking the separate email-confirm button.
   Its handler awaits `emailVerifier.requestVerification()` to confirm the entered code.
3. While that confirmation is unresolved, select another display language.
4. Resolve email confirmation. Its `finally` releases the last lifecycle hold and
   immediately reconstructs the registration form in the new language.
5. The original submit continuation then resumes, acquires its registration hold,
   and locks the detached original form. The new visible form has a separate local
   `registering=false` variable and enabled submit buttons.
6. Submit the visible form again while the first account creation is pending: a
   second `registerWithPassword` call consumes the same email proof concurrently.

This reintroduces the competing final-creation problem the shared owner was intended
to remove. Depending on server timing, the second request can rotate/race browser
context or show failure for an account that was already created. Email proof single
use protects durable data, but is not a substitute for coherent UI operation ownership.

Local executable reproduction: `.temp/review-locale-race.test.ts`. It deliberately
asserts the observed defective behavior (visible form replaced/unlocked and exactly
TWO registration calls), so its passing result confirms the bug rather than correctness:

```powershell
node node_modules/vitest/vitest.mjs run --root .temp review-locale-race.test.ts --maxWorkers=1
```

Correction/closure condition: the entire submit continuation must own its operation
before awaiting verification, with balanced release on failure and every early return;
locale projection cannot replace that owner in the confirmation-to-registration gap.
Add an enduring regression for this combined interaction asserting ONE registration
call and that the visible operation remains locked. Verify failed/no-proof confirmation
releases correctly, and route abort remains terminal. Worker and parent notified;
no production implementation edit made by reviewer.

### Account history and stable feedback

The earlier Back/Forward product gap is now addressed with preservation rather than
attempting to cancel `popstate`. Inspected actual router and coordinator changes:

- Native traversal asks the coordinator to preserve values from the still-rendered
  registered form, even though the URL has already changed.
- A hidden profile draft is restored only at Profile, with fresh account/CSRF reload
  and principal checking; unrelated route links do not discard the hidden draft.
- Approved visible-form discard clears the retained draft and avoids immediately
  recapturing it, so later traversal cannot resurrect an explicitly discarded edit.
- Hidden drafts participate in locale/document-exit warning decisions.
- Save success feedback is installed on the fresh canonical Profile only, after delta
  restoration, and only for the originating principal. Late/aborted callbacks cannot
  put success text on another route or another account.

No new substantive Account defect found in this bounded candidate-2 review. The
original stale-canonical-state P2 remains CLOSED, not reopened.

Independent focused checks:

```powershell
node node_modules/vitest/vitest.mjs run --root apps/account src/main.test.ts src/router-navigation.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --root apps/login src/locale-lifecycle.test.ts src/main.test.ts --maxWorkers=1
```

Account: 2 files / 5 tests passed. Login: 2 files / 12 tests passed. These tests do not
cover the combined confirmation/submission/locale race above; their green status does
not contradict the new finding. Login retained the existing Node localStorage warning.
Browser acceptance and staging deployment remain parent-owned; reviewer deployed nothing.


## Candidate 2 combined-race correction: independently closed

The combined email-confirmation/locale/final-registration finding above is CLOSED.
The current registration handler sets its `registering` owner and acquires the outer
lifecycle hold before entering the email-verification await. A verifier's nested release
therefore cannot flush queued localization between confirmation and account creation.

Inspected every ownership exit:

- Native/shared-field/password validation exits occur before ownership is acquired.
- No-proof/mailbox-only returns occur inside the outer try and reach finally.
- Abort after verification or avatar preparation reaches the same finally; disposed
  lifecycle state prevents late rebuilding or revival of the next route.
- Preparation, confirmation and registration failures restore the owner and controls
  before releasing the hold, allowing one coherent queued locale reconstruction.
- Successful password/Passkey creation sets `accountCreated=true`; finally releases
  the hold but does not re-enable signup. Installed terminal renderers preserve success
  or recovery-code output rather than reviving the original form.
- Hold release itself is idempotent; nested verifier operations remain balanced.

The three added permanent regressions exercise combined-confirmation success, combined
confirmation followed by registration failure, and mailbox-only submission without proof.
They check same-form ownership during unresolved creation, no duplicate request, usable
failure retry with retained password/current language, and early-return cleanup.

Independently rerun:

```powershell
node node_modules/vitest/vitest.mjs run --root apps/login src/locale-lifecycle.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --root .temp review-locale-race-fixed.test.ts --maxWorkers=1
```

Permanent locale tests: **14 tests passed**. Independent fixed reproduction: **1 test
passed**, checking SAME form, DISABLED visible signup button, and exactly ONE registration
request despite a repeated submit while pending. The historical defect-observation file
`.temp/review-locale-race.test.ts` was deliberately not overwritten; its expected-two-call
assertions describe the old defect, not the fixed acceptance contract. The fixed copy is
`.temp/review-locale-race-fixed.test.ts`.

No new substantive blocker found in this correction. Full 139-test suite/build and
candidate staging deployment remain parent-owned; this reviewer makes no production
or staging deployment claim.

## Explicit in-app draft discard dialog: independent scoped review

Reviewed the final async dialog implementation in `ui/draft-dialog.ts`, its callers
in `main.ts`, `preferences.ts`, `router.ts`, shell command locks, and relevant DOM
integration tests. This is a review of source behavior and local executable tests,
not a Browser acceptance or deployment claim. No production files were modified
by this review.

**Result:** no new substantive defect found in this bounded change. The worker found
and corrected a compatibility regression during review: entering anonymous state
previously retained an aborted render controller, rejecting anonymous language
changes. `becomeAnonymous` now aborts authenticated consent and creates a new live
anonymous scope. Independently inspected and rerun the integration's logout-then-
locale regression: no discard dialog, correct preference storage, exactly one reload.

Reviewed invariants and evidence:

- A dialog is owned by the render AbortSignal; navigation, refresh, or loss of
  authentication cancels it. The coordinator additionally checks controller and
  principal identity after awaiting consent. Retained detached approval buttons
  cannot revive a settled decision or authorize an unrelated command.
- Concurrent dialog requests fail closed rather than sharing an approval. Router
  links have one pending decision and a traversal/disposal generation; native
  Back/Forward preserves drafts without cancelling or rewriting browser history.
- Cancelling restores the old locale selection immediately and does not persist
  or reload it. Delayed invoker-focus restoration is gated by signal, connectivity,
  and consent generation; sign-out controls unlock before that restoration.
- Approved visible route discard clears retained values and renders without
  recapturing them. Hidden history drafts remain protected on document exits and
  language/sign-out decisions, without interrupting unrelated sidebar links.
- Native `beforeunload` protection remains separate. Explicit language approval
  removes that warning only immediately before the intentional reload. Unsupported
  `showModal` fails closed instead of silently losing drafts.

An additional independent reproduction is saved at
`.temp/review-discard-refresh.test.ts`. It starts a profile save, creates a newer
unsaved edit, opens sign-out confirmation, and completes the earlier save. The
canonical refresh aborts the modal, retains the newer edit, and ignores a stale
approval click: neither session listing nor revocation occurs. A subsequent sidebar
cancel remains usable and retains the draft and URL. **1 test passed.**

Independent verification (Node 24.18.0):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account src/main.test.ts src/ui/draft-dialog.test.ts src/router-navigation.test.ts src/preferences.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root .temp review-discard-refresh.test.ts --maxWorkers=1
```

Full suite before the final anonymous-scope correction: **19 files / 132 passed**.
Final corrected ownership/locale/router/dialog focused suite: **4 files / 24 passed**;
independent combined-save reproduction: **1 passed**. The worker reports the final
full suite and build; this review does not relabel that report as independent execution.

Remaining acceptance gates are parent-owned real Browser checks: native focus
containment/return, Escape, localized labels and narrow layout, cancel and explicit
discard for route/language/sign-out, and lack of a second document-exit warning.
DOM-emulator success does not prove those platform behaviors. No mail, credentials,
Browser interaction, staging deployment, or production mutation was performed here.

## Explicit Login Passkey cancellation: independent scoped review

Reviewed the new Login-only cancel action in `pages.ts` and its interaction with
`PageLifecycle`, route aborts, the native assertion wrapper, authentication completion,
existing shared auth locks, localized copy, and `passkey-cancel.test.ts`.
**No substantive defect found in the reviewed change.** No production source was
modified by this reviewer.

Cancellation is available only while awaiting the native assertion. The start request
and server completion remain locked and cannot be presented as reversibly cancelled.
Each attempt has its own controller and `live` continuation flag. Explicit cancellation
aborts that controller, restores password/Passkey controls, releases the locale hold,
and focuses the retained password draft immediately, without waiting for the native
promise to settle. Therefore a platform that ignores abort indefinitely cannot keep
the page locked. A delayed native credential or rejection is consumed by the existing
async handler but cannot invoke completion, show stale errors, or unlock a newer
operation. Releasing the lifecycle hold repeatedly is safe by its existing idempotent
contract. Route abort disposes the attempt and suppresses late start/native/result
continuations; the password form's separate owner and route signal are not aborted by
explicit Passkey cancellation. The accepted return destination and route-local draft
semantics are unchanged.

Independent targeted artifact: `.temp/review-passkey-cancel.test.ts` (**3 passed**).
It covers two successive native attempts with a queued language change: cancelling
attempt one, starting attempt two, then resolving OR rejecting attempt one's ignored
native promise must not complete authentication, hide the second cancel action, unlock
its controls, or expose the stale error. The second cancellation remains usable.
A third test aborts the route during the start request and proves its late reply does
not open a native ceremony, complete authentication, or overwrite the new route.

Independent permanent regressions (**3 files / 26 passed**, Node 24.18.0):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/login src/passkey-cancel.test.ts src/auth-interactions.test.ts src/locale-lifecycle.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root .temp review-passkey-cancel.test.ts --maxWorkers=1
```

These permanent tests additionally cover all three locales, never-settling assertions,
retained credential drafts, explicit password fallback and its valid return URI, stale
native completion while password authentication is pending, navigation abort, and
cancel unavailability before/after the native phase. They do not prove that a real
native browser chooser exposes or permits activating the page-level action while open.
Parent-owned Browser acceptance must check that real cancellation path, subsequent
password usability, retained locale/drafts/return destination, and absence of an
accidental authentication continuation. No Browser, mail, credentials, deployment,
production mutation, or physical-authenticator operation was performed in this review.

## Shared browser-binding renewal: review finding and closure gate

The follow-up review of registration-email context refresh found one additional
concrete shared-cookie shortening path (same underlying invariant, not a new scope).
`registration_email::complete` permits a verified-row completion retry while its
proof is live, returning the same proof and its original `proof_expires_at` through
`proof_response`. That function calls `renew_browser(expiry - now())`. If proof A
has 100 seconds left, another tab starts challenge B with a new 600-second deadline,
and A's completion response is retried, A writes the same shared browser binding
with `Max-Age=100`. B can then lose its binding before B's own server deadline even
if GET browser-context has been changed to issue 600 seconds. The path is directly
established by the verified-row SQL predicate and response helper; it is not yet a
separate real-Browser reproduction.

**Required closure:** ensure every successful binding-cookie renewal is compatible
with the longest existing purpose lifetime (currently 600 seconds), or avoid writing
a shorter cookie on proof replay. Preserve cookie identity/security attributes, the
original returned proof/deadline, SQL expiry enforcement, mismatched-binding rejection,
and no automatic client mutation replay. An isolated D1/Worker regression should
cover older live verified proof + newer pending challenge + old proof response retry.
Worker has been notified; this section is pending final verification.

Security-accounting nuance: browser CSRF is an HMAC of the opaque binding without a
cryptographic timestamp. The advertised browser-context `csrf_expires_at` remains
300-second refresh guidance, not a separately enforced token deadline. A uniform
600-second cookie does increase initial cookie persistence from 300 to 600 seconds
(already used during mailbox verification). It must not be described as retaining
an enforced 300-second CSRF expiry. Transaction/proof SQL expiry and binding checks
are separate controls and must remain unchanged.

### Scenario refinement during implementation

The worker correctly identified that starting a second mailbox challenge cancels
pending/verified mailbox rows for the same binding, so the two-mailbox scenario
above cannot reach the asserted successful retry. Do not treat that initial example
as a runnable reproduction. The underlying shorter-cookie response is reachable
with a different supported overlap: a live verified proof with 100 seconds remaining
starts a 300-second WebAuthn registration transaction, then retries the verified
mailbox completion. The old helper would return a 100-second cookie even though the
new WebAuthn transaction remains live for 300 seconds. The worker is adding this
precise isolated Worker/D1 regression. The correction now uses the same 600-second
binding-cookie helper for context, mailbox challenge and successful proof responses;
returned proof expiry and all SQL validation remain untouched. Final execution
verification is still pending below.

### Final independent closure: shared binding renewal

**CLOSED after source correction and executable verification.** All production
Set-Cookie writers for the browser binding now use `guard::browser_cookie`, which
retains the same opaque value with Secure/HttpOnly/SameSite=Strict/Path=/, no Domain,
and uniform Max-Age=600. `browser_cookie_for` has no other production callers.
`proof_response` still returns its original expiry and token; the cookie helper does
not modify database state. Existing Origin, Fetch Metadata, CSRF and stored browser
binding checks remain intact. The frontend refreshes context before exactly one
explicit confirmation, suppresses known-expired challenges locally, checks abort
before submitting, and retains code/draft/challenge without automatic mutation
replay or mailbox resend. Context rejection is localized rather than exposing raw
English CSRF prose.

Independent current-source/artifact verification:

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/login src/registration-email.test.ts src/locale-lifecycle.test.ts --maxWorkers=1
cargo test -p identity-worker guard::tests -- --nocapture
fnm exec --using=24.18.0 -- node scripts/tests/registration-email.mjs
```

Frontend: **2 files / 34 passed**. Rust guard: **9 passed**. Rebuilt release Worker
Wasm + real Miniflare/D1 harness: **passed**, independently rerun after the worker
confirmed the exact source rebuild. Inspected assertions establish:

- Context GET preserves cookie identity, emits 600 seconds, and returns the same
  binding-derived CSRF capability.
- Old CSRF with a different browser cookie is rejected (403); that other browser's
  fresh CSRF still cannot rebind the original challenge (400).
- Refresh does not revive an expired challenge; valid synthetic code is rejected
  after SQL expiry and creates no additional principal.
- A verified proof with 100 seconds remaining starts a live WebAuthn transaction
  with roughly 300 seconds remaining. Retrying the old successful email completion
  emits Max-Age=600 without extending the old proof's returned expiry.
- Existing proof single-use, browser/email binding, guessing budget, concurrent
  registration race, and profile atomic rollback checks still pass.

The harness uses isolated synthetic code/database fixture state, not deployed mail
or browser clock manipulation. Its deliberate profile trigger failure and deferred
mail diagnostics are expected fixture outputs, not new deployment failures. No
staging/production deployment or real Browser acceptance is implied. Parent still
owns a real late-code/resend and cross-tab-context journey against the staged fix.
No new substantive blocker found in the final bounded review.

## Recovery rotation with no active Passkeys: independent review

Reviewed the zero-key guard in `pages.ts::renderRecoveryCodeRotation`, its real API
client, frontend DTO, backend list endpoint/repository/wire serializer, rotation
policy, return-link validator, and focused tests. **No substantive defect found.**

The management endpoint requires an authenticated session and returns `items` from
the current principal's complete, non-paginated authenticator query. Revoked rows
are included; `revoked_at` is ISO timestamp or null. This matches Login's
`ResourceList<Authenticator>` and `!authenticator.revoked_at` active-key test;
optional absent revoked markers also preserve legacy DTO compatibility. List
failure/malformed-list exceptions do not authorize the empty-state enrollment path.
The client sends credentials and no-store. No credentials or recovery material
are returned by this read.

The prerequisite is a UX guard, not authorization: with an active key the existing
coordinator and server `recent_passkey` requirement remain unchanged. Concurrent
key revocation or addition cannot weaken the server requirement; a later explicit
attempt rereads the list. No password-only rotation or automatic enrollment occurs.
Duplicate clicks share the local lock; route abort suppresses a late reply before
step-up or rotation and cannot replace the next route. The enrollment URL uses the
existing same-environment exact Account return allowlist and does not copy arbitrary
query secrets or foreign destinations. The ordinary Return-to-Account link remains.

Independent verification (Node 24.18.0):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/login src/rotation-prerequisite.test.ts src/management-return.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root .temp review-rotation-wire.test.ts --maxWorkers=1
```

Permanent focused suite: **2 files / 21 passed**. Additional independent transport
contract probe: **3 passed**. It uses the actual IdentityApiClient and representative
complete backend DTO JSON: revoked-only data leads to the validated enrollment URL
and exactly one GET; an active row reaches the unchanged POST through the coordinator;
HTTP503 problem response remains an error, never a false zero-key explanation.
The initial independent error fixture omitted the problem Content-Type and therefore
produced the client's generic HTTP503 fallback; fixing that fixture header made the
intended response-detail assertion pass. No product defect was inferred from that
fixture error.

Parent owns the actual Browser acceptance of zero-key explanation/enrollment link
and any expressly authorized credential/recovery mutation. Tests do not prove a
real-device active-key ceremony. This review modified only its temporary test and
this review record; no production fixes, Browser, mail, deployment, or credential
operation occurred.

## Enrollment bootstrap review: cross-principal coordinator replay (OPEN)

The new first-key path's explicit expected-principal checks are useful, but the
existing active-key coordinator path still has a demonstrated authority-lifetime
bug. A page rendered for principal A retains `expectedPrincipalId=A`, while the
api-only WeakMap coordinator uses a realm-global cached CSRF. After another tab
changes the shared session to B, the first start request with A's CSRF is rejected;
`refreshSessionCsrf` then reads B's principal/CSRF without checking the rendered
principal and retries A's enrollment command under B. The same mechanism is used
by recovery rotation. This is a high-impact ownership defect, not a request to
weaken authentication or add support for a theoretical invalid API response.

Independent synthetic DOM reproduction:
`.temp/review-enrollment-principal-race.test.ts` (**1 passed**, defect-observation
assertions). It renders enrollment using A, switches the mocked shared session to
B, submits Add with an active-key projection, and observes two real coordinator
start calls: first `csrf-A`, then `csrf-B`; native creation starts for B's returned
transaction. No real account or credential was touched. This historical file must
not be presented as a fixed acceptance regression without changing its expected
behavior or making a separate fixed copy.

Required correction: bind the immutable rendered principal to each execution;
check a fresh principal before the first mutation and every CSRF refresh, and check
authentication-completion principal before remembering/retrying its authority.
Api-only caching must not retain a first route's immutable owner for unrelated
later routes or substitute a mutable global principal. Cross-account changes must
stop with an actionable reopen-management message, not replay the operation under
the new account. Same-principal shared-session rotation should remain recoverable.
The worker and parent have been notified; final closure is pending.

### Enrollment/bootstrap and management principal replay: CLOSED

Independently inspected final `renderPasskeyEnrollment`,
`reauthenticateAndStartEnrollment`, asynchronous `renderRecoveryCodeRotation`,
principal-scoped coordinator wiring, `InlineStepUpCoordinator`, and new regression
coverage. The cross-principal finding above is **CLOSED** after correction. No
remaining substantive blocker was found in this bounded management change.

Authority ownership is now explicit:

- Enrollment captures the principal shown at page initialization. The first-key
  direct path reloads the current principal/CSRF and rejects a different principal
  before starting credential registration. Its password confirmation uses the
  expected account's prefilled readonly identifier where available, but readonly
  is not treated as a security boundary: authentication's returned principal must
  match before any enrollment start. The exported helper's optional final argument
  preserves previous callers; the actual UI always supplies its expected principal.
- With zero active keys, Add never enters an assertion ceremony. Only the exact
  HTTP403/reauthentication_required rejection opens existing password confirmation;
  unrelated failures remain errors. A recent-password session may start creation
  directly under the unchanged backend bootstrap policy. The two forms share one
  operation lock and do not compete to rotate session/CSRF or create a key.
- Both enrollment and rotation pass an immutable expected principal to a coordinator
  cached by API client **and principal**, not a mutable global owner. Bound initial
  reads and every stale-CSRF refresh perform fresh `getPrincipal` and compare before
  adopting its token. A completed step-up result is checked before token caching,
  generation advancement, or retry. A mismatch stops with localized reopen-management
  guidance rather than mutating the newly signed-in account.
- Rotation now also captures its initial principal and validates fresh identity on
  explicit activation, before its key-list/preflight and bound step-up. Zero-key
  explanation does not issue recovery codes; active-key policy remains unchanged.
- Coordinator continuation checks AbortSignal after session/browser context reads,
  start, native assertion and completion, and before retries. Late native results
  cannot initiate completion or cache authority after navigation. Existing sharing,
  same-principal CSRF recovery and the original server validation remain intact.

Independent final verification (Node24.18.0):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/login src/enrollment-owner.test.ts src/enrollment-bootstrap.test.ts src/step-up.test.ts src/rotation-prerequisite.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root .temp review-enrollment-principal-race-fixed.test.ts --maxWorkers=1
```

Permanent focused checks: **4 files / 41 passed**. Independent fixed reproduction:
**1 passed**. The fixed copy renders A, changes the synthetic shared session to B,
then submits active-key Add: it now reports account change with **zero enrollment
start requests and zero native creation**, instead of the historical A-token then
B-token replay. The original defect-observation file remains unchanged for provenance.

Permanent tests cover fresh account mismatch, mismatching CSRF-refresh ownership,
wrong-principal assertion result, aborted late native assertion, and intentionally
rendering B later using the same client, for both management routes. Bootstrap tests
also cover password-manager identity substitution, both-form duplicate locks, exact
fallback error boundaries, and navigation abort during list/start/native/password.

Remaining Browser gates are parent-owned: fresh/stale password-only first-key
bootstrap, explicit confirmation failure/retry, original security return, and any
user-authorized real credential creation. No second real account, password, Passkey,
recovery code, native browser, mail, or deployment was used by this review.

Final-source recheck after the worker made the internal coordinator owner argument
mandatory: only the two management consumers exist and both supply their immutable
principal; there is no generic unbound coordinator/cache fallback. Independently
reran the final 4-file focused suite (**41 passed**) and fixed reproduction
(**1 passed**) at 19:40 local time. The exported password-bootstrap helper alone
retains its optional final argument for compatibility; its UI always supplies it.
Closure remains valid against the latest source. The worker reports full 27-file /
223-test build; this reviewer does not relabel that full run as independently executed.

## Account password card ownership and policy: independent review

Reviewed current `passwordCard`, `password-policy.ts`, API request mapping, localized
copy/tests, Rust `identity_domain::validate_password`, and Worker PUT/DELETE password
policy. **No substantive defect found in this bounded repair.** No production source
was changed by this reviewer.

- Set and remove use the same idle/pending/completed owner. Ownership is acquired
  before either request and both actions/credential inputs are disabled. Repeated
  synthetic submit or opposite-action activation cannot initiate a second mutation.
- Set captures exact new/current strings before disabling controls; neither trimming
  nor case folding occurs. Native required-field validation remains, while scalar
  length/custom validity replaces incompatible UTF-16 native length restrictions.
  `Array.from` counts code points and Unicode Cc rejection matches Rust control
  character rejection. Lone surrogate rejection correctly excludes JS strings that
  cannot be represented as Rust Unicode scalars. Space-only and astral passwords
  within the exact 15..128 scalar policy remain accepted.
- Remove intentionally does not require submitting either credential field. This
  preserves the real DELETE endpoint's existing recent password/Passkey session and
  remaining-authentication-method checks; no backend requirement was bypassed or
  new mutation permission introduced. PUT still requires the current password for
  replacement, or recent Passkey authority for adding the first password.
- Confirmed success becomes completed before canonical refresh and clears form
  secrets. Refresh failure cannot unlock/replay the mutation; if the old card remains,
  localized guidance directs reload, while the real main refresh coordinator may
  replace it with its read-only retry/error surface. Route abort clears inputs,
  locks the obsolete card and suppresses late success/failure feedback and refresh.
  Password fields never register for profile draft restoration/storage.
- An unconfirmed transport/server failure allows deliberate retry, not automatic
  replay. Such a failure is not evidence that the server did not commit; this repair
  guarantees no replay after **confirmed success followed by refresh failure**, not
  exactly-once delivery under arbitrary lost mutation responses. That boundary is
  unchanged and should not be described as proving every failure was pre-commit.

Independent verification (Node24.18.0):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account src/password.test.ts src/pages.test.ts src/i18n.test.ts --maxWorkers=1
```

**3 files / 53 passed**, including both set/delete ownership directions, submitted
credential-byte preservation, deliberate retry, confirmed mutation + refresh failure,
idle/in-flight abort, late success/rejection, last-method/recent-auth presentation,
three-locale hints, scalar boundaries and invalid controls/surrogates. Source review
also checked the actual DELETE rejection code `last_authentication_method` and that
its general error presentation remains unchanged; the new synthetic last-method
fixture uses a different generic code but exercises the same unchanged fallback.

Parent's live empty-Save/required-current-password focus observation is separate
Browser evidence. This review does not establish a real password replacement,
removal, native validation popup, or credential-change handoff. No Browser, mail,
deployment, real password mutation, or credential disclosure occurred here.

## Account mobile verification capability: independent bounded review

Reviewed the pending-mobile row, pre-add notice/accessibility wiring, locale copy,
contacts regressions, and the real Worker contact-verification start handler.
**No substantive defect found in this capability-presentation correction.**

The backend unconditionally rejects `kind=mobile` verification with HTTP503 /
`service_unavailable` before creating a delivery transaction. Therefore removing
the unusable Verify action and explaining that SMS verification is not yet available
matches the actual paired service contract rather than concealing a transient outage.
Saving/removing a number remains available. The copy does not assert the number is
verified, silently change verification state, or promise SMS delivery. Legacy verified
mobile contacts retain their existing verified/primary/removal behavior, and pending
email still uses its unchanged verification flow.

Switching the add form to mobile exposes the notice before submission and associates
it with the telephone field using aria-describedby. Switching back hides the notice,
removes the reference and restores the email field semantics. The feature statement
is intentionally tied to the current backend capability; a future SMS implementation
must update this static frontend capability projection as part of its delivery.
No authorization, payload, verification endpoint, or contact data contract changed.

Independent current-source checks (Node24.18.0):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account src/contacts.test.ts src/i18n.test.ts --maxWorkers=1
```

**2 files / 44 passed**, including all three locale notices, no pending-mobile send
action/request, pre-add hint toggling and accessible description cleanup, preserved
verified-mobile management, and the existing email operation/error-recovery suite.
Parent's live pending synthetic mobile row is reserved for staged acceptance and
cleanup. This review did not operate that row, request SMS/mail, use Browser, modify
production source, or deploy anything.

## Shared mobile-input normalization: independent bounded review

Reviewed `frontend-shared/mobile.ts`, its export and tests, Account contact submission,
Login signup submission and lifecycle ownership, locale/error/focus wiring, and Rust
`normalize_mobile`/separate login-identifier semantics. **No substantive defect found
in the final repair.** No production source was modified by this reviewer.

The typed empty/valid/invalid result preserves domain distinctions: optional whitespace-
only signup input is omitted, but nonblank punctuation-only input is rejected. The
selected calling code remains authoritative and is limited to the six existing
selectors. A matching explicit +country prefix is removed once; conflicting country,
multiple +, letters, fullwidth digits and unsupported symbols are rejected rather
than silently changing the selected country. Existing whitespace/ASCII parentheses/
hyphen formatting is removed, then one national trunk zero is removed. Crucially,
`00` is rejected **before** trunk-zero removal, including separators between zeros;
it is not reinterpreted as either universally international or the wrong selected
country's national digits. The result contains nonzero-leading ASCII national digits,
with total country+national length at most 15, matching unchanged Rust registration
syntax. This is formatting/syntax normalization, not proof of allocation, reachability,
SMS capability, or worldwide national-number validity.

Account checks the result before Add, leaves selected country/value unchanged on
error, focuses/marks the field and uses actionable localized reason-specific copy.
Email contact submission remains separate. Login checks optional mobile before
acquiring the account-creation operation hold and before inspecting/confirming email
proof, sending mail or starting either registration method. Invalid mobile therefore
cannot consume proof or start a platform ceremony/account mutation. Correction can
reuse the same verified email proof. The existing combined submit/email lifecycle
hold is retained once validation succeeds; localization and draft ownership do not
replay registration. Legacy password-login identifier parsing was not changed.

Independent current-source verification (Node24.18.0):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root packages/frontend-shared src/mobile.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/login src/mobile-registration.test.ts src/locale-lifecycle.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account src/contacts.test.ts src/i18n.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root .temp review-mobile-normalizer.test.ts --maxWorkers=1
```

- Shared permanent tests: **18 passed**.
- Signup and lifecycle permanent tests: **2 files / 25 passed**.
- Account contact/locale permanent tests: **2 files / 53 passed**.
- Independent supplemental safety probe: **8 passed**.

The independent probe rejects ambiguous copied 00 international input for all six
selected codes, accepts existing Unicode whitespace compatibility (NBSP, narrow
NBSP, ideographic space/tab), rejects zero-width inserted characters and unexpected
symbols, and checks every accepted sample against the unchanged Rust digits/nonzero/
15-digit invariants. Permanent real-form tests additionally cover matching full
number payloads, Japanese/UK national trunk input, conflicting countries, optional
blank omission, 00 correction guidance, invalid signup before mail/creation, retained
proof after correction, localized focus and duplicate/lifecycle guards.

Parent owns staged Browser acceptance and cleanup of its reserved synthetic phone
fixture. This review used no Browser, mail, actual phone, native authenticator,
credential mutation, or deployment. Hardware Passkey testing remains explicitly
deferred by the user and was not attempted.

Final markup follow-up: root identified an invalid intermediate label wrapper
containing both a labelled telephone input and another labelable select. The final
source uses `div.field`, a sibling caption `label[for=signup-mobile]`, and a phone
span containing the independently aria-labelled country select and the identified
telephone input. The caption label has no additional labelable descendant; the
telephone's hint remains aria-describedby. Inspected all three localized caption
assertions and independently reran final Login mobile/lifecycle tests: **25 passed**.
This establishes correct explicit HTML association in source/DOM, not a separate
real assistive-technology acceptance claim. No remaining markup blocker found.

## Profile multi-endpoint save: fail-fast overlapping retry (OPEN)

Independent investigation of the real form's `Promise.all(updateMe, updatePreferences)`
found a concrete valid-input network-failure ownership defect, separate from input
preflight. If preferences reject while the profile request remains pending, the
catch/finally immediately re-enable Save. A deliberate retry may therefore start a
second profile write before the first settles. If the newer write commits first,
the older pending write can later overwrite it. This is a user-data overwrite path,
not merely unclear copy or a request for cross-endpoint atomicity.

Historical independent reproduction saved at
`.temp/review-profile-partial-race.test.ts` (**1 passed**, defect-observation test):
real Profile DOM, valid names, deferred old updateMe, immediate first preferences
rejection, explicit newer retry. It observes Save unlocked before the old request
settles, the retry storing `Newer retry`, then the delayed first request replacing
it with `First write`. Only synthetic API doubles were used; no Browser/network
mutation occurred. Do not report this expected-defect test as fixed acceptance.

Additional source consequences:

- A one-side confirmed commit currently leaves both fields on the old baseline and
  reports a generic error, without distinguishing confirmed partial success from
  an unconfirmed/failed counterpart. Retained full draft avoids immediate data loss
  but does not establish that nothing was saved.
- The current success branch accepts the old form's baseline and calls refresh
  without first checking its route AbortSignal. The main wrapper guards stale
  refresh, so the old request cannot necessarily overwrite the new DOM; nevertheless
  its obsolete baseline acceptance should be suppressed after abort, especially for
  history-preserved drafts. No mutation abort should be described as rollback.

Minimum correction: retain shared Save ownership until both requests settle (for
example allSettled), check route ownership before baseline/feedback/refresh, provide
explicit partial/unknown outcome guidance, preserve failed/newer drafts, and never
automatically replay either mutation. Canonical reads can reconcile authoritative
state after settled outcomes; they do not make the two writes atomic. If accepting
only confirmed-success fields as baseline, accept their submitted snapshot rather
than the live edits typed later. Unknown lost responses still require honest manual
recovery, not an assertion that the failing request could not have committed.

Parent and preflight worker were notified. Production ownership remains with the
worker; parent is coordinating whether partial-save handling is the same workstream
or a separate task. This review made no source fix, deployment, mail or credential
change.

### Profile partial-save race: independently CLOSED

The fail-fast overlapping-retry finding is **CLOSED** in current source after the
single worker's separate partial-save correction. The form waits `Promise.allSettled`
for both writes and retains its Save owner until both observed outcomes settle.
A rejected sibling can no longer unlock a retry that overtakes the still-live first
write. Route abort is checked before baseline acceptance, feedback and canonical
refresh; no stale completion is treated as an instruction for the current route.

Each fulfilled endpoint contributes only its submitted field subset to the baseline:
profile details or locale/timezone. Failed/unconfirmed fields and edits made after
submission remain dirty. This uses the existing submitted FormData snapshot, not
live controls. After confirmed partial success the coordinator reloads canonical
account/preferences and restores only remaining deltas. Typed partial feedback is
scoped to Profile, the originating principal and active render lifetime; it never
uses generic Saved to imply both writes succeeded. A failed canonical refresh
retains the draft and displays partial/reload guidance; its retry remains a read,
not a mutation replay. If the original form remains after an explicitly rejected
refresh callback, confirmed-success state keeps it locked.

The tri-locale copy correctly says a rejected endpoint's save is unconfirmed,
not definitively unsaved. When neither endpoint reports success, the form retains
all edits and explains that some changes may nevertheless have been written.
There is no automatic replay, rollback claim or new server atomicity promise.
The fix prevents overlapping retry within this owning form; browser abort or a
lost network response still cannot establish that a server write was rolled back.

Independent final current-source tests (Node24.18.0):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root .temp review-profile-partial-race-fixed.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root .temp review-profile-partial-baseline.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account src/profile-input.test.ts src/pages.test.ts src/draft.test.ts src/main.test.ts --maxWorkers=1
```

Independent inverted race regression: **1 passed**; submitted-baseline/refresh/abort
probes: **4 passed**; permanent form/draft/main/preflight checks: **4 files / 57 passed**.
The historical expected-defect file remains separate and unchanged. The fixed race
asserts disabled Save after early preferences rejection, no second request from
repeated submit, and a later explicit retry retaining the newer server value after
the first write has settled. Additional probes cover both success subsets, newer
local edits, refresh rejection with no replay, and late aborted partial completion.
Inspected main integration additionally covers canonical partial readback, failure-
page read retry and restored deltas, both partial directions, and existing principal
feedback protection.

No further substantive partial-save defect was found in this bounded review.
Source validation/preflight is exercised by the focused suite but exhaustive backend
validator equivalence or a real partial-network Browser experiment is not claimed.
Parent owns actual staging save/readback and fixture restoration. No production
source, Browser, backend/auth/security, mail or deployment was changed by this review.

## Profile cross-mutation refresh/Save ownership: independently CLOSED

Reviewed the worker's page-local Profile mutation owner and all integrations in
`pages.ts`: Save, avatar preparation/upload/removal, contact add/remove/promotion,
and verification initial send/resend/completion. The root's independently reproduced
cross-mutation overwrite path is **CLOSED** in the reviewed source. No new substantive
blocker found. No production source was modified by this review.

All mutating starts now acquire the same rendered-page lease before request dispatch
(or asynchronous avatar preparation), and hold it through settled endpoint outcomes
and canonical refresh. Other mutation buttons/file selection are disabled and their
handlers guarded; profile text/select fields remain editable so newer edits survive
existing submitted-baseline/draft reconciliation. Both initiating directions matter
and are covered: pending Save blocks avatar/contact refresh, and pending avatar or
contact work blocks Save. Initial verification dynamically registers its new controls
while the original lease remains held. Native picker activation alone does not issue
a mutation; the file change/preparation phase must acquire the lease.

Disabled state is projected from explicit per-control desired intent plus page lease
and permanent abort closure, rather than restoring stale snapshots. This preserves
terminal Save/cooldown-style disabled state, handles dynamic controls, does not revive
detached controls on release, and makes repeated lease release idempotent. Profile
callbacks use the projection helper instead of raw busy(false) after refresh. Abort
permanently closes the old owner; late prepared resources are disposed, old controls
remain unavailable, and no old completion can initiate refresh/mutation on a new page.
Unrelated Account routes retain their previous command semantics.

Independent verification (Node24.18.0):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account src/profile-operations.test.ts src/profile-cross-operations.test.ts src/profile-input.test.ts src/pages.test.ts src/contacts.test.ts src/main.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account src/profile-main-owner.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root .temp review-profile-cross-owner.test.ts account-cross-mutation-race-fixed.test.ts --maxWorkers=1
```

Permanent focused integration/unit suite: **6 files / 109 passed**, plus promoted
real-main regression **1 passed**. Independent supplemental probes: **2 files / 7
passed**. The historical root reproduction `.temp/account-cross-mutation-race.test.ts`
remains unchanged; its expected-defect assertions are not current acceptance.

The inverted actual main/pages reproduction proves avatar removal cannot replace or
abort a pending Save owner, a synthetic competing click dispatches no delete, the
first Save settles before a fresh form exists, newer draft text is restored, and the
subsequent explicit Save's acknowledged newer server value remains durable. Additional
independent probes cover reverse avatar/contact direction, text editing, async local
preparation and late-resource disposal, lease ownership through read refresh, dynamic
verification send/completion, terminal/cooldown desired state, detached controls,
permanent abort closure and idempotent release. Permanent table tests cover all ten
initiating workflows against every other mutation.

An initial independent focused run had one obsolete test expecting an aborted
verification input to become writable again. The worker corrected that assertion to
the new closed-page contract (readonly input/disabled submit/no refresh/no extra
completion); the final independent suite passes. This was a test-contract adjustment,
not a newly demonstrated product failure.

Scope remains intentionally local: explicit browser history/document exits and
independent tabs are not a server concurrency protocol, and abort/lost responses do
not imply rollback. Existing selective partial-save baseline handling and honest
unknown-outcome guidance remain necessary and preserved. Parent owns actual staged
Browser acceptance; no Browser, mail, deployment, device, credential or real contact
operation occurred in this review.

## Account locale authority/current projection: review in progress

Parent reported a real candidate-13 mismatch: Profile persisted locale en but the
actual document/header/title remained zh-CN even after reload. Independently inspected
current main: locale/t are initialized from local storage/browser language, canonical
`getPreferences` populates only session preferences, and neither current interface
projection nor next bootstrap adopts that authenticated locale. ADR0003 explicitly
prioritizes authenticated account preference. The existing deterministic main/pages
defect observation is `.temp/account-profile-locale-consistency.test.ts`; parent
reports its expected-defect test passed. This review does not relabel that historical
file as fixed acceptance.

Prepared separate inverted acceptance artifact:
`.temp/account-profile-locale-consistency-fixed.test.ts`. It requires saved ja to
update document lang, header select, Profile copy, title, acknowledgement and local
fallback cache, then deliberately restores stale local en before rebootstrap and
requires authenticated ja to win. Execution is pending the worker's final repair.

Review design gates communicated to worker/parent: canonical locale, not a newer
unsaved locale draft, drives document/shell/title; selective partial save outcomes
must retain failed/newer drafts and originating-principal feedback. Shell copy updates
must preserve real command nodes and locks, while discard dialog copy uses the current
translator. If header selection persists account preferences, it must respect the
Profile-page mutation owner rather than compete with an admitted Save locale write
or abort it via cosmetic reload. Anonymous/local fallback and theme behavior must not
regress, and no stale route/principal request may project locale onto another owner.
No production edits, Browser, credentials, mail, device or deployment by this review.

### Account locale authority/projection and Appearance focus: independently CLOSED

Reviewed final main/shell/draft/owner wiring. The saved-language/current-interface
finding is **CLOSED** in current source. No new substantive blocker found.
Authenticated canonical preferences now win over local/bootstrap language on every
session read, before the page is rendered; document lang, route title, shell labels,
header selectors and local non-sensitive fallback cache are synchronized. Unsaved
form locale is still a draft, not authority over the real document. A Profile save
uses its existing canonical refresh, not document reload, and keeps failed/newer
deltas under the existing principal guard and selective partial-save semantics.

Authenticated header changes explicitly persist account preference. They share the
Profile operation lease (or reject an already-busy non-Profile command), so cosmetic
language work cannot interrupt/compete with an admitted Profile write. Consent keeps
the current selection until approved. Approval snapshots do not change the saved
baseline; a failed/unconfirmed write retains the original draft and locale. Confirmed
success discards only approved values, preserves post-consent edits, and reads fresh
canonical state. Readback failure reports confirmed language save separately and
provides read-only retry, never automatic PATCH replay. Request tokens, route signals
and principal checks suppress stale results and unlock persistent controls promptly
on abort/401. Hidden drafts are cleared only on approved successful discard. Native
document-exit protection remains installed.

Shell relocalization updates existing nodes, labels and accessible names without
replacing navigation, sign-out locks, main, or the focused header commands. The discard
dialog translates through current main t, not the initial translator. Appearance
updates the same focused button and icon in place; repeated system/light/dark cycling
keeps focus and current localized aria-label, fixing the parent's real keyboard-focus
loss observation. Existing media listener/theme authority is unchanged. Anonymous
language selection updates landing/title/header/local fallback in place, without an
authenticated preference write or document reload. New header feedback wraps in CSS;
no real narrow-screen or screenshot acceptance is inferred from these DOM checks.

Independent verification (Node24.18.0):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account src/locale-consistency.test.ts src/main.test.ts src/draft.test.ts src/ui/shell.test.ts src/ui/draft-dialog.test.ts src/profile-main-owner.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root .temp review-account-anonymous-locale.test.ts account-profile-locale-consistency-fixed.test.ts --maxWorkers=1
```

Permanent focused checks: **6 files / 31 passed**. Independent actual-main workflow
and anonymous probe: **2 passed**. The fixed workflow asserts:

- Saved ja updates document/header/title/Profile copy/success text/cache, and beats
  deliberately stale local en at next bootstrap.
- Theme cycles preserve the same focused button and localized aria-label. A subsequent
  dialog uses current ja and cancellation preserves node, selected locale and draft.
- Confirmed header discard retains only post-approval edits; failure retains original
  form/draft/language. Header activation during pending Save dispatches no competing
  preference request and presents busy guidance.
- Preference-only partial success adopts saved locale while preserving unconfirmed
  profile edits; details-only success keeps canonical locale and retains failed locale
  as draft. A newer unsaved locale survives without overriding saved document locale.
- A canonical principal change clears the originating draft/acknowledgement and adopts
  the new principal's own locale, rather than leaking old form state.

The separate anonymous probe uses a real main bootstrap with an authenticated read
rejected as401: local ja remains fallback, subsequent local en updates the landing
and title without preference mutation or reload, and header focus/node is retained.
Permanent integration also covers confirmed PATCH/readback failure, no replay on
Retry, late pending-header completion after unauthorized transition, approval snapshots,
persistent shell/sign-out ownership, and existing Profile cross-mutation closure.
The historical expected-defect locale file remains unchanged for provenance.

Parent independently reports full228-test/build gates and owns candidate14 staging
and actual three-language/keyboard/draft acceptance. This reviewer performed no
Browser, screenshot, mail, device, credential, deployment or production-source change.
No hardware Passkey testing was attempted; the user's explicit deferral is preserved.

## Explicit read-only locale recovery: final independent closure

Reviewed the new persistent header `Read latest state` action and its owner/token,
canonical read, draft, error, focus, principal and abort handling. **CLOSED; no
remaining substantive blocker in current source.** No production source was changed
by this reviewer.

The action calls only `renderCurrent(true)` with the default preserve policy. It does
not repeat the uncertain locale PATCH, submit Profile, create a second account, or
navigate/reload the document. All current changed profile fields are captured against
the saved baseline, including edits made after the failed header attempt; fresh
canonical fields and locale are read before those deltas are restored. Admission
respects an existing Profile mutation owner and other page busy state. A read token
serializes both responsive header actions and blocks competing locale writes while
canonical reads remain pending. Cancellation is bound to the **new read scope**, not
the old scope deliberately replaced by that read. A read failure uses the existing
failure-page read retry; no mutation replay or false success claim is introduced.

Successful recovery clears old feedback and hides its recovery button, then focuses
the same visible header selector for the same principal. Source review identified a
hidden-invoker corner on principal change; final `renderCurrent` restores captured
header focus only when connected and not hidden, otherwise focuses the new main.
The changed-principal guard drops old private drafts/feedback and does not restore
old-owner focus. Failed reads can focus the still-visible recovery action.

A late visible-state defect was found during final closure, after the initial
zero-write/authority tests passed: a read-triggered401 correctly cleared the profile
and unlocked controls, but retained the previous `localeChangeFailed` message and
Read-latest button on the anonymous landing. The message falsely said the old draft
remained and the button silently did nothing because reading requires authentication.
Adding explicit visibility assertions reproduced it (**1 failed / 2 passed**).
The worker's narrow fix clears locale feedback during `becomeAnonymous` and projects
header controls after abort/new anonymous scope. Those explicit assertions now pass:
old draft guidance and recovery action disappear immediately; late read results cannot
restore them, alter anonymous language, or resurrect the old profile. Parent was
notified both of discovery and final closure; candidate15 had already been staged
after the preceding preliminary no-blocker message, and candidate16 is parent-owned.

Independent final verification (Node24.18.0):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root .temp review-account-read-latest.test.ts --maxWorkers=1
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account src/locale-recovery.test.ts src/locale-consistency.test.ts src/main.test.ts src/ui/shell.test.ts src/draft.test.ts --maxWorkers=1
```

Independent recovery probes: **3 passed**. Permanent focused suite: **5 files / 22
passed**, including the promoted recovery cases. Probes establish immediate both-
header unlock and hidden obsolete feedback on401, ignored late results, different-
principal canonical rendering with visible-main focus/no leaked draft/no API writes,
and rejection of recovery reads while a Profile Save remains admitted. Permanent
integration additionally exercises retained old+later field drafts, duplicate reads
and competing locale events while pending, failed recovery read/read-only Retry,
normal successful focus, and prior locale/Appearance contracts.

Parent owns real Browser fault/recovery acceptance and final staging gates. The
parent's fault was an OPTIONS-preflight failure; this review did not inspect hidden
headers/bodies or use network interception. No screenshot or320px claim is made;
the parent observed the requested narrow viewport did not actually become320px.
No Browser, mail, device, real credential/contact operation, backend change or
deployment was performed by this reviewer.
