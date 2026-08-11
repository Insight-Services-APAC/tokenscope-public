-- 0091: rewrite v_cost_drift so it survives the provider-cost cutover.
-- Design: docs/design/provider-cost-precedence.md ("Open before implementation"
-- item 2 — "the cost-drift view needs a small rewrite of its own"). This file IS
-- that sub-design.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- v_cost_drift (mig 0045, re-created verbatim by mig 0055) exists to answer one
-- question: HOW FAR IS OUR RATE CARD FROM WHAT THE PROVIDER SAYS IT COST? It
-- answered it by comparing the two numbers where they happened to live:
--
--     rate_card_cost_usd = SUM(cost_usd)                     -- our estimate
--     law_cost_usd       = MAX(metadata->>'law_cost_usd')    -- the provider
--     drift_usd          = rate_card_cost_usd - law_cost_usd
--
-- The provider-cost change moves the PROVIDER's figure into cost_usd (sliced
-- across the span's token-type rows so it sums back to exactly the provider
-- total). Left alone, the view would then compute
--
--     SUM(provider slice) - MAX(provider figure) ≈ 0
--
-- for every new row — a tautology, not a diagnostic. The card would go green and
-- STAY green precisely when the rate card is most wrong, which is the opposite of
-- what it is for. The operands did not change MEANING; they changed ADDRESS.
--
-- ── TWO VINTAGES, FOREVER ──────────────────────────────────────────────────
-- History is deliberately NOT re-costed (COST-8 / design §"What this does not
-- change": rows are frozen on write, and re-costing in place would force a
-- `WHERE NOT superseded` filter into every present and future reader). So the
-- ledger holds two kinds of row indefinitely and the view must read both:
--
--   RATE-CARD-PRICED row  cost_usd IS the estimate; the provider figure sits in
--                         metadata.law_cost_usd. (Every pre-cutover row, plus
--                         rung-2 fallbacks written after it.)
--   PROVIDER-PRICED row   cost_usd is the provider's own figure; the rate-card
--                         estimate must have been persisted alongside it, or the
--                         comparison is unrecoverable — rate_card_id is NULL on
--                         these rows, so nothing can re-derive it after the fact.
--
-- ── THE CONTRACT THIS VIEW READS ───────────────────────────────────────────
-- The read joiner persists the per-ROW rate-card estimate as
--
--     metadata.rate_card_cost_usd    -- PER ROW (same units, same grain as
--                                    -- cost_usd on that row). Read as
--                                    -- ->>'…'::numeric, so a JSON number and a
--                                    -- numeric-as-string are both accepted —
--                                    -- deliberate, because JS floats round-trip
--                                    -- through JSON badly and the joiner may
--                                    -- prefer to hand over an exact decimal
--                                    -- string.
--
-- PER ROW, not per span, and deliberately so: the per-row value is exactly the
-- number that USED to be written into cost_usd, so it preserves the full
-- pre-cutover information (the per-token-type estimate) rather than only its
-- total. A per-span total would be strictly lossier and cost the same to store.
-- Note the asymmetry with metadata.law_cost_usd, which the KQL mv-expand
-- duplicates onto every row of the span and which is therefore aggregated with
-- MAX: the estimate is SUMmed, the provider figure is MAXed.
--
-- IF THE KEY IS ABSENT the span simply produces no drift row, exactly as
-- pre-0045 rows do today (see the HAVING clause). Reporting nothing is the only
-- honest option: emitting a drift computed against cost_usd would print ~0 and
-- assert "the rate card agrees with the provider" on evidence we do not have.
--
-- ── WHICH RUNG PRICED A ROW ────────────────────────────────────────────────
-- One predicate, used everywhere below:
--
--     provider-priced  :=  rate_card_id IS NULL OR cost_basis = 'provider-reported'
--
-- Both halves are load-bearing:
--   * rate_card_id IS NULL is exact for every vintage. A rate-card-priced
--     claude-code row has ALWAYS pinned a card — the joiner skips the span
--     outright when no card resolves — so a NULL here can only mean the row was
--     priced by something other than the card. (Copilot rows also carry NULL,
--     which is why the view is filtered to tool = 'claude-code'.)
--   * cost_basis = 'provider-reported' is the explicit marker.
--   * ORing them matters because cost_basis is OVERLOADED: the same column also
--     carries 'telemetry-only' for backfill provenance (mig 0045 / ADR-0005
--     slice 3). A backfilled span that the provider priced is stamped
--     'telemetry-only', so a cost_basis-only test would misread it as an
--     estimate and hand back the tautological ~0 this rewrite exists to prevent.
--
-- ── SIGN CONVENTION IS UNCHANGED ───────────────────────────────────────────
-- drift_usd stays `our estimate - the provider`, so positive still means "the
-- rate card over-prices" for BOTH vintages, and the existing consumer arithmetic
-- (ABS(drift)/law_cost_usd in the diagnostics endpoint) keeps its meaning across
-- the split. Existing output columns keep their names and order; the two new
-- ones are appended:
--
--   booked_cost_usd  SUM(cost_usd) — what the ledger actually charges. For a
--                    provider-priced span this must equal law_cost_usd; a
--                    difference is a SLICING bug (the residue allocation), which
--                    nothing else would catch.
--   priced_by        'provider' | 'rate-card' | 'mixed' — the span's vintage, so
--                    a reader can tell an old comparison from a new one. 'mixed'
--                    is reachable only by a span half-written across the cutover
--                    (ON CONFLICT DO NOTHING keeps the early rows); it is
--                    surfaced rather than hidden because the per-row CASE handles
--                    it correctly and a silent bucket would be worse.
--
-- ── INDEXING DECISION: NO INDEX. Deliberate. ───────────────────────────────
-- The question posed by the design ("whether the JSONB read wants an index") is
-- answered NO, on four grounds:
--
--  1. The JSONB touch is a PROJECTION over an already-bounded set, not a search.
--     The only JSONB predicate is `metadata ? 'law_cost_usd'`, and it is applied
--     after the real selectivity has already been spent.
--  2. attribution_record is RANGE-partitioned monthly on ts_event (mig 0055) and
--     ts_event is a GROUPING key of this view. The sole consumer filters
--     `ts_event >= now() - interval '7 days'`; that qualifier pushes through the
--     aggregation (it references only grouping columns and now() is STABLE, not
--     volatile) down onto the partition scans. VERIFIED on PG16 against the
--     migrated schema: the plan carries the ts_event filter into every leaf scan
--     and reports `Subplans Removed: 13` — runtime pruning drops every partition
--     that lies entirely below the cutoff. What is left is the current month,
--     the previous month when the window straddles a boundary, the pre-created
--     FUTURE months (unprunable — the predicate has no upper bound — but empty
--     by definition of "now"), and the default catch-all. So the data actually
--     read is bounded by one month. Bounding the scan is what an index would
--     have been for, and partitioning already did it.
--  3. A GIN index on metadata would tax the hottest write path in the system —
--     the joiner inserts ~4 rows per span, every span, and GIN insert cost is
--     not small — to speed up a diagnostics card that is read by an admin a
--     handful of times a day. mig 0054 (attribution_index_diet) deliberately
--     REMOVED indexes from this table; adding one back for a read this cold
--     would reverse a decision made on measurement.
--  4. A STORED generated column is worse still: adding one to a partitioned
--     table rewrites EVERY partition under an ACCESS EXCLUSIVE lock. That is a
--     migration-shaped outage in exchange for a projection.
--
-- REVISIT TRIGGER (write it down so the next person does not re-argue it): if a
-- single month's partition exceeds ~10M attribution rows, or the diagnostics
-- drift query is measured over ~500ms, add a PARTIAL btree
--     CREATE INDEX ... ON attribution_record (ts_event)
--       WHERE tool = 'claude-code' AND metadata ? 'law_cost_usd';
-- which is far cheaper on write than GIN and matches the actual predicate. Do
-- not reach for GIN unless a query starts SEARCHING inside metadata.
--
-- Idempotent: DROP IF EXISTS + CREATE (rather than CREATE OR REPLACE, which
-- cannot tolerate a column-type change and would fail cryptically on re-run
-- against a partially-migrated DB). Nothing depends on this view — it is read by
-- server/api/v1/admin/diagnostics/index.get.ts and by tests, never by another
-- view — so the drop is safe.

DROP VIEW IF EXISTS v_cost_drift;

-- security_invoker (PG15+): run with the QUERYING role's RLS, matching the
-- v_effective_spend / v_finance_reportable_spend convention (mig 0039).
CREATE VIEW v_cost_drift
WITH (security_invoker = true) AS
SELECT
  instance_id,
  conversation_key,
  ts_event,
  span_key,
  MAX(model)                                              AS model,
  -- Our estimate for the span, whichever vintage the rows are.
  SUM(rate_card_row_usd)                                  AS rate_card_cost_usd,
  -- The provider's figure. Duplicated onto every token-type row by the KQL
  -- mv-expand, so MAX (never SUM — that would 4x it).
  MAX(law_row_usd)                                        AS law_cost_usd,
  SUM(rate_card_row_usd) - MAX(law_row_usd)               AS drift_usd,
  -- What the ledger actually charges for this span.
  SUM(cost_usd)                                           AS booked_cost_usd,
  CASE
    WHEN bool_and(provider_priced)     THEN 'provider'
    WHEN bool_and(NOT provider_priced) THEN 'rate-card'
    ELSE 'mixed'
  END                                                     AS priced_by
FROM (
  SELECT
    instance_id,
    COALESCE(claude_session_id, ''::text)                 AS conversation_key,
    ts_event,
    COALESCE(source_run_id, ''::text)                     AS span_key,
    model,
    cost_usd,
    (metadata ->> 'law_cost_usd'::text)::numeric          AS law_row_usd,
    (rate_card_id IS NULL OR cost_basis = 'provider-reported'::text)
                                                          AS provider_priced,
    -- The per-row rate-card ESTIMATE. For a rate-card-priced row that is
    -- cost_usd itself (its pre-cutover meaning, unchanged). For a
    -- provider-priced row cost_usd holds the provider's number instead, so the
    -- estimate can only come from what the joiner persisted; NULL here (key
    -- absent) propagates to the HAVING below and drops the span.
    CASE
      WHEN rate_card_id IS NULL OR cost_basis = 'provider-reported'::text
        THEN (metadata ->> 'rate_card_cost_usd'::text)::numeric
      ELSE cost_usd
    END                                                   AS rate_card_row_usd
  FROM attribution_record
  WHERE tool = 'claude-code'::text
    AND metadata ? 'law_cost_usd'::text
) s
GROUP BY instance_id, conversation_key, ts_event, span_key
-- Degrade cleanly, never silently: if ANY row of the span is provider-priced
-- without a persisted estimate, the whole span drops out rather than
-- contributing a partial SUM (SUM ignores NULLs, which would under-report the
-- estimate and manufacture drift out of nothing).
HAVING bool_and(rate_card_row_usd IS NOT NULL);

COMMENT ON VIEW v_cost_drift IS
  'Per-span rate-card-vs-provider comparison, spanning both cost vintages (mig 0091). rate_card_cost_usd = our estimate (cost_usd for rate-card-priced rows; metadata.rate_card_cost_usd for provider-priced ones), law_cost_usd = the provider figure, drift_usd = estimate - provider (positive = the card over-prices). booked_cost_usd = what the ledger charges. priced_by = which rung priced the span. A provider-priced span with no persisted estimate yields NO row — silence, never a tautological zero.';
