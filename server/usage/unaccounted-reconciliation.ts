/*
 * Unaccounted-usage reconciliation — docs/design/provider-billing-attribution-model.md §A.
 *
 * The provider usage API is the COMPLETE truth of a person's spend (every container,
 * enrolled or not). OTel only captures enrolled containers, so it UNDERCOUNTS. For each
 * (teammate, day, tool) this computes:
 *
 *     unaccounted = max(0, API daily total − Σ OTel captured that day)
 *
 * and upserts ONE `unaccounted_usage` row per (teammate, day, tool) — the taggable
 * "needs tagging" record. The API has no session ids, so the day is the finest grain.
 *
 * Idempotent + tag-preserving: a recompute (e.g. late OTel arriving for a day) only
 * UPDATES `cost_usd` (and the denormalised dims); it never touches `project_id` /
 * `activity` / `tagged_*`, so a record the developer already tagged keeps its tag while
 * its amount shrinks. By construction OTel-captured + unaccounted = the API total, so
 * tagging the record can never double-count.
 *
 * `GREATEST(0, …)`: if OTel OVER-estimated a day (estimate > the API usage), the delta
 * floors at 0 — §A only guarantees we never UNDER-count; an over-estimate is the
 * over-emission detector's concern, not this one's.
 *
 * PER-MODEL CHILDREN (mig 0123, reporting-consolidation/07-model-axis-subtraction-
 * build.md D1-D3): each run also replaces, in the SAME transaction, the parent's
 * `unaccounted_usage_model` rows — `cap(GREATEST(0, api_m − otel_m))` per model,
 * where api_m reads provider_usage_fact cost/token rows across ALL sources for
 * the key and otel_m is the per-model corroborated operand under the SAME
 * per-tool-cell completeness gate as the parent's. Observed subtraction, never
 * apportionment; conservation by a deterministic descending cap, never a ratio.
 * `model_gap_reason` records why a parent has no children ('provider-day-grain'
 * = only github money backs the key; 'awaiting-provider-detail' = no cost facts
 * landed yet; NULL = children exist / nothing to explain).
 *
 * Source of the API total: the `v_teammate_usage_daily` view (mig 0073, restored to the
 * complete per-(teammate, day, tool) usage truth by mig 0101 §A1) — the per-(teammate,
 * day, tool) provider USAGE truth. It encapsulates where each tool's usage lives: claude-code
 * + the non-Code Claude surfaces from actual_spend (pure-metered, bill ≈ usage); copilot-cli
 * GROSS from reconciliation_record (GitHub ai_credit/usage, per-(user, day)). Tool-agnostic —
 * adding a tool means extending the view, not this query.
 *
 * EXCEPT the DISPLAY-ONLY usage lanes (INGEST_ONLY_USAGE_TOOLS, shared/usage/surface.ts —
 * mig 0101 §A2 generalised this from the GitHub-only GITHUB_INGEST_ONLY_USAGE_TOOLS to
 * every ingest-only tool): 'copilot-agent' (mig 0086, design D4) is the OTel-INVISIBLE
 * coding-agent lane, and the seven non-Code Claude surfaces (#142) have no sessions either
 * — no session ever emits any of them, so "API − OTel" would equal the FULL amount every
 * day and every dollar would become a permanent, untaggable worklist item. They are usage
 * display only (the view + its §A display readers), never a needs-tagging record.
 * copilot-cli (interactive) semantics are unchanged: enrolled containers emit OTel, so the
 * gap is genuinely taggable usage.
 *
 * v_complete_usage's third (ingest-only) union arm (mig 0101 §A3) is what makes these
 * dollars §A-VISIBLE again (Across / Regional / Cost-Centre usage cards, velocity-watch)
 * without ever letting them back into this worklist — the exclusion below is exactly what
 * keeps the two properties (visible vs taggable) independent. See mig 0086's header and
 * mig 0101's header; pinned by tests/integration/usage/copilot-usage-completeness.test.ts.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import type * as schema from '../../drizzle/schema'
import { INGEST_ONLY_USAGE_TOOLS } from '../../shared/usage/surface'
import { laneListSql } from '../../shared/usage/vendor'
import { corroboratedOtelDaily } from './corroborated-otel'
import { sweepStaleDismissals } from '../utils/stale-dismissals'

type Db = PostgresJsDatabase<typeof schema>

export interface ReconcileUnaccountedOptions {
  /** Inclusive UTC day window [startDate, endDate] (YYYY-MM-DD). */
  startDate: string
  endDate: string
  /** Optional: reconcile a single teammate (else all). */
  teammateId?: string
}

export interface ReconcileUnaccountedResult {
  rowsUpserted: number
  /** Number of (teammate, day, tool) records that have a positive unaccounted delta. */
  recordsWithDelta: number
  totalUnaccountedUsd: number
  /**
   * Dismissals handed back to the needs-tagging queue because the amounts they
   * were made about grew materially (mig 0094 / sweepStaleDismissals). Days are
   * what THIS run revises, but the sweep is one statement pair over both item
   * kinds, so both counts are reported rather than half of them being an
   * invisible side effect. `missingSnapshots` counts swept items whose
   * dismissal carried no baseline — always 0 unless some writer skipped it.
   */
  staleDismissalsReturned: number
  staleSessionDismissalsReturned: number
  staleDismissalsMissingSnapshot: number
}

export async function reconcileUnaccountedUsage(
  db: Db,
  opts: ReconcileUnaccountedOptions,
): Promise<ReconcileUnaccountedResult> {
  const teammateFilter = opts.teammateId ? sql`AND teammate_id = ${opts.teammateId}::uuid` : sql``
  const teammateFilterOtel = opts.teammateId ? sql`AND ar.teammate_id = ${opts.teammateId}::uuid` : sql``

  /*
   * ── ONE TRANSACTION FOR THE WHOLE RECOMPUTE (mig 0119) ────────────────────
   *
   * The three statements below (upsert, orphan DELETE, orphan zero-out) used to
   * run as three separate autocommits, so a concurrent reader could observe the
   * residual set half-recomputed — after the upsert had RAISED amounts but
   * before the orphan pass REMOVED keys the provider view no longer backs. That
   * intermediate state is larger than either the before or the after.
   *
   * That was survivable while the residual only drifted by late telemetry. It
   * stops being survivable when this design lands, because excluding self-billed
   * OTel makes residuals GROW, and `budget-alert` (server/workers/budget-alert.ts)
   * evaluates project budgets on its own hourly schedule from exactly this
   * money, through v_complete_usage arm 2. A threshold crossed against a
   * half-recomputed set is not a fact about anyone's spending, and paging a PM
   * for it teaches them to ignore the alert.
   *
   * WHAT THIS GUARANTEES: no reader — budget-alert, a project page, a report —
   * can see the residual set part-way through a recompute. Each run's writes
   * become visible together or not at all.
   *
   * WHAT IT DOES NOT GUARANTEE, and deliberately does not claim to:
   *   - It does not span `over_emission`, the rollups, or the joiner's stamping.
   *     Those are separate writes; a reader can still observe this table updated
   *     and those not yet. The design's full answer is a generation-carrying
   *     restatement window (§10), which is a later increment.
   *   - It does not suppress a LEGITIMATE alert. Once a run commits, a project
   *     that really is over its cap under the corrected figures will page on the
   *     next tick. That is the intended §10 behaviour ("re-evaluate once"), not
   *     a leak: the figure was wrong and is now right.
   *   - It is not a lock. Two overlapping runs are still serialised only by the
   *     worker dispatch lock, as before.
   *
   * `sweepStaleDismissals` stays OUTSIDE the transaction on purpose — it is
   * housekeeping with its own documented fail-soft, and folding it in would let
   * a sweep failure roll back deltas that were correctly computed.
   */
  const rows = await db.transaction(async (tx) => {
    // One set-based upsert: aggregate the API total (actual_spend) and the OTel-captured
    // total (attribution_record) per (teammate, day, tool), take the floored difference,
    // upsert. project_id / activity / tagged_* are deliberately NOT in the SET (tag-preserving).
    const upserted = await tx.execute<{ id: string }>(sql`
      WITH api AS (
        SELECT teammate_id, day, tool, usage_usd AS api_usd, COALESCE(tokens, 0) AS api_tokens
        FROM v_teammate_usage_daily
        WHERE day >= ${opts.startDate}::date AND day <= ${opts.endDate}::date
          -- Display-only lanes (see header): never a taggable unaccounted record.
          AND tool NOT IN (${laneListSql(INGEST_ONLY_USAGE_TOOLS)})
          ${teammateFilter}
      ),
      -- THE shared operand (server/usage/corroborated-otel.ts). It carries the
      -- quarantine exclusion this query has always applied, PLUS the self-billed
      -- exclusion (mig 0119) applied per complete cell. Cost and tokens are gated
      -- identically — this INSERT recomputes both, and a row whose dollars and
      -- tokens described different populations would be worse than either.
      otel AS (${corroboratedOtelDaily({
        startExpr: sql`${opts.startDate}::date::timestamptz`,
        endExpr: sql`(${opts.endDate}::date + 1)::timestamptz`,
        extra: teammateFilterOtel,
        withTool: true,
        withTokens: true,
      })})
      INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source, computed_at)
      SELECT api.teammate_id, t.region_id, t.org_unit_id, api.day, api.tool,
             GREATEST(0, api.api_usd - COALESCE(otel.otel_usd, 0))::numeric(14,6) AS cost_usd,
             GREATEST(0, api.api_tokens - COALESCE(otel.otel_tokens, 0))::bigint AS tokens,
             'api-reconciled', now()
      FROM api
      JOIN teammate t ON t.id = api.teammate_id
      LEFT JOIN otel ON otel.teammate_id = api.teammate_id AND otel.day = api.day AND otel.tool = api.tool
      -- PLACEMENT IS STAMPED AT FIRST WRITE AND LEFT ALONE (issue #44).
      --
      -- region_id and org_unit_id used to be refreshed here from the teammate's
      -- CURRENT placement on every recompute, over the trailing 35-day window.
      -- That made residual placement neither point-in-time nor live but both by
      -- turns: a row followed the person for 35 days and then froze wherever it
      -- happened to be, so the same teammate-day could sit in two org units
      -- depending on when you asked. Data-Lineage.md called it "not any coherent
      -- policy", which was exact.
      --
      -- It also silently destroys a date-floored correction: an admin fixing
      -- placement from July onwards would have June rewritten to the new unit by
      -- the next tick, within the hour.
      --
      -- Money still refreshes; only the dimensions freeze — matching
      -- actual_spend, whose ON CONFLICT list has always omitted them.
      ON CONFLICT (teammate_id, day, tool) DO UPDATE SET
        cost_usd = EXCLUDED.cost_usd,
        tokens = EXCLUDED.tokens,
        computed_at = now()
      RETURNING id::text AS id
    `)

    /*
     * ── THE PER-MODEL RESIDUAL CHILDREN (mig 0123, design D1-D3) ────────────
     *
     * docs/design/reporting-consolidation/07-model-axis-subtraction-build.md.
     * Same transaction as the parent upsert, replaced WHOLESALE per parent per
     * run — so `Σ children ≤ parent` is true at every read, and a reader can
     * never see a parent recomputed against last run's children.
     *
     * The arithmetic (D3), per parent key with R = parent.cost_usd:
     *   1. `floored_m = GREATEST(0, api_m − otel_m)` — a pure subtraction of
     *      two OBSERVED per-model operands. `api_m` aggregates
     *      provider_usage_fact COST rows (cost_usd; model NOT NULL) across ALL
     *      sources for the (teammate, date, tool) key — the same
     *      source-omitting join the provider-day drawer ships
     *      (provider-day-detail.ts:43-50; mig 0121 is the index it needs).
     *      `otel_m` is corroboratedOtelDaily's new per-model form: same
     *      quarantine exclusion, same UTC day expression, and the billing_lane
     *      completeness gate computed ONCE per (teammate, day, tool) cell and
     *      applied unchanged to every model cell (r1-H1) — so the children
     *      subtract exactly the operand the parent subtracted, decomposed.
     *   2. Conservation by CAPPING, not scaling (r1-H2): walk models in
     *      descending floored_m (ties by model name ASC) and allocate
     *      `min(floored_m, R_remaining)` until R is exhausted. Deterministic,
     *      no ratios, no negative rows — a named cell is its observed
     *      subtraction, or that subtraction truncated in a drift case, never
     *      inflated. Zero-value children are dropped.
     *   3. Tokens ride the IDENTICAL pipeline over the token rows
     *      (input+output per model vs OTel tokens per model), capped against
     *      parent.tokens — cost and tokens are subtracted from their own
     *      lanes, never each other's proportions (05 Decision 4 survives).
     *
     * SCOPE: parents in this run's window that the view currently backs — by
     * construction exactly the key set the upsert above just wrote (the upsert
     * inserts/updates every in-window view key). Orphans (window parents the
     * view no longer backs) are excluded here and handled below: the undecided
     * DELETE cascades through the 0123 FK; the decided zero-out deletes its
     * parents' children in the same statement (r1-M1).
     *
     * DELETE-then-INSERT as two statements, not one WITH: data-modifying CTEs
     * in a single statement execute against one snapshot with no ordering
     * guarantee, so re-inserting a (parent, model) PK the DELETE removes in
     * the same statement can race its own unique index.
     */
    const parentScope = sql`
      SELECT u.id, u.teammate_id, u.day, u.tool, u.cost_usd, u.tokens
      FROM unaccounted_usage u
      WHERE u.day >= ${opts.startDate}::date AND u.day <= ${opts.endDate}::date
        ${opts.teammateId ? sql`AND u.teammate_id = ${opts.teammateId}::uuid` : sql``}
        AND EXISTS (
          SELECT 1 FROM v_teammate_usage_daily v
          WHERE v.teammate_id = u.teammate_id AND v.day = u.day AND v.tool = u.tool
            AND v.tool NOT IN (${laneListSql(INGEST_ONLY_USAGE_TOOLS)})
        )`
    await tx.execute(sql`
      WITH parent AS (${parentScope})
      DELETE FROM unaccounted_usage_model m USING parent p WHERE m.unaccounted_usage_id = p.id
    `)
    await tx.execute(sql`
      WITH parent AS (${parentScope}),
      -- The API-side per-model operands, from the disjoint fact measures
      -- (0118 measure_chk): SUM(cost_usd) sees only COST rows (token rows
      -- carry NULL cost), the FILTERed token sum sees only TOKEN rows — so a
      -- github MODEL row (requests-only, cost_usd NULL) can never become a
      -- cost operand, and github money (model NULL, mig 0120) never enters at
      -- all. btrim mirrors the transform's modelOf (D9: pairing is on the
      -- trimmed, case-preserved string; no further normalisation).
      api_model AS (
        SELECT p.id, btrim(f.model) AS model,
               SUM(f.cost_usd) AS api_usd,
               SUM(COALESCE(f.input_tokens, 0) + COALESCE(f.output_tokens, 0))
                 FILTER (WHERE f.cost_type IS NULL) AS api_tokens
        FROM parent p
        JOIN provider_usage_fact f
          ON f.teammate_id = p.teammate_id AND f.date = p.day AND f.tool = p.tool
        WHERE f.model IS NOT NULL
        GROUP BY p.id, btrim(f.model)
      ),
      otel_model AS (${corroboratedOtelDaily({
        startExpr: sql`${opts.startDate}::date::timestamptz`,
        endExpr: sql`(${opts.endDate}::date + 1)::timestamptz`,
        extra: teammateFilterOtel,
        withTool: true,
        withTokens: true,
        withModel: true,
      })}),
      -- Models come from the FACT side only: a model OTel saw but the facts
      -- did not has api_m = 0, so its floored subtraction is 0 by definition.
      floored AS (
        SELECT p.id, a.model,
               p.cost_usd AS r_usd, p.tokens AS r_tok,
               GREATEST(0, COALESCE(a.api_usd, 0) - COALESCE(o.otel_usd, 0)) AS f_usd,
               GREATEST(0, COALESCE(a.api_tokens, 0) - COALESCE(o.otel_tokens, 0)) AS f_tok
        FROM parent p
        JOIN api_model a ON a.id = p.id
        LEFT JOIN otel_model o
          ON o.teammate_id = p.teammate_id AND o.day = p.day AND o.tool = p.tool
         AND o.model = a.model
      ),
      -- The deterministic descending cap (D3 step 3): cumulative-sum window in
      -- (floored DESC, model ASC) order; each cell takes min(floored, what is
      -- left of R). Money and tokens walk their OWN orderings against their
      -- OWN parents.
      alloc AS (
        SELECT id, model,
               LEAST(f_usd, GREATEST(0, r_usd - COALESCE(SUM(f_usd) OVER w_usd, 0)))::numeric(14, 6) AS cost_usd,
               LEAST(f_tok, GREATEST(0, r_tok - COALESCE(SUM(f_tok) OVER w_tok, 0)))::bigint AS tokens
        FROM floored
        WINDOW w_usd AS (PARTITION BY id ORDER BY f_usd DESC, model ASC
                         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
               w_tok AS (PARTITION BY id ORDER BY f_tok DESC, model ASC
                         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
      )
      INSERT INTO unaccounted_usage_model (unaccounted_usage_id, model, cost_usd, tokens)
      SELECT id, model, cost_usd, tokens FROM alloc
      WHERE cost_usd > 0 OR tokens > 0
    `)
    /*
     * Gap typing (r1-H5): stamped here because the writer is the one place
     * that knows why children are absent. Order matters: children win, then
     * "no cost-bearing facts at all" (transient — the fact lane refreshes
     * hourly against this worker's 2h cadence), then "only github money"
     * (structural — Copilot sends no per-model dollars, mig 0120). The ELSE
     * (model-carrying facts exist but nothing allocated, e.g. R = 0) is NULL:
     * there is no remainder to explain.
     */
    await tx.execute(sql`
      WITH parent AS (${parentScope})
      UPDATE unaccounted_usage u
      SET model_gap_reason = CASE
        WHEN EXISTS (SELECT 1 FROM unaccounted_usage_model m WHERE m.unaccounted_usage_id = u.id)
          THEN NULL
        WHEN NOT EXISTS (
          SELECT 1 FROM provider_usage_fact f
          WHERE f.teammate_id = u.teammate_id AND f.date = u.day AND f.tool = u.tool
            AND f.cost_usd IS NOT NULL
        ) THEN 'awaiting-provider-detail'
        WHEN NOT EXISTS (
          SELECT 1 FROM provider_usage_fact f
          WHERE f.teammate_id = u.teammate_id AND f.date = u.day AND f.tool = u.tool
            AND f.cost_usd IS NOT NULL AND f.provider <> 'github'
        ) THEN 'provider-day-grain'
        ELSE NULL
      END
      FROM parent p WHERE u.id = p.id
    `)

    // Reconcile DOWN: an unaccounted row whose (teammate, day, tool) the view no longer backs. The
    // upsert above only ever raises/maintains keys the view CURRENTLY has; a key the view stopped
    // producing (the API source for that day went away, or a prior code version wrote a key this one
    // doesn't — e.g. copilot-cli rows once read from actual_spend before the §B bill was split out
    // of §A) would otherwise linger with a stale positive delta. §A must NEVER show MORE than the
    // provider truth, so an orphan is corrected. NOTE: bounded to the caller's window — the
    // usage-reconciliation worker runs a trailing window, so an orphan older than that window is not
    // reached here; that is acceptable because the developer-facing readers are month-scoped.
    const orphanScope = sql`
      u.day >= ${opts.startDate}::date AND u.day <= ${opts.endDate}::date
      ${opts.teammateId ? sql`AND u.teammate_id = ${opts.teammateId}::uuid` : sql``}
      AND NOT EXISTS (
        SELECT 1 FROM v_teammate_usage_daily v
        WHERE v.teammate_id = u.teammate_id AND v.day = u.day AND v.tool = u.tool
          -- Same display-only exclusion as the api CTE: the effective §A source is the
          -- FILTERED view, so a (bug-written) display-only key must read as an orphan
          -- and self-heal, not linger because the raw view still backs it.
          AND v.tool NOT IN (${laneListSql(INGEST_ONLY_USAGE_TOOLS)})
      )`
    // A row the developer has DECIDED about — attributed to a project, labelled with an
    // activity, or explicitly dismissed (mig 0094) — carries a decision worth preserving;
    // anything else is anonymous and can go. The two branches must stay complementary, so
    // they share one predicate.
    const decided = sql`(u.project_id IS NOT NULL OR u.activity IS NOT NULL OR u.dismissed_at IS NOT NULL)`
    // Undecided orphan: DELETE outright — no decision to keep, and a $0 row would be a
    // permanent ghost in "My projects" / needs-tagging. (If the view later re-produces the
    // key, the upsert re-inserts.)
    /*
     * The teammates go on the rollup refresh queue IN THIS STATEMENT.
     *
     * A DELETE is the one §A mutation that leaves no trace for anything
     * downstream to notice: the zeroing branch below stamps computed_at, which
     * the rollup worker's stale signal and the read-side coverage gate both
     * read, but a removed row has no instant to carry. Without this the rollup
     * keeps the deleted money until the next daily wide sweep, and the gate --
     * finding nothing newer than the day's refresh_at -- reports the figure as
     * current. The queue is the durable channel for exactly this class.
     */
    await tx.execute(sql`
      WITH deleted AS (
        DELETE FROM unaccounted_usage u
         WHERE u.cost_usd > 0 AND NOT ${decided} AND ${orphanScope}
        RETURNING u.teammate_id
      )
      INSERT INTO usage_rollup_refresh (teammate_id, requested_at)
      SELECT DISTINCT teammate_id, statement_timestamp() FROM deleted
      ON CONFLICT (teammate_id) DO UPDATE SET requested_at = GREATEST(usage_rollup_refresh.requested_at + interval '1 microsecond', statement_timestamp())`)
    // Decided orphan: zero the amount but KEEP the row — the developer's decision is
    // preserved history (and survives the key coming back); only its contribution drops to 0.
    // The zeroed parents' children go IN THE SAME STATEMENT (design r1-M1): a
    // zeroed parent with surviving children would silently break
    // Σ children ≤ parent, and arm 2's `cost_usd > 0` filter would HIDE that,
    // not repair it. (The undecided DELETE above cascades through the 0123 FK.)
    // model_gap_reason resets with them — a $0 parent has no gap to explain.
    await tx.execute(sql`
      WITH zeroed AS (
        UPDATE unaccounted_usage u
        SET cost_usd = 0, tokens = 0, model_gap_reason = NULL, computed_at = now()
        WHERE u.cost_usd > 0 AND ${decided} AND ${orphanScope}
        RETURNING u.id
      )
      DELETE FROM unaccounted_usage_model m USING zeroed z WHERE m.unaccounted_usage_id = z.id`)
    return upserted
  })

  // Summary over the freshly-reconciled window (the upserted set).
  const [agg] = await db.execute<{ n: string; usd: string }>(sql`
    SELECT COUNT(*) FILTER (WHERE cost_usd > 0)::text AS n,
           COALESCE(SUM(cost_usd) FILTER (WHERE cost_usd > 0), 0)::text AS usd
    FROM unaccounted_usage
    WHERE day >= ${opts.startDate}::date AND day <= ${opts.endDate}::date
      ${teammateFilter}
  `)

  // Every run RECOMPUTES each day's delta, so a dismissal made about $0.67 can
  // find itself attached to $65 after the provider reports the rest of that day.
  // The decision was about the amount, not the key: hand a materially-grown day
  // back to the queue instead of letting the old answer stand for the new sum.
  // Housekeeping: a failed sweep must not fail a reconciliation run that has
  // already written its deltas. It retries on the next run.
  let staleDismissals = { sessions: 0, unaccounted: 0, missingSnapshots: 0 }
  try {
    staleDismissals = await sweepStaleDismissals(db)
  } catch (e) {
    consola.error('[unaccounted-reconciliation] stale-dismissal sweep failed; reconciled deltas are unaffected', e)
  }

  return {
    rowsUpserted: rows.length,
    recordsWithDelta: Number(agg?.n ?? 0),
    totalUnaccountedUsd: Number(agg?.usd ?? 0),
    staleDismissalsReturned: staleDismissals.unaccounted,
    staleSessionDismissalsReturned: staleDismissals.sessions,
    staleDismissalsMissingSnapshot: staleDismissals.missingSnapshots,
  }
}
