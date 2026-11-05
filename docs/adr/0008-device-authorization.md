# ADR-0008: Device authorization for human-operated remote clients

- Status: Accepted
- Date: 2026-11-05

## User journey and authority

A person running a CLI or remote moeSegFault service may have no usable browser
callback on that host. Add the standard RFC 8628 device grant alongside, not in
place of, Authorization Code + S256 PKCE. The remote client displays an expiring
code and browser URL. Login authenticates the person, displays the registered
application and code, and requires explicit approval or denial. The initiating
client polls Identity, validates the normal token set, and creates its own session.
A browser success page means approval succeeded, not remote token persistence.

Identity remains the user/session/token authority. Login owns presentation; each
consuming service owns token storage, its own session and business authorization.
This grant does not introduce `client_credentials`, SSH login, account-API bearer
scopes, introspection, or independent resource-server audiences. Existing token
`aud=client_id`, pairwise subjects, refresh rotation, and revocation semantics stay
unchanged. No remote service needs access to first-party cookies or extra CORS.

## Reuse the issuer, not a second authentication system

Discovery advertises `device_authorization_endpoint` and the standard device grant
URN. Start and poll use form encoding and OAuth JSON errors. Public native clients
use `none`; confidential clients use the existing `private_key_jwt` validation with
the exact device endpoint as assertion audience on start and the token endpoint on
polling. Each assertion needs a fresh `jti`.

Apply the forward-only `0012_device_authorization.sql` migration before
deploying this Worker: all client reads now project the new flag. Worker rollback
does not remove the column or pending records; retain migration history.

Registration adds an explicit `device_authorization_enabled` flag, default false
for existing clients. Device-only clients may register no callback; clients using
both grants retain their existing exact redirect policy. The create-only manifest
generator, environment migration overlays, and public-key ownership remain the
provisioning boundary. Enabling the grant never implicitly registers an app.

The device grant has no redirect, PKCE verifier, or nonce. The established token
signer issues the same pairwise identity and scoped access-token contract; device
ID tokens omit nonce rather than inventing one the requester cannot validate.
Clients validate signature, issuer, audience, time, subject, and `token_use=id`
before establishing
a local session. A device code is a pending capability, not a local user identifier.
Multi-user remote services bind it to the initiating local login transaction.

## State and lifetime

D1 owns the device record, its client/scope binding, expiry, polling schedule,
approval session, and one-time consumption. Browser lookup does not authorize.
Approval/denial requires an authenticated first-party session, exact allowed Origin,
and session CSRF. Token polling rechecks the registered client and approved session
before reusing normal token/grant issuance. Terminal decisions do not resurrect an
expired or consumed code. Concurrent polls must not mint two token sets.

A short human-readable code is distinct from the high-entropy device secret. Store
keyed lookup digests, not redeemable code strings. Default lifetime is ten minutes,
initial poll interval five seconds. An early poll returns `slow_down` and raises
the stored interval by five seconds; clients apply that interval to later polls.
Pending, denied, expired and consumed are distinguishable protocol outcomes.
Creation and human-code verification are rate-limited without coupling every
ordinary request to an additional network service. Lookup and decision have
separate per-principal budgets, so a successful final allowed lookup cannot itself
exhaust the subsequent confirmation budget. Diagnostics retain correlation IDs,
client/device-record identifiers, decisions, and stable errors, not bearer values.

## Cross-device risk and design choices

An authentic login page and even a phishing-resistant Passkey do not establish
that a code belongs to the device the person intended. An attacker can initiate a
real device flow and persuade a victim to approve it. Short-lived codes, explicit
per-client enablement, bounded polling/lookup, named-client/code confirmation, and
an instruction to approve only a self-initiated request reduce that opportunity.
The complete verification URL only pre-fills the code; navigation never approves.

These measures do not create cryptographic proximity or a trusted device pairing.
That trade-off is deliberate for remote terminal workloads, where requiring nearby
hardware would defeat the feature. Prefer the established callback/PKCE flow when
it is practical, and do not promote device login as stronger authentication.

The portable skill helper supports native public clients, standard discovery and
polling, RS256 ID-token verification, and protected token-file creation. It is an
integration starting point, not a service-session framework. Its implementation
lives inside the installable Identity skill so remote users need not clone the
provider repository to use it; the repository CLI is a thin wrapper.

## Engineering and research basis

- [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html) supplies the grant and
  polling/state contract; it avoids a provider-specific login protocol.
- [GitHub's device-flow integration](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
  demonstrates the production CLI pattern and explicit grant enablement. Identity
  follows its protocol shape, not GitHub-specific endpoints, scopes, or lifetimes.
- [RFC 10027](https://www.rfc-editor.org/rfc/rfc10027.html), published August 2026,
  explains cross-device consent/session phishing, protocol selection and mitigations.
  It supersedes the earlier cross-device-security Internet-Draft. Its formal-analysis
  discussion separates secure credential use from trustworthy cross-device intent.
- [Pernpruner et al., CODASPY 2020](https://doi.org/10.1145/3374664.3375727)
  analyzes out-of-band approval and social-engineering attacks. The relevant design
  implication is to bind the displayed approval to the user's own initiating task;
  adding another authentication factor alone does not supply that binding.

`npm run test:device-login` exercises the portable consumer.
`npm run test:device-authorization` runs the real Worker/D1 protocol journey; add
`-- --browser` for Chromium through Login and Identity (see the integration guide
for local browser installation). These commands add no CI quality gate.

The end-to-end acceptance boundary is a remote login plus real browser approval,
not just an HTTP 200 or a rendered page. Verify approval, denial, expiry, slow-down,
wrong-client rejection, one-time consumption, token validation and local persistence,
with existing callback/refresh semantics preserved. No production rollout is
implied by this design record; deployment and client registration are separate steps.
