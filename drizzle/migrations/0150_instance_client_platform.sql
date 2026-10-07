-- 0150: per-instance CLIENT PLATFORM, SURFACE and SETUP MODE on instance_attestation
-- (#412, #408 S3).
--
-- WHY. "Is Desktop / Windows working?" could only be answered by asking people.
-- The client now states its platform (`<os>-<arch>`, Node vocabulary:
-- darwin-arm64, linux-x64, win32-x64) and launch surface (Claude Code's
-- CLAUDE_CODE_ENTRYPOINT, e.g. cli / sdk-cli; Copilot's app / cli) on the /bearer
-- mint, beside the version headers of 0092. The setup redeem states whether it
-- configured the device fully (the Node redeem) or emit-only (the PowerShell
-- redeem on a Windows device without Node: no status line, backfill or repo pin).
--
-- TRUST MODEL: identical to 0092. CLIENT-ASSERTED, DIAGNOSTIC HINTS ONLY — never an
-- authorisation input, never a costing input. Nothing may gate on these columns.
--
-- NULL = never reported. No default, no backfill.
--
-- Write rules, so the data can be read correctly:
--   - client_platform / client_surface: written by /bearer only when reported,
--     never nulled by a mint (bearer.get.ts). client_version_at (0092) is the
--     stamp of the last claim of ANY of the four client_* fields.
--   - setup_mode: written by /setup/redeem on EVERY successful redeem, NULL when
--     that redeem did not state a recognised mode. A redeem replaces the device's
--     credential and configuration, so the mode describes the LATEST setup; an
--     older reading would describe a configuration that no longer exists.
--
-- Bounded like the version columns: the server sanitiser rejects anything over 40
-- characters (setup_mode is a closed set), and the CHECKs keep that true for any
-- other writer.

ALTER TABLE instance_attestation
  ADD COLUMN client_platform text,
  ADD COLUMN client_surface text,
  ADD COLUMN setup_mode text;

ALTER TABLE instance_attestation
  ADD CONSTRAINT instance_attestation_client_platform_len
    CHECK (client_platform IS NULL OR length(client_platform) <= 40),
  ADD CONSTRAINT instance_attestation_client_surface_len
    CHECK (client_surface IS NULL OR length(client_surface) <= 40),
  ADD CONSTRAINT instance_attestation_setup_mode_check
    CHECK (setup_mode IS NULL OR setup_mode IN ('full', 'emit-only'));

COMMENT ON COLUMN instance_attestation.client_platform IS
  'CLIENT-ASSERTED <os>-<arch> in Node vocabulary, e.g. win32-x64 (diagnostic hint only — never an authorisation or costing input). NULL = never reported.';
COMMENT ON COLUMN instance_attestation.client_surface IS
  'CLIENT-ASSERTED launch surface: CLAUDE_CODE_ENTRYPOINT (cli, sdk-cli, ...) or Copilot app/cli (diagnostic hint only). NULL = never reported.';
COMMENT ON COLUMN instance_attestation.setup_mode IS
  'CLIENT-ASSERTED mode of the LATEST setup redeem: full | emit-only (diagnostic hint only). NULL = that redeem did not report one.';
