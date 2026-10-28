CREATE TABLE notification_senders (
  local_part TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE notification_messages (
  message_id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  sender TEXT NOT NULL REFERENCES notification_senders(local_part),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sending', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_token TEXT,
  provider_message_id TEXT,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  UNIQUE (service, idempotency_key),
  CHECK (expires_at > created_at),
  CHECK (state IN ('sent', 'failed') OR payload IS NOT NULL)
) STRICT;

CREATE INDEX notification_messages_due ON notification_messages(state, next_attempt_at);
CREATE INDEX notification_messages_retention ON notification_messages(created_at);
