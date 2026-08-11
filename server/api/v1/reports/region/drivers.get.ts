/*
 * GET /api/v1/reports/region/drivers?month&region&ou?&axis&lane — the
 * axis-switchable ranked drivers behind the Region DriversTable, at either width
 * (§6 merge) and in either LANE.
 *
 * `?region=all` → whole-company denominators + the spend-concentration cohort
 * stats (the retired `/reports/across-regions/drivers`). Otherwise → in-scope
 * denominators for one region (the retired `/reports/regional/drivers`).
 *
 * ── `?lane=` IS THE PAGE'S TOGGLE, AND IT REACHES HERE NOW ───────────────────
 *
 * `usage` (the default) groups over `v_complete_usage`. `chargeback` groups over
 * `provider_usage_fact`, PER PROVIDER. Before this, `?lane=chargeback` re-lensed
 * the KPI hero and the §B cards and left the drivers attributed — the headline
 * changed and the rows under it did not, with nothing on the page saying so.
 *
 * Whatever the lane, every answer SUMS BACK to its own headline
 * (build-design §7(4)) — the NULL bucket (unassigned region / no-practice / no
 * model on the provider record / unallocated budget) is always a ROW so the
 * sum-back holds — and every money measure in the response declares the lane it
 * was computed on (`measureLanes`). Two measures here are deliberately NOT the
 * selected lane and say so: `concentration` is always attributed (a §A cohort
 * statistic), and the BUDGET axis is always attributed because
 * `provider_usage_fact` has no project column (engine/budget-axis.ts).
 *
 * Lane firewall: §7(7).
 *
 * The AXIS SETS DIFFER BY WIDTH and that is deliberate: `region` is a driver axis
 * only when you are looking across regions, and `practice` means something
 * different inside one. Each width validates against its own enum, so an axis from
 * the other width is a 400 rather than a silently-substituted default.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { parseSpendLens } from '../../../../../shared/usage/lens'
import type { MeasureLanes } from '../../../../../shared/reports/types'
import type { DriversResult } from '../../../../reporting/engine/drivers'
import { requireAuth } from '../../../../utils/auth'
import { withRequestRls } from '../../../../db/request-rls'
import {
  withReportCache,
  memoizedScan,
  identityKey,
  normalizedQuery,
  regionRequestKey,
} from '../../../../reporting/report-cache'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import { resolveRegionRequest, isValidRegionParam } from '../../../../reporting/region-scope'
import {
  fetchAcrossDrivers,
  fetchConcentration,
  ACROSS_DRIVER_AXES,
  type AcrossDriverAxis,
} from '../../../../reporting/across-regions'
import {
  fetchRegionalDrivers,
  REGIONAL_DRIVER_AXES,
  type RegionalDriverAxis,
} from '../../../../reporting/regional'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'
import { copilotChargebackEnabled } from '../../../../reports/copilot-mode'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  region: z.string().refine(isValidRegionParam, 'region must be a uuid or "all"').optional(),
  ou: z.string().uuid().optional(),
  // Parsed loosely here and narrowed per width below — the two widths have
  // different valid axis sets, and a shared enum would accept each other's.
  // PROJECT is the default at both (decisions D1): the same first answer the
  // screen opens on, for every consumer that does not name an axis.
  axis: z.string().optional(),
  /*
   * Parsed LOOSELY and coerced by `parseSpendLens`, never enum-validated: a
   * hand-typed or stale `?lane=` must fall back to `usage` rather than 500 a
   * dashboard (ADR 0012 decision 1, and the same coercion `?axis=` has always
   * had). One spelling of `'usage' | 'chargeback'` for the whole product.
   */
  lane: z.string().optional(),
})

export default defineEventHandler(async (event) => {
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  // Month OR custom from/to window (drivers + concentration are usage-lane, so a
  // custom range windows cleanly).
  const win = resolveReportWindow(query)
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  const lane = parseSpendLens(query.lane)
  // The SAME gate Finance honours (build-design §6): until Σ=bill is green on
  // Dev the pooled Copilot charge is withheld from every §B figure, and this
  // response says so in `chargebackCoverage` rather than omitting it silently.
  const billing = { copilotChargeback: copilotChargebackEnabled() }

  // Authz tx first, compute tx only for a cache-miss leader (plan D5/r1-M2).
  const req = await withRequestRls(event, (tx) =>
    resolveRegionRequest(event, tx, { region: query.region, ou: query.ou }),
  )
  const session = await requireAuth(event)
  const idKey = identityKey(session)

  return await withReportCache(
    event,
    ['region/drivers', normalizedQuery(query), idKey, regionRequestKey(req)],
    () => withRequestRls(event, async (tx) => {
    if (req.width === 'all-regions') {
      const axis = parseAxis<AcrossDriverAxis>(query.axis, ACROSS_DRIVER_AXES)
      const drivers = await fetchAcrossDrivers(tx, win, axis, lane, billing)
      // The top-1/5/10% cohort shares + power/heavy/typical/light segments, computed
      // once per call from the same lane (build-design §5). Whole-company only: a
      // single region's concentration is a different denominator and is not offered.
      //
      // ALWAYS §A, in BOTH lenses. It is a distribution over PEOPLE's consumption,
      // and `provider_usage_fact` carries no equivalent cohort. `measureLanes`
      // labels it rather than letting the toggle imply it moved.
      //
      // Memoized (D8): the screen fires one drivers XHR PER AXIS concurrently —
      // different response-cache keys, same cohort statistic. Single-flight
      // makes those concurrent calls share ONE concentration scan.
      const concentration = await memoizedScan(
        ['concentration', idKey, win.startIso, win.endIso],
        () => fetchConcentration(tx, win),
      )
      return {
        month,
        width: 'all-regions' as const,
        axis,
        lane,
        region: null,
        headlineUsd: drivers.headlineUsd,
        rows: drivers.rows,
        concentration,
        measureLanes: measureLanesFor(drivers, { concentration: 'attributed' }),
        ...(drivers.billedLane ? { billedLane: drivers.billedLane } : {}),
        ...(drivers.chargebackCoverage
          ? { chargebackCoverage: drivers.chargebackCoverage }
          : {}),
        ...(drivers.unallocatedUsd !== undefined
          ? { unallocatedUsd: drivers.unallocatedUsd }
          : {}),
        ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
      }
    }

    const { scope } = req
    const axis = parseAxis<RegionalDriverAxis>(query.axis, REGIONAL_DRIVER_AXES)
    const drivers = await fetchRegionalDrivers(tx, scope, win, axis, lane, billing)
    return {
      month,
      width: 'region' as const,
      axis,
      lane,
      region: scope.region,
      drill: scope.ou ? { ouId: scope.ou.id, displayName: scope.ou.displayName } : null,
      headlineUsd: drivers.headlineUsd,
      rows: drivers.rows,
      measureLanes: measureLanesFor(drivers),
      ...(drivers.billedLane ? { billedLane: drivers.billedLane } : {}),
      ...(drivers.chargebackCoverage ? { chargebackCoverage: drivers.chargebackCoverage } : {}),
      ...(drivers.unallocatedUsd !== undefined ? { unallocatedUsd: drivers.unallocatedUsd } : {}),
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }
    }),
  )
})

/**
 * The response's per-measure lane map.
 *
 * EVERY money field is named, including the ones that are obvious from the axis:
 * "one lane" is a claim, and an undeclared response is indistinguishable from one
 * nobody checked. `billedLane` is deliberately labelled at its LEAVES
 * (`billedLane.billedUsd`, `billedLane.consumptionUsd`) rather than as a whole —
 * it is a composite whose members are not interchangeable, and stamping one lane
 * on the parent would be the false claim this map exists to prevent.
 *
 * A `MeasureLane` says WHICH RELATION a figure was read from, not what the figure
 * means. `billedLane.consumptionUsd` is therefore `'billed'` — it is read from
 * `provider_usage_fact` — while being emphatically NOT billed money. That second
 * distinction rides `BilledAxisArm.measure`, and the two are separate on purpose:
 * collapsing them would leave a consumer with no way to ask "same relation?"
 * without also asserting "same kind of dollar?".
 */
function measureLanesFor(drivers: DriversResult, extra: MeasureLanes = {}): MeasureLanes {
  return {
    rows: drivers.lane,
    headlineUsd: drivers.lane,
    ...(drivers.billedLane
      ? { 'billedLane.billedUsd': 'billed' as const, 'billedLane.consumptionUsd': 'billed' as const }
      : {}),
    // The budget axis's remainder. Attributed by construction — it is the part of
    // an attributed headline carrying no budget claim — and it is named because a
    // reader who arrived here through the chargeback toggle would otherwise have
    // no way to know it is not billed money.
    ...(drivers.unallocatedUsd !== undefined ? { unallocatedUsd: 'attributed' as const } : {}),
    ...extra,
  }
}

/**
 * Narrow `?axis=` against ONE width's axis set, defaulting to `project`.
 *
 * An unknown or foreign-width axis falls back rather than 400-ing, which is the
 * behaviour both retired endpoints had via their per-scope zod enums: the CSV export
 * has always coerced the same way, and a report that 400s because a saved URL
 * carried the other width's axis is a worse answer than the default breakdown.
 */
function parseAxis<T extends string>(raw: string | undefined, valid: readonly T[]): T {
  return (valid as readonly string[]).includes(raw ?? '') ? (raw as T) : ('project' as T)
}
