-- 0031: emit_handoff + oauth_token.instance_id (MCP client backbone — provision_emit).
--
-- WHY (docs/design/mcp-client-backbone.md §"One auth → also provisions the
-- device, WITHOUT a durable secret in the LLM"):
--   The `provision_emit` MCP tool runs over the read-scoped OAuth bearer — the ONE
--   sanctioned read→emit crossing (ADR-0005 E1). It must NOT return the durable
--   emit refresh token (that would put the broadly-readable secret into the LLM's
--   context). Instead it mints a SHORT-TTL, single-use HANDOFF code (this table)
--   and returns only that + a redeem URL. A direct process→server call
--   (/api/v1/setup/redeem) redeems the handoff for the durable credential — the
--   secret goes process→process, never through the agent.
--
-- emit_handoff — a one-time, ~5-min credential bound to (teammate, instance).
--   Mirrors setup_token / oauth_auth_code discipline: only the HMAC-SHA-256 hash
--   is stored (server/auth/hmac.ts::hashSessionToken); the raw code is returned to
--   the tool once and never persisted. Single-use is an atomic CAS on consume
--   (UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() RETURNING), like
--   consumeAuthCode — concurrent/replayed redeems see at most one success.

CREATE TABLE IF NOT EXISTS emit_handoff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC hash of the raw handoff code; raw value goes to provision_emit's caller
  -- once. UNIQUE so redeem is a single indexed row lookup.
  code_hash     text NOT NULL UNIQUE,
  -- The teammate (read-bearer identity) provisioning the device, and the device
  -- this handoff provisions. Redeem mints the durable emit credential bound to
  -- this teammate + instance.
  teammate_id   uuid NOT NULL REFERENCES teammate(id) ON DELETE CASCADE,
  instance_id   uuid NOT NULL REFERENCES instance_attestation(instance_id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  -- Single-use marker. NULL = unconsumed; set atomically on redeem.
  consumed_at   timestamptz
);

CREATE INDEX IF NOT EXISTS emit_handoff_hash_idx ON emit_handoff (code_hash);
-- For rotate-and-revoke-prior (provision_emit invalidates any live handoff for
-- the same instance before minting a fresh one).
CREATE INDEX IF NOT EXISTS emit_handoff_instance_idx ON emit_handoff (instance_id);

-- oauth_token.instance_id — bind a durable EMIT credential to the device it was
-- provisioned for, so re-provisioning the SAME instance can rotate-and-revoke the
-- prior credential (idempotency: at most one LIVE emit credential per instance —
-- "no unbounded creds", docs §F2.3). NULL for read/tag credentials and for
-- legacy emit credentials minted via the setup-token path (which has no MCP
-- instance binding); only the provision_emit→redeem path populates it.
ALTER TABLE oauth_token ADD COLUMN IF NOT EXISTS instance_id uuid REFERENCES instance_attestation(instance_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS oauth_token_instance_idx ON oauth_token (instance_id) WHERE instance_id IS NOT NULL;
