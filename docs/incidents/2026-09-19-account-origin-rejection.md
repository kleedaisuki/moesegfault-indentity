# Account-origin mutations rejected by the Identity idempotency boundary

- **Date:** 2026-09-19
- **Status:** Resolved
- **Impact classification:** Broad authenticated Account write-path outage; no formal severity taxonomy was defined
- **Affected service:** `moesegfault-identity`
- **Affected frontend:** `account.moesegfault.dev`
- **Customer-reported correlation ID:** `01a0b94d-0c35-710b-9450-f1724fc62be1`
- **Fix commit:** `159f64fbbb855f89ad5d7e4bd19759bd3326f74e`
- **Production release commit:** `abc968838fbf00b552ccc5cd0cdfa7fa7011693f`
- **Production Worker version:** `44624dbb-d089-48aa-ac3f-62de7fb97224`
- **Delivery run:** [GitHub Actions 35439642102](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/35439642102)
- **Owners:** Identity / Account

## Executive summary

Authenticated reads from Account worked, but the shared idempotency preclaim middleware rejected
every Account-origin session mutation that reached it before the request reached its endpoint
handler. The
middleware compared `Origin` only with `LOGIN_ORIGIN`, while the outer CORS response boundary and
most Account endpoint guards correctly accepted the environment-paired Login and Account origins.

The first reported and observed failure was starting email verification from the Account profile
page; other Account write paths may have been unavailable for the same period:

```text
POST /v1/me/contacts/:contact_id/verification-transactions
Origin: https://account.moesegfault.dev
→ 403 Origin is not allowed
```

This was not a browser-generated CORS failure. The response carried the correct
`Access-Control-Allow-Origin: https://account.moesegfault.dev`, so the browser exposed a valid
application-level 403 response. It was also distinct from the earlier `/v1/me` incident, where a
D1 deserialization panic caused a Worker runtime error and a platform-synthesized response without
application CORS headers.

## Customer impact

The code defect affected all 20 route registrations using `Caller::Session` behind the generic
idempotency boundary if a request reached the Worker. The standard browser journey for
`PUT /v1/me/password` was blocked even earlier by its invalid preflight response. The Account API
client exposes 15 mutation methods: code inspection and boundary probes show that 11 were
unavailable and four unwrapped methods continued to work. One user report is recorded; request
volume, distinct affected users, incident start time, and duration were not measured.

| Customer-facing Account action | Result before remediation |
| --- | --- |
| Save profile | 403 |
| Add, make primary, or delete a contact | 403 |
| Start or complete contact verification | 403 |
| Save preferences | 403 |
| Set or replace a password | Browser preflight failure; a direct non-browser request would reach the stale 403 check |
| Rename or revoke a passkey | 403 |
| Revoke a session | 403 |
| Upload or delete an avatar | Worked; uses the endpoint-level paired-origin guard |
| Delete a password | Worked; uses the endpoint-level paired-origin guard |
| Revoke an application authorization | Worked; uses the endpoint-level paired-origin guard |

Reads were not affected. The rejection occurred before CSRF verification, the D1 idempotency
claim, contact-verification transaction creation, the email outbox write, or any other domain side
effect. Retrying the failed request therefore did not create duplicate emails or partial records.

### Affected session routes

1. `PATCH /v1/principals/self`
2. `PATCH /v1/me`
3. `POST /v1/me/contacts`
4. `DELETE /v1/me/contacts/:contact_id`
5. `PATCH /v1/me/contacts/:contact_id`
6. `PATCH /v1/me/preferences`
7. `POST /v1/me/contacts/:contact_id/verification-transactions`
8. `POST /v1/me/contacts/:contact_id/verification-transactions/:transaction_id/completion`
9. `PUT /v1/me/password`
10. `DELETE /v1/principals/self`
11. `POST /v1/principals/self/identifiers`
12. `PATCH /v1/principals/self/identifiers/:identifier_id`
13. `DELETE /v1/principals/self/identifiers/:identifier_id`
14. `POST /v1/principals/self/authenticators/registration-transactions`
15. `PATCH /v1/principals/self/authenticators/:authenticator_id`
16. `DELETE /v1/principals/self/authenticators/:authenticator_id`
17. `DELETE /v1/principals/self/sessions`
18. `DELETE /v1/principals/self/sessions/:session_id`
19. `POST /v1/principals/self/recovery-codes/rotations`
20. `DELETE /v1/principals/self/bindings/:binding_id`

## Detection and reproduction

The issue was reported with a screenshot from `https://account.moesegfault.dev/profile`. The UI
showed `Origin is not allowed`, the network request returned 403, and the browser console reported
the failed `verification-transactions` request.

An unauthenticated A/B probe isolated the boundary without accessing customer credentials:

```text
Same URL, method, content type, Fetch Metadata, CSRF header, and idempotency key

Origin: https://account.moesegfault.dev
→ 403 Origin is not allowed

Origin: https://login.moesegfault.dev
→ passed Origin validation and reached authentication (401)
```

Pre-remediation probes reproduced the same pattern in production, staging, and the local paired
origins. Inspection of active Worker bindings confirmed that `LOGIN_ORIGIN` and `ACCOUNT_ORIGIN` were correctly
configured in both deployed environments. Configuration drift was therefore excluded.

## Request path and failure point

```text
Account fetch with credentials
  → Worker fetch entry point records the presented Origin
  → Router selects an idempotent session mutation
  → idempotency::run
  → validate_preclaim_boundary
  → compares Origin only with LOGIN_ORIGIN       ← rejected here
  ✗ caller-specific authentication / CSRF check
  ✗ D1 idempotency claim
  ✗ endpoint handler
  ✗ domain transaction and email outbox
  → fetch finalizer adds Account ACAO to the 403
```

## Root cause

The system had two contradictory origin policies:

1. `guard::allowed_origin`, the CORS finalizer, browser-context endpoint, and most Account handlers
   accepted the exact environment-paired Login and Account origins.
2. `idempotency::validate_preclaim_boundary`, introduced when the browser surface was Login-only,
   retained a direct `Origin == LOGIN_ORIGIN` comparison.

When Account mutations were later placed behind the generic idempotency layer, its old invariant
was not updated. Because the check ran before the `Caller::Browser` versus `Caller::Session`
branch, it applied the Login-only assumption to every wrapped operation.

## Additional defects found in the same failure family

The bounded audit identified three adjacent problems:

1. Binding revocation had a second Login-only comparison in its bodyless-mutation guard. Fixing
   only the generic idempotency boundary would still leave that route returning 403.
2. The preflight response omitted `PUT` even though Account uses `PUT /v1/me/password`; browsers
   would reject that operation before sending the actual request.
3. Idempotency error and replay responses authored their own Login-origin CORS headers. The outer
   finalizer overwrote them for trusted Account requests, but rejected origins could receive an
   irrelevant Login ACAO. This was not an origin bypass—the value did not match the attacker's
   origin—but it violated the single response-boundary design and made behavior harder to reason
   about.

## Contributing factors

### Policy duplication

Origin policy existed in a shared helper, the fetch finalizer, idempotency middleware, Binding
middleware, and selected endpoint response helpers. The duplicated direct comparisons were able to
drift independently.

### Incorrect configuration documentation

`docs/configuration.md` described `LOGIN_ORIGIN` as the sole production CORS and Origin value and
did not list `ACCOUNT_ORIGIN`. That documentation preserved the obsolete Login-only mental model
even after runtime code had adopted paired origins.

### Test coverage stopped at the wrong boundary

- Account client tests mocked `fetch`; they verified URLs and headers but never executed Worker
  middleware.
- Rust idempotency tests covered keys, digests, claims, replay, and response safety but did not
  exercise an Account-origin request with a Worker `Env`.
- Deployment smoke tests checked Account-origin `GET /v1/me` and an `OPTIONS` preflight only.
  Both used the correct paired-origin code path, so they stayed green while actual mutations were
  rejected by a different layer.
- The registration verification flow originated from Login and therefore matched the stale
  Login-only check, masking the defect until verification was attempted from Account.

### Broad blast radius in a shared middleware layer

The idempotency wrapper correctly centralized concurrency semantics, but that also made an
unrelated origin-policy bug affect every wrapped Account command. Shared middleware requires
contract tests for every supported caller class, not only unit tests for its primary algorithm.

## Why earlier verification did not prove this path

The previous production check proved that:

- Account-origin anonymous reads received correct credentialed CORS headers; and
- `/v1/me` no longer crashed while decoding D1 integer-backed booleans.

It did not prove that an Account-origin mutation could pass all pre-handler boundaries. Treating a
successful read and preflight as evidence for a write path was the central verification mistake.

## Remediation

### Code

- Apply a caller-capability matrix in the idempotency preclaim: `Caller::Session` accepts the exact
  paired Login and Account origins, while Login-owned `Caller::Browser` ceremonies remain
  Login-origin-only.
- Reuse `guard::allowed_origin` in the Binding bodyless-mutation guard.
- Keep exact origin equality; do not use suffix, wildcard, parent-domain, or substring matching.
- Add `PUT` to the CORS preflight method list.
- Remove all CORS authorship from idempotency error and replay responses. The fetch finalizer is now
  the sole CORS response owner for those paths.
- Retain the old replay metadata `cors` field for deserialization compatibility, but ignore it when
  constructing a response.

WebAuthn remains restricted to `LOGIN_ORIGIN` and `login.moesegfault.dev`; allowing Account to call
the Identity resource API does not broaden the WebAuthn relying-party boundary.

### Deployment gates

The environment smoke test now verifies:

1. Account-origin credentialed CORS on an unauthenticated read.
2. A `PUT` preflight including the actual requested CSRF, content-type, and idempotency headers.
3. An Account-origin idempotent mutation reaches authentication (401), rather than failing Origin
   validation (403).
4. Binding deletion passes its second bodyless-mutation Origin guard and reaches recent-auth
   validation (401).
5. A deceptive origin is rejected with 403 and receives no `Access-Control-Allow-Origin` header.
6. Account remains unable to initiate a Login-owned `Caller::Browser` password-authentication
   ceremony, while receiving a readable CORS 403 response.

These probes intentionally omit session cookies. They are non-destructive, work in staging and
production, and prove the Origin, preflight, and response-CORS boundaries progress to
authentication without customer credentials or domain side effects. They do not prove valid-session
CSRF verification, D1 idempotency claims, or successful domain mutations.

## Five whys

1. **Why did email verification return 403?** The idempotency preclaim accepted only Login Origin.
2. **Why was Account not accepted there?** That middleware retained an invariant from the earlier
   Login-only browser architecture.
3. **Why did adding Account routes not update it?** Origin policy was duplicated instead of being
   owned by one helper and one response finalizer.
4. **Why did tests not fail?** Client tests mocked the server, middleware tests did not cover both
   frontend callers, and deployment smoke stopped at GET and OPTIONS.
5. **Why was the obsolete assumption plausible?** Configuration documentation still called
   `LOGIN_ORIGIN` the sole CORS/Origin value and omitted `ACCOUNT_ORIGIN`.

## Verification plan and evidence required for closure

| Layer | Required evidence |
| --- | --- |
| Native Rust | Unit tests and Clippy with warnings denied |
| Worker build | `wasm32-unknown-unknown` check and release Worker build |
| Local runtime | All 20 session routes reject zero valid Account origins; Binding, PUT preflight, deceptive-origin, and caller-scope controls pass |
| Staging | Full deployment smoke, including the new mutation probes |
| Production | Full deployment smoke on the promoted immutable revision |
| Live behavior | Account-origin verification start no longer returns Origin 403; response either succeeds with an authenticated session or reaches authentication without one |
| Negative control | Deceptive origin remains 403 with no ACAO |

## Resolution evidence

The immutable release passed native tests, Clippy with warnings denied, Worker/Wasm checks,
configuration validation, staging deployment smoke, and production promotion smoke. The staging
and production gates included the new Account mutation, Binding deletion, PUT preflight,
deceptive-origin, and Account-to-Browser-ceremony capability probes.

An independent production probe against the promoted revision recorded:

| Probe | Production result |
| --- | --- |
| Account → session verification route, without a session cookie | `401 authentication_failed`, exact Account ACAO; correlation `01a0b965-ad4a-7a36-bc6d-ac33e4a70187` |
| Account → Login-owned password authentication ceremony | `403 Origin is not allowed`, exact Account ACAO; correlation `01a0b965-af0d-7bcf-a861-2fadb7db2e20` |
| Account `PUT /v1/me/password` preflight | `204`; methods include `PUT`; all three requested headers allowed |
| Deceptive origin | `403`; no ACAO, verified by deployment smoke |

The first row reproduces the original method and route family with the same valid browser envelope
but without customer credentials. It now passes the previously failing Origin boundary and reaches
authentication. A live authenticated button click was requested during a production tail window
but was not observed; therefore the evidence proves this incident's Origin/CORS remediation, not
successful email delivery for a specific account.

## Corrective actions

| Action | Owner | Status |
| --- | --- | --- |
| Replace idempotency Login-only comparison with a caller-aware origin policy | Identity | Deployed |
| Replace Binding bodyless Login-only comparison | Identity | Deployed |
| Make the fetch finalizer the sole CORS owner for idempotency responses | Identity | Deployed |
| Add `PUT` and requested-header assertions to preflight smoke | Identity / Delivery | Deployed and passing |
| Add Account mutation, Binding deletion, and deceptive-origin smoke probes | Identity / Delivery | Deployed and passing |
| Add Account-to-Browser-ceremony negative capability probe | Identity / Delivery | Deployed and passing |
| Correct the configuration contract for paired origins | Identity | Landed |
| Re-run the complete local route matrix | Validation | Complete: 0/20 false Origin rejections |
| Deploy and verify staging and production | Delivery | Complete |
| Re-run the production boundary probes | Validation | Complete |

## References

- [MDN: Cross-Origin Resource Sharing](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)
- [MDN: `Access-Control-Allow-Methods`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Methods)
- [W3C: Fetch Metadata Request Headers](https://www.w3.org/TR/fetch-metadata/)
- [Cloudflare Workers: CORS header proxy example](https://developers.cloudflare.com/workers/examples/cors-header-proxy/)
