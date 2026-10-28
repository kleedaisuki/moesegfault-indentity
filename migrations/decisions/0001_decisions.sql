CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','submitted','expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  submitted_at INTEGER,
  UNIQUE (service,idempotency_key)
);
CREATE INDEX decisions_expiry ON decisions(state,expires_at);
CREATE TABLE decision_submissions (
  decision_id TEXT PRIMARY KEY REFERENCES decisions(decision_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE decision_outbox (
  outbox_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('notification','callback')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_id TEXT,
  lease_until INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  UNIQUE(decision_id,kind)
);
CREATE INDEX decision_outbox_ready ON decision_outbox(state,available_at);
