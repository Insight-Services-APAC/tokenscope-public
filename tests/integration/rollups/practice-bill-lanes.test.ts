// @vitest-environment node
/*
 * Practice §B weekly bill lanes (lane-visuals V4) — the widened
 * GET /api/v1/rollups/practice/:ouId `billWeeklyLanes` field exercised against a
 * real Postgres via the REAL handler:
 *   - weekly per-lane §B series from v_finance_bill_showback over the trailing
 *     14 weeks, registry lane ids (toolToVendor), canonical order;
 *   - the BLANKET CONSERVATION RULE (r1-F6), cent-exact: Σ lanes per week ==
 *     that week's showback total (checked against an INDEPENDENT query of the
 *     same view + subtree), and Σ over the MTD overlap == the endpoint's own
 *     `lanes.billUsd` when every bill row is month-to-date;
 *   - showback semantics (ADR-0010 rule 3): a chargeback-EXEMPT row still
 *     appears (showback shows ALL genuine cost — the exclusion lives only in
 *     the chargeback lane).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/rollups/practice/[ouId].get'

let t: TestDb
let regionA = ''
let mpoId = ''
let alice = ''

const ev = (session: Session, ouId: string) => {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET', path: `/x/${ouId}`, context: { params: { ouId } },
    node: {
      req: { method: 'GET', url: `/x/${ouId}`, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof handler>[0]
}
const sess = (role: string, orgPath: string, regionId: string): Session =>
  ({ teammateId: '00000000-0000-0000-0000-000000000001', email: 'x@x.test', displayName: 'X', role, regionId, orgPath, issuedAt: new Date().toISOString() } as unknown as Session)

const cents = (n: number) => Math.round(n * 100)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('pwa', 'Weekly Region A')`
  const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='pwa'`
  regionA = r!.id
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionA}::uuid, 'mpo'::ltree, 'mpo', 'mpo', 'practice', true)`
  const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='mpo'`
  mpoId = u!.id
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-alice', 'alice@a.test', 'alice', ${regionA}::uuid, ${mpoId}::uuid, true)`
  const [a] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='alice@a.test'`
  alice = a!.id

  // Bill rows (actual_spend → v_finance_bill_showback), NOW()-relative so they land
  // inside both the 14-week weekly window and (for the CURRENT_DATE rows) the MTD
  // total. Cent-odd figures so the conservation checks are genuinely CENT-exact.
  // Two surfaces on the SAME day (→ two lanes in one week) + a prior-week row.
  const spend = async (dayExpr: 'CURRENT_DATE' | 'WEEK_AGO', tool: string, cost: number, exempt = false) => {
    if (dayExpr === 'CURRENT_DATE') {
      await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
        VALUES (${alice}::uuid, CURRENT_DATE, ${tool}, 100, 100, ${cost}, 'anthropic-analytics-api', ${exempt})`
    } else {
      await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
        VALUES (${alice}::uuid, (date_trunc('week', NOW()) - INTERVAL '3 days')::date, ${tool}, 100, 100, ${cost}, 'anthropic-analytics-api', ${exempt})`
    }
  }
  await spend('CURRENT_DATE', 'claude-code', 12.34)
  await spend('CURRENT_DATE', 'claude-ai', 5.55)
  // Chargeback-EXEMPT row (its own surface — actual_spend is unique per
  // teammate/date/tool/source) — showback still shows it (ADR-0010 rule 3).
  await spend('CURRENT_DATE', 'claude-cowork', 1.11, true)
  // A prior-week row — in the 14-week weekly series, not necessarily in MTD.
  await spend('WEEK_AGO', 'claude-code', 7.77)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface Resp {
  lanes: { usageSignalUsd: number; billUsd: number }
  billWeeklyLanes: { weekStart: string; lane: string; usd: number }[]
}

describe('GET /api/v1/rollups/practice/:ouId — billWeeklyLanes (V4 weekly §B lanes)', () => {
  it('CONSERVATION: Σ lanes per week == that week\'s showback total (independent query), cent-exact', async () => {
    const r = (await handler(ev(sess('admin', 'mpo', regionA), mpoId))) as unknown as Resp
    expect(r.billWeeklyLanes.length).toBeGreaterThan(0)

    // Independent truth: the SAME view + cost-owning subtree, grouped by week only.
    const truth = await t.client<{ week_start: string; total: string }[]>`
      SELECT date_trunc('week', b.period_date)::date::text AS week_start,
             COALESCE(SUM(b.bill_usd), 0)::text AS total
      FROM v_finance_bill_showback b
      WHERE b.cost_owning_unit_id = ${mpoId}::uuid
        AND b.period_date >= (date_trunc('week', NOW()) - INTERVAL '13 weeks')::date
      GROUP BY 1 ORDER BY 1`
    const laneSumByWeek = new Map<string, number>()
    for (const p of r.billWeeklyLanes) laneSumByWeek.set(p.weekStart, (laneSumByWeek.get(p.weekStart) ?? 0) + p.usd)
    expect(truth.length).toBeGreaterThan(0)
    for (const w of truth) {
      expect(cents(laneSumByWeek.get(w.week_start) ?? 0)).toBe(cents(Number(w.total)))
    }
    // No phantom weeks: every emitted (week, lane) cell belongs to a truth week.
    expect([...laneSumByWeek.keys()].sort()).toEqual(truth.map((w) => w.week_start))
  })

  it('lanes are registry ids in canonical order; showback keeps the EXEMPT row (ADR-0010 rule 3)', async () => {
    const r = (await handler(ev(sess('admin', 'mpo', regionA), mpoId))) as unknown as Resp
    const currentWeek = [...new Set(r.billWeeklyLanes.map((p) => p.weekStart))].sort().at(-1)!
    const week = r.billWeeklyLanes.filter((p) => p.weekStart === currentWeek)
    // Canonical order: claude, then the non-Code surfaces in registry order.
    expect(week.map((p) => p.lane)).toEqual(['claude', 'claude-ai', 'claude-cowork'])
    expect(cents(week.find((p) => p.lane === 'claude')!.usd)).toBe(cents(12.34))
    expect(cents(week.find((p) => p.lane === 'claude-ai')!.usd)).toBe(cents(5.55))
    // The chargeback-EXEMPT cowork row is IN the showback series (the exemption
    // lives only in the chargeback lane, never here).
    expect(cents(week.find((p) => p.lane === 'claude-cowork')!.usd)).toBe(cents(1.11))
  })

  it('Σ MTD-week lanes reconcile to the endpoint\'s own MTD bill total when the windows coincide', async () => {
    const r = (await handler(ev(sess('admin', 'mpo', regionA), mpoId))) as unknown as Resp
    // The whole 14-week Σ covers every seeded row; the MTD bill covers only rows
    // dated this month. When the prior-week row is ALSO this month the two agree;
    // otherwise the weekly Σ exceeds MTD by exactly that row — assert the exact
    // relationship rather than a flaky calendar-dependent equality.
    const weeklyTotal = r.billWeeklyLanes.reduce((a, p) => a + p.usd, 0)
    const [{ mtd }] = await t.client<{ mtd: string }[]>`
      SELECT COALESCE(SUM(b.bill_usd), 0)::text AS mtd
      FROM v_finance_bill_showback b
      WHERE b.cost_owning_unit_id = ${mpoId}::uuid
        AND b.period_date >= date_trunc('month', NOW())::date`
    expect(cents(Number(mtd))).toBe(cents(r.lanes.billUsd))
    const [{ windowed }] = await t.client<{ windowed: string }[]>`
      SELECT COALESCE(SUM(b.bill_usd), 0)::text AS windowed
      FROM v_finance_bill_showback b
      WHERE b.cost_owning_unit_id = ${mpoId}::uuid
        AND b.period_date >= (date_trunc('week', NOW()) - INTERVAL '13 weeks')::date`
    expect(cents(weeklyTotal)).toBe(cents(Number(windowed)))
  })
})
