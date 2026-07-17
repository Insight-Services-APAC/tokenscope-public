// @vitest-environment node
/*
 * Across-Regions §B chargeback LANE widening (lane-visuals V2, Across scope) —
 * the two widened endpoints exercised against a real Postgres:
 *   - GET /reports/across-regions/trend → `chargeLanes` (per-(day, lane) bill
 *     series, `v_finance_bill_chargeback` GROUP BY tool → registry lanes);
 *   - GET /reports/across-regions → `chargebackLanes` (per-lane window totals:
 *     Anthropic day-grained + the pooled Copilot §B lanes on the KPI's gate).
 *
 * The BLANKET CONSERVATION RULE (r1-F6) is the point of this file: for every
 * widened endpoint, cent-exact Σ(lane series) == the existing total series —
 * per day for the trend, and against kpis.anthropicChargeableUsd /
 * kpis.chargeableUsd for the totals. Plus the two firewalls:
 *   - §A copilot tools in actual_spend NEVER surface as a chargeback lane
 *     (mig-0085 GITHUB_FIREWALL_EXCLUSIONS on the root view);
 *   - copilot-unclassified is VISIBLE as a lane but NEVER in a chargeable sum.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import acrossHandler from '../../../server/api/v1/reports/across-regions/index.get'
import trendHandler from '../../../server/api/v1/reports/across-regions/trend.get'

let t: TestDb
let regionA = ''
let unitA = ''
let alice = ''

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
  return e as unknown as Parameters<typeof acrossHandler>[0]
}
const gfo = (): Session =>
  ({ teammateId: '00000000-0000-0000-0000-000000000009', email: 'x@x.test', displayName: 'X', role: 'global-finops', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)

const cents = (n: number) => Math.round(n * 100)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('ra', 'Region A')`
  const [ra] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='ra'`
  regionA = ra!.id
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionA}::uuid, 'a'::ltree, 'a', 'a', 'bu', true)`
  const [ua] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='a'`
  unitA = ua!.id
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-alice', 'alice@a.test', 'alice', ${regionA}::uuid, ${unitA}::uuid, true)`
  const [al] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='alice@a.test'`
  alice = al!.id

  // Anthropic bill lane (actual_spend → v_finance_bill_chargeback): cent-odd
  // figures so the conservation checks are genuinely CENT-exact, split across
  // two tools (→ two lanes: claude + claude-ai) and two days.
  const spend = async (day: string, tool: string, cost: number) => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
      VALUES (${alice}::uuid, ${day}::date, ${tool}, 100, 100, ${cost}, 'anthropic-analytics-api', false)`
  }
  await spend('2026-07-01', 'claude-code', 12.34)
  await spend('2026-07-02', 'claude-code', 1.11)
  await spend('2026-07-02', 'claude-ai', 5.55)
  // §A copilot tool in actual_spend — the mig-0085 firewall must keep it OUT of
  // every chargeback lane (it is §A usage vocabulary, never a §B charge).
  await spend('2026-07-03', 'copilot-cli', 99)

  // Copilot pooled §B lanes (copilot_pool_bill → v_finance_copilot_pool_chargeback):
  // license 100 / usage 20 / UNCLASSIFIED 7 (visible, never chargeable).
  await t.client`INSERT INTO provider_enterprise (provider, external_id, display_name)
    VALUES ('github', 'ent-x', 'Enterprise X')`
  const [{ id: entId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM provider_enterprise WHERE external_id='ent-x'`
  await t.client`INSERT INTO copilot_pool_bill (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats, license_net_usd, overage_net_usd, unclassified_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-07-01'::date, ${entId}::uuid, NULL, ${unitA}::uuid, 5, 100, 20, 7, 80, 90)`
}, 180_000)

afterAll(async () => {
  delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
  await stopTestDb(t)
})

interface LaneRow { lane: string; chargeUsd: number }
interface TrendResp {
  window: { from: string; to: string }
  chargeSeries: { day: string; chargeUsd: number }[]
  chargeLanes: { day: string; lane: string; chargeUsd: number }[]
}
interface AcrossResp {
  kpis: { chargeableUsd: number; anthropicChargeableUsd: number }
  copilot: { partialMonthUnavailable?: boolean }
  chargebackLanes: LaneRow[]
}

describe('GET /reports/across-regions/trend — chargeLanes (per-lane §B daily series)', () => {
  it('CONSERVATION: Σ lanes per day == chargeSeries[day], cent-exact, every day', async () => {
    const r = (await trendHandler(ev(gfo(), 'month=2026-07'))) as unknown as TrendResp
    const laneSumByDay = new Map<string, number>()
    for (const p of r.chargeLanes) laneSumByDay.set(p.day, (laneSumByDay.get(p.day) ?? 0) + p.chargeUsd)
    for (const d of r.chargeSeries) {
      expect(cents(laneSumByDay.get(d.day) ?? 0)).toBe(cents(d.chargeUsd))
    }
    // And the whole-window Σ agrees both ways.
    const laneTotal = r.chargeLanes.reduce((a, p) => a + p.chargeUsd, 0)
    const seriesTotal = r.chargeSeries.reduce((a, p) => a + p.chargeUsd, 0)
    expect(cents(laneTotal)).toBe(cents(seriesTotal))
    expect(cents(seriesTotal)).toBe(cents(12.34 + 1.11 + 5.55))
  })

  it('lanes are registry lane ids; the §A copilot row NEVER surfaces (mig-0085 firewall)', async () => {
    const r = (await trendHandler(ev(gfo(), 'month=2026-07'))) as unknown as TrendResp
    const lanes = new Set(r.chargeLanes.map((p) => p.lane))
    expect(lanes).toEqual(new Set(['claude', 'claude-ai']))
    // The $99 copilot-cli actual_spend row is §A vocabulary — firewalled out of
    // the bill lane entirely (not a lane, not in the totals).
    expect([...lanes].some((l) => l.includes('copilot'))).toBe(false)
    const july2 = r.chargeLanes.filter((p) => p.day === '2026-07-02')
    expect(new Map(july2.map((p) => [p.lane, cents(p.chargeUsd)]))).toEqual(
      new Map([
        ['claude', cents(1.11)],
        ['claude-ai', cents(5.55)],
      ]),
    )
  })

  it('windows to a custom range like the total series', async () => {
    const r = (await trendHandler(ev(gfo(), 'from=2026-07-02&to=2026-07-02'))) as unknown as TrendResp
    expect(r.chargeLanes).toEqual([
      { day: '2026-07-02', lane: 'claude', chargeUsd: 1.11 },
      { day: '2026-07-02', lane: 'claude-ai', chargeUsd: 5.55 },
    ])
  })
})

describe('GET /reports/across-regions — chargebackLanes (per-lane §B window totals)', () => {
  it('pending mode: Anthropic lanes only; Σ == anthropicChargeableUsd == chargeableUsd, cent-exact', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const r = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(r.chargebackLanes.map((l) => l.lane)).toEqual(['claude', 'claude-ai'])
    const sum = r.chargebackLanes.reduce((a, l) => a + l.chargeUsd, 0)
    expect(cents(sum)).toBe(cents(r.kpis.anthropicChargeableUsd))
    expect(cents(sum)).toBe(cents(r.kpis.chargeableUsd))
    expect(cents(sum)).toBe(cents(19.0))
  })

  it('chargeback mode (month window): Copilot §B lanes ride along; Σ(chargeable lanes) == chargeableUsd; unclassified VISIBLE but NEVER charged', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const r = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
      const byLane = new Map(r.chargebackLanes.map((l) => [l.lane, l.chargeUsd]))
      expect(byLane.get('copilot-license')).toBe(100)
      expect(byLane.get('copilot-usage')).toBe(20)
      // Visible as a lane (badged in the UI) …
      expect(byLane.get('copilot-unclassified')).toBe(7)
      // … but the CHARGEABLE conservation excludes it: Σ(lanes − unclassified)
      // == kpis.chargeableUsd (19 Anthropic + 120 pooled net), cent-exact.
      const chargeable = r.chargebackLanes
        .filter((l) => l.lane !== 'copilot-unclassified')
        .reduce((a, l) => a + l.chargeUsd, 0)
      expect(cents(chargeable)).toBe(cents(r.kpis.chargeableUsd))
      expect(cents(chargeable)).toBe(cents(139.0))
      // The §A copilot tools never appear as lanes (firewall), in ANY mode.
      expect(byLane.has('copilot')).toBe(false)
      expect(byLane.has('copilot-agent')).toBe(false)
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it('chargeback mode + partial-month range: pooled lanes withheld (the KPI gate), Σ == chargeableUsd', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const r = (await acrossHandler(ev(gfo(), 'from=2026-07-01&to=2026-07-15'))) as unknown as AcrossResp
      expect(r.copilot.partialMonthUnavailable).toBe(true)
      // No pooled lane may be sliced into a partial month — Anthropic lanes only.
      expect(r.chargebackLanes.map((l) => l.lane)).toEqual(['claude', 'claude-ai'])
      const sum = r.chargebackLanes.reduce((a, l) => a + l.chargeUsd, 0)
      expect(cents(sum)).toBe(cents(r.kpis.chargeableUsd))
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })
})
