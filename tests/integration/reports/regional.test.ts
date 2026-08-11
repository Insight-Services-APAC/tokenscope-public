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
import regionalHandler from '../../../server/api/v1/reports/region/index.get'
import driversHandler from '../../../server/api/v1/reports/region/drivers.get'
import regionalTrendHandler from '../../../server/api/v1/reports/region/trend.get'
import regionalSeasonalityHandler from '../../../server/api/v1/reports/region/seasonality.get'
import exportHandler from '../../../server/api/v1/reports/export.get'
import metaHandler from '../../../server/api/v1/reports/meta.get'
import { resolveRegionalScope, fetchRegionalExceptions } from '../../../server/reporting/regional'
import {
  MODEL_GAP_REASON_LABELS,
  UNATTRIBUTED_MODEL_KEY,
  UNATTRIBUTED_MODEL_LABEL,
} from '../../../shared/reports/model-attribution'

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

  const mkUnit = async (region: string, path: string, code: string, costOwning: boolean, type = 'bu', parent: string | null = null) => {
    await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${parent}::uuid, ${path}::ltree, ${code}, ${code}, ${type}, ${costOwning})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  // S3 part (a): 'a' is used below as a MANAGER's own placement, which now must pass
  // placedBelowRegionRootPredicate() (parent_id IS NOT NULL). unit_type 'holding' so this
  // placeholder is excluded from every §A/§B usage query (they never select holding units) —
  // it exists ONLY as a parent_id target, invisible to every other assertion in this file.
  const s3RegionARootId = await mkUnit(regionA, 'ra_root', '__s3_root__', false, 'holding')
  unitA = await mkUnit(regionA, 'a', 'a', true, 'bu', s3RegionARootId)
  unitAsub = await mkUnit(regionA, 'a.sub', 'a-sub', false, 'team', unitA)
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
  // A REAL row for sess()'s default teammateId (S3: exportRegional's axis=teammate
  // audit event FKs actor_teammate_id onto teammate.id — every `sess()` caller in
  // this file now needs a backing row, not just a synthetic uuid literal).
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('00000000-0000-0000-0000-000000000009'::uuid, 'oid-default-caller', 'caller@a.test', 'Caller', ${regionA}::uuid, ${unitA}::uuid, true)`

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
  // model_gap_reason as the S1 writer stamps it for a github-money-backed key
  // (mig 0123): Copilot money is day-grain, so the fill has no model children
  // and the view's arm-2 remainder carries the reason (mig 0124).
  const uu = async (day: string, cost: number) => {
    await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source, model_gap_reason)
      VALUES (${dave}::uuid, ${regionA}::uuid, ${unitAsub}::uuid, ${day}::date, 'copilot-cli', ${cost}, 0, 'api-reconciled', 'provider-day-grain')`
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

interface Kpis { genuineUsd: number; chargeableUsd: number; anthropicChargeableUsd: number; tokens: number; activeUsers: number; momDeltaPct: number | null; chargeMomDeltaPct: number | null; billedTeammates: number; billedTokens: number; avgChargePerBilledUser: number }
interface DailyMetric { day: string; genuineUsd: number; tokens: number; activeUsers: number }
interface ChargeDaily { day: string; chargeUsd: number }
interface ChargeDow { dow: number; chargeUsd: number }
interface PerPerson {
  medianUsd: number
  top1: number
  top5: number
  top10: number
  emittingPeople: number
  peopleMomDelta: number | null
  medianMomDeltaPct: number | null
}
interface RegionalResp {
  kpis: Kpis
  perPerson?: PerPerson
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
interface DriversResp { axis: string; headlineUsd: number; rows: { key: string; label: string; usd: number; sharePct: number; spendClass: string; gap_reason?: string | null }[] }

const adminA = () => sess('admin', 'a', regionA)

/*
 * THE MEDIAN TILE'S OPERANDS ARE CLAMPED BY THE CALLER'S OWN SCOPE.
 *
 * The Region width renders the whole-company width's KPI row now, which means it
 * publishes a median, three percentiles and an emitting split it never used to.
 * Every one of those is a statement about a POPULATION, so the failure that
 * matters is a region owner (or worse, a manager) reading the whole company's
 * distribution under their own name.
 *
 * `fetchPerPerson` itself is clamp-tested at the engine level
 * (scope-engine-clamp.test.ts). What THIS pins is the wiring: that the route's
 * regional branch hands it the same clamp `kpis` was summed over, per RBAC role.
 *
 * MUTATION: pass `wholeCompanyUsage` in `fetchRegionalPerPerson` (or drop the
 * `perPerson` field from the regional branch of the route) — these go red.
 */
describe('GET /reports/region — the per-person cohort follows the caller clamp', () => {
  it("a developer's cohort is their subtree alone, not the region", async () => {
    const r = (await regionalHandler(
      ev(sess('developer', 'a.sub', regionA), 'month=2026-07'),
    )) as unknown as RegionalResp
    // dave alone: $30. One person holds the whole distribution.
    expect(r.kpis.activeUsers).toBe(1)
    expect(r.perPerson!.medianUsd).toBeCloseTo(30, 2)
    expect(r.perPerson!.top1).toBeCloseTo(1, 6)
  })

  it("a manager's cohort is their whole subtree, and no wider", async () => {
    const r = (await regionalHandler(
      ev(sess('manager', 'a', regionA), 'month=2026-07'),
    )) as unknown as RegionalResp
    // alice $20 + dave $30 = $50 across two people — a DIFFERENT distribution
    // from the developer's above, which is what proves the clamp moved with the
    // caller rather than being computed once for everyone.
    expect(r.kpis.activeUsers).toBe(2)
    expect(r.perPerson!.top1).toBeCloseTo(30 / 50, 6)
    expect(r.perPerson!.top1).not.toBeCloseTo(1, 6)
  })

  it('divides by the SAME headcount the KPI row publishes', async () => {
    const r = (await regionalHandler(
      ev(adminA(), 'month=2026-07'),
    )) as unknown as RegionalResp
    // The tile reads "half of N are below this" over `kpis.activeUsers`, so the
    // cohort and the count must be one population rather than two queries that
    // happen to agree.
    expect(r.kpis.activeUsers).toBe(2)
    expect(r.perPerson!.emittingPeople).toBeLessThanOrEqual(r.kpis.activeUsers)
  })

  /*
   * The §A MoM moved onto the payload. It used to be computed CLIENT-side from a
   * second fetch of the paced previous month — a divergent second implementation
   * of a figure the KPI engine already owns.
   *
   * MUTATION: drop `momDeltaPct` from the regional branch of the route — red.
   */
  it('carries the §A month-over-month delta the client used to re-derive', async () => {
    const r = (await regionalHandler(
      ev(adminA(), 'month=2026-07'),
    )) as unknown as RegionalResp
    expect(r.kpis).toHaveProperty('momDeltaPct')
  })
})

describe('GET /reports/region — RBAC scope matrix', () => {
  it('a developer sees only their own subtree (a.sub → dave), not a parent sibling', async () => {
    // `month=` like every sibling in this describe. Without it the handler
    // defaults to the CURRENT month against a July-seeded fixture, so the test
    // asserted the scope clamp on an empty window — green until 31 July 2026 and
    // red every day after, while proving nothing about the clamp either way.
    const r = (await regionalHandler(ev(sess('developer', 'a.sub', regionA), 'month=2026-07'))) as unknown as RegionalResp
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

  it('global-finops gets a picker and can switch to ANY region', async () => {
    // This fixture cannot tell the default RULE apart — 'Region A' is both this
    // caller's home and the first by display_name. The org-wide default (first by
    // (display_name, code), home ignored) is pinned where the two disagree:
    // tests/integration/reports/regional-default-region.test.ts.
    const dflt = (await regionalHandler(ev(sess('global-finops', 'a', regionA), 'month=2026-07'))) as unknown as RegionalResp
    expect(dflt.kpis.genuineUsd).toBe(50) // region A
    expect(dflt.regionOptions.length).toBe(2) // gets the picker
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

describe('GET /reports/region — the monetised genuine-vs-chargeable pair', () => {
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

describe('GET /reports/region — §A dailyMetrics + §B chargeback ranking + MoM', () => {
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

describe('GET /reports/region — §B chargeback bill-lane cards (Anthropic per-teammate, scope-clamped)', () => {
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

describe('GET /reports/region/drivers — sum-back = headline (every axis)', () => {
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

  it('the model axis REASON-TYPES the Copilot-gap remainder — no untyped bucket left', async () => {
    /*
     * Mig 0124: a NULL-model row is a REMAINDER carrying model_gap_reason.
     * dave's Copilot fill is github day-grain money → 'provider-day-grain',
     * whole (day-grain money is never split by a ratio). The KEY and LABEL
     * come from the shared helper — the constant, never the literal (the old
     * lesson stands: hand-copied labels broke on the last honest rewording).
     */
    const d = (await driversHandler(ev(adminA(), 'month=2026-07&axis=model'))) as unknown as DriversResp
    const gap = d.rows.find((r) => r.gap_reason === 'provider-day-grain')
    expect(gap).toBeDefined()
    expect(gap!.usd).toBe(30) // dave's Copilot gap
    expect(gap!.key).toBe(`${UNATTRIBUTED_MODEL_KEY}:provider-day-grain`)
    expect(gap!.label).toBe(MODEL_GAP_REASON_LABELS['provider-day-grain'])
    // The un-typed residual bucket is gone — every NULL-model row carries a reason.
    expect(d.rows.some((r) => r.key === UNATTRIBUTED_MODEL_KEY)).toBe(false)
    expect(d.rows.some((r) => r.label === UNATTRIBUTED_MODEL_LABEL)).toBe(false)
  })

  it('a pure-Copilot teammate row is `pooled-usage`; a Claude teammate is `indicative`', async () => {
    const d = (await driversHandler(ev(adminA(), 'month=2026-07&axis=teammate'))) as unknown as DriversResp
    const daveRow = d.rows.find((r) => r.label === 'dave@a.test')
    const aliceRow = d.rows.find((r) => r.label === 'alice@a.test')
    expect(daveRow!.spendClass).toBe('pooled-usage')
    expect(aliceRow!.spendClass).toBe('indicative')
  })
})

describe('GET /reports/region/drivers — range mode windows the FULL range (not one month)', () => {
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
    const csv = (await exportHandler(ev(adminA(), `scope=region&report=drivers&axis=teammate&${RANGE}`))) as unknown as string
    const lines = csv.trim().split('\n')
    expect(lines[1]).toBe('driver,spend_usd,share_pct,spend_class,otel_emitted_usd,api_reconciled_usd,provider_usage_usd,surface_mix')
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

describe('GET /reports/region — month-boundary invariance', () => {
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
  /** The Region scope's landing WIDTH — a width, deliberately never a region id. */
  region: { landing: 'all-regions' | 'own-region' | null; allRegions: boolean }
  monthFloors: { usage: string | null; bill: string | null; reconciliation: string | null; overall: string }
  copilotMode: string
}

describe('GET /reports/meta — granted scopes + floors + copilot mode', () => {
  it('a developer (no CC ownership) is granted ONLY the region scope, landing on their own region', async () => {
    const m = (await metaHandler(ev(sess('developer', 'a.sub', regionA, dave)))) as unknown as MetaResp
    expect(m.scopes).toEqual(['region'])
    expect(m.defaultScope).toBe('region')
    // The landing WIDTH: no `across` grant ⇒ their own region, and "All regions" is
    // not offered at all. This is the half of the merge a scope list cannot express.
    expect(m.region).toEqual({ landing: 'own-region', allRegions: false })
  })

  it('an admin is granted region + cost-centre (NOT finance — D-Q5 global-only; no All-regions width)', async () => {
    // owner-decisions D-Q5 (ratified 2026-07-02) supersedes build-design §8 Q5's
    // region-finance: Finance is a GLOBAL function — global-finops + platform-admin
    // ONLY. A region admin is NOT granted the Finance tab (the endpoint 403s too).
    const m = (await metaHandler(ev(adminA()))) as unknown as MetaResp
    expect(m.scopes).toEqual(expect.arrayContaining(['region', 'cost-centre']))
    expect(m.scopes).not.toContain('finance')
    // The retired scope names are gone from the contract entirely.
    expect(m.scopes).not.toContain('across')
    expect(m.scopes).not.toContain('regional')
    // Under STANDARD policy an admin holds no `across`, so the whole-company width
    // is not on their selector and they land on their own region.
    expect(m.region).toEqual({ landing: 'own-region', allRegions: false })
  })

  it('global-finops is granted every scope; floors span the lanes; copilot defaults to pool-utilisation', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const m = (await metaHandler(ev(sess('global-finops', 'a', regionA)))) as unknown as MetaResp
    expect(m.scopes).toEqual(['region', 'cost-centre', 'finance'])
    expect(m.defaultScope).toBe('region')
    // The `across` holder still opens on the whole-company answer — now as the
    // Region scope's first selector option rather than a tab of its own.
    expect(m.region).toEqual({ landing: 'all-regions', allRegions: true })
    // No region default: the bootstrap does not answer "which region" at all. The
    // Regional scope decides that per caller (resolveRegionalScope) and returns the
    // region it decided ON the responses whose figures it governs, so there is no
    // second, hour-cached answer to disagree with them.
    expect(m).not.toHaveProperty('defaultRegionId')
    expect(m.monthFloors.usage).toBe('2026-06') // earliest attribution/unaccounted month
    expect(m.monthFloors.overall).toBe('2026-06') // MIN over the lanes
    expect(m.copilotMode).toBe('pool-utilisation')
  })
})

describe('GET /reports/export — byte-identical to the screen figures', () => {
  it('the drivers CSV rows carry the SAME spend + share as the JSON endpoint', async () => {
    const json = (await driversHandler(ev(adminA(), 'month=2026-07&axis=teammate'))) as unknown as DriversResp
    const csv = (await exportHandler(ev(adminA(), 'scope=region&report=drivers&axis=teammate&month=2026-07'))) as unknown as string
    expect(typeof csv).toBe('string')
    const lines = csv.trim().split('\n')
    expect(lines[0]).toMatch(/^# tokenscope regional drivers/) // asOf provenance stamp
    expect(lines[1]).toBe('driver,spend_usd,share_pct,spend_class,otel_emitted_usd,api_reconciled_usd,provider_usage_usd,surface_mix')
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

describe('GET /reports/export — the teammate-axis driver export is complete + audited', () => {
  // A dedicated region, isolated from every other test's totals, carrying a
  // teammate population far larger than anything the other fixtures seed. Size is
  // the point: a truncation defect only shows on a population big enough to
  // truncate, so the completeness assertions below are made at 105 people rather
  // than the handful the byte-identical tests above use.
  const N = 105
  let capRegionId = ''
  let capUnitId = ''

  beforeAll(async () => {
    const [r] = await t.client<{ id: string }[]>`
      INSERT INTO region (code, display_name) VALUES ('cap-rg', 'Cap Region') RETURNING id::text AS id`
    capRegionId = r!.id
    const [u] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${capRegionId}::uuid, 'caproot'::ltree, 'caproot', 'Cap Root', 'bu', true)
      RETURNING id::text AS id`
    capUnitId = u!.id
    // Bulk-insert N teammates + one instance + one attribution row each — three
    // generate_series-driven statements instead of N round trips.
    await t.client`
      INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      SELECT 'oid-cap-' || i, 'cap' || lpad(i::text, 3, '0') || '@cap.test',
             'cap' || lpad(i::text, 3, '0') || '@cap.test', ${capRegionId}::uuid, ${capUnitId}::uuid, true
      FROM generate_series(0, ${N - 1}) AS i`
    await t.client`
      INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      SELECT gen_random_uuid(), 'p-' || t.id, t.id, 'claude-code', ${capRegionId}::uuid, ${capUnitId}::uuid, 'h', 'P'
      FROM teammate t WHERE t.region_id = ${capRegionId}::uuid`
    await t.client`
      INSERT INTO attribution_record (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event)
      SELECT ia.instance_id, ia.teammate_id, ${capRegionId}::uuid, ${capUnitId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 100, 1.00, 'tier-1', 'estimated', '2026-07-15T00:00:00Z'::timestamptz
      FROM instance_attestation ia WHERE ia.region_id = ${capRegionId}::uuid`
  }, 60_000)

  it(`exports every one of the ${N} teammates — one row each, no synthetic tail`, async () => {
    const json = (await driversHandler(ev(sess('admin', 'caproot', capRegionId), 'month=2026-07&axis=teammate'))) as unknown as DriversResp
    expect(json.rows.length).toBe(N)

    const csv = (await exportHandler(
      ev(sess('admin', 'caproot', capRegionId), 'scope=region&report=drivers&axis=teammate&month=2026-07'),
    )) as unknown as string
    const lines = csv.trim().split('\n')
    const dataRows = lines.slice(2)
    // One row per teammate and nothing else: a file that folded a tail would be
    // SHORTER than the screen and would still foot, which is precisely why the
    // row COUNT is asserted and not only the sum.
    expect(dataRows.length).toBe(N)
    expect(csv).not.toContain('all other')

    // The CSV is byte-identical to the screen at this size, as at every other
    // (build-design §2) — same headline, same population.
    const csvTotal = dataRows.reduce((a, line) => a + Number(line.split(',')[1]), 0)
    const jsonTotal = json.rows.reduce((a, r) => a + r.usd, 0)
    expect(csvTotal).toBeCloseTo(jsonTotal, 2)
    expect(csvTotal).toBeCloseTo(N * 1.0, 2)
  })

  it('records EXACTLY ONE audit_event PER export call (no names in the payload)', async () => {
    // Scoped as a before/after DELTA, not a bare count — the prior test in this
    // describe block also exports axis=teammate for this same fixture and so
    // ALSO writes a matching row; this test only asserts THIS call's contribution.
    const [{ n: before }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'report-export-teammate-axis' AND (payload->>'rowCount')::int = ${N}`
    await exportHandler(ev(sess('admin', 'caproot', capRegionId), 'scope=region&report=drivers&axis=teammate&month=2026-07'))
    const rows = await t.client<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM audit_event
      WHERE event_type = 'report-export-teammate-axis' AND (payload->>'rowCount')::int = ${N}
      ORDER BY ts_recorded DESC LIMIT 1`
    const [{ n: after }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'report-export-teammate-axis' AND (payload->>'rowCount')::int = ${N}`
    expect(Number(after)).toBe(Number(before) + 1) // exactly one NEW row from this call
    const payload = rows[0]!.payload
    // `scope` + `width`: after the merge both widths export under one scope name, so
    // the width is what tells a forensic reader whether one region's people or the
    // whole company's were in the CSV.
    expect(payload).toMatchObject({
      scope: 'region',
      width: 'region',
      report: 'drivers',
      axis: 'teammate',
      rowCount: N,
    })
    // Counts and ids only: the record describes the ACT of exporting, and copying
    // every exported row into it would grow the audit log by the size of the
    // report on every download.
    expect(JSON.stringify(payload)).not.toContain('@cap.test')
  })

  it('a non-teammate axis writes NO audit_event — there is no teammate grain to record', async () => {
    await exportHandler(
      ev(sess('admin', 'caproot', capRegionId), 'scope=region&report=drivers&axis=model&month=2026-07'),
    )
    const rows = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'report-export-teammate-axis' AND payload->>'axis' = 'model'`
    expect(Number(rows[0]!.n)).toBe(0)
  })

  /*
   * ── THE WHOLE-COMPANY WIDTH RECORDS ITS OWN WIDTH ──────────────────────────
   *
   * `region=all` is the SAME report over the LARGER population — every teammate
   * in the company. Both widths export under one scope name, so `width` in the
   * payload is the only thing that later distinguishes a company-wide pull from a
   * single-region one.
   */
  const finops = () => sess('global-finops', 'caproot', capRegionId)

  it('audits the WHOLE-COMPANY teammate export, with the width that names the population', async () => {
    const [{ n: before }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'report-export-teammate-axis' AND payload->>'width' = 'all-regions'`
    await exportHandler(
      ev(finops(), 'scope=region&region=all&report=drivers&axis=teammate&month=2026-07'),
    )
    const [{ n: after }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'report-export-teammate-axis' AND payload->>'width' = 'all-regions'`
    expect(Number(after)).toBe(Number(before) + 1)

    const [row] = await t.client<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM audit_event
      WHERE event_type = 'report-export-teammate-axis' AND payload->>'width' = 'all-regions'
      ORDER BY ts_recorded DESC LIMIT 1`
    expect(row!.payload).toMatchObject({
      scope: 'region',
      width: 'all-regions',
      report: 'drivers',
      axis: 'teammate',
    })
    // Counts and ids only — see the clamped-width test above for why.
    expect(JSON.stringify(row!.payload)).not.toContain('@cap.test')
  })

  /*
   * ── THE MULTI-ARM FILE, ACROSS DISJOINT ARMS ──────────────────────────────
   *
   * The chargeback lane writes teammate labels into the folded ranking AND one
   * block per provider ARM. The two arms are NOT the same population: the
   * Anthropic arm is a CHARGE (`provider_usage_fact`, provider='anthropic') and
   * the GitHub arm is CONSUMPTION — and a teammate can appear on one and not the
   * other. Below, 60 people have an Anthropic charge and 45 DIFFERENT people have
   * GitHub consumption, so the file must name all 105.
   *
   * This is the hardest shape for a completeness claim: a file that dropped names
   * from ONE arm still looks complete from the ranking alone, and each arm would
   * still foot to its own declared total.
   */
  const ANTHROPIC_N = 60
  const GITHUB_N = 45
  beforeAll(async () => {
    // Deliberately AUGUST, so no other assertion in this file can see these rows.
    await t.client`
      INSERT INTO provider_usage_fact
        (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd,
         region_id, org_unit_id, cost_owning_unit_id)
      SELECT 'src-anthropic', 'anthropic', t.id, 'a@x.test', '2026-08-05'::date, 'claude-code',
             'claude-opus-5', 'tokens', 2.00, ${capRegionId}::uuid, ${capUnitId}::uuid, ${capUnitId}::uuid
      FROM teammate t WHERE t.region_id = ${capRegionId}::uuid
      ORDER BY t.email LIMIT ${ANTHROPIC_N}`
    await t.client`
      INSERT INTO provider_usage_fact
        (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd,
         region_id, org_unit_id, cost_owning_unit_id)
      SELECT 'src-github', 'github', t.id, 'g@x.test', '2026-08-05'::date, 'copilot-cli',
             NULL, 'tokens', 3.00, ${capRegionId}::uuid, ${capUnitId}::uuid, ${capUnitId}::uuid
      FROM teammate t WHERE t.region_id = ${capRegionId}::uuid
      ORDER BY t.email OFFSET ${ANTHROPIC_N} LIMIT ${GITHUB_N}`
  }, 60_000)

  it.each(['', 'region=all&'] as const)(
    'names EVERY teammate across the ranking AND both disjoint arms (%s)',
    async (widthParam) => {
      const csv = (await exportHandler(
        ev(finops(), `scope=region&${widthParam}report=drivers&axis=teammate&lane=chargeback&month=2026-08`),
      )) as unknown as string
      const lines = csv.trim().split('\n')

      // The file really does carry BOTH arms, or the union assertion below is
      // exhaustive over a set that never had the hard case in it.
      expect(lines.some((l) => l.startsWith('anthropic,billed,'))).toBe(true)
      expect(lines.some((l) => l.startsWith('github,consumption,'))).toBe(true)

      // Every teammate name anywhere in the file — the ranking's first column and
      // the arm block's `driver` column alike.
      const names = new Set<string>()
      for (const line of lines) {
        for (const cell of line.split(',')) {
          if (cell.endsWith('@cap.test')) names.add(cell)
        }
      }
      // The union of both arms, in full. Asserted as an EQUALITY: "at least N"
      // would pass on a file that dropped names from one arm and made them up in
      // the other.
      expect(names.size).toBe(ANTHROPIC_N + GITHUB_N)
      expect(csv).not.toContain('all other')

      // Each arm foots to its own declared total.
      const armLines = lines.filter((l) => /^(anthropic|github),/.test(l))
      const byArm = new Map<string, { declared: number; sum: number }>()
      for (const l of armLines) {
        const c = l.split(',')
        const key = `${c[0]},${c[1]}`
        const acc = byArm.get(key) ?? { declared: Number(c[4]), sum: 0 }
        acc.sum += Number(c[6] || 0)
        byArm.set(key, acc)
      }
      for (const [, v] of byArm) expect(v.sum).toBeCloseTo(v.declared, 2)
    },
  )
})

/* ── THE DRILL FACTS ON THE SIGNALS STRIP (D34, r5-H1) ──────────────────────── */

describe('fetchRegionalExceptions — a velocity signal carries its own drill facts', () => {
  /*
   * ── THE DEFECT ────────────────────────────────────────────────────────────
   * The signals strip names people. Its rows carried `is_active` and nothing
   * else, so `RegionalSignals.vue` fell back to the client helper's permissive
   * `isProvisional` default and rendered a PROVISIONAL SHADOW — an ACTIVE
   * teammate minted by the unauthenticated enrol path, whose email is a claim
   * nobody has verified (mig 0057) — as a live link onto a page that 403s.
   *
   * Both facts now come from the ONE shared producer
   * (`server/reporting/teammate-drill-facts.ts`).
   *
   * MUTATION: delete `${TEAMMATE_DRILL_FACTS}` from `fetchRegionalExceptions`
   * (server/reporting/regional.ts) and the second test goes red —
   * `isProvisional` comes back `undefined` for the shadow, which is exactly the
   * value that used to admit the drill.
   *
   * ── WHY THIS FIXTURE IS `NOW()`-RELATIVE ─────────────────────────────────
   * This is the one §A read in the file that is NOT month-bounded: the signal is
   * "this week against the trailing 4-week mean". So the rows are anchored on
   * `date_trunc('week', NOW())` rather than on the June/July fixture above, and
   * they live in their own unit so no windowed assertion elsewhere can see them.
   */
  let spiker = ''
  let shadow = ''
  let unitSignals = ''

  beforeAll(async () => {
    await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionA}::uuid, ${unitA}::uuid, 'a.signals'::ltree, 'a-signals', 'a-signals', 'team', false)`
    const [u] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM org_unit WHERE region_id=${regionA}::uuid AND code='a-signals'`
    unitSignals = u!.id

    const mk = async (email: string, provisional: boolean) => {
      await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active, provisional)
        VALUES ('oid-'||${email}, ${email}, ${email}, ${regionA}::uuid, ${unitSignals}::uuid, true, ${provisional})`
      const [r] = await t.client<{ id: string }[]>`
        SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-'||${email}`
      await t.client`INSERT INTO instance_attestation
          (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
        VALUES (gen_random_uuid(), 'p-'||${email}, ${r!.id}::uuid, 'claude-code',
                ${regionA}::uuid, ${unitSignals}::uuid, 'h', 'P')`
      return r!.id
    }
    // The confirmed spiker, and the shadow claiming someone else's address. Both
    // spike identically — the ONLY difference between them is `provisional`.
    spiker = await mk('spiker@a.test', false)
    shadow = await mk('victim@a.test', true)

    /** `weeksAgo = 0` is the CURRENT week; 1..3 are the rolling baseline. */
    const spend = async (tm: string, weeksAgo: number, cost: number) => {
      const [i] = await t.client<{ id: string }[]>`
        SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${tm}::uuid LIMIT 1`
      await t.client`INSERT INTO attribution_record
          (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens,
           cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
        VALUES (${i!.id}::uuid, ${tm}::uuid, ${regionA}::uuid, ${unitSignals}::uuid,
                'claude-code', 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated',
                date_trunc('week', NOW()) - (${weeksAgo}::text || ' weeks')::interval + INTERVAL '1 hour',
                ${'sig-' + tm + weeksAgo})`
    }
    for (const tm of [spiker, shadow]) {
      for (const w of [1, 2, 3]) await spend(tm, w, 10) // baseline mean = 10
      await spend(tm, 0, 100) // current week = 100 ⇒ +900%
    }
  })

  const exceptions = async () => {
    const scope = await resolveRegionalScope(
      t.db,
      { role: 'global-finops', regionId: regionA },
      { region: regionA },
      { crossRegion: true },
    )
    return fetchRegionalExceptions(t.db, scope, 0.25)
  }

  it('a confirmed spiker is flagged and states BOTH facts as booleans', async () => {
    const rows = await exceptions()
    const r = rows.find((x) => x.name === 'spiker@a.test')
    expect(r, 'the confirmed spiker is not on the strip').toBeTruthy()
    expect(r!.deltaPct).toBeGreaterThan(0.25)
    // Present, not `undefined` — an absent fact is what ADMITTED the drill.
    expect(typeof r!.isActive).toBe('boolean')
    expect(typeof r!.isProvisional).toBe('boolean')
    expect(r!.isActive).toBe(true)
    expect(r!.isProvisional).toBe(false)
  })

  it('a PROVISIONAL shadow is still flagged, and says so', async () => {
    const rows = await exceptions()
    const r = rows.find((x) => x.name === 'victim@a.test')
    // The SIGNAL survives: this strip is a top-N callout that foots to nothing,
    // so suppressing the row would silently unreport a real spike. The DOOR is
    // what closes, and it closes on this fact.
    expect(r, 'the shadow spiker was dropped from the strip').toBeTruthy()
    expect(r!.isProvisional).toBe(true)
    // A shadow IS active — that is precisely why `is_active` alone let it through.
    expect(r!.isActive).toBe(true)
    expect(r!.teammateId).toBe(shadow)
  })

  it('a DEACTIVATED spiker is flagged and reports isActive false', async () => {
    await t.client`UPDATE teammate SET is_active = false WHERE entra_oid = 'oid-spiker@a.test'`
    try {
      const r = (await exceptions()).find((x) => x.name === 'spiker@a.test')
      expect(r).toBeTruthy()
      expect(r!.isActive).toBe(false)
      expect(r!.isProvisional).toBe(false)
    } finally {
      await t.client`UPDATE teammate SET is_active = true WHERE entra_oid = 'oid-spiker@a.test'`
    }
  })
})
