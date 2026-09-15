-- Rich account and multi-method authentication foundation.
-- 丰富账户资料与多认证方式基础。This migration intentionally replaces the narrow
-- username-only identifier shape while preserving existing username rows.
-- 本迁移有意替换仅用户名的标识符结构，并保留已有用户名记录。

PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

-- Password becomes a first-class session method. Rebuilding the parent table in this
-- forward migration removes the v1 CHECK constraint without changing its public keys.
-- 密码成为一等会话认证方式；本向前迁移重建父表以移除 v1 CHECK 限制，同时保持公开键不变。
ALTER TABLE identity_sessions RENAME TO identity_sessions_v1;

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

INSERT INTO identity_sessions SELECT * FROM identity_sessions_v1;
DROP TABLE identity_sessions_v1;

CREATE INDEX idx_identity_sessions_principal_active
    ON identity_sessions(principal_id, revoked_at, absolute_expires_at);
CREATE INDEX idx_identity_sessions_authenticator
    ON identity_sessions(authenticator_id, revoked_at);
CREATE INDEX idx_identity_sessions_binding
    ON identity_sessions(binding_id, revoked_at);

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

PRAGMA foreign_keys = ON;
