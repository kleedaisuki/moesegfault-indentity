# Registration Adaptive Layout (2026-10-03)

## Contract and implementation

Show the complete signup form immediately. Email verification remains inline, and only
final submission with server-authorized mailbox proof creates an account. This patch
changes layout and neutral avatar copy, not authentication or account-creation semantics.

The previous email action grid reserved a hidden second track. The avatar grid also
reserved a preview track when its preview was hidden. Use flex actions and a single
avatar details track by default; add the preview track only when a preview exists.
The shell projects its active route onto main so the containing block owns the 760px
registration width instead of translating a child outside a narrower container.

Profile pairs use auto-fit with a 15rem minimum. Container queries stack email actions
and sign-in methods below 32rem of available card space, and avatar previews below
25rem. This adapts to embedded/narrow content areas, not merely device categories.
Controls preserve zero minimum intrinsic width, wrap explanatory text, and keep
inputs at 16px with 48px minimum height. Avatar buttons and display selectors are
at least 44px high. Header controls move to a separate row on small phones.

## Validation and reproduction

- Windows, local Vite, native Codex browser. Initial form checked at viewport widths
  320, 360, 390, 430, 600, 768, 1024 and 1280 CSS pixels (900px height).
- No horizontal document overflow or visible form control outside the form was found.
  Avatar bodies matched full-width fields; profile pairs stack on phones and split on desktop.
- Expanded code/error/avatar-preview states checked at 320, 390, 600, 768 and 1280.
  Correct-code state also inspected visually at 1280. Native file chooser exercised
  the real avatar processor (synthetic checkerboard, resulting 800x800 WebP, 4.2 KiB).
- The local `.temp/signup-responsive-fixture.html` imports the actual shell, page and CSS
  but mocks email API responses. Invalid code displays the actual localized error;
  valid fixture code yields a synthetic proof. No real emails or accounts were created.
- Screenshots and geometry JSON remain in repository `.temp`. Browser geometry and
  screenshots are layout evidence; happy-dom tests are not treated as a layout engine.
- `npm run test:login`: 14 files / 66 tests passed, including route-sizing reset.
- `npm run build:login`, `npm run lint:login`, `git diff --check`: passed.

## References

- [MDN container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Container_queries): adapt descendants to available component space.
- [W3C reflow guidance](https://www.w3.org/WAI/WCAG21/Understanding/reflow): 320 CSS pixel reflow target. This inspection is not a full WCAG certification.

## Delivery

Staging-only delivery is recorded below after deployment. Production is not part of this request.

### Delivered candidate

- Revision: `d3e16b3` on `codex/registration-email-first-20261003`.
- [Staging-only run 37134005840](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/37134005840): all required checks and staging deployment succeeded; production promotion skipped.
- Smoke passed at `2026-10-03T15:43:52Z`.
- Worker versions: Identity `aab22797-394b-4941-90f5-f71218ee5583`, Login `9cfa853c-bd7d-414e-867e-e1611770299e`, Account `30b83a1f-ea2c-4f61-b5af-88f174424a09`.
- Live `/register` loaded the exact built `index-DAC2KgEZ.css`. At 390px viewport,
  document width was 375px (vertical scrollbar excluded) and form width 342.67px;
  at 1280px, document width was 1265px and form width 760px. No horizontal overflow.
- Native screenshots inspected in English and Simplified Chinese; final Chinese
  viewport screenshots saved as `.temp/signup-adaptive-staging-{mobile,desktop}.jpg`.
- Preview: https://login-staging.moesegfault.dev/register
