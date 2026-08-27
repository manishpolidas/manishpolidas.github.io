-- ---------------------------------------------------------------------------
-- OTP Testing & Load-Testing Platform - PostgreSQL schema
-- Apply with:  psql "$DATABASE_URL" -f server/db/schema.sql
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS test_session (
    id                  TEXT PRIMARY KEY,
    test_name           TEXT,
    recipient           TEXT        NOT NULL,
    status              TEXT        NOT NULL,
    sms_mode            TEXT        NOT NULL,
    otp_length          INTEGER     NOT NULL,
    rate_limit          INTEGER     NOT NULL,          -- messages per minute
    max_messages        INTEGER     NOT NULL,
    duration_seconds    INTEGER     NOT NULL,
    generated           INTEGER     NOT NULL DEFAULT 0,
    sent                INTEGER     NOT NULL DEFAULT 0,
    failed              INTEGER     NOT NULL DEFAULT 0,
    created_by          TEXT        NOT NULL,
    stop_reason          TEXT,
    authorization_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at          TIMESTAMPTZ,
    paused_at           TIMESTAMPTZ,
    stopped_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    CONSTRAINT test_session_status_chk CHECK (
        status IN ('CREATED', 'RUNNING', 'PAUSED', 'STOPPING', 'STOPPED', 'COMPLETED', 'FAILED')
    ),
    CONSTRAINT test_session_mode_chk CHECK (sms_mode IN ('mock', 'sandbox', 'authorized'))
);

CREATE INDEX IF NOT EXISTS test_session_status_idx     ON test_session (status);
CREATE INDEX IF NOT EXISTS test_session_created_at_idx ON test_session (created_at DESC);

-- One row per generated OTP. `otp_hash` is an HMAC-SHA256 of the OTP; the
-- plaintext column is only ever populated by the local mock provider.
CREATE TABLE IF NOT EXISTS otp_attempt (
    id                  TEXT PRIMARY KEY,
    test_id             TEXT        NOT NULL REFERENCES test_session (id) ON DELETE CASCADE,
    sequence            INTEGER     NOT NULL,
    recipient           TEXT        NOT NULL,
    otp_hash            TEXT        NOT NULL,
    otp_plaintext       TEXT,
    status              TEXT        NOT NULL,
    provider_message_id TEXT,
    error_message       TEXT,
    latency_ms          INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ,
    CONSTRAINT otp_attempt_status_chk CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
    CONSTRAINT otp_attempt_unique_sequence UNIQUE (test_id, sequence)
);

CREATE INDEX IF NOT EXISTS otp_attempt_test_idx ON otp_attempt (test_id, sequence);

CREATE TABLE IF NOT EXISTS test_log (
    id         TEXT PRIMARY KEY,
    test_id    TEXT        NOT NULL REFERENCES test_session (id) ON DELETE CASCADE,
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    level      TEXT        NOT NULL,
    event      TEXT        NOT NULL,
    message    TEXT        NOT NULL,
    CONSTRAINT test_log_level_chk CHECK (level IN ('info', 'warn', 'error'))
);

CREATE INDEX IF NOT EXISTS test_log_test_idx ON test_log (test_id, at);

-- Append-only audit trail: who started/stopped/deleted what, and from where.
CREATE TABLE IF NOT EXISTS audit_log (
    id      TEXT PRIMARY KEY,
    at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor   TEXT        NOT NULL,
    action  TEXT        NOT NULL,
    test_id TEXT,
    detail  TEXT,
    ip      TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
