-- 0092: per-instance CLIENT VERSION capture on instance_attestation.
--
-- WHY. On 2026-07-24 the attribution-gap detector flagged a live Dev device: last
-- emitted 2026-07-24, last attributed 2026-07-16 — eight days behind. The very
-- first triage question, "is that device running an old plugin / an old Claude
-- Code?", was UNANSWERABLE from data, because nothing recorded either version per
-- device. That is not a one-off: every version-specific incident this project has
-- had (the 2.1.191 chunked-OTLP transport regression, the durable revert-key
-- wedge, the forwarder self-heal) ended in "go ask the human what version they are
-- on". Three columns close it.
--
-- TRUST MODEL — READ THIS BEFORE USING THESE COLUMNS. Both version strings are
-- CLIENT-ASSERTED: the device puts them in a request header and we store what it
-- said. They are DIAGNOSTIC HINTS ONLY. They must NEVER be used as an
-- authorisation input (a gate on emitting / minting / reading), nor as a costing
-- or billing input. Nothing about them is attested — a device can claim any
-- version, and a device that lies is indistinguishable from one that is honest.
-- The unspoofable teammate binding remains instance_id + the OAuth emit
-- credential; this is metadata hanging off it.
--
-- NULL IS THE MOST USEFUL VALUE. NULL means "this device has never reported a
-- version", which is precisely "the device is running a plugin build older than
-- the one that started reporting" — the population you most want to find during a
-- rollout incident. So the columns are nullable with no default and no backfill.
--
-- Captured on the /bearer mint (~every 29 minutes per live device), which already
-- stamps last_bearer_at — one extra column write on a path that already writes,
-- no new endpoint and no new client traffic.

ALTER TABLE instance_attestation
  -- The TokenScope plugin version the device is running, e.g. '0.1.27'. From the
  -- plugin's own .claude-plugin/plugin.json, read by the helper that mints the
  -- bearer — so it is the version of the code that ACTUALLY ran, not the version
  -- someone believes is installed. CLIENT-ASSERTED (see above).
  ADD COLUMN client_plugin_version text,
  -- The agent CLI version the device is running, e.g. '2.1.212' (Claude Code).
  -- CLIENT-ASSERTED (see above).
  ADD COLUMN client_cli_version text,
  -- When the two values above were last reported. NOT redundant with
  -- last_bearer_at: a device that keeps minting but STOPS reporting versions (a
  -- downgrade to a pre-reporting build) advances last_bearer_at while leaving this
  -- stamp behind, which is exactly how you spot a stale reading instead of
  -- trusting it. NULL whenever both version columns are NULL.
  ADD COLUMN client_version_at timestamptz;

-- What makes "which versions are in the fleet" cheap is that these are COLUMNS on
-- a small table rather than keys inside `notes` jsonb: the rollup
--   SELECT client_plugin_version, count(*) FROM instance_attestation GROUP BY 1
-- is an ordinary aggregate that anyone can run and read. This index does NOT
-- speed that up (a full grouping reads every row either way) and is not claimed
-- to. It serves the other question an operator asks during a rollout — "which
-- devices are on version X" / "which are NOT on X" — as an equality lookup.
-- Partial because the NULL population ("never reported") is answered by the
-- IS NULL branch and would only bloat the index.
CREATE INDEX instance_attestation_client_plugin_version_idx
  ON instance_attestation (client_plugin_version)
  WHERE client_plugin_version IS NOT NULL;

COMMENT ON COLUMN instance_attestation.client_plugin_version IS
  'CLIENT-ASSERTED TokenScope plugin version (diagnostic hint only — never an authorisation or costing input). NULL = never reported.';
COMMENT ON COLUMN instance_attestation.client_cli_version IS
  'CLIENT-ASSERTED agent CLI version, e.g. Claude Code 2.1.212 (diagnostic hint only — never an authorisation or costing input). NULL = never reported.';
COMMENT ON COLUMN instance_attestation.client_version_at IS
  'When the client_* version columns were last reported. Lags last_bearer_at when a device stops reporting versions.';
