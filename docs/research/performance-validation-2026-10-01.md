# Independent performance-change validation — 2026-10-01

## Scope, contracts, and environment

This validation covers local security regression behavior against the new release Wasm Worker and the new npm/CI gate wiring. No production code was changed by this validator. No production/staging request, mutation, migration, deployment, or secret access was performed. Experiments use repository-local `.temp` directories.

Environment: Windows PowerShell, Node `v26.8.2`, npm `11.19.1`, Rust `1.88.0`, installed Wrangler `4.131.1`, Python with PyYAML `6.0.3`. The backend owner confirmed `npm run build:identity` finished before the runtime suites started. This validator did not rebuild. Security scripts were run once, sequentially, against isolated local D1 with the current schema and real Wrangler/workerd HTTP handlers.

Expected behavior comes from the established request-boundary and password-authority contracts already exercised in `docs/research/validation-2026-09-28.md`, and from unchanged route/header contracts: invalid browser origin or CSRF must not claim idempotency state; password mutation must require recent proof, rotate the host-only secure cookie, revoke old sessions and refresh authority, and never replay secret-bearing responses. Session optimization must not weaken those contracts.

## Independently executed runtime checks

Commands, in order:

```powershell
node scripts/tests/security-boundary.mjs
npm run test:password-security
```

The commands both exited **0**. The actual release Worker, rather than a mock implementation of authentication, handled the HTTP requests. Fixtures, migrations and query checks were confined to each script's isolated local D1 state.

| Request-boundary case | Expected and observed HTTP status | Expected and observed idempotency claims |
| --- | ---: | ---: |
| Missing fetch metadata, allowed context | 400 Invalid JSON request | 1 |
| Same-site fetch metadata, allowed context | 400 Invalid JSON request | 1 |
| Cross-site fetch metadata | 403 Invalid browser request context | 0 |
| Foreign origin | 403 Origin is not allowed | 0 |
| Missing required origin | 403 Origin is not allowed | 0 |
| Invalid CSRF token | 403 CSRF validation failed | 0 |
| Missing CSRF token | 403 CSRF validation failed | 0 |

The two 400 cases intentionally send malformed JSON; they show that allowed contexts reach parsing only after the established idempotency preclaim, not that a password operation succeeded.

Password suite expected and observed results:

- Stale Passkey proof was denied with 403; adding a password with restored recent proof returned 204 and rotated the secure host-only cookie.
- Password-authenticated OAuth returned 200 and the configured Identity issuer-rooted authorization-resume URI; the authorization transaction persisted as `authenticated`.
- Old session cookie was denied with 401; rotated cookie accessed session listing with 200.
- Lost-response replay using the old cookie and same mutation key returned 409 `idempotency_result_unavailable`, rather than exposing the new session secret. An old cookie with a fresh key returned 401.
- Wrong current password returned 403; correct change returned 204 and rotated the cookie again. The previous cookie was denied with 401 and the latest cookie accepted with 200.
- D1 assertions found password version **2**, exactly **1** non-revoked Identity session, and **0** non-revoked OAuth refresh-token families for the fixture principal.

## Regression-harness inspection and coordination

Inspected `crates/identity-worker/tests/session-performance.mjs`, without rerunning the backend owner's ongoing baseline comparison. Initially the generic-session check used a disabled OAuth path and asserted only `status >= 400`; that was not proof of successful generic session decoding or the RPC budget. The gap was reported to the backend owner, who replaced it with the real `/v1/browser-context` route using the allowed Account origin:

- Fresh generic session: 200, `has_identity_session=true`, exactly 1 D1 call.
- Due generic session: 200, `has_identity_session=true`, exactly 2 D1 calls.

The final inspected harness also asserts fresh `/v1/me` uses 3 calls without an activity UPDATE, due uses 4 calls with persisted renewal, internal `last_seen_at` is not exposed, concurrent touches preserve the absolute-expiry clamp, idle/absolute expiration and revocation deny access without touch, and an inactive principal is denied. Exact 299/300/301-second boundaries are covered by the backend owner's Rust unit tests. These are **inspected assertions**, not independently rerun results in this document; runtime evidence belongs to the backend report. No redundant new harness was added after the generic projection gap was addressed.

The security validation and backend timing experiment overlapped on this local machine. The backend owner was informed: this is potential timing noise, not evidence against the deterministic D1 operation counts. Local timing distributions with injected per-call delays must not be described as production latency improvements.

## npm and CI wiring verification

Isolated reproducible checker: `.temp/performance-2026-10-01/check-ci-wiring.py` (ignored local artifact). Command:

```powershell
python .temp/performance-2026-10-01/check-ci-wiring.py
node --check crates/identity-worker/tests/session-performance.mjs
node --check scripts/tests/http-latency.mjs
node --check scripts/measure-http-latency.mjs
```

All exited **0**. The checker parsed `package.json` and `.github/workflows/ci.yml` using standard JSON and installed PyYAML, asserted both script paths exist, and checked:

- `test:http-latency` is exactly `node --test scripts/tests/http-latency.mjs`, referenced exactly once in `contracts`.
- `test:session-performance` is exactly `node crates/identity-worker/tests/session-performance.mjs`, referenced exactly once in `package`, after the downloaded release Worker artifact is restored.
- `package` depends on Rust, frontend, and contracts jobs; the required quality gate includes `package`.

This establishes syntax and the relevant dependency/ordering contracts, not an executed GitHub Actions run or a full Actions schema validation. Root independently completed a similar YAML/wiring check before its coordination message arrived; neither check was subsequently repeated. Existing HTTP offline test successes reported by root were reused, not rerun here.

## Supported verdict and limits

**PASS for the independently exercised local security regression contracts and the inspected new gate wiring.** No implementation regression was reproduced. One consequential generic-projection test gap was identified and addressed by its owner. No production-change recommendation depends on an unexecuted benchmark in this document.

Not verified here: actual deployed cache headers (frontend owner), backend benchmark timing or Rust unit execution (backend owner), end-user browser rendering/input performance, authenticated production behavior, a mainland-China device/network path, remote email delivery, production p95/p99, or the full GitHub Actions workflow. Production/staging were not modified. Local success is not evidence that these changes have already been deployed.
