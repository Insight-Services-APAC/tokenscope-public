/*
 * GET /api/v1/rollups/finance/export — CSV export of the finance
 * per-CoU rollup. Honours the same period + region filters the page
 * UI sends so the downloaded file matches the on-screen table.
 *
 * Per the security-audit lesson: csvEscape() from
 * server/utils/csv-escape.ts on every cell.
 */
import { defineEventHandler, createError, getValidatedQuery, setHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { financeRegionFilter } from '../../../../auth/finance-scope'
import { withRequestRls } from '../../../../db/request-rls'
import { csvEscape } from '../../../../utils/csv-escape'
import { monthStartIso } from '../../../../utils/period'

const Query = z.object({
  period: z.enum(['prior', 'mtd', 'q1']).default('mtd'),
  // Slug + existence check, not a hard-coded enum (API-15) — keeps newly
  // created regions exportable. Mirrors rollups/finance.get.
  region: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'region must be a lowercase slug')
    .default('all'),
})

interface Row extends Record<string, unknown> {
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
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), 3, 1))
  return { start: start.toISOString(), end: end.toISOString(), label: `${now.getUTCFullYear()}-Q1` }
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin', 'global-finops')
  const query = await getValidatedQuery(event, (data) => Query.parse(data))
  const range = rangeForPeriod(query.period)

  // Region clamp: admin → own region only; global-finops → requested.
  const regionFilter = financeRegionFilter(session, query.region)

  const rows = await withRequestRls(event, async (tx) => {
    // Existence check for the requested region code — only when the filter
    // is actually honoured (admin is hard-bound to their own region).
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

    // BILL-ANCHORED (mig 0059): the CSV mirrors the page — the bill homed to each
    // teammate's nearest cost-owning ancestor (v_finance_bill_chargeback). Region
    // clamp anchors on the teammate's region (always present); the NULL-CoU
    // unallocated bucket is emitted too so the export totals reconcile.
    return tx.execute<Row>(sql`
      SELECT ou.code AS cou_code,
             ou.display_name AS cou_display_name,
             cr.code AS region_code,
             COALESCE(SUM(b.bill_tokens), 0)::text AS total_tokens,
             COALESCE(SUM(b.bill_usd), 0)::text   AS total_cost_usd
      FROM v_finance_bill_chargeback b
      JOIN teammate tm ON tm.id = b.teammate_id
      JOIN region r ON r.id = tm.region_id
      LEFT JOIN org_unit ou ON ou.id = b.cost_owning_unit_id
      LEFT JOIN region cr ON cr.id = ou.region_id
      WHERE b.period_date >= ${range.start.slice(0, 10)}::date
        AND b.period_date <  ${range.end.slice(0, 10)}::date
        ${regionFilter}
      GROUP BY b.cost_owning_unit_id, ou.code, ou.display_name, cr.code
      ORDER BY SUM(b.bill_usd) DESC NULLS LAST
    `)
  })

  const csvLines = [
    'cou_code,cou_display_name,region_code,total_tokens,total_cost_usd',
    ...[...rows].map(
      (r) =>
        `${csvEscape(r.cou_code ?? 'unallocated')},${csvEscape(r.cou_display_name ?? 'Unallocated')},${csvEscape(r.region_code ?? '')},${r.total_tokens},${r.total_cost_usd}`,
    ),
  ]
  setHeader(event, 'content-type', 'text/csv; charset=utf-8')
  setHeader(
    event,
    'content-disposition',
    `attachment; filename="tokenscope-finance-${range.label}-${query.region}.csv"`,
  )
  return csvLines.join('\n') + '\n'
})
