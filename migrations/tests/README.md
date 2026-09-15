# Populated migration regression

The `0002` regression must be exercised against a fresh isolated local D1 in this order:

1. execute `../0001_identity_foundation.sql`;
2. execute `0002_populated_seed.sql`;
3. execute `../0002_account_foundation.sql`;
4. execute `0002_populated_assert.sql`.

The seed covers the complete foreign-key dependency graph rooted at
`identity_sessions`. The assertion file fails through SQL `CHECK` constraints if data is
lost, a foreign key targets a temporary table, or `foreign_key_check` reports a violation.

`0003_open_registration.sql` is independent and is applied after this regression sequence.
