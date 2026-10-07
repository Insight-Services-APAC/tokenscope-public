-- 0153: client_connection_setting.marketplace_source refuses `%`.
--
-- 0151 stated that the CHECKs refuse every shell metacharacter, but its
-- marketplace_source pattern allowed `%` (for percent-encoded URL paths).
-- cmd.exe expands %NAME% even inside double quotes, and the dialog shows this
-- value in a command a Windows user pastes into a terminal
-- (`copilot plugin marketplace add <source>`), so `%` is refused like the rest.
-- The app layer (shared/connect.ts, HTTPS_GIT_URL) refuses it too.
--
-- 0151's own CHECK is replaced, not edited: 0151 has already run. A row saved
-- with `%` since 0151 makes ADD CONSTRAINT fail and the deploy stop, by intent:
-- the value is not rewritten behind the admin's back. Clear it from the admin
-- page (or delete the row, which restores the defaults) and redeploy.

ALTER TABLE client_connection_setting
  DROP CONSTRAINT IF EXISTS client_connection_setting_marketplace_source_check;

ALTER TABLE client_connection_setting
  ADD CONSTRAINT client_connection_setting_marketplace_source_check CHECK (
    length(marketplace_source) <= 512
    AND marketplace_source ~ '^[A-Za-z0-9._~:/-]+$'
  );
