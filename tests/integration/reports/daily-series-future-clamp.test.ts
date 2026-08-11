// @vitest-environment node
/*
 * The daily series' axis stops at the DATA FRONTIER, never at the calendar.
 *
 * THE BUG. `fetchDailyMetrics` (§A) and `fetchChargebackTrend` (§B) both build a
 * `generate_series` day axis over the WHOLE window and LEFT JOIN the aggregate
 * onto it, COALESCE-ing every miss to 0. Over a CLOSED month that is right: a
 * day with no spend is a real zero, because we looked and found none. Over an
 * IN-PROGRESS month it manufactured a zero for every day that has not happened
 * yet — so on day 3 of a 31-day month the KPI sparkline rose, fell to zero at
 * day 3 and flatlined to the right edge, asserting "spend collapsed on day 4 and
 * never recovered" about 28 days nobody has lived through.
 *
 * THE FIX under test — the axis' upper bound is now
 *
 *   LEAST( endDate - 1 day, GREATEST( clock.settledThrough, MAX(day carrying data) ) )
 *
 * and this file pins all three arms as FIGURES rather than shapes:
 *   1. the window arm — a fully-CLOSED month is unchanged, one point per
 *      calendar day, interior zeros still present as zeros;
 *   2. the SETTLED-EDGE arm — a window running past the edge ends at the edge;
 *   3. the GREATEST arm — a row dated BEYOND the edge re-admits the axis out to
 *      that row, because it still counts in the headline and a series that
 *      dropped it would break Σ(series) === headline silently.
 *
 * ── UPDATED BY F1 (one clock) ───────────────────────────────────────────────
 * The middle arm used to read `CURRENT_DATE`, and this file used to derive its
 * own `today` from the DB's `CURRENT_DATE` to match. Both were the same defect
 * from two sides: SQL's clock is a THIRD clock (after the server's and the
 * browser's) and a WALL-CLOCK fact where the axis needs a COVERAGE fact. The
 * gap between them is the morning dip.
 *
 * The clock is now INJECTED on `event.context.serverClock`, so every date below
 * is derived from a value this file chose. That is what makes the third
 * describe block possible at all: with a wall clock you cannot construct "a day
 * that is still filling" and assert what the series does with it.
 *
 * The two regions are separate on purpose: the future-dated fixture must not
 * move the frontier of the tests that assert the axis stops at the edge.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import regionHandler from '../../../server/api/v1/reports/region/index.get'
import { resolveServerClock } from '../../../shared/reports/clock'

let t: TestDb
/** Carries usage + bill up to TODAY and no further. */
let regionNear = ''
/** Carries usage + bill dated THREE DAYS AHEAD of today. */
let regionAhead = ''
/** Carries usage that STOPS three days back — nothing on today, nothing on the edge. */
let regionQuiet = ''

/*
 * THE PINNED CLOCK for every request in this file. A fixed instant mid-month so
 * "today", "the settled edge" and "a closed month two months back" are all
 * unambiguous, and none of it expires.
 */
const CLOCK = resolveServerClock(new Date('2026-08-19T09:14:00Z'))
/** The still-filling UTC day. NOT the axis edge. */
let today = ''
/** The last COMPLETE UTC day — the axis edge. */
let settledThrough = ''
/** A month that closed at least a month ago (`YYYY-MM`), and its length. */
let closedMonth = ''
let closedDays = 0

const DAY_MS = 86_400_000
/** `YYYY-MM-DD`, `n` days from `iso`. UTC arithmetic on a bare calendar day. */
const shift = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
/** `${month}-${dd}`, zero-padded. */
const dayOf = (month: string, d: number) => `${month}-${String(d).padStart(2, '0')}`

const ev = (session: Session, query = '') => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    // THE PINNED CLOCK. `requestClock(event)` returns this rather than reading a
    // wall clock, so the SQL frontier, the response-cache key and the assertions
    // below are all the same instant — and `today` is a day this file chose.
    context: { params: {}, serverClock: CLOCK },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof regionHandler>[0]
}

const sess = (): Session =>
  ({
    teammateId: '00000000-0000-0000-0000-000000000009',
    email: 'x@fc.test',
    displayName: 'X',
    role: 'global-finops',
    regionId: regionNear,
    orgPath: 'near',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

interface DailyMetric { day: string; genuineUsd: number; tokens: number; activeUsers: number }
interface ChargeDaily { day: string; chargeUsd: number }
interface RegionResp {
  kpis: { genuineUsd: number; anthropicChargeableUsd: number }
  dailyMetrics: DailyMetric[]
  chargeDaily: ChargeDaily[]
}

/** One region-clamped report over an explicit window. */
const report = (region: string, query: string) =>
  regionHandler(ev(sess(), `${query}&region=${region}`)) as unknown as Promise<RegionResp>

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  // Pool-utilisation mode: the pooled (month-grained) Copilot net is then held
  // OUT of `chargeableUsd`, so `anthropicChargeableUsd` and `chargeDaily` read
  // the SAME daily bill lane and the sum-to-headline assertions are exact.
  delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED

  /*
   * Derived from the PINNED clock, not from the database's `CURRENT_DATE`. The
   * old derivation was directionally right (the DB's clock beat the browser's)
   * but it still meant the test and the code under test were reading a clock
   * rather than being handed one — so no assertion could ever pin a boundary.
   */
  today = CLOCK.today
  settledThrough = CLOCK.settledThrough
  const [months] = await t.client<{ closed_month: string; closed_days: number }[]>`
    SELECT to_char(${today}::date - INTERVAL '2 months', 'YYYY-MM') AS closed_month,
           EXTRACT(DAY FROM (date_trunc('month', ${today}::date)
                             - INTERVAL '1 month' - INTERVAL '1 day'))::int AS closed_days`
  closedMonth = months!.closed_month
  closedDays = months!.closed_days

  const mkRegion = async (code: string, name: string) => {
    await t.client`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
    return r!.id
  }
  regionNear = await mkRegion('fcn', 'Frontier Near')
  regionAhead = await mkRegion('fca', 'Frontier Ahead')
  regionQuiet = await mkRegion('fcq', 'Frontier Quiet')

  const mkUnit = async (region: string, code: string) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${code}::ltree, ${code}, ${code}, 'bu', true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code=${code}`
    return r!.id
  }
  const unitNear = await mkUnit(regionNear, 'near')
  const unitAhead = await mkUnit(regionAhead, 'ahead')
  const unitQuiet = await mkUnit(regionQuiet, 'quiet')

  // The caller `sess()` builds every request from — seeded so it exists in
  // `teammate` (audit FKs are real). Carries NO usage and NO bill, so it is
  // invisible to every figure below.
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('00000000-0000-0000-0000-000000000009'::uuid, 'oid-fc-caller', 'x@fc.test', 'X',
            ${regionNear}::uuid, ${unitNear}::uuid, true)`

  const mkTeammate = async (region: string, unit: string, email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  const mkInstance = async (teammateId: string, region: string, unit: string) => {
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${region}::uuid, ${unit}::uuid, 'h', 'P')`
    const [r] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid ORDER BY instance_id LIMIT 1`
    return r!.id
  }

  const near = await mkTeammate(regionNear, unitNear, 'near@fc.test')
  const nearInst = await mkInstance(near, regionNear, unitNear)
  const ahead = await mkTeammate(regionAhead, unitAhead, 'ahead@fc.test')
  const aheadInst = await mkInstance(ahead, regionAhead, unitAhead)
  const quiet = await mkTeammate(regionQuiet, unitQuiet, 'quiet@fc.test')
  const quietInst = await mkInstance(quiet, regionQuiet, unitQuiet)

  /** §A usage. Midday so the UTC day is unambiguous whatever the server TZ. */
  const usage = async (
    inst: string, tm: string, region: string, unit: string, day: string, cost: number,
  ) => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, project_id, tool, model, token_type,
         tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${region}::uuid, ${unit}::uuid, NULL::uuid, 'claude-code',
              'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated',
              ${day + 'T12:00:00Z'}::timestamptz, ${'conv-' + tm + '-' + day})`
  }
  /** §B Anthropic per-teammate bill (never copilot-cli — that lane is pooled). */
  const bill = async (tm: string, day: string, cost: number) => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
      VALUES (${tm}::uuid, ${day}::date, 'claude-code', 100, 100, ${cost}, 'anthropic-analytics-api', false)`
  }

  // ── Region NEAR: nothing later than today ────────────────────────────────
  await usage(nearInst, near, regionNear, unitNear, shift(today, -2), 7)
  await usage(nearInst, near, regionNear, unitNear, today, 11)
  await bill(near, shift(today, -2), 3)
  await bill(near, today, 4)
  // …plus a CLOSED month: spend on days 02 and 05 only, so days 01/03/04 and
  // every day after the 5th are interior zeros a past-month axis must keep.
  await usage(nearInst, near, regionNear, unitNear, dayOf(closedMonth, 2), 5)
  await usage(nearInst, near, regionNear, unitNear, dayOf(closedMonth, 5), 9)
  await bill(near, dayOf(closedMonth, 2), 2)

  // ── Region AHEAD: a row dated three days past today, in BOTH lanes ───────
  await usage(aheadInst, ahead, regionAhead, unitAhead, today, 13)
  await usage(aheadInst, ahead, regionAhead, unitAhead, shift(today, 3), 17)
  await bill(ahead, today, 6)
  await bill(ahead, shift(today, 3), 8)

  // ── Region QUIET: the morning case. Spend stops three days back, so neither
  //    the settled edge nor today carries a row. This is the fixture the old
  //    `CURRENT_DATE` frontier could not distinguish from "spend collapsed".
  await usage(quietInst, quiet, regionQuiet, unitQuiet, shift(today, -3), 19)
  await bill(quiet, shift(today, -3), 5)
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('the axis stops at the FRONTIER — a day that has not happened is not a zero', () => {
  it('the CURRENT month ends at today, not at the month end', async () => {
    const month = today.slice(0, 7)
    const dayOfMonth = Number(today.slice(8, 10))
    const r = await report(regionNear, `month=${month}`)

    // The point the bug drew wrong: the LAST point is today — here because this
    // region HAS usage today, so the GREATEST(MAX(day)) arm re-admits it — and
    // there are exactly as many points as days that have happened this month.
    expect(r.dailyMetrics.at(-1)!.day).toBe(today)
    expect(r.dailyMetrics.length).toBe(dayOfMonth)
    expect(r.dailyMetrics[0]!.day).toBe(dayOf(month, 1))
    // Stated the other way round too, so a series that merely ended EARLY (a
    // dropped trailing zero) could not satisfy the assertions above by accident.
    expect(r.dailyMetrics.filter((d) => d.day > today)).toEqual([])

    // …and the same axis under the §B tile.
    expect(r.chargeDaily.at(-1)!.day).toBe(today)
    expect(r.chargeDaily.length).toBe(dayOfMonth)
    expect(r.chargeDaily.filter((d) => d.day > today)).toEqual([])
  })

  it('a window running explicitly INTO the future ends at today', async () => {
    /*
     * The month case above degenerates on the last day of a month (today IS the
     * month end, so clamped and unclamped agree). This window is future-heavy
     * every day of the year: three days that have happened, ten that have not.
     */
    const from = shift(today, -2)
    const to = shift(today, 10)
    const r = await report(regionNear, `from=${from}&to=${to}`)

    expect(r.dailyMetrics.map((d) => d.day)).toEqual([from, shift(today, -1), today])
    expect(r.chargeDaily.map((d) => d.day)).toEqual([from, shift(today, -1), today])
    // The interior PAST day still reads as a measured zero — the fix bounds the
    // axis, it does not suppress zeros.
    expect(r.dailyMetrics[1]).toMatchObject({ day: shift(today, -1), genuineUsd: 0, activeUsers: 0 })
    expect(r.chargeDaily[1]!.chargeUsd).toBe(0)
    // The real days still carry their real money.
    expect(r.dailyMetrics[0]!.genuineUsd).toBe(7)
    expect(r.dailyMetrics[2]!.genuineUsd).toBe(11)
  })

  it('a window entirely in the future is EMPTY — nothing in it has happened', async () => {
    const r = await report(regionNear, `from=${shift(today, 5)}&to=${shift(today, 9)}`)
    expect(r.dailyMetrics).toEqual([])
    expect(r.chargeDaily).toEqual([])
    // …and the headline agrees there is nothing there, so the empty series is
    // not hiding money.
    expect(r.kpis.genuineUsd).toBe(0)
    expect(r.kpis.anthropicChargeableUsd).toBe(0)
  })
})

describe('data BEYOND today re-admits the axis — Σ(series) can never fall short of the headline', () => {
  it('§A: the series runs out to the latest day carrying usage, not to today', async () => {
    const from = shift(today, -5)
    const r = await report(regionAhead, `from=${from}&to=${shift(today, 10)}`)

    // Frontier = the future-dated row, NOT CURRENT_DATE and NOT the window end.
    expect(r.dailyMetrics.at(-1)!.day).toBe(shift(today, 3))
    expect(r.dailyMetrics.length).toBe(9) // today-5 … today+3 inclusive
    expect(r.dailyMetrics.map((d) => d.day)).toEqual(
      Array.from({ length: 9 }, (_, i) => shift(from, i)),
    )
    // The future-dated money is IN the series, at its own day…
    expect(r.dailyMetrics.at(-1)!.genuineUsd).toBe(17)
    // …and the days between today and it are measured zeros, not a gap.
    expect(r.dailyMetrics.at(-2)!.genuineUsd).toBe(0)
    expect(r.dailyMetrics.at(-3)!.genuineUsd).toBe(0)
  })

  it('§B: the bill series runs out to the latest BILLED day', async () => {
    const r = await report(regionAhead, `from=${shift(today, -5)}&to=${shift(today, 10)}`)
    expect(r.chargeDaily.at(-1)!.day).toBe(shift(today, 3))
    expect(r.chargeDaily.length).toBe(9)
    expect(r.chargeDaily.at(-1)!.chargeUsd).toBe(8)
  })

  it('SUM-TO-HEADLINE holds with the frontier past today (both lanes)', async () => {
    /*
     * The invariant the GREATEST arm exists for. Clamping at CURRENT_DATE alone
     * would drop the +3 row from the series while the KPI kept counting it — a
     * series and a headline disagreeing with nothing on the page to say so.
     */
    const r = await report(regionAhead, `from=${shift(today, -5)}&to=${shift(today, 10)}`)
    expect(r.dailyMetrics.reduce((a, d) => a + d.genuineUsd, 0)).toBe(r.kpis.genuineUsd)
    expect(r.kpis.genuineUsd).toBe(30) // 13 today + 17 three days out
    expect(r.chargeDaily.reduce((a, d) => a + d.chargeUsd, 0)).toBe(r.kpis.anthropicChargeableUsd)
    expect(r.kpis.anthropicChargeableUsd).toBe(14) // 6 + 8
  })

  it('SUM-TO-HEADLINE holds on a clamped-at-today window too (both lanes)', async () => {
    const month = today.slice(0, 7)
    const r = await report(regionNear, `month=${month}`)
    expect(r.dailyMetrics.reduce((a, d) => a + d.genuineUsd, 0)).toBe(r.kpis.genuineUsd)
    expect(r.chargeDaily.reduce((a, d) => a + d.chargeUsd, 0)).toBe(r.kpis.anthropicChargeableUsd)
  })
})

describe('a fully-PAST month is unchanged — every calendar day, interior zeros included', () => {
  it('§A: one point per calendar day, in order, with the empty days as real zeros', async () => {
    const r = await report(regionNear, `month=${closedMonth}`)

    expect(r.dailyMetrics.length).toBe(closedDays)
    expect(r.dailyMetrics.map((d) => d.day)).toEqual(
      Array.from({ length: closedDays }, (_, i) => dayOf(closedMonth, i + 1)),
    )
    // The two days that carry money…
    const byDay = new Map(r.dailyMetrics.map((d) => [d.day, d]))
    expect(byDay.get(dayOf(closedMonth, 2))).toMatchObject({ genuineUsd: 5, activeUsers: 1 })
    expect(byDay.get(dayOf(closedMonth, 5))).toMatchObject({ genuineUsd: 9, activeUsers: 1 })
    // …and the INTERIOR zeros between them, which are measurements and must survive.
    expect(byDay.get(dayOf(closedMonth, 3))).toMatchObject({ genuineUsd: 0, tokens: 0, activeUsers: 0 })
    expect(byDay.get(dayOf(closedMonth, 4))).toMatchObject({ genuineUsd: 0, tokens: 0, activeUsers: 0 })
    // …including the trailing ones: this month is OVER, so its last day is a zero
    // we looked for, not a day awaiting data.
    expect(byDay.get(dayOf(closedMonth, 1))).toMatchObject({ genuineUsd: 0, activeUsers: 0 })
    expect(byDay.get(dayOf(closedMonth, closedDays))).toMatchObject({ genuineUsd: 0, activeUsers: 0 })
    expect(r.dailyMetrics.reduce((a, d) => a + d.genuineUsd, 0)).toBe(r.kpis.genuineUsd)
    expect(r.kpis.genuineUsd).toBe(14)
  })

  it('§B: the bill series is zero-filled across the whole closed month', async () => {
    const r = await report(regionNear, `month=${closedMonth}`)
    expect(r.chargeDaily.length).toBe(closedDays)
    expect(r.chargeDaily.at(0)!.day).toBe(dayOf(closedMonth, 1))
    expect(r.chargeDaily.at(-1)!.day).toBe(dayOf(closedMonth, closedDays))
    const byDay = new Map(r.chargeDaily.map((d) => [d.day, d.chargeUsd]))
    expect(byDay.get(dayOf(closedMonth, 2))).toBe(2)
    expect(byDay.get(dayOf(closedMonth, 3))).toBe(0)
    expect(byDay.get(dayOf(closedMonth, closedDays))).toBe(0)
    expect(r.chargeDaily.reduce((a, d) => a + d.chargeUsd, 0)).toBe(r.kpis.anthropicChargeableUsd)
    expect(r.kpis.anthropicChargeableUsd).toBe(2)
  })
})

describe('T1/T2 — the SETTLED edge, and today drawn beyond it (never as a dip)', () => {
  /*
   * THE MECHANISM OF THE MORNING DIP, isolated.
   *
   * At 09:00 Sydney the current UTC day is three hours old. Under
   * `GREATEST(CURRENT_DATE, MAX(day))` the axis was pulled onto that day, the
   * LEFT JOIN padded it to 0, and the chart drew a collapse — for every reader,
   * every morning, worst in APAC. Under `GREATEST(settledThrough, MAX(day))` an
   * empty today is simply not on the axis: silence, not a zero.
   *
   * Region QUIET carries spend three days back and nothing since, so this is the
   * only fixture in the file where `today` and `MAX(day)` disagree — which is
   * exactly the state the old frontier could not represent.
   */
  it('§A: with NO usage today, the series ends at the SETTLED edge — today is absent', async () => {
    const from = shift(today, -6)
    const r = await report(regionQuiet, `from=${from}&to=${shift(today, 2)}`)

    expect(r.dailyMetrics.at(-1)!.day).toBe(settledThrough)
    // Stated as an absence too: a series that merely ended early could satisfy
    // the line above, but a fabricated zero at `today` could not survive this.
    expect(r.dailyMetrics.some((d) => d.day === today)).toBe(false)
    expect(r.dailyMetrics.filter((d) => d.day > settledThrough)).toEqual([])
  })

  it('§B: the bill series stops at the same edge', async () => {
    const r = await report(regionQuiet, `from=${shift(today, -6)}&to=${shift(today, 2)}`)
    expect(r.chargeDaily.at(-1)!.day).toBe(settledThrough)
    expect(r.chargeDaily.some((d) => d.day === today)).toBe(false)
  })

  it('the three quantities are DISTINCT at the edge, and the axis uses the right one', async () => {
    // today          — the still-filling day
    // settledThrough — the last COMPLETE day  ← the axis edge
    // MAX(event_date)— the last day with DATA (three days back here)
    // The old code conflated the first two; a series anchored on the third would
    // drop the settled empty days that give the month its shape.
    const lastDataDay = shift(today, -3)
    expect(settledThrough).not.toBe(today)
    expect(lastDataDay).not.toBe(settledThrough)

    const r = await report(regionQuiet, `from=${shift(today, -6)}&to=${shift(today, 2)}`)
    expect(r.dailyMetrics.at(-1)!.day).toBe(settledThrough)
    expect(r.dailyMetrics.at(-1)!.genuineUsd).toBe(0) // a MEASURED zero — the day is over
  })

  it('the settled days after the last spend are still measured zeros, not a gap', async () => {
    // The other half of the contract: bounding the axis must not suppress the
    // interior/trailing zeros that make a sparse month read as sparse.
    const r = await report(regionQuiet, `from=${shift(today, -6)}&to=${shift(today, 2)}`)
    const byDay = new Map(r.dailyMetrics.map((d) => [d.day, d.genuineUsd]))
    expect(byDay.get(shift(today, -3))).toBe(19)
    expect(byDay.get(shift(today, -2))).toBe(0)
    expect(byDay.get(shift(today, -1))).toBe(0)
    // …and Σ still equals the headline.
    expect(r.dailyMetrics.reduce((a, d) => a + d.genuineUsd, 0)).toBe(r.kpis.genuineUsd)
    expect(r.kpis.genuineUsd).toBe(19)
  })

  it('today RE-ENTERS the axis the moment it carries a row (region NEAR)', async () => {
    // The partial day is drawn, distinctly, beyond the edge — the D4 treatment.
    // What is refused is a FABRICATED today, not a real one.
    const r = await report(regionNear, `from=${shift(today, -4)}&to=${shift(today, 2)}`)
    expect(r.dailyMetrics.at(-1)!.day).toBe(today)
    expect(r.dailyMetrics.at(-1)!.genuineUsd).toBe(11)
  })
})
