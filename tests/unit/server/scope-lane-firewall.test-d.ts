/*
 * TYPE-LEVEL guard for consistency contract C2, "one lane per axis,
 * firewall-enforced".
 *
 * §A clamps address (region_id, org_unit_id) on v_complete_usage; §B clamps
 * address (region_id, cost_owning_unit_id) on v_finance_bill_chargeback. Those
 * are different columns over different grains — an org unit that is not
 * cost-owning exists in the §A clamp and not the §B one — so handing a finance
 * clamp to the usage engine silently DROPS usage in non-cost-owning child
 * units. A smaller number, with nothing else on the page to contradict it.
 *
 * Before the lane phantom type, that swap type-checked.
 *
 * WHICH CHECKER ENFORCES THIS: `npm run typecheck:types`
 * (tsconfig.type-tests.json), NOT `npm run typecheck`. The latter runs vue-tsc
 * against the NUXT tsconfig, whose include covers app/, shared/ and
 * tests/nuxt/ but NOT tests/ — so this file is invisible to it. That is not a
 * hypothetical: the first version of this guard lived here and removing the
 * firewall left `npm run typecheck` green, which is how it was found. Naming
 * the wrong command here would recreate exactly the defect the guard exists to
 * prevent — a stated guarantee that nothing delivers.
 *
 * Each @ts-expect-error fails the build when the error it expects STOPS
 * occurring ("Unused '@ts-expect-error' directive"), so the firewall cannot be
 * removed without this going red.
 *
 * Deliberately `.test-d.ts`: it asserts on types and is never executed, so it
 * must not be collected by vitest as a suite with no tests in it.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import {
  clampedFinance,
  clampedUsage,
  wholeCompanyFinance,
  wholeCompanyUsage,
} from '../../../server/reporting/engine/scope'
import { fetchUsageWeeklyLanes } from '../../../server/reporting/engine/usage-series'
import { fetchChargebackTrend } from '../../../server/reporting/engine/chargeback-series'
import { fetchKpiCore } from '../../../server/reporting/engine/kpis'
import { fetchDrivers } from '../../../server/reporting/engine/drivers'
import { resolveServerClock } from '../../../shared/reports/clock'

const CLOCK = resolveServerClock(new Date('2026-12-31T12:00:00Z'))

type Tx = PostgresJsDatabase<Record<string, unknown>>
declare const tx: Tx
const window = { startIso: '2026-06-01T00:00:00.000Z', endIso: '2026-07-01T00:00:00.000Z' }
const kpiOpts = { copilotChargeback: false, momMonthRange: null }

// ── The swaps that must NOT compile ──────────────────────────────────────────

// @ts-expect-error a §B finance clamp must not be accepted by the §A usage engine
void fetchUsageWeeklyLanes(tx, clampedFinance(sql`1 = 1`), window)

// @ts-expect-error a §A usage clamp must not be accepted by the §B bill engine
void fetchChargebackTrend(tx, clampedUsage(sql`1 = 1`), window, CLOCK)

// @ts-expect-error whole-company is lane-typed too — the finance one is not a usage scope
void fetchUsageWeeklyLanes(tx, wholeCompanyFinance, window)

// @ts-expect-error and the usage one is not a finance scope
void fetchChargebackTrend(tx, wholeCompanyUsage, window, CLOCK)

/*
 * The KPI row is the one engine function that holds BOTH lanes at once — the
 * tiles render a §A total beside a §B charge — so it takes one clamp per lane
 * rather than one clamp. That is the swap with no runtime symptom: both fields
 * are named, both are SQL, and a transposed pair still returns a plausible row.
 */
void fetchKpiCore(
  tx,
  // @ts-expect-error the §A slot must not accept a §B clamp
  { usage: clampedFinance(sql`1 = 1`), finance: clampedFinance(sql`1 = 1`), monthFloorKey: 'k' },
  window,
  kpiOpts,
)
void fetchKpiCore(
  tx,
  // @ts-expect-error the §B slot must not accept a §A clamp
  { usage: clampedUsage(sql`1 = 1`), finance: clampedUsage(sql`1 = 1`), monthFloorKey: 'k' },
  window,
  kpiOpts,
)
void fetchKpiCore(
  tx,
  // @ts-expect-error whole-company is lane-typed in both slots too
  { usage: wholeCompanyFinance, finance: wholeCompanyUsage, monthFloorKey: 'k' },
  window,
  kpiOpts,
)

// @ts-expect-error drivers rank §A consumption; a §B clamp addresses other columns
void fetchDrivers(tx, clampedFinance(sql`1 = 1`), window, 'teammate')

// @ts-expect-error and whole-company finance is not a usage scope either
void fetchDrivers(tx, wholeCompanyFinance, window, 'project')

// ── The correct pairings, which must keep compiling ──────────────────────────

void fetchUsageWeeklyLanes(tx, clampedUsage(sql`1 = 1`), window)
void fetchUsageWeeklyLanes(tx, wholeCompanyUsage, window)
void fetchChargebackTrend(tx, clampedFinance(sql`1 = 1`), window, CLOCK)
void fetchChargebackTrend(tx, wholeCompanyFinance, window, CLOCK)
void fetchKpiCore(
  tx,
  { usage: clampedUsage(sql`1 = 1`), finance: clampedFinance(sql`1 = 1`), monthFloorKey: 'k' },
  window,
  kpiOpts,
)
void fetchKpiCore(
  tx,
  { usage: wholeCompanyUsage, finance: wholeCompanyFinance, monthFloorKey: 'k' },
  window,
  kpiOpts,
)
void fetchDrivers(tx, clampedUsage(sql`1 = 1`), window, 'teammate')
void fetchDrivers(tx, wholeCompanyUsage, window, 'region')
