# Independent change review — 2026-09-28

## Scope

Reviewed the security-sensitive working-tree changes for contact projection, OAuth token privacy and refresh-client binding, password rotation and guessing protection, recovery revocation, OAuth client provisioning, and CI. This was a source/diff review with relevant schema and existing research notes; it did not rerun already reported passing tests or exercise staging. Earlier deployment limitations documented in the project audit and integration guide are not repeated as findings.

## Resolved during review — OAuth provisioning test migration chain

**Location:** `scripts/tests/oauth-client-migration.mjs`, local-D1 test around the migration copy list and generated filename.

The initial test copied base migrations only through `0005_oauth_pairwise_session.sql`, then wrote its generated client migration as `0006_test_oauth_client.sql`. The repository now includes `0006_password_rate_limit.sql`, so this validated an impossible production sequence. The integration owner subsequently changed the fixture to copy all numbered base migrations, derive the next slot, and assert the full local D1 chain; the owner reported 8/8 focused tests passing. The defect is resolved in the working tree. **Confidence:** high for the original issue and source-level resolution; the reviewer did not independently rerun the test.

## Resolved during review — Password rotation HTTP regression missing from CI

**Location:** `.github/workflows/ci.yml` package/contract jobs; `scripts/tests/password-security.mjs`.

The new password-security harness is the only added real Worker HTTP test for passwordless step-up, credential replacement, cookie rotation, revocation of old sessions and refresh families, and nonreplay of a secret response. The initial CI change ran the SQL-focused `test:password-rate-limit` but omitted this harness. The root owner subsequently added a package script and invoked it in the package job after restoring the Worker build. The coverage gap is resolved in the working tree. **Confidence:** high for the original omission and source-level resolution; no independent CI run was performed by this reviewer.

## Other inspected paths

No further substantive defect was established in the inspected diff. Contact responses now include `contact_id` while preserving the legacy `identifier_id` alias. OAuth access claims no longer emit global `pid` or `sid`; UserInfo resolves pairwise `sub` through the client's sector, and ID-token logout resolves the client-scoped session ID. The refresh-client check now precedes token-reuse revocation. Password change uses D1-batch authority guards before revoking old sessions and refresh families; recovery removes the old password verifier within its batch; login's session insertion checks the verified hash/version still exists. These are source-level observations, not a claim of deployed correctness or exhaustive route coverage.
