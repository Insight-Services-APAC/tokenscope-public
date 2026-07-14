/*
 * GET /api/v1/me/consumption?window=30|90 — the My-consumption dashboard
 * payload in ONE fetch (brief §6.4). Thin consumer: every number comes from
 * the consumption/insights read-models over attribution_aggregate, plus the
 * existing getMyUsage quota math. Teammate-scoped via requireAuth +
 * withRequestRls (the 0046 aggregate RLS bridge applies under the
 * non-owner role).
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { sql } from 'drizzle-orm'
import { WindowQuery } from '../../../../shared/schemas/usage'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { getMyUsage } from '../../../utils/me-queries'
import {
  fetchDailySeries,
  fetchInsightCellsFromWindow,
  fetchModelSeries,
  fetchWindowTotals,
} from '../../../usage/consumption'
import { runRate } from '../../../usage/projections'
import { detectFindings, fetchCatalog, fetchRateLines, fetchSignalCells } from '../../../usage/insights'


/** Insight cards shown at once (PO cap — never a wall of advice). */
const MAX_INSIGHTS = 3

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const { window } = await getValidatedQuery(event, (d) => WindowQuery.parse(d))

  return await withRequestRls(event, async (tx) => {
    // Existing quota math (buckets, allowance, activity-tagged spend).
    const usage = await getMyUsage(tx, session.teammateId)

    // Concurrent issuance on ONE tx connection: postgres-js pipelines and
    // answers in order — safe; the win is one round-trip wave, not true
    // parallelism.
    const [series, seriesByModel, totals, insightCells, signalCells, catalog, rateLines, acks, aggFresh] =
      await Promise.all([
        fetchDailySeries(tx, 'teammate', session.teammateId, window),
        fetchModelSeries(tx, 'teammate', session.teammateId, window),
        fetchWindowTotals(tx, 'teammate', session.teammateId, window),
        fetchInsightCellsFromWindow(tx, session.teammateId, 28),
        fetchSignalCells(tx, session.teammateId, 28),
        fetchCatalog(tx),
        fetchRateLines(tx),
        tx.execute<{ finding_id: string }>(sql`
          SELECT finding_id FROM insight_ack
          WHERE teammate_id = ${session.teammateId}::uuid
            AND month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
        `),
        // Honesty principle: series/mix lag the ledger by the rollup cadence —
        // surface the aggregate's own freshness alongside the ledger's.
        tx.execute<{ minutes: string | null }>(sql`
          SELECT FLOOR(EXTRACT(EPOCH FROM (now() - MAX(refresh_at))) / 60)::text AS minutes
          FROM attribution_aggregate
          WHERE scope_type = 'teammate' AND scope_id = ${session.teammateId}::uuid
        `),
      ])

    const dismissed = new Set([...acks].map((a) => a.finding_id))
    const insights = detectFindings(insightCells, catalog, rateLines, signalCells)
      .filter((f) => !dismissed.has(f.id))
      .slice(0, MAX_INSIGHTS)

    return {
      month: {
        spend_usd: usage.total_cost_usd,
        tokens: usage.total_tokens,
        quota_usd: usage.total_quota_usd,
        base_allowance_usd: usage.base_allowance_usd,
        allocation_usd: usage.total_allocation_usd,
        run_rate: runRate(Number(usage.total_cost_usd), new Date()),
      },
      window_days: window,
      series,
      series_by_model: seriesByModel,
      mix: {
        by_model: totals.by_model,
        by_token_type: totals.by_token_type,
        buckets: usage.buckets,
        tagged_spend: usage.tagged_spend,
        unallocated: usage.unallocated,
      },
      cache: totals.cache,
      aux: totals.aux,
      fidelity: {
        window_cost_usd: totals.cost_usd.toFixed(2),
        advisory_cost_usd: totals.advisory_cost_usd.toFixed(2),
      },
      insights,
      freshness_minutes_ago: usage.freshness_minutes_ago,
      aggregate_refreshed_minutes_ago: (() => {
        const m = [...aggFresh][0]?.minutes
        return m == null ? null : Number(m)
      })(),
    }
  })
})
