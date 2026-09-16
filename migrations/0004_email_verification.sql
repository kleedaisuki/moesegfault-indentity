-- Verification transactions are ephemeral. Rebuild the unused v1 table so email
-- delivery has a destination snapshot and contact deletion stays a normal operation.
-- 验证事务是短期数据。直接重建未启用的 v1 表，为邮件投递保存目标快照摘要，并让删除联系方式保持为普通操作。
DROP TABLE identifier_verification_transactions;

-- Unverified contacts are account-local claims, not global ownership. Global ownership
-- begins only after verification; usernames remain globally unique.
-- 未验证联系方式只是账号内声明，而不是全局所有权；验证后才获得全局所有权，用户名仍保持全局唯一。
CREATE TABLE identifiers_v3 (
    identifier_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('username', 'email', 'mobile')),
    value TEXT NOT NULL CHECK (length(value) BETWEEN 3 AND 320),
    normalized_value TEXT NOT NULL CHECK (length(normalized_value) BETWEEN 3 AND 320),
    country_calling_code TEXT,
    national_number TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    verification_state TEXT NOT NULL DEFAULT 'verified'
        CHECK (verification_state IN ('unverified', 'pending', 'verified')),
    verified_at INTEGER DEFAULT (unixepoch()),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    UNIQUE(principal_id, kind, normalized_value),
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

INSERT INTO identifiers_v3 (
    identifier_id, principal_id, kind, value, normalized_value,
    country_calling_code, national_number, is_primary, verification_state,
    verified_at, created_at, updated_at
)
SELECT identifier_id, principal_id, kind, value, normalized_value,
       country_calling_code, national_number, is_primary, verification_state,
       verified_at, created_at, updated_at
FROM identifiers;

DROP TABLE identifiers;
ALTER TABLE identifiers_v3 RENAME TO identifiers;

CREATE INDEX idx_identifiers_principal
    ON identifiers(principal_id, kind, created_at);
CREATE UNIQUE INDEX idx_identifiers_primary_kind
    ON identifiers(principal_id, kind) WHERE is_primary = 1;
CREATE UNIQUE INDEX idx_identifiers_one_username
    ON identifiers(principal_id) WHERE kind = 'username';
CREATE UNIQUE INDEX idx_identifiers_unique_username_value
    ON identifiers(normalized_value) WHERE kind = 'username';
CREATE UNIQUE INDEX idx_identifiers_unique_verified_contact
    ON identifiers(kind, normalized_value)
    WHERE kind IN ('email', 'mobile') AND verified_at IS NOT NULL;

CREATE TABLE identifier_verification_transactions (
    transaction_id TEXT PRIMARY KEY
        CHECK (typeof(transaction_id) = 'text' AND length(transaction_id) BETWEEN 1 AND 128),
    identifier_id TEXT NOT NULL
        REFERENCES identifiers(identifier_id) ON DELETE CASCADE,
    destination_digest BLOB NOT NULL
        CHECK (typeof(destination_digest) = 'blob' AND length(destination_digest) = 32),
    code_digest BLOB NOT NULL
        CHECK (typeof(code_digest) = 'blob' AND length(code_digest) = 32),
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 10),
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'verified', 'expired', 'cancelled', 'locked')),
    created_at INTEGER NOT NULL
        CHECK (typeof(created_at) = 'integer' AND created_at > 0),
    expires_at INTEGER NOT NULL
        CHECK (
            typeof(expires_at) = 'integer'
            AND expires_at > created_at
            AND expires_at <= created_at + 600
        ),
    consumed_at INTEGER,
    CHECK (
        (state = 'pending' AND consumed_at IS NULL)
        OR (
            state <> 'pending'
            AND typeof(consumed_at) = 'integer'
            AND consumed_at >= created_at
        )
    )
);

-- At most one live challenge exists for a contact. Finished history remains available
-- for abuse-rate accounting without application-side race windows.
-- 每个联系方式最多只有一个待处理挑战；完成历史继续用于滥用频率统计，且不留下应用层竞态窗口。
CREATE UNIQUE INDEX idx_identifier_verifications_one_pending
    ON identifier_verification_transactions(identifier_id)
    WHERE state = 'pending';

CREATE INDEX idx_identifier_verifications_identifier_created
    ON identifier_verification_transactions(identifier_id, created_at DESC);

CREATE INDEX idx_identifier_verifications_destination_created
    ON identifier_verification_transactions(destination_digest, created_at DESC);

CREATE INDEX idx_identifier_verifications_expiry
    ON identifier_verification_transactions(state, expires_at);

-- A primary-key claim is the concurrency arbiter for exactly-once verification completion.
-- 主键声明是验证完成恰好一次语义的并发仲裁点。
CREATE TABLE identifier_verification_consumptions (
    transaction_id TEXT PRIMARY KEY
        REFERENCES identifier_verification_transactions(transaction_id) ON DELETE CASCADE,
    consumed_at INTEGER NOT NULL
        CHECK (typeof(consumed_at) = 'integer' AND consumed_at > 0)
) WITHOUT ROWID;

-- Durable encrypted delivery work is committed with the verification transaction.
-- No recipient or verification code is stored in plaintext.
-- 加密的持久投递任务与验证事务一同提交；收件人与验证码都不以明文保存。
CREATE TABLE email_verification_outbox (
    outbox_id TEXT PRIMARY KEY
        CHECK (typeof(outbox_id) = 'text' AND length(outbox_id) BETWEEN 1 AND 128),
    transaction_id TEXT NOT NULL UNIQUE
        REFERENCES identifier_verification_transactions(transaction_id) ON DELETE CASCADE,
    payload_ciphertext BLOB
        CHECK (
            payload_ciphertext IS NULL
            OR (typeof(payload_ciphertext) = 'blob' AND length(payload_ciphertext) BETWEEN 17 AND 4096)
        ),
    payload_nonce BLOB
        CHECK (
            payload_nonce IS NULL
            OR (typeof(payload_nonce) = 'blob' AND length(payload_nonce) = 24)
        ),
    key_revision INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(key_revision) = 'integer' AND key_revision = 1),
    template_revision INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(template_revision) = 'integer' AND template_revision = 1),
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'sending', 'delivered', 'dead')),
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 10),
    next_attempt_at INTEGER
        CHECK (next_attempt_at IS NULL OR (
            typeof(next_attempt_at) = 'integer' AND next_attempt_at > 0
        )),
    lease_expires_at INTEGER,
    created_at INTEGER NOT NULL
        CHECK (typeof(created_at) = 'integer' AND created_at > 0),
    delivered_at INTEGER,
    last_error_code TEXT
        CHECK (last_error_code IS NULL OR (
            typeof(last_error_code) = 'text' AND length(last_error_code) BETWEEN 1 AND 128
        )),
    CHECK (next_attempt_at IS NULL OR next_attempt_at >= created_at),
    CHECK (lease_expires_at IS NULL OR (
        typeof(lease_expires_at) = 'integer' AND lease_expires_at >= created_at
    )),
    CHECK (delivered_at IS NULL OR (
        typeof(delivered_at) = 'integer' AND delivered_at >= created_at
    )),
    CHECK (
        (state = 'pending'
            AND payload_ciphertext IS NOT NULL AND payload_nonce IS NOT NULL
            AND next_attempt_at IS NOT NULL
            AND lease_expires_at IS NULL AND delivered_at IS NULL)
        OR (state = 'sending'
            AND payload_ciphertext IS NOT NULL AND payload_nonce IS NOT NULL
            AND next_attempt_at IS NOT NULL
            AND lease_expires_at IS NOT NULL AND delivered_at IS NULL)
        OR (state = 'delivered'
            AND payload_ciphertext IS NULL AND payload_nonce IS NULL
            AND next_attempt_at IS NULL
            AND lease_expires_at IS NULL AND delivered_at IS NOT NULL)
        OR (state = 'dead'
            AND payload_ciphertext IS NULL AND payload_nonce IS NULL
            AND next_attempt_at IS NULL
            AND lease_expires_at IS NULL AND delivered_at IS NULL)
    )
);

CREATE INDEX idx_email_verification_outbox_due
    ON email_verification_outbox(state, next_attempt_at, lease_expires_at);
