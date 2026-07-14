-- 0023: OAuth 2.1 Authorization Server tables (ADR-0005 — the credential pathway).
--
-- TokenScope becomes an MCP OAuth provider. Claude Code's MCP client registers
-- dynamically (RFC 7591), runs authorization-code + PKCE (RFC 7636), and
-- exchanges/refreshes tokens. a sibling project stores this in Redis; TokenScope has no
-- Redis in MVP, so the AS state is Postgres.
--
-- Secrets discipline: client_secret, auth codes, and access/refresh tokens are
-- stored only as HMAC-SHA-256 hashes (server/auth/hmac.ts::hashSessionToken) —
-- never plaintext. The raw value is returned to the client once.

CREATE TABLE IF NOT EXISTS oauth_client (
  client_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_secret_hash text NOT NULL,
  client_name        text NOT NULL DEFAULT 'MCP Client',
  -- Loopback-only redirect URIs (RFC 8252), validated at registration.
  redirect_uris      text[] NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_auth_code (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC hash of the raw code; raw code goes to the client in the redirect.
  code_hash             text NOT NULL UNIQUE,
  client_id             uuid NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  teammate_id           uuid NOT NULL REFERENCES teammate(id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL,
  scope                 text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  -- Single-use marker. NULL = unconsumed; set atomically on exchange
  -- (UPDATE ... WHERE consumed_at IS NULL RETURNING).
  consumed_at           timestamptz
);

CREATE TABLE IF NOT EXISTS oauth_token (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token_hash   text NOT NULL UNIQUE,
  refresh_token_hash  text NOT NULL UNIQUE,
  client_id           uuid NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  teammate_id         uuid NOT NULL REFERENCES teammate(id) ON DELETE CASCADE,
  scope               text NOT NULL,
  -- ADR-0005 E2 anchor: a teammate revoked AFTER this instant invalidates the
  -- token (teammate.revoked_at > access_issued_at). requireOAuthBearer joins on it.
  access_issued_at    timestamptz NOT NULL DEFAULT now(),
  access_expires_at   timestamptz NOT NULL,
  refresh_expires_at  timestamptz NOT NULL,
  -- Set on revoke OR when superseded by a refresh. NULL = live.
  revoked_at          timestamptz
);

CREATE INDEX IF NOT EXISTS oauth_token_teammate_idx ON oauth_token (teammate_id);
CREATE INDEX IF NOT EXISTS oauth_auth_code_expires_idx ON oauth_auth_code (expires_at);
