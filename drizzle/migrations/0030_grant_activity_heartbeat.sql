-- 0030: grant-lifecycle activity + emit heartbeat columns (MCP client backbone).
--
-- oauth_token.last_used_at — last time a credential was used. Stamped INSIDE the
-- existing refresh UPDATE (no extra hot-path write) + best-effort on MCP calls.
-- Drives the grant active/inactive(14d) state via COALESCE(last_used_at, created_at).
--
-- instance_attestation.last_bearer_at — last successful /bearer mint, an
-- authenticated heartbeat proving the instance held a valid emit credential then.
-- Drives heartbeat-coverage / quarantined-spend detection.

ALTER TABLE oauth_token ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE instance_attestation ADD COLUMN IF NOT EXISTS last_bearer_at TIMESTAMPTZ;
