// @vitest-environment node
/*
 * Consumption read-model over a REAL materialised aggregate (night sprint
 * N3): series/window pivots re-add to the ledger, velocity math, the
 * membership gate (non-member → null → endpoint 404), member contribution,
 * activity mix, untagged pressure, and the insight-ack contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { runAggregateRollup } from '../../../server/workers/aggregate-rollup'
import {
  fetchDailySeries,
  fetchMtdSpend,
  fetchProjectAllocation,
  fetchProjectVelocity,
  fetchWindowTotals,
  requireProjectMembership,
} from '../../../server/usage/consumption'
import { exhaustionDate } from '../../../server/usage/projections'
import {
  fetchMemberContribution,
  fetchProjectActivityMix,
  fetchUntaggedPressure,
} from '../../../server/usage/project-detail'
import { fetchCatalog, fetchRateLines } from '../../../server/usage/insights'

let t: TestDb
let devId: string
let mateId: string
let outsiderId: string
let regionId: string
let orgUnitId: string
let projectId: string
const INSTANCE = randomUUID()

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.db.insert(schema.region).values({ code: 'apac-cn', displayName: 'APAC' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'apac.cons', code: 'cons', displayName: 'Cons', unitType: 'bu' })
    .returning()
  orgUnitId = bu!.id
  const mk = async (oid: string, email: string) => {
    const [tm] = await t.db.insert(schema.teammate).values({ entraOid: oid, email, regionId, orgUnitId }).returning()
    return tm!.id
  }
  devId = await mk('oid-cn-dev', 'cn.dev@example.com')
  mateId = await mk('oid-cn-mate', 'cn.mate@example.com')
  outsiderId = await mk('oid-cn-out', 'cn.out@example.com')

  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: 'CN-P1',
      codeHash: 'h-cn-p1',
      displayName: 'Consumption P1',
      type: 'billable',
      regionId,
      costOwningUnitId: orgUnitId,
      wbsCode: '1.2.3', // finance correlation field (mig 0047)
    })
    .returning()
  projectId = proj!.id
  for (const tm of [devId, mateId]) {
    await t.db.insert(schema.projectAssignment).values({
      projectId,
      teammateId: tm,
      effective: sql`'[2026-01-01, 2099-01-01)'::tstzrange`,
    })
  }
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: INSTANCE,
    principalOid: 'oid-cn-dev',
    teammateId: devId,
    projectCodeHash: 'h-cn-p1',
    rawProjectCode: 'CN-P1',
    tool: 'claude-code',
    sessionTokenHash: 'tok-cn-' + INSTANCE,
    tsStart: new Date(),
    regionId,
    orgUnitId,
    costOwningUnitId: orgUnitId,
  })
  // Allocation: $300 baseline, current (audit row required by NOT NULL FK).
  const [evt] = await t.db
    .insert(schema.auditEvent)
    .values({
      eventType: 'allocation-created',
      subjectKind: 'project',
      subjectId: projectId,
      payload: { initial: true },
    })
    .returning({ id: schema.auditEvent.id })
  await t.db.insert(schema.allocation).values({
    scopeType: 'project',
    scopeId: projectId,
    budgetUsd: '300.00',
    effective: sql`'[2026-01-01, 2099-01-01)'::tstzrange`,
    allocationKind: 'baseline',
    auditEventId: evt!.id,
  })

  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)
  // Ledger: project spend from two members + dev's untagged conversation + an
  // activity-tagged slice. Seed timestamps are anchored to NOON UTC TODAY (not a
  // `now - Nh` relative offset) so every row always lands in the current month +
  // the read-models' rolling window on ANY calendar date — a `now - 27h` offset
  // fell into the PREVIOUS month near a month boundary and dropped the rows out of
  // the MTD / rolling windows, failing activity-mix / untagged-pressure / member-
  // contribution. No assertion needs a 2-day spread, so both seeds sit on today.
  const d = new Date()
  const anchorMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)
  const insert = (over: Record<string, unknown>) =>
    t.db.insert(schema.attributionRecord).values({
      instanceId: INSTANCE,
      claudeSessionId: 'conv-cn-' + String(over.run),
      teammateId: devId,
      projectId,
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      tool: 'claude-code',
      model: 'claude-fable-5',
      tokenType: 'input',
      tokens: 1_000n,
      costUsd: '1.000000',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(anchorMs - 3_600_000),
      sourceRunId: String(over.run),
      querySource: 'main',
      ...over,
    } as never)

  await insert({ run: 'a1', tokens: 100_000n, costUsd: '0.300000', activity: 'feature-dev' })
  await insert({ run: 'a2', tokenType: 'output', tokens: 10_000n, costUsd: '0.150000', activity: 'feature-dev' })
  await insert({ run: 'a3', tokens: 50_000n, costUsd: '0.150000', tsEvent: new Date(anchorMs), activity: 'research' })
  await insert({ run: 'a4', teammateId: mateId, tokens: 200_000n, costUsd: '0.600000' })
  // dev's untagged conversation (no project) — untagged pressure.
  await insert({ run: 'a5', projectId: null, costOwningUnitId: null, tokens: 30_000n, costUsd: '0.090000' })
  // aux lane + tier-2 row for window pivots.
  await insert({ run: 'a6', querySource: 'generate_session_title', model: 'claude-haiku-4-5', tokens: 5_000n, costUsd: '0.005000', fidelityTier: 'tier-2', costBasis: 'telemetry-only' })

  await runAggregateRollup(t.db)
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('consumption read-model (aggregate-backed)', () => {
  it('daily series re-adds to the teammate ledger total', async () => {
    const series = await fetchDailySeries(t.db, 'teammate', devId, 30)
    expect(series.length).toBeGreaterThanOrEqual(1)
    const seriesTotal = series.reduce((a, d) => a + Number(d.cost_usd), 0)
    const [ledger] = await t.client<{ cost: string }[]>`
      SELECT SUM(cost_usd)::text AS cost FROM attribution_record WHERE teammate_id = ${devId}::uuid
    `
    // Day values are 2dp money strings → up to half a cent of rounding per day.
    // The `+ 1e-9` absorbs IEEE-754 representation error: with a single seed day
    // the fixture's ledger (0.695) rounds to a day string exactly half a cent off,
    // and |0.69 − 0.695| evaluates to 0.005000…044 — a hair over a strict 0.005.
    expect(Math.abs(seriesTotal - Number(ledger!.cost))).toBeLessThanOrEqual(0.005 * series.length + 1e-9)
  })

  it('window totals: pivots, cache lanes, aux split, advisory share', async () => {
    const totals = await fetchWindowTotals(t.db, 'teammate', devId, 30)
    expect(totals.by_model.length).toBeGreaterThanOrEqual(2)
    expect(totals.by_model[0]!.model).toBe('claude-fable-5') // cost-share desc
    expect(totals.aux.aux_tokens).toBe(5_000)
    expect(totals.aux.main_tokens).toBeGreaterThan(0)
    expect(totals.advisory_cost_usd).toBeCloseTo(0.005, 6)
    const pivotTotal = totals.by_token_type.reduce((a, x) => a + x.tokens, 0)
    expect(pivotTotal).toBe(totals.tokens)
  })

  it('project MTD spend + allocation + exhaustion wire together', async () => {
    const mtd = await fetchMtdSpend(t.db, 'project', projectId)
    const [ledger] = await t.client<{ cost: string }[]>`
      SELECT SUM(cost_usd)::text AS cost FROM attribution_record
      WHERE project_id = ${projectId}::uuid
        AND ts_event >= date_trunc('month', now() AT TIME ZONE 'UTC')
    `
    expect(mtd).toBeCloseTo(Number(ledger!.cost), 6)
    const allocation = await fetchProjectAllocation(t.db, projectId)
    expect(allocation).toBe(300)
    // exhaustionDate is a pure projection over a caller-supplied clock; pin it to
    // an early-in-the-month `asOf` so the within-month assertion is deterministic.
    // (A real `new Date()` made this date-sensitive: spend of 150/300 projects to
    // exhaust at ~2× days-elapsed into the month, which falls past month-end — and
    // correctly returns null — once the real clock passes mid-month, so the test
    // failed every day after the 15th.)
    const asOf = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 5))
    // ~$1.35 MTD against $300 burns out far past month-end → null (the cap that
    // stops meaningless next-quarter projections); a realistic burn projects.
    expect(exhaustionDate(mtd, allocation, asOf)).toBeNull()
    expect(exhaustionDate(150, allocation, asOf)).not.toBeNull()
  })

  it('velocity: current week vs trailing mean (no flag without history)', async () => {
    // ISOLATED fixture: a fresh project+teammate whose ONLY spend is at the current
    // instant — so "no prior-week history → delta null" is deterministic on every
    // weekday. (The shared fixture spreads spend across ~2 days; its earliest row
    // falls into the PRIOR ISO week every Monday — date_trunc('week') is Monday-based
    // — which legitimately flips delta_pct non-null. Same date-sensitivity class as
    // the exhaustionDate `asOf` pin above; isolating avoids perturbing the daily/MTD
    // fixtures that need the 2-day spread.)
    const [vrc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)
    const [vTm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-cn-vel', email: 'cn.vel@example.com', regionId, orgUnitId })
      .returning()
    const [vProj] = await t.db
      .insert(schema.project)
      .values({ code: 'CN-VEL', codeHash: 'h-cn-vel', displayName: 'Velocity P', type: 'billable', regionId, costOwningUnitId: orgUnitId, wbsCode: '9.9.9' })
      .returning()
    await t.db.insert(schema.attributionRecord).values({
      instanceId: INSTANCE,
      claudeSessionId: 'conv-cn-vel',
      teammateId: vTm!.id,
      projectId: vProj!.id,
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      tool: 'claude-code',
      model: 'claude-fable-5',
      tokenType: 'input',
      tokens: 100_000n,
      costUsd: '0.300000',
      rateCardId: vrc!.id,
      rateCardVersion: vrc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(), // current instant → current ISO week, no prior weeks
      sourceRunId: 'vel1',
      querySource: 'main',
    } as never)
    await runAggregateRollup(t.db)

    // Callers thread the resolved spike-threshold dial in (mig 0049 platform default).
    const v = await fetchProjectVelocity(t.db, vProj!.id, 0.25)
    expect(Number(v.current_week_usd)).toBeGreaterThan(0)
    // Only current-week spend, zero prior weeks → no baseline → delta null, unflagged.
    expect(v.delta_pct).toBeNull()
    expect(v.is_flagged).toBe(false)
  })

  it('membership gate: member resolves, outsider gets null (the 404 backing)', async () => {
    const member = await requireProjectMembership(t.db, devId, 'CN-P1')
    expect(member?.id).toBe(projectId)
    expect(member?.wbs_code).toBe('1.2.3') // WBS surfaces to the project dashboard
    expect(member?.ended).toBe(false)
    expect(await requireProjectMembership(t.db, outsiderId, 'CN-P1')).toBeNull()
    expect(await requireProjectMembership(t.db, devId, 'NO-SUCH')).toBeNull()
  })

  it('member contribution: per-member MTD with cost-per-active-day, cost desc', async () => {
    const members = await fetchMemberContribution(t.db, projectId)
    expect(members.length).toBe(2)
    // dev's project rows: a1 .30 + a2 .15 + a3 .15 + a6 .005 = .605 > mate .60
    // (sorted on the RAW sums; cost_usd strings are 2dp money)
    expect(members[0]!.email).toBe('cn.dev@example.com')
    expect(Number(members[0]!.cost_usd)).toBeCloseTo(0.6, 2)
    expect(Number(members[1]!.cost_usd)).toBeCloseTo(0.6, 2)
    expect(members[0]!.tokens).toBe(165_000) // 100k+10k+50k+5k
    expect(members[0]!.active_days).toBeGreaterThanOrEqual(1)
    expect(Number(members[0]!.cost_per_active_day)).toBeGreaterThan(0)
  })

  it('activity mix: tagged slices + NULL lane, cost desc', async () => {
    const mix = await fetchProjectActivityMix(t.db, projectId)
    const labels = mix.map((m) => m.activity)
    expect(labels).toContain('feature-dev')
    expect(labels).toContain('research')
    expect(labels).toContain(null) // untagged-within-project (mate's row)
  })

  it('untagged pressure: members’ unallocated MTD spend, counts only', async () => {
    const up = await fetchUntaggedPressure(t.db, projectId)
    expect(up.conversations).toBe(1)
    expect(Number(up.cost_usd)).toBeCloseTo(0.09, 6)
  })

  it('insight fetch helpers: catalog seeded, rate lines active', async () => {
    const catalog = await fetchCatalog(t.db)
    expect(catalog.find((c) => c.model_pattern === 'fable')?.tier).toBe('frontier')
    const lines = await fetchRateLines(t.db)
    expect(lines.some((l) => l.unit === 'cache-read')).toBe(true)
  })

  it('insight_ack contract: idempotent upsert, month-scoped uniqueness', async () => {
    const ins = () => t.client`
      INSERT INTO insight_ack (teammate_id, finding_id, month)
      VALUES (${devId}::uuid, 'cache-hit-starvation', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'))
      ON CONFLICT (teammate_id, finding_id, month) DO NOTHING
    `
    await ins()
    await ins()
    const rows = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM insight_ack WHERE teammate_id = ${devId}::uuid
    `
    expect(Number(rows[0]!.n)).toBe(1)
  })
})
