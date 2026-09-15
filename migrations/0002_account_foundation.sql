-- Rich account and multi-method authentication foundation.
-- 丰富账户资料与多认证方式基础。This migration intentionally replaces the narrow
-- username-only identifier shape while preserving existing username rows.
-- 本迁移有意替换仅用户名的标识符结构，并保留已有用户名记录。

-- D1 keeps foreign-key enforcement enabled while applying migrations. Stage plain data
-- backups, remove the dependency graph from leaves to root, and rebuild it from root to
-- leaves. This keeps every statement valid and, unlike ALTER TABLE RENAME, never rewrites
-- a child reference to a temporary table name.
-- D1 在迁移期间始终启用外键。先暂存无约束数据，从叶到根移除依赖图，再从根到叶重建；
-- 每条语句均保持有效，且不会像 ALTER TABLE RENAME 那样把子引用改写为临时表名。

CREATE TABLE _0002_identity_sessions_backup AS SELECT * FROM identity_sessions;
CREATE TABLE _0002_binding_transactions_backup AS SELECT * FROM binding_transactions;
CREATE TABLE _0002_oauth_authorization_transactions_backup AS SELECT * FROM oauth_authorization_transactions;
CREATE TABLE _0002_oauth_authorization_codes_backup AS SELECT * FROM oauth_authorization_codes;
CREATE TABLE _0002_oauth_refresh_token_families_backup AS SELECT * FROM oauth_refresh_token_families;
CREATE TABLE _0002_binding_transaction_consumptions_backup AS SELECT * FROM binding_transaction_consumptions;
CREATE TABLE _0002_webauthn_authorization_links_backup AS SELECT * FROM webauthn_authorization_links;
CREATE TABLE _0002_oauth_authorization_code_uses_backup AS SELECT * FROM oauth_authorization_code_uses;
CREATE TABLE _0002_oauth_refresh_tokens_backup AS SELECT * FROM oauth_refresh_tokens;

-- Break only the live self-reference before DROP; the backup retains and restores it.
-- DROP 前仅断开当前表的自引用；备份仍完整保留并恢复该关系。
UPDATE identity_sessions
SET created_from_session_id = NULL
WHERE created_from_session_id IS NOT NULL;

-- Rotated refresh tokens also form a self-referencing chain. Move only the disposable
-- live copy to a constraint-valid terminal state; backup rows remain authoritative.
-- 已轮换刷新令牌同样形成自引用链；仅把即将删除的当前副本转为合法终态，备份仍为权威数据。
UPDATE oauth_refresh_tokens
SET state = 'revoked', replacement_token_id = NULL
WHERE replacement_token_id IS NOT NULL;

DROP TABLE binding_transaction_consumptions;
DROP TABLE webauthn_authorization_links;
DROP TABLE oauth_authorization_code_uses;
DROP TABLE oauth_refresh_tokens;
DROP TABLE binding_transactions;
DROP TABLE oauth_authorization_codes;
DROP TABLE oauth_authorization_transactions;
DROP TABLE oauth_refresh_token_families;
DROP TABLE identity_sessions;

CREATE TABLE identity_sessions (
    session_id TEXT PRIMARY KEY,
    session_digest BLOB NOT NULL UNIQUE CHECK (length(session_digest) = 32),
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    authenticator_id TEXT REFERENCES authenticators(authenticator_id) ON DELETE RESTRICT,
    binding_id TEXT REFERENCES identity_bindings(binding_id) ON DELETE RESTRICT,
    auth_method TEXT NOT NULL CHECK (auth_method IN ('password', 'passkey', 'federated')),
    amr_json TEXT NOT NULL CHECK (json_valid(amr_json)),
    acr TEXT NOT NULL CHECK (length(acr) BETWEEN 1 AND 255),
    authenticated_at INTEGER NOT NULL CHECK (authenticated_at > 0),
    last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= authenticated_at),
    idle_expires_at INTEGER NOT NULL CHECK (idle_expires_at > last_seen_at),
    absolute_expires_at INTEGER NOT NULL CHECK (absolute_expires_at >= idle_expires_at),
    revoked_at INTEGER,
    revocation_reason TEXT,
    created_from_session_id TEXT REFERENCES identity_sessions(session_id) ON DELETE RESTRICT,
    CHECK ((auth_method = 'password' AND authenticator_id IS NULL AND binding_id IS NULL)
        OR (auth_method = 'passkey' AND authenticator_id IS NOT NULL AND binding_id IS NULL)
        OR (auth_method = 'federated' AND binding_id IS NOT NULL AND authenticator_id IS NULL)),
    CHECK ((revoked_at IS NULL AND revocation_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);

CREATE TABLE binding_transactions (
    transaction_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    provider_id TEXT NOT NULL REFERENCES binding_providers(provider_id) ON DELETE RESTRICT,
    identity_session_id TEXT NOT NULL REFERENCES identity_sessions(session_id) ON DELETE RESTRICT,
    provider_state_digest BLOB NOT NULL UNIQUE CHECK (length(provider_state_digest) = 32),
    pkce_verifier_ciphertext BLOB NOT NULL CHECK (length(pkce_verifier_ciphertext) BETWEEN 32 AND 512),
    pkce_verifier_nonce BLOB NOT NULL CHECK (length(pkce_verifier_nonce) IN (12, 24)),
    pkce_key_revision INTEGER NOT NULL CHECK (pkce_key_revision > 0),
    csrf_digest BLOB NOT NULL CHECK (length(csrf_digest) = 32),
    -- The Worker derives this callback from its reviewed canonical issuer; the database
    -- enforces transport/fragment shape without hard-coding one deployment hostname.
    -- Worker 从经评审的规范 issuer 派生回调；数据库只约束传输与 fragment 形状，
    -- 避免把 production hostname 写死后令 staging 无法使用同一 schema。
    redirect_uri TEXT NOT NULL CHECK (
        redirect_uri LIKE 'https://%'
        AND instr(redirect_uri, '#') = 0
    ),
    policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'consumed_success', 'consumed_failure', 'cancelled')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    consumed_at INTEGER,
    result_binding_id TEXT REFERENCES identity_bindings(binding_id) ON DELETE RESTRICT,
    CHECK ((state = 'pending' AND consumed_at IS NULL AND result_binding_id IS NULL)
        OR (state = 'consumed_success' AND consumed_at IS NOT NULL AND result_binding_id IS NOT NULL)
        OR (state IN ('consumed_failure', 'cancelled') AND consumed_at IS NOT NULL AND result_binding_id IS NULL))
);

CREATE TABLE oauth_authorization_transactions (
    authorization_transaction_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),
    response_type TEXT NOT NULL CHECK (response_type = 'code'),
    scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 1024),
    state_value TEXT NOT NULL CHECK (length(state_value) BETWEEN 1 AND 1024),
    nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 8 AND 1024),
    code_challenge TEXT NOT NULL CHECK (length(code_challenge) = 43),
    code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
    principal_id TEXT REFERENCES principals(principal_id) ON DELETE RESTRICT,
    identity_session_id TEXT REFERENCES identity_sessions(session_id) ON DELETE RESTRICT,
    state TEXT NOT NULL DEFAULT 'awaiting_authentication'
        CHECK (state IN ('awaiting_authentication', 'authenticated', 'completed', 'denied', 'expired')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    consumed_at INTEGER,
    CHECK ((state IN ('awaiting_authentication', 'authenticated') AND consumed_at IS NULL)
        OR (state IN ('completed', 'denied', 'expired') AND consumed_at IS NOT NULL)),
    CHECK ((state = 'awaiting_authentication' AND principal_id IS NULL AND identity_session_id IS NULL)
        OR state <> 'awaiting_authentication')
);

CREATE TABLE oauth_authorization_codes (
    authorization_code_id TEXT PRIMARY KEY,
    code_digest BLOB NOT NULL UNIQUE CHECK (length(code_digest) = 32),
    authorization_transaction_id TEXT NOT NULL UNIQUE
        REFERENCES oauth_authorization_transactions(authorization_transaction_id) ON DELETE RESTRICT,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    identity_session_id TEXT NOT NULL REFERENCES identity_sessions(session_id) ON DELETE RESTRICT,
    redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),
    scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 1024),
    nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 8 AND 1024),
    code_challenge TEXT NOT NULL CHECK (length(code_challenge) = 43),
    code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
    issued_at INTEGER NOT NULL CHECK (issued_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
    consumed_at INTEGER,
    revoked_at INTEGER,
    CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE TABLE oauth_refresh_token_families (
    refresh_token_family_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    identity_session_id TEXT NOT NULL REFERENCES identity_sessions(session_id) ON DELETE RESTRICT,
    scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 1024),
    audience TEXT NOT NULL CHECK (length(audience) BETWEEN 1 AND 255),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    absolute_expires_at INTEGER NOT NULL CHECK (absolute_expires_at > created_at),
    revoked_at INTEGER,
    revocation_reason TEXT,
    reuse_detected_at INTEGER,
    CHECK ((revoked_at IS NULL AND revocation_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)),
    CHECK (reuse_detected_at IS NULL OR revoked_at IS NOT NULL)
);

CREATE TABLE binding_transaction_consumptions (
    transaction_id TEXT PRIMARY KEY REFERENCES binding_transactions(transaction_id) ON DELETE RESTRICT,
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
    result_binding_id TEXT REFERENCES identity_bindings(binding_id) ON DELETE RESTRICT,
    consumed_at INTEGER NOT NULL CHECK (consumed_at > 0),
    CHECK ((outcome = 'success' AND result_binding_id IS NOT NULL)
        OR (outcome <> 'success' AND result_binding_id IS NULL))
) WITHOUT ROWID;

CREATE TABLE webauthn_authorization_links (
    webauthn_transaction_id TEXT PRIMARY KEY
        REFERENCES webauthn_transactions(transaction_id) ON DELETE RESTRICT,
    authorization_transaction_id TEXT NOT NULL UNIQUE
        REFERENCES oauth_authorization_transactions(authorization_transaction_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE oauth_authorization_code_uses (
    authorization_code_id TEXT PRIMARY KEY
        REFERENCES oauth_authorization_codes(authorization_code_id) ON DELETE RESTRICT,
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    used_at INTEGER NOT NULL CHECK (used_at > 0)
) WITHOUT ROWID;

CREATE TABLE oauth_refresh_tokens (
    refresh_token_id TEXT PRIMARY KEY,
    refresh_token_family_id TEXT NOT NULL
        REFERENCES oauth_refresh_token_families(refresh_token_family_id) ON DELETE RESTRICT,
    token_digest BLOB NOT NULL UNIQUE CHECK (length(token_digest) = 32),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    issued_at INTEGER NOT NULL CHECK (issued_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'rotated', 'revoked')),
    consumed_at INTEGER,
    replacement_token_id TEXT REFERENCES oauth_refresh_tokens(refresh_token_id) ON DELETE RESTRICT,
    CHECK ((state = 'active' AND consumed_at IS NULL AND replacement_token_id IS NULL)
        OR (state = 'rotated' AND consumed_at IS NOT NULL AND replacement_token_id IS NOT NULL)
        OR (state = 'revoked' AND replacement_token_id IS NULL)),
    UNIQUE(refresh_token_family_id, generation)
);

INSERT INTO identity_sessions SELECT * FROM _0002_identity_sessions_backup;
INSERT INTO binding_transactions SELECT * FROM _0002_binding_transactions_backup;
INSERT INTO oauth_authorization_transactions SELECT * FROM _0002_oauth_authorization_transactions_backup;
INSERT INTO oauth_authorization_codes SELECT * FROM _0002_oauth_authorization_codes_backup;
INSERT INTO oauth_refresh_token_families SELECT * FROM _0002_oauth_refresh_token_families_backup;
INSERT INTO binding_transaction_consumptions SELECT * FROM _0002_binding_transaction_consumptions_backup;
INSERT INTO webauthn_authorization_links SELECT * FROM _0002_webauthn_authorization_links_backup;
INSERT INTO oauth_authorization_code_uses SELECT * FROM _0002_oauth_authorization_code_uses_backup;
INSERT INTO oauth_refresh_tokens SELECT * FROM _0002_oauth_refresh_tokens_backup;

DROP TABLE _0002_oauth_refresh_tokens_backup;
DROP TABLE _0002_oauth_authorization_code_uses_backup;
DROP TABLE _0002_webauthn_authorization_links_backup;
DROP TABLE _0002_binding_transaction_consumptions_backup;
DROP TABLE _0002_oauth_refresh_token_families_backup;
DROP TABLE _0002_oauth_authorization_codes_backup;
DROP TABLE _0002_oauth_authorization_transactions_backup;
DROP TABLE _0002_binding_transactions_backup;
DROP TABLE _0002_identity_sessions_backup;

CREATE INDEX idx_identity_sessions_principal_active
    ON identity_sessions(principal_id, revoked_at, absolute_expires_at);
CREATE INDEX idx_identity_sessions_authenticator
    ON identity_sessions(authenticator_id, revoked_at);
CREATE INDEX idx_identity_sessions_binding
    ON identity_sessions(binding_id, revoked_at);
CREATE INDEX idx_binding_transactions_expiry
    ON binding_transactions(state, expires_at);
CREATE INDEX idx_binding_transactions_principal
    ON binding_transactions(principal_id, state, created_at);
CREATE INDEX idx_oauth_authorization_transactions_expiry
    ON oauth_authorization_transactions(state, expires_at);
CREATE INDEX idx_oauth_authorization_transactions_session
    ON oauth_authorization_transactions(identity_session_id, state);
CREATE INDEX idx_oauth_authorization_codes_active
    ON oauth_authorization_codes(client_id, expires_at, consumed_at, revoked_at);
CREATE INDEX idx_oauth_authorization_codes_principal
    ON oauth_authorization_codes(principal_id, consumed_at, revoked_at);
CREATE INDEX idx_refresh_token_families_principal_active
    ON oauth_refresh_token_families(principal_id, revoked_at, absolute_expires_at);
CREATE INDEX idx_refresh_token_families_session
    ON oauth_refresh_token_families(identity_session_id, revoked_at);
CREATE UNIQUE INDEX idx_refresh_tokens_one_active_per_family
    ON oauth_refresh_tokens(refresh_token_family_id) WHERE state = 'active';
CREATE INDEX idx_refresh_tokens_expiry ON oauth_refresh_tokens(state, expires_at);

CREATE TRIGGER binding_consumption_validate
BEFORE INSERT ON binding_transaction_consumptions
WHEN NOT EXISTS (
    SELECT 1 FROM binding_transactions
    WHERE transaction_id = NEW.transaction_id
      AND state = 'pending'
      AND expires_at >= unixepoch()
)
BEGIN
    SELECT RAISE(ABORT, 'binding_transaction_not_consumable');
END;

CREATE TRIGGER binding_consumption_apply
AFTER INSERT ON binding_transaction_consumptions
BEGIN
    UPDATE binding_transactions
    SET state = CASE NEW.outcome
            WHEN 'success' THEN 'consumed_success'
            WHEN 'failure' THEN 'consumed_failure'
            ELSE 'cancelled'
        END,
        consumed_at = NEW.consumed_at,
        result_binding_id = NEW.result_binding_id
    WHERE transaction_id = NEW.transaction_id;
END;

CREATE TRIGGER authorization_code_use_validate
BEFORE INSERT ON oauth_authorization_code_uses
WHEN NOT EXISTS (
    SELECT 1 FROM oauth_authorization_codes
    WHERE authorization_code_id = NEW.authorization_code_id
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at >= unixepoch()
)
BEGIN
    SELECT RAISE(ABORT, 'authorization_code_not_consumable');
END;

CREATE TRIGGER authorization_code_use_apply
AFTER INSERT ON oauth_authorization_code_uses
BEGIN
    UPDATE oauth_authorization_codes SET consumed_at = NEW.used_at
    WHERE authorization_code_id = NEW.authorization_code_id;
END;

-- One identifier model avoids separate, eventually-inconsistent email and phone tables.
-- 单一标识符模型避免邮箱与手机表最终不一致。normalized_value is the lookup key;
-- value is the user-facing spelling. Mobile identifiers use E.164 in both fields.
-- normalized_value 是查询键；value 保留用户可见写法；手机号统一使用 E.164。
CREATE TABLE identifiers_v2 (
    identifier_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('username', 'email', 'mobile')),
    value TEXT NOT NULL CHECK (length(value) BETWEEN 3 AND 320),
    normalized_value TEXT NOT NULL CHECK (length(normalized_value) BETWEEN 3 AND 320),
    country_calling_code TEXT,
    national_number TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    -- Username writers inherit verified; contact writers must explicitly request unverified.
    -- 用户名写入默认已验证；联系方式写入必须显式指定未验证。
    verification_state TEXT NOT NULL DEFAULT 'verified'
        CHECK (verification_state IN ('unverified', 'pending', 'verified')),
    verified_at INTEGER DEFAULT (unixepoch()),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    UNIQUE(kind, normalized_value),
    CHECK (
        (kind = 'username'
            AND country_calling_code IS NULL AND national_number IS NULL
            AND verification_state = 'verified' AND verified_at IS NOT NULL)
        OR (kind = 'email'
            AND country_calling_code IS NULL AND national_number IS NULL)
        OR (kind = 'mobile'
            AND country_calling_code GLOB '+[1-9]*'
            AND country_calling_code NOT GLOB '*[^+0-9]*'
            AND length(country_calling_code) BETWEEN 2 AND 4
            AND national_number NOT GLOB '*[^0-9]*'
            AND length(national_number) BETWEEN 4 AND 14
            AND normalized_value = country_calling_code || national_number)
    ),
    CHECK ((verification_state = 'verified' AND verified_at IS NOT NULL)
        OR (verification_state <> 'verified' AND verified_at IS NULL))
);

INSERT INTO identifiers_v2 (
    identifier_id, principal_id, kind, value, normalized_value, is_primary,
    verification_state, verified_at, created_at, updated_at
)
SELECT identifier_id, principal_id, kind, value, normalized_value, 1,
       'verified', created_at, created_at, updated_at
FROM identifiers;

DROP TABLE identifiers;
ALTER TABLE identifiers_v2 RENAME TO identifiers;

CREATE INDEX idx_identifiers_principal
    ON identifiers(principal_id, kind, created_at);
CREATE UNIQUE INDEX idx_identifiers_primary_kind
    ON identifiers(principal_id, kind) WHERE is_primary = 1;
CREATE UNIQUE INDEX idx_identifiers_one_username
    ON identifiers(principal_id) WHERE kind = 'username';

-- Out-of-band contact verification state stores only a digest of the presented code.
-- 带外联系方式验证只存储用户提交验证码的摘要。
CREATE TABLE identifier_verification_transactions (
    transaction_id TEXT PRIMARY KEY,
    identifier_id TEXT NOT NULL REFERENCES identifiers(identifier_id) ON DELETE RESTRICT,
    code_digest BLOB NOT NULL CHECK (length(code_digest) = 32),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'verified', 'expired', 'cancelled', 'locked')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    consumed_at INTEGER,
    CHECK ((state = 'pending' AND consumed_at IS NULL)
        OR (state <> 'pending' AND consumed_at IS NOT NULL))
);

CREATE INDEX idx_identifier_verifications_pending
    ON identifier_verification_transactions(identifier_id, state, expires_at);

-- Passwords are optional and coexist with passkeys and federation. password_hash is a
-- complete PHC string so algorithm upgrades do not require schema changes.
-- 密码是可选认证方式，可与通行密钥和联合登录共存；password_hash 使用完整 PHC 字符串。
CREATE TABLE password_credentials (
    principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id) ON DELETE RESTRICT,
    password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 32 AND 1024),
    hash_algorithm TEXT NOT NULL DEFAULT 'argon2id'
        CHECK (hash_algorithm IN ('argon2id', 'scrypt', 'bcrypt', 'pbkdf2-sha256')),
    hash_parameters_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(hash_parameters_json)),
    password_version INTEGER NOT NULL DEFAULT 1 CHECK (password_version > 0),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    last_used_at INTEGER,
    CHECK (last_used_at IS NULL OR last_used_at >= created_at)
);

-- A durable password-registration transaction gives invite consumption the same atomic,
-- replay-safe shape as WebAuthn registration.
-- 持久化密码注册事务，使邀请码消费与 WebAuthn 注册拥有相同的原子、防重放形态。
CREATE TABLE password_registration_transactions (
    transaction_id TEXT PRIMARY KEY,
    registration_capability_id TEXT REFERENCES registration_capabilities(capability_id) ON DELETE RESTRICT,
    request_digest BLOB NOT NULL UNIQUE CHECK (length(request_digest) = 32),
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'consumed_success', 'consumed_failure')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    consumed_at INTEGER,
    result_principal_id TEXT REFERENCES principals(principal_id) ON DELETE RESTRICT,
    CHECK ((state = 'pending' AND consumed_at IS NULL AND result_principal_id IS NULL)
        OR (state = 'consumed_success' AND consumed_at IS NOT NULL AND result_principal_id IS NOT NULL)
        OR (state = 'consumed_failure' AND consumed_at IS NOT NULL AND result_principal_id IS NULL))
);

CREATE INDEX idx_password_registration_transactions_expiry
    ON password_registration_transactions(state, expires_at);

-- Generalize the one-time invite claim so password and passkey registration share one path.
-- 泛化一次性邀请码声明，使密码与通行密钥注册共享同一路径。
ALTER TABLE registration_capability_uses RENAME TO registration_capability_uses_v1;

CREATE TABLE registration_capability_uses (
    capability_id TEXT PRIMARY KEY REFERENCES registration_capabilities(capability_id) ON DELETE RESTRICT,
    webauthn_transaction_id TEXT UNIQUE REFERENCES webauthn_transactions(transaction_id) ON DELETE RESTRICT,
    password_registration_id TEXT UNIQUE
        REFERENCES password_registration_transactions(transaction_id) ON DELETE RESTRICT,
    consumed_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    used_at INTEGER NOT NULL CHECK (used_at > 0),
    CHECK ((webauthn_transaction_id IS NOT NULL) <> (password_registration_id IS NOT NULL))
) WITHOUT ROWID;

INSERT INTO registration_capability_uses (
    capability_id, webauthn_transaction_id, consumed_by_principal_id, request_digest, used_at
)
SELECT capability_id, webauthn_transaction_id, consumed_by_principal_id, request_digest, used_at
FROM registration_capability_uses_v1;

DROP TABLE registration_capability_uses_v1;

CREATE TRIGGER registration_capability_use_validate
BEFORE INSERT ON registration_capability_uses
WHEN NOT EXISTS (
    SELECT 1 FROM registration_capabilities
    WHERE capability_id = NEW.capability_id
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at >= unixepoch()
)
BEGIN
    SELECT RAISE(ABORT, 'registration_capability_not_consumable');
END;

CREATE TRIGGER registration_capability_use_apply
AFTER INSERT ON registration_capability_uses
BEGIN
    UPDATE registration_capabilities
    SET consumed_at = NEW.used_at,
        consumed_by_principal_id = NEW.consumed_by_principal_id
    WHERE capability_id = NEW.capability_id;
END;

-- Profile fields are intentionally social and playful without becoming authentication data.
-- 资料字段服务同好社交趣味，但绝不作为认证数据。
CREATE TABLE account_profile_details (
    principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id) ON DELETE RESTRICT,
    bio TEXT CHECK (bio IS NULL OR length(bio) <= 500),
    status_message TEXT CHECK (status_message IS NULL OR length(status_message) <= 100),
    pronouns TEXT CHECK (pronouns IS NULL OR length(pronouns) <= 40),
    favorite_character TEXT CHECK (favorite_character IS NULL OR length(favorite_character) <= 100),
    interests_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(interests_json)),
    links_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links_json)),
    profile_visibility TEXT NOT NULL DEFAULT 'members'
        CHECK (profile_visibility IN ('private', 'members', 'public')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

-- Avatar objects are immutable uploads; one partial unique index selects the current avatar.
-- 头像对象按不可变上传处理；局部唯一索引选定当前头像。
CREATE TABLE avatar_assets (
    avatar_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    r2_key TEXT NOT NULL UNIQUE CHECK (length(r2_key) BETWEEN 1 AND 1024),
    media_type TEXT NOT NULL CHECK (media_type IN ('image/avif', 'image/jpeg', 'image/png', 'image/webp')),
    byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
    width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8192),
    height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8192),
    content_digest BLOB NOT NULL CHECK (length(content_digest) = 32),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'rejected', 'deleted')),
    is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    CHECK (is_current = 0 OR state = 'ready')
);

CREATE INDEX idx_avatar_assets_principal ON avatar_assets(principal_id, state, created_at);
CREATE UNIQUE INDEX idx_avatar_assets_current
    ON avatar_assets(principal_id) WHERE is_current = 1;

-- Preferences belong to account.moesegfault.dev, not the login ceremony.
-- 偏好设置属于 account.moesegfault.dev，而不是登录仪式。
CREATE TABLE account_preferences (
    principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id) ON DELETE RESTRICT,
    locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (length(locale) BETWEEN 2 AND 35),
    theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai' CHECK (length(timezone) BETWEEN 1 AND 64),
    reduced_motion INTEGER NOT NULL DEFAULT 0 CHECK (reduced_motion IN (0, 1)),
    compact_mode INTEGER NOT NULL DEFAULT 0 CHECK (compact_mode IN (0, 1)),
    notification_preferences_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(notification_preferences_json)),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

-- Generic MFA records support TOTP now and future platform/third-party methods. Secret
-- material is encrypted outside D1; only ciphertext and a key revision are persisted.
-- 通用多因素认证记录支持 TOTP 及未来平台/第三方方式；密钥材料加密后才写入 D1。
CREATE TABLE mfa_methods (
    mfa_method_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('totp', 'passkey', 'push', 'hardware_otp')),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'revoked')),
    secret_ciphertext BLOB,
    secret_nonce BLOB,
    key_revision INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    activated_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER,
    CHECK ((kind = 'totp' AND secret_ciphertext IS NOT NULL
            AND secret_nonce IS NOT NULL AND key_revision IS NOT NULL)
        OR (kind <> 'totp' AND secret_ciphertext IS NULL
            AND secret_nonce IS NULL AND key_revision IS NULL)),
    CHECK ((state = 'pending' AND activated_at IS NULL AND revoked_at IS NULL)
        OR (state = 'active' AND activated_at IS NOT NULL AND revoked_at IS NULL)
        OR (state = 'revoked' AND revoked_at IS NOT NULL))
);

CREATE INDEX idx_mfa_methods_principal_active
    ON mfa_methods(principal_id, state, created_at);

-- Attach an ordered set of authentication methods to a session. This is the extensible
-- source for AMR/AAL; legacy identity_sessions.auth_method remains for old session writers.
-- 将有序认证方式集合绑定到会话，作为 AMR/AAL 的可扩展来源。
CREATE TABLE session_authentication_methods (
    session_id TEXT NOT NULL REFERENCES identity_sessions(session_id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 16),
    method TEXT NOT NULL CHECK (method IN (
        'password', 'passkey', 'federated', 'totp', 'recovery_code', 'hardware_otp', 'push'
    )),
    mfa_method_id TEXT REFERENCES mfa_methods(mfa_method_id) ON DELETE RESTRICT,
    authenticated_at INTEGER NOT NULL CHECK (authenticated_at > 0),
    PRIMARY KEY (session_id, sequence),
    UNIQUE(session_id, method, mfa_method_id)
) WITHOUT ROWID;

-- Deployment-reviewed presentation metadata is kept apart from OAuth protocol state.
-- 经部署审核的展示元数据与 OAuth 协议状态分离。
CREATE TABLE oauth_client_presentation (
    client_id TEXT PRIMARY KEY REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    logo_url TEXT CHECK (logo_url IS NULL OR logo_url LIKE 'https://%'),
    homepage_url TEXT CHECK (homepage_url IS NULL OR homepage_url LIKE 'https://%'),
    privacy_policy_url TEXT CHECK (privacy_policy_url IS NULL OR privacy_policy_url LIKE 'https://%'),
    updated_at INTEGER NOT NULL CHECK (updated_at > 0)
);

-- Durable user grants make connected-app management explicit. Token families are
-- issuance artifacts, not a substitute for the user's authorization decision.
-- 持久化用户授权使已连接应用可显式管理；令牌族是签发产物，不能替代用户授权决定。
CREATE TABLE oauth_user_authorizations (
    authorization_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
    granted_at INTEGER NOT NULL CHECK (granted_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= granted_at),
    last_used_at INTEGER,
    revoked_at INTEGER,
    revocation_reason TEXT,
    CHECK (last_used_at IS NULL OR last_used_at >= granted_at),
    CHECK ((revoked_at IS NULL AND revocation_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);

CREATE UNIQUE INDEX idx_oauth_user_authorizations_active
    ON oauth_user_authorizations(principal_id, client_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_oauth_user_authorizations_principal
    ON oauth_user_authorizations(principal_id, revoked_at, last_used_at);

-- Standard OIDC contact scopes become available to deployment-managed clients.
-- 标准 OIDC 联系方式 scope 可供部署管理的客户端按需授权。
INSERT INTO oauth_scopes(scope, description, audience, is_oidc, created_at) VALUES
    ('email', 'Read primary email claims / 读取主邮箱声明', 'identity', 1, unixepoch()),
    ('phone', 'Read primary mobile claims / 读取主手机号声明', 'identity', 1, unixepoch());
