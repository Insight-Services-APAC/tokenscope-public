// @vitest-environment node
/*
 * Regional reporting scope — the Wave 2 endpoints (`/reports/regional{,/drivers,
 * /trend}`, `/reports/export`) exercised against a real testcontainers Postgres
 * via the OWNER connection (RLS inert in prod too, so the in-query scope clauses
 * are what's tested). Covers build-design §7:
 *   (1) drivers sum-back = headline (each axis, incl. the NULL-model bucket);
 *   (3) RBAC matrix (developer subtree/owner, manager subtree clamp, admin
 *       own-region force, global-finops any region, anti-IDOR on `ou`);
 *   (4) month-boundary invariance (Σ per-month over a range = unbounded);
 *   (5) export byte-identical to the JSON figures;
 *   + the Copilot "pending" marker (pool-utilisation mode) vs folded chargeback.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import regionalHandler from '../../../server/api/v1/reports/regional/index.get'
import driversHandler from '../../../server/api/v1/reports/regional/drivers.get'
import regionalTrendHandler from '../../../server/api/v1/reports/regional/trend.get'
import regionalSeasonalityHandler from '../../../server/api/v1/reports/regional/seasonality.get'
import exportHandler from '../../../server/api/v1/reports/export.get'
import metaHandler from '../../../server/api/v1/reports/meta.get'

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
let projA = ''

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
const sess = (role: string, orgPath: string, regionId: string, teammateId = '00000000-0000-0000-0000-000000000009'): Session =>
  ({ teammateId, email: 'x@x.test', displayName: 'X', role, regionId, orgPath, issuedAt: new Date().toISOString() } as unknown as Session)

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

  const mkUnit = async (region: string, path: string, code: string, costOwning: boolean, type = 'bu') => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${code}, ${type}, ${costOwning})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  unitA = await mkUnit(regionA, 'a', 'a', true)
  unitAsub = await mkUnit(regionA, 'a.sub', 'a-sub', false, 'team')
  unitB = await mkUnit(regionB, 'b', 'b', true)

  const mkTeammate = async (region: string, unit: string, email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  alice = await mkTeammate(regionA, unitA, 'alice@a.test')
  dave = await mkTeammate(regionA, unitAsub, 'dave@a.test') // Copilot-only (unaccounted)
  const bob = await mkTeammate(regionB, unitB, 'bob@b.test')

  // Project (region A, cost-owning a) — alice's tagged rows.
  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PROJ-A', 'hash-a', 'Project A', 'billable', ${regionA}::uuid, ${unitA}::uuid)`
  ;[{ id: projA }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='PROJ-A'`

  const mkInstance = async (teammateId: string, region: string, unit: string) => {
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${region}::uuid, ${unit}::uuid, 'h', 'P')`
    const [r] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid LIMIT 1`
    return r!.id
  }
  const aliceInst = await mkInstance(alice, regionA, unitA)
  const bobInst = await mkInstance(bob, regionB, unitB)

  const ar = async (inst: string, tm: string, region: string, unit: string, model: string, cost: number, day: string, projectId: string | null) => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${region}::uuid, ${unit}::uuid, ${projectId}::uuid, 'claude-code', ${model}, 'input', 1000, ${cost}, 'tier-1', 'estimated', ${day}::timestamptz, ${'conv-' + tm + day})`
  }
  // Region A — alice: June sonnet 10 (tagged) + opus 5 (untagged); July sonnet 20 (tagged).
  await ar(aliceInst, alice, regionA, unitA, 'claude-sonnet-4-6', 10, '2026-06-05T00:00:00Z', projA)
  await ar(aliceInst, alice, regionA, unitA, 'claude-opus-4-6', 5, '2026-06-06T00:00:00Z', null)
  await ar(aliceInst, alice, regionA, unitA, 'claude-sonnet-4-6', 20, '2026-07-02T00:00:00Z', projA)
  // Region B — bob: July sonnet 8.
  await ar(bobInst, bob, regionB, unitB, 'claude-sonnet-4-6', 8, '2026-07-02T00:00:00Z', null)

  // Copilot-only dave — the §A unaccounted gap (NULL model). June 15, July 30.
  const uu = async (day: string, cost: number) => {
    await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
      VALUES (${dave}::uuid, ${regionA}::uuid, ${unitAsub}::uuid, ${day}::date, 'copilot-cli', ${cost}, 0, 'api-reconciled')`
  }
  await uu('2026-06-15', 15)
  await uu('2026-07-10', 30)

  // Anthropic chargeable bill (region A, July) — alice actual_spend → homes to cost-owning 'a'.
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${alice}::uuid, '2026-07-01'::date, 'claude-code', 500, 500, 12, 'anthropic-analytics-api', false)`
  // Prior-month (June) Anthropic bill (alice, 8) — the chargeback-MoM operand. The bill
  // lane is separate from v_complete_usage, so no genuine figure changes.
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${alice}::uuid, '2026-06-10'::date, 'claude-code', 400, 400, 8, 'anthropic-analytics-api', false)`

  // Copilot pooled chargeback (region A, July) — folds in ONLY in chargeback mode.
  await t.client`INSERT INTO provider_enterprise (provider, external_id, display_name)
    VALUES ('github', 'ent-x', 'Enterprise X')`
  const [{ id: entId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM provider_enterprise WHERE external_id='ent-x'`
  await t.client`INSERT INTO copilot_pool_bill (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats, license_net_usd, overage_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-07-01'::date, ${entId}::uuid, NULL, ${unitA}::uuid, 5, 100, 20, 80, 90)`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface Kpis { genuineUsd: number; chargeableUsd: number; anthropicChargeableUsd: number; tokens: number; activeUsers: number; chargeMomDeltaPct: number | null; billedTeammates: number; billedTokens: number; avgChargePerBilledUser: number }
interface DailyMetric { day: string; genuineUsd: number; tokens: number; activeUsers: number }
interface ChargeDaily { day: string; chargeUsd: number }
interface ChargeDow { dow: number; chargeUsd: number }
interface RegionalResp {
  kpis: Kpis
  copilot: { mode: string; pending: boolean; chargeableUsd: number | null }
  chargebackProviderSplit: { anthropicUsd: number; copilotUsd: number | null }
  region: { id: string } | null
  regionOptions: { id: string }[]
  practices: { key: string; label: string; value: number }[]
  chargebackByCostCentre: { key: string; label: string; value: number }[]
  dailyMetrics: DailyMetric[]
  chargeDaily: ChargeDaily[]
  drill: { ouId: string } | null
}
interface TrendResp { series: unknown[]; chargeSeries: ChargeDaily[] }
interface SeasonalityResp { chargeDow: ChargeDow[] }
interface DriversResp { axis: string; headlineUsd: number; rows: { key: string; label: string; usd: number; sharePct: number; spendClass: string }[] }

const adminA = () => sess('admin', 'a', regionA)

describe('GET /reports/regional — RBAC scope matrix', () => {
  it('a developer sees only their own subtree (a.sub → dave), not a parent sibling', async () => {
    const r = (await regionalHandler(ev(sess('developer', 'a.sub', regionA)))) as unknown as RegionalResp
    expect(r.kpis.genuineUsd).toBe(30) // dave July only
  })

  it('a manager sees their whole subtree (a → alice + dave), never another region', async () => {
    const r = (await regionalHandler(ev(sess('manager', 'a', regionA), 'month=2026-07'))) as unknown as RegionalResp
    expect(r.kpis.genuineUsd).toBe(50) // alice 20 + dave 30
  })

  it('a manager CANNOT widen via ?region= (subtree clamp, param ignored)', async () => {
    const r = (await regionalHandler(ev(sess('manager', 'a', regionA), `month=2026-07&region=${regionB}`))) as unknown as RegionalResp
    expect(r.kpis.genuineUsd).toBe(50) // still region A subtree — bob (region B) invisible
  })

  it('a region admin is forced to their own region; the ?region= param is IGNORED', async () => {
    const own = (await regionalHandler(ev(adminA(), 'month=2026-07'))) as unknown as RegionalResp
    expect(own.kpis.genuineUsd).toBe(50) // whole region A (alice + dave)
    const widened = (await regionalHandler(ev(sess('admin', 'a', regionA), `month=2026-07&region=${regionB}`))) as unknown as RegionalResp
    expect(widened.kpis.genuineUsd).toBe(50) // param ignored — never region B's bob
  })

  it('global-finops defaults to its home region and can switch to ANY region', async () => {
    const home = (await regionalHandler(ev(sess('global-finops', 'a', regionA), 'month=2026-07'))) as unknown as RegionalResp
    expect(home.kpis.genuineUsd).toBe(50) // region A
    expect(home.regionOptions.length).toBe(2) // gets the picker
    const other = (await regionalHandler(ev(sess('global-finops', 'a', regionA), `month=2026-07&region=${regionB}`))) as unknown as RegionalResp
    expect(other.kpis.genuineUsd).toBe(8) // region B (bob)
  })

  it('an unknown region uuid → 404 (no silent fallback to all)', async () => {
    await expect(
      regionalHandler(ev(sess('global-finops', 'a', regionA), 'region=11111111-1111-4111-8111-111111111111')),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('anti-IDOR: a region admin drilling a FOREIGN-region `ou` → 403', async () => {
    await expect(
      regionalHandler(ev(adminA(), `ou=${unitB}`)),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('anti-IDOR: a developer cannot drill UP to a parent unit outside their subtree → 403', async () => {
    await expect(
      regionalHandler(ev(sess('developer', 'a.sub', regionA), `ou=${unitA}`)),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a developer CAN drill their own subtree unit', async () => {
    const r = (await regionalHandler(ev(sess('developer', 'a.sub', regionA), `ou=${unitAsub}&month=2026-07`))) as unknown as RegionalResp
    expect(r.drill?.ouId).toBe(unitAsub)
    expect(r.kpis.genuineUsd).toBe(30) // dave
  })
})

describe('GET /reports/regional — the monetised genuine-vs-chargeable pair', () => {
  it('pool-utilisation mode: chargeable = Anthropic only + Copilot "pending" marker', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const r = (await regionalHandler(ev(adminA(), 'month=2026-07'))) as unknown as RegionalResp
    expect(r.copilot.mode).toBe('pool-utilisation')
    expect(r.copilot.pending).toBe(true)
    expect(r.kpis.anthropicChargeableUsd).toBe(12)
    expect(r.kpis.chargeableUsd).toBe(12) // Copilot pooled net NOT folded in
    expect(r.kpis.genuineUsd).toBe(50) // genuine ≥ chargeable
  })

  it('chargeback mode: Copilot pooled net folds into chargeable, no pending marker', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const r = (await regionalHandler(ev(adminA(), 'month=2026-07'))) as unknown as RegionalResp
      expect(r.copilot.mode).toBe('chargeback')
      expect(r.copilot.pending).toBe(false)
      expect(r.kpis.chargeableUsd).toBe(132) // 12 Anthropic + 120 Copilot pooled net
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })
})

describe('GET /reports/regional — §A dailyMetrics + §B chargeback ranking + MoM', () => {
  it('dailyMetrics is the region §A per-day series, summing to the region headline', async () => {
    const r = (await regionalHandler(ev(adminA(), 'month=2026-07'))) as unknown as RegionalResp
    const byDay = new Map(r.dailyMetrics.map((d) => [d.day, d]))
    // Region A July: 07-02 alice 20 (1000 tok, 1 user); 07-10 dave gap 30 (0 tok, 1 user).
    expect(byDay.get('2026-07-02')).toMatchObject({ genuineUsd: 20, tokens: 1000, activeUsers: 1 })
    expect(byDay.get('2026-07-10')).toMatchObject({ genuineUsd: 30, tokens: 0, activeUsers: 1 })
    expect(r.dailyMetrics.reduce((a, d) => a + d.genuineUsd, 0)).toBe(50)
    // Zero-filled: EVERY July day present (31), no-usage days a genuine 0 (finding #6).
    expect(r.dailyMetrics.length).toBe(31)
    expect(byDay.get('2026-07-01')).toMatchObject({ genuineUsd: 0, tokens: 0, activeUsers: 0 })
    expect(byDay.get('2026-07-31')).toMatchObject({ genuineUsd: 0, tokens: 0, activeUsers: 0 })
  })

  it('chargebackByCostCentre ranks the §B charge per cost-owning unit (gated on chargeback mode)', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const pool = (await regionalHandler(ev(adminA(), 'month=2026-07'))) as unknown as RegionalResp
    // Pool mode: only Anthropic (alice 12) homes to cost-owning 'a'; Copilot pooled held back.
    const poolA = pool.chargebackByCostCentre.find((c) => c.label === 'a')
    expect(poolA).toBeDefined()
    expect(poolA!.value).toBe(12)

    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const cb = (await regionalHandler(ev(adminA(), 'month=2026-07'))) as unknown as RegionalResp
      // Chargeback mode: Anthropic 12 + Copilot pooled net 120 = 132 on cost-owning 'a'.
      const cbA = cb.chargebackByCostCentre.find((c) => c.label === 'a')
      expect(cbA!.value).toBe(132)
      // The ranking sums back to the region chargeable headline.
      expect(cb.chargebackByCostCentre.reduce((a, c) => a + c.value, 0)).toBe(cb.kpis.chargeableUsd)
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it('chargeMomDeltaPct is withheld for the in-progress month + range mode (§B accrues intra-month)', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    // The bill lane accrues daily intra-month, so an MTD-vs-full-prior-month MoM understates
    // the current month → withheld (null) until the viewed month closes (finding #3). Detected
    // dynamically (the current month) so it is not month-boundary flaky.
    const currentMonth = new Date().toISOString().slice(0, 7)
    const cur = (await regionalHandler(ev(adminA(), `month=${currentMonth}`))) as unknown as RegionalResp
    expect(cur.kpis.chargeMomDeltaPct).toBeNull()
    const range = (await regionalHandler(ev(adminA(), 'from=2026-07-01&to=2026-07-31'))) as unknown as RegionalResp
    expect(range.kpis.chargeMomDeltaPct).toBeNull() // no month anchor in range mode
  })
})

describe('GET /reports/regional — §B chargeback bill-lane cards (Anthropic per-teammate, scope-clamped)', () => {
  it('KPI billed figures are the ANTHROPIC per-teammate bill, scope-clamped to the region', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const r = (await regionalHandler(ev(adminA(), 'month=2026-07'))) as unknown as RegionalResp
    // Region A July: only alice carries an Anthropic bill (12, 500+500 tokens). dave is
    // Copilot-only (no per-teammate bill), so he is NOT billed.
    expect(r.kpis.billedTeammates).toBe(1)
    expect(r.kpis.billedTokens).toBe(1000)
    expect(r.kpis.avgChargePerBilledUser).toBe(12) // Anthropic 12 ÷ 1 billed teammate
  })

  it('the billed figures are FINANCE-scope-clamped — region B (no Anthropic bill) reports zero', async () => {
    // Region B (bob) has usage but NO actual bill homed to it, so the bill lane is empty there.
    const r = (await regionalHandler(ev(sess('global-finops', 'a', regionA), `month=2026-07&region=${regionB}`))) as unknown as RegionalResp
    expect(r.kpis.billedTeammates).toBe(0)
    expect(r.kpis.billedTokens).toBe(0)
    expect(r.kpis.avgChargePerBilledUser).toBe(0)
    expect(r.chargeDaily.reduce((a, d) => a + d.chargeUsd, 0)).toBe(0)
  })

  it('chargebackProviderSplit is Anthropic vs Copilot pooled, GATED on copilotChargeback', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const pool = (await regionalHandler(ev(adminA(), 'month=2026-07'))) as unknown as RegionalResp
    expect(pool.chargebackProviderSplit.anthropicUsd).toBe(12)
    expect(pool.chargebackProviderSplit.copilotUsd).toBeNull()
    expect(pool.chargebackProviderSplit.anthropicUsd).toBe(pool.kpis.chargeableUsd)

    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const cb = (await regionalHandler(ev(adminA(), 'month=2026-07'))) as unknown as RegionalResp
      expect(cb.chargebackProviderSplit.copilotUsd).toBe(120) // pooled net folded in
      expect(cb.chargebackProviderSplit.anthropicUsd + (cb.chargebackProviderSplit.copilotUsd ?? 0)).toBe(
        cb.kpis.chargeableUsd,
      )
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it('chargeDaily is the §B ANTHROPIC per-DAY series (day-grained, zero-filled, Copilot absent)', async () => {
    const r = (await regionalHandler(ev(adminA(), 'month=2026-07'))) as unknown as RegionalResp
    const byDay = new Map(r.chargeDaily.map((d) => [d.day, d.chargeUsd]))
    expect(byDay.get('2026-07-01')).toBe(12)
    expect(r.chargeDaily.length).toBe(31)
    // The Copilot pooled net (120, monthly) is ABSENT from the daily Anthropic series.
    expect(r.chargeDaily.reduce((a, d) => a + d.chargeUsd, 0)).toBe(12)
  })

  it('trend.chargeSeries + seasonality.chargeDow carry the §B bill lane (day / day-of-week)', async () => {
    const tr = (await regionalTrendHandler(ev(adminA(), 'month=2026-07'))) as unknown as TrendResp
    expect(new Map(tr.chargeSeries.map((d) => [d.day, d.chargeUsd])).get('2026-07-01')).toBe(12)
    expect(tr.chargeSeries.reduce((a, d) => a + d.chargeUsd, 0)).toBe(12)

    const se = (await regionalSeasonalityHandler(ev(adminA(), 'month=2026-07'))) as unknown as SeasonalityResp
    expect(se.chargeDow.length).toBe(7)
    expect(se.chargeDow.reduce((a, b) => a + b.chargeUsd, 0)).toBe(12)
    expect(se.chargeDow.find((b) => b.dow === isoDow0('2026-07-01'))!.chargeUsd).toBe(12)
  })
})

describe('GET /reports/regional/drivers — sum-back = headline (every axis)', () => {
  const axes = ['practice', 'teammate', 'model', 'project'] as const
  for (const axis of axes) {
    it(`axis=${axis}: Σ rows = headline = genuine, with the NULL bucket present`, async () => {
      const d = (await driversHandler(ev(adminA(), `month=2026-07&axis=${axis}`))) as unknown as DriversResp
      const sum = d.rows.reduce((a, r) => a + r.usd, 0)
      expect(sum).toBeCloseTo(d.headlineUsd, 6)
      expect(d.headlineUsd).toBe(50) // region A July genuine
      const shareSum = d.rows.reduce((a, r) => a + r.sharePct, 0)
      expect(shareSum).toBeCloseTo(1, 6)
    })
  }

  it('the model axis surfaces the NULL-model (unattributed) bucket = the Copilot gap', async () => {
    const d = (await driversHandler(ev(adminA(), 'month=2026-07&axis=model'))) as unknown as DriversResp
    const nullBucket = d.rows.find((r) => r.label === 'Unattributed')
    expect(nullBucket).toBeDefined()
    expect(nullBucket!.usd).toBe(30) // dave's Copilot gap
  })

  it('a pure-Copilot teammate row is `pooled-usage`; a Claude teammate is `indicative`', async () => {
    const d = (await driversHandler(ev(adminA(), 'month=2026-07&axis=teammate'))) as unknown as DriversResp
    const daveRow = d.rows.find((r) => r.label === 'dave@a.test')
    const aliceRow = d.rows.find((r) => r.label === 'alice@a.test')
    expect(daveRow!.spendClass).toBe('pooled-usage')
    expect(aliceRow!.spendClass).toBe('indicative')
  })
})

describe('GET /reports/regional/drivers — range mode windows the FULL range (not one month)', () => {
  // Region A, a multi-month window (June + July). Drivers must window the WHOLE range and
  // the CSV export must window the SAME range so screen == CSV in range mode.
  const RANGE = 'from=2026-06-01&to=2026-07-31'

  it('teammate drivers sum over June + July (80), NOT a single month', async () => {
    const d = (await driversHandler(ev(adminA(), `${RANGE}&axis=teammate`))) as unknown as DriversResp
    // Region A: alice (10+5 June + 20 July = 35) + dave (15 June + 30 July = 45) = 80.
    expect(d.headlineUsd).toBe(80)
    const byName = new Map(d.rows.map((r) => [r.label, r.usd]))
    expect(byName.get('alice@a.test')).toBe(35)
    expect(byName.get('dave@a.test')).toBe(45)
    expect(d.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(80, 6)
  })

  it('the drivers CSV export windows the SAME range — byte-identical to the screen figures', async () => {
    const json = (await driversHandler(ev(adminA(), `${RANGE}&axis=teammate`))) as unknown as DriversResp
    const csv = (await exportHandler(ev(adminA(), `scope=regional&report=drivers&axis=teammate&${RANGE}`))) as unknown as string
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
  })
})

describe('GET /reports/regional — month-boundary invariance', () => {
  it('Σ per-month (June + July) = the unbounded total over the range', async () => {
    const june = (await regionalHandler(ev(adminA(), 'month=2026-06'))) as unknown as RegionalResp
    const july = (await regionalHandler(ev(adminA(), 'month=2026-07'))) as unknown as RegionalResp
    expect(june.kpis.genuineUsd).toBe(30) // alice 10+5 + dave 15
    expect(july.kpis.genuineUsd).toBe(50) // alice 20 + dave 30
    // Unbounded total over [June, Aug) straight from the view, same scope (region A).
    const [{ total }] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM v_complete_usage
      WHERE region_id = ${regionA}::uuid
        AND ts_event >= '2026-06-01T00:00:00Z'::timestamptz
        AND ts_event <  '2026-08-01T00:00:00Z'::timestamptz`
    expect(june.kpis.genuineUsd + july.kpis.genuineUsd).toBe(Number(total))
    expect(Number(total)).toBe(80)
  })
})

interface MetaResp {
  scopes: string[]
  defaultScope: string | null
  defaultRegionId: string | null
  monthFloors: { usage: string | null; bill: string | null; reconciliation: string | null; overall: string }
  copilotMode: string
}

describe('GET /reports/meta — granted scopes + floors + copilot mode', () => {
  it('a developer (no CC ownership) is granted ONLY the regional scope', async () => {
    const m = (await metaHandler(ev(sess('developer', 'a.sub', regionA, dave)))) as unknown as MetaResp
    expect(m.scopes).toEqual(['regional'])
    expect(m.defaultScope).toBe('regional')
  })

  it('an admin is granted regional + cost-centre (NOT finance — D-Q5 global-only; NOT across)', async () => {
    // owner-decisions D-Q5 (ratified 2026-07-02) supersedes build-design §8 Q5's
    // region-finance: Finance is a GLOBAL function — global-finops + platform-admin
    // ONLY. A region admin is NOT granted the Finance tab (the endpoint 403s too).
    const m = (await metaHandler(ev(adminA()))) as unknown as MetaResp
    expect(m.scopes).toEqual(expect.arrayContaining(['regional', 'cost-centre']))
    expect(m.scopes).not.toContain('finance')
    expect(m.scopes).not.toContain('across')
  })

  it('global-finops is granted every scope; floors span the lanes; copilot defaults to pool-utilisation', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const m = (await metaHandler(ev(sess('global-finops', 'a', regionA)))) as unknown as MetaResp
    expect(m.scopes).toEqual(['across', 'regional', 'cost-centre', 'finance'])
    expect(m.defaultScope).toBe('across')
    expect(m.defaultRegionId).toBe(regionA)
    expect(m.monthFloors.usage).toBe('2026-06') // earliest attribution/unaccounted month
    expect(m.monthFloors.overall).toBe('2026-06') // MIN over the lanes
    expect(m.copilotMode).toBe('pool-utilisation')
  })
})

describe('GET /reports/export — byte-identical to the screen figures', () => {
  it('the drivers CSV rows carry the SAME spend + share as the JSON endpoint', async () => {
    const json = (await driversHandler(ev(adminA(), 'month=2026-07&axis=teammate'))) as unknown as DriversResp
    const csv = (await exportHandler(ev(adminA(), 'scope=regional&report=drivers&axis=teammate&month=2026-07'))) as unknown as string
    expect(typeof csv).toBe('string')
    const lines = csv.trim().split('\n')
    expect(lines[0]).toMatch(/^# tokenscope regional drivers/) // asOf provenance stamp
    expect(lines[1]).toBe('driver,spend_usd,share_pct,spend_class')
    // Map CSV data rows → { label: { usd, share } } and compare to JSON.
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
    // The CSV escapes formula-injection + is snapshot-stable for the seeded month.
    expect(csv).toContain('dave@a.test,30.00,60.0,pooled-usage')
    expect(csv).toContain('alice@a.test,20.00,40.0,indicative')
  })
})
