# Backend latency investigation (2026-10-01)

## Workload, scope, and decision

The user reports general sluggishness: initial load, account navigation, save/login,
and scrolling/typing. This backend investigation targets identity API critical paths,
not rendering or mainland-China network connectivity. No production account creation,
authentication mutation, database write, or load test was performed. All fixtures,
raw timings, and baseline artifacts are under repository-local `.temp`.

Existing knowledge consulted first: ADR-0002 (HTTP and D1 boundaries), password
security and rate-limit research from 2026-09-28. Those documents establish that
primary authority checks, transactional audit/outbox writes, password guessing
protection, and atomic revocation are intentional contracts, not removable overhead.

**Implemented:** eliminate a remote D1 session-touch call when the already-read
primary session proves that the existing five-minute renewal window is not due.
This removes one serial remote round trip from most authenticated read APIs without
reducing authentication correctness or changing session lifetime policy.

## Critical-path findings

| Path or subsystem | Observed mechanism | Decision |
| --- | --- | --- |
| Both current-session repository functions | Primary session SELECT followed by awaited UPDATE, even when UPDATE necessarily changes zero rows because `last_seen_at > now - 300` | Read `last_seen_at` in the same authoritative SELECT and skip only the known no-op |
| Fresh `GET /v1/me` | Before: session SELECT, touch UPDATE, account SELECT, identifier SELECT; after: three serial calls | One call removed; remaining profile reads not redesigned in this patch |
| Fresh authenticated `GET /v1/browser-context` | Before: session SELECT + touch; after: session SELECT only | Same optimization applies to generic session path |
| No-cookie browser context | No identity-session database query | Anonymous latency here cannot be blamed on session-touch or Argon2 |
| `/healthz` | Executes `SELECT 1` against D1 | Distinguish its D1/network latency from configuration-only capability/discovery responses |
| Password authentication | Argon2id: 19,456 KiB memory, 2 iterations, 1 lane; authoritative guessing reservation happens first | Do not weaken parameters or bypass rate gates; measure separately |
| Password success / sensitive mutations | Security audit + archive outbox persist inside atomic D1 batches | Keep synchronous durability; R2 archive itself is already drained by cron, not login |
| OAuth token pair | Calls WebCrypto RSA import/sign separately for access and ID token | Request-local import reuse is a possible micro-optimization, but not proven important; left unchanged |
| Database indexes | Session digest has UNIQUE index, identifier lookup has explicit schema indexes | No evidence justifies speculative index migration |

Many mutations additionally use an idempotency wrapper for pre-claim/complete
storage. Its session precheck validates cookie-bound CSRF without querying the
session database; the handler performs the authoritative lookup. The new skip
applies to both generic and account-specific lookup functions and does **not**
replace handler authority checks with a cached session.

## Implementation and invariants

Touched production files:

- `crates/identity-worker/src/repository.rs`
- `crates/identity-worker/src/account_repository.rs`

`SessionActivity<T>` is an internal, request-local deserialization projection with
the existing session fields flattened and `last_seen_at` separated. Neither public
session structures nor HTTP payloads gain an activity field. The freshness predicate
matches the pre-existing SQL condition at Unix-second precision:

```text
touch_due = last_seen_at <= now - 300
```

The primary SELECT still checks digest, revocation, idle expiry, absolute expiry,
and active principal lifecycle on every request. The existing UPDATE is retained
unchanged: it rechecks revocation and both expiries, gates on the current persisted
last-seen timestamp, and caps idle extension at absolute expiry. Concurrent due
requests therefore still race through the existing conditional update safely; a
losing request performs a no-op. Due renewal remains awaited, not detached with
`waitUntil`. No authorization decision comes from an isolate cache or a replica.

Skipping a fresh no-op write does not grant any new authority. There remains the
same general read-vs-revocation ordering between a session lookup and the handler;
sensitive mutations must preserve their own atomic database guards.

## Reproducible local Worker evidence

Harness: `crates/identity-worker/tests/session-performance.mjs`.

The harness instantiates the actual **release Wasm Worker in workerd via Miniflare**,
applies all six real migrations, seeds one synthetic principal/session directly
into isolated local D1, and wraps the real binding with request-local RPC counting.
The wrapper and D1 persistence live below a new `.temp/performance-2026-10-01/`
directory. It does not replace SQL or mocked authentication results.

Environment: Windows, Intel Core i9-12900H (20 logical processors), Node 26.8.2,
Rust/Cargo 1.88.0, Wrangler 4.131.1, bundled Miniflare 5.20260911.0-alpha. The harness
uses Miniflare's exported V4-option conversion helper for the pinned toolchain.
The release profile remains `opt-level = "s"`, LTO enabled; no compiler profile
change was required.

### Correctness checks passed

1. Fresh `/v1/me`: 200, **three** D1 calls and no session UPDATE.
2. Due `/v1/me`: 200, **four** D1 calls, last-seen advanced and idle lifetime renewed.
3. Fresh generic `/v1/browser-context`: 200, `has_identity_session = true`, **one** D1 call.
4. Due generic browser context: same authentication result, **two** D1 calls.
5. Six concurrent due requests: all successful; conditional touch preserves absolute-expiry cap.
6. Expired idle or absolute deadline and revoked session: 401 and exactly one SELECT, no touch.
7. Pending-deletion principal: 401.
8. Internal activity timestamp does not appear in the account HTTP payload.
9. Rust boundary tests include 299/300/301 seconds and future last-seen timestamps.

### Timing comparison: sensitivity experiment, not production latency

Baseline build was preserved **before modifying Rust sources** at
`.temp/performance-2026-10-01/backend-before/`. Both builds run the same fixture,
binding instrumentation and route, with five warmups and 25 timing samples per
scenario. Before/after request order alternates. Timing consumes the whole response.
The delayed scenarios inject a timer before each actual D1 RPC; Windows timer
granularity makes actual overhead exceed the nominal delay.

Wasm SHA-256: baseline `2895af53253a99a23da4226829c64f454ef6053c9962c8c01db920a6ef2eeacd`;
patched `5d8850e87ed4d5832fa3c1093bcbe34a11c7f714c8fd532fb4471d4845f8c1c0`.

Raw report: `.temp/performance-2026-10-01/session-worker-57hxe2/results.json`.

| Injected delay per RPC | Before median / MAD (ms) | After median / MAD (ms) | Before / after p95 (ms) | Median reduction |
| ---: | ---: | ---: | ---: | ---: |
| 0 ms | 10.70 / 0.44 | 8.96 / 0.66 | 13.27 / 11.39 | 16.3% |
| 20 ms | 122.41 / 7.91 | 91.14 / 5.35 | 136.04 / 99.90 | 25.5% |
| 80 ms | 363.46 / 3.93 | 273.13 / 3.40 | 378.77 / 286.10 | 24.9% |

MAD is median absolute deviation, a spread estimate, **not a confidence interval**.
These runs used a shared developer machine, without dedicated CPU affinity or
exclusive workload isolation; background engineering/security tests may overlap.
Do not extrapolate their millisecond or percentage values to deployed Cloudflare
latency. The deterministic four-to-three RPC reduction is the decisive mechanism.

### Password-path inexpensive probe

An optional local probe sent unknown randomized identifiers through the real
password route with valid browser CSRF/idempotency proof. Each response was 401;
the existing dummy Argon2 verification and D1 rate-reservation path were exercised.
No real account credentials were used. Three warmups plus 12 measured attempts:
median **39.27 ms**, p95 **43.50 ms**, MAD **1.60 ms** for the full local response.
Raw report: `.temp/performance-2026-10-01/session-worker-eckzBG/results.json`.

This is not an isolated Argon2 CPU measurement, production CPU quota measurement,
successful-login measurement, or attack-concurrency capacity test. It does not
support claiming that password hashing explains multi-second page sluggishness.
Its 19 MiB memory footprint can still matter under concurrency; keep the persisted
attempt budget and investigate production CPU telemetry before optimizing it.

### Commands and final verification

```sh
npm run build:identity
node crates/identity-worker/tests/session-performance.mjs
# Optional sensitivity comparison when the preserved baseline is available:
node crates/identity-worker/tests/session-performance.mjs --baseline=.temp/performance-2026-10-01/backend-before
# Optional separate real password-path timing:
node crates/identity-worker/tests/session-performance.mjs --benchmark-password
cargo test --workspace --all-features --locked
cargo clippy -p identity-worker --all-targets -- -D warnings
cargo fmt --all --check
```

Release Wasm build passed. Final workspace tests passed: **14 domain tests + 88
Worker tests + 1 domain doctest**; two existing Worker doctests remain ignored.
Clippy with warnings denied and final formatting check passed. Independent
validator ran and passed `scripts/tests/security-boundary.mjs` and
`scripts/tests/password-security.mjs`; this investigator did not duplicate them.
Default harness execution performs deterministic correctness checks only; optional
timing flags prevent adding unnecessary benchmark duration to CI.

## Production and academic grounding

- [Cloudflare D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
  explicitly identifies remote round-trip reduction as a batch performance benefit
  and guarantees ordered transactional batches. This fix removes a useless call
  rather than deferring security durability; future account projection batching
  should use those same transaction semantics.
- [Cloudflare D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
  documents `first-primary` as obtaining the latest database version. Keep that
  boundary for revocation/authorization, rather than exchanging security freshness
  for faster local replica reads.
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
  emphasizes bindings, explicit promise lifetimes, and separating background work
  from foreground execution. The project already uses an outbox for R2 archive;
  audit commit itself is not background work.
- [Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
  provides native platform RSA signing. Current OAuth code correctly uses it;
  replacing this with handwritten Wasm RSA is not a justified improvement.
- Marcelino et al., **Lumos**, ACM IoT 2025,
  [published university repository](https://repositum.tuwien.at/handle/20.500.12708/227637)
  ([DOI](https://doi.org/10.1145/3770501.3770515)), separates workload, system, and
  environment drivers and distinguishes startup from warm execution and serialization.
  Its compared runtime configurations are not Cloudflare Workers; the relevant
  lesson is measurement design, not transferring its runtime speedup factors.

## Worthwhile next step

The patch is worthwhile: small implementation, unchanged external contracts,
no schema/dependency addition, and one fewer authoritative-database round trip
on the dominant fresh-session path. It is not a complete fix for all sluggishness.

After deployment through the normal release path, compare authenticated GET
wall-time distributions and D1 call spans, controlling region and fresh/due session
state. Correlate mainland-China network routes separately. If the **remaining**
three D1 calls dominate `/v1/me`, the next discriminating experiment is a two-query
primary-session batch for account + identifiers, not lowering password strength or
caching session authority. If configuration-only endpoints are equally slow,
network/edge routing remains a stronger explanation than this backend path.
