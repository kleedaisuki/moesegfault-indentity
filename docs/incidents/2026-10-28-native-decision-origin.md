# Native decision confirmation rejected by its referrer policy

## Observation and cause

After the in-app Browser connection was repaired, a real staging recipient could
choose a decision and fill the form, but activating the separate confirmation
button returned `403 origin_rejected`. The decision remained unconsumed. Earlier
HTTP tests explicitly supplied Origin and therefore did not exercise browser
navigation-header generation.

The shared response helper used `Referrer-Policy: no-referrer` to keep bearer
paths out of Referer. The [Fetch Origin-header algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header)
serializes Origin as `null` for a non-CORS, non-GET/HEAD request under that policy.
An ordinary HTML form POST is navigation, not a scripted CORS fetch. Its rejection
was consistent with the application's exact-origin rule; weakening that rule to
accept null would have been the wrong fix.

## Correction and regression boundary

Responses now use `strict-origin`: the browser retains the real HTTPS Origin and
sends only the public origin in Referer, never the capability path or query. Exact
Origin validation, encrypted CSRF proof, Secure/HttpOnly/SameSite cookies, CSP,
single consumption and registered callback authorization remain unchanged.

The hosted Chromium regression first recreates the old policy's native
Origin:null/403/no-consumption result, then verifies the corrected native POST,
real stored CSRF cookie, explicit confirmation, automatic303 completion GET,
exactly one stored submission, and the actual registered callback receiver.
Browser binaries are installed and cached in Actions, not on the local workstation.

Two test-transport assumptions were corrected without dropping assertions:

- Playwright routing only intercepts the first URL of a redirect chain. A virtual
  hostname plus route fulfillment did not establish a real automatic303 follow-up.
  The test now uses an actual loopback HTTPS listener and isolated generated
  certificate; certificate-error tolerance is confined to that synthetic CI
  context, not the user's browser or production.
- Miniflare `getWorker().fetch` traverses its protected management proxy. It can
  reject an opaque Origin before application code. Browser traffic now uses
  public dispatch, while private test control remains on its named binding.
  The SDK Fetch Metadata envelope preserves the observed navigation mode through
  Undici. A pre-browser ingress probe requires the application's problem media
  type and `origin_rejected` code, not merely an arbitrary403.

Native Origin/Cookie values are not fabricated. Diagnostics expose route classes,
HTTP/MIME outcomes and bounded redacted errors, not capability URLs or cookies.

## Hosted and actual-browser evidence

- [Source/native/package gates 40699297824](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40699297824)
  and [exact-candidate staging 40699288940](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40699288940)
  passed for `326ddb1`.
- The authorized sandbox [experiment 40699434872](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40699434872)
  deployed only the two staging TypeScript Workers and read back strict-origin.
  Its temporary workflow branch was not merged into product source; production
  quality gates were not bypassed.
- In-app Browser actions selected `approve`, filled `staging-ok`, separately
  activated confirmation, and reached the Chinese submitted page through the real
  redirect. [Mailbox/browser/callback run 40699666946](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40699666946)
  confirmed the durable registered-service receipt. The observed decision ID was
  `a18a15ac-5e5e-4f4c-be42-fcb60c7fa0c2`; its bearer URL is intentionally omitted.
- [PR28](https://github.com/kleedaisuki/moesegfault-indentity/pull/28) merged the
  reviewed correction, and [production run 40702620948](https://github.com/kleedaisuki/moesegfault-indentity/actions/runs/40702620948)
  passed the normal immutable-bundle staging/production path. Independent public
  health readback observed strict-origin in production.

The reproduced request used a disposable staging decision. No production account
or credential mutation was used for this investigation.

## Related asynchronous-lifetime correction

The test invitation's thirty-minute deadline also exposed an inappropriate user
assumption: asynchronous recipients must not be required to watch their inbox.
The user chose a seven-day default with explicit longer business deadlines.
[PR29](https://github.com/kleedaisuki/moesegfault-indentity/pull/29) separates that
business deadline from bounded mail delivery and CI observation, freezes new
outgoing invitation JSON, preserves legacy serialization, and retains the private
callback consumer when its public test driver is disabled. See ADR-0007 and the
service READMEs for the resulting contract and coordinated downgrade boundary.
