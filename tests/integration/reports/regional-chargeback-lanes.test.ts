// @vitest-environment node
/*
 * Regional §B chargeback LANE widening (lane-visuals V2-Regional, mirroring the
 * Across scope) — the two widened endpoints exercised against a real Postgres:
 *   - GET /reports/regional/trend → `chargeLanes` (per-(day, lane) bill series,
 *     `v_finance_bill_chargeback` GROUP BY tool → registry lanes, scope-clamped);
 *   - GET /reports/regional → `chargebackLanes` (per-lane window totals:
 *     Anthropic day-grained + the pooled Copilot §B lanes on the KPI's gate).
 *
 * The BLANKET CONSERVATION RULE (r1-F6) is the point of this file: for every
 * widened endpoint, cent-exact Σ(lane series) == the existing total series —
 * per day for the trend, and against kpis.anthropicChargeableUsd /
 * kpis.chargeableUsd for the totals. Plus the two firewalls (the §A copilot
 * tools never surface as a chargeback lane; copilot-unclassified is VISIBLE but
 * never in a chargeable sum) AND the regional-only concern the Across file has
 * no analogue for: the lane series are clamped by the SAME finance scope the
 * KPI uses (a foreign region's bill rows never leak into the lanes).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import regionalHandler from '../../../server/api/v1/reports/region/index.get'
import trendHandler from '../../../server/api/v1/reports/region/trend.get'

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
  return e as unknown as Parameters<typeof regionalHandler>[0]
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

  /*
   * mig 0129: `gfo()` is the ONLY session this file ever builds — its shared
   * sentinel id ('00000000-0000-0000-0000-000000000009') is never reused for
   * an admin/manager/developer persona here (unlike seasonality-active-trend
   * .test.ts / regional.test.ts), so granting it directly is safe per the
   * "no other role shares this id" rule. Needs a backing `teammate` row first
   * (report_access_grant.teammate_id is a real FK) — this file never inserted
   * one, since nothing previously needed it. Both permissions: 'operational'
   * is what the cross-region `?region=` switch and the whole-company chargeback
   * conservation checks below need.
   */
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role, is_active)
    VALUES ('00000000-0000-0000-0000-000000000009'::uuid, 'oid-gfo', 'gfo@a.test', 'GFO Caller', ${regionA}::uuid, ${unitA}::uuid, 'global-finops', true)`
  await grantReportAccess(t.client, '00000000-0000-0000-0000-000000000009')

  // Anthropic bill lane (actual_spend → v_finance_bill_chargeback): cent-odd
  // figures so the conservation checks are genuinely CENT-exact, split across
  // two tools (→ two lanes: claude + claude-ai) and two days.
  const spend = async (tm: string, day: string, tool: string, cost: number) => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
      VALUES (${tm}::uuid, ${day}::date, ${tool}, 100, 100, ${cost}, 'anthropic-analytics-api', false)`
  }
  await spend(alice, '2026-07-01', 'claude-code', 12.34)
  await spend(alice, '2026-07-02', 'claude-code', 1.11)
  await spend(alice, '2026-07-02', 'claude-ai', 5.55)
  // §A copilot tool in actual_spend — the mig-0085 firewall must keep it OUT of
  // every chargeback lane (it is §A usage vocabulary, never a §B charge).
  await spend(alice, '2026-07-03', 'copilot-cli', 99)
  // Region B (bob) — must NEVER leak into a region-A lane series (scope clamp).
  await spend(bob, '2026-07-02', 'claude-code', 7.77)

  // Copilot pooled §B lanes (copilot_pool_bill → v_finance_copilot_pool_chargeback),
  // homed to region A's unit: license 100 / usage 20 / UNCLASSIFIED 7.
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
  chargeSeries: { day: string; chargeUsd: number }[]
  chargeLanes: { day: string; lane: string; chargeUsd: number }[]
}
interface RegionalResp {
  kpis: { chargeableUsd: number; anthropicChargeableUsd: number }
  copilot: { partialMonthUnavailable?: boolean }
  chargebackLanes: LaneRow[]
}

describe('GET /reports/regional/trend — chargeLanes (per-lane §B daily series, scope-clamped)', () => {
  it('CONSERVATION: Σ lanes per day == chargeSeries[day], cent-exact, every day', async () => {
    const r = (await trendHandler(ev(gfo(), 'month=2026-07'))) as unknown as TrendResp
    const laneSumByDay = new Map<string, number>()
    for (const p of r.chargeLanes) laneSumByDay.set(p.day, (laneSumByDay.get(p.day) ?? 0) + p.chargeUsd)
    for (const d of r.chargeSeries) {
      expect(cents(laneSumByDay.get(d.day) ?? 0)).toBe(cents(d.chargeUsd))
    }
    // And the whole-window Σ agrees both ways — region A ONLY (bob's 7.77 clamped out).
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

  it('SCOPE CLAMP: a cross-region caller viewing region B sees ONLY region-B lanes', async () => {
    const r = (await trendHandler(ev(gfo(), `month=2026-07&region=${regionB}`))) as unknown as TrendResp
    expect(r.chargeLanes).toEqual([{ day: '2026-07-02', lane: 'claude', chargeUsd: 7.77 }])
    const seriesTotal = r.chargeSeries.reduce((a, p) => a + p.chargeUsd, 0)
    expect(cents(seriesTotal)).toBe(cents(7.77))
  })
})

describe('GET /reports/regional — chargebackLanes (per-lane §B window totals, scope-clamped)', () => {
  it('pending mode: Anthropic lanes only; Σ == anthropicChargeableUsd == chargeableUsd, cent-exact', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const r = (await regionalHandler(ev(gfo(), 'month=2026-07'))) as unknown as RegionalResp
    expect(r.chargebackLanes.map((l) => l.lane)).toEqual(['claude', 'claude-ai'])
    const sum = r.chargebackLanes.reduce((a, l) => a + l.chargeUsd, 0)
    expect(cents(sum)).toBe(cents(r.kpis.anthropicChargeableUsd))
    expect(cents(sum)).toBe(cents(r.kpis.chargeableUsd))
    expect(cents(sum)).toBe(cents(19.0))
  })

  it('chargeback mode (month window): Copilot §B lanes ride along; Σ(chargeable lanes) == chargeableUsd; unclassified VISIBLE but NEVER charged', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const r = (await regionalHandler(ev(gfo(), 'month=2026-07'))) as unknown as RegionalResp
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
      const r = (await regionalHandler(ev(gfo(), 'from=2026-07-01&to=2026-07-15'))) as unknown as RegionalResp
      expect(r.copilot.partialMonthUnavailable).toBe(true)
      // No pooled lane may be sliced into a partial month — Anthropic lanes only.
      expect(r.chargebackLanes.map((l) => l.lane)).toEqual(['claude', 'claude-ai'])
      const sum = r.chargebackLanes.reduce((a, l) => a + l.chargeUsd, 0)
      expect(cents(sum)).toBe(cents(r.kpis.chargeableUsd))
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it("SCOPE CLAMP: region B's lanes exclude region A's bill AND region A's pooled Copilot", async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const r = (await regionalHandler(ev(gfo(), `month=2026-07&region=${regionB}`))) as unknown as RegionalResp
      // Only bob's claude row — no region-A Anthropic lane, no region-A pooled lane.
      expect(r.chargebackLanes).toEqual([{ lane: 'claude', chargeUsd: 7.77 }])
      expect(cents(r.kpis.chargeableUsd)).toBe(cents(7.77))
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })
})
