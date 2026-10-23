# Agents staging client registration

The user explicitly authorized registering Agents staging clients and joining the staging Subscribe Billing subject sector on 2026-10-23. Both `adash-staging.moesegfault.dev` and `subscribe-staging.moesegfault.dev` are controlled by the same deployment owner. This deliberately allows Billing to identify the same account across Subscribe, the Agents BFF, and magents. It must not be reused for an unrelated application or production.

The generic client generator rejects confidential redirect hosts different from their subject sector because it cannot prove cross-host ownership. Its validation and all runtime authentication logic remain unchanged. For migration 0013, all fields were validated using the official generator with the dashboard's own host sector; the single sector literal in the resulting create-only SQL was then reviewed and changed to the authorized shared staging sector. The final public manifest records the deployed shared sector. Migration 0012 uses the generator without modification.

Only staging environment overlays are added. These migrations create new clients, redirects, scopes, public keys, and audit events; they never update existing clients or pairwise subjects. The browser callback remains exact. The native callback supports arbitrary loopback ports only. Private keys are not in this repository.
