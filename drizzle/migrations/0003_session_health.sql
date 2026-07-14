-- session_attestation_health — mitigation-query observability table.
--
-- Per data-model.md §Mitigation queries / observability: the
-- mitigation-query worker (Epic 6) writes one row here per
-- detected gap between attestation and OTel reception. Manager-side
-- inbox surfaces these as info-severity items so the SRE / dev can
-- investigate.

CREATE TABLE session_attestation_health (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES session_attestation(session_id),
  status        TEXT NOT NULL,                          -- 'no-spans-received' | 'partial-spans' | 'late-spans' | 'healthy'
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expected_span_count INTEGER,
  actual_span_count   INTEGER,
  payload       JSONB,
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX session_attestation_health_session ON session_attestation_health (session_id);
CREATE INDEX session_attestation_health_status_detected ON session_attestation_health (status, detected_at);
