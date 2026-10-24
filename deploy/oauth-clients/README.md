# Agents staging client registration

The user explicitly authorized registering Agents staging clients and joining the staging Subscribe Billing subject sector on 2026-10-23. Both `adash-staging.moesegfault.dev` and `subscribe-staging.moesegfault.dev` are controlled by the same deployment owner. This deliberately allows Billing to identify the same account across Subscribe, the Agents BFF, and magents. It must not be reused for an unrelated application or production.

The generic client generator rejects confidential redirect hosts different from their subject sector because it cannot prove cross-host ownership. Its validation and all runtime authentication logic remain unchanged. For migration 0013, all fields were validated using the official generator with the dashboard's own host sector; the single sector literal in the resulting create-only SQL was then reviewed and changed to the authorized shared staging sector. The final public manifest records the deployed shared sector. Migration 0012 uses the generator without modification.

Only staging environment overlays are added. These migrations create new clients, redirects, scopes, public keys, and audit events; they never update existing clients or pairwise subjects. The browser callback remains exact. The native callback supports arbitrary loopback ports only. Private keys are not in this repository.

## Prepared production Agents registration (not applied)

The existing user authorization covers adding the production Agents clients after the Agents staging acceptance gate. Production manifests and create-only overlays 0014/0015 are prepared for that gate, not evidence of applied D1 state. The public dashboard key is independent from staging. Neither production private JWKs nor application encryption keys are present here.

The dashboard uses the same reviewed shared-sector ownership exception as staging: adash.moesegfault.dev and subscribe.moesegfault.dev have the same deployment owner, and sharing the Subscribe billing account is explicit. All remaining fields are validated by the unchanged official generator; only the unique generated client sector literal is changed to the authorized shared sector. Runtime authentication and the generic generator guard are unchanged. New production rows do not mutate existing Subscribe registration or pairwise subjects.
