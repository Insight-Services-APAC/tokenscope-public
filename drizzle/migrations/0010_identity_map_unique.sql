-- An external identity (a Claude/GitHub/client email or username) maps to AT
-- MOST ONE teammate — so a teammate can't claim an identity another teammate
-- already owns (the integrity guard for self-service identity linking). See
-- docs/design/client-attribution-auth-spec.md §2 / the "My accounts" surface.
CREATE UNIQUE INDEX IF NOT EXISTS teammate_identity_map_identity_unique
  ON teammate_identity_map (system, identifier);
