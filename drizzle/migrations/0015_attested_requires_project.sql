-- Invariant guard (adversarial-review): an 'attested' attestation MUST carry a
-- project; only the 'unassigned' state may have a NULL project. Two consumers
-- gate on different columns for the same concept (the read joiner on
-- attestation_state='attested'; the untagged worklist on project_code_hash IS
-- NOT NULL), so the binding must be DB-guaranteed. Without it, an attested row
-- with a NULL project would be silently dropped by the joiner (its project
-- lookup returns nothing) and the spend would vanish with no audit.

ALTER TABLE session_attestation
  ADD CONSTRAINT session_attestation_attested_has_project
  CHECK (attestation_state <> 'attested' OR project_code_hash IS NOT NULL);
