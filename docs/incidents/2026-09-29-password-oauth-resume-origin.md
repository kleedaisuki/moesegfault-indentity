# Password OAuth resume used the Login origin / 密码 OAuth 续接误用 Login 来源

**Status / 状态:** fixed revision deployed to staging; native-client browser retest pending. 2026-09-29.

## Observed boundary / 观察到的边界

During a controlled, synthetic staging native-client sign-in, account creation and email verification succeeded and password authentication returned success. The native client's loopback callback timed out. A privacy-safe browser-history classification found an OAuth authorization request on the staging Identity origin and a `/v1/oauth/authorization-transactions/.../resume` navigation on the **staging Login origin**, with none on the staging Identity origin. A bounded D1 readback found the latest transaction in `authenticated`, not `completed`. No authorization URL, transaction handle, credential, code, token, account name, or recipient is included here.

This is evidence of a navigation-origin defect, not of a failed password check or native-client callback listener. The source-level cause is deterministic: `password::authentication_response` returned a root-relative `authorization_resume_uri`, whereas `apps/login` used `new URL(value, location.href)`. Login and Identity are separate origins. The Passkey completion and already-authenticated authorization paths returned absolute issuer-rooted URLs. The OpenAPI schema had already declared an absolute URI, although its former hostname pattern incorrectly constrained the contract to production.

## Correction / 修正

All three server-side resume-URL paths now use one issuer-rooted construction helper. Password completion emits an absolute URL for the configured Identity issuer, matching Passkey and authorization behavior. The Login page's existing top-level navigation and old absolute response behavior remain unchanged. OpenAPI now describes the environment-independent absolute contract; the Identity skill records the browser boundary. No migration, client registration, user-account change, or credential rotation is required.

The focused regression is the existing isolated local-Worker password-security harness: it seeds only a synthetic local principal and OAuth transaction, authenticates through the actual browser-context and password HTTP routes, and asserts the staging issuer URL plus the `authenticated` transaction state. A pure Rust test covers both production and staging issuer construction. The isolated browser harness requires a test-only `TRANSACTION_PEPPER` because the route is protected by the idempotency pre-claim; its absence initially caused HTTP 500 before the handler. The unrelated contact-verification harness also exposed an idle local-Worker socket reuse failure after synchronous Wrangler D1 queries, now avoided by closing those test connections. Neither harness correction changed production runtime code.

## Rollout and verification / 发布与验证

1. **Done:** GitHub [quality and immutable-package run 36521409380](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36521409380) passed for exact source revision `5bf9cb4a43d3122fe9f3ae8df363c5a12158cc67`, including Rust/WASM, Login and Account frontends, contracts, isolated real-Worker password/contact harnesses, and package checks.
2. **Done:** GitHub [staging-only run 36521750319](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/36521750319) passed the same checks and live smoke. The production promotion job was skipped. Cloudflare's deployment readback showed the Identity, Login, and Account staging Workers each serving 100% from a version annotated with that exact source revision. Live discovery reported `https://identity-staging.moesegfault.dev` as issuer and authorization endpoint origin; health and D1 were `ok`, and both frontend roots served HTTP 200 HTML.
3. **Pending:** Retry login using the **existing verified synthetic staging account**, a fresh OAuth transaction, and the native callback listener. Do not re-register or expose browser URL query material.
4. **Pending:** Confirm a privacy-safe browser-origin classification (resume on Identity, not Login), transaction `completed`, and native callback/token success. If deployment and browser state are mixed during rollout, start a fresh authorization attempt after deployment rather than reusing an expired transaction.

The staging incident remains open until step 4 passes. Production promotion is a separate release decision under the normal Identity pipeline.
