-- 0093: telemetry_recovery_request — the admin-reachable WIDENED READ queue.
--
-- WHAT WAS MISSING. server/azure/reader.ts honours `opts.lookbackDays` (default 7,
-- max 90) — the lever that re-reads already-ingested telemetry older than a week
-- and re-joins it. It was reachable ONLY through a signed HMAC worker body:
-- `azure-monitor-read` is deliberately absent from UI_TRIGGERABLE_WORKER_NAMES,
-- and no UI passes worker opts at all. So a backlog older than seven days could
-- not be recovered from the product, and a signed re-run WITHOUT the lever
-- recovers exactly seven days while reporting success indistinguishably from a
-- full recovery. That last part is the dangerous half: the operator's
-- verification passes on a near-zero recovery.
--
-- WHY A QUEUE AND NOT A BUTTON. The run-worker HTTP endpoint sits behind a ~120s
-- gateway (a 187s slice 504'd; the handler keeps running and holds the
-- single-flight lock, so every later call 409s). A 90-day read across a set of
-- instances WILL exceed that. This follows the precedent set by
-- reconciliation_backfill_request (mig 0074): the admin ENQUEUES the intent, and
-- a cron-driven worker drains it in slices within a wall-clock budget, persisting
-- a cursor so the next invocation resumes. No synchronous long request exists to
-- time out.
--
-- WHY azure-monitor-read IS STILL NOT UI-TRIGGERABLE. That safelist's contract is
-- "idempotent workers an admin has a real reason to force, at their DEFAULT
-- settings" — adding it wholesale would expose the fleet-wide scheduled selection
-- as a one-click button, which is the blast radius the list exists to withhold.
-- What an operator actually needs is narrower: a re-read SCOPED to named
-- instances at a stated window. That is what this queue carries, and every row is
-- RBAC-gated, same-origin-checked and audited at enqueue.
--
-- No RLS, and the gate is split by side: enqueueing is requireRole('global-finops')
-- + assertSameOrigin (it spends query budget and serialises the queue), while
-- reading status is requireRole('admin', 'global-finops') -- the same tier as every
-- other read-only diagnostics endpoint it sits beside (attribution-gaps, network,
-- instance-telemetry). The worker runs as the service role.
--
-- Row-level scoping would have nothing to scope ON: a recovery request is a GLOBAL
-- operation, enqueued only by a global role and covering instances across regions,
-- so it belongs to no single region. A region-scoped admin therefore reads every
-- row -- deliberately: the `in_flight` answer derived here is what decides whether
-- the enqueue button is offered at all, and a per-region view of a globally
-- serialised queue would tell one operator the queue was free while another was
-- draining it. What is NOT widened is identity: requested_by resolves through the
-- RLS-protected `teammate` join, so an out-of-scope requester surfaces as NULL
-- rather than an email. Keep it that way; `reason` is operator free text and should
-- be treated as visible to every admin.

CREATE TABLE telemetry_recovery_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The instances to re-read, in order. An ARRAY rather than a child table
  -- because the set is small (capped at the endpoint), immutable once enqueued,
  -- and only ever consumed positionally by the cursor below.
  instance_ids uuid[] NOT NULL,

  -- The reader's OUTER scan bound for this recovery, in days. The whole point of
  -- the row: without it a re-run reaches back 7 days and says "succeeded".
  lookback_days integer NOT NULL,

  -- RESUME POINT: how many of instance_ids have been fully processed. The worker
  -- advances it after each slice, so a budget-exhausted or crashed invocation
  -- resumes here instead of re-reading (idempotent, but not free) from the start.
  cursor_index integer NOT NULL DEFAULT 0,

  status text NOT NULL DEFAULT 'pending',
  reason text,                       -- operator's note: why this recovery was run
  requested_by uuid REFERENCES teammate(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,            -- last-touched heartbeat (observability)
  started_at timestamptz,
  finished_at timestamptz,
  -- OUTCOME, recorded so "did the recovery actually recover anything" is
  -- answerable from the row rather than inferred from a green status. A run that
  -- processes every instance and writes zero rows is a legitimate and important
  -- result — it means the backlog was not where we thought it was.
  instances_processed integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  error text,
  run_id uuid,                       -- the worker_run that processed it (no FK by design)

  CONSTRAINT trr_status_chk CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  -- Mirrors server/azure/reader.ts MAX_LOOKBACK_DAYS (90 = the longest retention
  -- we provision). A wider request could only scan empty range at real cost.
  CONSTRAINT trr_lookback_chk CHECK (lookback_days BETWEEN 1 AND 90),
  CONSTRAINT trr_scope_chk CHECK (cardinality(instance_ids) > 0),
  CONSTRAINT trr_cursor_chk CHECK (cursor_index >= 0 AND cursor_index <= cardinality(instance_ids))
);

-- The worker claims the oldest claimable row; index the claim predicate.
CREATE INDEX telemetry_recovery_request_claim_idx
  ON telemetry_recovery_request (status, requested_at);

-- At most ONE in-flight recovery GLOBALLY (not per-scope, unlike mig 0074): a
-- widened read is the most expensive thing this system asks of Log Analytics, and
-- two concurrent campaigns would contend for the same query budget while both
-- reported progress. Serialising them is the honest behaviour, and the DB backstop
-- means two concurrent POSTs cannot both enqueue (TOCTOU).
CREATE UNIQUE INDEX telemetry_recovery_request_inflight_unique
  ON telemetry_recovery_request ((true))
  WHERE status IN ('pending', 'running');

COMMENT ON TABLE telemetry_recovery_request IS
  'Admin-enqueued widened re-read of already-ingested telemetry (reader lookbackDays), drained in slices by the telemetry-recovery worker so no single request meets the ~120s worker gateway ceiling.';
