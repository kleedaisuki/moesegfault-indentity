# Anonymous Account deep-link browser acceptance — 2026-10-07

## Intended candidate acceptance

Against candidate 1 in staging, navigate a fresh anonymous in-app Browser tab to
`https://account-staging.moesegfault.dev/security` and check:

1. Normal anonymous landing, not a private dashboard or private-data failure UI.
2. Clear sign-in and create-account actions.
3. Usable theme/language controls.
4. Activating sign-in preserves the exact Account `/security` destination as
   `return_uri` and uses Login staging.
5. Registration action remains in the same staging environment.

No password input, registration, email sending, viewport changes, or production
deployment is within this probe.

## Attempt and current evidence

This agent's previous locale probe successfully controlled its independent
in-app Browser ID 2. At the start of the follow-up, the first attempted operation
was `await iab.tabs.new()` on that existing binding. It failed immediately with
`Browser is not available: 2`; navigation was never reached.

The documented bootstrap-troubleshooting instructions were then read through the
existing `agent`. One authoritative `await agent.browsers.list()` call returned
`[]`. The connection is unavailable, rather than a slow page-observation timeout.
No unrelated browser backend or undocumented workaround was used.

**Verdict: not exercised.** None of the five acceptance claims above is proven
or disproven by this environment failure. A fresh live in-app Browser context
must execute the proposed checks. The parent was notified so another available
driver can perform the acceptance rather than treating this as a product defect.

## Fresh-context retry after the permission fix

A newly bootstrapped official in-app Browser binding (`iab`, ID 2) successfully
created a new tab and navigated to the exact staging `/security` URL. The first
AX observation completed within the 120-second command budget.

The observed page was **already authenticated**, not anonymous: the header showed
the staging verification display name and a sign-out action, and main content
showed the Security Center, Passkey count 0, password enabled with current/new
password fields, and recovery codes enabled. A fresh tab does not isolate the
existing browser session. This does not demonstrate an anonymous-access defect.

The visible links on the authenticated page were correctly staging-scoped:

- Passkey management: `https://login-staging.moesegfault.dev/passkey/enroll?return_uri=https%3A%2F%2Faccount-staging.moesegfault.dev%2Fsecurity`
- Recovery-code management: `https://login-staging.moesegfault.dev/recovery-codes/rotate?return_uri=https%3A%2F%2Faccount-staging.moesegfault.dev%2Fsecurity`

No sign-out, credential entry, storage inspection, registration, email sending,
viewport change, or production mutation was performed. The parent was notified
that the anonymous acceptance needs the coordinated authenticated journey to
finish and sign out first. **Anonymous landing and sign-in activation remain
unverified**, while the permission-related browser availability failure is no
longer present in this fresh context.
