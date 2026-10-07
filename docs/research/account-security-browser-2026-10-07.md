# Account security and subscription browser validation — 2026-10-07

## Environment and scope

- Official Codex in-app Browser (`iab`), fresh agent runtime and agent-owned tab 1; staging only. No production deployment or production account access.
- Account https://account-staging.moesegfault.dev; Identity https://login-staging.moesegfault.dev; Subscribe https://subscribe-staging.moesegfault.dev.
- Dedicated disposable test fixture `journey_20261007`. Credentials stay in ignored protected task files; no email address, password, OTP or recovery code is recorded here.
- Fresh agent/browser tab does **not** provide an independent cookie jar. Account immediately rendered the already-authenticated owned fixture; Sessions showed one current device. Therefore this is NOT a second-device/revocation test.
- Candidate 1 security/session observation; candidate 2 was reported staged by parent before apps/subscription observation. These are runtime UI observations, not asset-hash verification.

## Authoritative observed results

| Journey | Expected basis | Observed UI | Verdict |
| --- | --- | --- | --- |
| Security landing | Owned password-created account should expose credential state and management routes | Passkey count 0; password enabled with Current/New password controls; recovery codes enabled; two-step verification preparing (TOTP/WebAuthn) | Landing verified; no credential mutation performed |
| Passkey return destination | Management must return to the initiating Account screen | Visible link to login-staging `/passkey/enroll?return_uri=` encoded Account `/security` | Link destination verified only; enrollment not attempted |
| Recovery-code return destination | Credential-management route should preserve origin | Visible link to login-staging `/recovery-codes/rotate?return_uri=` encoded Account `/security` | Link destination verified only; rotation not attempted |
| Sessions | Current authenticated browser must be identifiable | One password article; displayed login date 2026-10-07 15:18; `当前设备`; no other device | Current-device view verified; targeted revocation unexercised |
| Connected apps | New fixture without grants should have useful empty state | `还没有连接任何应用。` after one normal reload | Empty state verified |
| Initial subscription embedding | Account must explain service identity and offer an actionable reconnect path | Parent copy asks to compare displayed account; management/reconnect links; iframe renders anonymous subscription login | Rendering and reconnect discovery verified |
| Reconnect | Routine existing-session SSO should reconnect owned fixture and retain return destination | Following exact visible reconnect href automatically authenticated Subscribe as matching owned fixture display name; no credential or consent submission. Empty subscriptions, activation disabled with no code, Return to app href is Account `/subscriptions` | Routine SSO return verified; no purchase, activation, billing save or grant |
| Return iframe | After reconnect Account iframe should show matching subscription identity | Following exact Return to app href renders Account + iframe `订阅服务账号:` matching owned fixture and empty subscriptions; management/switch-account links visible | Cross-service journey verified |

## Tool and environmental limitations (not product defects)

- Locator `press('Enter')` in this fresh context only focused the Account security link without navigating. Login fills also returned input lengths inconsistent with supplied values (both 10 characters); two nominal wrong-password submissions produced no UI effect. No correct-password attempt occurred. These observations do not establish that the backend received a wrong-password attempt or that product feedback is defective.
- Parent coordinated stopping all auth submissions because browser tabs share the owned fixture cookie jar and another driver was testing unsaved drafts/native confirmation.
- The read-only journey therefore used `tab.goto()` with exact visible navigation/reconnect/return hrefs. It does not verify keyboard activation or mouse interaction.
- First `/apps` navigation timed out. Inspecting the same live handle showed actual `/apps` and global error UI `页面暂时出了点小故障 / Unable to reach the identity service. / 重试`. One `tab.reload()` recovered normal empty state. Parent independently observed contemporaneous staging TLS/fetch failures, so classify as transient network failure, not an apps product regression.
- Screenshot attempt after successful subscription return failed `Unable to capture screenshot`; DOM evidence verifies semantic content, not pixel layout. No screenshot or visual-layout acceptance claimed.

## Reproducible Browser commands

After official skill bootstrap and exact iab selection, obtain own fresh tab. Read fixture JSON through ordinary local fs without printing secrets. Run calls with 120-second timeout and at most four operations per call.

1. `tab.goto(Account + '/security')`; `tab.playwright.domSnapshot()` (redact owned email before output).
2. `tab.goto(Account + '/sessions')`; snapshot.
3. `tab.goto(Account + '/apps')`; on observation timeout inspect same tab URL/snapshot; one normal reload if network failure.
4. `tab.goto(Account + '/subscriptions')`; snapshot initial iframe and parent links.
5. `getByRole('link', {name: '重新连接账号', exact: true}).getAttribute('href', {})`; navigate exact href; inspect rendered identity/return link without touching activation/billing/logout.
6. `getByRole('link', {name: '返回应用', exact: true}).getAttribute('href', {})`; navigate exact href; inspect Account iframe identity/empty state.

## Remaining coverage

Actual wrong/correct password submission, independent-device creation/revocation, credential change/removal, Passkey enrollment and recovery-code rotation require separately coordinated interaction and policy-compliant authorization/hand-off. This work neither claims those pass nor classifies their unexercised status as a product defect. Cross-account subscription switching was not exercised; only matching-fixture reconnect was verified.
