-- Run after 0002. CHECK failures make migration corruption visible to CI.
-- 在 0002 后运行；任一 CHECK 失败都会让 CI 明确暴露迁移损坏。
CREATE TABLE _0002_assertion (
    assertion TEXT PRIMARY KEY,
    passed INTEGER NOT NULL CHECK (passed = 1)
);

INSERT INTO _0002_assertion VALUES (
    'stable session foreign keys',
    (SELECT
        (SELECT count(*) FROM pragma_foreign_key_list('binding_transactions')
         WHERE "table" = 'identity_sessions') = 1
        AND (SELECT count(*) FROM pragma_foreign_key_list('oauth_authorization_transactions')
             WHERE "table" = 'identity_sessions') = 1
        AND (SELECT count(*) FROM pragma_foreign_key_list('oauth_authorization_codes')
             WHERE "table" = 'identity_sessions') = 1
        AND (SELECT count(*) FROM pragma_foreign_key_list('oauth_refresh_token_families')
             WHERE "table" = 'identity_sessions') = 1)
);

INSERT INTO _0002_assertion VALUES (
    'no temporary schema references',
    (SELECT count(*) = 0 FROM sqlite_schema
     WHERE name <> '_0002_assertion'
       AND (instr(sql, 'identity_sessions_v1') > 0 OR instr(sql, '_0002_') > 0))
);

INSERT INTO _0002_assertion VALUES (
    'foreign key integrity',
    (SELECT count(*) = 0 FROM pragma_foreign_key_check)
);

INSERT INTO _0002_assertion VALUES (
    'dependent rows preserved',
    (SELECT
        (SELECT count(*) FROM identity_sessions) = 2
        AND (SELECT count(*) FROM binding_transactions) = 1
        AND (SELECT count(*) FROM oauth_authorization_transactions) = 1
        AND (SELECT count(*) FROM oauth_authorization_codes) = 1
        AND (SELECT count(*) FROM oauth_refresh_token_families) = 1
        AND (SELECT count(*) FROM oauth_refresh_tokens) = 1
        AND coalesce((SELECT created_from_session_id = 's1' FROM identity_sessions
                      WHERE session_id = 's2'), 0))
);

INSERT INTO _0002_assertion VALUES (
    'behavioral triggers restored',
    (SELECT count(*) = 6 FROM sqlite_schema
     WHERE type = 'trigger' AND name IN (
        'binding_consumption_validate', 'binding_consumption_apply',
        'authorization_code_use_validate', 'authorization_code_use_apply',
        'registration_capability_use_validate', 'registration_capability_use_apply'
     ))
);

DROP TABLE _0002_assertion;
