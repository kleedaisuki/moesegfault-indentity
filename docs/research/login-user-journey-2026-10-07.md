# Login interaction repairs (2026-10-07)

## Scope and current evidence

Staging-oriented Identity/Login and Account user-journey work. Production deployment
is explicitly forbidden. These repairs are frontend-only; no API, credential format,
database migration, or established authentication contract changes.

The original browser connection repeatedly failed with Windows `realpath` EPERM.
After the user repaired permissions, a fresh validation agent successfully loaded
the prescribed Browser runtime and selected the in-app browser. The older root
connection still fails. Browser baseline and acceptance evidence belongs in
`browser-journey-2026-10-07.md`; the tests below are not an end-to-end journey.

## Repairs and rationale

### One owner for authentication

Password and Passkey login previously disabled only their respective buttons. Two
authentication attempts could overlap and race session/CSRF rotations. A shared
in-memory owner now locks both entry points, ignores duplicate submissions, and
restores both methods after failure. Abort does not render a stale failure message.

Final registration similarly has one owner, rechecked after asynchronous email
verification. The local avatar-preparation await is inside the error boundary;
preparation failure releases controls and preserves the draft. Navigation aborting
preparation cannot continue into account creation. Successful requests remain locked
through their completion UI rather than inviting another account-creation attempt.

### Independent credential-method validation

The whole registration form contains password minimum-length constraints. A user
typing a short password before choosing Passkey could be stopped by native form
validation even though that method does not use the password. Only the Passkey
submitter skips whole-form validation; its handler explicitly validates all shared
input/select fields and does not send password drafts to the Passkey endpoint.
Password registration retains minimum-length and matching checks.

### Actionable email resend state

An ordinary network/send error previously imposed another 60-second local wait,
even without a server rate-limit response. Transient errors now remain immediately
retryable, while explicit rate limits keep the existing cooldown. Server-provided
successful-send deadlines remain authoritative. Buttons show remaining seconds,
and timer projection cannot unlock final-registration or expired OAuth state.
Timers are released with the page AbortSignal. This does not bypass backend limits.

### Focus belongs to the active route

The route render completion handler checked the newest controller instead of the
controller for its own render. A late completion from an aborted route could steal
focus from a newer page. It now checks its captured signal; an entrypoint regression
resolves the superseded render last and proves that only the live page receives focus.

### A completed screen must not promise a redirect that is not running

The real staging registration succeeded but stayed at `/register` for more than
80 seconds while saying “Continuing.” This branch intentionally offers a manual
Account link, while OAuth/explicit-return branches already navigate automatically.
The three translations now describe a completed, ready-to-continue state without
changing those established navigation contracts.

## Reproducible local verification

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/login --maxWorkers=2
fnm exec --using=24.18.0 -- npm.cmd run build:login
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root packages/frontend-shared --maxWorkers=2
```

- Supported runtime: Node 24.18.0 (the initial system Node 22 run is not the final gate).
- Login: 19 files, 124 tests passed.
- Shared browser primitives: 5 files, 52 tests passed.
- TypeScript and Vite build passed: JS `index-Bx97MtzV.js` 66.62 kB / gzip
  23.76 kB; CSS `index-BZaXmuQz.css` 13.59 kB / gzip 3.86 kB.
- Regression coverage includes both login-method owners, short/mismatched password
  drafts with Passkey, required shared fields, failed-send retry, deadline/countdown,
  explicit rate limit, duplicate final registration, local preparation failure,
  and abort before account creation.
- No commit, push, or deployment by this workstream at this checkpoint.

## External grounding

- The [HTML Standard](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#form-submission-algorithm)
  distinguishes submitter validation policy from each control's constraints. Method
  selection should not accidentally impose another method's requirements.
- [Passkeys in the Wild, SOUPS 2026](https://www.usenix.org/conference/soups2026/presentation/ramat)
  examines 111 websites with 28 UX factors and finds uneven supporting experiences.
  Project inference: test cancellation, fallback, recovery, and cross-page continuation
  as seriously as the happy-path cryptographic ceremony. That study is context, not
  proof that these particular changes improve this product's measured usability.

Pending browser probes include registration validation and retained drafts, actual
email delivery/correction, Passkey cancellation and password fallback, success return
destinations, sign-out/sign-in, language-switch draft loss, and mobile/keyboard use.

## Password rejection copy follow-up (2026-10-07)

Root's real staging Browser wrong-password submission reached the server and
returned to an enabled retry form, but showed raw English `Authentication failed`
below a Chinese failure heading. The Login panel now substitutes an actionable
zh-CN/en/ja hint only at the `password_authentication` operation boundary when
HTTP status is 401 and the stable Problem code is `authentication_failed`.
`error_code` is authoritative when present; otherwise the exact current HTTPS
Problem type or historical URN type identifies that code. Server prose is never
parsed. The hint deliberately does not distinguish an unknown identifier from a
wrong password, and points to checking entries, Passkey, or account recovery.

The existing closed, opt-in diagnostic details and receipt are unchanged. Other
HTTP statuses/codes, browser-context failures, Passkey failures, and transport
failures retain their existing presentation. No authentication API, credential
semantics, retries, or lock ownership changed. Integration tests exercise all
three locales, retained input drafts, enabled retry controls, deliberate retry,
unchanged closed receipts, and negative operation/status/code/transport cases.
Local Node 24.18.0 verification: 20 Login test files / 148 tests passed; TypeScript
and Vite build passed. Current JS artifact: `index-C_xrOdym.js`. This is local
source/build evidence, not a staging deployment or post-change Browser claim.

## Return-destination continuity follow-up (2026-10-07)

Root observed that the real anonymous Account `/profile` login CTA supplied a valid
staging `return_uri`, but Login's Recovery link and Recovery's Back link discarded
it. A shared internal-auth-link builder now preserves only the destination accepted
by `validateAccountReturnUri`. Recovery, registration/sign-in alternatives, and
header/brand links use this builder. The shell updates its links from the live
Location on route changes so Back/Forward cannot retain an obsolete destination.
No `tx`, OAuth state, arbitrary query, fragment, credentials, or form draft enters
these links. The existing exact route/same-environment allowlist and authentication
completion precedence remain unchanged. Invalid or absent targets retain plain
`/login`, `/register`, and `/recovery` URLs, not a new implicit redirect.

New DOM integration tests follow Login -> Recovery -> Back -> Register -> Sign in
for a valid staging profile target, foreign and production targets, a target with
query secrets, and absent return state; header tests cover destination refresh and
removal. Node 24.18.0: all 21 Login test files / 154 tests passed; TypeScript/Vite
build passed, producing `index-DkXTkLc-.js`. No deployment or post-fix Browser
verification was performed by this implementation agent.

## Invalid recovery material follow-up (2026-10-07)

Root's non-destructive real Browser probe used synthetic invalid recovery material.
The form correctly re-enabled retry without opening a Passkey ceremony, but its
Chinese failure heading was followed by English `Recovery material is invalid`.
Worker `api.rs::start_recovery` deliberately returns the same HTTP 400 /
`invalid_transaction` for malformed material and a failed recovery-identity lookup.
The Login handler now localizes only that start-endpoint error boundary into a
non-enumerating zh-CN/en/ja hint: check the complete copied code, try another unused
code, or return to password/Passkey login. It does not assert whether a code was
used, expired, absent, or belongs to any account. Stable error-code recognition is
shared with password rejection, with explicit `error_code` taking precedence over
exact HTTPS/legacy URN type fallbacks; no English-message matching is used.

Browser-context, CSRF, rate-limit, authenticator-label, platform-ceremony, and
completion errors remain untouched. Draft fields and intentional retry remain;
invalid start material cannot open the mocked platform ceremony. Eight focused
integration cases cover all locales, retained drafts/retry, and nonmatching
operation/status/code failures. Latest Node 24.18.0 full Login verification:
22 files / 162 tests passed and TypeScript/Vite build passed; latest JS artifact
`index-C_OA_dyz.js`. This agent did not deploy or perform Browser credential changes.

## Explicit cancellation of a waiting sign-in Passkey (2026-10-07)

Root observed a real Login device-wait state persisting for minutes with both sign-in
methods disabled and no in-page password fallback. Login alone now exposes a
localized Cancel Passkey / Use password action while `getPasskey` is awaiting the
native chooser. Its attempt-specific AbortController is tied to route navigation.
Cancellation marks the attempt inactive, aborts the native request, immediately
releases the operation hold/locks even if the platform ignores abort indefinitely,
and focuses the preserved password draft. No password submission is automatic;
validated return destination, OAuth page state, and typed username/password remain.

The action is unavailable during start-transaction or server-completion mutations.
Once a native assertion is accepted, cancellation is synchronously removed before
the completion request starts: the UI never represents an in-flight authentication
mutation as safely undone. Each awaited boundary checks ownership. Late native
resolution/rejection cannot submit a credential, navigate, overwrite newer errors,
hide a newer chooser's cancellation action, or unlock a newer password operation.
Route abort also suppresses late start replies before native UI is invoked. Deferred
locale projection flushes on immediate, idempotent cancellation release; no old
finally block owns the rebuilt form. Existing native AbortSignal plumbing remains
unchanged; enrollment, registration, recovery, and credential semantics are untouched.

Nine new source tests cover the three language labels, a never-settling native
promise, retained credentials and destination on deliberate password retry, late
native resolve/reject, repeated cancellation, pending locale changes, route abort,
and the start/completion mutation boundaries. Node 24.18.0 full Login suite:
23 files / 171 tests passed; TypeScript/Vite build passed. Latest JS artifact:
`index-BNjGQiAN.js` (SHA-256
`d2c3543014188bc21f5cf4131da719164b235bbeb85d2b56a514f244a1091d9e`).
This is source/local evidence; no deployment or post-change Browser claim here.

## Explicit Account return from management ceremonies (2026-10-07)

Root's real staging Security -> Passkey enrollment page offered credential creation
and password step-up, but only a generic footer Account-home detour when changing
one's mind. Enrollment and recovery-code rotation now expose a secondary Return
to Account Center anchor using the existing exact `resolveAccountReturnUri`
allowlist/fallback. It remains available during initial session loading, ready
forms, pending/step-up and failure states, and completion. Completion reuses the
same safe link rather than introducing a duplicate destination or changing secret
copy/download semantics. Existing translated `continueAccount` copy is reused.

This is navigation, not credential cancellation or rollback: it starts no mutation,
changes no credential/session contract, and retains existing route abort ownership.
Foreign, cross-environment, or absent return values fall back to paired staging
Account home; an accepted `/security` return goes directly back there. Thirteen
DOM tests cover both management routes and these destination boundaries, plus
pending/step-up, failure, completion, and enrollment loading/initialization errors.
Node 24.18.0 full Login suite: 24 files / 184 tests passed; TypeScript/Vite build
passed with JS `index-CFk6ErB_.js`. No deployment or Browser mutation by this agent.

## Cross-tab registration binding lifetime and confirmation recovery (2026-10-07)

### Real journey and mechanism

The parent observed an owned registration challenge received at 10:24:02 UTC and
submitted after 10:35 UTC. A parallel Login management tab had initialized browser
context. Instead of actionable expiry feedback, the old tab rendered "CSRF validation
failed". This observation does not by itself prove which cookie was replaced, and
no browser cookie/token inspection was used. Source and real local Worker tests
establish the mechanism: registration extends its binding cookie to600 seconds,
while `GET /v1/browser-context` previously reissued the same shared cookie with
Max-Age300. A management initializer could therefore shorten a still-live challenge's
binding lifetime. Once absent, GET creates a new binding; its deterministic CSRF
HMAC differs. The idempotency boundary rejects cached-CSRF/current-cookie mismatch
with stable `invalid_request`403 before the email handler can report expiry. The
reported submit was also beyond the challenge's own ten-minute deadline.

### Repair and security contract

- `guard::browser_cookie` uses the common600-second binding retention window. Context
  GET preserves an existing cookie value and never shrinks a ten-minute ceremony to
  five minutes. All successful validated email renewals use the same common window;
  a near-expired verified-proof replay cannot shorten another tab's live WebAuthn
  ceremony. Starting another email challenge cancels prior pending/verified email
  rows, so the reproducible overlap is email proof plus WebAuthn, not two live email
  proofs for one binding.
- The shared cookie is binding material, not authorization. Every origin/CSRF/binding
  check, SQL challenge/proof/ceremony expiry, OAuth authority and consumption rule is
  unchanged. Initial anonymous binding persistence increases300→600 seconds (signup
  already supported600); this bounded retention tradeoff prevents cross-tab expiry
  interference. It does not extend mailbox proof or credential transaction authority.
- Browser CSRF is deterministic HMAC(binding, pepper), without a timestamp in its
  validation. `csrf_expires_at = now+300` remains advertised refresh guidance; it is
  not a separately enforced cryptographic deadline. We do not claim a five-minute
  token-expiry guarantee that the implementation does not provide.
- Registration challenge/proof lifetime is fixed600 seconds. WebAuthn registration,
  authentication and recovery use300 seconds. The separately configured account email
  verification TTL is bounded60..600; existing validation rejects601, and that flow
  authenticates an identity session rather than the anonymous browser binding.
- The inline verifier checks its known challenge deadline before issuing any confirm
  request. Expiry retains profile/password/avatar/code controls and directs the user
  to resend, without automatically sending another email or creating an account.
- For a live challenge, one explicit confirmation refreshes browser context and uses
  its current CSRF capability for exactly one mutation. It does not replace the
  challenge, replay on failure, restore an old cookie, rebind another browser, or read
  browser storage. An abort while awaiting context suppresses completion. A remaining
  `invalid_request`403 produces localized zh/en/ja context-change/resend guidance,
  not an incorrect-code diagnosis. Existing server authority remains final if the
  clock crosses expiry between the local check and the response.

### Reproducible evidence

Changed files: `crates/identity-worker/src/guard.rs`, `registration_email.rs`;
`apps/login/src/registration-email.ts`, `registration-email.test.ts`, `i18n.ts`;
`scripts/tests/registration-email.mjs`. Added frontend regressions cover fresh-CSRF
single confirmation, expiry before context/confirmation requests, preserved draft/code
with no automatic retry on403, and abort during context refresh.

The real release-Wasm/Miniflare/D1 harness checks context GET retains cookie identity
and Max-Age600, same-binding fresh-CSRF confirms, stale-CSRF/new-binding rejects403,
new-binding fresh-CSRF cannot claim the original challenge, and an expired challenge
still rejects after GET refresh. A verified proof with100 seconds remaining starts a
300-second WebAuthn ceremony, then is replayed: cookie remains600 while the proof's
returned deadline remains100. Time-relative SQL fixtures preserve the schema's
`expires_at > created_at` and maximum600-second constraint; the first expired-row
fixture violated that CHECK and was corrected rather than weakening the schema.

Validation on Node24.18.0 / Windows:

- Full Login:24 files /188 tests passed; TypeScript+Vite build passed.
- Login entry JS `index-BN_aFskc.js`; CSS `index-BZaXmuQz.css`.
- `cargo test -p identity-worker guard::tests`:9 passed.
- `cargo fmt --all --check`, warning-free Worker Clippy and focused diff check passed.
- `npm run build:identity` release Wasm rebuilt after final Rust changes.
- `node scripts/tests/registration-email.mjs` passed all existing and new assertions.
  Its expected deferred-mail messages and deliberate profile-batch rollback fixture
  are local-only; it does not demonstrate external email delivery.

No migration, deployment, commit, mailbox or Browser operation was performed by this
source workstream. Parent owns the live expiry tab, staging deployment and visible
post-fix acceptance. Root independently assigned review of this lifetime contract.

## Zero-Passkey recovery rotation prerequisite (2026-10-07)

Root's real password-registered staging fixture had no Passkeys. Clicking rotation
opened an indefinite device-confirmation path that the fixture could not satisfy.
Backend `account.rs::rotate_recovery_codes` intentionally requires `recent_passkey`;
this repair does not relax that policy or issue recovery material using a password.
The existing authenticated `listAuthenticators` endpoint returns the current
registered-key management projection, including revoked markers, without requiring
a native assertion. On explicit Rotate, Login now reads that list before entering
the existing rotation/step-up coordinator. An empty or revoked-only set yields a
localized explanation and an enrollment link preserving only the validated Account
return destination. The existing password-confirmation bootstrap on enrollment can
add a first key; the user returns to Account to request rotation separately.

List errors remain errors, never evidence of zero keys. An active key retains the
original coordinator/backend policy. Duplicate clicks share one in-flight check;
a route abort suppresses late read results and cannot initiate a chooser/mutation.
The existing Return-to-Account link remains available. No credentials are created,
revoked, rotated, or automatically submitted by this guard. There is one extra
small authenticated GET only when the user explicitly requests rotation, not during
page load or general authentication.

Eight new focused DOM cases cover all locales, empty/revoked-only keys, active-key
coordinator continuity, failed list/retry, duplicate/aborted reads, and rejected
return destinations. The existing management-return tests now supply an active-key
list when exercising actual rotation. Latest shared-worktree Node 24.18.0 full
Login suite: 25 files / 196 tests passed; TypeScript/Vite build passed with
`index-LwUtrHyJ.js` (including concurrent registration-context repairs). This agent
performed no Browser, deployment, mail, or real credential mutation.

## Grounding the first-key recovery path

[OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
and [OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
support reauthentication for sensitive credential changes; they do not mandate
this product's exact recent-Passkey-only rotation policy. Product inference:
explain the first-key bootstrap dependency rather than downgrading that policy.
The bootstrap must confirm the rendered principal, not silently treat a login to
another account as consent to enroll a credential there.

[W3C Web Authentication](https://www.w3.org/TR/webauthn/) distinguishes creating
credentials from obtaining assertions and defines cancellation/NotAllowedError
outcomes. An observed cancellation message alone does not prove platform enrollment
is unsupported, nor even that the operation reached credential creation: the old
zero-key step-up assertion could fail first. Root source/Browser correlation now
keeps that distinction explicit. The already-cited SOUPS Passkeys-in-the-Wild study
provides UX context for testing bootstrap/recovery/cancellation, not proof of this
implementation's security or measured usability.

## First-key bootstrap and immutable management-account intent (2026-10-07)

Root's real zero-key enrollment Add action produced cancellation/timeout feedback,
but source inspection showed that the old generic step-up coordinator could request
an assertion before it ever tried credential creation. This is not evidence that
platform `credentials.create` failed. Worker `start_authenticator_registration`
already permits a first credential when the account has recent password or Passkey
authentication; subsequent additions require recent Passkey authentication.

Explicit Add now reads active authenticators. A zero/revoked-only set refreshes the
same account session/CSRF and requests the existing first-key registration endpoint
directly. Only its stable HTTP 403 `reauthentication_required` opens/focuses the
existing password-confirmation form, with localized first-key guidance; it never
asks the zero-key user for a nonexistent assertion. Other codes/statuses/list errors
remain ordinary failures. Active-key additions retain the original coordinator.
Both Add and password confirmation share one operation owner/lock. The label and
safe Account return destination remain; errors now say Passkey addition failed,
not account registration failed. Await boundaries suppress route-aborted continuations.

A related ownership risk is source-derived and independently reproducible with
synthetic sessions, not a claimed cross-account Browser exploit: another tab may
change the shared cookie while a management page still represents account A.
Both enrollment and rotation now capture an immutable rendered principal. Rotation
awaits initial session loading like enrollment, retaining Return navigation on
loading/failure. Fresh direct-session reads and password-authentication results must
match that principal. Username confirmation is prefilled/readonly where available,
but readonly is not trusted as enforcement. A mismatch stops before enrollment.
The exported password helper's new optional final principal argument preserves
legacy callers; the actual management UI always supplies the account binding.

The coordinator factory now requires an owner principal, caches by API client plus
principal, and validates fresh session reads before initial mutation and stale-CSRF
retry. A completed step-up account must match before token adoption/generation
promotion/retry. The optional StepUpPorts result validator preserves generic module
callers. Explicit AbortSignal checkpoints after asynchronous authority boundaries
prevent ignored native/fetch aborts from continuing authentication or adopting a
late token. The immutable owner is not overwritten when another account opens a
new management page. These safeguards cover both existing coordinator consumers,
not just the password-bootstrap branch, without relaxing backend authentication.

Seventeen bootstrap tests cover recent/stale zero-key behavior, three-language
fallback, active-key coordinator continuity, nonmatching failures, shared locking,
account mismatches, and four abort boundaries. Ten real-coordinator integration
cases cover both routes' initial/refresh/assertion account mismatches, ignored late
native aborts, and API-client cache separation across intentionally rendered A/B
pages. Full Node 24.18.0 Login suite: 27 files / 223 tests passed; TypeScript/Vite
build passed, latest JS `index-B8Zhaqxu.js`. No deployment, Browser, mail, or real
credential mutation was performed by this implementation agent.
