-- 0029: partial index backing the bearer-auth-failed health signal (went-silent
-- re-anchor). The /bearer success path runs a resolve UPDATE on every credential
-- refresh (WHERE instance_id = … AND status='bearer-auth-failed' AND resolved_at
-- IS NULL), and the went-silent worker filters/JOINs on the same predicate. In
-- steady state almost no instance has an open failure, so a partial index makes
-- the resolve a near-free empty probe instead of a widening scan over the
-- append-only health table.

CREATE INDEX IF NOT EXISTS instance_attestation_health_open_bearer
  ON instance_attestation_health (instance_id)
  WHERE status = 'bearer-auth-failed' AND resolved_at IS NULL;
