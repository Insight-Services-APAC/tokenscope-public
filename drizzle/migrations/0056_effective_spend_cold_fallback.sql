-- 0056: finance cold-fallback (ledger-retention epic, Phase E)
--
-- After archive-ledger (0055 + archive-ledger worker) DETACH+DROPs a cold
-- monthly partition, that month's raw attribution_record rows are gone. Finance
-- reads v_effective_spend / v_finance_reportable_spend, so without a fallback
-- those views silently lose all archived-period spend.
--
-- Fix: v_effective_spend reads the durable rollup (spend_rollup_daily) for
-- periods strictly OLDER than an explicit archived-through watermark, and raw
-- for everything from the watermark forward. The watermark lives in a singleton
-- row (ledger_archive_state) advanced ONLY by the archive-ledger worker, once a
-- partition is exported+verified+dropped.
--
-- Why a stored watermark and not a live min(ts_event): a late/replayed row whose
-- ts_event falls in an already-dropped month routes to the DEFAULT partition. A
-- live-min boundary would snap backwards to that month, excluding its entire
-- rollup (period_start < min) while the raw branch served only the one stray row
-- — the whole archived month would vanish from finance (review C1). With the
-- watermark, the raw branch is gated `ts_event >= watermark`, so a stray cold
-- row is simply excluded (the month stays served from the rollup) instead of
-- corrupting the boundary. Overlap-free + gap-free in every state:
--   * Nothing archived (watermark NULL => -infinity) -> cold branch matches no
--     rollup period; raw branch matches everything. Byte-for-byte the pre-0056
--     raw+reconciliation view.
--   * Month archived -> watermark = that month's end. Exactly the dropped
--     periods come from the rollup; raw serves >= watermark. No double-count.
-- Archival is contiguous (the worker halts on a data-present skip), so a single
-- watermark always describes a gap-free cold region.
--
-- spend_class split: v_effective_spend is per-row estimated|indicative; a rollup
-- CELL carries total_cost_usd plus indicative_cost_usd (the telemetry-only
-- subset, keyed on cost_basis — the same axis spend_class uses). We emit up to
-- two view rows per cold cell so v_finance_reportable_spend's
-- `spend_class <> 'indicative'` filter keeps excluding the advisory portion:
--   * estimated row : cost = total - indicative
--   * indicative row: cost = indicative
-- The estimated row also carries a zero-cost cell that still has tokens (free /
-- sub-rounding usage) so those tokens are never lost; a purely-indicative cell
-- (no estimated portion) instead lets the indicative row carry the tokens. Tokens
-- always sum to the cell's total_tokens, on exactly one row. source = 'rollup'
-- makes cold-served rows identifiable.

-- Singleton archive watermark (one row). archived_through = exclusive lower
-- bound of the HOT window: raw with ts_event < it has been retired and is served
-- from the rollup. NULL until the first partition is dropped.
CREATE TABLE ledger_archive_state (
  id text PRIMARY KEY DEFAULT 'singleton',
  archived_through timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_archive_state_singleton CHECK (id = 'singleton')
);
INSERT INTO ledger_archive_state (id, archived_through) VALUES ('singleton', NULL);

DROP VIEW IF EXISTS v_finance_reportable_spend;
DROP VIEW IF EXISTS v_effective_spend;

CREATE VIEW v_effective_spend WITH (security_invoker = true) AS
  -- raw (hot) attribution — only from the archive watermark forward
  SELECT ar.id AS source_id, 'attribution'::text AS source, ar.teammate_id, ar.region_id,
         ar.org_unit_id, ar.cost_owning_unit_id, ar.project_id, ar.tool, ar.model,
         NULL::text AS category, ar.ts_event AS occurred_at, ar.cost_usd, ar.tokens,
         CASE WHEN ar.cost_basis = 'telemetry-only'::text THEN 'indicative'::text ELSE 'estimated'::text END AS spend_class
    FROM attribution_record ar
   WHERE ar.ts_event >= COALESCE((SELECT archived_through FROM ledger_archive_state WHERE id = 'singleton'), '-infinity'::timestamptz)
  UNION ALL
  -- rollup (cold) — estimated portion of periods older than the watermark.
  -- Emitted when there is estimated cost, OR when the cell is non-indicative but
  -- still has tokens (zero-cost free usage) so no tokens are dropped.
  SELECT srd.id AS source_id, 'rollup'::text AS source, srd.teammate_id, srd.region_id,
         srd.org_unit_id, srd.cost_owning_unit_id, srd.project_id, srd.tool, srd.model,
         NULL::text AS category, srd.period_start AS occurred_at,
         (srd.total_cost_usd - srd.indicative_cost_usd) AS cost_usd, srd.total_tokens AS tokens,
         'estimated'::text AS spend_class
    FROM spend_rollup_daily srd
   WHERE srd.period_start < COALESCE((SELECT archived_through FROM ledger_archive_state WHERE id = 'singleton'), '-infinity'::timestamptz)
     AND ((srd.total_cost_usd - srd.indicative_cost_usd) <> 0
          OR (srd.indicative_cost_usd = 0 AND srd.total_tokens <> 0))
  UNION ALL
  -- rollup (cold) — indicative (telemetry-only) portion
  SELECT srd.id AS source_id, 'rollup'::text AS source, srd.teammate_id, srd.region_id,
         srd.org_unit_id, srd.cost_owning_unit_id, srd.project_id, srd.tool, srd.model,
         NULL::text AS category, srd.period_start AS occurred_at,
         srd.indicative_cost_usd AS cost_usd,
         CASE WHEN (srd.total_cost_usd - srd.indicative_cost_usd) = 0 THEN srd.total_tokens ELSE 0::bigint END AS tokens,
         'indicative'::text AS spend_class
    FROM spend_rollup_daily srd
   WHERE srd.period_start < COALESCE((SELECT archived_through FROM ledger_archive_state WHERE id = 'singleton'), '-infinity'::timestamptz)
     AND srd.indicative_cost_usd <> 0
  UNION ALL
  -- applied reconciliation (unchanged)
  SELECT rr.id AS source_id, 'reconciliation'::text AS source, rr.teammate_id, rr.region_id,
         rr.org_unit_id, rr.cost_owning_unit_id, rr.project_id, NULL::text AS tool, NULL::text AS model,
         rr.category, (rr.period_date::timestamp without time zone AT TIME ZONE 'UTC'::text) AS occurred_at,
         rr.delta_usd AS cost_usd, 0::bigint AS tokens, rr.spend_class
    FROM reconciliation_record rr
   WHERE rr.status = 'applied'::text;

CREATE VIEW v_finance_reportable_spend WITH (security_invoker = true) AS
  SELECT source_id, source, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
         tool, model, category, occurred_at, cost_usd, tokens, spend_class
    FROM v_effective_spend
   WHERE spend_class <> 'indicative'::text;
