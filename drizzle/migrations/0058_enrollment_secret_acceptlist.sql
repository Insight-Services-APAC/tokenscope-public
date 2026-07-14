-- 0058: emit-on-install enrollment-secret accept-list (slice 3).
--
-- See docs/design/emit-on-install-provisional-attribution.md (§Flows 1, §Safety
-- properties). The bundled Insight enrollment secret is the GATE on
-- POST /api/v1/setup/enroll (the no-login emit-on-install path). This table is the
-- durable, rotatable accept-list: rotate-with-overlap (several live rows, each in
-- its [not_before, not_after) window) + instant revoke (revoked_at) so a leaked
-- secret can be killed without bricking every already-installed plugin.
--
-- Secrets discipline mirrors oauth_client / emit_handoff: only the HMAC-SHA-256
-- hash of the raw secret is stored (hashSessionToken), never the plaintext. The
-- presented secret is hashed and looked up by hash, so a stolen DB can't recover
-- a usable secret.
--
-- Bootstrap: in ADDITION to this table, the enroll endpoint accepts a secret from
-- env NUXT_ENROLLMENT_SECRET (hashed + compared) so dev works before any row is
-- seeded. The TABLE is the durable mechanism; the env var is the seed/bootstrap.
--
-- Idempotent (IF NOT EXISTS) so a re-run is a no-op.
CREATE TABLE IF NOT EXISTS enrollment_secret (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC-SHA-256 hash of the raw bundled secret. UNIQUE: one row per secret, and
  -- a rotation can't accidentally double-seed the same value.
  secret_hash text NOT NULL UNIQUE,
  label text,                                       -- human note: which rotation / cohort
  not_before timestamptz,                           -- NULL = live from creation (no lower bound)
  not_after timestamptz,                            -- NULL = no scheduled expiry (no upper bound)
  revoked_at timestamptz,                           -- instant kill switch; NULL = live
  created_at timestamptz NOT NULL DEFAULT now()
);
