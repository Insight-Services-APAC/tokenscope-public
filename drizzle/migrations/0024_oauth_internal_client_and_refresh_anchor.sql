-- 0024: OAuth hardening (ADR-0005 adversarial review follow-ups).
--
-- Two additive, idempotent changes:
--
-- 1. oauth_client.internal — identify the single internal emit client by a
--    server-controlled boolean instead of a free-form client_name string. An
--    attacker could register a public client named 'tokenscope-emit' and then
--    be treated as the internal emit client (public refresh_token path, no
--    secret). Keying off `internal = TRUE` removes that name-trust. A partial
--    unique index guarantees AT MOST ONE internal client ever exists.
--
-- 2. oauth_token.refresh_issued_at — a STABLE per-row anchor for the ADR-0005
--    E2 teammate-revocation check on the NON-ROTATING refresh path. access_issued_at
--    is bumped on every refresh, so it cannot anchor "was the teammate revoked
--    since this credential was granted?". refresh_issued_at is set once at
--    issuance and never moves, so a teammate revoked after the credential was
--    granted is correctly rejected on refresh.

ALTER TABLE oauth_client
  ADD COLUMN IF NOT EXISTS internal boolean NOT NULL DEFAULT FALSE;

-- At most one internal emit client. Partial unique index over `internal` scoped
-- to the TRUE rows: with the WHERE predicate selecting only internal = TRUE rows,
-- a unique index on `internal` admits a single such row (FALSE rows are excluded
-- from the index and so unconstrained).
CREATE UNIQUE INDEX IF NOT EXISTS oauth_client_one_internal_idx
  ON oauth_client (internal)
  WHERE internal = TRUE;

ALTER TABLE oauth_token
  ADD COLUMN IF NOT EXISTS refresh_issued_at timestamptz NOT NULL DEFAULT now();
