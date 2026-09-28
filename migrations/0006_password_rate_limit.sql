-- Store only domain-separated HMAC digests, never submitted identifiers or IP addresses.
-- 仅保存带域隔离的 HMAC 摘要，不保存提交的标识符或 IP 地址。
CREATE TABLE password_auth_attempts (
    bucket_digest BLOB PRIMARY KEY
        CHECK (typeof(bucket_digest) = 'blob' AND length(bucket_digest) = 32),
    attempt_count INTEGER NOT NULL
        CHECK (typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 1 AND 100),
    last_attempt_at INTEGER NOT NULL
        CHECK (typeof(last_attempt_at) = 'integer' AND last_attempt_at > 0),
    next_allowed_at INTEGER NOT NULL
        CHECK (typeof(next_allowed_at) = 'integer' AND next_allowed_at >= last_attempt_at),
    expires_at INTEGER NOT NULL
        CHECK (typeof(expires_at) = 'integer' AND expires_at > last_attempt_at)
);

-- The scheduled worker removes stale buckets in bounded batches.
-- 定时 Worker 分批删除过期桶。
CREATE INDEX idx_password_auth_attempts_expiry ON password_auth_attempts(expires_at);
