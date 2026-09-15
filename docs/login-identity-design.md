# Login / Account / Identity design

This former passkey-only two-surface design has been superseded in full by
[`ADR-0003`](adr/0003-account-platform-redesign.md). It is intentionally not retained as
a second normative specification because conflicting authentication and ownership rules are
worse than a short redirect.

The current normative boundaries are:

```text
login.moesegfault.dev   = registration, authentication, recovery, authorization UX
account.moesegfault.dev = profile, contacts, credentials, sessions, grants, preferences UX
identity.moesegfault.dev = identity authority and OAuth/OIDC protocol service
```

`openapi/identity.yaml` remains the canonical machine-readable HTTP contract. Database history
is expressed by the ordered migrations. Operational behavior and service-level objectives are
defined in `infra/RUNBOOK.md`.
