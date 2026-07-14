-- 0074: reconciliation_backfill_request — the on-demand "backfill provider usage from date X" queue.
--
-- The steady-state reconciliation-sync pulls only [yesterday, today] (cheap hourly re-pull). To
-- surface §A unaccounted usage for HISTORICAL days, an admin enqueues a backfill over a chosen
-- window; the reconciliation-backfill worker claims it, runs the SAME adapter pull + engine over
-- [start_date, end_date], then the §A reconcile, and stamps status. Idempotent (the engine +
-- actual_spend/reconciliation_record upserts are idempotent), so a re-run over a window is safe.
--
-- Grain mirrors reconciliation-sync's credential grain: anthropic → org, github → enterprise.
-- No RLS: management is app-gated by requireRole('admin','global-finops') (same as provider_org /
-- provider_enterprise); the worker runs as the service role.

CREATE TABLE reconciliation_backfill_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  -- the credential grain: 'org' (anthropic external_org_id) | 'enterprise' (github external_id)
  target_kind text NOT NULL,
  external_ref text NOT NULL,        -- external_org_id | enterprise external_id (canonical lowercase)
  display_name text,                 -- denormalised for the admin list (provider_* may be renamed later)
  start_date date NOT NULL,          -- inclusive UTC day; the 90-day cap is enforced at the endpoint
  end_date date NOT NULL,            -- inclusive UTC day (today at enqueue time)
  status text NOT NULL DEFAULT 'pending',
  requested_by uuid REFERENCES teammate(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,            -- set when the worker claims it (stale-claim re-pickup uses this)
  started_at timestamptz,
  finished_at timestamptz,
  rows_written integer NOT NULL DEFAULT 0,
  error text,
  run_id uuid,                       -- the worker_run that processed it (drill-down; no FK by design)
  CONSTRAINT rbr_provider_chk CHECK (provider IN ('anthropic', 'github')),
  CONSTRAINT rbr_target_kind_chk CHECK (target_kind IN ('org', 'enterprise')),
  CONSTRAINT rbr_status_chk CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  CONSTRAINT rbr_window_chk CHECK (start_date <= end_date)
);

-- The worker claims the oldest claimable row; index the claim predicate.
CREATE INDEX reconciliation_backfill_request_claim_idx
  ON reconciliation_backfill_request (status, requested_at);

-- At most ONE in-flight (pending|running) request per scope — the DB backstop for the
-- endpoint's pre-check, so two concurrent POSTs can't both enqueue (TOCTOU). lower() mirrors
-- the canonical-casing key used elsewhere for provider refs.
CREATE UNIQUE INDEX reconciliation_backfill_request_inflight_unique
  ON reconciliation_backfill_request (provider, lower(external_ref))
  WHERE status IN ('pending', 'running');
