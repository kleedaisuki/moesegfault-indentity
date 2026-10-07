# In-app Browser staging journey — 2026-10-07

## Scope and environment

- User authorized real staging signup and product testing, no production deployment.
- Driver: official Browser skill, absolute browser-client module import, exact `iab` selector; dedicated agent context worked after root session encountered stale permission errors.
- Domains: https://login-staging.moesegfault.dev and https://account-staging.moesegfault.dev.
- Dedicated disposable owned mailbox (address retained only in protected task files); username journey_20261007. Credentials and OTP remain only in ignored ACL-restricted `.temp/identity-journey-20261007`, never in this document.
- Owned tab 1. No unrelated existing account operated.
- Browser AX and locator mouse clicks repeatedly fail with `Input.dispatchMouseEvent` timeout; this is tooling/environment evidence, not a website defect. Documented locator `fill` + `press('Enter')` work. Each operation commonly takes ~20 seconds; use 120-second tool timeout and avoid batching over 4 operations.

## Baseline actual journey evidence

1. Anonymous login rendered password and Passkey paths, recovery, and Account center links.
2. Activated Create account with keyboard; complete registration form rendered, including optional status, favorite character, interests, avatar and phone. Password hint is at least 15 characters. No terms checkbox or linked agreement; only generic community-guidelines notice.
3. Filled dedicated display name/username/email. Send verification by keyboard succeeded; 8-digit code field focused, masked destination shown, 10-minute validity and 60-second resend explained.
4. Submitted one wrong code `00000000`. Actionable alert explains incorrect eight-digit code and retry. Correct code obtained via authorized amail workflow succeeded, removed code field, and displayed a 10-minute registration-completion window.
5. Filled status `真实浏览器旅程验证 ✦`, favorite character `Klee`, interests `ACG, Linux, VOCALOID`, and generated unique password/confirmation. Password signup succeeded.
6. Success screen remained at `/register` for >80 seconds with misleading text `身份已确认，正在继续…` and manual Account center link; no automatic continuation. Root addressed copy without changing navigation contract.
7. Manual Account center link correctly authenticated the newly created account; dashboard displays `Staging 旅程测试 ✦` and `@journey_20261007`.
8. Profile page shows verified primary owned email but status, favorite character and interests all empty despite signup values. This directly establishes readback loss at the UI; does not alone prove database loss.
9. Filled Status and activated Save changes. Subsequent page snapshot shows Status empty again; no visible alert/status or actionable failure. This establishes silent disappearing input. HTTP status not inspected; do not claim browser-proven 400.

## Pending validation

- Refresh dedicated authenticated session after staging-only backend/frontends update; verify registration values read back, full profile save, reload persistence, timezone, visibility, and feedback.
- Verify remaining account navigation/security/sessions/apps/subscriptions, signout/relogin, recovery, locale/theme and responsive interactions.
- Reproduce locale registration draft-loss baseline separately without sending additional mail.
- Screenshots are still pending due slow tooling; no screenshot evidence yet and no claim of visual-layout verification.

## Candidate 1 real-browser retest

- Refreshed owned profile after root confirmed staging deployment. Original signup status, favorite character, interests now appear. This establishes the original database values were retained and the read serialization was fixed.
- Saved display name, biography, status, pronouns, favorite character, interests, two newline-separated example.com/example.org URLs, private visibility, and Asia/Singapore timezone. Reload independently confirmed all values persisted.
- Post-save DOM showed values updated but no stable success/failure acknowledgement. Root preparing stable confirmation.
- Dirty-form navigation: changed status then activated Security link by keyboard. Input dispatch timed out; original tab remains `/profile`, `getJsDialog()` returns undefined, later DOM/AX calls fail focus emulation. This does not establish an application defect; native-dialog tooling support is incomplete.
- A new tab in the same browser reused the authorized fixture session and displayed persisted profile. Secondary owned email fill is valid; Enter on Add button or input produced no visible new contact and no inline error. All form controls report valid/enabled. Original native confirmation may be interfering with keyboard routing; investigate recovery before attributing this to app.
- Screenshot via documented API failed `Unable to capture screenshot`; no visual proof claimed.

## Browser recovery limit after dirty-navigation test

- Original owned tab 1 remains listed at `/profile`; `tab.close()` failed focus-emulation timeout. No force/protocol workaround attempted.
- New owned tab 3 can navigate/read DOM and fill fields; mouse Save returns successfully but does not produce saved acknowledgement. Form validity is all true. Avoid queued mutations until original native-confirm blockage is resolved.
- `tab.getJsDialog()` is documented but returned undefined; documented AX Escape failed. There is no documented browser-level dialog handler in effective Browser API.
- Original and current account tabs marked handoff. Documented visibility capability refuses with `IAB visibility is not supported in a subagent thread`; parent requested user cancellation.
- Read-only Security view rendered password enabled, zero Passkeys, TOTP preparing, recovery codes enabled. No security mutation, password change, or actual recovery secret reading was performed.

## Root-owned candidate 2b locale retest

The root official Browser connection now succeeds with the unmodified absolute
runtime module. Root's tab namespace is separate from the original driver's tabs;
all still share the dedicated staging fixture's cookie jar. Root explicitly showed
the in-app Browser for troubleshooting. A real registration-form interaction then
worked: fill Display name and Status, select English using the visible language
control. The served page relocalized, both exact Unicode drafts remained, and
focus stayed on the Language selector. This closes the actual idle registration
locale-loss reproduction for candidate 2b (`index-C13Yh2T0.js`). It does not by
itself prove pending OTP/avatar/credential lifetime interactions; their automated
regressions remain separate evidence. No additional registration or mail send was
performed in this retest.

## Root-owned Account interaction progress

- Entered Account from its actual Login footer link; identity matched the owned
  fixture. Entered Profile via its actual Edit profile link.
- Changed Status and added the owned secondary email. The new pending-verification
  contact appeared; the unsaved Status draft survived the contact-triggered reload.
- Profile mouse Save dispatch timed out once. One state inspection showed no
  feedback; supported keyboard Enter then completed save with stable `已保存`
  in the fresh form's inline message. `getJsDialog()` was undefined. This is not
  a product mouse defect merely because dispatch failed.
- The actual loaded Account module at this checkpoint was candidate 2
  `index-B2FvE7b8.js`; root is intentionally reloading before contact verification
  to exercise candidate 3, rather than assuming a staged deploy replaces an
  already-running SPA bundle.
- Root screenshot succeeded and was saved/displayed: protected task file
  `login-locale-candidate2b.png`. It visibly shows English form labels with the
  retained Chinese Status draft. Earlier agent screenshot failures remain history,
  not a claim that screenshots are universally unavailable.

## Candidate 3 real contact journey and avatar preview

Root explicitly reloaded and observed loaded `/assets/index-BBBNyo9t.js` before
verification. The original primary contact and saved Status survived reload.

1. Activate pending secondary contact Verify via keyboard. The real eight-digit
   verification form appeared with delivery status and focused code control.
2. Authorized amail exact-recipient/time-bounded search found the delivery. Code
   extraction used the explicitly labeled `Verification code:` field: searching
   every eight-digit run also matches the date in the test alias and is unsafe.
   The protected OTP was never printed and the delivery was not marked/deleted.
3. One wrong code displayed an alert, preserving the challenge and input. Correct
   real delivered code then succeeded with the same visible flow; both contacts
   rendered verified. No backend fixture was substituted for this browser proof.
4. Make secondary primary showed the expected badges; make original primary again
   restored the fixture baseline. These were real API-backed UI interactions.
5. Root selected a synthetic local 64x64 PNG through the documented file chooser.
   Browser preparation displayed `64 x 64 px / 598 B / WebP`, explicit confirm and
   cancel controls, and upload-only-after-confirm copy. Cancel removed the Confirm
   upload control (count zero); no upload was performed in this preview/cancel test.
6. The human explicitly approved removing only this secondary test contact. Root
   then removed that exact email-scoped article. Readback showed only the original
   verified primary contact. No account, main contact or mailbox delivery deleted.

The actual wrong-code feedback exposed a usability issue: raw English server prose
and a long diagnostic UUID crowded the main Chinese alert. A contact-local repair
now maps stable Problem Details codes to actionable three-language copy and places
support IDs in closed native details. Actual AccountApiClient network wrapping and
429 semantics are covered without inventing client cooldown deadlines. Root local
117-test/build gate and a subsequent staging candidate are separate from candidate3
browser evidence; post-repair browser wording is not yet claimed verified.

## Avatar confirmed upload checkpoint

On root-observed Account candidate 4 `index-CMbe9rQB.js`, selecting the exact same
synthetic PNG again after cancellation produced a new confirmation preview.
Explicit keyboard Confirm upload completed and refreshed Profile with an actual
`https://avatars-staging.moesegfault.dev/avatars/...webp` URL rather than a local
blob URL. This is real staging upload evidence; reload/image-decode confirmation
and narrow-screen checks are next. The fresh avatar inline message was empty,
although the image URL changed: consider stable avatar acknowledgement using the
same route/principal-bound feedback mechanism already used for profile saves.

## Avatar persistence, narrow-screen and candidate 5 acknowledgement

- Reload retained the exact staging avatar resource URL; DOM image decode reported
  complete=true and naturalWidth=naturalHeight=64. This proves actual image content,
  not merely a changed URL or local blob preview.
- Explicit 320x740 viewport measurement returned viewport=320, document scrollWidth=320,
  and no main/header/navigation element extending past the right viewport edge.
  The mobile Exit control remained visible. No CSS fix was needed for this probe.
  Screenshot at this viewport failed; quantitative DOM-layout evidence is not a
  claim of comprehensive pixel-layout verification.
- The human approved restoring the default avatar. Root reloaded and observed
  candidate5 `/assets/index-DYPspyGU.js`, activated Remove scoped to avatar card,
  and read `/icons/logo.svg` plus persistent `已保存` on the fresh avatar card.
  The main email/contact and account were untouched.

Candidate5 Account version is 246e8bdc-4462-4f86-b2ca-a3b7905ad6bd. Root independently
passed 18 files/118 tests and build before staging-only deployment. The earlier
Avatar acknowledgement gap is now closed by actual browser removal feedback;
late/principal-switched feedback and upload same-policy are separate unit evidence.

## Candidate6 history/dirty-signout actual branch

Root loaded candidate6 `/assets/index-DuwvYrvm.js`, edited a synthetic Status draft,
and used actual browser Back. Overview rendered at Account root, proving the native
same-document traversal occurred while the profile draft became hidden in memory.
Root then activated the mobile Exit control. Supported dialog detection returned
undefined and input dispatch timed out; this is an interaction-tool limitation.
The human reported clicking Confirm on the actual discard dialog (not Cancel).
Root's subsequent real DOM observation showed the paired staging Login page.
Therefore the actual accepted-discard/signout branch is exercised; cancellation
is NOT claimed passed. The discarded Status was deliberately synthetic and never
part of the saved profile. A follow-up protected Account deep-link check and real
wrong/correct password login are in progress. Source integrated cancellation tests
remain separate supporting evidence.

## Post-signout protected route

After the human-confirmed hidden-draft discard and observed Login navigation,
root visited the already-grounded staging Account `/profile` route. It rendered
the dedicated anonymous landing with no authenticated profile/sidebar/signout.
Its actual Login CTA preserved the exact same-environment Account `/profile`
return_uri. This establishes the session is no longer accepted by the protected
Account route; merely opening Login was not used as revocation proof.

## Password correction and exact return acceptance

Root followed the actual anonymous Account `/profile` Login CTA, retained its exact
staging return_uri, filled only the owned fixture identifier and one fake password,
and submitted. A real HTTP401 password-authentication failure appeared with an
enabled retry control and closed support diagnostic panel. Root then changed ONLY
the password to the protected existing credential (never printed), after checking
the exact staging credential destination. Authentication returned to Account
`/profile`, displayed the owned fixture and the previously saved Status. The
confirmed-discard synthetic History draft was absent, as intended. Thus actual
wrong→correct retry, retained identifier, authenticated deep-link return, durable
profile state, and approved signout lifecycle have all been exercised.

The wrong-password main detail was unhelpful raw English `Authentication failed`
under the Chinese headline. A narrow Login repair maps only stable password
credential-rejection codes/401 to actionable localized non-enumerating copy;
other transports/security errors and support diagnostics keep their contracts.
Root independently tests/builds/deploys the next Login candidate separately.

## Latest Login return and real additional-session fixture

Candidate3 Login wrong-password feedback is now actually localized and retryable;
correcting only the password again reached the same owned Account Profile with
saved values and default avatar. A very early URL read still showed Login while
the request was unresolved; subsequent actual DOM observation established the
return, not a premature second submission.

Sessions navigation and one normal Retry encountered the global network-failure
state. Later supported public healthz returned HTTP200 with D1 ok; a normal owned
tab reload then rendered Sessions correctly. Treat the earlier failures as network
observations, not a proven multi-session backend defect. The actual list contained
the current password session, one older active password session created by our
repeat login, and one revoked-session history article. Fresh tabs were never used
as independent-device evidence. Targeted revocation of this explicitly known old
test session is in progress; its result will not be labelled independent-browser
or physical-device coverage.

## Browser recovery and explicit-dialog acceptance (root, 2026-10-07)

After the user's network repair, the existing built-in Browser binding had no
remaining tabs. Root created a fresh owned tab in the same browser (no alternate
browser or cookie inspection). Account Profile loaded candidate8 entry
`index-CKMvzvPn.js`, remained authenticated as the owned fixture, and showed the
saved profile, default avatar, and sole verified primary contact.

Actual candidate8 interaction results:
- Dirty Status + Overview opens the semantic HTML dialog, with Continue editing
  initially focused. Escape cancels, preserves the draft and /profile, and returns
  focus to the invoking Overview link.
- Header language change opens the language-specific discard action; cancellation
  keeps zh-CN selected and preserves the same draft.
- Dirty sign-out opens the explicit discard-and-sign-out action. Continue editing
  preserves authentication/draft, restores sign-out focus, and re-enables the
  visible exit control.
- Explicit discard-and-leave followed by Profile shows the original saved Status;
  the discarded synthetic draft does not resurrect.
- First Tab moved safe -> destructive. Second Tab left dialog focus on body.
  This actual failure motivated explicit two-button boundary wrapping; it is not
  labelled a proven engine defect. Candidate9 contains the narrow fix and needs
  real forward/backward keyboard retest.

Fresh Sessions read resolved the prior unknown mutation outcome: the known older
active test session (displayed 16:26) still offered Sign out device, alongside the
current session and the previously revoked history record. Thus the old operation
was not assumed successful or blindly replayed; a new explicit action can now be
based on fresh state. Displayed timestamps may be last activity, not creation.

## Candidate9 actual acceptance and old-session revocation

Root loaded `index-S-Z4jL6-.js` through the actual built-in Browser. From the
initial safe action, Shift+Tab now wraps to the destructive action; Tab from the
destructive action wraps back to safe. Both observations confirmed the focused
element remained inside the dialog. Escape still cancels. Dirty language change
approved through the explicit action switched to English once and restored the
saved canonical Status rather than the abandoned draft. English leave/cancel copy
was read in the real dialog; a clean switch to Japanese retained the saved data.

At 320x740, the Japanese mobile exit opened the translated discard/sign-out dialog,
initially focusing Continue editing. Document scrollWidth was exactly 320 and the
dialog lay within x=19..285.67. Screenshot capture failed, so these are DOM geometry
and interaction observations, not a claimed pixel-perfect screenshot review.
Cancellation retained the draft/authentication. A precise Chinese repeat confirmed
activeElement was BUTTON.icon-button.mobile-sign-out, aria-label Exit, visible and
enabled: the earlier empty textContent was the SVG-only icon, not a focus defect.
The viewport and UI language were restored afterward.

After fresh server state showed the older owned test session still active, root
explicitly revoked that sole old-session action. The resulting actual list showed
it signed out at 17:14, the current session still current, and earlier revoked
history intact. This proves targeted first-party fixture revocation, not separate
browser/device isolation.

The unused isolated local Vite component probe was stopped through its owned exec
session; it was not used as a substitute for the staging results above.

## Registration verification/locale lifetime and new Recovery findings

While anonymous, root used only the already-owned secondary alias to create a
registration verification challenge, not a second account. The actual delivered
initial mail and an explicit resend were retrieved via amail. Resend showed a
server-derived disabled countdown (40s at the observation) and focused the code
field; changing zh-CN -> en retained the challenge UI and Unicode Status. Direct
comparisons against sensitive DOM input values returned false while snapshots
redacted those fields; these comparisons are not used as proof of retention or
loss. The latest labelled verification code was extracted privately from the
owned delivered message and submitted in the ordinary English Verify email UI.

After successful verification, switching to Japanese kept the actual verified
email success state, selected synthetic avatar preview (64x64 / 598B), and Unicode
Status. No new account, avatar upload, credential, recovery code rotation, purchase
or grant was created. This proves real delivered resend -> verification -> locale
projection continuity; it does not claim a race or full expiry test.

Actual Recovery navigation exposed two further defects: Login's recovery link and
the recovery Back link dropped the validated Account/profile return destination;
and a deliberately invalid recovery code produced English 'Recovery material is
invalid' under a Chinese error heading. The invalid code was rejected before any
platform credential prompt and retained retry/form state. Both narrowly scoped
fixes now have stable-contract tests and await actual candidate4 Browser acceptance.

Root independently reran Login 22 files / 162 tests, TypeScript/Vite build and
whitespace check. Staging-only candidate4 deployed successfully:
`95311a15-63aa-4dff-8427-4d48635e5d68`, JS `index-C_OA_dyz.js`, CSS unchanged
`index-BZaXmuQz.css`. No production deployment, commit, push or migration.

## Candidate9 sign-out and Login candidate4 recovery acceptance

Actual dirty mobile sign-out with the explicit discard-and-sign-out action reached
paired staging Login. A fresh protected Account/profile navigation rendered the
anonymous landing (no authenticated controls), and anonymous zh-CN -> en -> zh-CN
worked. This verifies actual revocation rather than treating a redirect as proof.

The proof-only registration probe then exercised the Passkey method with required
shared fields empty: focus returned to display_name; display_name and username
were invalid, with the avatar preview intact and no platform ceremony. Root
intentionally abandoned this probe without creating another account.

Fresh Login loaded candidate4 `index-C_OA_dyz.js` from the anonymous Account/profile
CTA. Actual Recovery and its Back link now preserve that exact allowlisted return
URI. Deliberately invalid material yields the actionable Chinese guidance, keeps
both drafts, and re-enables submit, without a credential prompt. Back actually
returned to /login with the same profile destination. Root invoked ordinary
Passkey sign-in to test cancellation/fallback; the UI entered waiting-device state
with both auth methods locked. Human cancellation of the native device chooser
has been requested; no private credential is to be selected and no credential is
created by this sign-in probe. This gate is pending, not passed.

## Login candidate5: actual Passkey cancel -> password fallback

Root independently reran all Login tests (23 files / 171), TypeScript/Vite build,
and whitespace check; staging-only deploy succeeded as version
`2ffb34b9-d548-4c09-b4dd-d9c7c4a18ef1`, entry `index-BNjGQiAN.js`.
Independent review also passed three adversarial late-response/route-abort probes.

The old candidate4 device wait was ended by ordinary navigation to the same owned
Login return URL; no native credential was selected. Fresh Browser read confirmed
candidate5 loaded. Root filled the owned existing username/password, invoked
Passkey, and waited for the actual device-wait-phase cancel button (not merely the
initial start-request busy state). Ordinary keyboard activation of the visible
Cancel Passkey/use password action succeeded: both auth methods became enabled,
password field received focus, and the explicit cancellation guidance appeared.
Root then activated password login WITHOUT refilling either input. Actual Account
Profile loaded the owned principal, durable original values, default avatar and
sole verified primary contact. Thus real page cancellation, preserved credentials,
password fallback, and exact staging/profile return are passed. No Passkey was
created or selected, and native chooser-cancel behavior itself is not inferred.
The earlier human-cancel request is now obsolete; the human was informed.

## Pending human-scoped security actions

Post-fallback actual Connected apps now contains exactly moeSegFault Subscribe,
openid/profile, dated 15:25, created by the earlier owned-fixture SSO journey. The
previous empty-state observation predates that grant and is not the latest state.
Root has requested explicit approval before revoking this test grant; no revocation
has occurred yet. The user has also been asked whether this round should keep
credentials unchanged or continue human-operated password/Passkey/recovery-code
changes. No new credential is entered/created or recovery code rotated by the agent.

## Native history acceptance after continuation

The previous turn made concrete progress (four deployed/retested interaction fixes,
real mail resend/verification and real Passkey-to-password fallback). At continuation
start the temporary tab had closed normally; root reused the live iab binding and
created a fresh tab, which remained authenticated with canonical saved profile.

Public plugin documentation provided the exact history API (`tab.back()` and
`tab.forward()`) and lifecycle marks (`tab.markHandoff()` / `tab.markDeliverable()`).
These are supported Browser operations, not JavaScript history mutation or client
internal inspection. Keyboard Alt+ArrowLeft remains an ineffective input probe.

Actual latest Account candidate9 native history results:
1. Root established Overview -> Profile, typed synthetic Status, then native Back.
   Overview rendered with no draft-discard modal.
2. Native Forward rebuilt Profile and restored that exact unsaved Unicode Status.
3. Root opened explicit sidebar-discard dialog, then used native Back instead of
   either action. The old modal was removed and Overview rendered normally; stale
   consent was not carried onto the newly active route.
Further hidden-draft cancellation/Forward readback is being checked separately.

Actual hidden-draft completion: on Overview after the pending-modal Back, Exit
opened the explicit sign-out discard dialog. Continue editing left the account
logged in; native Forward restored the same unsaved synthetic Status. Root then
returned that value to its saved baseline, without saving the synthetic value.

Document-exit paired probe: with a synthetic dirty Status, a full navigation to
known Account/security rejected with net::ERR_ABORTED. Both getJsDialog reads
returned undefined; no claim is made about visible native warning buttons or
manual dismissal. A fresh DOM read still showed Profile and the exact dirty text.
After reverting only that text to the saved baseline, the identical full
navigation succeeded and rendered Security. This establishes dirty-vs-clean exit
protection in this Browser, while native warning presentation remains unobserved.

A real registration OTP expiry probe is now live in a separate owned tab. It uses
only the existing synthetic test alias and no account-creation submission. Initial
mail received 10:24:02.853 UTC, id 705cc135-33c6-4c8d-98f7-7789e70fc591, was retrieved
privately. The real ten-minute deadline will be allowed to pass (no mocked clock,
network interception or secret/transaction inspection). Late-code rejection and
explicit resend recovery will then be tested. Other owned tab remains logged in.

## Candidate6 manager navigation and confounded expiry probe

Root personally followed Security -> enrollment/rotation without activating Add
Passkey or Rotate. Both initial management views lacked an explicit return to the
originating Security page (footer went only to Account home). A shared safe Return
to Account link now preserves the allowlisted security return through loading,
ready, waiting, error and completion states. Root independently reran Login
24 files / 184 tests and build before staging-only candidate6:
`f470a46b-2810-41d5-b174-b3dae6e7058a`, entry `index-CFk6ErB_.js`.
Actual fresh rotation read confirmed that asset and the visible Return to Account
Center link to exact staging/security. No credential/rotation mutation occurred.

The real OTP expiry probe did NOT establish expiry feedback: after more than ten
minutes, submitting the delivered old code returned 'CSRF validation failed', with
challenge and Unicode draft retained. Parallel read-only enrollment/rotation page
initializations had occurred in the same cookie jar, so cross-tab context refresh
is a concrete candidate cause, not yet a proved mechanism. The current UI exposes
raw English CSRF detail under verification retry guidance. A focused workstream is
investigating the actual context contract and a safe fresh-token/manual recovery
path; no backend CSRF weakening, cookie inspection, hidden network access, clock
mocking or automatic replay is allowed. OTP expiry remains unproven in this probe.

Actual candidate6 navigation completion: root activated Return to Account Center
from Rotation and observed /security/title; then followed the actual Passkey
management link, observed the same safe return href, activated it and again landed
on Security. No mutation control was activated. Both manager return paths passed.

Old candidate5 CSRF-error recovery: explicit Resend created a new challenge and
cleared only the stale OTP, retaining the Unicode Status. Newly delivered mail
received10:39:15.469 UTC (db71dc12-98b0-4506-83be-b842ac3fe9c9) was read privately;
ordinary Verify email succeeded and showed verified status. No new account was
created. This is evidence of existing manual resend recovery, not post-fix
cross-tab acceptance. The verifier's real proof-expiry check can next be exercised
by a cosmetic locale change after its displayed ten-minute proof window; no
account-creation submission or fake clock is needed.

## Shared browser-binding fix: root rollout gates

Root independently ran cargo fmt, full workspace tests (90 Worker + 14 domain +
1 executable doc test; 2 existing docs ignored), warning-free workspace Clippy,
release Wasm build, actual registration Worker/D1 and contact-verification harnesses.
All passed; the deliberate atomic rollback fixture's diagnostic is expected.
Additional password-security and recovery-authority harnesses passed: stale binding
rejected, password/session authority rotation and recovery revocation invariants
remain intact. These are local synthetic harnesses, not real credential changes.

Root independently reran Login24 files /188 tests, TypeScript/Vite build and
whitespace check. After independent security review closed without a blocker,
staging-only deployment succeeded:
- Identity: d10ba9ad-c44a-4bdb-9815-9fde486c9801 (release Wasm)
- Login: bdff54a7-4880-496d-a955-2239d41cb08e (index-BN_aFskc.js)
- Account unchanged:134d30e8-fe1a-4522-8a6f-7dc8ef5bee89
No production command, migration, commit or push.

Browser then followed Security -> enrollment and actually loaded index-BN_aFskc.js;
its explicit Return action returned to authenticated Security. The uniform600s
binding retains the SAME nonce; registration600s/WebAuthn300s/SQL proof deadlines
are unchanged, old binding cannot be silently rebound, and expired transactions
cannot revive. csrf_expires_at300 remains an existing refresh hint: the HMAC has
no independent time claim. Old proof replay also renews common600 rather than its
short remainder, avoiding a second cross-ceremony shortening path found in review.

Real cross-tab delayed confirmation and expiry/recovery acceptance remain separate
next gates. The already-live old-page verified proof will first be allowed to
expire naturally and reprojected through a normal locale change, without any
credential creation or clock substitution.

## Real proof expiry and delayed cross-tab acceptance setup

The live old-page proof verified around10:39:45 UTC remained visibly verified at
10:47:11. Root waited in real wall time until after10:50:30, then changed en->zh-CN.
Actual readback at10:51:37 showed '邮箱验证已过期，请重新验证' with enabled Send code,
no verified badge/code confirmation, and unchanged Unicode Status. No clock
substitution, creation attempt or automatic mail send occurred. Thus natural proof
expiry with draft-preserving recovery guidance is now Browser-covered.

A fresh candidate7 registration page actually loaded index-BN_aFskc.js. New owned
challenge mail received10:53:56.376 UTC, id a589b83b-2284-414a-ad10-e51a9a39b1f8.
Root then opened actual enrollment from the second tab, let it initialize its
shared browser context, and returned normally to Security without creating a key.
At10:56:39 the first tab still had its original challenge and Unicode draft.
The real delayed confirmation will be attempted more than five minutes after this
observation, before the original ten-minute code window ends, with no resend or
additional context initialization during the wait. The exact target is11:01:40 UTC
or later, original challenge expires approximately11:03:56. This discriminates the
former300s shared-binding lifetime from the fixed600s lifetime using real Browser
and delivered mail, while keeping SQL challenge validity unchanged.

## Candidate7 actual delayed cross-tab success

Root began final confirmation at11:02:31 UTC, more than five minutes after the last
second-tab context initialization/return observation at10:56:39, using the SAME
mail delivered10:53:56.376. No resend, hidden token read or context call was made
during that wait. Ordinary Confirm email succeeded; final DOM read at11:03:46
showed verified success and the exact Unicode Status. This is within the original
ten-minute challenge window and beyond the former300s binding lifetime. The
source/client now fetches current CSRF for that one explicit confirmation; it
cannot rescue a changed binding or revive an expired transaction, as the actual
Worker/D1 security regressions separately prove. No second account was created.

This closes the real delayed cross-tab journey for the staged Identity/Login fix.
The original >10-minute late-code probe remains correctly labelled confounded;
natural VERIFIED-proof expiry itself passed separately. The blocked-nav native
warning presentation was not observed and is not upgraded to a native-button test.

Security scope and test Subscribe grant revocation still await human responses;
there has been no password change, new Passkey, recovery-code rotation or grant
revocation in the real staging fixture. The original primary contact/default
avatar and durable profile remain the intended cleaned fixture state.

## User-authorized staging security continuation

The human explicitly clarified that staging fixture tests, including the previously
listed security operations and test grant cleanup, should proceed autonomously.
This is not production or unrelated-account authority. Root revalidated the live
principal as the dedicated fixture before any mutation. Exact Subscribe openid/
profile grant revocation succeeded through ordinary UI; an actual reload retained
the empty apps state. This approval gate is closed, not awaiting another prompt.

Actual rotation attempt with zero registered Passkeys entered device-wait step-up
with no recovery-code output. Root did not inspect any credential values or choose
an unrelated device key. The existing explicit Account return cancels that route.
This exposes a product dead-end for a password-only user: the UI should explain
first-key enrollment/bootstrap rather than launch an empty-device ceremony. A
bounded source workstream is examining the existing high-assurance policy and
an actionable zero-key path; server security requirements must not be weakened.

## Zero-Passkey rotation precondition repair

Actual zero-key rotation entered a native device wait and locked its control.
Root used Return to Account to cancel, then tried the actual enrollment Add action.
That returned actionable device cancellation/timeout copy and unlocked Add; its
password-confirmation fallback controls were present. No key or recovery code was
created, and root returned to Security. These are real cancellation/entry tests,
not claimed successful hardware credential enrollment.

The rotation repair now reads the existing complete authenticator list on explicit
activation. Zero active keys (including revoked-only history) produce localized
first-key enrollment guidance and a safe security-preserving link, without invoking
rotation or the native chooser. A failed read is an error, not evidence of zero
keys; active keys retain the original recent-Passkey step-up policy. Shared duplicate
lock and route cancellation guard the read. Root independently passed Login25 files/
196 tests and build; independent reviewer passed21 related tests plus3 real-client
DTO wire cases. No server security requirement or credential semantics were weakened.
Staging candidate8 rollout/real UI acceptance follows these source gates.

## Device-prompt interruption and candidate9 bounded Browser acceptance

The human reported that a Passkey device prompt appeared while they were away.
This was root's prior explicit enrollment/step-up testing, not evidence of account
compromise. Root used the ordinary Return to Account link, observed Security with
zero Passkeys, and committed not to automatically trigger device credential
prompts again. Staging permission was already granted; this is an interaction
boundary and does not reopen generic authorization questions.

Root independently passed the final Login27-file/223-test suite, build, whitespace
checks, and deployed only Login staging candidate9. Version:
`6eaf5942-7e04-4a52-a4e5-fb13c7a1246d`; Browser reload actually loaded
`/assets/index-B8Zhaqxu.js`. Reviewer closed the synthetic cross-account retry
reproduction after both management consumers gained immutable account ownership.

Using the same owned fixture and built-in Browser, root explicitly activated
Rotate with the verified zero-key state. Actual UI showed '请先添加一枚 Passkey'
and password-bootstrap guidance, with a safe enrollment link and enabled return.
No codes were displayed. Root followed the link only to inspect enrollment, never
submitted its Add/password forms: name default remained '这台设备', the confirmation
identifier was prefilled and readonly, one password input existed, and Return still
targeted Account/security. Returning displayed Passkey0, password enabled, recovery
codes enabled. The tab was handed off on Security, not a native-device wait.

No native chooser dismissal pixels, new-key creation, stale-password confirmation,
or successful recovery rotation are claimed from these observations. Those live
ceremonies remain unperformed; the new bootstrap/ownership/abort branches are
covered by deterministic production-wiring regressions and independent review.
No production, migrations, commits, pushes, extra mailbox aliases, or additional
real account were involved.

## Account candidate10 actual mobile and password-policy journey

Root tested ordinary Profile Add with the fictitious non-working number
+1 202-555-0107, in NANPA's reserved555-0100..0199 range. It saved as canonical
+12025550107, pending and primary-for-mobile. Verify showed a transient '稍后重新发送'
message; source inspection established deterministic unsupported-mobile503 before
any delivery transaction, not a transient SMS outage. The corrected Account UI
exposes this capability before Add and beside pending mobile contacts, without a
nonfunctional Verify control; email verification and legacy verified mobile remain.

Root's supported Node24 full Account170 tests/build and independent bounded review
passed. First staging deployment failed before asset upload; one terminal retry
published `da85a99d-8995-4693-ae75-2f40cd1e17b2`. Actual Browser reload loaded
`/assets/index-DHWoPRyY.js`. On the retained pending phone row the localized notice
was visible and only Remove remained. Switching contact kind to Mobile showed the
same pre-add notice and `aria-describedby=mobile-verification-note`. At actual
viewport406px, document scrollWidth391px: no horizontal overflow in this probe.
Root removed only the synthetic phone row; reload confirmed no number and exactly
one contact row (original verified primary email). No real SMS recipient or send.

Security displayed its new policy hint:15..128 Unicode scalars, spaces allowed,
no controls. With only a synthetic fake current value and eight fox emoji as new
input, explicit Save focused the new-password field, set customError/aria-invalid,
and showed the localized policy as an alert. This discriminates the old native
minlength15 UTF16-unit check, which counted the eight astral characters as16.
It is an invalid-input UI probe, not a successful credential mutation or an observed
network trace. Root then reloaded, confirming both password field lengths0, enabled
Save, Passkey0, original password enabled and recovery posture enabled. No actual
password change/removal, recovery issuance, or native device prompt occurred.
The retained tab is the clean staging Security page, not a form containing secrets.

## Full international mobile paste: live baseline

After the human explicitly deferred device-dependent Passkey testing, root continued
ordinary contact input testing. On Account candidate10, selected country+1 and
pasted the reserved fictitious full number '+1 (202) 555-0107'. Actual Add returned
'Invalid mobile number' with a correlation receipt and retained the input; no
synthetic mobile row was saved. Source passes the leading+country prefix again
inside national_number rather than translating the user's full-number presentation
to the existing structured API payload. Login's optional mobile field has a separate
normalizer that also lacks Account's established national-trunk-zero handling.

A bounded shared input normalization repair is in progress for only the six
existing country choices, preserving backend validation and login-identifier
lookup semantics. It must reject mismatching selected/international codes with
localized corrective feedback before any request rather than silently change
the selected country. Registration must reject bad optional mobile input before
email verification or account creation, not after consuming a verified proof.
This is not a new SMS-delivery or global number-validity capability.

## Full mobile paste repair: post-deployment real Browser acceptance

Root independently passed shared70/typecheck, Account179 and Login234 tests, both
builds and whitespace checks. Independent bounded review passed the focused and
additional00/invariant probes. Frontend-only staging deployment succeeded:
Login72baa513-5865-4b49-804d-96c786575730 / index-y4d-xBqN.js;
Account43286e1f-f6bd-4109-9e26-078e4d6a24fa / index-CG4BOV5Q.js.
Both entries were observed in the actual Browser documents, not merely deployment
output. No backend, production, migration, dependencies, commit or push changed.

Account: with default+86 and full fictitious '+1 (202) 555-0107', Add now presented
localized selected-country conflict, focused value, set aria-invalid, retained+86
and showed zero mobile rows. Changing only the country to+1 and retrying saved
canonical+12025550107 pending with the existing unsupported-SMS notice. This directly
closes the original failing copy/paste path using the actual structured API.
With+86 and0012025550107, Add then displayed explicit+ notation guidance, retained
selection/focus and kept the row count at one: no silently misrouted extra contact.

Register: actual mobile labels contained '手机号（可选）', input described the new
format hint, and the separate country select retained its own name. Root used only
synthetic negative-test display/username/new-password values, the owned test email,
and the fictitious conflicting full phone; explicit password-method submission
stopped at a localized mobile error with focus/aria-invalid, kept the create control
enabled and left email-code UI hidden. No real account was created, no verification
was completed, and no device method was activated. This is an actual negative-input
probe, not a claimed successful signup-with-mobile or inspected request trace.
The separate signup tab was closed immediately after that observation.

Root removed the one synthetic phone through its own row, then reloaded Profile:
contactRows1, mobileRows0, avatar/icons/logo.svg. Returned to Security and retained
only tab4. No stage passwords, credentials, hardware or unrelated recipients were
touched. Real Passkey testing remains explicitly deferred by the human; no new
device handoff or generic staging permission request is pending.

## Continued Profile testing: actual candidate12 acceptance

The human deferred only device/Passkey testing, not the remaining non-device work.
Root resumed the official built-in Browser on the owned staging fixture. On the
previous candidate11, submitting eleven valid example.com links silently retained
only ten; an invalid profile link combined with timezone UTC returned a generic
profile error while an independent fresh Profile showed timezone UTC persisted.
Root restored the original two links and Asia/Singapore before testing the repair.

Candidate12 deployed as Account 14ab11dc-590e-4b25-877f-e387fe99590a. The actual
document loaded /assets/index-emXSp8nH.js. Submitting eleven links with timezone
UTC now retained every link and the timezone draft, focused links with aria-invalid,
and explained the ten-link limit without dropping entries. An independent fresh
same-browser Profile retained the original two links and Asia/Singapore: neither
side of the composite Save wrote on invalid input.

Root then exercised an explicitly injected one-request network failure, not a
naturally observed outage, using the Browser's advertised scoped CDP capability.
Fetch intercepted only the exact staging /v1/me/preferences Fetch resource; one
PATCH was failed, while the profile PATCH was allowed to complete. No request
headers, cookies, tokens or bodies were inspected or emitted. The supported clear
operation is Fetch.enable with patterns:[] (Fetch.disable is rejected by this
Browser). One already-paused canonical GET was explicitly continued; interception
was cleared, and normal page rendering and subsequent saves succeeded.

The UI accurately reported that profile details were saved but preferences were
unconfirmed, retaining UTC as a retryable draft. A separate fresh Profile read back
the submitted status marker and the original Asia/Singapore timezone, distinguishing
the confirmed half from the failed half. Deliberate retry succeeded with Saved and
UTC. Root then restored status 'Root contact-email draft retained' (the existing
Chinese fixture text) and Asia/Singapore through the ordinary Save control; actual
canonical UI showed the original values and Saved. All interception is cleared.

This verifies frontend partial-result presentation/draft preservation and deliberate
retry, not a server transaction, cross-tab serialization, or cancellation rollback.
The additional cross-avatar/contact refresh race has a separate main/pages wiring
reproduction and a reviewed page-local owner repair, pending candidate13 deployment
and actual Browser acceptance. Screenshot capture still failed; no screenshot
artifact or visual-perfect claim is inferred from these accessibility/DOM checks.

## Candidate13: bidirectional mutation ownership and Unicode boundary

Actual Browser loaded index-C8fS-QTN.js after Account staging deployment
4c27a36e-9590-49dd-b138-97e81a4a93e1; root independent full Account225/build gates
and the bounded independent review had passed beforehand.

The first controlled held-request call exceeded its execution deadline and lost
its local connection. Root recovered only through the same official Browser,
cleared Fetch interception, reset the draft to its original value and reloaded;
the canonical status/timezone were unchanged. That interrupted call is not a
successful acceptance result. Subsequent probes used small calls and explicitly
continued OPTIONS before holding only the intended write, preventing unresolved
preflight from being mistaken for a dispatched profile write.

Successful held profile PATCH: all main mutation buttons were disabled, including
Avatar/Contact/Save, while status remained editable. A newer status draft entered
during the hold survived the settled write and canonical refresh; feedback stated
that submitted changes were saved but newer edits were not. A fresh same-browser
Profile showed only the submitted older status. Explicit subsequent Save persisted
the newer draft, displaying Saved. Interception was cleared before releasing the
write so canonical GETs did not remain paused.

Successful reverse held Contact POST: Save and Avatar were disabled while editable
status remained available. Newer draft text survived the completed add and canonical
refresh. The only added contact was the already-owned secondary test email; its
exact row was removed immediately afterward. Root observed one primary contact and
the newer draft still present after removal. No email verification/delivery, new
mailbox, authentication credential or hardware action was involved.

Unicode boundary: 81 cat emoji were retained with a localized display-name error,
aria-invalid and field focus. 80 cat emoji were saved intact (80 scalars,160 UTF-16
units, no native maxlength), survived document reload, and document scrollWidth
equalled clientWidth392. Root restored the original display name and status by Save.
This is observed layout-width evidence, not a screenshot-perfect assertion.

Next discovered real defect: saving Profile locale=en persisted the field, but the
document language, page title and both header selects stayed zh-CN, including after
reload. Root restored the original zh-CN preference. Independent main/pages evidence
and the existing ADR establish authenticated account locale should take precedence.
The bounded repair must apply confirmed canonical locale without forcing document
reload that discards newer draft text, and must not introduce an overlapping header
language write around the Profile operation owner.

Pre-repair header cancellation also passed in the actual Browser: changing header
language with a dirty profile opened the localized HTML discard decision. Continue
editing retained the complete draft and restored both header selects/current
document language to zh-CN. Root returned the draft to its saved baseline afterward.
The fix must preserve that behavior while making successful authenticated selection
durable and coherent with Profile language.

External grounding for the bounded locale repair:
- [W3C WCAG2.2 Language of Page](https://www.w3.org/WAI/WCAG22/Understanding/language-of-page)
  explains that accurate document language helps assistive technologies render
  text correctly. Updating visible translations without html.lang is insufficient;
  acceptance should check both, plus accessible names and discard decisions.
- [Da Rosa et al., Patterns for UI language-switching, PLoP2022 manuscript](https://www.plopcon.org/pastplops/2022/papers/G6_P3.pdf)
  derives patterns from inspection of existing multilingual systems and distinguishes
  profile preferences from an interaction-time selector. Its design argument supports
  applying language without interrupting the user's workflow. This is pattern research,
  not a controlled usability trial or proof of a particular synchronization protocol.
  The present decision stays with the repository ADR's existing single account-locale
  contract; no ranked-language model, new localization dependency, or framework is added.

Root also reproduced a concrete keyboard defect in the same persistent shell on
candidate13: pressing Enter on Appearance changed themePreference system->light,
but document.activeElement became BODY with no accessible control name because
installPreferenceControls replaced the focused button. Repeating the interaction
through the fresh button cycled light->dark->system and restored the original
appearance. The bounded header/locale repair should preserve the focused control
instead of recreating it; independent review was given the actual reproduction.
Current owned fixture is restored: original display name/status, zh-CN account
locale, Asia/Singapore, system appearance, default avatar and one primary email.

## Candidate14: actual locale, keyboard and language-failure journeys

Root independent Account25files/228tests, TypeScript/Vite build and diff whitespace
checks passed. Bounded independent review closed locale/Appearance findings. Account
staging deployment4eb03d03-830c-47ff-9365-5fdc96d89449 loaded actual Browser entry
index-DtKr36lO.js; no production or backend deployment was involved.

- Profile interface-language=en + ordinary Save immediately produced English title,
  labels, heading and Saved, html.lang=en, both header selects=en and canonical form
  locale=en. Actual scrollWidth/clientWidth were both392.
- Keyboard Enter on Appearance produced light and focused BUTTON/Appearance;
  subsequent Return events to current focus produced dark then system, retaining
  focus/name throughout. No retargeting was needed between those last two presses.
- Dirty English Profile header selectionja opened an English Unsaved changes
  dialog. Continue editing retained the full draft, removed the dialog and restored
  both selectors to en.
- Root repeated ja selection, explicitly approved discarding the synthetic old
  draft, allowed OPTIONS and held the one preferences PATCH. Both header selectors
  and Save were disabled while Profile status stayed editable. Text entered after
  consent survived completion and the canonical Japanese render. Only that new
  status field was edited in this live probe; selective multi-field consent-delta
  distinctions have independent deterministic evidence, not extra live claims.
- Japanese html.lang/title/profile/header all agreed, controls unlocked, and a fresh
  same-browser Profile independently showed persistedja but the original saved
  status. Root restored the unsaved status, then headerja->zh-CN succeeded and all
  locale surfaces agreed in Chinese.
- With a new dirty draft, root approved a headeren change and deliberately failed
  its OPTIONS preflight, not a dispatched PATCH. The UI retained Chinese/draft,
  unlocked both selectors/Save and showed localized role=alert unknown-outcome
  guidance. All Fetch patterns were cleared before releasing/failing requests;
  no request headers, tokens, bodies or cookies were read.

The requested viewport.set320 did not alter the effective layout: clientWidth and
visualViewport.width392, innerWidth407, body/headerWidth392, html min-width320.
Latest error feedback had scrollWidth392 and a visible mobile exit. Do not claim
320px acceptance for this latest candidate from that ineffective override. Root
reset the override and original draft after observing it.

The live failure guidance asks users to read latest state before retrying, but
the intact Profile/header has no explicit read action; browser reload would risk
the retained draft. This is now a targeted follow-up repair, not a reason to stop
all testing or start a new framework. Deferred native device tests remain untouched.

## Candidate16: final actual read-only recovery acceptance

After bounded implementation/review, root independent final Account26files/231tests,
TypeScript/Vite build and whitespace checks passed. Candidate15 deployed before a
late review found stale failure feedback/read button surviving401; it is superseded
by candidate16, which includes the401 UI cleanup and permanent authority/visible-UI
regressions. No live authentication session was revoked or fabricated to claim a
real401 journey; that particular branch has deterministic independent evidence.

Actual final Browser loaded index-BcRIcomX.js from Account staging deployment
56e1b83d-8fe6-4add-9e72-e51eb8ac1031. Root entered separate status and bio drafts,
selected headeren and approved the localized discard decision. The one controlled
OPTIONS preflight failed before dispatching a preferences PATCH, and all Fetch
patterns were cleared. The original drafts remained and Read latest state appeared
beside the actionable header alert on the visible mobile surface.

Root clicked the actual Read latest state button. After canonical refresh:
- Both complete status/bio drafts remained; document language stayedzh-CN.
- Failure feedback and read action became hidden; both selectors were enabled.
- Focus was SELECT with accessible name Language (localized Chinese), not the now
  hidden read button or the page body.
- A fresh same-browser Profile read original saved bio/status, zh-CN, default logo
  avatar and one primary contact. The retained drafts and intended English change
  were not submitted by the read action. GET-only/no-replay is also asserted directly
  in permanent/independent command tests; no live request-header/body trace is inferred.

Root closed that observer and restored both original field values in the main tab.
No stale device prompt, extra contact/avatar, network override or explicit viewport
override remains. Screenshot failure/ineffective320px override limits from earlier
sections remain explicit; neither is silently promoted to visual acceptance.
All owned source/test/review/deploy work for this resumed round is terminal. Keep
the original goal's deferred device/credential coverage distinct from these delivered
non-device fixes, rather than repeating the earlier whole-goal stop mistake.
