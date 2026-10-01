# PR22 opt-in Login failure receipt rollout — 2026-10-01

## Verdict and boundary

**PASS: exact main-source hosted quality/package/promotion, six active Worker versions and environment binding pairing, anonymous HTTP acceptance, and anonymously delivered Login JavaScript support-receipt markers.**

This does **not** establish that the original user's pre-authentication `401 authentication_failed` is resolved, nor that an authenticated browser journey or rendered error/copy interaction succeeds. The change adds private, explicit opt-in diagnostics; it does not make invalid credentials authenticate. Marker presence is a delivery discriminator, not proof of execution or absence of every possible unintended behavior. Source privacy contracts and behavior tests were covered by the hosted gate, not inferred solely from compiled strings.

The monitor performed no project build/test locally, provider mutation, dispatch, deploy, retry, push, credential/account login or authenticated API mutation. No account identifier, password, token, cookie, transaction URL, OTP, receipt instance, secret value or raw response body was printed or persisted. Anonymous HTTP bodies and provider metadata were held in memory and reduced to allowlisted evidence only.

## Hosted immutable release

- Main SHA: `ef642619140928e3ab5603c575c45802dbeee370`; independently confirmed current main with `git ls-remote` after promotion.
- [Main-push run 36797640859](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36797640859): created `2026-10-01T00:44:07Z`, successfully completed by `00:48:38Z`.
- All eight required jobs succeeded; staging completed before production promotion began.
- Release artifact `11134074058`: 1,030,525 bytes, archive digest `sha256:6d34676d5880d480c3f8787a68a44c77a91eaf6f9c7420db6042eef6d75e84e3`, non-expired at readback. The digest identifies the GitHub archive, not an inner package checksum. This monitor did not download/rebuild it.

| Job | Job ID | Result | Completion UTC |
| --- | --- | --- | --- |
| Rust quality and Worker build | 110164636712 | success | 10/01/2026 00:46:02 |
| Contracts, migrations, config, scripts | 110164636964 | success | 10/01/2026 00:45:54 |
| login frontend | 110164636968 | success | 10/01/2026 00:44:39 |
| account frontend | 110164637131 | success | 10/01/2026 00:44:38 |
| Immutable deployment package | 110165138046 | success | 10/01/2026 00:47:11 |
| Required quality gate | 110165443685 | success | 10/01/2026 00:47:18 |
| Deploy and verify staging | 110165444170 | success | 10/01/2026 00:47:58 |
| Promote verified revision to production | 110165644702 | success | 10/01/2026 00:48:37 |

## Independent live provider readback

`wrangler deployments list --json` and `versions view <id> --json`, using exact main config and production selection only for production, established one active 100% version for each unit. Both deployment and version message annotations match the expected environment plus exact source SHA. Identity public environment/issuer/origin/RP/OAuth variables, exact D1/R2 resources, required secret binding names/types and email binding were checked in memory. No secret values or database rows were read.

| Environment | Unit | Active version | Deployment | Traffic |
| --- | --- | --- | --- | --- |
| staging | identity | fd843870-3e46-4ca1-98e5-5e988827b749 | 9f8bbf30-1d30-4ca7-8c3d-03b2c94180fa | 100% |
| staging | login | 0b8520a8-dec8-4900-984d-5a6aa90d98ab | f39861a8-bb1a-44a8-a766-2dd594c3cd4b | 100% |
| staging | account | 008b9663-1f2e-4412-b279-8d476750312c | af18ef20-1761-4371-abfa-bb4ad99048c5 | 100% |
| production | identity | 40e2f5ef-16c3-4e7c-838c-4b526fd1d461 | d656e12f-ac8b-45e6-a62c-6f44da331a67 | 100% |
| production | login | 3f60ec33-65b1-404e-a6a4-a231e67db4de | f52ed4e4-9bac-4d25-b597-1fdf6ae690af | 100% |
| production | account | 1c592af7-9fb4-450a-baae-685c3ddc78e7 | e11c0b03-829b-4272-b727-27c407b02351 | 100% |

## Anonymous HTTP and Login asset checks

Bounded existing acceptance harness: 19 anonymous requests per realm, no redirects, credentials/cookies or retries. Staging passed `2026-10-01T00:50:41.791Z`; production passed `00:50:53.255Z`.

- Health 200 with D1 healthy; discovery 200 and exactly paired Identity issuer.
- Login root/login/brand: `no-store, no-transform`; Account root/security/mutable icons: `public, max-age=0, must-revalidate`.
- HTML-linked hashed JS/CSS: 200 and explicit conditional 304, `public, max-age=31536000, immutable`; CSP, nosniff and same-origin COOP retained.
- Anonymous `/v1/me`: expected 401 `authentication_failed`, paired Account origin and credential CORS. This is an unauthenticated contract, not reproduction of the original password rejection.
- Password PUT preflight: 204 and correct paired origin/method.

Separate Login asset discriminator performed four anonymous requests total: root plus uniquely HTML-linked hashed JS in each realm. Both realms delivered the same SHA-256 `1481301b30c58cbc38f722664e77ea02904475828d7055b004e928e300668e36`. Both had true markers for exact source revision, support-details UI/copy strings, never-auto-upload disclosure, fixed receipt field/transport/problem allowlist, known deployed realms and clipboard-copy logic. Bodies were not saved. Asset markers do not substitute for an authenticated/interactive UI observation.

## Reproduction and durable artifacts

Repository-local `.temp/identity-pr22-live/` contains only allowlisted run/artifact metadata, six sanitized version reports, two anonymous HTTP reports, asset hash/booleans and narrow read-only harnesses. The evidence document is staged in isolated main-based `.temp/identity-pr22-rollout-evidence/docs/research/pr22-login-receipt-rollout-2026-10-01.md`.

Commands used:

```powershell
gh run watch 36797640859 --repo kleedaisuki/moesegfault-indentity --exit-status --interval 45
gh run view 36797640859 --repo kleedaisuki/moesegfault-indentity --json status,conclusion,jobs,headSha,createdAt,updatedAt,url
gh api repos/kleedaisuki/moesegfault-indentity/actions/runs/36797640859/artifacts
& .temp/identity-pr22-live/verify-deployments.ps1 -ExpectedSha ef642619140928e3ab5603c575c45802dbeee370
node .temp/identity-pr22-live/verify-http.mjs staging
node .temp/identity-pr22-live/verify-http.mjs production
node .temp/identity-pr22-live/verify-login-asset.mjs
git ls-remote origin refs/heads/main
```

The `node` commands are narrow live read-only HTTP acceptance, not project tests or compilation. Ordinary failure diagnostics remain user-controlled: if the original failure recurs, obtain only the deliberately copied receipt privately; do not ask for credentials, publish correlation IDs, or claim a successful authentication from anonymous health/version evidence.
