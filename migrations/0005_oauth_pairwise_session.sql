-- Opaque per-client session IDs keep RP-initiated logout functional without exposing Identity session IDs.
-- 每个客户端使用独立的不透明会话 ID，既支持 RP 发起登出，也不泄露 Identity 会话 ID。
CREATE TABLE oauth_client_session_ids (
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
    identity_session_id TEXT NOT NULL REFERENCES identity_sessions(session_id) ON DELETE RESTRICT,
    public_sid TEXT NOT NULL UNIQUE CHECK (length(public_sid) BETWEEN 16 AND 255),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    PRIMARY KEY (client_id, identity_session_id)
) WITHOUT ROWID;
