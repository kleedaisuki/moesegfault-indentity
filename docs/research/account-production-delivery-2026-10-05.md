# Account Subscription Production Promotion (2026-10-05)

## Scope and preservation

Promote the staging-accepted Account frontend from `fe7eec4` only. Account remains a
first-party static client; no Identity backend change or service deployment belongs to
this rollout. The comparison against production source `origin/main` (`407f663`) contains
only the accepted subscription section, shared return route, current-session sign-out,
and their tests/documentation. Existing production UI behavior is preserved.

Production hostname `account.moesegfault.dev` selects `subscribe.moesegfault.dev`,
`identity.moesegfault.dev`, and `login.moesegfault.dev`. No `.env` files or VITE environment
overrides were present during the fresh build. The view passes only locale and effective
theme; no Account identity identifier, cookie, CSRF proof, or OAuth token crosses the
iframe boundary. Subscribe visibly labels its independent signed-in account. Identity
uses a pairwise OIDC subject, so Account principal IDs are never equated with OAuth `sub`.

## Verification and artifact

- Account: 66 tests passed across 14 files, `--maxWorkers=2`.
- Shared environment/route contract: 3 tests passed, one worker.
- TypeScript project check and Vite production build passed.
- Entry JS: `index-CM7SzkwV.js` (52.49 kB, gzip 18.41 kB).
- Entry CSS: `index-ClP0ODt_.css` (17.07 kB, gzip 4.58 kB).
- Build time: 266 ms; no local Rust compilation.
- Before rollout, production served `index-CNM-m4Gx.js` and CSP lacked Subscribe frame-src.
- Before rollout, staging continued to serve `index-CM7SzkwV.js`.

Commands:

```powershell
node node_modules/vitest/vitest.mjs run --root apps/account --maxWorkers=2
node node_modules/vitest/vitest.mjs run --root packages/frontend-shared src/environment.test.ts --maxWorkers=1
npm run build:account
```

## Coordinated rollout

Identity/Login production promotion and OIDC client registration are owned by the
Identity rollout agent. The agreed rollout uses the existing
GitHub Actions main pipeline to promote Identity, Login, and Account together from the
coordinated source that includes `fe7eec4`. No independent Account Wrangler deployment
will run, avoiding duplicate promotion and artifact overwrite. Production Subscribe
`/account` health must be ready before the overall rollout is accepted.

## Production deployment and readback

The coordinated main revision is `c91f7a8eb780f6731777eafd4d4a2cdd83231c1c`.
The existing GitHub Actions release completed successfully:
https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/37268599733

Account production version: `e9348f12-5723-4778-bc0b-8ac037efc5e2`, deployed at 100%.
The deployment owner read back creation at `2026-10-05T05:41:42.758847Z` (13:41:42
Asia/Singapore), with `Production GitHub c91f7a8` annotations. Independent Wrangler
version-list readback agrees with the version and exact coordinated revision.

Response readback after the release:

- `https://account.moesegfault.dev/subscriptions`: HTTP 200, entry
  `/assets/index-CM7SzkwV.js`.
- Served entry JS contains the fixed production Subscribe and Account origins,
  `/subscriptions`, the native current-session revocation implementation, and the
  independent subscription-account presentation. No new code was needed for production.
- Served CSP contains `frame-src https://subscribe.moesegfault.dev
  https://subscribe-staging.moesegfault.dev` and retains `frame-ancestors 'none'`.
- Staging Account still serves `/assets/index-CM7SzkwV.js`; no independent staging or
  production deployment was run by this Account workstream.

At this readback, local requests to `https://subscribe.moesegfault.dev/account` failed
TLS connection establishment. Root and the deployment owner were informed: Subscribe
DNS/certificate/route readiness is a separate rollout gate, not a reason to redeploy
Account. This observation is not presented as an Account iframe rendering failure.

Root owns browser-level production acceptance; this note does not claim that this agent
exercised production sign-in, activation, iframe rendering, or logout.
