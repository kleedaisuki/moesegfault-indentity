# Device authorization rollout — 2026-11-05

## Scope and delivery contract

[PR32](https://github.com/kleedaisuki/moesegfault-indentity/pull/32) adds opt-in
RFC 8628 device login, explicit Login confirmation, the portable Identity skill
helper, OpenAPI/registration updates, and deployed staging acceptance. The design
and protocol boundaries are in [ADR-0008](../adr/0008-device-authorization.md) and
the [integration guide](../integrating-app.md).

The owner requested staging deployment and a full real-user journey before
production. The release uses the existing GitHub Actions immutable-package path:
manual `staging-only` candidate deployment, real staging acceptance, then normal
main-push staging → production promotion. No manual production shortcut or new CI
quality gate was added. Root owns dispatch, merge, promotion and rollback.

Live GitHub environment inspection found `protection_rules: []` for both
`cloudflare-staging` and `cloudflare-production`. Older release notes describing a
required environment approval do not describe the current setting. This release
therefore orders real staging acceptance **before merge**, rather than assuming a
production approval pause exists. The checked-in main-only production condition,
checksum verification, environment deployment lock and stale-main guard remain.

## Source and staging deployment

- Feature implementation/documentation checkpoint:
  `46ce9f3130dc585961bfd5d29ae6fbeeaa1f8c6e`;
  [CI41990689647](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/41990689647)
  passed.
- Deployed staging candidate:
  `f8e8472d50666efacecaa00af33b7d980833c8a7`;
  [staging-only run41991502381](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/41991502381)
  passed, as did its
  [PR checks41991509345](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/41991509345).
- Release logs show `0012_device_authorization.sql` applied at
  `2026-11-05T08:07:52Z`, before the new Identity Worker. All five services passed
  deployment smoke at `08:08:10Z`.
- Live staging discovery returned the exact configured issuer, its absolute
  `device_authorization_endpoint`, and
  `urn:ietf:params:oauth:grant-type:device_code` in advertised grant types.

| Service | Verified staging Worker version |
| --- | --- |
| Notifications | `46768b0d-e51c-4bfa-81cc-eb8a6f2e4abd` |
| Decisions | `525f9321-df56-4a10-b631-aebab70f42c5` |
| Identity | `e5596159-90b3-43ee-9382-7bf5ce76ce44` |
| Login | `6a876258-61f5-459e-82f7-c04dd70f9e5e` |
| Account | `350aea76-c008-4bc4-bd8f-1a671856fe82` |

## Real deployed staging journey

The deployed journey uses `scripts/device-journey.mjs`: an actual portable CLI
subprocess polls real HTTPS Identity endpoints while Chromium operates the deployed
Login page. A deployment-owned disposable staging principal/client supplies the
fixture; this is not mocked HTTP or local Miniflare acceptance.

The first
[journey run41992350196](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/41992350196)
passed all four phases and cleanup. Its artifact upload found no files because
`actions/upload-artifact` excluded hidden `.temp` paths. The logs retain that pass,
but no artifact was created. Commit
`ee8e3de24f7c1867eb740c9c9141c521fecb1667` adds `include-hidden-files: true`
while retaining the exact summary/PNG upload allowlist. It changes no application
or acceptance logic. Root compared application, migration, contract, skill and
configuration paths with the deployed candidate and found no application diff.

The repeated
[journey run41992729985](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/41992729985)
passed from `2026-11-05T08:13:46.170Z` to `08:14:23.554Z`
(16:13–16:14 Asia/Singapore):

| Phase | Observed result |
| --- | --- |
| Browser initiation and review | Mobile manual code entry → ordinary password sign-in → retained device confirmation; registered client, account, code and scopes displayed; no horizontal overflow or automatic approval. |
| Explicit approval and remote completion | User action approves; the real CLI polls, validates the RS256 ID token and persists a mode-0600 token file. UserInfo matches the fixture subject. |
| Durable-session lifecycle | Refresh rotates; the new token set is atomically persisted. Explicit revocation makes subsequent renewal fail. |
| Denial | A second actual CLI attempt is denied in the authenticated browser; the CLI terminates without creating a token file. |
| Cleanup | Identity-session revocation returned204; fixture cleanup passed, its client was disabled, and test-principal credentials/protocol state were removed. |

The consent screenshot was also inspected: application, account, human code,
requested scopes, expiry, phishing guidance, and distinct approve/deny controls
remain readable in the mobile layout.

Verified artifact: `device-journey-41992729985`, ID `13398109272`, 261,254 bytes,
seven-day retention. It contains the sanitized summary and mobile screenshot,
not token/password files. The downloaded summary reports `outcome: passed`,
`session_cleanup_status: 204` and `fixture_cleanup: passed`. Useful diagnostic
correlations include UserInfo `01a1aac5-c116-7295-940f-d8909a341945`, successful
refresh `01a1aac5-c2a6-7d96-bc5c-d12f6864533c`, and rejected post-revocation
renewal `01a1aac5-ca02-7a16-81fc-258e6960991d` (HTTP400).

Repository-local copies are under
`.temp/device-staging-evidence-41992729985/device-staging-a6C0Re/`;
deployment and first journey logs are `.temp/device-staging-deploy.log` and
`.temp/device-staging-remote-journey.log`. The substantive outcomes above remain
in Git after the temporary files and short-lived Actions artifact expire.

## Production promotion and readback

After the final
[PR CI41992739446](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/41992739446)
and deployed staging journey passed, PR32 was merged at
`2026-11-05T08:17:02Z` as `3911715b07dc0b30878ea27a51fd2c0b4946d66f`.
The normal
[main-push run41993267570](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/41993267570)
completed successfully at `08:23:07Z` (16:23 Asia/Singapore). GitHub staging
deployment `7568708035` and production deployment `7568724215` both identify
that exact merge SHA.

This main run built its own merge-SHA release package; it is **not** the earlier
feature-branch package. In particular, Login embeds the merge build revision.
Within the main run, staging and production downloaded and verified the **same**
immutable tarball rather than rebuilding between environments. Root independently
downloaded and checked artifact ID `13398992583`; the inner release tarball SHA-256
is `27c18e0701501546ac4d69dcc372782c61eedabed12e85b69da31a59498d8559`.
The earlier full browser/CLI journey establishes deployed candidate application
behavior; the final main run supplies merge-revision packaging, ordered promotion
and both-environment deployment smoke evidence.

Main staging smoke passed at `08:22:04Z`. Production then applied
`0012_device_authorization.sql` at `08:22:49Z`, before deploying the authority.
Identity/Login/Account smoke and Notifications/Decisions smoke all passed by
`08:23:03Z`.

| Service | Main-run staging Worker version | Final production Worker version |
| --- | --- | --- |
| Notifications | `6ec044d0-487e-4dc9-931f-2f08b556bf76` | `7e3297c0-536f-47c0-8064-915d885ea1d3` |
| Decisions | `26deac1a-1fe5-4f1f-a296-b459b8089b33` | `1fd3e690-8be6-420b-83d7-0a56396d82e3` |
| Identity | `b95f4f1f-9d17-48db-8b9e-f61a56f06579` | `85e2c0cd-44bf-46d9-a3ad-5ff2fb2f759c` |
| Login | `dee55937-6acb-4695-ab5f-373e6824b327` | `435f5297-fe02-411b-96cb-e7be458ace50` |
| Account | `20538dfb-06a6-4891-bb77-01cfa2c815dc` | `ae40172c-420c-45c7-aeb4-9d05989e8eeb` |

Independent public production probes at `2026-11-05T08:23:27.130Z` passed:

- deep Identity health and D1 readiness;
- exact issuer, absolute device endpoint and device grant, retained authorization
  code/refresh grants, and public signing keys;
- `/device`, its CSP, localized confirmation UI, and Login asset
  `/assets/index-DbUObKeW.js` containing the merged source revision;
- unknown-client device authorization returning401 without issuing credentials;
- anonymous browser confirmation returning401 with the correct paired-origin CORS.

The production probe used no authenticated user or credential mutation. Existing
clients remain device-disabled unless separately reviewed and enabled; successful
staging fixture login does not provision a production application automatically.
The release outcome is **staging full browser/remote-CLI journey passed, production
promotion and public feature/readiness checks passed**. No rollback was required.

Final evidence is `.temp/device-main-production-release.log` and
`.temp/device-production-public-probe.json`, alongside the linked main workflow.

## Repeat acceptance and rollback baseline

To repeat the real deployed staging journey without redeploying application code:

```bash
gh workflow run bootstrap.yml --ref main \
  -f target=staging -f platform_journey=skip -f device_journey=true
```

This selects only the staging device journey, provisions a task-owned disposable
fixture, runs Chromium and the actual CLI, revokes the session and removes fixture
credentials/protocol state, and uploads only sanitized summary/PNG evidence.
It is an explicit manual acceptance path, not a new PR/CI quality gate or a
production journey. The workflow requires the existing staging deployment access.

The pre-release production baseline was
`5e0dae68826d89aaf2832625fa4f69abfe831d87`, GitHub deployment `7388405829`, from
[run40707342063](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40707342063).
Known-good versions captured before promotion:

| Service | Previous production Worker version |
| --- | --- |
| Notifications | `cfae9af1-eaa2-440d-8091-c7d36d23c9e8` |
| Decisions | `3ff930b8-b6eb-4c88-bdad-b318c6dd3411` |
| Identity | `a074006d-fecf-4b53-a77e-c737c7a93fe1` |
| Login | `7aa017cc-2e45-4e9f-8151-8cee45b51bdf` |
| Account | `1c59e83f-29dd-4d37-8cd7-85e6e44fa09d` |

Apply schema migrations before Worker code. A rollback restores frontend versions
before Identity and retains the expanded D1 schema; it must not restore a database
snapshot or rotate the pepper to undo this release.
