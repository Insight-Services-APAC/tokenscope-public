-- 0145 — record that an auth code's exchange actually issued a token.
--
-- consumed_at is set BEFORE the client / redirect_uri / PKCE checks and commits
-- even when /oauth/token answers invalid_grant (token-transactional.test.ts),
-- so it cannot tell the consent page whether sign-in succeeded. token_issued_at
-- is written in the same transaction as issueTokens, only on success.
ALTER TABLE oauth_auth_code ADD COLUMN IF NOT EXISTS token_issued_at timestamptz;
