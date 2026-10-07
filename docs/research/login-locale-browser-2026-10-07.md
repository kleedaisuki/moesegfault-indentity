# Registration locale draft-loss browser probe — 2026-10-07

## Scope and expected behavior

Independent, bounded test of the actual in-app Browser at
`https://login-staging.moesegfault.dev/register`. Changing the display language
should not silently erase unsaved registration information: preserve the draft,
or explicitly warn before losing it. This expectation follows the user goal of
repairing real Identity/Account interaction problems, rather than implementation
details or an existing unit test.

No registration, email sending, credential entry, session inspection, deployment,
viewport change, or production source edit was performed by this probe.

## Environment and reproduction

- Official Browser skill/runtime, selected exactly `agent.browsers.get("iab")`.
- New tab created by this agent; its namespace reported Browser ID 2 / tab ID 1.
  `iab.tabs.list()` reported only this register tab. The parent's driver separately
  reported profile tab 1 and register tab 2: numeric IDs alone are not sufficient
  to identify a cross-agent browser tab.
- Initial title: `创建账号 · moeSegFault Identity`; initial selected locale:
  `简体中文`.
- Page was loaded before the parent's candidate staging rollout; the probe did
  not reload it, so this is baseline evidence, not candidate acceptance evidence.
- Runtime operations used 120-second tool deadlines. Browser reads were slow,
  but complete accessibility and DOM snapshots were returned.

Reproduction through documented UI locators:

```js
await tab.playwright.getByRole('textbox', { name: '显示昵称', exact: true })
  .fill('Locale probe draft 1007');
await tab.playwright.getByRole('textbox', { name: '状态签名', exact: true })
  .fill('Unsaved status draft 1007');
await tab.ax.write();
await tab.playwright.getByRole('combobox', { name: '语言', exact: true })
  .selectOption({ label: 'English' });
await tab.ax.write();
await tab.playwright.domSnapshot();
```

## Observations and verdict

| Point | Selected language | Display name | Status message |
| --- | --- | --- | --- |
| After filling | 简体中文 | `Locale probe draft 1007` | `Unsaved status draft 1007` |
| After language selection | English | Empty | Empty |
| After restoring original language | 简体中文 | Empty | Empty |

Before switching, both values appeared in the accessibility tree and DOM snapshot.
After switching, both inputs appeared with only their placeholders and no draft
text. The title became `Create account · moeSegFault Identity`; the URL remained
`/register`; focus returned to `main-content`. No loss confirmation was presented.
The avatar picker DOM ID changed from `avatar-picker-1` to `avatar-picker-2`,
consistent with replacement of the page; this is supporting observation rather
than a verified implementation cause.

**Reproduced interaction defect:** switching registration locale silently loses
unsaved nickname and status. The impact extends to at least these two fields;
other fields, verified email state, and uploads were deliberately not exercised.

Original locale was restored with `Language` combobox → `简体中文` and confirmed by
fresh accessibility state. A proof screenshot was attempted via
`tab.screenshot({fullPage:false})`, but the browser returned `Unable to capture
screenshot`; no screenshot artifact was produced. The DOM/accessibility evidence
above is authoritative for the tested values, but does not verify visual layout.

## Required follow-up

Preserve the in-memory registration draft across locale rendering, including
nontext state where appropriate, without persisting credentials to browser storage.
After repair, repeat this same real-browser sequence against freshly loaded
candidate staging assets and verify both exact draft strings survive. Unit tests
may supplement that acceptance check but do not replace it.
