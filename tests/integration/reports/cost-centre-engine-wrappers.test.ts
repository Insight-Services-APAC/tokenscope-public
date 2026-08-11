// @vitest-environment node
/*
 * Every cost-centre engine wrapper, executed against a real database.
 *
 * ── WHY THIS EXISTS, AND WHY A UNIT TEST CANNOT REPLACE IT ───────────────────
 * The engine's queries are split between two table-alias conventions —
 * `FROM v_complete_usage` and `FROM v_complete_usage u` — and each wrapper has
 * to hand in a predicate written for the one it lands in:
 *
 *   UNALIASED  fetchKpiCore · fetchPerPerson · fetchUsageWeeklyLanes · fetchChargebackTrend
 *   ALIASED u. fetchDailyMetrics · fetchUsageBudgetCoverage · fetchSpendTrend · fetchActiveTrend
 *
 * Nothing in the type system distinguishes them: `UsageScope` wraps arbitrary
 * SQL, so an aliased predicate in an unaliased query typechecks perfectly and
 * then fails at execution with `missing FROM-clause entry for table "u"` — the
 * whole request 500s. Two of these wrappers shipped that way and took 21
 * unrelated integration tests down with them, because the drill route calls
 * them all.
 *
 * So the assertion here is deliberately shallow and deliberately EXHAUSTIVE:
 * every wrapper is invoked, and the test passes only if the SQL executes. It is
 * not checking arithmetic (the engine's own tests do that) — it is checking that
 * each wrapper hands the engine a predicate the engine can actually run. That is
 * exactly the property a unit test cannot see, because a unit test supplies the
 * scope itself and never reaches Postgres.
 *
 * A wrapper added without a line here is a wrapper whose clamp nobody has ever
 * executed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  fetchCostCentreKpis,
  fetchCostCentrePerPerson,
  fetchCostCentreDailyMetrics,
  fetchCostCentreChargebackTrend,
  fetchCostCentreUsageBudgetCoverage,
  fetchCostCentreSpendTrend,
  fetchCostCentreActiveTrend,
  fetchCostCentreUsageWeeklyLanes,
  fetchCostCentreTierExposure,
} from '../../../server/reporting/cost-centres'
import type { UsageWindow } from '../../../server/reporting/params'
import type { ServerClock } from '../../../shared/reports/clock'

let t: TestDb
let ccId = ''

const win: UsageWindow = {
  startIso: '2026-07-01T00:00:00.000Z',
  endIso: '2026-08-01T00:00:00.000Z',
  isMonth: true,
  monthStr: '2026-07',
  monthRange: { startIso: '2026-07-01T00:00:00.000Z', endIso: '2026-08-01T00:00:00.000Z' },
} as UsageWindow

const clock: ServerClock = {
  now: '2026-07-22T09:00:00.000Z',
  today: '2026-07-22',
  settledThrough: '2026-07-21',
} as ServerClock

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (code, display_name) VALUES ('ccw', 'CC Wrappers')`
  const [{ id: regionId }] =
    await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='ccw'`
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'ccw'::ltree, 'ccw-unit', 'CC Wrappers Unit', 'practice', true)`
  ;[{ id: ccId }] =
    await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='ccw-unit'`
})

afterAll(async () => {
  await stopTestDb(t)
})

describe('every cost-centre engine wrapper executes against a real database', () => {
  /*
   * An EMPTY cost centre is the right fixture. The clamp defect is in the SQL
   * text, not in the data, so it fires on a scan that matches nothing — and an
   * empty centre keeps this test about executability rather than quietly
   * becoming a second, weaker copy of the engine's arithmetic tests.
   */
  it('fetchCostCentreKpis — UNALIASED usage + finance clamps', async () => {
    const kpis = await fetchCostCentreKpis(t.db, ccId, win, { copilotChargeback: false })
    expect(kpis.genuineUsd).toBe(0)
    expect(kpis.activeUsers).toBe(0)
  })

  it('fetchCostCentrePerPerson — UNALIASED cohort clamp', async () => {
    const pp = await fetchCostCentrePerPerson(t.db, ccId, win)
    expect(pp.medianUsd).toBe(0)
  })

  it('fetchCostCentreDailyMetrics — ALIASED u. clamp', async () => {
    await expect(fetchCostCentreDailyMetrics(t.db, ccId, win, clock)).resolves.toBeInstanceOf(Array)
  })

  it('fetchCostCentreChargebackTrend — UNALIASED finance clamp', async () => {
    await expect(fetchCostCentreChargebackTrend(t.db, ccId, win, clock)).resolves.toBeInstanceOf(Array)
  })

  it('fetchCostCentreUsageBudgetCoverage — ALIASED u. clamp', async () => {
    const cov = await fetchCostCentreUsageBudgetCoverage(t.db, ccId, win, 'CC Wrappers Unit')
    expect(cov.totalUsd).toBe(0)
    // The label travels WITH the figure — a component cannot see a SQL predicate.
    expect(cov.scopeLabel).toBe('CC Wrappers Unit')
  })

  it('fetchCostCentreSpendTrend — ALIASED u. clamp', async () => {
    const trend = await fetchCostCentreSpendTrend(t.db, ccId, win)
    expect(trend.series).toEqual([])
    expect(trend.windowDays).toBe(31)
  })

  it('fetchCostCentreActiveTrend — ALIASED u. clamp', async () => {
    await expect(fetchCostCentreActiveTrend(t.db, ccId, win)).resolves.toEqual([])
  })

  it('fetchCostCentreUsageWeeklyLanes — UNALIASED clamp', async () => {
    await expect(fetchCostCentreUsageWeeklyLanes(t.db, ccId, win)).resolves.toEqual([])
  })

  /*
   * The §B wrapper, which an earlier revision of this file omitted while its own
   * header called the matrix exhaustive. It wraps an UNALIASED finance query
   * (`engine/tier-exposure.ts`), so it is subject to the identical trap — and a
   * matrix that claims to cover every wrapper and covers all but one is worse
   * than an honest partial, because the next person trusts the claim.
   */
  it('fetchCostCentreTierExposure — UNALIASED finance clamp', async () => {
    const exposure = await fetchCostCentreTierExposure(t.db, ccId, win)
    expect(exposure).toBeTruthy()
  })
})
