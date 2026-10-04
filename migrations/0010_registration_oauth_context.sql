-- Preserve provider-issued OAuth context through browser-bound mailbox verification.
-- NULL retains independent signup and compatibility with already-issued challenges.
ALTER TABLE registration_email_transactions ADD COLUMN authorization_transaction_id TEXT
    REFERENCES oauth_authorization_transactions(authorization_transaction_id);
