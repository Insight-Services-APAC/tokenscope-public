/*
 * GET /api/v1/reports/regional/drivers?month&region&ou?&axis — the axis-switchable
 * ranked drivers behind the Regional DriversTable (build-design §2/§3/§5).
 *
 * `axis=practice|teammate|model|project`; in-scope denominators; grouped over
 * `v_complete_usage` (the usage lane). The rows SUM BACK to the headline in the
 * same lane (build-design §7(4)) — the NULL bucket (unattributed model / untagged
 * project / no-practice) is always present so the sum-back holds. Same RBAC +
 * scope as `/reports/regional` (resolveRegionalScope). Lane firewall: §7(7).
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { resolveReportGrants } from '../../../../auth/report-scope'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import {
  resolveRegionalScope,
  fetchRegionalDrivers,
  REGIONAL_DRIVER_AXES,
} from '../../../../reporting/regional'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().uuid().optional(),
  ou: z.string().uuid().optional(),
  axis: z.enum(REGIONAL_DRIVER_AXES).default('teammate'),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(
    event,
    'developer',
    'manager',
    'admin',
    'global-finops',
    'platform-admin',
  )
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  // Month OR custom from/to window (drivers are usage-lane). Month mode is
  // byte-identical to the old path.
  const win = resolveReportWindow(query)
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))

  return await withRequestRls(event, async (tx) => {
    const grants = await resolveReportGrants(event, tx, caller)
    const scope = await resolveRegionalScope(
      tx,
      caller,
      { region: query.region, ou: query.ou },
      { crossRegion: grants.regional === 'all-regions' },
    )
    const { rows, headlineUsd } = await fetchRegionalDrivers(tx, scope, win, query.axis)
    return {
      month,
      axis: query.axis,
      region: scope.region,
      drill: scope.ou ? { ouId: scope.ou.id, displayName: scope.ou.displayName } : null,
      headlineUsd,
      rows,
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }
  })
})
