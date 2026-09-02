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
import { buildUsageRollup } from '../helpers/usage-rollup'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import acrossHandler from '../../../server/api/v1/reports/region/index.get'
import acrossDriversHandler from '../../../server/api/v1/reports/region/drivers.get'
import acrossTrendHandler from '../../../server/api/v1/reports/region/trend.get'
import acrossSeasonalityHandler from '../../../server/api/v1/reports/region/seasonality.get'
import exportHandler from '../../../server/api/v1/reports/export.get'
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
/*
 * mig 0129: a DEDICATED teammate for every 'global-finops' / 'platform-admin'
 * session in this file — NEVER the shared sess() default sentinel
 * ('00000000-0000-0000-0000-000000000009'), which the admin/manager/developer
 * 403 loop below ALSO resolves to. Report-access grants are keyed on
 * teammate_id alone, not on the `role` string handed to injectTestSession — so
 * granting the shared sentinel would ALSO elevate every 403-expecting session
 * built from it (see tests/integration/reports/regional.test.ts for the same
 * fix, already committed).
 */
let acrossElevatedId = ''

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
/*
 * The WHOLE-COMPANY width of the merged `/reports/region*` family (was the
 * separate `/reports/across-regions*` routes). `region=all` is not an optional
 * extra here — it is what selects the unclamped engine scope, so every call that
 * used to reach an across route reaches it through this.
 */
const evAll = (session: Session, query = '') =>
  ev(session, query ? `${query}&region=all` : 'region=all')

const sess = (role: string, orgPath: string, regionId: string, teammateId = '00000000-0000-0000-0000-000000000009'): Session =>
  ({ teammateId, email: 'x@x.test', displayName: 'X', role, regionId, orgPath, issuedAt: new Date().toISOString() } as unknown as Session)

const gfo = () => sess('global-finops', 'a', regionA, acrossElevatedId)

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
  /*
   * The CALLER `sess()` builds every request from, seeded so it exists in
   * `teammate` — `audit_event.actor_teammate_id` is a real FK, and the
   * whole-company teammate-axis export now writes an audit row exactly as the
   * clamped width always has (regional.test.ts seeds the same id for the same
   * reason). Carries NO usage and NO bill, so it is invisible to every figure.
   */
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('00000000-0000-0000-0000-000000000009'::uuid, 'oid-default-caller', 'caller@a.test', 'Caller',
            ${regionA}::uuid, ${unitA}::uuid, true)`
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

  /*
   * The PROJECT axis fixture. Deliberately a TAG on money that is already in the
   * headline rather than extra spend: the axis must partition the SAME company
   * total (58) into tagged + untagged, so a headline that moved would mean the
   * axis had invented money rather than re-cut it.
   */
  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PROJ-X', 'hash-x', 'Project X', 'billable', ${regionA}::uuid, ${unitA}::uuid)`
  await t.client`UPDATE attribution_record
    SET project_id = (SELECT id FROM project WHERE code='PROJ-X')
    WHERE claude_session_id = ${'conv-' + alice + '2026-07-02T00:00:00Z'}`

  /*
   * A live allocation on PROJ-X, so the drivers' "Against budget" column has a
   * real number to answer with. 40.00 against 20.00 of July spend = 50% — chosen
   * so a row reading 100% (a budget accidentally equal to the burn) or 0% would
   * both be visible failures rather than plausible ones.
   */
  await t.client`INSERT INTO audit_event (event_type, actor_system, payload) VALUES ('seed', 'test', '{}'::jsonb)`
  const [{ id: auditId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM audit_event ORDER BY ts_recorded DESC LIMIT 1`
  await t.client`INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
    VALUES ('project', (SELECT id FROM project WHERE code='PROJ-X'), 40.00,
            tstzrange('2020-01-01', NULL, '[)'), 'baseline', ${auditId}::uuid)`

  // Copilot-only dave — the §A unaccounted gap (NULL model). June 01, July 30.
  // model_gap_reason as the S1 writer stamps it for a github-money-backed key
  // (mig 0123): Copilot money is day-grain, so the fill has no model children
  // and the view's arm-2 remainder carries the reason (mig 0124).
  const uu = async (day: string, cost: number) => {
    await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source, model_gap_reason)
      VALUES (${dave}::uuid, ${regionA}::uuid, ${unitAsub}::uuid, ${day}::date, 'copilot-cli', ${cost}, 0, 'api-reconciled', 'provider-day-grain')`
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

  // A SEPARATE, DEDICATED teammate for this file's 'global-finops'/'platform-admin'
  // sessions (mig 0129) — see the `acrossElevatedId` declaration above for why it
  // must NOT be the shared sentinel row. Granted BOTH permissions so every
  // org-wide call below keeps its pre-mig-0129 (unconditional org-wide) reach —
  // this file's own point is the whole-company scope mechanics, not the grants
  // model itself.
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, is_active)
    VALUES ('oid-finops-elevated', 'finops-elevated@a.test', 'Finops Elevated', ${regionA}::uuid, ${unitA}::uuid, 'global-finops', true)`
  ;[{ id: acrossElevatedId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='finops-elevated@a.test'`
  await grantReportAccess(t.client, acrossElevatedId)

  // Copilot pooled chargeback (region A, July) — folds into chargeable ONLY in chargeback mode.
  await t.client`INSERT INTO provider_enterprise (provider, external_id, display_name)
    VALUES ('github', 'ent-x', 'Enterprise X')`
  const [{ id: entId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM provider_enterprise WHERE external_id='ent-x'`
  await t.client`INSERT INTO copilot_pool_bill (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats, license_net_usd, overage_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-07-01'::date, ${entId}::uuid, NULL, ${unitA}::uuid, 5, 100, 20, 80, 90)`

  /*
   * PER-PERSON KPI fixture — a dedicated, otherwise-empty March/April pair in its
   * own region, so the median, the percentiles, the emitting split and both
   * month-over-month operands have a hand-computable answer that no other test's
   * data can move.
   *
   *   March (2026-03-05): p1 $10, p2 $30            → 2 people, median $30
   *   April (2026-04-20): p1 $20, p2 $60,           → 3 people, median $40
   *                       p3 $40 via the API gap (NOT emitting),
   *                       p4 a ZERO-COST attribution record.
   *
   * p4 is the whole point of the fix: they carry a real row in `v_complete_usage`
   * and spent nothing, so "distinct teammates with a row" counts 4 while "people
   * who spent" counts 3 — and the median divides by the latter.
   */
  const regionE = await mkRegion('re', 'Region E')
  const unitE = await mkUnit(regionE, 'e', 'e', true)
  const mkSpender = async (email: string) => {
    const tm = await mkTeammate(regionE, unitE, email)
    return { tm, inst: await mkInstance(tm, regionE, unitE) }
  }
  const p1 = await mkSpender('p1@e.test')
  const p2 = await mkSpender('p2@e.test')
  const p3 = await mkTeammate(regionE, unitE, 'p3@e.test')
  const p4 = await mkSpender('p4@e.test')
  await ar(p1.inst, p1.tm, regionE, unitE, 'claude-sonnet-4-6', 10, '2026-03-05T00:00:00Z')
  await ar(p2.inst, p2.tm, regionE, unitE, 'claude-sonnet-4-6', 30, '2026-03-05T00:00:00Z')
  await ar(p1.inst, p1.tm, regionE, unitE, 'claude-sonnet-4-6', 20, '2026-04-20T00:00:00Z')
  await ar(p2.inst, p2.tm, regionE, unitE, 'claude-sonnet-4-6', 60, '2026-04-20T00:00:00Z')
  // p3 is visible ONLY through provider reconciliation — spends, never emits.
  await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${p3}::uuid, ${regionE}::uuid, ${unitE}::uuid, '2026-04-20'::date, 'copilot-cli', 40, 0, 'api-reconciled')`
  // p4 emits and costs nothing — a row in the lane, not a person who spent.
  await ar(p4.inst, p4.tm, regionE, unitE, 'claude-sonnet-4-6', 0, '2026-04-20T00:00:00Z')

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

  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
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
  meta: { scope: string; month: string; settledThrough?: string; coverage?: { applicable: boolean; denominator: number | null; connected: number; nonConnected: number; stale: boolean } }
  kpis: Kpis
  copilot: { mode: string; pending: boolean; chargeableUsd: number | null }
  chargebackProviderSplit: { anthropicUsd: number; copilotUsd: number | null }
  dailyMetrics: DailyMetric[]
  chargeDaily: ChargeDaily[]
  perPerson: PerPerson
  regionCards: RegionCard[]
  chargebackByRegion: ChargebackRegion[]
}
interface PerPerson {
  medianUsd: number
  top1: number
  top5: number
  top10: number
  emittingPeople: number
  peopleMomDelta: number | null
  medianMomDeltaPct: number | null
}
interface TrendResp { window: { from: string; to: string }; series: unknown[]; chargeSeries: ChargeDaily[] }
interface SeasonalityResp { window: { from: string; to: string }; chargeDow: ChargeDow[] }
interface Segment { key: string; label: string; count: number; totalUsd: number; sharePct: number; avgUsd: number; medianUsd: number }
interface Concentration { activeUsers: number; totalUsd: number; top1: number; top5: number; top10: number; segments: Segment[] }
interface DriversResp { axis: string; headlineUsd: number; rows: { key: string; label: string; usd: number; sharePct: number; spendClass: string; gap_reason?: string | null }[]; concentration: Concentration }

describe('GET /reports/region (region=all) — RBAC (whole-company only)', () => {
  it('global-finops and platform-admin see the whole-company rollup', async () => {
    const gf = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    // ONE scope, and the WIDTH is what says this is the whole-company answer. Both
    // are asserted: `scope` alone stopped distinguishing the two answers at the merge.
    expect(gf.meta.scope).toBe('region')
    expect((gf as unknown as { width: string }).width).toBe('all-regions')
    // No effective region — this width answers for no single one, and says so
    // explicitly rather than leaving the field off for a reader to misread.
    expect((gf as unknown as { region: unknown }).region).toBeNull()
    expect(gf.kpis.genuineUsd).toBe(58) // region A (50) + region B (8)
    // Workstream D — this fixture's GitHub provider_enterprise (seeded for the
    // Copilot chargeback fixtures elsewhere in this file) has never been observed by
    // a coverage sweep/recheck, so the marker must say "no denominator", never a
    // fabricated 0-of-0 completeness claim.
    expect(gf.meta.coverage?.denominator).toBeNull()
    expect(gf.meta.coverage?.connected).toBe(0)
    expect(gf.meta.coverage?.nonConnected).toBe(0)
    const pa = (await acrossHandler(evAll(sess('platform-admin', 'a', regionA, acrossElevatedId), 'month=2026-07'))) as unknown as AcrossResp
    expect(pa.kpis.genuineUsd).toBe(58)
  })

  for (const role of ['admin', 'manager', 'developer'] as const) {
    it(`a ${role} is FORBIDDEN (403) — this scope is whole-company only`, async () => {
      await expect(acrossHandler(evAll(sess(role, 'a', regionA), 'month=2026-07'))).rejects.toMatchObject({ statusCode: 403 })
      await expect(acrossDriversHandler(evAll(sess(role, 'a', regionA), 'month=2026-07'))).rejects.toMatchObject({ statusCode: 403 })
    })
  }
})

describe('GET /reports/region (region=all) — whole-company KPIs + per-region cards', () => {
  it('KPIs roll up every region; MoM + avg/user are correct', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(r.kpis.genuineUsd).toBe(58)
    expect(r.kpis.activeUsers).toBe(3) // alice, dave, bob
    expect(r.kpis.avgPerUserUsd).toBeCloseTo(58 / 3, 6)
    // MoM (LIKE-FOR-LIKE): July MTD genuine 58 vs June's matching day-of-month PACE
    // (all June data dated June-01, so it is captured) 30 (alice 15 + dave 15) → +93.33%.
    expect(r.kpis.momDeltaPct).toBeCloseTo(28 / 30, 6)
  })

  it('per-region cards carry genuine, share, active users, avg/user — and sum back to the headline', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
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
    const pool = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(pool.copilot.mode).toBe('pool-utilisation')
    expect(pool.copilot.pending).toBe(true)
    expect(pool.kpis.anthropicChargeableUsd).toBe(12)
    expect(pool.kpis.chargeableUsd).toBe(12) // Copilot pooled net NOT folded in
    const regionA_pool = pool.regionCards.find((c) => c.displayName === 'Region A')!
    expect(regionA_pool.chargeableUsd).toBe(12)

    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const cb = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
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

/*
 * The KPI row's people axis (prototype fixes 2a / 2c / 6). Every figure below is
 * over the dedicated March/April region-E fixture, where p4 carries a zero-cost
 * `attribution_record` — a real row in `v_complete_usage` belonging to somebody
 * who spent nothing.
 *
 * MUTATION: revert `fetchKpiCore`'s per-teammate CTE to the flat
 * `COUNT(DISTINCT teammate_id)` and the first test goes red (4, not 3); revert
 * `computeConcentration`'s `medianUsd` to 0 and the second goes red; drop the
 * paced previous-window query in `fetchAcrossPerPerson` and the third goes red.
 */
describe('GET /reports/region (region=all) — Active people counts who SPENT, and the median divides by the same cohort', () => {
  it('a zero-cost record is a row in the lane, not a person who spent', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-04'))) as unknown as AcrossResp
    expect(r.kpis.genuineUsd).toBe(120) // p1 20 + p2 60 + p3 40; p4 adds nothing
    expect(r.kpis.activeUsers).toBe(3) // p1, p2, p3 — NOT p4
    /*
     * p4 really IS in the lane — this is what makes the 3 above a decision rather
     * than an absence. Asserted against the view directly, because every reporting
     * figure now filters on positive spend and so none of them can witness the row.
     */
    const [{ n }] = await t.client<{ n: number }[]>`
      SELECT COUNT(DISTINCT teammate_id)::int AS n FROM v_complete_usage
      WHERE ts_event >= '2026-04-01'::timestamptz AND ts_event < '2026-05-01'::timestamptz`
    expect(n).toBe(4)
  })

  it('the daily sparkline series counts the SAME population as the tile above it', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-04'))) as unknown as AcrossResp
    const byDay = new Map(r.dailyMetrics.map((d) => [d.day, d]))
    expect(byDay.get('2026-04-20')).toMatchObject({ genuineUsd: 120, activeUsers: 3 })
  })

  it('publishes the cohort median and its three percentiles, over the WHOLE cohort', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-04'))) as unknown as AcrossResp
    // Costs ASC [20, 40, 60] → index floor(3/2) = 1 → 40. Not a mean (40 here by
    // coincidence of the fixture's symmetry is avoided: mean would be 40 too, so
    // the March check below is the one that separates them).
    expect(r.perPerson.medianUsd).toBe(40)
    // k = max(1, round(3 × p)) = 1 for every p at n = 3 → the top spender's share.
    expect(r.perPerson.top1).toBeCloseTo(60 / 120, 6)
    expect(r.perPerson.top5).toBeCloseTo(60 / 120, 6)
    expect(r.perPerson.top10).toBeCloseTo(60 / 120, 6)
  })

  it('a median is not a mean — March [10, 30] reads 30, where the mean is 20', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-03'))) as unknown as AcrossResp
    expect(r.kpis.genuineUsd).toBe(40)
    expect(r.kpis.activeUsers).toBe(2)
    expect(r.perPerson.medianUsd).toBe(30)
  })

  it('splits the people who SPEND from the people EMITTING through TokenScope', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-04'))) as unknown as AcrossResp
    // p1 + p2 emit; p3 is visible only through provider reconciliation.
    expect(r.perPerson.emittingPeople).toBe(2)
    expect(r.kpis.activeUsers).toBe(3)
  })

  it('the count delta is ABSOLUTE and the median delta is a ratio, both PACED to the previous month', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-04'))) as unknown as AcrossResp
    // April 3 people vs the paced March window's 2 → +1, a count and not a percentage.
    expect(r.perPerson.peopleMomDelta).toBe(1)
    // April median 40 vs March median 30 → +33.3%.
    expect(r.perPerson.medianMomDeltaPct).toBeCloseTo((40 - 30) / 30, 6)
  })

  it('withholds BOTH deltas in range mode — an arbitrary span has no previous month', async () => {
    const r = (await acrossHandler(
      evAll(gfo(), 'from=2026-03-01&to=2026-04-30'),
    )) as unknown as AcrossResp
    expect(r.perPerson.peopleMomDelta).toBeNull()
    expect(r.perPerson.medianMomDeltaPct).toBeNull()
    // The cohort itself still computes over the full range: p1 30, p2 90, p3 40
    // → ASC [30, 40, 90], median 40.
    expect(r.kpis.activeUsers).toBe(3)
    expect(r.perPerson.medianUsd).toBe(40)
  })
})

describe('GET /reports/region/drivers (region=all) — sum-back = headline (every axis)', () => {
  // 'region' is NOT an axis any more — it has its own card (prototype fix 4a).
  const axes = ['practice', 'teammate', 'model', 'project'] as const
  for (const axis of axes) {
    it(`axis=${axis}: Σ rows = headline = company genuine, shares sum to 1`, async () => {
      const d = (await acrossDriversHandler(evAll(gfo(), `month=2026-07&axis=${axis}`))) as unknown as DriversResp
      const sum = d.rows.reduce((a, r) => a + r.usd, 0)
      expect(sum).toBeCloseTo(d.headlineUsd, 6)
      expect(d.headlineUsd).toBe(58)
      expect(d.rows.reduce((a, r) => a + r.sharePct, 0)).toBeCloseTo(1, 6)
    })
  }

  it('the model axis REASON-TYPES the Copilot-gap remainder — no untyped bucket left', async () => {
    /*
     * Mig 0124: a NULL-model row is a REMAINDER carrying model_gap_reason.
     * dave's Copilot fill is github day-grain money, so its reason is
     * 'provider-day-grain' — the key/label come from the shared helper and the
     * $30 stays whole (no ratio ever splits day-grain money).
     */
    const d = (await acrossDriversHandler(evAll(gfo(), 'month=2026-07&axis=model'))) as unknown as DriversResp
    const gap = d.rows.find((r) => r.gap_reason === 'provider-day-grain')
    expect(gap).toBeDefined()
    expect(gap!.usd).toBe(30) // dave's Copilot gap (region A) + none in B
    expect(gap!.key).toBe(`${UNATTRIBUTED_MODEL_KEY}:provider-day-grain`)
    expect(gap!.label).toBe(MODEL_GAP_REASON_LABELS['provider-day-grain'])
    // The un-typed residual bucket is gone — every NULL-model row carries a reason.
    expect(d.rows.some((r) => r.key === UNATTRIBUTED_MODEL_KEY)).toBe(false)
    expect(d.rows.some((r) => r.label === UNATTRIBUTED_MODEL_LABEL)).toBe(false)
  })

  it('the project axis re-cuts the SAME total into the tagged project + an UNTAGGED bucket', async () => {
    const d = (await acrossDriversHandler(evAll(gfo(), 'month=2026-07&axis=project'))) as unknown as DriversResp
    expect(d.rows.find((r) => r.label === 'Project X')!.usd).toBe(20) // alice's July claude
    // "Untagged" = no project claim. NOT "Unattributed" — that names a missing
    // identity or model, a different gap with a different remedy (§6.6, one word
    // one meaning). bob 8 + dave's reconciled Copilot 30.
    expect(d.rows.find((r) => r.label === 'Untagged')!.usd).toBe(38)
    expect(d.rows.some((r) => r.label === UNATTRIBUTED_MODEL_LABEL)).toBe(false)
  })

  /*
   * prototype.html `note('fix 4a', …)`: the Regions table and the region PIVOT
   * disagreed — different values AND a different rank order — and a reader could
   * not tell which was wrong. The pivot is the copy that went.
   *
   * A saved `?axis=region` URL falls back to the default rather than 400-ing, so
   * what is asserted is that the response is NOT a region cut: the rows are
   * projects. Asserting "no region axis" on the enum alone would pass on a
   * handler that still answered one.
   */
  it('a saved ?axis=region URL falls back to project — the region pivot is retired', async () => {
    const d = (await acrossDriversHandler(evAll(gfo(), 'month=2026-07&axis=region'))) as unknown as DriversResp & { axis: string }
    expect(d.axis).toBe('project')
    const labels = d.rows.map((r) => r.label)
    expect(labels).not.toContain('Region A')
    expect(labels).not.toContain('Region B')
    expect(labels).toContain('Project X')
  })

  /*
   * prototype.html `note('fix 4', …)`: "Dev puts Untagged $35,208.99 — 82% as row
   * one, which buries every real project under an absence."
   *
   * Untagged is 38 of the 58 here, so amount-ranking puts it first — which is
   * exactly the state before this change. Order, not membership: dropping the row
   * would break the sum-back the axis is built on and delete the accountability
   * signal `shared/reports/vocabulary.ts` calls "the row the product exists to
   * surface".
   */
  it('the untagged bucket is the LAST row, never row one, and is still in the sum', async () => {
    const d = (await acrossDriversHandler(evAll(gfo(), 'month=2026-07&axis=project'))) as unknown as DriversResp
    expect(d.rows.at(-1)!.label).toBe('Untagged')
    expect(d.rows[0]!.label).toBe('Project X')
    // Biggest by amount, and still last — the discriminator is the KIND of row.
    expect(d.rows.at(-1)!.usd).toBeGreaterThan(d.rows[0]!.usd)
    expect(d.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(d.headlineUsd, 6)
  })

  /*
   * AGAINST BUDGET (prototype lines 821-829): "% of the company total tells a
   * project owner nothing they can act on… Tracking against their own budget is
   * the question they actually have."
   *
   * THREE states, and only real project rows carry the field at all: a number
   * (the allocation), `null` (no budget set — a decision nobody has made), and
   * ABSENT (the untagged bucket, which has nothing a budget could be set on).
   */
  it('a project row carries its OWN live allocation as budgetUsd', async () => {
    const d = (await acrossDriversHandler(evAll(gfo(), 'month=2026-07&axis=project'))) as unknown as DriversResp
    const projectX = d.rows.find((r) => r.label === 'Project X')!
    expect(projectX.budgetUsd).toBe(40)
    expect(projectX.usd).toBe(20) // → 50% of $40 on screen
  })

  it('the untagged bucket carries NO budget field — "no budget set" would be a false claim', async () => {
    const d = (await acrossDriversHandler(evAll(gfo(), 'month=2026-07&axis=project'))) as unknown as DriversResp
    const untagged = d.rows.find((r) => r.label === 'Untagged')!
    expect(untagged.budgetUsd).toBeUndefined()
  })

  it('a pure-Copilot teammate row is `pooled-usage`; a Claude teammate is `indicative`', async () => {
    const d = (await acrossDriversHandler(evAll(gfo(), 'month=2026-07&axis=teammate'))) as unknown as DriversResp
    expect(d.rows.find((r) => r.label === 'dave@a.test')!.spendClass).toBe('pooled-usage')
    expect(d.rows.find((r) => r.label === 'alice@a.test')!.spendClass).toBe('indicative')
  })
})

describe('GET /reports/region/drivers (region=all) — concentration math (known answer)', () => {
  // 30 teammates, costs 300,290,…,10 (total 4650). Concentration cohorts use
  // k = max(1, round(N×p)); AEUF segment cut-points: power=top5% (2), heavy=next15% (5),
  // typical=middle55% (15), light=bottom25% (8). Every number below is hand-computed.
  it('top-1/5/10% cohort shares use k = max(1, round(N×p))', async () => {
    const d = (await acrossDriversHandler(evAll(gfo(), 'month=2026-05&axis=teammate'))) as unknown as DriversResp
    const c = d.concentration
    expect(c.activeUsers).toBe(30)
    expect(c.totalUsd).toBe(4650)
    expect(c.top1).toBeCloseTo(300 / 4650, 6) // k=1 → top user (300)
    expect(c.top5).toBeCloseTo(590 / 4650, 6) // k=2 → 300+290
    expect(c.top10).toBeCloseTo(870 / 4650, 6) // k=3 → 300+290+280
  })

  it('power/heavy/typical/light segments carry count, share, avg + median', async () => {
    const d = (await acrossDriversHandler(evAll(gfo(), 'month=2026-05&axis=teammate'))) as unknown as DriversResp
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

describe('GET /reports/region/drivers (region=all) — range mode windows the FULL range (not one month)', () => {
  // A multi-month custom window (June + July). The drivers previously anchored to a single
  // month in range mode; they must now window the WHOLE range (the review invariant), and
  // the CSV export must window the SAME range so screen == CSV.
  const RANGE = 'from=2026-06-01&to=2026-07-31'

  it('teammate drivers sum over June + July (88), NOT a single month', async () => {
    const d = (await acrossDriversHandler(evAll(gfo(), `${RANGE}&axis=teammate`))) as unknown as DriversResp
    // June (alice 15 + dave 15) + July (alice 20 + bob 8 + dave 30) = 88 — the whole range.
    expect(d.headlineUsd).toBe(88)
    const byName = new Map(d.rows.map((r) => [r.label, r.usd]))
    expect(byName.get('alice@a.test')).toBe(35) // 15 June + 20 July
    expect(byName.get('bob@b.test')).toBe(8)
    expect(byName.get('dave@a.test')).toBe(45) // 15 June + 30 July (Copilot gap)
    expect(d.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(88, 6)
  })

  it('the drivers CSV export windows the SAME range — byte-identical to the screen figures', async () => {
    const json = (await acrossDriversHandler(evAll(gfo(), `${RANGE}&axis=teammate`))) as unknown as DriversResp
    const csv = (await exportHandler(ev(gfo(), `scope=region&region=all&report=drivers&axis=teammate&${RANGE}`))) as unknown as string
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
    // dave's FULL-range Copilot gap present at 45.00 — not 30.00 (July only).
    expect(csv).toContain('dave@a.test,45.00,')
  })
})

describe('GET /reports/region (region=all) — §A dailyMetrics + §B chargeback MoM', () => {
  it('dailyMetrics is the §A per-day series (genuine / tokens / active users), summing to the headline', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
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

  /*
   * `meta.settledThrough` — the operand the day series were CUT on, shipped with
   * them (external review r2). Without it the hero's sparks cannot tell whether
   * their last point is a finished day or the still-filling one, and the frame
   * cannot answer it: `fetchDailyMetrics` stops at the settled edge unless today
   * carries rows, so "the month has days left" says nothing about the last point.
   * The alternative — the client asking `/api/v1/clock` — is a second request
   * with its own instant, which is the defect `clock-and-day-boundary.md` names.
   *
   * RED ON REVERT: drop the field from the meta and this goes red.
   */
  it('ships the settled edge the series were cut on, as a real UTC day', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(r.meta.settledThrough).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // It is `today − 1` by construction, so it is strictly before today.
    expect(r.meta.settledThrough! < new Date().toISOString().slice(0, 10)).toBe(true)
  })

  it('chargeMomDeltaPct compares two CLOSED calendar months; the in-progress month is null (§B, never usage)', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    // June (a CLOSED month) chargeable 8 vs May (closed) 4 → +100%. §B bill lane, never usage.
    const june = (await acrossHandler(evAll(gfo(), 'month=2026-06'))) as unknown as AcrossResp
    expect(june.kpis.chargeMomDeltaPct).toBeCloseTo(1.0, 6)
    // The current (in-progress) month accrues intra-month, so an MTD-vs-full-prior MoM is
    // misleading → null (finding #3). Detected dynamically so it is not month-boundary flaky.
    const currentMonth = new Date().toISOString().slice(0, 7)
    const cur = (await acrossHandler(evAll(gfo(), `month=${currentMonth}`))) as unknown as AcrossResp
    expect(cur.kpis.chargeMomDeltaPct).toBeNull()
  })

  it('chargeMomDeltaPct is null in custom-range mode (no month anchor)', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'from=2026-07-01&to=2026-07-31'))) as unknown as AcrossResp
    expect(r.kpis.chargeMomDeltaPct).toBeNull()
  })

  it('chargebackByRegion ranks off the bill lane — a region with charge but NO in-window usage appears + sums to the chargeable', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    // August: only Region D has a §B bill (25) and NOBODY has August usage. The usage region
    // cards would DROP Region D; chargebackByRegion (v_finance_chargeback_month) keeps it.
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-08'))) as unknown as AcrossResp
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

describe('GET /reports/region (region=all) — §B chargeback bill-lane cards (Anthropic per-teammate)', () => {
  it('KPI billed figures come from the ANTHROPIC per-teammate bill lane (not usage)', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
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
    const pool = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(pool.chargebackProviderSplit.anthropicUsd).toBe(12)
    expect(pool.chargebackProviderSplit.copilotUsd).toBeNull() // pooled Copilot held back (pending)
    // The split sums to the chargeable headline (Anthropic-only while pending).
    expect(pool.chargebackProviderSplit.anthropicUsd).toBe(pool.kpis.chargeableUsd)

    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const cb = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
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
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
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
    const r = (await acrossTrendHandler(evAll(gfo(), 'month=2026-07'))) as unknown as TrendResp
    const byDay = new Map(r.chargeSeries.map((d) => [d.day, d.chargeUsd]))
    expect(byDay.get('2026-07-01')).toBe(12)
    expect(r.chargeSeries.reduce((a, d) => a + d.chargeUsd, 0)).toBe(12)
  })

  it('the seasonality endpoint carries the §B day-of-week chargeback (7 buckets, Mon..Sun)', async () => {
    const r = (await acrossSeasonalityHandler(evAll(gfo(), 'month=2026-07'))) as unknown as SeasonalityResp
    // Always seven buckets, dow 0..6, summing to the window's Anthropic chargeback (12).
    expect(r.chargeDow.length).toBe(7)
    expect(r.chargeDow.map((b) => b.dow)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(r.chargeDow.reduce((a, b) => a + b.chargeUsd, 0)).toBe(12)
    // The whole 12 lands on 2026-07-01's day-of-week bucket.
    const dow = isoDow0('2026-07-01')
    expect(r.chargeDow.find((b) => b.dow === dow)!.chargeUsd).toBe(12)
  })
})

describe('GET /reports/region (region=all) — month-boundary invariance', () => {
  it('Σ per-month (May + June + July) = the unbounded whole-company total', async () => {
    const may = (await acrossHandler(evAll(gfo(), 'month=2026-05'))) as unknown as AcrossResp
    const june = (await acrossHandler(evAll(gfo(), 'month=2026-06'))) as unknown as AcrossResp
    const july = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
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

describe('GET /reports/export?scope=region&region=all — byte-identical + RBAC', () => {
  it('the drivers CSV rows carry the SAME spend + share as the JSON endpoint', async () => {
    const json = (await acrossDriversHandler(evAll(gfo(), 'month=2026-07&axis=teammate'))) as unknown as DriversResp
    const csv = (await exportHandler(ev(gfo(), 'scope=region&region=all&report=drivers&axis=teammate&month=2026-07'))) as unknown as string
    expect(typeof csv).toBe('string')
    const lines = csv.trim().split('\n')
    expect(lines[0]).toMatch(/^# tokenscope across-regions drivers/)
    expect(lines[1]).toBe('driver,spend_usd,share_pct,spend_class,otel_emitted_usd,api_reconciled_usd,provider_usage_usd,surface_mix')
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
    const csv = (await exportHandler(ev(gfo(), 'scope=region&region=all&report=concentration&month=2026-05'))) as unknown as string
    expect(csv).toMatch(/^# tokenscope across-regions concentration/)
    expect(csv).toContain('cohort,share_pct')
    expect(csv).toContain(`Top 1%,${((300 / 4650) * 100).toFixed(1)}`)
    expect(csv).toContain('segment,users,spend_usd,share_pct,avg_usd,median_usd')
    expect(csv).toContain('Power users,2,590.00,12.7,295.00,300.00')
    expect(csv).toContain('Light users,8,360.00,7.7,45.00,50.00')
  })

  it('the region-comparison CSV lists every region (§A usage; no month-grained chargeable column)', async () => {
    const csv = (await exportHandler(ev(gfo(), 'scope=region&region=all&report=regions&month=2026-07'))) as unknown as string
    // The region-card `chargeableUsd` is month-grained AND UI-dead (the screen ranks §A off
    // genuineUsd, §B off the DAILY-grained chargebackByRegion), so it is not a CSV column —
    // a month-grained figure would read $0 in a sub-month range while the screen KPI is not.
    expect(csv).toContain('region,genuine_usd,active_users,avg_per_user_usd,share_pct')
    expect(csv).not.toContain('chargeable_usd')
    expect(csv).toContain('Region A,50.00,2,25.00,86.2')
    expect(csv).toContain('Region B,8.00,1,8.00,13.8')
  })

  it('a non-owner (admin) is FORBIDDEN from the whole-company export (403)', async () => {
    await expect(
      exportHandler(ev(sess('admin', 'a', regionA), 'scope=region&region=all&report=drivers&month=2026-07')),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

/*
 * The retired export scopes, honoured for ONE RELEASE (04-prototype-delta.md §6).
 *
 * An export URL is the one reporting URL that leaves the app: pasted into a runbook,
 * scheduled by a script, saved in a spreadsheet's refresh settings. None of those get
 * rewritten when a tab is renamed, and none of them would report a 400 to anybody —
 * a scheduled pull would simply stop producing a file.
 *
 * The bar is BYTE-IDENTICAL, not merely "does not 400". A legacy value that mapped to
 * the wrong WIDTH would keep returning a CSV — one region's rows under a header that
 * still says whole-company — and nothing downstream would notice.
 */
describe('GET /reports/export — the retired scope values still resolve, byte-identically', () => {
  it('scope=across-regions ⇒ scope=region&region=all (the whole-company width)', async () => {
    const legacy = (await exportHandler(
      ev(gfo(), 'scope=across-regions&report=drivers&axis=teammate&month=2026-07'),
    )) as unknown as string
    const current = (await exportHandler(
      ev(gfo(), 'scope=region&region=all&report=drivers&axis=teammate&month=2026-07'),
    )) as unknown as string
    expect(legacy).toBe(current)
    // Proves it is genuinely the WHOLE-COMPANY answer, not a region that happens to
    // serialise: dave is in region A, and region B's spend is in the same file.
    expect(legacy).toContain('dave@a.test')
  })

  it('scope=regional ⇒ scope=region, keeping the region it carried', async () => {
    // `axis=model`, not teammate: the teammate axis writes an export-provenance
    // audit row whose actor FK this file's synthetic session does not satisfy. The
    // mapping under test is the scope→width one, which every axis exercises equally.
    const legacy = (await exportHandler(
      ev(gfo(), `scope=regional&report=drivers&axis=model&region=${regionB}&month=2026-07`),
    )) as unknown as string
    const current = (await exportHandler(
      ev(gfo(), `scope=region&report=drivers&axis=model&region=${regionB}&month=2026-07`),
    )) as unknown as string
    expect(legacy).toBe(current)
    // …and it landed on the CLAMPED width, not the whole company. Without this the
    // test would pass with `regional` wrongly mapped to `region=all`, since both
    // spellings would then be wrong in the same way and still match each other.
    const wholeCompany = (await exportHandler(
      ev(gfo(), 'scope=region&region=all&report=drivers&axis=model&month=2026-07'),
    )) as unknown as string
    expect(legacy).not.toBe(wholeCompany)
  })

  it('a stray region beside scope=across-regions does NOT narrow it', async () => {
    // `across-regions` never had a region param, so a `region=` riding along is a
    // stale key. Honouring it would clamp an export whose header says whole-company.
    const strayed = (await exportHandler(
      ev(gfo(), `scope=across-regions&report=drivers&axis=teammate&region=${regionB}&month=2026-07`),
    )) as unknown as string
    const wholeCompany = (await exportHandler(
      ev(gfo(), 'scope=region&region=all&report=drivers&axis=teammate&month=2026-07'),
    )) as unknown as string
    expect(strayed).toBe(wholeCompany)
  })

  it('the retired values carry the SAME gate, not a way around it', async () => {
    // The compatibility window is for URLs, never for authorisation. An admin holds
    // no `across`, so the legacy spelling of the whole-company export 403s exactly as
    // the current one does.
    await expect(
      exportHandler(ev(sess('admin', 'a', regionA), 'scope=across-regions&report=drivers&month=2026-07')),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
