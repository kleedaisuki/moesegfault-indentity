# Identity and Account real-user journey (2026-10-07)

## Objective and boundaries

Act as real users of staging through the in-app Browser, repair product defects,
and repeat the affected journeys. Local unit/DOM tests are supporting evidence,
not substitutes for registration, delivered mail, navigation, and reload behavior.
Production deployment, purchases, real-user account mutation, and unrelated mailbox
reads are outside this task. All temporary artifacts stay under repository `.temp`
or `.cache`. Existing unrelated untracked documentation is preserved.

The user explicitly authorized staging registration with owned amail addresses.
An owned dedicated test alias has been provisioned and is active. A unique generated
staging-only credential is held in an ACL-restricted ignored task directory. Neither
passwords, OTPs, mailbox bodies, session/CSRF tokens, nor recovery codes belong in
these notes, test logs, Git, or public support reports. Mail retrieval does not mark
or delete deliveries. First-use automatic OpenRouter indexing was disclosed.

## Environment recovery

The original Node browser context failed importing the official Browser runtime:
Windows `realpath` EPERM affected every tested volume path. After the user repaired
permissions, shell Node resolved the official path successfully; resetting the old
root browser context still did not recover it. A fresh validation-agent context
successfully imported the same official module and selected exactly `iab`.

No custom browser protocol, raw CDP, browser-profile inspection, or alternate browser
is used for the accepted journey. An earlier Computer Use fallback stopped before
interaction because it could not establish the current URL for its safety check.
The user then explicitly selected the in-app Browser; subsequent work stays there.

Browser observations can be slow. A failed/timed-out mouse input is not a website
defect without an observable page effect. Keyboard activation of the Sign-up link
succeeded after mouse dispatch timed out. Live tab enumeration, not a stale lock
file or an observation timeout, determines whether a tab still exists.

## Journey acceptance matrix

The full objective remains open until browser evidence covers the requested journeys.

| Journey | Required behavior | Current evidence / next gate |
| --- | --- | --- |
| Anonymous entry | Protected routes become anonymous after revocation and preserve intended return | Actual Profile anonymous landing and exact staging/profile CTA passed after candidate9 sign-out; anonymous zh/en switching passed |
| Registration validation | Shared fields required independently of password/Passkey method | Actual empty shared-field Passkey attempt focuses invalid display_name/username without a platform ceremony; local cross-method regressions passed |
| Email verification | Delivered mail, correction/resend, proof survives cosmetic locale changes | Actual original signup wrong/correct verification and creation passed; actual new owned-alias resend/countdown/delivery/verification and verified-state locale retention passed; natural verified-proof expiry with preserved draft passed; candidate7 actual delayed cross-tab confirmation beyond old300s window passed; full adversarial browser races not claimed |
| Fresh account creation | Clear continuation and complete durable profile | Actual owned account registration, full seven-field save/reload, avatar workflow passed; latest proof-only probe created no second account |
| Password login / destination | Wrong password recoverable; correct login returns exactly to requested Account route | Actual localized wrong/correct retry and exact profile return passed; latest Recovery->Back destination and invalid-recovery guidance passed; latest actual Passkey page-cancel -> preserved-password login returns to profile |
| Sign-out / session lifecycle | Explicit consent, cancel retains draft/auth, approve revokes current session | Candidate9 actual desktop/mobile cancel, unlock/focus restoration, explicit approve->Login->protected Profile anonymous passed; old owned session targeted revoke passed with current preserved |
| Profile/avatar/contact safety | Save/reload, multiline links, canonical refresh does not erase newer drafts | Actual full save/reload, contact-triggered draft preservation, stable save acknowledgement, synthetic avatar preview/cancel/upload/decode/removal passed; draft discard nonresurrection passed |
| Preferences/responsive UI | Three languages, safe dialog focus and usable 320px controls | Actual zh/en/ja dialog labels, locale cancel/approve, bidirectional Tab wrap, Escape and mobile focus passed; 320px DOM geometry no overflow; screenshot capture failed, no pixel-perfect claim |
| Contacts | Add/verify/promote/revert/remove only owned test contact | Actual delivered OTP, wrong/correct correction, promote/revert, secondary removal passed; reserved fictitious mobile add/unavailable-verification diagnosis/fixed capability notice/remove/reload passed; only verified primary remains |
| Security/recovery | Clear failure/fallback and safe credential ceremonies | Actual landing/return links, localized invalid recovery rejection, page-cancel/password fallback passed; zero-key rotation guidance fixed and passed on candidate9 Login without native wait; candidate10 Account password policy/invalid scalar validation passed with synthetic input; successful native enrollment/password change/recovery rotation remain unperformed |
| History/document exits | Native history preserves drafts; explicit discard is final | Actual Back/Forward draft restoration, pending-modal Back cancellation and hidden-draft sign-out cancellation passed; dirty full navigation aborted with draft retained, identical clean navigation passed; native warning pixels/buttons unobserved |
| Devices/app grants | Owned session targeted revocation; clear app boundary | Actual old-session revoke with current retained; apps now show only test Subscribe openid/profile grant after owned SSO; actual test Subscribe grant revocation and reload-empty state passed; no independent-device claim |
| Subscriptions | Same fixture after reconnect; no purchase | Actual anonymous viewer/reconnect SSO/matching fixture/authenticated iframe return passed; no billing, activation or purchase mutation |
Detailed driver observations are recorded in `browser-journey-2026-10-07.md` as they
occur, without upgrading unperformed steps to “passed.” Feature-specific changes
and commands live in `login-user-journey-2026-10-07.md` and
`account-user-journey-2026-10-07.md`.

## Repair checkpoint

- Login authentication methods and final registration have one in-memory owner.
- Passkey registration ignores irrelevant short/mismatched password drafts while
  preserving shared-field validation.
- Email send transient failures remain retryable; explicit rate limits and
  successful-send cooldowns are still enforced and visibly counted down.
- Account mobile sign-out shares the existing first-party revocation command.
- Profile links use a multiline control instead of a newline-stripping text input.
- Profile save accepts submitted values only; newer edits remain dirty and visible.
- Navigation/document-exit guards prevent several accidental draft-loss paths.
- Further coordinated profile-refresh and locale handling is being completed.

At the predeployment checkpoint, Login 124 tests, Account 85 tests, and shared primitives 52 tests
pass; both frontend TypeScript/Vite builds pass. No deployment, commit, or push has
been performed. Staging acceptance must use the final built candidate rather than
assuming that the currently served site already includes local changes.

## Backend contract defect found during the journey

The existing ProfileWire and account read projection omit all seven extended profile
fields used by the Account form. UpdateAccountRequest accepts only display_name and
locale with deny_unknown_fields, so the existing full form cannot save its submitted
bio/status/pronouns/favorite/interests/links/visibility payload. Registration writes
some of these details, but the account read model also hides them.

The details table already contains the intended columns. A backend workstream is
completing the established read/write contract without a migration, preserving
omitted-field semantics and validating clear operations. Actual pre/post-fix browser
profile readback and save are acceptance gates, not presumed passed from source tests.

## Staging candidate 1 (15:03-15:04 Asia/Singapore)

Only the three allowlisted staging Workers were updated; no production command,
migration, commit, push, or main-branch pipeline was executed. The ephemeral driver
explicitly passed the empty top-level Wrangler environment and checked the expected
`moesegfault-*-staging` name before each operation. Source and artifact archives and
SHA-256 manifests are retained in the protected ignored task directory.

| Unit | Version at 100% | Public frontend entry |
| --- | --- | --- |
| Identity staging | `953acbcf-aca8-4d22-ab1c-187d0684f82d` | release Wasm |
| Login staging | `18f564c6-d394-4a47-a470-0f9fb4565564` | `index-Bx97MtzV.js` |
| Account staging | `98777d3e-2173-4343-924f-dcae8cb93f1e` | `index-D_BcJOyM.js` |

Deployment-list readback agrees with all three versions. Public checks passed D1
health, staging OIDC issuer, paired frontend HTML/CSP and expected entry assets,
unauthenticated `/v1/me` 401 with credentialed Account CORS, and PATCH preflight 204.
These are rollout checks, not authenticated-browser acceptance.

Final candidate gates: Rust formatting and warning-free Worker Clippy, workspace
14 domain + 90 Worker unit tests and one domain doc-test; release Wasm rebuild;
actual Worker/D1 registration/profile/null/legacy/atomic-rollback harness; OpenAPI
lint; Node 24.18.0 Login 124, Account 85, shared 52 tests and both frontend builds.
Two pre-existing Worker doc examples remain intentionally ignored by their tests.

The real browser baseline has now completed wrong/correct OTP and fresh password
registration, reached authenticated Account, and demonstrated missing registration
profile readback plus disappearing status after save. Candidate 1 browser retest is
in progress. A separate browser probe confirmed silent registration draft loss on
language change; a subsequent Login-specific candidate is being implemented.

## Candidate 2 checkpoint (15:22 Asia/Singapore)

Account candidate 2 deployed to staging only: version
`5927d0ee-e465-4e5c-825b-7381b127485a`, entry `index-B2FvE7b8.js`.
Root independently reran 17 files / 86 tests and the TypeScript/Vite build.
It adds stable post-refresh save feedback and route-owned Back/Forward draft
retention with explicit discard semantics. Actual browser retest is pending.

Login candidate 2 passed root-independent 20 files / 136 tests and build,
entry `index-DMwTq7aP.js`. It preserves the actual route/form ownership across
cosmetic locale changes and permanently disposes pending projection ownership on
navigation abort. Its first staging deployment failed before asset upload with
Wrangler connectivity failure. Public staging HTTPS checks in the same interval
failed with unexpected EOF; no successful Login candidate 2 rollout is claimed.
The candidate 1 backend remains unchanged; no database migration or production
operation has been run.

Candidate 1 actual browser profile reload independently retained display name,
all seven extended profile fields, two newline-separated URLs, private visibility,
and Asia/Singapore timezone. The full journey remains open: contact verification,
security/recovery, actual logout/login, responsive parity and candidate 2 affected
interaction checks are still gates. Browser-native dialog/input limitations and
network failures are not product defects merely because a tool timed out.

### Candidate 2b Login rollout and review closure

Independent review found and locally demonstrated a combined-interaction race:
submit-driven email confirmation could release its lifecycle hold after a queued
language change, replacing the form just before the original submit continuation
started registration. The replacement form had a different unlocked local owner.
This was fixed before a successful candidate-2 Login rollout by acquiring one
owner/hold before the first verification await, with one balanced finally and a
terminal account-created guard. Formal success/failure/no-proof regression cases
now assert one creation request. Reviewer independently inverted the original
reproduction and confirmed the same visible form stays locked with one call.
See `user-journey-review-2026-10-07.md` for the closed finding and exit audit.

Root-independent Login validation: **20 files / 139 tests**, TypeScript/Vite build.
Login staging deploy succeeded: **06a68e17-76c6-4dde-8a50-95d98eb97be2**,
entry **index-C13Yh2T0.js**. Explicit-proxy public HTML GET independently confirms
this entry. Account public HTML likewise confirms **index-B2FvE7b8.js**. Subsequent
Wrangler deployment-list requests remain intermittently failing with connectivity
errors, so these candidate versions are deployment-output plus public-asset
confirmation, not a successful second deployment-list readback. No redeployment is
needed to solve a readback request failure.

Actual read-only browser Account Security shows zero Passkeys, enabled password,
recovery readiness and the pending TOTP capability; Sessions shows one current
password session. Apps initially showed the global network/retry state, then one
normal reload displayed its correct empty state. Subscriptions initially had its
own anonymous viewer; explicit reconnect completed ordinary SSO without password
or consent interaction and showed the exact owned fixture account. No purchase,
activation, security change or third-party-grant revocation was performed.

## Candidate 3 Account contact ownership

A bounded contract check found confirmation/resend had independent locks even
though resending replaces the very transaction being confirmed. Add-contact also
lacked a synchronous in-flight guard. These were repaired without backend or
schema changes. Failure preserves the existing code/challenge and releases the
shared operation owner; abort suppresses stale results/refresh. New focused DOM
regressions plus actual local Worker/D1 wrong-code correction, promotion, deletion
and empty readback passed (synthetic local digest only; not real mail evidence).
Root reran Account **18 files / 93 tests** and TypeScript/Vite build.
Account staging candidate 3 deployed successfully:
**5a1e6079-192f-4772-9cd1-d7ac5386b5ee**, **index-BBBNyo9t.js**.
No Identity/backend redeployment, migration, commit, push or production operation.

## Candidate 4 contact feedback presentation

Account **18 files / 117 tests** and TypeScript/Vite build passed independently
under root before staging-only deployment. Version
**efdc4a93-0e35-4b47-ad56-853f828f83cd**, entry **index-CMbe9rQB.js**.
Wrong-code/expired/auth/network/rate-limit feedback now uses actionable localized
steps based on stable Problem Details codes; diagnostic IDs remain available in
closed native details. No English-message matching, OTP echo, invented cooldown,
backend schema/API change or production deployment was introduced.

Actual candidate 3 contact journey is now complete: real owned-mail delivery,
wrong-code correction, successful verification, secondary-primary/original-primary
round trip, explicit human-approved removal of the secondary contact. Root also
verified synthetic avatar selection/preview/cancel; upload remains pending. See
the browser evidence note for the actual loaded bundle, code privacy and limits.

## Candidates 5 and 6: stable avatar feedback and pre-revocation draft decision

Candidate5 Account: `246e8bdc-4462-4f86-b2ca-a3b7905ad6bd`,
`index-DYPspyGU.js`. Root-independent 118 tests/build passed. Actual Browser
human-approved avatar removal then showed default logo and stable saved feedback.
The prior uploaded staging WebP survived reload and decoded to real 64x64 pixels.
320x740 DOM geometry reported document width exactly320 and no measured right-edge
overflow in main/header/navigation; mobile signout stayed visible. Screenshot at
that viewport failed, so comprehensive pixel-level acceptance is not claimed.
Theme UI cycled to actual dark DOM preference/theme and back to system/light.

Source review then found SignOut omitted the same draft decision used by navigation:
it revoked the session and cleared drafts before beforeunload could warn. Candidate6
uses the existing canDiscardDraft BEFORE revocation, including hidden history drafts;
no new confirmation machinery, post-revocation warning or user-facing API change.
Integrated tests cover visible/hidden cancellation, unlocked responsive controls,
clean retry, and approved single-confirmation cleanup. Root-independent 118 tests
and build passed; Account staging deployed as
`a7815828-d103-493a-beb7-a80865471a9b`, `index-DuwvYrvm.js`.
Actual cancellation and logout/relogin acceptance is still in progress. Identity
and Login versions are unchanged. No production, schema migration, commit or push.

## Login candidate 3 actionable credential rejection

Root-independent **20 files / 148 tests** and build passed; staging Login version
**a886b337-ae8f-4429-a427-3c1e9f0d05d5**, entry **index-C_xrOdym.js**.
Root navigated the actual same staging `/login?return_uri=.../profile`, observed
that exact loaded module, and submitted one wrong fixture password. The main UI
now says to check email/username/password and offers Passkey or recovery; retry
remains enabled. No server English-string parsing or account-existence disclosure.
This is actual post-fix browser feedback, not just a typed-error test. Correct
password/deep-link behavior already passed on candidate2b and is being rechecked
on candidate3. The subsequent successful sign-in may create another session;
actual Sessions, not fresh tabs, will determine whether there is another session
to use for targeted revocation testing.

## Candidate8 explicit consent and shared network messages

Root-independent Account **19 files / 137 tests** and TypeScript/Vite build passed.
Dialog architecture had an independent focused review and combined-save race test;
no substantive findings remained. Source uses native HTML dialog's modal/inert
platform behavior with safe initial focus and explicit localized leave/language/
sign-out actions. Browser document-exit warnings remain native and separate.
Ordinary mutation and global network failures now share a small formatter, keeping
non-network details and the old errorText two-argument contract. Actual API-client
wrapping, dirty retry, and translated Sessions mutation failures have regressions.

Several Wrangler network failures were terminal; one uploaded assets but did not
confirm Worker publication. Public HTML then still served candidate6, so that
attempt was NOT called deployed. Source/artifact candidate8 was archived only
after final root tests/build. Using the already-installed Node26.10.0 for Wrangler
(without changing package/global proxy/TLS settings) eventually deployed candidate8:
**4ed4427e-f546-4de0-958b-857d9784cb79**, JS **index-CKMvzvPn.js**,
CSS **index-Cz7B_ZUW.css**. Frontend tests/build still used supported Node24.18.0.
No production, schema migration, commit, push or forced network/security bypass.
Browser loaded-asset and explicit consent acceptance are in progress.

## Account candidate9: real keyboard boundary repair

Root independently ran all Account tests (19 files / 139 tests), TypeScript/Vite
build, and git diff --check before deploying only the allowlisted staging worker
with explicit empty Wrangler env under Node26.10.0. Successful version:
`134d30e8-fe1a-4522-8a6f-7dc8ef5bee89`; entry `index-S-Z4jL6-.js`, CSS
`index-Cz7B_ZUW.css`. No production deployment, migrations, commits or pushes.
The candidate fixes the actual candidate8 dialog Tab boundary observation; loaded
asset confirmation and browser acceptance remain separate next steps.


## Latest root checkpoint (2026-10-07, 18:00 local onward)

| Unit | Confirmed staging version | Actual loaded entry | Root local verification |
| --- | --- | --- | --- |
| Identity | 953acbcf-aca8-4d22-ab1c-187d0684f82d | release Wasm | Previously documented Rust/Worker-D1 regressions |
| Account | 134d30e8-fe1a-4522-8a6f-7dc8ef5bee89 | index-S-Z4jL6-.js | 19 files / 139 tests, build, whitespace |
| Login | 2ffb34b9-d548-4c09-b4dd-d9c7c4a18ef1 | index-BNjGQiAN.js | 23 files / 171 tests, build, whitespace |

Latest Login actual cancellation-to-password fallback is detailed in the driver
record. It supersedes the matrix's older human-cancel wait: page-level cancellation
and password fallback are now passed, while native chooser cancellation itself is
not claimed. Recovery->Back preserves the profile destination and real fallback
login returns there without refilling the credential draft.

A locator Alt+ArrowLeft probe did not trigger browser navigation (Profile remained
visible). This is an unsupported/ineffective shortcut path, not evidence of an
application history bug or a passed Back/Forward test. Root cleared the synthetic
probe draft to its saved baseline and navigated normally to Security. Remaining
native history/document-exit and human-only credential mutation gates are not
silently removed from scope. No production deployment, migration, commit or push.

Protected ignored source/build archives:
- candidate9-account.tgz SHA256 0E09B00A4552F32E2DD830001D8B81CE3B7DEC9A5DB39C2E6D292BFC7858ECCA
- candidate4-login.tgz SHA256 1675A2EEEA59B6EE8F50C7CDC1E283058D0BBA0C104A09CAA4F2CDA69EE014C9

The Login archive is the pre-cancel candidate4 snapshot, deliberately not labelled
candidate5. Latest source and entry hash remain recorded in the implementation note.





## Current authoritative staging and acceptance checkpoint

Identity `d10ba9ad-c44a-4bdb-9815-9fde486c9801`, Login
`72baa513-5865-4b49-804d-96c786575730` / `index-y4d-xBqN.js`, Account
`56e1b83d-8fe6-4add-9e72-e51eb8ac1031` / `index-BcRIcomX.js` (candidate16).
Root independently passed Login234, Account231, frontend-shared70, full Rust
90+14+1doc, fmt/Clippy, release Wasm, actual local Worker/D1 registration/contact,
password-security/recovery-authority regressions. Independent review closed the
browser-binding fix without an open security finding. Root actual staging evidence
now includes manager roundtrip and >300s cross-tab original-code confirmation.

The human explicitly authorized autonomous staging-fixture operations. The owned
Subscribe grant has now been revoked through UI and its absence persisted after
reload; that is no longer an approval gate. Native credential creation, password
change, and successful recovery-code rotation remain unperformed live ceremonies,
not passed journeys. After a test-triggered device prompt disturbed the human,
root exited enrollment and committed not to automatically trigger further device
credential prompts. Do not substitute another browser or downgrade server policy
to bypass this boundary, and do not label the entire original goal complete.
No production deployment, migration, commit or push has occurred.

Final independent unchanged-Account/shared/OpenAPI gates also passed:
Account19 files139, frontend-shared5 files52, Redocly OpenAPI validation. Current
source/build archives in protected ignored taskdir:
- candidate7-login.tgz SHA256690DC8092DFC1D35A4385B9028B5ADA843DD0574DC49BA378DCC585579AAF0FF
- candidate7-identity.tgz SHA2560CB8B46A76FB62A67B0A4D1B83D56FEAB9A9047F633CB0C5EB615E43A789E014
These are source/artifact snapshots, not commits or production releases. No owned
local Vite/validation/deployment process remains live after completed gate sessions.

## Login candidate9: first-key bootstrap and account ownership closure

Root independently reran all Login tests (27 files / 223 passed), TypeScript/Vite
build, and whitespace checks. Independent review closed the reproduced cross-account
CSRF-replay defect with 41 focused tests plus a separate fixed reproduction. Both
management routes bind the rendered principal before fresh authority adoption;
first-key enrollment no longer requests an assertion from an empty key set.

Only the allowlisted Login staging Worker was deployed, using the existing staging
helper with a real empty environment argv under Node26.10.0. Publication version
and actual Browser-loaded entry match the authoritative checkpoint above. Bundle
SHA256: `BD85C8753E40F3CEAB5AC96ADD3EADC0F6C4FFB3EA487DA7974659D2C6BC2A52`.
Protected ignored source/build snapshot `candidate9-login.tgz` SHA256:
`ED385D59CDABBD4EF9B4D0DCBCE010D906616A68FB27E9D4FAFAAE4AD7B100DF`.

Actual post-deployment Browser: zero-key rotation displays first-key/password
guidance, ordinary enrollment navigation retains Security return, confirmation
identifier is prefilled/readonly, and returning to Account shows zero Passkeys.
Root intentionally did not submit Add/password confirmation or launch a native
ceremony again. Stale-password bootstrap and cross-account authority regressions
are source/test-reviewed, not mislabeled as new live-device acceptance. No
production deployment, migration, commit, push, new key, password change, or
recovery-code issuance occurred in this checkpoint.

## Account candidate10: password ownership and truthful mobile capability

Root independently passed20 Account files/170 tests, TypeScript/Vite and whitespace
checks; independent bounded review passed53 password/page/i18n tests and44 contact/
i18n tests without blockers (overlapping runs, not additive unique-test counts).
Only Account staging was updated. An initial Wrangler connectivity failure was
terminal before upload; one ordinary retry published version
`da85a99d-8995-4693-ae75-2f40cd1e17b2`. Actual Browser loaded
`/assets/index-DHWoPRyY.js`, SHA256
`ACA95B3E61D374ECC82D13CBE22EA033BE9D7697019D2DE9D5295573A3EA326C`.
Protected source/build archive `candidate10-account.tgz` SHA256
`11C61BAD58E1B1FE03B9D5BBA9B9BDB14B9A0DB970E68AAA9FC6F8A83F804984`.

Actual Browser gates completed: unavailable-SMS notice on the pending fictional
mobile row, no impossible Verify action, matching described pre-add disclosure,
row removal and reload-confirmed absence; password policy hint, eight-astral-scalar
invalid feedback/focus/custom validity using only synthetic input, and reload with
both password fields empty. No live password change/removal or device ceremony was
performed. Final fixture remains one verified primary email, default avatar, durable
profile, zero Passkeys, enabled original password/recovery posture. No production,
schema migration, commit or push. Full original security ceremonies are still not
proven complete, and the device-prompt boundary remains in force.

## Human deferral of device-dependent acceptance

The human explicitly deferred real Passkey testing because they are away from the
computer. Do not trigger native credential prompts or request immediate device
handoff. Enrollment, Passkey sign-in and dependent successful recovery ceremonies
remain deferred, not passed. This is not withdrawal of autonomous staging authority
for ordinary owned-fixture UI testing, nor a request to pause the entire goal.
Continue meaningful non-device journey repair without repeatedly asking for the
same staging permission or rebranding supporting tests as native acceptance.

## Shared mobile input: Login candidate10 / Account candidate11

Root independently ran frontend-shared70 tests/typecheck, Account179 tests, Login234
tests, both TypeScript/Vite builds and whitespace checks against final corrected
markup. Independent focused review and additional adversarial probes found no
remaining blocker. Only the two frontend staging Workers were deployed, with
versions/actual loaded entries reflected in the authoritative checkpoint above.
Identity/backend contracts, migrations, package dependencies, production, Git commits
and pushes are unchanged by this frontend repair.

The shared parser accepts national/formatted input and explicit matching+country
input for the six existing selectors. It rejects country conflicts and ambiguous
double-zero international prefixes instead of silently targeting a different number.
Signup validates before mail/proof consumption and now associates a real localized
mobile label with its input. This is formatting/backend-policy alignment, not proof
of a phone's allocation, ownership, reachability, or SMS capability.

Root actual Browser acceptance on final entries:
- Account selected+86 with the reserved full+1 example: localized conflict, number
  focus, unchanged selection and no mobile row. Changing only the country to+1 and
  retrying saved canonical+12025550107. No SMS/action capability was invented.
- Account selected+86 with0012025550107: localized explicit+ guidance, unchanged
  country and no additional row (only the intentionally saved fixture phone).
- Register negative-password-method submission with synthetic inputs and conflicting
  phone: localized conflict, mobile focus/aria-invalid, retry enabled, email-code
  UI remained hidden. No OTP, proof or account creation step was completed.
- Register mobile is named '手机号（可选）' rather than only its placeholder; actual
  label and described-format-hint associations were inspected.
- Root closed the negative signup tab, removed only the synthetic phone and reloaded:
  one original contact, zero mobile rows, default avatar. Retained sole tab is Security.

Protected source/build snapshots (pre-Browser acceptance notes):
- candidate10-login.tgz SHA256288BECB7B5E3C9BD0D08938C00CA9DD0CA9659F8A253D76A8FD757287FADE0BC
- candidate11-account.tgz SHA2569DE025F23D7632E3FB755E21155277E2D29FD72C6155B6BACC00601777FCD71E

Human-deferred device journeys and unperformed live password mutation remain clearly
unverified. Do not mark the original entire-security objective complete on the basis
of these successful non-device input journeys.

## Previous completion audit (superseded by continued non-device testing)

The original full journey is not complete. The matrix and driver record distinguish
actual staging signup/mail/login/profile/contact/session/grant/subscription/history
observations from supporting deterministic tests. Latest mobile-input repair has
actual post-deployment Browser acceptance on both entry assets; the normal account
fixture was restored and all owned implementation/test/deploy operations are terminal.
No independent-device claim, screenshot-perfect claim, native warning-button claim,
fresh latest-entry signup-with-mobile claim, or credential-change success is inferred.

Remaining substantive acceptance requires local human/device interaction:
- Create the first real Passkey, exercise successful assertion login/step-up, then
  credential metadata/revocation and dependent recovery-code issuance/use. The human
  explicitly deferred this while away from their computer. Do not reopen a device
  prompt merely to advance a test or weaken backend authentication policy.
- Complete a valid password replacement/removal/restoration through the required
  final credential-change handoff. Synthetic invalid-input Browser probes and local
  Worker/DOM security tests are not replacements for this successful live journey.

The same human/device-availability boundary has persisted through the three latest
goal turns while non-device password/mobile defects were repaired and staged. There
is no current implementation/review/deploy job to wait for, no open source-review
blocker, and no new non-device defect established by the completed probes. Further
progress on the remaining live security acceptance now requires the deferred human
handoff/device conditions, not renewed generic staging authority. Retain the original
objective and these unverified items; do not call the goal complete or manufacture
additional work solely to keep the goal running. The retained Browser tab is clean
Account staging Security; no device wait, synthetic phone, or signup draft remains.

## Continue non-device journeys: correct the premature stop

The human clarified that deferring Passkey tests must not stop work on other
journeys. The previous completion/blocking assessment above was too narrow and is
historical, not current authority to stop. Local-device acceptance remains deferred;
continue ordinary staging Profile/Account interaction testing without asking the
human to return to their computer or reauthorize disposable fixture mutations.

Root resumed the actual staging Profile using the official built-in Browser. Two
material defects are now verified on Account candidate11:
- Eleven valid fictional example.com links were submitted. After canonical refresh,
  only the first ten remained; the eleventh was silently dropped by frontend slicing.
- An invalid profile link plus valid timezoneUTC returned 'Invalid profile fields'.
  A separate fresh same-browser Profile showed original links but timezoneUTC: one
  half of the composite Save committed despite the undifferentiated failure.

Root restored and read back the original two links and Asia/Singapore timezone.
Independent deterministic reproduction additionally shows fail-fast Promise.all
unlocking while its sibling write is still pending, allowing that old write to
overwrite a later Save. A single implementation owner is repairing backend-aligned
preflight/no slicing and whole-attempt/partial-save ownership; independent review
owns the reproduction and regression inversion. No device/authentication flow,
production deployment or real-user profile is involved.

## Continued non-device delivery: Profile candidates12 and13

Root independently passed Account225 tests, TypeScript/Vite build and whitespace
checks. Independent review closed the partial-save and cross-mutation findings;
the reviewed scope is one rendered Profile page, not server atomicity or cross-tab
write ordering. Candidate13 is now the authoritative staged Account entry above.
Protected archive candidate13-account.tgz SHA256
64FA10F7E0EAAB841882385E848A8611192450F999C2473F09EC84E6F26953E6;
JS SHA256 C2F8B418070BB59CF94C4E346C13B9872E8863305738A035DE5DE6761576355A.

Actual official Browser acceptance now covers:
- Eleven-link preflight preserves every item and blocks both profile/preferences
  writes; fresh canonical Profile retained original links/timezone.
- A controlled failed preferences PATCH with successful profile PATCH produces
  accurate partial feedback and a retained retryable timezone draft. Independent
  readback distinguished persisted profile from unchanged timezone; deliberate
  retry succeeded, then baseline was restored. This was fault injection, not an
  observed spontaneous backend outage; no network override remains.
- A deliberately held profile PATCH disables Avatar/Contact/Save controls while
  text remains editable. Release preserves newer text as an unsaved draft with
  explicit feedback; a fresh observer confirmed only the submitted version was
  persisted. Deliberate second Save succeeded.
- In the reverse direction, a held Contact POST disables Save/Avatar, permits
  newer text edits and preserves them through contact canonical refresh. The owned
  secondary email was added and then removed through its exact row; one primary
  contact remains and the newer profile draft survived both operations.
- An 81-emoji display name remains intact with a focused localized error. An
  80-emoji name (160 UTF-16 units) saves without a native maxlength cutoff, persists
  after reload and has no horizontal overflow at the observed392px viewport. Root
  restored the original display name/status/timezone afterward.

One held-request probe exceeded the Browser call deadline before its evidence was
returned. Root reconnected, cleared interception and restored the clean draft;
reloading showed unchanged canonical baseline. The successful replacement probe
used smaller calls and explicitly released preflight/write requests. No result is
inferred from the interrupted probe. Driver detail is in the Browser journey note.

Further actual testing found a distinct locale defect on candidate13: Profile
interface-language=en persisted and reported Saved while html.lang, both header
selects, page title and UI stayed zh-CN, including after reload. Root restored zh-CN.
The documented authenticated-preference priority and independent main/pages
reproduction confirm this is not intended metadata-only behavior. A bounded locale
coherence repair is in progress; device prompts remain deferred, not a reason to
stop these independent journeys. No production, migration, commit or push changed.

## Candidate14: locale coherence and keyboard focus, actual acceptance

Account locale repair passed root independent228 tests/build and separate bounded
review before staging deployment4eb03d03-830c-47ff-9365-5fdc96d89449. Actual Browser
loaded index-DtKr36lO.js, with stylesheet index-BhQ1JvkX.css. Protected archive
candidate14-account.tgz SHA256
002253E538837211F94F86BA6A26328AD7C2397D5C4AA0200A260B3B8CD378E2;
JS SHA25676D2E47B0504F5ACBC817AD86147E580A61F8A101077B29FC0EF0EF1A10CAEDF.

Root actual Profile Save language=en now produced English page/title/fields/Saved,
html.lang=en and both header selects=en. Appearance Enter cycles light/dark/system
kept the focused BUTTON with localized accessible name, including subsequent Return
events sent only to the current focus. Dirty-profile header cancellation opened the
current English decision and retained both the draft and English selection.

Root then explicitly approved switching header to Japanese, held only that PATCH
after allowing its OPTIONS, and entered newer status text while it was pending.
Both selectors and Save were disabled but text remained editable. After clearing
interception and continuing the PATCH, Japanese page/title/html/header/profile
locale were coherent and the newer text remained an unsaved draft. A fresh Profile
independently showed durable Japanese preference and original saved status. Root
restored the draft, then switched the header back to Chinese successfully.

A failed language OPTIONS preflight tested the actual failure path without a
backend write: original Chinese language and draft survived, selectors/Save unlocked,
and a localized role=alert correctly reported the unconfirmed result. An attempted
viewport320 override did not take effect: actual client/visual width remained392,
innerWidth407, scrollWidth392. Only392px no-overflow/visible-exit acceptance is
claimed for this latest feedback; the temporary override was reset.

That failure exposed a useful follow-up interaction defect: guidance tells users
to read latest state before retrying, but the retained Profile/header has no such
action. A bounded explicit read-only refresh button is being added to preserve
drafts without replaying the language mutation. The owned fixture is restored and
no interception, native dialog or device/credential action remains pending.

## Candidate16: actionable read-only recovery, actual acceptance

The missing read-latest action is implemented in all three locales, with the existing
header request guard/Profile owner, canonical GET refresh, full draft preservation
and meaningful focus restoration. A late independent review additionally found
that401 recovery left the old 'draft retained' message and a dead read button on
the anonymous landing. Candidate15 had already deployed before that late finding
arrived, and is not labelled as containing the401 fix. Candidate16 clears that
feedback and reprojects both anonymous headers; permanent authority/UI regressions
and independent review close the finding without changing authentication policy.

Root independently passed Account26files/231tests, TypeScript/Vite build and diff
whitespace checks. Final staging deployment56e1b83d-8fe6-4add-9e72-e51eb8ac1031 was
observed in the actual Browser as index-BcRIcomX.js. JS SHA256
4106CAAEDD3951C32E9F85D247EF585A34C407875E04BCEBD915A51E2295BFE7;
protected candidate16-account.tgz SHA256
CF835B80E088FBBDA225E1C4E9AE09B367B1CAECF02FC3B61C5D9F51B69D628B.
CSS remains index-BhQ1JvkX.css. All root test/build/deploy commands have completed.

Root actual final-entry acceptance: two unsaved fields (status and bio), approved
language switch, deliberately failed only its OPTIONS preflight, then clicked the
visible localized Read latest state action. Both complete drafts survived canonical
refresh; Chinese remained authoritative, feedback/read button hid on successful
read, both selectors unlocked and focus returned to the visible language select.
A separate fresh Profile read back original saved bio/status, zh-CN, default avatar
and one primary contact: the recovery action did not submit the drafts or replay
the intended language change. Source/permanent tests establish its GET-only command
contract; no live request-header/body trace or real401/device result is claimed.

Root restored both unsaved fields to their original saved values. No network
interception or viewport override remains. The full original goal is not declared
complete: device/credential ceremonies are explicitly unperformed. That boundary
does not prevent independently useful non-device delivery; the material Profile
input/save/locale/focus/recovery findings from this resumed round are now repaired,
reviewed, staged and Browser-tested to the scopes above. No production, migration,
Git commit or push occurred, and no current implementation/review/deploy job remains.
