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

Production deployment version/readback will be appended after deployment. Root owns
browser-level production acceptance; this note does not claim a production user flow
was exercised by this agent.
