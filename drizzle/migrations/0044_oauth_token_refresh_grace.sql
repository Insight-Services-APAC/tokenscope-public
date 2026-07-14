-- 0044: one-deep access-token grace window on non-rotating refresh (AUTH-3,
-- robustness-review-2026-06-09).
--
-- refreshAccessToken overwrites access_token_hash IN PLACE, so concurrent
-- refreshes against the SAME refresh token (all CWs on one host share one
-- instance → one emit refresh token, per the 2026-06-05 dogfood incident)
-- invalidate each other's access tokens and ping-pong indefinitely. The fix:
-- the refresh UPDATE parks the OUTGOING access-token hash in
-- prev_access_token_hash with a short prev_valid_until horizon (~60 s), and
-- requireOAuthBearer accepts either hash (the previous one only until
-- prev_valid_until). One-deep: a second refresh overwrites the parked hash, so
-- at most two access tokens are ever live per row, the older for ≤60 s.
ALTER TABLE oauth_token
  ADD COLUMN prev_access_token_hash text,
  ADD COLUMN prev_valid_until timestamptz;

-- requireOAuthBearer looks the presented hash up by either column; the grace
-- lookup needs its own index (access_token_hash already has the unique one).
CREATE INDEX oauth_token_prev_access_hash_idx
  ON oauth_token (prev_access_token_hash)
  WHERE prev_access_token_hash IS NOT NULL;
