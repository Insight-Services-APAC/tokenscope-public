/*
 * GET /api/v1/reports/teammate/{id}/export?src&month|from&to — the TokenSheet
 * as CSV (developer pages build fix 10 / D31 / D35).
 *
 * SAME gate, SAME frame, SAME refusal as the page composite beside it — this is
 * the identical audit-worthy read in a portable format, so a caller who is 403'd
 * on the page must be 403'd here, and a page that REFUSES on staleness must not
 * hand out a file of the figures it just withheld.
 *
 * TWO things differ from the page, both deliberate:
 *   - it writes its OWN audit event, `report-teammate-export` (r1-M1). A page
 *     view and a named-person dataset leaving the building are different
 *     forensic facts and the existing vocabulary already separates them
 *     (`report-export-teammate-axis`).
 *   - it is NEVER response-cached. A download is cheap to recompute and a cached
 *     one would be a second copy of a named-person dataset sitting in process
 *     memory. `Cache-Control: no-store` on the browser layer, as on the page
 *     (r1-H6/r2-M1 — T32 asserts it on a real export response, not just the page).
 */
import { createError, defineEventHandler, getRouterParam, getValidatedQuery, setHeader } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../../auth/rbac'
import { resolveReportGrants } from '../../../../../auth/report-scope'
import { withRequestRls } from '../../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../../reporting/params'
import {
  resolveDrillScope,
  fetchTeammateIdentity,
  subjectHasInScopeRow,
  fetchTeammateTokenSheet,
  tokenSheetToCsv,
  writeDrillAudit,
} from '../../../../../reporting/teammate'
import {
  subjectFreshness,
  TEAMMATE_FRESHNESS_THRESHOLD_HOURS,
} from '../../../../../reporting/teammate-freshness'
import { teammateDrillAdmission } from '../../../../../../shared/auth/report-visibility'
import { MONTH_REGEX } from '../../../../../utils/period'
import { isUuid } from '../../../../../utils/uuid'

const Query = z.object({
  src: z.string().min(1),
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
})

function forbidden(): never {
  throw createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/forbidden',
      title: 'Forbidden',
      status: 403,
      detail:
        'This teammate is not visible in the scope you opened this view from, or your role does not grant the per-teammate reports depth.',
    },
  })
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const subjectId = getRouterParam(event, 'id')
  if (!subjectId || !isUuid(subjectId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid teammate id' })
  }
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const now = new Date()
  const win = resolveReportWindow(query, { now })

  setHeader(event, 'cache-control', 'no-store')

  const { scope, identity, rows, stale } = await withRequestRls(event, async (tx) => {
    const grants = await resolveReportGrants(event, tx, session)
    const scope = await resolveDrillScope(tx, session, grants, query.src)
    const identity = await fetchTeammateIdentity(tx, subjectId)
    const hasRow = identity ? await subjectHasInScopeRow(tx, scope.usage, subjectId, win) : false
    const decision = teammateDrillAdmission(
      { grants },
      {
        id: identity?.id ?? null,
        hasInScopeWindowRow: hasRow,
        isActive: identity?.isActive === true,
        // SAME gate as the page beside it (r3-H2): a caller 403'd there must be
        // 403'd here, or the CSV becomes the way to get the withheld dataset.
        // Passed through, NOT collapsed: `=== true` would turn a missing
        // identity row into 'confirmed' and admit it. The rule refuses an
        // unknown on its own (r7-H1).
        isProvisional: identity?.isProvisional,
      },
      { src: scope.token, held: true },
      { from: win.from, to: win.to },
    )
    if (!decision.admit) forbidden()

    const freshness = await subjectFreshness(tx, scope.usage, subjectId, win, now)
    // The refusal withholds the FIGURES; the file is the figures, so a stale
    // window produces no file at all rather than an empty one (an empty CSV
    // reads as "this person contributed nothing", which is a different claim).
    if (freshness.stale) return { scope, identity: identity!, rows: [], stale: freshness.stale }

    const rows = await fetchTeammateTokenSheet(tx, scope.usage, subjectId, win)
    return { scope, identity: identity!, rows, stale: null }
  })

  await writeDrillAudit(event, 'report-teammate-export', {
    actorTeammateId: session.teammateId,
    subjectId,
    payload: {
      src: scope.token,
      window: { from: win.from, to: win.to },
      // COUNTS only — how many rows left the building, never which.
      rows: rows.length,
      refused: stale != null,
    },
  })

  if (stale) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Conflict',
      data: {
        type: 'https://tokenscope.example.com/errors/coverage-stale',
        title: 'Coverage is stale',
        status: 409,
        detail: `Provider coverage for ${stale.provider} is ${stale.ageHours == null ? 'not established' : `${stale.ageHours} h old`} against a ${TEAMMATE_FRESHNESS_THRESHOLD_HOURS} h threshold — figures are withheld until it catches up.`,
      },
    })
  }

  setHeader(event, 'content-type', 'text/csv; charset=utf-8')
  setHeader(
    event,
    'content-disposition',
    `attachment; filename="teammate-${subjectId}-${win.from}_${win.to}.csv"`,
  )
  return tokenSheetToCsv(identity, scope, win, rows)
})
