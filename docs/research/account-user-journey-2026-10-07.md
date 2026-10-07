# Account user-journey repairs (2026-10-07)

## Profile interface language persists but never selects the interface (candidate 13 follow-up)

Status: **reproduced; correction pending**. This bounded follow-up performed no
Browser/mail/device/deployment or production source operation. Parent already
accepted candidate-13 page-owner behavior separately; header reload navigation is
not assumed to belong to that page-local mutation owner.

Contract evidence: `apps/account/README.md` lists locale among editable Profile
settings and distinguishes non-sensitive local UI preferences. More decisively,
`docs/adr/0003-account-platform-redesign.md` (internationalization section) specifies
authenticated account preference before explicit local/cookie/browser fallback.
The Profile control itself is labeled `Interface language` / `界面语言` /
`表示言語`; it is not presented as an unrelated public profile language claim.
No inspected documentation says saving this field should leave the whole interface
in another language indefinitely.

Actual implementation has two independent sources: header/startup read
`moe.account.locale` (or browser language), whereas Profile renders and PATCHes
`AccountPreferences.locale`. The main translator, document language, header and
shell are initialized before the authenticated preferences read and are not updated
from that read or after Profile Save. Persisting `ja` therefore succeeds at the API
while English UI and English local preference remain, including subsequent startup.
This is a misleading setting, not a failed API write.

Deterministic actual-entry reproduction:
`.temp/account-profile-locale-consistency.test.ts` imports actual `main.ts`, pages,
draft, page-operation owner and shell, replacing only `AccountApiClient` with a
controlled in-memory service. Initial local and authenticated preferences both
equal `en`. Set Profile locale to `ja`, Save, await the fresh canonical Saved form.
Assertions prove:

- Exactly one preferences PATCH includes `locale: "ja"`; canonical service is `ja`.
- Fresh Profile renderer marks the Japanese option `selected`.
- `document.documentElement.lang`, header selector, `Edit profile`, `Saved`, and
  local preference all remain English.
- Resetting module evaluation and bootstrapping actual main against the persisted
  Japanese service and same local preference still renders English.

The test uses the renderer's `option[selected]` attribute for canonical Profile
selection because happy-dom exposed inconsistent `.value` versus selected-attribute
state during draft/FormData processing. No separate browser selection defect is
claimed from that harness behavior; the document/header/text/localStorage evidence
does not depend on it. Rebootstrap is module/DOM reinitialization, not browser reload.

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root .temp account-profile-locale-consistency.test.ts --maxWorkers=1
```

Result: **1 file / 1 expected-defect test passed**, Node 24.18.0. Production files
were not changed by this probe.

Recommended product correction: make authenticated interface language one explicit
policy, using canonical `AccountPreferences.locale`, not the separate legacy
`account.profile.locale`. Profile Save must visibly apply its confirmed canonical
language, including shell, header, dialog strings, document language/title and
page translations. Do not simply force document reload: newer edits intentionally
remain possible during Save and would be lost. Preserve the current in-memory draft
and refresh/relabel within the same document; apply only confirmed canonical state,
never an unacknowledged submitted value after preferences failure. Existing partial
feedback must use the effective language consistently.

Startup must also implement the documented authenticated preference precedence;
merely updating localStorage on Profile Save would mask this one fixture but not
fix another device or a stale local override. Header changes need an explicitly
consistent contract: authenticated changes should update the same account preference
(with their own failure/ownership handling), or a deliberate browser-only override
must be clearly documented and labeled as such. Anonymous header changes can remain
local. This is separate from candidate-13's mutation-serialization boundary; do not
silently widen that lock to arbitrary header/document navigation.

If the product intentionally wants account locale metadata independent of interface
language, the alternative is to rename/described the Profile control accurately and
revise the ADR precedence. Keeping an inert control labeled Interface language is
not a defensible resolution. Parent owns implementation scope and real staging
acceptance; this probe supplies a reproducible, user-visible decision point.

## Scope and evidence boundary

Account frontend only. Production deployment is forbidden for this investigation.
The main agent owns real staging registration, sign-in, and interactive browser
acceptance with a newly created test account. This workstream has not interacted
with an existing user's account or inspected browser storage, cookies, or profiles.

The prescribed Browser runtime import failed with `EPERM` from Node `realpath`
on the official plugin module. The same sandbox failure affected Vite source
resolution. The parent was notified immediately. Computer Use also stopped before
interaction because it could not establish the current URL for its safety check.
After the user repaired permissions, a fresh agent connected to the in-app Browser;
real baseline and acceptance results are recorded separately. This implementation
workstream does not claim browser-level acceptance.

Relevant prior knowledge: `docs/research/account-production-delivery-2026-10-05.md`,
`docs/incidents/2026-10-03-device-sign-out-feedback.md`, and the Account README.

## Repaired defects

### Mobile users had no sign-out control

The only command lived in `.sidebar .user-chip`. The existing `max-width: 52rem`
media query hides the entire sidebar. Neither mobile header nor bottom navigation
provided another sign-out action, so mobile users lost a core account operation.

Resolution: a localized, accessible sign-out icon button in the mobile header,
outside the preference controls that theme changes replace. It uses the same
first-party current-session revocation command as desktop, not a new logout protocol.
Both controls share one pending lock and busy state; switching responsive surfaces
while a command runs cannot send a second revocation. Anonymous/pending states hide
both controls. Header wrapping preserves access on narrow screens.

Regression coverage checks authenticated/anonymous visibility, accessible name,
placement outside the sidebar, preference-control replacement, shared duplicate-click
protection, and command completion. DOM tests cannot validate actual pixel layout;
the staging mobile viewport remains a browser acceptance gate.

### Saving profile could corrupt existing multiple links

The API stores `links: string[]`; rendering joined them with newlines into a
single-line text `input`, while submission splits on newlines. HTML text inputs
sanitize away newlines, so simply opening a multi-link profile and saving an
unrelated field concatenates URLs into one invalid value. This is an unsafe
representation mismatch, not a backend list-validation problem.

Resolution: use a native `textarea` with the existing line-list parser. No API,
storage, or migration change is necessary. Existing bio length limits remain;
multiline fields opt into limits only when the underlying field requires one.
Tests cover preservation while editing an unrelated field, blank-line trimming,
adding two URLs, and clearing to an empty list.

## Verification

On 2026-10-07, authorized local execution outside the Windows sandbox:

```powershell
node node_modules/vitest/vitest.mjs run --root apps/account --maxWorkers=2
npm run build:account
```

- 14 test files / 69 tests passed.
- TypeScript project build and Vite build passed.
- Entry JS: `index-BoSusMrm.js`, 52.69 kB / gzip 18.44 kB.
- Entry CSS: `index-Cm9u4NyS.css`, 17.14 kB / gzip 4.60 kB.
- No deployment performed by this workstream.

## Grounding and next browser probes

- The [HTML Standard](https://html.spec.whatwg.org/multipage/input.html) defines
  text inputs as one-line controls and specifies newline removal; a multiline
  list should use [textarea](https://html.spec.whatwg.org/multipage/form-elements.html).
- [WCAG Reflow](https://www.w3.org/WAI/WCAG21/Understanding/reflow) frames responsive
  adaptation as preserving information and functionality, not merely fitting pixels.
  Hiding the only sign-out operation violated that practical product constraint.
- [Passkeys in the Wild, SOUPS 2026](https://www.usenix.org/conference/soups2026/presentation/ramat)
  studies UX consistency across 111 websites with 28 factors. Project inference:
  maintain visible, recoverable account controls across responsive surfaces before
  optimizing ceremony presentation; real viewport and keyboard tests remain necessary.

Pending parent-owned staging checks: sign in; edit two links; change display name and
save/reload; narrow viewport and change theme; find and use sign-out; confirm only
the fresh current session is revoked. A separate candidate for later investigation
was silent profile-draft loss on route navigation; the repair below now covers route
links, document exits, and same-document Back/Forward traversal.

## Draft protection and save-race repair (2026-10-07)

The previously interrupted guard is now complete for intercepted Account route links.
Discard confirmation and concurrent-save feedback are localized in Chinese, English,
and Japanese. A current-route click is a no-op rather than a destructive rerender.
Modified clicks, downloads, external origins, and new-tab targets retain native behavior.
Native `beforeunload` requests a standard browser warning for reload/tab/document exits;
actual warning display depends on browser policy and requires interactive acceptance.

Only the registered profile text/select form is tracked in a WeakMap. Values are never
written to browser storage. Live FormData comparison detects autofill and reverted edits
without requiring input-event bookkeeping. Sensitive security forms are not registered.

The save callback formerly accepted live form values after awaiting both mutations and
then refreshed the page. A user typing during that request could have their newer edits
silently marked saved and immediately erased. The baseline now accepts only the captured
submitted FormData. Every successful save still refreshes the canonical Account session;
skipping refresh would leave the shell/session account stale and could resurrect the
pre-save display name after discarding a newer draft and navigating back. Before refreshing,
changed profile text/select values are captured; after loading fresh account/preferences/
CSRF data, they are restored into the newly rendered form without changing its baseline.
Unedited fields retain concurrent server updates. This policy also covers avatar and
contact mutations, whose independent refreshes previously erased profile text edits.
Only plain changed string values survive: never old DOM, controllers, credentials, uploads,
or CSRF proofs. Aborted-page refresh callbacks cannot rerender a later page.

A route/principal-bound in-memory slot preserves these values through refresh failure and
retry. The failed-refresh screen still warns before route/document exits. Successful
rehydration clears the slot; explicit discard, anonymous state, and principal mismatch discard
it. Nothing enters persistent storage.

The same slot now retains profile edits across native Back/Forward traversal. Capture is
centralized before destructive route rendering, even though `popstate` has already changed
the URL. Typed navigation policy distinguishes preservation from explicit visible-draft
discard; it does not cancel traversal or rewrite history. A retained draft survives
unrelated routes without repeatedly prompting on sidebar clicks. Document exit and locale
reload still consider hidden edits. Returning to Profile reloads canonical session state
before rehydration. Accepted explicit discard skips recapture, so history cannot resurrect
the discarded values.

The primary browser driver also reported a real interaction defect in candidate 1:
profile save succeeded, but its success message disappeared with the canonical refresh.
Profile save now sends typed `profile-saved` feedback to that refresh. The newly rendered
form displays localized saved/saved-with-newer-edits feedback after rehydration. Ownership
is scoped to the profile route, initiating principal, and live render signal; aborted
or principal-switched renders never show an old success acknowledgement.

Locale selection now asks the localized discard question before changing state/storage.
Cancellation restores the rendered language selection. Approved reload removes the native
exit-warning handler to avoid a duplicate prompt. Theme preference-control rebuilding
now has a single startup media listener instead of accumulating one on every click.
Failed/partially failed saves retain the dirty baseline; repeated submits are locked.
The API contract and durable account data shape are unchanged.

Focused evidence (no Browser acceptance claimed):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account --maxWorkers=2
fnm exec --using=24.18.0 -- npm.cmd run build:account
```

- Final clean test run on supported Node 24.18.0: 17 files / 86 tests passed,
  no network-error output.
- Account TypeScript/Vite build passed; entry `index-B2FvE7b8.js`, 55.53 kB /
  gzip 19.49 kB; CSS remains `index-Cm9u4NyS.css`, 17.14 kB / gzip 4.60 kB.
- Added tests cover live/reverted edits, submitted-snapshot races, sensitive-form exclusion,
  failed save retention, duplicate-submit prevention, route cancellation/acceptance,
  native new-tab/download behavior, current-route preservation, and exit-warning disposal.
- A real `main.ts` + profile-page DOM integration test exercises avatar-triggered refresh
  failure/retry, cancelled locale selection, one media listener after repeated rebuilds,
  draft warnings during failure, fresh CSRF on the restored form's save, newer edits during
  save, canonical saved display name after discard/navigation, principal mismatch, and
  ignored stale-page completion. It now also invokes native history back/forward and checks
  retained edits with fresh untouched server fields, hidden-draft locale/document warnings,
  unrelated-route navigation without prompts, non-resurrection after explicit discard,
  stable fresh-form save feedback, and suppressed principal-switched/aborted feedback.
  These are DOM/API-double checks, not browser acceptance.
- No commit, push, or deployment performed.

Remaining integration gates: browser-native dialogs and narrow-screen layout require
real-browser checks, including native Back/Forward retention in the next Account candidate.
`popstate` is never cancelled and this patch does not add history-rewrite heuristics.
The shared refresh policy protects registered profile text/select edits; unsent avatar
previews and add-contact/verification/security forms are deliberately outside its scope.

## Contact operation ownership and recoverable verification (2026-10-07)

The contact panel had independent `Confirm` and `Resend` busy flags. Both handlers
could therefore execute simultaneously. The backend intentionally cancels a pending
transaction when it successfully sends a replacement code; allowing the browser to
confirm the previous transaction during that replacement creates an avoidable race.
The add form also disabled its submit button but did not guard the submit handler,
so another submit event could send a second creation request while the first waited.
These are source/DOM-reproduced defects, not conclusions drawn from the live Browser
focus/modal transport failures.

Repair: contact verification now has a single per-form operation owner. Confirmation
and resend acquire the same lock; both buttons are disabled and the code input is
read-only until that operation settles. A wrong-code failure preserves the original
transaction and entered code, then releases the lock for correction or resend. A
resend cooldown/network rejection likewise retains the usable original challenge;
a successful resend replaces it and clears the obsolete code. The initial send
button remains retryable on failure. Add submission now guards reentry, keeps its
entered value on failure, clears stale error feedback on retry, and exposes errors
as an accessible alert. Initial send, add, confirm and resend ignore terminal
results after the owning page's abort signal; old mutations cannot refresh or steal
focus from a newly navigated page. Existing CSRF/idempotency/API policy is unchanged.

Changed implementation: `apps/account/src/pages.ts`. Seven focused regressions in
`apps/account/src/contacts.test.ts` cover duplicate add and retry, initial-send retry,
confirm/resend mutual exclusion in both directions, wrong-code recovery, cooldown
rejection recovery, replacement transaction selection, and navigation aborts.
The existing local Worker/D1 contact harness now additionally checks wrong-code
400 followed by correct-code 200 in the same pending transaction, exactly one
consumption, atomic primary switching with verification retained, removal of both
channels, and empty list readback. Its completion code is synthetic, with a digest
written only to its isolated local D1; this is not staging email-delivery evidence.

Verification (Node 24.18.0 via `fnm`, 2026-10-07):

- Account Vitest: 18 files / 93 tests passed (7 new contact tests).
- `npm run build:account`: TypeScript and Vite passed; JS `index-BBBNyo9t.js`.
- `node scripts/tests/contact-verification.mjs`: real local Worker + isolated D1
  create/list/start/replay/cooldown/wrong/correct/replay/reuse/promote/remove passed.
- No backend schema/source change, mail access, staging mutation, deployment, or
  commit was performed by this source workstream. Parent owns real Browser acceptance.

The design reuses native disabled/read-only controls rather than a second retry
protocol, consistent with the HTML form-control grounding above. The lock expresses
the backend transaction invariant directly: code replacement and code consumption
are mutually exclusive user operations, while failure must leave an actionable path.

## Contact verification: actionable localized failures (2026-10-07)

Parent-owned staging Browser acceptance subsequently reproduced a genuine product
issue beyond the operation races: a wrong code rendered a Chinese failure prefix
followed by English server text and a long correlation UUID. It did not tell the
user how to recover, and the diagnostic dominated the primary feedback. This
finding comes from the actual wrong-code browser journey, not a transport timeout.

`verificationButton` now presents initial-send, confirmation and resend errors with
one bounded local formatter. Stable `error_code`, or the exact Identity Problem
Details type URI when that extension is absent, selects zh-CN/en/ja instructions:
check the latest eight-digit code; resend an expired/inactive code; wait after a
rate limit; retry later if delivery is unavailable; or sign in again. Unknown
failures get a safe localized retry instruction rather than arbitrary server prose.
The actual client's `ApiError(status=0)` network wrapper maps to a connection/retry
instruction. Native closed `details` retains the response-header correlation ID
(or body fallback) for support, without putting it in the default primary sentence.
Neither server message text nor entered codes/contact addresses are interpolated.
Success/resend feedback clears previous diagnostics. Existing alert/status roles,
operation ownership, challenge preservation, CSRF and backend contracts are retained.

429 wording is deliberately operation-neutral: "Too many requests. Wait a little
before trying again." The same formatter can handle confirmation and sending, so
it must not promise that confirmation is always available during rate limiting.
The backend remains authoritative. Its current CORS response exposes correlation
ID but not `Retry-After`; this change does not invent a local cooldown interval,
ignore or bypass 429, change backend policy, or permanently disable retry controls.

Validation: 24 additional parameterized DOM regressions across all three locales
cover typed wrong-code/expired/rate-limited/unavailable/authentication/unknown errors,
type-URI fallback, header/body diagnostic preservation, closed diagnostic defaults,
success cleanup, and real `AccountApiClient` fetch rejection wrapping (injected
fetch, not external network). Node 24.18.0 Account tests: 18 files / 117 tests passed.
TypeScript + Vite build passed; entry JS `index-CMbe9rQB.js`, CSS unchanged. Focused
`git diff --check` passed. Changes are in `pages.ts`, `i18n.ts`, `contacts.test.ts`;
no deployment/mail/browser/backend mutation by this source workstream. Parent owns
staging candidate deployment and final visible feedback acceptance.

## Avatar canonical-refresh acknowledgement (2026-10-07)

Parent's real staging Browser journey confirmed select/preview/cancel/reselect and
upload, including the actual staging WebP URL. The freshly refreshed avatar card
nevertheless had an empty inline message: upload success was written only into
the discarded card, just like the previously repaired profile-save feedback.

The existing typed `RefreshFeedback` now includes `avatar-saved`. Both upload and
remove request the ordinary canonical refresh with this acknowledgement. Only
the fresh profile route's avatar card receives the localized `saved` message,
after session/CSRF reload and profile draft restoration, and only when the owning
render is not aborted and its principal is unchanged. The profile form does not
receive avatar feedback. No old DOM reuse, skipped refresh, persistent storage,
API contract changes, or CSS changes are introduced. Upload and remove also skip
refresh requests after their original page aborts.

Regression evidence covers exact upload feedback ownership, removal feedback,
late upload after navigation, unchanged profile draft retention during avatar
refresh, fresh CSRF on the next profile save, principal-switch suppression, and
navigation during an unresolved avatar refresh. Node 24.18.0 Account Vitest:
18 files / 118 tests passed. TypeScript and Vite build passed; entry JS
`index-DYPspyGU.js`, CSS `index-Cm9u4NyS.css` unchanged. This source workstream
performed no deployment, Browser/mail operations, or commit; parent owns staging
deployment and the final browser acceptance of persistent acknowledgement.

## Sign-out uses the same draft-discard decision (2026-10-07)

Parent source review identified a separate draft-loss exit: sign-out revoked the
session and cleared drafts before document navigation, so beforeunload could no
longer warn. `signOut` now calls the existing `canDiscardDraft` before any session
lookup or revocation. It covers both a visible dirty profile and an in-memory
history draft hidden on another route. Cancel leaves the authenticated page and
draft intact, makes zero sign-out API calls, and releases both responsive shell
buttons through their existing shared command lock. Clean sign-out does not ask.

Approved discard preserves the existing current-session-only revocation and paired
Login navigation contract. Drafts are still cleared only after successful sign-out,
so a failed revocation remains retryable. Successful clearance means the ensuing
document exit does not show a duplicate native draft warning. No additional
framework, persistent draft storage, or sign-out backend policy was introduced.

The main integration regression now exercises visible cancel, hidden-history
cancel and restoration, clean sign-out with ordinary revocation failure/retry,
and approved hidden discard with exactly one confirmation, current CSRF, anonymous
state, paired Login navigation, and no beforeunload warning. Node 24.18.0:
18 files / 118 Account tests passed; TypeScript/Vite build passed. Current entry JS
`index-DuwvYrvm.js`; CSS remains `index-Cm9u4NyS.css`. No deployment, Browser/mail
operations, or commit were performed by this source workstream.

## Explicit, route-scoped draft-discard dialog (2026-10-07)

The parent-owned real Browser journey exposed a usability problem in the previous
native `window.confirm` guard: the generic affirmative button does not name the
consequence, and the user clicked it when the requested test step was cancellation.
The built-in Browser also did not expose that native dialog through `getJsDialog`.
The product change is justified by the unclear action, not by assuming a tool
protocol failure proves a browser or backend defect.

In-app route links, language reload, and sign-out now use one small native HTML
`dialog` owner. Visible zh-CN/en/ja buttons name the actual decision: continue
editing versus discard and leave / change language / sign out. The description
states that only unsaved profile changes are lost; saved profile data is unchanged.
The safe action is initially focused. Escape, unexpected close, unsupported modal
opening, or an aborted owning render resolve as cancellation. The caller's focus
is restored after cancellation once the shared sign-out buttons unlock, provided
its route lifetime and dialog generation are still current. The browser supplies
modal top-layer/inert/focus-containment behavior through `showModal`; no custom
modal framework, focus trap, browser-security workaround, or history rewriting
was introduced. Browser-native `beforeunload` warnings remain unchanged for
reloads, tab closure, and other document exits.

Consent is not a global boolean that another command can reuse. A competing dialog
request is rejected rather than subscribed to the first command's approval. Each
request is tied to the active render AbortSignal; route refresh/traversal and
anonymous transition close it and invalidate its stale button handlers. The main
coordinator rechecks controller/principal ownership before accepting the decision,
and rechecks controller ownership before committing language changes or starting
session revocation. Same-origin route links await approval before history mutation,
ignore duplicate link activation while deciding, and invalidate late approvals on
native history traversal/disposal or URL changes. Back/Forward still preserves
route-owned profile drafts and refreshes canonical account/CSRF data. Explicit
approved route discard still clears the visible draft without recapturing it.

Language controls immediately return to the currently rendered locale while the
dialog is open; no storage write or reload occurs before approval. A clean exit
does not open a dialog. Sign-out retains its shared desktop/mobile operation lock,
current-session revocation, failure retry, and paired Login destination. Successful
sign-out clears draft state before the document exit, avoiding a duplicate warning.

### Grounding

- [HTML Standard: dialog](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-dialog-element)
  provides modal top-layer and inert-background semantics, cancellation and native
  focus behavior. We use the platform primitive instead of implementing these
  mechanisms with a framework.
- [WAI-ARIA APG: modal dialogs](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
  calls for a named modal, contained keyboard focus, Escape cancellation, visible
  closing action, and sensible focus return. Its guidance favors the least
  destructive initial focus for hard-to-reverse actions. Native dialog implements
  modality; explicit labelled title/description and buttons supply the semantics.
- [GOV.UK Design System: buttons](https://design-system.service.gov.uk/components/button/)
  recommends action-describing text and reserves warning buttons for consequential
  destructive actions. Here the destructive consequence is loss of unsaved edits,
  not account deletion; the safe action stays prominent and initially focused.
- The existing [SOUPS 2026 Passkeys in the Wild](https://www.usenix.org/conference/soups2026/presentation/ramat)
  grounding supports consistency and recovery as account-journey concerns. It does
  not empirically validate this particular dialog; the parent's actual Browser
  acceptance below is still required.

### Local verification and Browser acceptance boundary

Regression coverage uses real DOM dialog decisions, not a mocked confirmation:
three explicit intent labels and initial safe focus; cancel/focus return; Escape
and close; competing-command rejection; render abort and stale retained button;
unsupported modal fail-closed; pending/duplicate route decisions; stale approval
after traversal/disposal; deferred locale commit; complete localization; and the
existing full refresh/draft/CSRF/principal/feedback/sign-out integration workflow.
The integration also opens a sign-out dialog before native Back and verifies the
dialog closes, the old approval cannot revoke a session, and Forward restores the
same draft. DOM tests do not prove native keyboard focus trapping or real layout.

Parent-owned staging acceptance steps:
1. Dirty a profile; activate a sidebar destination. Confirm the dialog's full
   explicit labels, default safe focus, Tab/Shift+Tab containment, and Escape.
   Cancellation must retain URL, draft, authentication, and invoking-link focus.
2. Approve discard/leave; return to Profile. The abandoned draft must not reappear.
3. With a dirty profile, change language. Verify the select returns to its actual
   current language while deciding. Continue editing must preserve locale/storage,
   draft, focus and URL. Explicit discard/change language reloads exactly once
   without a second native document-exit warning.
4. Dirty a profile and activate each responsive sign-out control in turn. Continue
   editing keeps the session/draft and re-enables both buttons. Explicit discard/
   sign out revokes only this fixture's current session and reaches paired Login.
5. Use native Back/Forward with a pending dialog; consent must cancel and profile
   values must survive through the existing canonical refresh. Repeated activation
   must not open multiple dialogs or cause multiple navigation/revocation commands.
6. Recheck 320px layout, all three locale labels, theme switching, clean sign-out,
   persistent save/avatar acknowledgements, and native document-exit warning.

No deployment, mail/authentication mutation, Browser operation, commit, or production
change was performed by this implementation workstream. Parent owns acceptance.

Final implementation check: anonymous transition aborts authenticated consent and
creates a new live anonymous render scope, so post-sign-out language switching is
not accidentally disabled by the old aborted controller. The integration verifies
anonymous language persistence/reload without any discard dialog.

Node 24.18.0 final local verification: **19 files / 132 Account tests passed**;
TypeScript project build and Vite build passed. Current entry JS is
`index-tOWWfQ__.js` (61.76 kB, gzip 21.40 kB), CSS `index-Cz7B_ZUW.css`
(17.67 kB, gzip 4.71 kB). The previous 118-test staged candidate is not evidence
that this new dialog has reached staging; deployment and Browser acceptance remain
parent-owned. Focused source `git diff --check` passed (line-ending notices only).

## General network-failure guidance uses the current locale (2026-10-07)

The parent observed an actual Sessions navigation failure with a Chinese headline
and raw English `Unable to reach the identity service.` detail. Contact-local
verification errors already had bounded localization, but `main.renderFailure`
still rendered the API client's transport message verbatim.

The global failure renderer now maps `ApiError` status 0 or the stable
`urn:moesegfault:problem:network` type to a dedicated `networkUnavailable` message
in zh-CN/en/ja. This is general identity-service retry guidance, not verification
service wording. Other API Problem Details retain their existing detail; generic
non-API failure and 401/anonymous behavior are unchanged. The error object and its
correlation ID are not changed, and the existing retry button and route-owned
draft recovery remain intact. No dialog/consent architecture was changed.

The main integration obtains the actual status-0 error from a real
`AccountApiClient` with an injected rejected fetch (not an external request),
asserts localized global guidance rather than the English transport sentence,
retries through an ordinary 503 with its original detail/correlation intact, then
restores the user's profile draft against fresh canonical data and CSRF. All
three locale dictionaries provide distinct general and verification messages.

Node 24.18.0: 19 files / 133 Account tests passed; TypeScript/Vite build passed.
The last extra ordinary-503 integration assertion was separately rerun with
main/i18n: 2 files / 9 passed. Current JS `index-CUoGE9F9.js` (62.21 kB,
gzip 21.49 kB); CSS remains `index-Cz7B_ZUW.css`. Focused diff check passed.
Parent owns staging deployment and actual failure/retry acceptance; this workstream
performed no Browser, mail, authentication, deployment or commit operation.

Final post-assertion full rerun also passed: 19 files / 133 tests (Node 24.18.0, 16:34 local). Source and built entry hash above are unchanged.

## Network localization also covers mutation feedback (2026-10-07)

The parent then reproduced the same real transport failure while revoking a
non-current Sessions entry: the inline action error was still English because
mutation presenters bypassed `main.renderFailure`. The browser owner correctly
checks refreshed server state before retrying an operation with an unknown remote
outcome; this source change does not add automatic mutation retries.

`api/error-message.ts` now holds one small typed `apiErrorMessage` formatter shared
by the global failure renderer and mutation text. It maps only status 0 / the
stable network type when the caller provides localized wording, leaves all other
API detail intact, and never modifies the error/correlation object. The existing
exported `pages.errorText(error, fallback)` behavior remains compatible: a third,
optional network-message argument opts into localization while retaining the
existing ` · ID ...` suffix. All ordinary Account mutation errorText sites now
pass the current locale's general `networkUnavailable` message: profile save,
avatar upload, contact add, credential rename, and the shared mutation presenter
used by session/app/contact/avatar actions and password/security operations.
Contact verification keeps its separate actionable formatter and diagnostic UI.
No authentication, consent/dialog, CSRF, draft baseline, history, or API policy
was changed.

Focused coverage: real AccountApiClient injected rejected fetch through Sessions
revocation in zh-CN/en/ja; alert text localized, button unlocked, no success/refresh
or automatic retry, and explicit subsequent activation succeeds and clears feedback.
The profile-save regression now uses the actual client transport wrapper, checks
localized failure and retained dirty values, then explicitly retries the same
patch and requests canonical success refresh. A compatibility regression preserves
legacy two-argument errorText behavior, ordinary Error/fallback text, non-network
API detail, correlation suffixes, and both status-0 and stable-type matching.
The existing actual-client Sessions history/retry test now expects Chinese recovery
guidance instead of the obsolete English transport sentence.

Node 24.18.0 verification: **19 files / 137 Account tests passed**; TypeScript/Vite
build passed. A final extra stable-type assertion was rerun with pages/Sessions:
**2 files / 23 passed**. Focused diff check passed. Current entry JS:
`index-CKMvzvPn.js` (62.38 kB, gzip 21.51 kB), SHA256
`260347FCF231E00A0AB52415C90D95730E9F254622B01C549220A8E661873C82`;
CSS unchanged `index-Cz7B_ZUW.css`. Parent owns staging deployment and real
mutation-failure/recovery acceptance. No deployment, Browser, mailbox, authentication
mutation, or commit was performed by this source workstream.

## Explicit two-action keyboard wrap after staging observation (2026-10-07)

On the parent-owned actual candidate-8 Browser journey, the modal opened with
Continue editing focused. The first Tab moved to the destructive action inside
the dialog, but the second Tab left `document.activeElement` at `document.body`
(`closest('dialog')` was false), rather than wrapping to the safe action. This
observation does not establish whether browser chrome, runtime instrumentation,
or engine focus sequencing caused the transition. It does establish that the
current two-button modal did not meet the intended keyboard-containment behavior
in the actual acceptance environment. Escape already cancelled successfully and
restored the Overview invoking-link focus while retaining `/profile`.

The native dialog now handles only unmodified Tab boundaries: forward from the
last/destructive action focuses Continue editing; Shift+Tab from the first/safe
action focuses the destructive action. A dialog-container focus also moves to the
appropriate boundary action. Ordinary inner traversal, Alt/Ctrl/Meta+Tab, and
Escape remain native. The modal still uses `showModal`, the native top layer and
inert background, native cancel/close handling, and the same lifetime-scoped
consent owner. This is a bounded wrap for the known two-action dialog, not a
framework or a general-purpose focusable-element scanner. If the dialog later
adds interactive controls, its explicit two-action boundary invariant must be
updated with those controls and their tests.

New DOM regressions cover both wrap directions without settling consent, inner
forward/backward traversal not prevented, reserved modified Tab not intercepted,
and Escape not intercepted by the keyboard handler. Existing abort, competing
consent, cancellation/focus return, localization, and draft/sign-out integration
regressions still pass. Node 24.18.0 full Account suite: **19 files / 139 passed**.
After the final extra inner-backward assertion, focused dialog suite: **11 passed**;
TypeScript/Vite build passed. Current entry JS `index-S-Z4jL6-.js` (62.60 kB,
gzip 21.59 kB), SHA256
`B1EA6040C6ED5C233DA3A4D375C866E92374A334E39641E3D89459AFFB9F1814`;
CSS remains `index-Cz7B_ZUW.css`. Focused diff check passed.

Parent-owned Browser closure: repeat safe -> Tab -> destructive -> Tab -> safe;
then safe -> Shift+Tab -> destructive -> Shift+Tab -> safe. Confirm focus stays
inside the dialog on each step; Escape still cancels and restores invoking-link
focus, URL, draft and authentication. No Browser operation, deployment, mailbox,
authentication mutation, or commit was performed by this implementation workstream.

## Mobile cancel focus: observation boundary (2026-10-07)

Parent confirmed candidate-9 actual bidirectional keyboard wrap, initial safe focus,
and 320px Japanese mobile sign-out cancellation retaining draft and authentication.
A post-cancel empty activeElement.textContent alone does not prove focus loss:
the mobile sign-out control is SVG-only and named by aria-label. Parent is checking
actual tag/class/aria-label before classifying a defect.

Source inspection identifies a possible platform-dependent capture ordering:
Shell disables both responsive sign-out buttons before calling signOut, whereas
the dialog captures document.activeElement inside that call. The HTML focusable-area
conditions exclude actually disabled controls:
https://html.spec.whatwg.org/multipage/interaction.html#focusable-area . This is a
risk hypothesis, not proof that a particular engine has already moved focus when
the dialog reads it. `.temp/mobile-discard-focus-probe.test.ts` exercises the real
Shell -> dialog order and cancellation in Happy DOM. It retains/captures/restores
the mobile button (1 test passed, Node 24.18.0), so this emulator does not reproduce
the hypothesized loss. Production source and build were deliberately unchanged;
actual Browser tag/class/name evidence determines whether any correction is needed.

## Password card: one mutation owner and scalar-aligned policy (2026-10-07)

Scope: Account security password card only. Root's real Browser check confirmed an
empty Save correctly focused the required current-password field but showed no
password-policy hint. Current source independently allowed set/delete ownership
to overlap: submit had no pending guard, while Delete used a separate actionButton.
A committed mutation followed by failed refresh could also become clickable again.
These are interaction/lifetime defects, not permission-policy or endpoint changes.

The card now owns idle/pending/completed state shared by both actions. It captures
credentials before disabling both buttons and fields, ignores queued submit/opposite
activation, and uses the existing CSRF/signal API contract. Failures before commit
unlock for deliberate user retry and retain existing recent-auth Login recovery and
last-authenticator error presentation. Success becomes completed before refreshing;
refresh failure cannot replay set/delete, and an accessible localized message asks
for document reload instead. Normal canonical refresh remains authoritative; no
new global toast or success protocol was introduced. Password field values are
cleared after commit and on route abort. Late completion/rejection cannot refresh
or write feedback for an aborted card. Security forms remain unregistered for
profile draft preservation; no credential value enters storage or the draft cache.

Policy is derived from crates/identity-domain/src/policy.rs::validate_password:
15 through 128 Unicode scalar values, rejecting char::is_control, without trimming
or case folding. The JS helper counts Array.from(value), rejects Unicode Cc control
characters and invalid lone surrogate values, and preserves other characters and
spaces exactly. Visible policy text is localized in Chinese/English/Japanese and
associated with the new-password field using aria-describedby. Native required
validation remains; custom validity and aria-invalid communicate the scalar policy.

Native minlength/maxlength count UTF-16 code units, not Unicode scalars. The old
minlength=15 could accept eight astral characters (16 units) although the backend
requires 15 scalars; a naive maxlength=128 would instead exclude valid passwords
containing 128 astral characters (256 units). Neither native length attribute is
used for this contract. Grounding:
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/minlength
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/maxlength

Deterministic real-card DOM tests use deferred API promises to cover both set-first
and delete-first overlap, duplicate submit/direct activation, failed mutation retry,
committed mutation with rejected refresh, idle/in-flight abort, late success and
failure, recent-auth compatibility (existing suite), last-method rejection, draft
exclusion, and exact credential bytes. Scalar tests cover 14/15/128/129 boundaries,
astral 8/15/128/129, allowed spaces, C0/C1 controls, newline, and lone surrogate.
All three locales exercise a visible policy hint and acceptance of 128 astral scalars.

Verification on supported Node 24.18.0:

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account --maxWorkers=2
fnm exec --using=24.18.0 -- npm.cmd run build:account
```

- Full Account suite: 20 test files / 165 tests passed.
- TypeScript and Vite build passed; focused diff check passed.
- JS index-Cb2QE84w.js: 65.08 kB / gzip 22.42 kB, SHA256
  510A507390C40AA834836BC4B1368A1C95C8D7B6C36B14050B338758B1EB9A8C.
- CSS unchanged for this repair: index-Cz7B_ZUW.css, 17.67 kB / gzip 4.71 kB.
- This workstream performed no Browser/mail operation, password mutation against
  staging, deployment, or commit. Parent owns independent review and harmless
  Browser validation before deciding whether to stage this Account candidate.

## Mobile contact capability: remove a permanently failing verification action

Root continued the actual Profile journey with the dedicated staging fixture and
the fictitious number +1 202-555-0107. NANPA reserves 555-0100 through 555-0199
as fictitious, non-working numbers (https://nanpa.com/numbering/555-line-numbers).
This fixture is not a real recipient, and no SMS provider was invoked. Ordinary
Add saved the canonical +12025550107 pending mobile contact. Verify then displayed
'暂时无法发送验证码，请稍后重新发送。' with diagnostics, implying a transient failure.
Source correlation shows account.rs::start_contact_verification unconditionally
returns HTTP503/service_unavailable for mobile before creating any transaction.
Waiting/retrying therefore cannot complete that advertised journey.

Account now explains that SMS verification is unavailable before saving a mobile
number and beside each unverified mobile row. The form description is associated
with its number field; changing back to email hides/removes the mobile description.
Only unverified email offers the existing mail verification action. Saving/removing
mobile contacts stays supported, and already-verified mobile contacts retain
their state and primary/remove controls. No server response, verification state,
delivery capability, or policy is invented. Adding SMS delivery itself requires a
provider/product capability outside this bounded interaction repair.

Five new real-panel DOM cases cover Chinese/English/Japanese notices and zero send,
pre-add disclosure with email switch-back, and legacy verified-mobile compatibility.
Root independent combined Account suite:20 files/170 passed; TypeScript/Vite build
and whitespace checks passed. Combined JS index-DHWoPRyY.js SHA256
ACA95B3E61D374ECC82D13CBE22EA033BE9D7697019D2DE9D5295573A3EA326C.
Independent review and actual post-staging notice/removal acceptance follow.
The synthetic mobile row remains only until that acceptance and cleanup finish.

## Shared signup/contact mobile formatting (2026-10-07)

Root's actual Browser baseline selected +1 and pasted the reserved fictional example
+1 (202) 555-0107. Add returned Invalid mobile number without adding a row. Account
stripped separators but left the explicit country prefix in national_number. Login
signup also failed ordinary Japanese/UK national input with a trunk zero.

The shared, dependency-free normalizer supports only the six existing selectors:
+86, +81, +1, +44, +65, +852. A discriminated result distinguishes optional empty,
normalized payload, malformed input, selected-country mismatch, and ambiguous
double-zero input. National and matching full +country input share a canonical
payload. Whitespace, parentheses and hyphens are removed. Single national trunk-zero
removal preserves established Account intent for these selectors, not unsupported
countries. Backend digits/combined length <=15 policy, endpoints/schema, legacy
LoginIdentifier semantics, and dependencies are unchanged. This formatter does not
prove allocation, reachability, SMS capability or country-specific numbering validity.

Safety refinement: stripping all leading zeros could turn selected +86 with
0012025550107 into a different number. Double-zero input is deliberately refused
with localized instructions to use explicit +country notation. Mismatched country
prefixes never silently change the selection. Vanity numbers, extensions, inferred
countries, and worldwide dialing-prefix parsing are outside scope.

Production grounding: Google's libphonenumber FAQ explains explicit + notation,
country-specific trunk zeros, non-universal 00 international prefixes, and the
limits of parsing versus reachability:
https://github.com/google/libphonenumber/blob/master/FAQ.md . Length policy follows
the existing Rust normalize_mobile contract and the international numbering standard:
https://www.itu.int/rec/T-REC-E.164/ . No libphonenumber dependency was added.

Account validates/focuses mobile before addContact, retaining input and country.
Its format hint is described alongside the mobile-verification-unavailable notice.
Email add, CSRF/operation ownership, refresh/drafts and verification stay unchanged.
Signup validates the optional snapshot before lifecycle hold, email confirmation,
avatar preparation or final registration: invalid mobile cannot start confirmation
or consume a retained single-use proof. Correction retries with that same proof;
blank optional mobile omits the payload. Both password and Passkey submit paths use
the guard without invoking a device in these tests. Existing locale/draft ownership
is retained. Signup mobile now has a real localized label targeting signup-mobile,
separate from the independently named country select, and a described format hint.

Shared-helper and actual Account/signup form tests cover six national/full prefixes,
Japanese 090 and UK 020, formatting, mismatches, invalid/empty input, combined-digit
boundaries, 00 refusal, focus and selection preservation, localized hints/errors,
optional omission, no early email operation, and proof retention followed by corrected
registration. Existing draft/lifecycle/locale/operation regressions remain covered.
All mail, platform and API operations in these tests are doubles.

Supported Node 24.18.0 final evidence:
- Shared: 6 files / 70 tests passed; shared TypeScript check passed.
- Account: 20 files / 179 tests passed; TypeScript/Vite build passed.
- Login: 28 files / 234 tests passed including final explicit-label source;
  TypeScript/Vite build passed.
- Account JS index-CG4BOV5Q.js: 68.82 kB / gzip 23.61 kB; SHA256
  0678987D3B998AA3A7974CA2A561165E169FD6F7D950217644DE8E8670F61F46.
- Login JS index-y4d-xBqN.js: 81.78 kB / gzip 28.01 kB; SHA256
  4D4FA926A9FCBF5BD61DDF04E1E4FB87971D1F98F97C305B9AB2126EF953A90F.
- Independent focused review found no substantive blocker; see existing journey review.

No Browser/mail/device/deployment/commit operation was performed by this workstream.
Parent owns post-staging acceptance/cleanup with only the fictional US number;
Japanese/UK examples exist solely in API-double tests.

## Profile preflight: no silent truncation or deterministic split writes (2026-10-07)

Root's real staging candidate-11 Browser baseline submitted 11 distinct valid example.com
links. The canonical fresh form contained only the first 10: the old lineList.slice(0,10)
silently erased the eleventh. commaList.slice(0,20) had the corresponding interest defect.
The root restored its fixture's original two links; this implementation workstream did
not perform any Browser or staging mutation. Separately, malformed details sent alongside
preferences in Promise.all could reject one endpoint while committing the other.
Root subsequently completed that actual old-candidate staging probe: invalid links
plus timezone UTC produced Invalid profile fields; a separate fresh Profile read retained
the original two links but showed timezone UTC. Root restored both the original two
links and Asia/Singapore and confirmed fresh readback. This proves the deterministic
partial-write symptom independently of the transport-race API-double reproduction.

The new typed profile-input helper validates the entire submitted snapshot before BOTH
API calls. It parses lists without truncating nonempty entries, reports localized count,
per-item length, exact-case duplicate-interest and invalid-URL errors, focuses the offending
field, and retains every live draft value. Correcting a field does not clear other edits.
Actual constraints are derived from identity-worker/src/account.rs details_patch,
valid_text and update_preferences, not a new frontend policy:

| Input | Existing backend constraint mirrored by preflight |
| --- | --- |
| Display name | Unicode-whitespace trimmed length 1..80 scalars |
| Bio / status / pronouns / favorite character | At most 500 / 100 / 40 / 100 scalars |
| Interests | At most 20 entries; each 1..40 scalars; exact-case uniqueness |
| Links | At most 10 entries; each 1..2048 scalars; absolute URL parsing |
| Visibility | private / members / public |
| Timezone | Nonempty and at most 64 UTF-8 bytes; no IANA identifier requirement |

Existing detail/list whitespace trimming and blank-entry omission remain. All nonempty
list values survive until explicitly corrected. URL checks use the platform absolute URL
parser without a new scheme allowlist; tests preserve mailto, ftp, urn and custom schemes.
This is not a claim of exhaustive parser equivalence for every Rust/JavaScript URL edge.
Lone JavaScript surrogates are rejected because they cannot cross the Rust JSON/string
contract as Unicode scalar values. Native UTF-16 maxlength attributes were removed from
scalar-limited text controls: valid 80-astral display names and 500-astral bios must not be
silently truncated. Native required validation remains; deterministic preflight also works
when submit events are dispatched directly. The UTF-16/scalar distinction is grounded in
the MDN attribute references already cited in the password repair above.

## Profile split-save lifetime and partial reconciliation (2026-10-07)

Independent review reproduced a second, transport-level defect: preferences rejected
while updateMe remained pending, Promise.all immediately unlocked Save, a newer retry
completed, then the old pending updateMe overwrote the newer profile. Preflight alone
cannot solve this ordering defect or make separate writes atomic.

One explicit idle/pending/completed owner now awaits Promise.allSettled for BOTH writes
before releasing the form. Queued/duplicate Save cannot overtake a pending sibling.
On acknowledgement, trackFormDraft accepts only the submitted field names belonging to
fulfilled API groups; its default-all behavior remains available for existing callers.
Unconfirmed fields and edits made while saving stay dirty. The existing coordinator reads
canonical account/preferences/CSRF and restores only those changed values into a fresh
server-backed form. Main-entry integration tests prove both partial directions preserve
the correct failed/newer fields and retain the confirmed server baseline.

Typed side-specific partial feedback is scoped to Profile, initiating principal and the
live render signal. It says which group was confirmed and asks users to inspect retained
edits before deliberate retry. A rejected response is NOT proof that a request did not
commit; both rejected results retain the full draft and say results are unconfirmed.
There is no automatic mutation retry, atomicity, or exactly-once assertion. If canonical
refresh fails after a confirmed result, the obsolete form stays locked with reload
guidance rather than replaying the write. The main failure screen preserves draft state
and identifies that at least some changes were saved. Route abort prevents late baseline
acceptance, stale feedback, or refresh. Existing principal/route feedback guards remain.

Permanent tests group preflight separately from two-write ownership. They cover zero
API calls for all deterministic invalid inputs, full 20/10 accepted lists, scalar limits,
legacy schemes, UTF-8 timezone boundary without IANA policy, three-locale correction,
both early-rejection/pending-sibling orders, both rejected outcomes, confirmed/partial
refresh failure with no replay, selective baseline acceptance, newer edits, late abort,
and real main-entry canonical partial reconciliation. Existing journey tests remain green.
Independent review reran the four focused files (57 passed), an inverted race regression,
and four additional subset/refresh-failure/abort cases; the open race finding was closed.

Final supported Node 24.18.0 checks:
```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account --maxWorkers=2
fnm exec --using=24.18.0 -- npm.cmd run build:account
```
- Full Account: 21 files / 208 tests passed; TypeScript/Vite build passed.
- Focused whitespace diff check passed.
- JS index-emXSp8nH.js: 78.20 kB / gzip 26.07 kB; SHA256
  FC9EDD1AEF272FDEB3EB87D7B7B78E1D938495AB0299652B8715E2F2B2F056D8.
- CSS unchanged: index-Cz7B_ZUW.css.
- No Browser/mail/device/deployment/commit operation by this workstream.

## Cross-mutation refresh can outlive the Profile Save owner (2026-10-07, candidate 12 follow-up)

Status: **reproduced; correction pending**. This is distinct from the closed
same-form early-rejection race. The current `Promise.allSettled` owner is local to
one rendered form, but Avatar and Contact mutations can independently refresh
that form while its two requests remain admitted at the service.

Deterministic reproduction: `.temp/account-cross-mutation-race.test.ts`, importing
the actual Account `main.ts` entry and actual `pages.ts`, shell, router and draft
coordinator. Only `AccountApiClient` is replaced by a deferred in-memory service;
no production module was edited. The fixture deliberately permits an already
admitted backend write to finish after its client signal is aborted. Client abort
does not provide a server rollback guarantee, so this is an allowed ordering, not
an assertion that every fetch abort necessarily commits.

| Step | Actual main/pages behavior | Service state |
| --- | --- | --- |
| 1 | Save A submits `Old submitted`; original Save is disabled | Details A deferred; preferences A fulfilled |
| 2 | User types `Newer draft` and clicks still-enabled Avatar Remove | Avatar succeeds |
| 3 | Avatar calls `c.refresh("avatar-saved")`; main captures draft, aborts original signal, rerenders | Details A still deferred |
| 4 | Fresh form restores `Newer draft`, but its new local Save owner is idle | A still deferred |
| 5 | Save B submits `Newest submitted`; both writes finish, fresh form displays `Saved` | Details B committed |
| 6 | Admitted details A commits late; old form sees `signal.aborted` and exits | Details A overwrites B |
| 7 | UI still shows `Newest submitted` and `Saved`; no read is triggered by A | Canonical value is `Old submitted` |
| 8 | A later Avatar read refresh exposes `Old submitted` | Acknowledged newer value has been lost |

Reproduction command (Node 24.18.0):

```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root .temp account-cross-mutation-race.test.ts --maxWorkers=1
```

Result: **1 file / 1 expected-defect test passed**. This is not a fixed regression
test: its assertions intentionally demonstrate the unsafe order. Checks include
old signal abortion, fresh Save availability while A remains deferred, B success
acknowledgement, final server overwrite by A, no late canonical read, and eventual
readback of A. Avatar removal suffices for reachability; Contact calls use the same
refresh path but were not separately exercised in this bounded reproduction.

Minimum recommended correction: one small **Profile-page mutation owner**, shared
by Save, Avatar upload/remove, and Contact mutations for that page. Acquire it
before dispatching backend mutations; keep ownership until their observed results
settle and the canonical refresh completes; release in `finally`. While owned,
other mutation starts must be disabled and handler-guarded, including queued
submits, not just cosmetically marked busy. Do not disable editable profile fields:
newer text edits must still be retained by the existing draft coordinator.
Acquiring the shared owner in *every* direction matters: Avatar/Contact may already
be pending before Save is attempted. Local ownership should have no effect on
unrelated Account routes or change API contracts. Existing partial/unknown outcome
copy and selective baseline acceptance remain necessary; do not replace them with
a false atomicity or rollback claim.

An alternative is deferring incidental Profile refresh until Save settles, but it
must also preserve avatar/contact acknowledgements, reconcile both-rejected Save
outcomes, and avoid deadlocking Save's own refresh. A page-local operation owner is
the smaller correctness surface unless product requirements demand overlapping
mutations. Browser-back/document-exit and genuinely independent tabs remain separate
ordering boundaries; a local owner is not a new server concurrency protocol.

No Browser, mail, native device, deployment, credential or production source
operation was performed during this follow-up. Parent owns whether to schedule
the correction after the candidate-12 staging build and its browser acceptance.

## Cross-mutation owner: correction and permanent regressions (2026-10-07)

The reachable order documented above is now corrected in source with one Profile-local
operation owner. It covers Save, asynchronous avatar preparation, avatar upload/removal,
and contact add/remove/promotion/initial delivery/resend/confirmation. A command acquires
one lease before starting and retains it through observed settlement and canonical refresh.
Every competing mutation control is disabled AND handler-guarded, including direct synthetic
events. Profile text/select fields remain editable for the established newer-edits contract.
An open file chooser whose change arrives during another command is ignored, not queued.
Avatar removal now waits for preparation rather than cancelling preparation through a
competing command; a failed removal still releases controls for deliberate retry.

The owner projects explicit per-control desired disabled state, not captured snapshots.
Local pending/terminal state updates that intent under the shared lock. Dynamic verifier
buttons register while their initial delivery still owns the page and become usable only
after release. Completed Save with failed refresh stays non-replayable even if a later
avatar/contact operation acquires/releases the owner. Release cannot re-enable detached
or aborted controls; aborted verifier input remains readonly, and late preparation disposes
its preview without refresh. Busy-state updates never briefly write disabled=false through
the shared lock. Outside Profile, no owner is supplied and existing route behavior remains.

The historical expected-defect test remains evidence of the old implementation, not a
passing fixed regression. Its permanent inverted actual-main/pages test is now
apps/account/src/profile-main-owner.test.ts: Avatar cannot refresh/abort Save A while its
write is admitted; newer editable draft survives A's canonical refresh, and Save B starts
only after A has settled. This fixes the observed same-document command ordering, not
genuine navigation, independent tabs, or server-side concurrent writers. No rollback,
atomicity, or cancellation-of-admitted-server-write claim is introduced.

Permanent tests also include profile-cross-operations.test.ts: each of ten workflows owns
the page first and blocks every other form/click/file-change mutation; editable text is
retained. Additional cases cover lease lifetime through canonical refresh, terminal Save
surviving another lease, and late preparation after abort. profile-operations.test.ts checks
explicit disabled intent, dynamic controls, detached/closed controls and idempotent releases.
Existing avatar/contact tests now assert the intentional serialized/closed-page semantics
instead of expecting aborted controls to re-enable. Independent review separately inverted
the original race and exercised reverse avatar/contact ownership, preparation, refresh,
terminal intent and dynamic/abort projection without finding a new defect.

Final verification is recorded below after the last owner-projection source change.
No Browser/mail/native-device/deployment/commit operation was performed by this workstream.

Supported Node 24.18.0 final checks:
```powershell
fnm exec --using=24.18.0 -- node node_modules/vitest/vitest.mjs run --root apps/account --maxWorkers=2
fnm exec --using=24.18.0 -- npm.cmd run build:account
```
- Full Account: 24 files / 225 tests passed; TypeScript/Vite build passed.
- Focused five permanent files: 81 tests passed before the final projection refinement;
  the final full run includes those unchanged expectations against the refined source.
- Independent review: six files / 109 tests plus actual-main inversion and seven supplemental
  cross-owner cases passed; the cross-mutation finding is closed in the existing review note.
- Final whitespace diff check passed.
- JS index-C8fS-QTN.js: 79.56 kB / gzip 26.53 kB; SHA256
  C2F8B418070BB59CF94C4E346C13B9872E8863305738A035DE5DE6761576355A.
- CSS remains index-Cz7B_ZUW.css, 17.67 kB / gzip 4.71 kB.

## Authenticated locale coherence and keyboard header continuity (candidate 14)

Root's real staging candidate-13 journey showed Profile locale Save(en) acknowledged in
Chinese while document.lang, both header selectors and title remained Chinese, including
reload. Root also observed Appearance Enter cycling focus to BODY because its focused
button was replaced. The fixture was restored by root; this implementation agent did not
operate Browser, mail, hardware or deployment.

ADR 0003's authenticated-account-preference priority is the source of truth. Canonical
bootstrap/refresh now normalizes and applies account preferences.locale before route content
and translated Save/partial acknowledgements; local storage is only a non-sensitive fallback.
A persistent shell relocalizes existing command/navigation nodes without recreating their
handlers or pending state. Header locale writes the same preferences API instead of forcing
a document reload, and shares the existing Profile lease to prevent competing Save/avatar/
contact mutations. A separate header token blocks duplicate consent/write and releases on
abort even when transport ignores cancellation. Other-route mutation aria-busy blocks header
changes; main is inert during non-Profile header writes. This is not a generic mutation
framework or cross-tab concurrency protocol. Appearance uses its existing button and one
media listener; theme and account locale remain independent.

Discard consent does not mutate draft baselines. A complete editable-field approval snapshot
allows only differences typed after approval to survive successful header writes; failed or
unconfirmed writes retain the entire old draft. Canonical render is explicitly discard-visible
so approved values are not accidentally recaptured. A confirmed preference acknowledgement
is applied immediately; failed canonical readback is explicit and its Retry only rereads,
without replaying PATCH. Aborted/principal-changed continuations cannot apply stale language
or private drafts. Future dialogs use a dynamic translator, not the original bootstrap one.

Permanent actual-main integration in locale-consistency.test.ts covers Profile Save changing
page/header/document/title/cache, authenticated bootstrap overriding stale cache, three theme
cycles retaining node/focus, Japanese discard dialog/cancel, approved discard plus newer edits,
shared Save/header exclusion, failed write draft retention/unlock, confirmed-write readback
failure/read-only retry, and unauthorized abort suppressing late response. draft.test.ts adds
non-mutating approval snapshots/later deltas; shell.test.ts covers persistent nav and pending
sign-out relocalization. Initial full Account gate: 25 files / 228 tests passed with Node
24.18.0; final gate is recorded below after completion. No backend/API schema change, device
request, Browser acceptance claim, production deployment or commit is made by this agent.

Final candidate-14 verification: Node 24.18.0, `vitest run --root apps/account
--maxWorkers=2`: 25 files / 228 tests passed; Account TypeScript + Vite build passed.
JS index-DtKr36lO.js: 83.85 kB (gzip 27.63 kB); CSS index-BhQ1JvkX.css:
17.76 kB (gzip 4.73 kB). Parent owns subsequent staging deployment and real-Browser
acceptance; no device validation is required for this locale repair.

### Candidate 15: actionable read-only recovery after an uncertain language write

Root's candidate-14 real Browser failure probe preserved the Profile draft correctly, but
its message asked users to read latest state without providing a safe action on the intact
page. Browser reload would lose the in-memory draft. Added persistent, localized Read latest
state buttons alongside both header failure notices. They reuse canonical refresh with full
draft preservation and perform no PATCH. Header token and Profile lease gate admission;
the abort listener belongs to the new read scope rather than the intentionally replaced old
scope. Duplicate events/header writes are blocked, pending controls remain disabled, and
principal/route abort suppresses late continuations. Existing Retry handles failed canonical
reads. A successful read hides feedback and transfers keyboard focus to the same header's
persistent language selector instead of focusing its now-hidden recovery button.

Permanent locale-consistency.test.ts covers recovery from failed header PATCH with both old
and later Profile field edits, delayed read disabled states/duplicate events/no extra write,
selector focus after success, and failed recovery read followed by read-only Retry. This
agent did not operate Browser, mail, device, deployment or commit. Root requested 320px
viewport but effective Browser DOM stayed 392px; no actual 320px acceptance is claimed here.

Candidate-15 gates: Node 24.18.0 Account full suite 25 files / 228 tests passed;
after the independent hidden-invoker focus correction, main/locale/shell focused 3 files /
9 tests and final TypeScript + Vite build passed. Final JS index-Nz9lovj8.js 84.91 kB
(gzip 27.86), SHA256 8E89A83268559E21B7F58289BCDEF65944EF57DE09A75BFD1F80889E604AEE2C.
CSS index-BhQ1JvkX.css unchanged. Production ownership released to parent for staging
acceptance; no deployment performed here.

### Candidate 16: clear recovery feedback when authentication is lost

Independent review found that a 401 during read-latest correctly cleared the private draft
but left the prior authenticated locale-error claim and an inert recovery button visible
on the anonymous landing. becomeAnonymous now clears locale feedback and reprojects both
persistent headers after aborting the old scope. No account-specific draft-preservation
claim or dead recovery action remains. Permanent locale-recovery.test.ts promotes the
independent actual-main regressions: delayed recovery read/401 clears both notices/actions,
late response cannot restore private data or language; principal-changed read drops the old
draft and focuses visible main; recovery cannot interrupt an admitted Profile Save.

Candidate-16 final gates: Node 24.18.0 full Account 26 files / 231 tests passed;
TypeScript + Vite build passed. JS index-BcRIcomX.js 84.92 kB (gzip 27.86), SHA256
4106CAAEDD3951C32E9F85D247EF585A34C407875E04BCEBD915A51E2295BFE7; CSS unchanged.
No Browser, mail, device, deploy or commit was performed; parent owns staging acceptance.
