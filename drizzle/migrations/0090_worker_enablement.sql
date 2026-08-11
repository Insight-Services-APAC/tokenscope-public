-- 0090: worker_enablement — an ADMIN-CONTROLLED per-worker on/off switch.
--
-- WHY. Until now the only way to stop a misbehaving scheduled worker was to edit
-- infra/modules/worker-jobs.bicep and redeploy. That is a slow, infra-shaped lever
-- for what is a product/operational decision, and it means a worker whose real-world
-- behaviour is unproven can only be evaluated by shipping it hot. This makes
-- activation a runtime, admin-owned, audited decision.
--
-- WHY A TABLE, NOT governance_setting: that table is deliberately NUMERIC-only
-- ("a future non-numeric dial earns its own column, not a type erasure" — mig 0049).
-- This is per-worker boolean state with its own updated_by/at audit trail, so it
-- earns its own table — the same rationale mig 0087 (report_visibility) and mig 0083
-- (directory-exclusion) used.
--
-- ABSENT ROW ⇒ ENABLED. Deliberate, and the inverse of a feature flag:
--   * behaviour on upgrade is byte-identical to today for every existing worker
--     (nothing silently stops running because a row is missing);
--   * a rollback that DROPS this table degrades to "everything scheduled runs",
--     which is exactly today's behaviour, not an outage;
--   * turning something OFF is therefore always an explicit, attributable act.
-- The one seeded row is the exception that proves it — see below.
--
-- The cron still fires when a worker is disabled; dispatchWorker short-circuits and
-- records a 'skipped' worker_run so the ledger shows WHY nothing happened, rather
-- than a silent gap that looks identical to the never-scheduled trap this whole
-- epic exists to close.

CREATE TABLE IF NOT EXISTS worker_enablement (
  worker_name TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL,
  -- Operator note: WHY it was turned off. Shown in the admin UI and the skip record
  -- so the next person does not have to guess (or re-enable it blindly).
  reason      TEXT,
  updated_by  UUID REFERENCES teammate(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE worker_enablement IS
  'Admin-controlled per-worker on/off switch, checked by dispatchWorker. ABSENT ROW = ENABLED (so a missing row or a dropped table degrades to today behaviour). Disabling is an explicit, audited act; the cron still fires and a skipped worker_run is recorded so the ledger shows why.';

-- The ONE seeded row. heartbeat-coverage has never run in any environment, so its
-- false-positive rate against real data is unmeasured, and /tokenscope:backfill
-- re-emits with ORIGINAL timestamps (which read as "uncovered" against the current
-- enrolment) — it could paint "unverified spend" badges on real developers'
-- homepages on its first tick. Ship it scheduled but OFF; an admin enables it from
-- Admin -> Diagnostics ("Worker enable/disable" card) once the read-only count in
-- docs/design/stranded-workers-lifecycle.md has been eyeballed. This replaces the
-- "pre-deploy gate you must remember" with a switch that is on the screen.
INSERT INTO worker_enablement (worker_name, enabled, reason)
VALUES (
  'heartbeat-coverage',
  FALSE,
  'Never run in any environment: false-positive rate unmeasured, and backfilled spend reads as uncovered. Enable after reviewing the coverage count (docs/design/stranded-workers-lifecycle.md).'
)
ON CONFLICT (worker_name) DO NOTHING;
