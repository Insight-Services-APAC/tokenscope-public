/*
 * GET /api/v1/rollups/finance — finance per-CoU rollup (Journey 6 /
 * Screen 6).
 *
 * Returns per-cost-owning-unit totals for the requested period.
 * Filters: period (mtd / prior / q1 — custom land later), region
 * (all / apac / emea / us / global), cou (multi-select via array
 * query param — refine UI is deferred).
 *
 * BILL-ANCHORED (mig 0059): finance = the provider bill (`actual_spend`) per
 * user, homed to that user's nearest cost-owning ancestor via LTREE
 * (v_finance_bill_chargeback). OTel is only the project overlay — the tagged
 * split plus the untagged remainder (v_finance_project_overlay), which sums back
 * to the bill by construction. There is NO coverage gate.
 *
 * Composition: returns the tagged vs untagged split for the OTelCoverageNote.
 * Teammates whose org has no cost-owning ancestor fall into the unallocated
 * bucket (cost_owning_unit_id NULL).
 *
 * Admin / global-finops only. A region admin is hard-bound to their own
 * region (financeRegionFilter); global-finops is org-wide and honours
 * the requested region param.
 */
import { defineEventHandler, createError, getValidatedQuery } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../auth/rbac'
import { financeRegionFilter } from '../../../auth/finance-scope'
import { withRequestRls } from '../../../db/request-rls'
import { monthStartIso } from '../../../utils/period'

const Query = z.object({
  period: z.enum(['prior', 'mtd', 'q1']).default('mtd'),
  // Region codes are dynamically creatable (admin/regions POST), so this is
  // a slug + existence check rather than a hard-coded enum (API-15 — spend
  // in a newly created region could never be filtered with the old enum).
  region: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'region must be a lowercase slug')
    .default('all'),
})

interface CouRow extends Record<string, unknown> {
  cou_id: string | null
  cou_code: string | null
  cou_display_name: string | null
  region_code: string | null
  total_tokens: string
  total_cost_usd: string
}

function rangeForPeriod(period: 'prior' | 'mtd' | 'q1'): {
  start: string
  end: string
  label: string
} {
  const now = new Date()
  if (period === 'mtd') {
    const start = monthStartIso(now)
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    return { start, end: end.toISOString(), label: start.slice(0, 7) }
  }
  if (period === 'prior') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    return { start: start.toISOString(), end: end.toISOString(), label: start.toISOString().slice(0, 7) }
  }
  // Q1 — calendar quarter 1 of the current year.
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), 3, 1))
  return { start: start.toISOString(), end: end.toISOString(), label: `${now.getUTCFullYear()}-Q1` }
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin', 'global-finops')
  const query = await getValidatedQuery(event, (data) => Query.parse(data))
  const range = rangeForPeriod(query.period)

  // Region clamp: admin → own region only; global-finops → requested.
  // Every subquery below aliases the region table as `r`.
  const regionFilter = financeRegionFilter(session, query.region)

  return await withRequestRls(event, async (tx) => {
    // Existence check for the requested region code — only when the filter
    // is actually honoured (admin is hard-bound to their own region above,
    // so their param is ignored). Unknown code → 404, not silent zeros.
    if (query.region !== 'all' && session.role !== 'admin') {
      const regionRows = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM region WHERE code = ${query.region} LIMIT 1
      `)
      if (![...regionRows][0]) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Region not found',
          data: {
            type: 'https://tokenscope.example.com/errors/not-found',
            title: 'Region not found',
            status: 404,
            detail: `No region has code '${query.region}'.`,
          },
        })
      }
    }

    // CC rows = the BILL, homed to the nearest cost-owning ancestor of each
    // teammate's org (v_finance_bill_chargeback). One driving query produces both
    // the allocated CoU rows AND the unallocated bucket (cost_owning_unit_id NULL =
    // teammate with no cost-owning ancestor) — the latter is split out below.
    //
    // Region clamp anchors on the TEAMMATE's region (always present): the bill
    // belongs to the person regionally, and a teammate's cost-owning ancestor is in
    // the same region tree, so this matches the CoU region for allocated rows AND
    // keeps the clamp honest for the unallocated bucket (whose view region_id is
    // NULL). cr is the CoU's own region for display.
    const startDate = range.start.slice(0, 10)
    const endDate = range.end.slice(0, 10)
    const couRows = await tx.execute<CouRow>(sql`
      SELECT b.cost_owning_unit_id::text AS cou_id,
             ou.code AS cou_code,
             ou.display_name AS cou_display_name,
             cr.code AS region_code,
             COALESCE(SUM(b.bill_tokens), 0)::text AS total_tokens,
             COALESCE(SUM(b.bill_usd), 0)::text   AS total_cost_usd
      FROM v_finance_bill_chargeback b
      JOIN teammate tm ON tm.id = b.teammate_id
      JOIN region r ON r.id = tm.region_id
      LEFT JOIN org_unit ou ON ou.id = b.cost_owning_unit_id
      LEFT JOIN region cr ON cr.id = ou.region_id
      WHERE b.period_date >= ${startDate}::date
        AND b.period_date <  ${endDate}::date
        ${regionFilter}
      GROUP BY b.cost_owning_unit_id, ou.code, ou.display_name, cr.code
      ORDER BY SUM(b.bill_usd) DESC NULLS LAST
    `)

    // tagged_pct (replaces attribution_pct): the fraction of each CoU's bill that
    // landed on a tagged project, from the overlay. SUM(charge_usd) per CoU = the
    // bill (the overlay sums back to it), so this is tagged / bill.
    const pctRows = await tx.execute<{ cou_id: string | null; tagged_pct: string }>(sql`
      SELECT o.cost_owning_unit_id::text AS cou_id,
             (CASE WHEN SUM(o.charge_usd) > 0
               THEN SUM(o.charge_usd) FILTER (WHERE o.project_id IS NOT NULL) / SUM(o.charge_usd)
               ELSE 0 END)::text AS tagged_pct
      FROM v_finance_project_overlay o
      JOIN teammate tm ON tm.id = o.teammate_id
      JOIN region r ON r.id = tm.region_id
      WHERE o.period_date >= ${startDate}::date
        AND o.period_date <  ${endDate}::date
        ${regionFilter}
      GROUP BY o.cost_owning_unit_id
    `)
    const pctByCou = new Map(
      [...pctRows].map((p) => [p.cou_id ?? '', Number(p.tagged_pct)] as [string, number]),
    )

    // Composition = tagged (project-attributed) vs untagged (bill remainder), from
    // the overlay. By construction tagged + untagged = the bill, so the composition
    // total equals the CC total. The untagged figure is also the unattributed KPI.
    const compRows = await tx.execute<{ tagged: string; untagged: string }>(sql`
      SELECT COALESCE(SUM(o.charge_usd) FILTER (WHERE o.project_id IS NOT NULL), 0)::text AS tagged,
             COALESCE(SUM(o.charge_usd) FILTER (WHERE o.project_id IS NULL), 0)::text    AS untagged
      FROM v_finance_project_overlay o
      JOIN teammate tm ON tm.id = o.teammate_id
      JOIN region r ON r.id = tm.region_id
      WHERE o.period_date >= ${startDate}::date
        AND o.period_date <  ${endDate}::date
        ${regionFilter}
    `)
    const taggedUsd = Number([...compRows][0]?.tagged ?? 0)
    const untaggedUsd = Number([...compRows][0]?.untagged ?? 0)
    const compositionTotal = taggedUsd + untaggedUsd

    // Split the unallocated bucket (NULL CoU) out of the bill rows.
    const all = [...couRows]
    const unallocatedRow = all.find((r) => r.cou_id === null)
    const list = all.filter((r) => r.cou_id !== null)
    const totalCost = all.reduce((acc, r) => acc + Number(r.total_cost_usd), 0)
    const totalTokens = all.reduce((acc, r) => acc + Number(r.total_tokens), 0)

    return {
      period: { key: query.period, label: range.label, start: range.start, end: range.end },
      region: query.region,
      cous: list.map((r) => ({
        cou_id: r.cou_id,
        cou_code: r.cou_code,
        cou_display_name: r.cou_display_name,
        region_code: r.region_code,
        total_tokens: Number(r.total_tokens),
        total_cost_usd: Number(r.total_cost_usd).toFixed(2),
        tagged_pct: pctByCou.get(r.cou_id ?? '') ?? 0,
      })),
      // Bill for teammates with no cost-owning ancestor — chargeable but unhomed.
      unallocated: {
        total_tokens: Number(unallocatedRow?.total_tokens ?? 0),
        total_cost_usd: Number(unallocatedRow?.total_cost_usd ?? 0).toFixed(2),
      },
      kpis: {
        total_tokens: Number(totalTokens),
        total_cost_usd: totalCost.toFixed(2),
        cous_in_scope: list.length,
        unattributed_cost_usd: untaggedUsd.toFixed(2),
      },
      composition: {
        total_cost_usd: compositionTotal.toFixed(2),
        tagged_cost_usd: taggedUsd.toFixed(2),
        untagged_cost_usd: untaggedUsd.toFixed(2),
      },
    }
  })
})
