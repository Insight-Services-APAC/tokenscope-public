-- setup_token — one-time, short-lived self-service CLI enrolment credential.
-- Minted by an authed web user (who picks a project), redeemed once by the CLI
-- (/api/v1/setup/exchange, no cookie — the token is the auth) which mints a
-- session attestation for the chosen project. Single-use + TTL.

CREATE TABLE IF NOT EXISTS setup_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL,
  teammate_id   uuid NOT NULL REFERENCES teammate(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES project(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);

CREATE INDEX IF NOT EXISTS setup_token_hash_idx ON setup_token (token_hash);
