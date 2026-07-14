// @vitest-environment node
/*
 * Across-Regions reporting scope — the Wave 4 endpoints (`/reports/across-regions
 * {,/drivers}`, `/reports/export`) exercised against a real testcontainers Postgres
 * via the OWNER connection (RLS inert in prod too, so the whole-company query with
 * NO scope clause is what's tested — the enterprise rollup). Covers build-design §7:
 *   (3) RBAC (ONLY global-finops / platform-admin; admin / manager / developer → 403);
 *   whole-company KPIs + per-region comparison cards on a seeded multi-region fixture;
 *   (4) drivers sum-back = headline (each axis, incl. the NULL-model bucket);
 *   §5 concentration math (top-1/5/10% + power/heavy/typical/light segment cut-points
 *       + avg/median) on a seeded 30-teammate distribution with a hand-computed answer;
 *   month-boundary invariance + MoM; (5) export byte-identical to the JSON figures.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import acrossHandler from '../../../server/api/v1/reports/across-regions/index.get'
import acrossDriversHandler from '../../../server/api/v1/reports/across-regions/drivers.get'
import acrossTrendHandler from '../../../server/api/v1/reports/across-regions/trend.get'
import acrossSeasonalityHandler from '../../../server/api/v1/reports/across-regions/seasonality.get'
import exportHandler from '../../../server/api/v1/reports/export.get'

// ISO day-of-week, zero-based (Mon=0..Sun=6) from a YYYY-MM-DD string.
const isoDow0 = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7

let t: TestDb
let regionA = ''
let regionB = ''
let unitA = '' // cost-owning practice 'a' (region A)
let unitAsub = '' // team 'a.sub' under a (region A)
let unitB = '' // cost-owning practice 'b' (region B)
let alice = ''
let dave = ''

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
const sess = (role: string, orgPath: string, regionId: string, teammateId = '00000000-0000-0000-0000-000000000009'): Session =>
  ({ teammateId, email: 'x@x.test', displayName: 'X', role, regionId, orgPath, issuedAt: new Date().toISOString() } as unknown as Session)

const gfo = () => sess('global-finops', 'a', regionA)

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
  const regionC = await mkRegion('rc', 'Region C')
  const regionD = await mkRegion('rd', 'Region D')

  const mkUnit = async (region: string, path: string, code: string, costOwning: boolean, type = 'bu') => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${code}, ${type}, ${costOwning})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  unitA = await mkUnit(regionA, 'a', 'a', true)
  unitAsub = await mkUnit(regionA, 'a.sub', 'a-sub', false, 'team')
  unitB = await mkUnit(regionB, 'b', 'b', true)
  const unitC = await mkUnit(regionC, 'c', 'c', true)
  const unitD = await mkUnit(regionD, 'd', 'd', true)

  const mkTeammate = async (region: string, unit: string, email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  alice = await mkTeammate(regionA, unitA, 'alice@a.test')
  dave = await mkTeammate(regionA, unitAsub, 'dave@a.test') // Copilot-only (unaccounted)
  const bob = await mkTeammate(regionB, unitB, 'bob@b.test')
  // Region D — carries a §B bill (August) but NO usage in any window (finding #2 fixture).
  const ework = await mkTeammate(regionD, unitD, 'ework@d.test')

  const mkInstance = async (teammateId: string, region: string, unit: string) => {
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${region}::uuid, ${unit}::uuid, 'h', 'P')`
    const [r] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid ORDER BY instance_id LIMIT 1`
    return r!.id
  }
  const aliceInst = await mkInstance(alice, regionA, unitA)
  const bobInst = await mkInstance(bob, regionB, unitB)

  const ar = async (inst: string, tm: string, region: string, unit: string, model: string, cost: number, day: string) => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${region}::uuid, ${unit}::uuid, NULL::uuid, 'claude-code', ${model}, 'input', 1000, ${cost}, 'tier-1', 'estimated', ${day}::timestamptz, ${'conv-' + tm + day})`
  }
  // Region A — alice: June sonnet 10 + opus 5 (dated June-01 so both fall inside the
  // like-for-like day-of-month MoM PACE window for any in-July run day); July sonnet 20.
  await ar(aliceInst, alice, regionA, unitA, 'claude-sonnet-4-6', 10, '2026-06-01T00:00:00Z')
  await ar(aliceInst, alice, regionA, unitA, 'claude-opus-4-6', 5, '2026-06-01T00:00:00Z')
  await ar(aliceInst, alice, regionA, unitA, 'claude-sonnet-4-6', 20, '2026-07-02T00:00:00Z')
  // Region B — bob: July sonnet 8.
  await ar(bobInst, bob, regionB, unitB, 'claude-sonnet-4-6', 8, '2026-07-02T00:00:00Z')

  // Copilot-only dave — the §A unaccounted gap (NULL model). June 01, July 30.
  const uu = async (day: string, cost: number) => {
    await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
      VALUES (${dave}::uuid, ${regionA}::uuid, ${unitAsub}::uuid, ${day}::date, 'copilot-cli', ${cost}, 0, 'api-reconciled')`
  }
  await uu('2026-06-01', 15)
  await uu('2026-07-10', 30)

  // Anthropic chargeable bill (region A, July) — alice actual_spend → homes to cost-owning 'a'.
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${alice}::uuid, '2026-07-01'::date, 'claude-code', 500, 500, 12, 'anthropic-analytics-api', false)`
  // Prior-month (June) Anthropic bill (alice, 8) — the chargeback-MoM operand. Does NOT
  // feed v_complete_usage (the finance/bill lane is separate), so no genuine figure moves.
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${alice}::uuid, '2026-06-10'::date, 'claude-code', 400, 400, 8, 'anthropic-analytics-api', false)`
  // May Anthropic bill (alice, 4) — gives the CLOSED June→May chargeback-MoM a prior operand.
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${alice}::uuid, '2026-05-12'::date, 'claude-code', 200, 200, 4, 'anthropic-analytics-api', false)`
  // Region D August bill (ework, 25) — a §B charge with NO usage anywhere in August, so the
  // usage region cards drop Region D but chargebackByRegion (bill lane) keeps it (finding #2).
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${ework}::uuid, '2026-08-05'::date, 'claude-code', 200, 200, 25, 'anthropic-analytics-api', false)`

  // Copilot pooled chargeback (region A, July) — folds into chargeable ONLY in chargeback mode.
  await t.client`INSERT INTO provider_enterprise (provider, external_id, display_name)
    VALUES ('github', 'ent-x', 'Enterprise X')`
  const [{ id: entId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM provider_enterprise WHERE external_id='ent-x'`
  await t.client`INSERT INTO copilot_pool_bill (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats, license_net_usd, overage_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-07-01'::date, ${entId}::uuid, NULL, ${unitA}::uuid, 5, 100, 20, 80, 90)`

  // Concentration fixture — a CLEAN 30-teammate distribution in a dedicated month
  // (2026-05, region C) with costs 300, 290, …, 10 (descending). Total = 4650.
  // No other teammate has May data, so the whole-company May concentration is
  // exactly these 30. Hand-computable known answer (see the concentration test).
  for (let rank = 1; rank <= 30; rank++) {
    const cost = (31 - rank) * 10
    const email = `conc${String(rank).padStart(2, '0')}@c.test`
    const tm = await mkTeammate(regionC, unitC, email)
    const inst = await mkInstance(tm, regionC, unitC)
    await ar(inst, tm, regionC, unitC, 'claude-sonnet-4-6', cost, '2026-05-15T00:00:00Z')
  }
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface Kpis { genuineUsd: number; chargeableUsd: number; anthropicChargeableUsd: number; tokens: number; activeUsers: number; momDeltaPct: number | null; chargeMomDeltaPct: number | null; avgPerUserUsd: number; billedTeammates: number; billedTokens: number; avgChargePerBilledUser: number }
interface RegionCard { regionId: string | null; displayName: string; genuineUsd: number; chargeableUsd: number; activeUsers: number; avgPerUserUsd: number; sharePct: number }
interface ChargebackRegion { regionId: string | null; label: string; chargeableUsd: number }
interface DailyMetric { day: string; genuineUsd: number; tokens: number; activeUsers: number }
interface ChargeDaily { day: string; chargeUsd: number }
interface ChargeDow { dow: number; chargeUsd: number }
interface AcrossResp {
  meta: { scope: string; month: string }
  kpis: Kpis
  copilot: { mode: string; pending: boolean; chargeableUsd: number | null }
  chargebackProviderSplit: { anthropicUsd: number; copilotUsd: number | null }
  dailyMetrics: DailyMetric[]
  chargeDaily: ChargeDaily[]
  regionCards: RegionCard[]
  chargebackByRegion: ChargebackRegion[]
}
interface TrendResp { window: { from: string; to: string }; series: unknown[]; chargeSeries: ChargeDaily[] }
interface SeasonalityResp { window: { from: string; to: string }; chargeDow: ChargeDow[] }
interface Segment { key: string; label: string; count: number; totalUsd: number; sharePct: number; avgUsd: number; medianUsd: number }
interface Concentration { activeUsers: number; totalUsd: number; top1: number; top5: number; top10: number; segments: Segment[] }
interface DriversResp { axis: string; headlineUsd: number; rows: { key: string; label: string; usd: number; sharePct: number; spendClass: string }[]; concentration: Concentration }

describe('GET /reports/across-regions — RBAC (whole-company only)', () => {
  it('global-finops and platform-admin see the whole-company rollup', async () => {
    const gf = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(gf.meta.scope).toBe('across')
    expect(gf.kpis.genuineUsd).toBe(58) // region A (50) + region B (8)
    const pa = (await acrossHandler(ev(sess('platform-admin', 'a', regionA), 'month=2026-07'))) as unknown as AcrossResp
    expect(pa.kpis.genuineUsd).toBe(58)
  })

  for (const role of ['admin', 'manager', 'developer'] as const) {
    it(`a ${role} is FORBIDDEN (403) — this scope is whole-company only`, async () => {
      await expect(acrossHandler(ev(sess(role, 'a', regionA), 'month=2026-07'))).rejects.toMatchObject({ statusCode: 403 })
      await expect(acrossDriversHandler(ev(sess(role, 'a', regionA), 'month=2026-07'))).rejects.toMatchObject({ statusCode: 403 })
    })
  }
})

describe('GET /reports/across-regions — whole-company KPIs + per-region cards', () => {
  it('KPIs roll up every region; MoM + avg/user are correct', async () => {
    const r = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(r.kpis.genuineUsd).toBe(58)
    expect(r.kpis.activeUsers).toBe(3) // alice, dave, bob
    expect(r.kpis.avgPerUserUsd).toBeCloseTo(58 / 3, 6)
    // MoM (LIKE-FOR-LIKE): July MTD genuine 58 vs June's matching day-of-month PACE
    // (all June data dated June-01, so it is captured) 30 (alice 15 + dave 15) → +93.33%.
    expect(r.kpis.momDeltaPct).toBeCloseTo(28 / 30, 6)
  })

  it('per-region cards carry genuine, share, active users, avg/user — and sum back to the headline', async () => {
    const r = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    const byName = new Map(r.regionCards.map((c) => [c.displayName, c]))
    const a = byName.get('Region A')!
    const b = byName.get('Region B')!
    expect(a.genuineUsd).toBe(50)
    expect(a.activeUsers).toBe(2)
    expect(a.avgPerUserUsd).toBe(25)
    expect(b.genuineUsd).toBe(8)
    expect(b.activeUsers).toBe(1)
    // Region cards sum back to the genuine headline; shares sum to 1.
    const sum = r.regionCards.reduce((acc, c) => acc + c.genuineUsd, 0)
    expect(sum).toBe(58)
    expect(r.regionCards.reduce((acc, c) => acc + c.sharePct, 0)).toBeCloseTo(1, 6)
    expect(a.sharePct).toBeCloseTo(50 / 58, 6)
  })

  it('pool-utilisation mode: chargeable = Anthropic only + Copilot "pending"; chargeback mode folds Copilot in', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const pool = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(pool.copilot.mode).toBe('pool-utilisation')
    expect(pool.copilot.pending).toBe(true)
    expect(pool.kpis.anthropicChargeableUsd).toBe(12)
    expect(pool.kpis.chargeableUsd).toBe(12) // Copilot pooled net NOT folded in
    const regionA_pool = pool.regionCards.find((c) => c.displayName === 'Region A')!
    expect(regionA_pool.chargeableUsd).toBe(12)

    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const cb = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
      expect(cb.copilot.mode).toBe('chargeback')
      expect(cb.copilot.pending).toBe(false)
      expect(cb.kpis.chargeableUsd).toBe(132) // 12 Anthropic + 120 Copilot pooled net
      const regionA_cb = cb.regionCards.find((c) => c.displayName === 'Region A')!
      expect(regionA_cb.chargeableUsd).toBe(132)
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })
})

describe('GET /reports/across-regions/drivers — sum-back = headline (every axis)', () => {
  const axes = ['region', 'practice', 'teammate', 'model'] as const
  for (const axis of axes) {
    it(`axis=${axis}: Σ rows = headline = company genuine, shares sum to 1`, async () => {
      const d = (await acrossDriversHandler(ev(gfo(), `month=2026-07&axis=${axis}`))) as unknown as DriversResp
      const sum = d.rows.reduce((a, r) => a + r.usd, 0)
      expect(sum).toBeCloseTo(d.headlineUsd, 6)
      expect(d.headlineUsd).toBe(58)
      expect(d.rows.reduce((a, r) => a + r.sharePct, 0)).toBeCloseTo(1, 6)
    })
  }

  it('the model axis surfaces the NULL-model (unattributed) bucket = the Copilot gap', async () => {
    const d = (await acrossDriversHandler(ev(gfo(), 'month=2026-07&axis=model'))) as unknown as DriversResp
    const nullBucket = d.rows.find((r) => r.label === 'Unattributed')
    expect(nullBucket).toBeDefined()
    expect(nullBucket!.usd).toBe(30) // dave's Copilot gap (region A) + none in B
  })

  it('the region axis names each region and includes both', async () => {
    const d = (await acrossDriversHandler(ev(gfo(), 'month=2026-07&axis=region'))) as unknown as DriversResp
    const labels = d.rows.map((r) => r.label).sort()
    expect(labels).toEqual(['Region A', 'Region B'])
  })

  it('a pure-Copilot teammate row is `pooled-usage`; a Claude teammate is `indicative`', async () => {
    const d = (await acrossDriversHandler(ev(gfo(), 'month=2026-07&axis=teammate'))) as unknown as DriversResp
    expect(d.rows.find((r) => r.label === 'dave@a.test')!.spendClass).toBe('pooled-usage')
    expect(d.rows.find((r) => r.label === 'alice@a.test')!.spendClass).toBe('indicative')
  })
})

describe('GET /reports/across-regions/drivers — concentration math (known answer)', () => {
  // 30 teammates, costs 300,290,…,10 (total 4650). Concentration cohorts use
  // k = max(1, round(N×p)); AEUF segment cut-points: power=top5% (2), heavy=next15% (5),
  // typical=middle55% (15), light=bottom25% (8). Every number below is hand-computed.
  it('top-1/5/10% cohort shares use k = max(1, round(N×p))', async () => {
    const d = (await acrossDriversHandler(ev(gfo(), 'month=2026-05&axis=teammate'))) as unknown as DriversResp
    const c = d.concentration
    expect(c.activeUsers).toBe(30)
    expect(c.totalUsd).toBe(4650)
    expect(c.top1).toBeCloseTo(300 / 4650, 6) // k=1 → top user (300)
    expect(c.top5).toBeCloseTo(590 / 4650, 6) // k=2 → 300+290
    expect(c.top10).toBeCloseTo(870 / 4650, 6) // k=3 → 300+290+280
  })

  it('power/heavy/typical/light segments carry count, share, avg + median', async () => {
    const d = (await acrossDriversHandler(ev(gfo(), 'month=2026-05&axis=teammate'))) as unknown as DriversResp
    const seg = new Map(d.concentration.segments.map((s) => [s.key, s]))

    const power = seg.get('power')!
    expect([power.count, power.totalUsd, power.avgUsd, power.medianUsd]).toEqual([2, 590, 295, 300])
    expect(power.sharePct).toBeCloseTo(590 / 4650, 6)

    const heavy = seg.get('heavy')!
    expect([heavy.count, heavy.totalUsd, heavy.avgUsd, heavy.medianUsd]).toEqual([5, 1300, 260, 260])
    expect(heavy.sharePct).toBeCloseTo(1300 / 4650, 6)

    const typical = seg.get('typical')!
    expect([typical.count, typical.totalUsd, typical.avgUsd, typical.medianUsd]).toEqual([15, 2400, 160, 160])
    expect(typical.sharePct).toBeCloseTo(2400 / 4650, 6)

    const light = seg.get('light')!
    expect([light.count, light.totalUsd, light.avgUsd, light.medianUsd]).toEqual([8, 360, 45, 50])
    expect(light.sharePct).toBeCloseTo(360 / 4650, 6)

    // Segments partition the whole population + spend (no user double-counted).
    expect(d.concentration.segments.reduce((a, s) => a + s.count, 0)).toBe(30)
    expect(d.concentration.segments.reduce((a, s) => a + s.totalUsd, 0)).toBe(4650)
  })
})

describe('GET /reports/across-regions/drivers — range mode windows the FULL range (not one month)', () => {
  // A multi-month custom window (June + July). The drivers previously anchored to a single
  // month in range mode; they must now window the WHOLE range (the review invariant), and
  // the CSV export must window the SAME range so screen == CSV.
  const RANGE = 'from=2026-06-01&to=2026-07-31'

  it('teammate drivers sum over June + July (88), NOT a single month', async () => {
    const d = (await acrossDriversHandler(ev(gfo(), `${RANGE}&axis=teammate`))) as unknown as DriversResp
    // June (alice 15 + dave 15) + July (alice 20 + bob 8 + dave 30) = 88 — the whole range.
    expect(d.headlineUsd).toBe(88)
    const byName = new Map(d.rows.map((r) => [r.label, r.usd]))
    expect(byName.get('alice@a.test')).toBe(35) // 15 June + 20 July
    expect(byName.get('bob@b.test')).toBe(8)
    expect(byName.get('dave@a.test')).toBe(45) // 15 June + 30 July (Copilot gap)
    expect(d.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(88, 6)
  })

  it('the drivers CSV export windows the SAME range — byte-identical to the screen figures', async () => {
    const json = (await acrossDriversHandler(ev(gfo(), `${RANGE}&axis=teammate`))) as unknown as DriversResp
    const csv = (await exportHandler(ev(gfo(), `scope=across-regions&report=drivers&axis=teammate&${RANGE}`))) as unknown as string
    const lines = csv.trim().split('\n')
    expect(lines[1]).toBe('driver,spend_usd,share_pct,spend_class')
    const csvByLabel = new Map<string, { usd: number; share: number }>()
    for (const line of lines.slice(2)) {
      const [label, usd, share] = line.split(',')
      csvByLabel.set(label!, { usd: Number(usd), share: Number(share) })
    }
    for (const row of json.rows) {
      const c = csvByLabel.get(row.label)
      expect(c).toBeDefined()
      expect(c!.usd).toBe(Number(row.usd.toFixed(2)))
      expect(c!.share).toBe(Number((row.sharePct * 100).toFixed(1)))
    }
    // dave's FULL-range Copilot gap present at 45.00 — not 30.00 (July only).
    expect(csv).toContain('dave@a.test,45.00,')
  })
})

describe('GET /reports/across-regions — §A dailyMetrics + §B chargeback MoM', () => {
  it('dailyMetrics is the §A per-day series (genuine / tokens / active users), summing to the headline', async () => {
    const r = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    const byDay = new Map(r.dailyMetrics.map((d) => [d.day, d]))
    // 2026-07-02: alice 20 (1000 tok) + bob 8 (1000 tok) = 28 / 2000 tok / 2 users.
    expect(byDay.get('2026-07-02')).toMatchObject({ genuineUsd: 28, tokens: 2000, activeUsers: 2 })
    // 2026-07-10: dave's Copilot gap 30 (0 tok) / 1 user.
    expect(byDay.get('2026-07-10')).toMatchObject({ genuineUsd: 30, tokens: 0, activeUsers: 1 })
    // Σ daily genuine = the KPI headline (58).
    expect(r.dailyMetrics.reduce((a, d) => a + d.genuineUsd, 0)).toBe(58)
    // Zero-filled: EVERY July day present (31), no-usage days a genuine 0 (finding #6 —
    // the sparkline's temporal shape must not compress scattered activity).
    expect(r.dailyMetrics.length).toBe(31)
    expect(byDay.get('2026-07-01')).toMatchObject({ genuineUsd: 0, tokens: 0, activeUsers: 0 })
    expect(byDay.get('2026-07-31')).toMatchObject({ genuineUsd: 0, tokens: 0, activeUsers: 0 })
  })

  it('chargeMomDeltaPct compares two CLOSED calendar months; the in-progress month is null (§B, never usage)', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    // June (a CLOSED month) chargeable 8 vs May (closed) 4 → +100%. §B bill lane, never usage.
    const june = (await acrossHandler(ev(gfo(), 'month=2026-06'))) as unknown as AcrossResp
    expect(june.kpis.chargeMomDeltaPct).toBeCloseTo(1.0, 6)
    // The current (in-progress) month accrues intra-month, so an MTD-vs-full-prior MoM is
    // misleading → null (finding #3). Detected dynamically so it is not month-boundary flaky.
    const currentMonth = new Date().toISOString().slice(0, 7)
    const cur = (await acrossHandler(ev(gfo(), `month=${currentMonth}`))) as unknown as AcrossResp
    expect(cur.kpis.chargeMomDeltaPct).toBeNull()
  })

  it('chargeMomDeltaPct is null in custom-range mode (no month anchor)', async () => {
    const r = (await acrossHandler(ev(gfo(), 'from=2026-07-01&to=2026-07-31'))) as unknown as AcrossResp
    expect(r.kpis.chargeMomDeltaPct).toBeNull()
  })

  it('chargebackByRegion ranks off the bill lane — a region with charge but NO in-window usage appears + sums to the chargeable', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    // August: only Region D has a §B bill (25) and NOBODY has August usage. The usage region
    // cards would DROP Region D; chargebackByRegion (v_finance_chargeback_month) keeps it.
    const r = (await acrossHandler(ev(gfo(), 'month=2026-08'))) as unknown as AcrossResp
    const d = r.chargebackByRegion.find((x) => x.label === 'Region D')
    expect(d).toBeDefined()
    expect(d!.chargeableUsd).toBe(25)
    // Region D is NOT in the usage region cards (no August usage) — the exact drop the fn fixes.
    expect(r.regionCards.some((c) => c.displayName === 'Region D')).toBe(false)
    // The ranking sums back to the whole-company chargeable headline.
    expect(r.chargebackByRegion.reduce((a, x) => a + x.chargeableUsd, 0)).toBe(r.kpis.chargeableUsd)
    expect(r.kpis.chargeableUsd).toBe(25)
  })
})

describe('GET /reports/across-regions — §B chargeback bill-lane cards (Anthropic per-teammate)', () => {
  it('KPI billed figures come from the ANTHROPIC per-teammate bill lane (not usage)', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const r = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    // Only alice carries a July Anthropic bill (12, 500+500 tokens). dave is Copilot-only
    // (unaccounted, no per-teammate bill), so he is NOT billed — the bill lane ≠ the usage lane.
    expect(r.kpis.billedTeammates).toBe(1)
    expect(r.kpis.billedTokens).toBe(1000)
    // Avg = Anthropic charge (12) ÷ billed teammates (1) — NOT the Copilot-inclusive chargeable.
    expect(r.kpis.avgChargePerBilledUser).toBe(12)
    // Distinct from §A: 3 active users but only 1 billed teammate.
    expect(r.kpis.activeUsers).toBe(3)
  })

  it('chargebackProviderSplit is Anthropic vs Copilot pooled, GATED on copilotChargeback', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const pool = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(pool.chargebackProviderSplit.anthropicUsd).toBe(12)
    expect(pool.chargebackProviderSplit.copilotUsd).toBeNull() // pooled Copilot held back (pending)
    // The split sums to the chargeable headline (Anthropic-only while pending).
    expect(pool.chargebackProviderSplit.anthropicUsd).toBe(pool.kpis.chargeableUsd)

    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const cb = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
      expect(cb.chargebackProviderSplit.anthropicUsd).toBe(12)
      expect(cb.chargebackProviderSplit.copilotUsd).toBe(120) // pooled net folded in
      // Now both buckets sum to the (Copilot-inclusive) chargeable.
      expect(cb.chargebackProviderSplit.anthropicUsd + (cb.chargebackProviderSplit.copilotUsd ?? 0)).toBe(
        cb.kpis.chargeableUsd,
      )
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it('chargeDaily is the §B ANTHROPIC per-DAY series (day-grained, zero-filled, Copilot absent)', async () => {
    const r = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    const byDay = new Map(r.chargeDaily.map((d) => [d.day, d.chargeUsd]))
    // alice's July-01 bill (12) lands on its exact DAY — the month-grained chargeback view
    // could never express this; the daily bill lane can.
    expect(byDay.get('2026-07-01')).toBe(12)
    // Zero-filled across the whole month; the Copilot pooled net (120, monthly) is ABSENT.
    expect(r.chargeDaily.length).toBe(31)
    expect(r.chargeDaily.reduce((a, d) => a + d.chargeUsd, 0)).toBe(12)
    expect(byDay.get('2026-07-15')).toBe(0)
  })

  it('the trend endpoint carries the §B chargeSeries alongside the §A series (day-grained)', async () => {
    const r = (await acrossTrendHandler(ev(gfo(), 'month=2026-07'))) as unknown as TrendResp
    const byDay = new Map(r.chargeSeries.map((d) => [d.day, d.chargeUsd]))
    expect(byDay.get('2026-07-01')).toBe(12)
    expect(r.chargeSeries.reduce((a, d) => a + d.chargeUsd, 0)).toBe(12)
  })

  it('the seasonality endpoint carries the §B day-of-week chargeback (7 buckets, Mon..Sun)', async () => {
    const r = (await acrossSeasonalityHandler(ev(gfo(), 'month=2026-07'))) as unknown as SeasonalityResp
    // Always seven buckets, dow 0..6, summing to the window's Anthropic chargeback (12).
    expect(r.chargeDow.length).toBe(7)
    expect(r.chargeDow.map((b) => b.dow)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(r.chargeDow.reduce((a, b) => a + b.chargeUsd, 0)).toBe(12)
    // The whole 12 lands on 2026-07-01's day-of-week bucket.
    const dow = isoDow0('2026-07-01')
    expect(r.chargeDow.find((b) => b.dow === dow)!.chargeUsd).toBe(12)
  })
})

describe('GET /reports/across-regions — month-boundary invariance', () => {
  it('Σ per-month (May + June + July) = the unbounded whole-company total', async () => {
    const may = (await acrossHandler(ev(gfo(), 'month=2026-05'))) as unknown as AcrossResp
    const june = (await acrossHandler(ev(gfo(), 'month=2026-06'))) as unknown as AcrossResp
    const july = (await acrossHandler(ev(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(may.kpis.genuineUsd).toBe(4650)
    expect(june.kpis.genuineUsd).toBe(30)
    expect(july.kpis.genuineUsd).toBe(58)
    const [{ total }] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM v_complete_usage
      WHERE ts_event >= '2026-05-01T00:00:00Z'::timestamptz
        AND ts_event <  '2026-08-01T00:00:00Z'::timestamptz`
    expect(may.kpis.genuineUsd + june.kpis.genuineUsd + july.kpis.genuineUsd).toBe(Number(total))
    expect(Number(total)).toBe(4738)
  })
})

describe('GET /reports/export?scope=across-regions — byte-identical + RBAC', () => {
  it('the drivers CSV rows carry the SAME spend + share as the JSON endpoint', async () => {
    const json = (await acrossDriversHandler(ev(gfo(), 'month=2026-07&axis=teammate'))) as unknown as DriversResp
    const csv = (await exportHandler(ev(gfo(), 'scope=across-regions&report=drivers&axis=teammate&month=2026-07'))) as unknown as string
    expect(typeof csv).toBe('string')
    const lines = csv.trim().split('\n')
    expect(lines[0]).toMatch(/^# tokenscope across-regions drivers/)
    expect(lines[1]).toBe('driver,spend_usd,share_pct,spend_class')
    const csvByLabel = new Map<string, { usd: number; share: number; klass: string }>()
    for (const line of lines.slice(2)) {
      const [label, usd, share, klass] = line.split(',')
      csvByLabel.set(label!, { usd: Number(usd), share: Number(share), klass: klass! })
    }
    for (const row of json.rows) {
      const c = csvByLabel.get(row.label)
      expect(c).toBeDefined()
      expect(c!.usd).toBe(Number(row.usd.toFixed(2)))
      expect(c!.share).toBe(Number((row.sharePct * 100).toFixed(1)))
      expect(c!.klass).toBe(row.spendClass)
    }
    expect(csv).toContain('dave@a.test,30.00,51.7,pooled-usage')
  })

  it('the concentration CSV carries the hand-computed cohorts + segments', async () => {
    const csv = (await exportHandler(ev(gfo(), 'scope=across-regions&report=concentration&month=2026-05'))) as unknown as string
    expect(csv).toMatch(/^# tokenscope across-regions concentration/)
    expect(csv).toContain('cohort,share_pct')
    expect(csv).toContain(`Top 1%,${((300 / 4650) * 100).toFixed(1)}`)
    expect(csv).toContain('segment,users,spend_usd,share_pct,avg_usd,median_usd')
    expect(csv).toContain('Power users,2,590.00,12.7,295.00,300.00')
    expect(csv).toContain('Light users,8,360.00,7.7,45.00,50.00')
  })

  it('the region-comparison CSV lists every region (§A usage; no month-grained chargeable column)', async () => {
    const csv = (await exportHandler(ev(gfo(), 'scope=across-regions&report=regions&month=2026-07'))) as unknown as string
    // The region-card `chargeableUsd` is month-grained AND UI-dead (the screen ranks §A off
    // genuineUsd, §B off the DAILY-grained chargebackByRegion), so it is not a CSV column —
    // a month-grained figure would read $0 in a sub-month range while the screen KPI is not.
    expect(csv).toContain('region,genuine_usd,active_users,avg_per_user_usd,share_pct')
    expect(csv).not.toContain('chargeable_usd')
    expect(csv).toContain('Region A,50.00,2,25.00,86.2')
    expect(csv).toContain('Region B,8.00,1,8.00,13.8')
  })

  it('a non-owner (admin) is FORBIDDEN from the across-regions export (403)', async () => {
    await expect(
      exportHandler(ev(sess('admin', 'a', regionA), 'scope=across-regions&report=drivers&month=2026-07')),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
