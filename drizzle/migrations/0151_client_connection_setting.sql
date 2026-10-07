-- 0151: client_connection_setting — the admin "Client connection" policy (#415).
--
-- WHAT IT IS FOR. The connect dialog tells a developer which plugin marketplace to
-- add and which plugins to install. Those were baked into the component, so a
-- deployment other than the one they were written for showed instructions for the
-- wrong marketplace. This row lets a platform admin set them per deployment;
-- GET /api/v1/connect/config serves them to the dialog.
--
-- SINGLE LOGICAL ROW, same shape as mig 0087: `key` is a PK pinned to 'policy' by
-- CHECK. NO SEED ROW: an absent row means DEFAULT_CLIENT_CONNECTION
-- (shared/connect.ts), which is exactly what the dialog showed before this table
-- existed. A rollback that drops the table degrades to those defaults.
--
-- WHY A TABLE, NOT governance_setting: that table is numeric-only (mig 0049).
--
-- The CHECKs repeat the app-layer formats (shared/connect.ts) for the columns
-- where a regex is cheap to state. Every value ends up inside a command a user
-- pastes into a terminal, so the DB refuses whitespace and shell metacharacters
-- too, not only the PUT handler.

CREATE TABLE client_connection_setting (
  key                TEXT PRIMARY KEY DEFAULT 'policy' CHECK (key = 'policy'),
  marketplace_source TEXT NOT NULL CHECK (
    length(marketplace_source) <= 512
    AND marketplace_source ~ '^[A-Za-z0-9._~%:/-]+$'
  ),
  marketplace_ref    TEXT CHECK (marketplace_ref IS NULL OR marketplace_ref ~ '^[A-Za-z0-9._/-]{1,128}$'),
  marketplace_name   TEXT NOT NULL CHECK (marketplace_name ~ '^[a-z0-9-]{1,64}$'),
  claude_plugin      TEXT NOT NULL CHECK (claude_plugin ~ '^[a-z0-9-]{1,64}$'),
  copilot_plugin     TEXT NOT NULL CHECK (copilot_plugin ~ '^[a-z0-9-]{1,64}$'),
  enabled_clients    TEXT[] NOT NULL CHECK (
    cardinality(enabled_clients) >= 1
    AND enabled_clients <@ ARRAY['claude-code', 'copilot-cli']::TEXT[]
  ),
  support_url        TEXT CHECK (support_url IS NULL OR (length(support_url) <= 2048 AND support_url ~ '^https://')),
  updated_by         UUID REFERENCES teammate(id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS mirrors 0087: readable by any authenticated user (every connect dialog
-- reads it), written by platform-admin only (`app.user_role` carries
-- 'global-finops' for a platform-admin, see 0140). RLS is not the live gate
-- today; requireRole('platform-admin') on the PUT is.
ALTER TABLE client_connection_setting ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON client_connection_setting FROM PUBLIC;

CREATE POLICY client_connection_setting_read ON client_connection_setting
  FOR SELECT
  USING (true);

CREATE POLICY client_connection_setting_write ON client_connection_setting
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

COMMENT ON TABLE client_connection_setting IS
  'Admin Client connection policy (#415): marketplace source/ref/name, plugin names, enabled clients, support link for the connect dialog. Single row; ABSENT ROW = shared/connect.ts DEFAULT_CLIENT_CONNECTION.';
