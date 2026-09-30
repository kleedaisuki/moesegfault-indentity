# Service and page sluggishness investigation — 2026-10-01

## Scope and evidence boundary

The user reports slow loading/navigation, slow login/save operations, and slow input/scrolling.
Investigation started at repository commit `32064c9` with a clean working tree. Local measurements
ran on Windows PowerShell, Node `v26.8.2`, curl `8.21.0` (Schannel, HTTP/1.1), and Wrangler `4.131.1`.
The user-facing date is 2026-10-01 in Asia/Singapore; captured response dates were 2026-09-30 UTC.

Production probes were **anonymous GETs only**, sequential, three cold curl connections per endpoint
and network mode. No production account, session, mutation, password attempt, load test, deployment,
database migration, or configuration change was performed. `/v1/me` is expected to return 401.
These timings include network connection establishment; they are not Worker CPU time, warm-browser
fetch latency, authenticated service latency, Core Web Vitals, or statistically stable percentiles.
All 42 sampled requests completed successfully with expected statuses. Results do not establish
an outage, but do establish meaningful latency and variability from this machine.

## Findings and causal separation

### 1. Network latency is significant even before application data work

The shell has explicit HTTP(S)/ALL proxy variables configured for a loopback proxy. Both modes below
use the same machine; `explicit-proxy-bypass` means curl `--noproxy '*'`, **not** a verified mainland
China direct connection. Transparent VPN/TUN, routing, DNS, and host egress remain unmeasured.

| Endpoint | Inherited proxy median / range (ms) | Explicit-proxy-bypass median / range (ms) |
| --- | ---: | ---: |
| Login HTML | 805 / 794–1,246 | 453 / 303–679 |
| Account HTML | 1,022 / 877–4,781 | 471 / 300–725 |
| OIDC discovery | 860 / 816–985 | 790 / 295–872 |
| Deep health (one D1 read) | 1,005 / 708–1,427 | 1,082 / 389–2,414 |
| Public capabilities | 2,721 / 766–3,157 | 763 / 280–941 |
| Registration policy (D1 read) | 1,095 / 758–1,168 | 1,058 / 954–1,090 |
| Anonymous `/v1/me` rejection | 967 / 621–1,158 | 789 / 651–1,527 |

Inherited-proxy CF-RAY locations varied across SYD, OTP, KIX, MXP, MAN, BOS, MIA, CPH, etc.
Bypass samples also varied: SIN/HKG **and** AMS/DUS/LHR. Therefore neither mode provides a
controlled geographic comparison. The fact that small static HTML and the database-free discovery
and capabilities endpoints also exhibit long waits rules out SQL and password hashing as the
**sole** explanation. It does not isolate the proxy from every other network factor. Most byte
transfer times were tiny relative to TTFB; the slow Account HTML proxy sample spent 2.903 s before
TLS completed and 4.779 s to first byte. A 66-byte health response also had a 1.026 s post-first-byte
delay in one bypass sample, which reinforces that network variation cannot be ignored.

Raw metadata and header files: `.temp/performance-2026-10-01/network-samples.json` and neighboring
`*.headers`. They are intentionally ignored local artifacts. The table above preserves the important
measurements in tracked knowledge. Small sample size precludes p95/p99 or user-population claims.

### 2. Login assets have a confirmed contradictory cache policy

Live `https://login.moesegfault.dev/assets/index-BC7yChrU.js` returned:

```http
Cache-Control: no-store, no-transform, public, max-age=31536000, immutable
```

The wildcard rule and `/assets/*` rule in Login `_headers` both match; Cloudflare combines their
values. `no-store` defeats the intended long-lived browser cache for hashed JS/CSS. The HTML's
`no-store` is deliberate and must stay intact. `CF-Cache-Status: HIT` on HTML does not contradict
browser `no-store`: those describe different caching layers.

Both frontends now detach the inherited header and set immutable caching for only content-hashed
entry JS/CSS. The real local Wrangler runtime verified all four bundles return exactly
`public, max-age=31536000, immutable`, while HTML, mutable SVGs, and security headers retain their
prior behavior. Account's former zero-max-age bundles now avoid normal warm-cache revalidation.
See [the frontend investigation](frontend-performance-2026-10-01.md) for 11-path runtime evidence
and regression coverage. This is a local correction, not a deployed fix or cold-first-load speedup.

### 3. Authenticated reads issue a provably unnecessary D1 write RPC

The existing session lookup is authoritative, but is followed by an awaited `touch_session`
UPDATE every time. The SQL update has a 300-second activity window: inside that window it changes
zero rows, yet the remote call still occurs and stays on the response critical path.

The backend change projects `last_seen_at` in the existing session query and omits **only**
the writes that the current predicate already makes no-ops. Authoritative lookup, revocation,
principal status, idle/absolute expiry, FirstPrimary consistency, and the SQL compare-and-update
guards remain in force. This saves one D1 invocation on each qualifying authenticated read; it
does not imply a measured production millisecond improvement. No revocation cache or weaker
password algorithm is introduced. Real release-Wasm/workerd testing verified fresh `/v1/me`
D1 calls decrease from 4 to 3, while due renewal still performs 4 calls. Generic session lookup
via `/v1/browser-context` uses 1 call when fresh and 2 when due. A local sensitivity experiment
used 25 alternating before/after requests after 5 warmups per condition:

| Artificial delay per D1 invocation | Before median (ms) | After median (ms) |
| --- | ---: | ---: |
| None | 10.70 | 8.96 |
| 20 ms | 122.41 | 91.14 |
| 80 ms | 363.46 | 273.13 |

These delays are deliberately injected test conditions, **not measured production D1 latency**.
Timer quantization and runtime scheduling contribute overhead, so the wall-clock delta need not
equal the requested delay. Measurements were not performed on an isolated idle machine; independent
security validation may have overlapped and contributed contention. The robust conclusion is
the removed serial invocation, not a precise wall-clock speedup. See the
backend report and independent review for security/expiration/renewal evidence.

### 4. Account startup has a serial dependency barrier

Source at the investigation baseline waits for both `/v1/me` and preferences before constructing
route content. Deep routes then perform route-specific fetches in a second wave; profile also
requires contacts. This is a request-waterfall opportunity, not a reason to issue speculative
sensitive requests before authentication. No request-scheduling change was made: flattening it
without authenticated measurements could add private reads on anonymous visits and new 401/abort
races. Any later change must preserve the anonymous landing, stale-navigation abort, CSRF
ownership, failure UI, and 401 handling.

Login's initial form renders without an API request; its first submit acquires browser CSRF state
before the mutation, which is a security dependency and cannot simply be dropped. Account and
Login production JS are approximately 17–20 KB gzip, so bundle splitting or replacing frameworks
is not the leading intervention.

### 5. Input and scrolling remain a separate unresolved symptom

No Chrome DevTools MCP was configured. The attempted local browser probe did not proceed; no
new browser frame trace, INP, LCP, CLS, long-task, FPS, or CPU-throttled interaction measurement is
claimed. Network waits cannot by themselves prove why typing or scrolling is choppy. Source
inspection can identify candidates (render scheduling, backdrop effects, DOM churn), but not rank
their causal effect without a real device trace. Do not call network/header fixes a measured frame
rate improvement.

## Reproducible and safe follow-up

The tracked diagnostic helper excludes bodies, cookies, credentials, and proxy URLs from output,
disables curl config files, performs fixed anonymous GETs only, bounds samples to 1–5, imposes
connect/transfer limits, and makes errors visible instead of hiding them with retries:

```powershell
node --test scripts/tests/http-latency.mjs
node scripts/measure-http-latency.mjs production --samples=3
node scripts/measure-http-latency.mjs production --direct --samples=3
node scripts/measure-http-latency.mjs staging --direct --samples=3
```

Run comparable samples on the affected user's actual network, keeping browser/device, time window,
and explicit proxy mode recorded. Direct mode only disables explicit proxies. Use medians/ranges
for these few samples and do not extrapolate to percentiles. The same helper should be used after
deployment, not as evidence that undeployed changes are already helping production.

Remaining high-information probes: authenticated staging request traces with D1-call counts;
browser cold/warm reload cache behavior; profile-ready time under fixed response delays; a real
typing/scrolling trace on the affected device. Local mock delays isolate scheduling mechanisms,
while production traces are required for deployed tail latency. Ask for neither passwords nor
session-cookie dumps; use correlation IDs and sanitized timing summaries.

## Platform and research judgment

- [Cloudflare static asset headers](https://developers.cloudflare.com/workers/static-assets/headers/)
  define matching-rule concatenation and header detachment; use the platform's native header
  rules, not a new static-serving Worker.
- [Cloudflare Worker best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
  recommend moving independent work off the critical path. This does **not** authorize moving
  revocation checks or correctness-dependent state changes into unawaited tasks.
- [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
  documents primary-location round trips and potentially stale replicas. Authentication authority
  must not use unconstrained replica reads solely to reduce latency.
- [Worker placement](https://developers.cloudflare.com/workers/configuration/placement/) can improve
  multi-call backend locality, but it is not enabled blindly here: current probe locations are
  uncontrolled and no per-route production comparison or database-location evidence exists.
- [CRISP (USENIX ATC 2022)](https://www.usenix.org/conference/atc22/presentation/zhang-zhizhou)
  provides production-backed RPC critical-path methodology. The useful transfer is removing
  checkable serial work, not borrowing a speedup from a different system.
- [Panorama (USENIX ATC 2024)](https://www.usenix.org/conference/atc24/presentation/li-geng)
  studies measured end-to-end routes in a global interactive overlay. It reinforces the need to
  characterize user network paths, but its real-time-video latency targets/results cannot be
  used as this SPA's thresholds. More recent web-cache research is discussed in the frontend note.

## Completion record

Root validation: the HTTP helper's five offline tests passed, syntax check passed, and a
seven-endpoint production explicit-proxy-bypass smoke produced expected statuses. Frontend suites
passed 56 Login and 50 Account tests; both TypeScript/Vite builds passed with unchanged JS/CSS
hashes, and both frontend lint gates passed. The 11-path real asset-runtime check passed. The
release Wasm build passed. Full native Rust workspace validation passed 14 domain tests, 88 Worker
tests and 1 domain doctest; 2 existing Worker doctests remain ignored. Worker Clippy with warnings
denied and workspace formatting checks passed. The Worker session harness passed actual
D1-call-budget, renewal/expiry/revocation and HTTP-projection checks. Independent existing
`security-boundary` and `password-security` workflows both exited 0, preserving browser guards,
idempotency, session rotation and authority revocation. New offline diagnostics and session-call
budget tests are wired into the existing contracts/package CI jobs; YAML/npm wiring parsed with
PyYAML and JSON and passed. Remote CI/deployment is not claimed.

Detailed evidence: [frontend report](frontend-performance-2026-10-01.md),
[backend report](backend-performance-2026-10-01.md),
[independent review](performance-review-2026-10-01.md), and
[independent validation](performance-validation-2026-10-01.md). No production mutation or
deployment was performed. The remaining meaningful gap is actual user-device interaction
profiling and deployed authenticated before/after traces.
