-- moeSegFault Identity initial schema / moeSegFault Identity 初始模式
-- Forward-only Cloudflare D1 migration. Timestamps are Unix seconds in UTC.
-- Cloudflare D1 只向前迁移；所有时间戳均为 UTC Unix 秒。

PRAGMA foreign_keys = ON;

-- Stable principals; deletion is a lifecycle state, not a physical DELETE.
-- 稳定主体；删除是生命周期状态，不是物理 DELETE。
CREATE TABLE principals (
    principal_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'workload')),
    lifecycle_state TEXT NOT NULL DEFAULT 'active'
        CHECK (lifecycle_state IN ('active', 'suspended', 'pending_deletion', 'deleted')),
    webauthn_user_handle BLOB UNIQUE,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    state_changed_at INTEGER NOT NULL CHECK (state_changed_at >= created_at),
    deleted_at INTEGER,
    CHECK ((kind = 'human' AND webauthn_user_handle IS NOT NULL)
        OR (kind = 'workload' AND webauthn_user_handle IS NULL)),
    CHECK ((lifecycle_state = 'deleted' AND deleted_at IS NOT NULL)
        OR (lifecycle_state <> 'deleted' AND deleted_at IS NULL))
);

CREATE INDEX idx_principals_state ON principals(lifecycle_state, principal_id);

-- Human-only display profile; it is not an authentication identifier.
-- 仅人类主体的展示资料；不是认证标识符。
CREATE TABLE human_profiles (
    principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id) ON DELETE RESTRICT,
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
    avatar_r2_key TEXT,
    locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (length(locale) BETWEEN 2 AND 35),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

-- First release supports username only; normalized_value is authoritative for conflicts.
-- 首版仅支持 username；normalized_value 是唯一性冲突的权威值。
CREATE TABLE identifiers (
    identifier_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind = 'username'),
    value TEXT NOT NULL CHECK (length(value) BETWEEN 3 AND 32),
    normalized_value TEXT NOT NULL
        CHECK (length(normalized_value) BETWEEN 3 AND 32)
        CHECK (normalized_value = lower(normalized_value))
        CHECK (normalized_value NOT GLOB '*[^a-z0-9_]*')
        CHECK (substr(normalized_value, 1, 1) GLOB '[a-z]'),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    UNIQUE(kind, normalized_value),
    UNIQUE(principal_id, kind)
);

CREATE INDEX idx_identifiers_principal ON identifiers(principal_id, identifier_id);

-- A registered WebAuthn credential. Binary values are stored as BLOBs without base64 inflation.
-- 已登记的 WebAuthn 凭据；二进制值使用 BLOB，避免 base64 膨胀。
CREATE TABLE authenticators (
    authenticator_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    credential_id BLOB NOT NULL UNIQUE CHECK (length(credential_id) BETWEEN 16 AND 1024),
    public_key_cose BLOB NOT NULL CHECK (length(public_key_cose) BETWEEN 16 AND 4096),
    sign_count INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
    aaguid BLOB NOT NULL CHECK (length(aaguid) = 16),
    transports_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports_json)),
    backup_eligible INTEGER NOT NULL CHECK (backup_eligible IN (0, 1)),
    backup_state INTEGER NOT NULL CHECK (backup_state IN (0, 1)),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    last_used_at INTEGER,
    revoked_at INTEGER,
    CHECK (backup_state <= backup_eligible),
    CHECK (last_used_at IS NULL OR last_used_at >= created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX idx_authenticators_principal_active
    ON authenticators(principal_id, revoked_at, created_at);

-- External provider registry is deployment-managed, never account-managed.
-- 外部提供商注册表由部署管理，绝不由普通账号管理。
CREATE TABLE binding_providers (
    provider_id TEXT PRIMARY KEY,
    issuer TEXT NOT NULL UNIQUE CHECK (issuer LIKE 'https://%'),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
    authorization_endpoint TEXT NOT NULL CHECK (authorization_endpoint LIKE 'https://%'),
    token_endpoint TEXT NOT NULL CHECK (token_endpoint LIKE 'https://%'),
    jwks_uri TEXT NOT NULL CHECK (jwks_uri LIKE 'https://%'),
    client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 255),
    scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 512),
    policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
    authentication_enabled INTEGER NOT NULL DEFAULT 0 CHECK (authentication_enabled IN (0, 1)),
    state TEXT NOT NULL DEFAULT 'disabled' CHECK (state IN ('enabled', 'disabled')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE identity_bindings (
    binding_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    provider_id TEXT NOT NULL REFERENCES binding_providers(provider_id) ON DELETE RESTRICT,
    issuer TEXT NOT NULL CHECK (issuer LIKE 'https://%'),
    subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
    kind TEXT NOT NULL CHECK (kind IN ('federated_human', 'workload')),
    claim_policy_revision INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    authentication_enabled INTEGER NOT NULL DEFAULT 0 CHECK (authentication_enabled IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    last_authenticated_at INTEGER,
    revoked_at INTEGER,
    UNIQUE(issuer, subject),
    CHECK ((kind = 'workload' AND claim_policy_revision IS NOT NULL)
        OR (kind = 'federated_human' AND claim_policy_revision IS NULL)),
    CHECK (last_authenticated_at IS NULL OR last_authenticated_at >= created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX idx_identity_bindings_principal_active
    ON identity_bindings(principal_id, revoked_at, binding_id);
CREATE INDEX idx_identity_bindings_provider_subject
    ON identity_bindings(provider_id, subject);

-- Registration mode is singleton deployment configuration. Capabilities store only digests.
-- 注册模式是单例部署配置；邀请能力仅保存摘要。
CREATE TABLE registration_policy (
    policy_id INTEGER PRIMARY KEY CHECK (policy_id = 1),
    mode TEXT NOT NULL DEFAULT 'invite_only' CHECK (mode IN ('closed', 'invite_only', 'open')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at > 0)
);

CREATE TABLE registration_capabilities (
    capability_id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE CHECK (length(public_id) BETWEEN 8 AND 64),
    secret_digest BLOB NOT NULL UNIQUE CHECK (length(secret_digest) = 32),
    policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
    issued_at INTEGER NOT NULL CHECK (issued_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
    consumed_at INTEGER,
    consumed_by_principal_id TEXT REFERENCES principals(principal_id) ON DELETE RESTRICT,
    revoked_at INTEGER,
    CHECK ((consumed_at IS NULL AND consumed_by_principal_id IS NULL)
        OR (consumed_at IS NOT NULL AND consumed_by_principal_id IS NOT NULL)),
    CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE INDEX idx_registration_capabilities_expiry
    ON registration_capabilities(expires_at, consumed_at, revoked_at);

-- A primary-key insert is the atomic one-time claim; a zero-row UPDATE is not sufficient in D1 batch().
-- 主键 INSERT 是原子一次性声明；D1 batch() 中影响零行的 UPDATE 不足以保证消费。
-- All WebAuthn challenges share one state machine so one-time consumption has one normal path.
-- 所有 WebAuthn challenge 共用一个状态机，使一次性消费只有一条常规路径。
CREATE TABLE webauthn_transactions (
    transaction_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN (
        'account_registration', 'authentication', 'authenticator_addition', 'step_up'
    )),
    principal_id TEXT REFERENCES principals(principal_id) ON DELETE RESTRICT,
    registration_capability_id TEXT REFERENCES registration_capabilities(capability_id) ON DELETE RESTRICT,
    challenge_digest BLOB NOT NULL UNIQUE CHECK (length(challenge_digest) = 32),
    browser_binding_digest BLOB NOT NULL CHECK (length(browser_binding_digest) = 32),
    csrf_digest BLOB NOT NULL CHECK (length(csrf_digest) = 32),
    rp_id TEXT NOT NULL CHECK (length(rp_id) BETWEEN 1 AND 253),
    expected_origin TEXT NOT NULL CHECK (expected_origin LIKE 'https://%' OR expected_origin LIKE 'http://localhost:%'),
    policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'consumed_success', 'consumed_failure', 'cancelled')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    consumed_at INTEGER,
    result_reference TEXT,
    CHECK ((state = 'pending' AND consumed_at IS NULL)
        OR (state = 'cancelled' AND consumed_at IS NOT NULL)
        OR (state IN ('consumed_success', 'consumed_failure') AND consumed_at IS NOT NULL)),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at),
    CHECK ((kind IN ('account_registration', 'authentication') AND principal_id IS NULL)
        OR (kind IN ('authenticator_addition', 'step_up') AND principal_id IS NOT NULL))
);

CREATE INDEX idx_webauthn_transactions_expiry
    ON webauthn_transactions(state, expires_at);
CREATE INDEX idx_webauthn_transactions_principal
    ON webauthn_transactions(principal_id, state, created_at);

CREATE TABLE webauthn_transaction_consumptions (
    transaction_id TEXT PRIMARY KEY REFERENCES webauthn_transactions(transaction_id) ON DELETE RESTRICT,
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
    result_reference TEXT,
    consumed_at INTEGER NOT NULL CHECK (consumed_at > 0),
    CHECK ((outcome = 'success' AND result_reference IS NOT NULL)
        OR (outcome <> 'success' AND result_reference IS NULL))
) WITHOUT ROWID;

CREATE TABLE registration_capability_uses (
    capability_id TEXT PRIMARY KEY REFERENCES registration_capabilities(capability_id) ON DELETE RESTRICT,
    webauthn_transaction_id TEXT NOT NULL UNIQUE
        REFERENCES webauthn_transactions(transaction_id) ON DELETE RESTRICT,
    consumed_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    used_at INTEGER NOT NULL CHECK (used_at > 0)
) WITHOUT ROWID;

-- Identity sessions contain only a digest of the host-only cookie secret.
-- Identity 会话仅保存 host-only Cookie secret 的摘要。
CREATE TABLE identity_sessions (
    session_id TEXT PRIMARY KEY,
    session_digest BLOB NOT NULL UNIQUE CHECK (length(session_digest) = 32),
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    authenticator_id TEXT REFERENCES authenticators(authenticator_id) ON DELETE RESTRICT,
    binding_id TEXT REFERENCES identity_bindings(binding_id) ON DELETE RESTRICT,
    auth_method TEXT NOT NULL CHECK (auth_method IN ('passkey', 'federated')),
    amr_json TEXT NOT NULL CHECK (json_valid(amr_json)),
    acr TEXT NOT NULL CHECK (length(acr) BETWEEN 1 AND 255),
    authenticated_at INTEGER NOT NULL CHECK (authenticated_at > 0),
    last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= authenticated_at),
    idle_expires_at INTEGER NOT NULL CHECK (idle_expires_at > last_seen_at),
    absolute_expires_at INTEGER NOT NULL CHECK (absolute_expires_at >= idle_expires_at),
    revoked_at INTEGER,
    revocation_reason TEXT,
    created_from_session_id TEXT REFERENCES identity_sessions(session_id) ON DELETE RESTRICT,
    CHECK ((auth_method = 'passkey' AND authenticator_id IS NOT NULL AND binding_id IS NULL)
        OR (auth_method = 'federated' AND binding_id IS NOT NULL AND authenticator_id IS NULL)),
    CHECK ((revoked_at IS NULL AND revocation_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);

CREATE INDEX idx_identity_sessions_principal_active
    ON identity_sessions(principal_id, revoked_at, absolute_expires_at);
CREATE INDEX idx_identity_sessions_authenticator
    ON identity_sessions(authenticator_id, revoked_at);
CREATE INDEX idx_identity_sessions_binding
    ON identity_sessions(binding_id, revoked_at);

-- Recovery codes and transactions never store the presented secret.
-- 恢复码与恢复事务绝不保存用户提交的明文秘密。
CREATE TABLE recovery_code_sets (
    recovery_code_set_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    invalidated_at INTEGER,
    CHECK (invalidated_at IS NULL OR invalidated_at >= created_at)
);

CREATE INDEX idx_recovery_code_sets_principal
    ON recovery_code_sets(principal_id, invalidated_at, created_at);

CREATE TABLE recovery_codes (
    recovery_code_id TEXT PRIMARY KEY,
    recovery_code_set_id TEXT NOT NULL REFERENCES recovery_code_sets(recovery_code_set_id) ON DELETE RESTRICT,
    public_id TEXT NOT NULL UNIQUE CHECK (length(public_id) BETWEEN 8 AND 64),
    secret_digest BLOB NOT NULL UNIQUE CHECK (length(secret_digest) = 32),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    used_at INTEGER,
    CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX idx_recovery_codes_set_unused
    ON recovery_codes(recovery_code_set_id, used_at);

CREATE TABLE recovery_transactions (
    transaction_id TEXT PRIMARY KEY,
    recovery_code_id TEXT NOT NULL REFERENCES recovery_codes(recovery_code_id) ON DELETE RESTRICT,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    browser_binding_digest BLOB NOT NULL CHECK (length(browser_binding_digest) = 32),
    csrf_digest BLOB NOT NULL CHECK (length(csrf_digest) = 32),
    challenge_digest BLOB NOT NULL UNIQUE CHECK (length(challenge_digest) = 32),
    rp_id TEXT NOT NULL CHECK (length(rp_id) BETWEEN 1 AND 253),
    expected_origin TEXT NOT NULL CHECK (expected_origin LIKE 'https://%' OR expected_origin LIKE 'http://localhost:%'),
    authenticator_label TEXT NOT NULL CHECK (length(authenticator_label) BETWEEN 1 AND 80),
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'consumed_success', 'consumed_failure', 'cancelled')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    consumed_at INTEGER,
    CHECK ((state = 'pending' AND consumed_at IS NULL)
        OR (state <> 'pending' AND consumed_at IS NOT NULL)),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX idx_recovery_transactions_expiry
    ON recovery_transactions(state, expires_at);

CREATE TABLE recovery_transaction_consumptions (
    transaction_id TEXT PRIMARY KEY REFERENCES recovery_transactions(transaction_id) ON DELETE RESTRICT,
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
    result_authenticator_id TEXT REFERENCES authenticators(authenticator_id) ON DELETE RESTRICT,
    consumed_at INTEGER NOT NULL CHECK (consumed_at > 0),
    CHECK ((outcome = 'success' AND result_authenticator_id IS NOT NULL)
        OR (outcome <> 'success' AND result_authenticator_id IS NULL))
) WITHOUT ROWID;

CREATE TABLE recovery_code_uses (
    recovery_code_id TEXT PRIMARY KEY REFERENCES recovery_codes(recovery_code_id) ON DELETE RESTRICT,
    recovery_transaction_id TEXT NOT NULL UNIQUE
        REFERENCES recovery_transactions(transaction_id) ON DELETE RESTRICT,
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    used_at INTEGER NOT NULL CHECK (used_at > 0)
) WITHOUT ROWID;

-- Provider callback state and PKCE values are one-time and digest-only.
-- Provider callback state 与 PKCE 值是一次性的，且仅存摘要。
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
    redirect_uri TEXT NOT NULL CHECK (redirect_uri LIKE 'https://identity.moesegfault.dev/%'),
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

CREATE INDEX idx_binding_transactions_expiry
    ON binding_transactions(state, expires_at);
CREATE INDEX idx_binding_transactions_principal
    ON binding_transactions(principal_id, state, created_at);

CREATE TABLE binding_transaction_consumptions (
    transaction_id TEXT PRIMARY KEY REFERENCES binding_transactions(transaction_id) ON DELETE RESTRICT,
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'cancelled')),
    result_binding_id TEXT REFERENCES identity_bindings(binding_id) ON DELETE RESTRICT,
    consumed_at INTEGER NOT NULL CHECK (consumed_at > 0),
    CHECK ((outcome = 'success' AND result_binding_id IS NOT NULL)
        OR (outcome <> 'success' AND result_binding_id IS NULL))
) WITHOUT ROWID;

-- OAuth client configuration is deployment-owned and uses exact redirect URI rows.
-- OAuth client 配置由部署所有，redirect URI 逐条精确登记。
CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
    client_type TEXT NOT NULL CHECK (client_type IN ('confidential', 'native')),
    token_endpoint_auth_method TEXT NOT NULL
        CHECK (token_endpoint_auth_method IN ('private_key_jwt', 'none')),
    sector_identifier TEXT NOT NULL CHECK (length(sector_identifier) BETWEEN 1 AND 253),
    subject_salt_revision INTEGER NOT NULL CHECK (subject_salt_revision > 0),
    state TEXT NOT NULL DEFAULT 'enabled' CHECK (state IN ('enabled', 'disabled')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    CHECK ((client_type = 'confidential' AND token_endpoint_auth_method = 'private_key_jwt')
        OR (client_type = 'native' AND token_endpoint_auth_method = 'none'))
);

CREATE TABLE oauth_client_keys (
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    kid TEXT NOT NULL,
    algorithm TEXT NOT NULL CHECK (algorithm IN ('RS256', 'ES256')),
    public_jwk_json TEXT NOT NULL CHECK (json_valid(public_jwk_json)),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    retired_at INTEGER,
    PRIMARY KEY (client_id, kid),
    CHECK (retired_at IS NULL OR retired_at >= created_at)
) WITHOUT ROWID;

-- A used private_key_jwt jti is retained until assertion expiry to reject replay.
-- 已使用的 private_key_jwt jti 保留到 assertion 过期，以拒绝重放。
CREATE TABLE oauth_client_assertion_replays (
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    jti_digest BLOB NOT NULL CHECK (length(jti_digest) = 32),
    expires_at INTEGER NOT NULL CHECK (expires_at > 0),
    PRIMARY KEY (client_id, jti_digest)
) WITHOUT ROWID;

CREATE INDEX idx_oauth_client_assertion_replays_expiry
    ON oauth_client_assertion_replays(expires_at);

CREATE TABLE oauth_redirect_uris (
    redirect_uri_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),
    match_mode TEXT NOT NULL DEFAULT 'exact'
        CHECK (match_mode IN ('exact', 'native_loopback_any_port')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    UNIQUE(client_id, redirect_uri),
    CHECK (match_mode = 'exact'
        OR (redirect_uri LIKE 'http://127.0.0.1/%' OR redirect_uri LIKE 'http://[::1]/%'))
);

CREATE TABLE oauth_post_logout_redirect_uris (
    post_logout_redirect_uri_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    UNIQUE(client_id, redirect_uri)
);

CREATE TABLE oauth_scopes (
    scope TEXT PRIMARY KEY,
    description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 255),
    audience TEXT NOT NULL CHECK (length(audience) BETWEEN 1 AND 255),
    is_oidc INTEGER NOT NULL DEFAULT 0 CHECK (is_oidc IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE TABLE oauth_client_scopes (
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    scope TEXT NOT NULL REFERENCES oauth_scopes(scope) ON DELETE RESTRICT,
    granted_at INTEGER NOT NULL CHECK (granted_at > 0),
    PRIMARY KEY (client_id, scope)
) WITHOUT ROWID;

CREATE TABLE pairwise_subjects (
    sector_identifier TEXT NOT NULL,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    pairwise_subject TEXT NOT NULL UNIQUE CHECK (length(pairwise_subject) BETWEEN 16 AND 255),
    salt_revision INTEGER NOT NULL CHECK (salt_revision > 0),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    PRIMARY KEY (sector_identifier, principal_id)
) WITHOUT ROWID;

-- Original authorization request stays server-side; browser UI receives only transaction_id.
-- 原始授权请求保留在服务端；浏览器 UI 只获取 transaction_id。
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

CREATE INDEX idx_oauth_authorization_transactions_expiry
    ON oauth_authorization_transactions(state, expires_at);
CREATE INDEX idx_oauth_authorization_transactions_session
    ON oauth_authorization_transactions(identity_session_id, state);

-- Link rather than a nullable forward-reference column: both sides receive enforced FKs.
-- 使用链接表而非可空前向引用列；两端都获得可强制的外键。
CREATE TABLE webauthn_authorization_links (
    webauthn_transaction_id TEXT PRIMARY KEY
        REFERENCES webauthn_transactions(transaction_id) ON DELETE RESTRICT,
    authorization_transaction_id TEXT NOT NULL UNIQUE
        REFERENCES oauth_authorization_transactions(authorization_transaction_id) ON DELETE RESTRICT
) WITHOUT ROWID;

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

CREATE INDEX idx_oauth_authorization_codes_active
    ON oauth_authorization_codes(client_id, expires_at, consumed_at, revoked_at);
CREATE INDEX idx_oauth_authorization_codes_principal
    ON oauth_authorization_codes(principal_id, consumed_at, revoked_at);

CREATE TABLE oauth_authorization_code_uses (
    authorization_code_id TEXT PRIMARY KEY
        REFERENCES oauth_authorization_codes(authorization_code_id) ON DELETE RESTRICT,
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    used_at INTEGER NOT NULL CHECK (used_at > 0)
) WITHOUT ROWID;

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

CREATE INDEX idx_refresh_token_families_principal_active
    ON oauth_refresh_token_families(principal_id, revoked_at, absolute_expires_at);
CREATE INDEX idx_refresh_token_families_session
    ON oauth_refresh_token_families(identity_session_id, revoked_at);

-- Retaining rotated token digests enables reliable family reuse detection.
-- 保留已轮换 token 的摘要，以可靠检测整个 family 的重用。
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

CREATE UNIQUE INDEX idx_refresh_tokens_one_active_per_family
    ON oauth_refresh_tokens(refresh_token_family_id) WHERE state = 'active';
CREATE INDEX idx_refresh_tokens_expiry ON oauth_refresh_tokens(state, expires_at);

-- Public signing metadata only. Private key material remains in Workers Secrets.
-- 仅保存公开签名元数据；私钥始终位于 Workers Secrets。
CREATE TABLE signing_keys (
    kid TEXT PRIMARY KEY,
    algorithm TEXT NOT NULL CHECK (algorithm = 'RS256'),
    public_jwk_json TEXT NOT NULL CHECK (json_valid(public_jwk_json)),
    secret_binding_name TEXT NOT NULL UNIQUE CHECK (length(secret_binding_name) BETWEEN 1 AND 128),
    state TEXT NOT NULL CHECK (state IN ('staged', 'active', 'retiring', 'retired', 'revoked')),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    publish_at INTEGER NOT NULL CHECK (publish_at >= created_at),
    activate_at INTEGER,
    stop_signing_at INTEGER,
    remove_from_jwks_at INTEGER,
    revoked_at INTEGER,
    CHECK (activate_at IS NULL OR activate_at >= publish_at),
    CHECK (stop_signing_at IS NULL OR activate_at IS NOT NULL),
    CHECK (remove_from_jwks_at IS NULL OR stop_signing_at IS NOT NULL),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX idx_signing_keys_single_active
    ON signing_keys(state) WHERE state = 'active';
CREATE INDEX idx_signing_keys_jwks_window
    ON signing_keys(publish_at, remove_from_jwks_at, state);

-- Immutable security facts. Triggers make accidental application mutation impossible.
-- 不可变安全事实；触发器阻止应用意外修改。
CREATE TABLE security_audit_events (
    audit_event_id TEXT PRIMARY KEY,
    event_name TEXT NOT NULL CHECK (event_name LIKE 'identity.%'),
    occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
    observed_at INTEGER NOT NULL CHECK (observed_at >= occurred_at),
    actor_principal_id TEXT REFERENCES principals(principal_id) ON DELETE RESTRICT,
    subject_principal_id TEXT REFERENCES principals(principal_id) ON DELETE RESTRICT,
    client_id TEXT REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
    reason_code TEXT,
    authenticator_id TEXT REFERENCES authenticators(authenticator_id) ON DELETE RESTRICT,
    correlation_id TEXT NOT NULL CHECK (length(correlation_id) BETWEEN 16 AND 64),
    trace_id TEXT CHECK (trace_id IS NULL OR length(trace_id) BETWEEN 16 AND 64),
    policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
    context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context_json))
);

CREATE INDEX idx_security_audit_events_subject_time
    ON security_audit_events(subject_principal_id, occurred_at DESC);
CREATE INDEX idx_security_audit_events_name_time
    ON security_audit_events(event_name, occurred_at DESC);
CREATE INDEX idx_security_audit_events_correlation
    ON security_audit_events(correlation_id);

CREATE TRIGGER security_audit_events_no_update
BEFORE UPDATE ON security_audit_events
BEGIN
    SELECT RAISE(ABORT, 'security_audit_events are immutable');
END;

CREATE TRIGGER security_audit_events_no_delete
BEFORE DELETE ON security_audit_events
BEGIN
    SELECT RAISE(ABORT, 'security_audit_events are immutable');
END;

-- Independent R2 archive delivery, keyed idempotently by audit_event_id.
-- 独立 R2 归档投递，以 audit_event_id 实现幂等对象键。
CREATE TABLE audit_archive_outbox (
    audit_event_id TEXT PRIMARY KEY
        REFERENCES security_audit_events(audit_event_id) ON DELETE RESTRICT,
    r2_object_key TEXT NOT NULL UNIQUE CHECK (length(r2_object_key) BETWEEN 1 AND 1024),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'dead_letter')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at > 0),
    delivered_at INTEGER,
    last_error_code TEXT,
    CHECK ((state = 'delivered' AND delivered_at IS NOT NULL)
        OR (state <> 'delivered' AND delivered_at IS NULL))
);

CREATE INDEX idx_audit_archive_outbox_pending
    ON audit_archive_outbox(state, next_attempt_at, audit_event_id);

-- Diagnostic payload is allowlisted and must contain no account identifiers.
-- Diagnostic payload 必须使用字段允许列表，且不得包含账号标识符。
CREATE TABLE diagnostic_outbox (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    correlation_id TEXT NOT NULL CHECK (length(correlation_id) BETWEEN 16 AND 64),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'dead_letter')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= created_at),
    delivered_at INTEGER,
    last_error_code TEXT,
    CHECK ((state = 'delivered' AND delivered_at IS NOT NULL)
        OR (state <> 'delivered' AND delivered_at IS NULL))
);

CREATE INDEX idx_diagnostic_outbox_pending
    ON diagnostic_outbox(state, next_attempt_at, event_id);

-- Idempotency records are scoped by authenticated caller and operation.
-- 幂等记录按已认证调用方与操作共同隔离。
-- response_metadata_json must never contain recovery codes, cookies, or tokens.
-- response_metadata_json 绝不得包含恢复码、Cookie 或 Token。
CREATE TABLE idempotency_records (
    idempotency_record_id TEXT PRIMARY KEY,
    caller_fingerprint TEXT NOT NULL CHECK (length(caller_fingerprint) BETWEEN 1 AND 255),
    operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 128),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    state TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'failed')),
    response_status INTEGER CHECK (response_status BETWEEN 200 AND 599),
    response_metadata_json TEXT CHECK (response_metadata_json IS NULL OR json_valid(response_metadata_json)),
    result_reference TEXT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    completed_at INTEGER,
    UNIQUE(caller_fingerprint, operation, idempotency_key),
    CHECK ((state = 'processing' AND completed_at IS NULL AND response_status IS NULL)
        OR (state IN ('completed', 'failed') AND completed_at IS NOT NULL AND response_status IS NOT NULL))
);

CREATE INDEX idx_idempotency_records_expiry
    ON idempotency_records(expires_at, state);

-- Consumption triggers turn duplicate claims into a constraint error that rolls back batch().
-- 消费触发器将重复声明变成约束错误，从而回滚整个 batch()。
CREATE TRIGGER webauthn_consumption_validate
BEFORE INSERT ON webauthn_transaction_consumptions
WHEN NOT EXISTS (
    SELECT 1 FROM webauthn_transactions
    WHERE transaction_id = NEW.transaction_id
      AND state = 'pending'
      AND expires_at >= unixepoch()
)
BEGIN
    SELECT RAISE(ABORT, 'webauthn_transaction_not_consumable');
END;

CREATE TRIGGER webauthn_consumption_apply
AFTER INSERT ON webauthn_transaction_consumptions
BEGIN
    UPDATE webauthn_transactions
    SET state = CASE NEW.outcome
            WHEN 'success' THEN 'consumed_success'
            WHEN 'failure' THEN 'consumed_failure'
            ELSE 'cancelled'
        END,
        consumed_at = NEW.consumed_at,
        result_reference = NEW.result_reference
    WHERE transaction_id = NEW.transaction_id;
END;

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

CREATE TRIGGER authenticator_keep_one_active
BEFORE UPDATE OF revoked_at ON authenticators
WHEN OLD.revoked_at IS NULL
  AND NEW.revoked_at IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM principals
      WHERE principal_id = OLD.principal_id
        AND lifecycle_state NOT IN ('pending_deletion', 'deleted')
  )
  AND NOT EXISTS (
      SELECT 1 FROM authenticators
      WHERE principal_id = OLD.principal_id
        AND authenticator_id <> OLD.authenticator_id
        AND revoked_at IS NULL
  )
BEGIN
    SELECT RAISE(ABORT, 'last_authenticator');
END;

CREATE TRIGGER recovery_consumption_validate
BEFORE INSERT ON recovery_transaction_consumptions
WHEN NOT EXISTS (
    SELECT 1 FROM recovery_transactions
    WHERE transaction_id = NEW.transaction_id
      AND state = 'pending'
      AND expires_at >= unixepoch()
)
BEGIN
    SELECT RAISE(ABORT, 'recovery_transaction_not_consumable');
END;

CREATE TRIGGER recovery_consumption_apply
AFTER INSERT ON recovery_transaction_consumptions
BEGIN
    UPDATE recovery_transactions
    SET state = CASE NEW.outcome
            WHEN 'success' THEN 'consumed_success'
            WHEN 'failure' THEN 'consumed_failure'
            ELSE 'cancelled'
        END,
        consumed_at = NEW.consumed_at
    WHERE transaction_id = NEW.transaction_id;
END;

CREATE TRIGGER recovery_code_use_validate
BEFORE INSERT ON recovery_code_uses
WHEN NOT EXISTS (
    SELECT 1
    FROM recovery_codes AS code
    JOIN recovery_code_sets AS code_set
      ON code_set.recovery_code_set_id = code.recovery_code_set_id
    WHERE code.recovery_code_id = NEW.recovery_code_id
      AND code.used_at IS NULL
      AND code_set.invalidated_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'recovery_code_not_consumable');
END;

CREATE TRIGGER recovery_code_use_apply
AFTER INSERT ON recovery_code_uses
BEGIN
    UPDATE recovery_codes SET used_at = NEW.used_at
    WHERE recovery_code_id = NEW.recovery_code_id;
END;

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

-- Immutable event payloads may update delivery columns only.
-- 不可变事件 payload 只允许更新投递列。
CREATE TRIGGER diagnostic_outbox_payload_immutable
BEFORE UPDATE ON diagnostic_outbox
WHEN NEW.event_id IS NOT OLD.event_id
  OR NEW.event_type IS NOT OLD.event_type
  OR NEW.severity IS NOT OLD.severity
  OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.correlation_id IS NOT OLD.correlation_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'diagnostic_outbox payload is immutable');
END;

CREATE TRIGGER diagnostic_outbox_no_delete
BEFORE DELETE ON diagnostic_outbox
BEGIN
    SELECT RAISE(ABORT, 'diagnostic_outbox events are append-only');
END;

CREATE TRIGGER audit_archive_outbox_identity_immutable
BEFORE UPDATE ON audit_archive_outbox
WHEN NEW.audit_event_id IS NOT OLD.audit_event_id
  OR NEW.r2_object_key IS NOT OLD.r2_object_key
BEGIN
    SELECT RAISE(ABORT, 'audit archive identity is immutable');
END;

-- Baseline OIDC scopes. Client grants are inserted by deployment configuration.
-- 基线 OIDC scope；client grant 由部署配置写入。
INSERT INTO oauth_scopes(scope, description, audience, is_oidc, created_at) VALUES
    ('openid', 'Request an OpenID Connect identity / 请求 OpenID Connect 身份', 'identity', 1, unixepoch()),
    ('profile', 'Read the minimal public profile / 读取最小公开资料', 'identity', 1, unixepoch()),
    ('offline_access', 'Issue a rotating refresh token / 签发轮换式 refresh token', 'identity', 1, unixepoch());

INSERT INTO registration_policy(policy_id, mode, revision, updated_at)
VALUES (1, 'invite_only', 1, unixepoch());
