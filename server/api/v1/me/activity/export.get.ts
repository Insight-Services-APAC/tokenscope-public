/*
 * GET /api/v1/me/activity/export — the Activity list as CSV, under the SAME
 * filters the reader has applied (D20).
 *
 * It reads through `fetchActivityForExport`, which walks the very keyset the
 * page walks, so "the CSV matches what you are looking at" is true by
 * construction rather than by two queries happening to agree. Both row kinds
 * export; `kind` is the first column so the two grains are never confused.
 *
 * THE `when` COLUMN IS EMPTY FOR A PROVIDER-RECORDED DAY, and that is the point:
 * no instant exists at day grain, and a `00:00` in a spreadsheet is a number
 * somebody will later average. `day` carries everything that is known.
 *
 * The filename carries no date. The server owns the clock (docs/design/
 * clock-and-day-boundary.md) and this route is not a windowing path — stamping
 * it from `new Date()` or `CURRENT_DATE` would be inventing a second one.
 *
 * csvEscape() mitigates formula injection per the security-audit sweep.
 *
 * ROUTING NOTE: this sits beside `/me/activity/{activity}` (the tag drill-down).
 * A static segment outranks a parameter in Nitro's router, so `export` resolves
 * here; the cost is that an activity LABEL of exactly "export" is not reachable
 * through the drill-down URL.
 */
import { defineEventHandler, getValidatedQuery, setHeader } from 'h3'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { csvEscape } from '../../../../utils/csv-escape'
import { fetchActivityForExport } from '../../../../usage/activity-list'
import { ACTIVITY_CSV_COLUMNS, ActivityExportQuery } from '#shared/schemas/activity'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const { limit, ...filters } = await getValidatedQuery(event, (d) => ActivityExportQuery.parse(d))

  const rows = await withRequestRls(event, (tx) =>
    fetchActivityForExport(tx, session.teammateId, filters, limit),
  )

  const lines = [
    ACTIVITY_CSV_COLUMNS.join(','),
    ...rows.map((r) =>
      [
        csvEscape(r.kind),
        csvEscape(r.id),
        csvEscape(r.day),
        // A session's real instant; NOTHING for a day-grain record.
        csvEscape(r.kind === 'session' ? r.ts_last : ''),
        csvEscape(r.tool),
        csvEscape(r.project_code ?? ''),
        csvEscape(r.project_display_name ?? ''),
        csvEscape(r.activity ?? ''),
        // EMPTY when the provider reported no token quantity (every Copilot
        // day — it is metered in ai-credits), for the same reason `when` is
        // empty above: a 0 in a spreadsheet is a number somebody will average.
        // `String(null)` would have written the literal text "null".
        r.tokens === null ? '' : String(r.tokens),
        r.cost_usd,
      ].join(','),
    ),
  ]

  setHeader(event, 'content-type', 'text/csv; charset=utf-8')
  setHeader(event, 'content-disposition', 'attachment; filename="tokenscope-activity.csv"')
  return lines.join('\n') + '\n'
})
