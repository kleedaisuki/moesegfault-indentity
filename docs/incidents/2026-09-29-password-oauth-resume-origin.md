# Password OAuth resume used the Login origin / 密码 OAuth 续接误用 Login 来源

**Status / 状态:** fix prepared; staging deployment and browser retest pending. 2026-09-29.

## Observed boundary / 观察到的边界

During a controlled, synthetic staging native-client sign-in, account creation and email verification succeeded and password authentication returned success. The native client's loopback callback timed out. A privacy-safe browser-history classification found an OAuth authorization request on the staging Identity origin and a `/v1/oauth/authorization-transactions/.../resume` navigation on the **staging Login origin**, with none on the staging Identity origin. A bounded D1 readback found the latest transaction in `authenticated`, not `completed`. No authorization URL, transaction handle, credential, code, token, account name, or recipient is included here.

This is evidence of a navigation-origin defect, not of a failed password check or native-client callback listener. The source-level cause is deterministic: `password::authentication_response` returned a root-relative `authorization_resume_uri`, whereas `apps/login` used `new URL(value, location.href)`. Login and Identity are separate origins. The Passkey completion and already-authenticated authorization paths returned absolute issuer-rooted URLs. The OpenAPI schema had already declared an absolute URI, although its former hostname pattern incorrectly constrained the contract to production.

## Correction / 修正

All three server-side resume-URL paths now use one issuer-rooted construction helper. Password completion emits an absolute URL for the configured Identity issuer, matching Passkey and authorization behavior. The Login page's existing top-level navigation and old absolute response behavior remain unchanged. OpenAPI now describes the environment-independent absolute contract; the Identity skill records the browser boundary. No migration, client registration, user-account change, or credential rotation is required.

The focused regression is the existing isolated local-Worker password-security harness: it seeds only a synthetic local principal and OAuth transaction, authenticates through the actual browser-context and password HTTP routes, and asserts the staging issuer URL plus the `authenticated` transaction state. A pure Rust test covers both production and staging issuer construction. CI must run these; local formatting and script syntax checks alone are not release evidence.

## Rollout and verification / 发布与验证

1. Await GitHub CI quality and package checks for the exact revision.
2. Deploy **staging only** using the reviewed Identity workflow; do not promote this incident fix to production merely to test amail.
3. Retry login using the **existing verified synthetic staging account**, a fresh OAuth transaction, and the native callback listener. Do not re-register or expose browser URL query material.
4. Confirm a privacy-safe browser-origin classification (resume on Identity, not Login), transaction `completed`, and native callback/token success. If deployment and browser state are mixed during rollout, start a fresh authorization attempt after deployment rather than reusing an expired transaction.

The staging incident remains open until step 4 passes. Production promotion is a separate release decision under the normal Identity pipeline.
