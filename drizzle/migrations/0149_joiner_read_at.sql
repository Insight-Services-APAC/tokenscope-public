-- 0149 — when the read joiner last attempted each device.
--
-- The scheduled azure-monitor-read tick selects at most NUXT_JOINER_INSTANCE_CAP
-- devices and stops starting new ones at its deadline, so on a large fleet it
-- cannot read every eligible device every tick. Ordering the selection by this
-- column, least recently read first, makes the cap and the deadline rotate
-- through every eligible device instead of shedding the same ones each tick.
-- Design: docs/design/scaling-to-1000-users.md, Phase 1 item 2.
--
-- Stamped by the scheduled tick only, once, at its end, for every device it
-- attempted (whether that device's read succeeded or failed). Operator-scoped
-- runs, forced deep reads and telemetry-recovery do not stamp it.
--
-- instance_attestation is one row per enrolled device (not partitioned), so the
-- column is added without a default and needs no backfill: NULL means "never
-- read by a scheduled tick" and sorts first.
ALTER TABLE instance_attestation
  ADD COLUMN joiner_read_at timestamptz NULL;

COMMENT ON COLUMN instance_attestation.joiner_read_at IS
  'When a scheduled azure-monitor-read tick last attempted this device (success or failure). Orders the joiner selection least-recently-read first. NULL = never attempted by a scheduled tick.';
