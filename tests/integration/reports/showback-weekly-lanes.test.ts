// @vitest-environment node
/*
 * BILLED showback weekly lanes (lane-visuals iter-2 I1) — the trend-endpoint
 * widening exercised against a real Postgres:
 *   - GET /reports/across-regions/trend → `showbackWeeklyLanes`
 *   - GET /reports/regional/trend       → `showbackWeeklyLanes` (region-clamped)
 *
 * The Conservation section is the point of this file:
 *   - Σ(showbackWeeklyLanes) == the window's SHOWBACK total (incl. a
 *     chargeback-EXEMPT row — showback shows every genuine dollar, ADR-0010
 *     rule 3), cent-exact, recomputed independently against
 *     `v_finance_bill_showback`;
 *   - the §A GitHub usage tools NEVER surface in a billed-basis element
 *     (GITHUB_FIREWALL_EXCLUSIONS — a usage-basis figure can never ride the
 *     hero/donut);
 *   - weeks are ISO Mondays (`date_trunc('week')`), lanes are registry ids;
 *   - the regional mirror is clamped by the SAME finance scope the §B lane
 *     trend uses (a foreign region's showback rows never leak in).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import acrossTrendHandler from '../../../server/api/v1/reports/across-regions/trend.get'
import regionalTrendHandler from '../../../server/api/v1/reports/regional/trend.get'

let t: TestDb
let regionA = ''
let regionB = ''
let unitA = ''
let unitB = ''
let alice = ''
let bob = ''

const ev = (session: Session, query = '') => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params: {} },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof acrossTrendHandler>[0]
}
const gfo = (): Session =>
  ({ teammateId: '00000000-0000-0000-0000-000000000009', email: 'x@x.test', displayName: 'X', role: 'global-finops', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)

const cents = (n: number) => Math.round(n * 100)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const mkRegion = async (code: string, name: string) => {
    await t.client`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
    return r!.id
  }
  regionA = await mkRegion('ra', 'Region A')
  regionB = await mkRegion('rb', 'Region B')

  const mkUnit = async (region: string, path: string, code: string) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  unitA = await mkUnit(regionA, 'a', 'a')
  unitB = await mkUnit(regionB, 'b', 'b')

  const mkTeammate = async (region: string, unit: string, email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  alice = await mkTeammate(regionA, unitA, 'alice@a.test')
  bob = await mkTeammate(regionB, unitB, 'bob@b.test')

  // Showback bill rows (actual_spend → v_finance_bill_showback). Cent-odd
  // figures so conservation is genuinely CENT-exact; two ISO weeks
  // (2026-07-01/02 → Monday 2026-06-29; 2026-07-07 → Monday 2026-07-06),
  // two Anthropic lanes, PLUS:
  //   - a chargeback-EXEMPT claude-ai row: IN showback (rule 3), so it MUST
  //     be inside the hero's conservation total;
  //   - §A copilot rows (copilot-cli / copilot-agent): usage-basis vocabulary
  //     riding the showback view — the firewall keeps them OUT.
  const spend = async (tm: string, day: string, tool: string, cost: number, exempt = false) => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
      VALUES (${tm}::uuid, ${day}::date, ${tool}, 100, 100, ${cost}, 'anthropic-analytics-api', ${exempt})`
  }
  await spend(alice, '2026-07-01', 'claude-code', 12.34)
  await spend(alice, '2026-07-02', 'claude-code', 1.11)
  await spend(alice, '2026-07-02', 'claude-ai', 5.55)
  await spend(alice, '2026-07-01', 'claude-ai', 2.22, true) // exempt → showback-only (same ISO week)
  await spend(alice, '2026-07-07', 'claude-cowork', 7.89)
  await spend(alice, '2026-07-03', 'copilot-cli', 99)
  await spend(alice, '2026-07-03', 'copilot-agent', 44)
  // Region B (bob) — must NEVER leak into region A's regional lanes.
  await spend(bob, '2026-07-02', 'claude-code', 7.77)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface TrendResp {
  window: { from: string; to: string }
  showbackWeeklyLanes: { weekStart: string; lane: string; usd: number }[]
}

// Anthropic-only July showback: 12.34 + 1.11 + 5.55 + 2.22(exempt) + 7.89 (+ bob's
// 7.77 company-wide). The copilot rows (99 + 44) are §A usage vocabulary — firewalled.
const ALICE_TOTAL = 12.34 + 1.11 + 5.55 + 2.22 + 7.89
const COMPANY_TOTAL = ALICE_TOTAL + 7.77

describe('GET /reports/across-regions/trend — showbackWeeklyLanes (whole company)', () => {
  it('CONSERVATION: Σ cells == the GitHub-excluded showback window total (incl. exempt), cent-exact', async () => {
    const r = (await acrossTrendHandler(ev(gfo(), 'month=2026-07'))) as unknown as TrendResp
    const sum = r.showbackWeeklyLanes.reduce((a, c) => a + c.usd, 0)
    expect(cents(sum)).toBe(cents(COMPANY_TOTAL))
    // Independent recompute straight off the view (the same firewall applied).
    const [indep] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(bill_usd), 0)::text AS total
      FROM v_finance_bill_showback
      WHERE period_date >= '2026-07-01'::date AND period_date < '2026-08-01'::date
        AND (tool NOT IN ('copilot', 'copilot-agent', 'copilot-license', 'copilot-usage', 'copilot-unclassified', 'copilot-cli') OR tool IS NULL)`
    expect(cents(sum)).toBe(cents(Number(indep!.total)))
  })

  it('weeks are ISO Mondays; lanes are registry ids; §A GitHub tools NEVER surface', async () => {
    const r = (await acrossTrendHandler(ev(gfo(), 'month=2026-07'))) as unknown as TrendResp
    expect(new Set(r.showbackWeeklyLanes.map((c) => c.weekStart))).toEqual(
      new Set(['2026-06-29', '2026-07-06']),
    )
    const lanes = new Set(r.showbackWeeklyLanes.map((c) => c.lane))
    expect(lanes).toEqual(new Set(['claude', 'claude-ai', 'claude-cowork']))
    expect([...lanes].some((l) => l.includes('copilot'))).toBe(false)
    // Week 2026-06-29 (Jul 1–2): claude 12.34+1.11+7.77, claude-ai 5.55+2.22.
    const w1 = new Map(
      r.showbackWeeklyLanes.filter((c) => c.weekStart === '2026-06-29').map((c) => [c.lane, cents(c.usd)]),
    )
    expect(w1).toEqual(
      new Map([
        ['claude', cents(12.34 + 1.11 + 7.77)],
        ['claude-ai', cents(5.55 + 2.22)],
      ]),
    )
  })

  it('windows to a custom range like the other series (the ONE shared window object)', async () => {
    const r = (await acrossTrendHandler(ev(gfo(), 'from=2026-07-07&to=2026-07-07'))) as unknown as TrendResp
    expect(r.window).toEqual({ from: '2026-07-07', to: '2026-07-07' })
    expect(r.showbackWeeklyLanes).toEqual([
      { weekStart: '2026-07-06', lane: 'claude-cowork', usd: 7.89 },
    ])
  })
})

describe('GET /reports/regional/trend — showbackWeeklyLanes (region-clamped)', () => {
  it('CONSERVATION within the region: Σ cells == region A showback total; bob NEVER leaks', async () => {
    const r = (await regionalTrendHandler(ev(gfo(), 'month=2026-07'))) as unknown as TrendResp
    const sum = r.showbackWeeklyLanes.reduce((a, c) => a + c.usd, 0)
    expect(cents(sum)).toBe(cents(ALICE_TOTAL))
    // Region B's claude row (7.77) is absent from every cell.
    const w1Claude = r.showbackWeeklyLanes.find(
      (c) => c.weekStart === '2026-06-29' && c.lane === 'claude',
    )!
    expect(cents(w1Claude.usd)).toBe(cents(12.34 + 1.11))
  })

  it('echoes the shared window object and clamps the §A GitHub tools out', async () => {
    const r = (await regionalTrendHandler(ev(gfo(), 'month=2026-07'))) as unknown as TrendResp
    expect(r.window).toEqual({ from: '2026-07-01', to: '2026-07-31' })
    expect(r.showbackWeeklyLanes.some((c) => c.lane.includes('copilot'))).toBe(false)
  })

  it('the other region sees ONLY its own rows (?region=B)', async () => {
    const r = (await regionalTrendHandler(
      ev(gfo(), `month=2026-07&region=${regionB}`),
    )) as unknown as TrendResp
    expect(r.showbackWeeklyLanes).toEqual([
      { weekStart: '2026-06-29', lane: 'claude', usd: 7.77 },
    ])
  })
})
