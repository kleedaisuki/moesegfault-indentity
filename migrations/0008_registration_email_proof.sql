-- Mailbox proof exists before any principal or credential. Only digests and encrypted
-- delivery payloads are stored; abandoned signup challenges do not reserve identities.
CREATE TABLE registration_email_transactions (
    transaction_id TEXT PRIMARY KEY NOT NULL,
    destination_digest BLOB NOT NULL CHECK(typeof(destination_digest)='blob' AND length(destination_digest)=32),
    browser_digest BLOB NOT NULL CHECK(typeof(browser_digest)='blob' AND length(browser_digest)=32),
    code_digest BLOB NOT NULL CHECK(typeof(code_digest)='blob' AND length(code_digest)=32),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 10),
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','verified','cancelled','locked','expired')),
    created_at INTEGER NOT NULL CHECK(created_at>0),
    expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+600),
    consumed_at INTEGER,
    proof_expires_at INTEGER
);
CREATE INDEX idx_registration_email_destination ON registration_email_transactions(destination_digest,created_at);
CREATE INDEX idx_registration_email_browser ON registration_email_transactions(browser_digest,created_at);

-- Enforce send budgets at the database write boundary, including concurrent requests.
CREATE TRIGGER registration_email_send_budget BEFORE INSERT ON registration_email_transactions
WHEN EXISTS(SELECT 1 FROM registration_email_transactions
    WHERE (destination_digest=NEW.destination_digest OR browser_digest=NEW.browser_digest)
    AND created_at>NEW.created_at-60)
    OR (SELECT COUNT(*) FROM registration_email_transactions
        WHERE destination_digest=NEW.destination_digest AND created_at>NEW.created_at-3600)>=5
    OR (SELECT COUNT(*) FROM registration_email_transactions
        WHERE browser_digest=NEW.browser_digest AND created_at>NEW.created_at-3600)>=5
BEGIN SELECT RAISE(ABORT,'registration_email_rate_limited'); END;

-- Consumed in the same account-creation batch. A duplicate claim rolls everything back.
CREATE TABLE registration_email_consumptions (
    transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES registration_email_transactions(transaction_id),
    principal_id TEXT NOT NULL UNIQUE REFERENCES principals(principal_id),
    consumed_at INTEGER NOT NULL CHECK(consumed_at>0)
);

-- Reuse the existing encrypted delivery contract, independently of account contacts.
CREATE TABLE registration_email_outbox (
    outbox_id TEXT PRIMARY KEY
        CHECK (typeof(outbox_id) = 'text' AND length(outbox_id) BETWEEN 1 AND 128),
    transaction_id TEXT NOT NULL UNIQUE
        REFERENCES registration_email_transactions(transaction_id) ON DELETE CASCADE,
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

CREATE INDEX idx_registration_email_outbox_due
    ON registration_email_outbox(state, next_attempt_at, lease_expires_at);
