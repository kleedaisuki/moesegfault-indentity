-- Device authorization is an explicit, deployment-owned client capability.
ALTER TABLE oauth_clients ADD COLUMN device_authorization_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (device_authorization_enabled IN (0, 1));

CREATE TABLE oauth_device_authorizations (
    device_authorization_id TEXT PRIMARY KEY,
    device_code_digest BLOB NOT NULL UNIQUE CHECK (length(device_code_digest) = 32),
    user_code_digest BLOB NOT NULL UNIQUE CHECK (length(user_code_digest) = 32),
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 1024),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied', 'consumed')),
    principal_id TEXT REFERENCES principals(principal_id) ON DELETE RESTRICT,
    identity_session_id TEXT REFERENCES identity_sessions(session_id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    poll_interval INTEGER NOT NULL DEFAULT 5 CHECK (poll_interval >= 5),
    next_poll_at INTEGER NOT NULL,
    last_poll_early INTEGER NOT NULL DEFAULT 0 CHECK (last_poll_early IN (0, 1)),
    consumption_id TEXT UNIQUE,
    CHECK ((state IN ('pending', 'denied') AND principal_id IS NULL AND identity_session_id IS NULL)
        OR (state IN ('approved', 'consumed') AND principal_id IS NOT NULL AND identity_session_id IS NOT NULL)),
    CHECK ((state = 'consumed' AND consumption_id IS NOT NULL)
        OR (state <> 'consumed' AND consumption_id IS NULL))
);

CREATE INDEX idx_oauth_device_authorizations_expiry ON oauth_device_authorizations(expires_at);

CREATE TABLE oauth_device_verification_attempts (
    bucket_digest BLOB NOT NULL CHECK (length(bucket_digest) = 32),
    bucket_start INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
    PRIMARY KEY (bucket_digest, bucket_start)
) WITHOUT ROWID;
