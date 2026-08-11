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
  fetchAdvisorySpend,
  fetchDailySeries,
  fetchProjectAllocation,
  fetchProjectVelocity,
  fetchWindowTotals,
  requireProjectMembership,
} from '../../../server/usage/consumption'
import { exhaustionDate } from '../../../server/usage/projections'
import { fetchUntaggedPressure } from '../../../server/usage/project-detail'
import {
  completeOneProjectSpend,
  completeProjectSpendByActivity,
  completeProjectSpendByMember,
} from '../../../server/usage/complete-spend'
import { monthToDateWindow } from '../../../server/utils/period'
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
  const monthStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  // Anchored a couple of MINUTES IN THE PAST, clamped up to month-start.
  // Month-to-date is half-open `[month start, now)`, so noon-today (the previous
  // anchor) is FUTURE-DATED on any run before 12:00 UTC and drops straight out of
  // every month figure; and a plain `now - Nh` falls into the PREVIOUS month near
  // a boundary, which is the failure the noon anchor was introduced to fix. The
  // clamp satisfies both at once. No assertion needs a multi-day spread.
  const anchorMs = Math.max(monthStartMs, Date.now() - 60_000)
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
      tsEvent: new Date(Math.max(monthStartMs, anchorMs - 60_000)),
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

/*
 * The one MTD window every project figure uses: half-open `[month start, NOW)`.
 * Evaluated PER CALL, never hoisted into a constant — the window's upper bound
 * is the current instant, and a module-load snapshot would exclude every row
 * this suite writes after it (testcontainers startup alone is minutes).
 */
const mtd = () => monthToDateWindow()

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
    const window = mtd()
    const mtdUsd = (await completeOneProjectSpend(t.db, projectId, window)).costUsd
    const [ledger] = await t.client<{ cost: string }[]>`
      SELECT SUM(cost_usd)::text AS cost FROM attribution_record
      WHERE project_id = ${projectId}::uuid
        AND ts_event >= ${window.startIso}::timestamptz
        AND ts_event <  ${window.endIso}::timestamptz
    `
    expect(mtdUsd).toBeCloseTo(Number(ledger!.cost), 6)
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
    expect(exhaustionDate(mtdUsd, allocation, asOf)).toBeNull()
    expect(exhaustionDate(150, allocation, asOf)).not.toBeNull()
  })

  /*
   * THE GUARD THAT USED TO BE VACUOUS.
   *
   * This assertion was `fetchMtdSpend(aggregate) == Σ ledger`, taken with
   * `runAggregateRollup` called immediately before and nothing written after —
   * the ONE condition under which it is guaranteed true. It certified nothing,
   * and the divergence it was supposed to catch is precisely what shipped: a
   * cron-refreshed headline above a live table.
   *
   * The failing half, added here: write to the ledger AFTER the rollup, then
   * check the two sources. The project headline must move (it is on the live
   * §A lane) and the aggregate must NOT (nobody has re-rolled it). If some
   * future change points the headline back at the aggregate, the first
   * assertion drops to the stale figure and this fails.
   */
  it('after a post-rollup ledger write the project figure is LIVE and the aggregate is stale', async () => {
    const before = (await completeOneProjectSpend(t.db, projectId, mtd())).costUsd
    const [aggBefore] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(total_cost_usd), 0)::text AS total FROM attribution_aggregate
      WHERE scope_type = 'project' AND scope_id = ${projectId}::uuid AND period_kind = 'day'
        AND period_start >= date_trunc('month', now() AT TIME ZONE 'UTC')`

    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)
    const d = new Date()
    await t.db.insert(schema.attributionRecord).values({
      instanceId: INSTANCE,
      claudeSessionId: 'conv-cn-post-rollup',
      teammateId: devId,
      projectId,
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      tool: 'claude-code',
      model: 'claude-fable-5',
      tokenType: 'input',
      tokens: 40_000n,
      costUsd: '0.250000',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      // A minute in the past: month-to-date is half-open and ends at NOW.
      tsEvent: new Date(Math.max(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), Date.now() - 60_000)),
      sourceRunId: 'post-rollup',
      querySource: 'main',
    } as never)

    // The headline saw it immediately — no rollup tick required.
    const after = (await completeOneProjectSpend(t.db, projectId, mtd())).costUsd
    expect(after).toBeCloseTo(before + 0.25, 6)

    // And the aggregate did NOT: the two sources really do diverge between
    // ticks, which is why the page must not quote one above the other in
    // silence. (This is the half the old assertion could never reach.)
    const [aggAfter] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(total_cost_usd), 0)::text AS total FROM attribution_aggregate
      WHERE scope_type = 'project' AND scope_id = ${projectId}::uuid AND period_kind = 'day'
        AND period_start >= date_trunc('month', now() AT TIME ZONE 'UTC')`
    expect(Number(aggAfter!.total)).toBeCloseTo(Number(aggBefore!.total), 6)
    expect(after).toBeGreaterThan(Number(aggAfter!.total))

    // The per-member grain moved with it — one lane, one window, so the table
    // under the headline cannot lag behind it.
    const members = await completeProjectSpendByMember(t.db, projectId, mtd())
    expect(members.reduce((a, m) => a + m.costUsd, 0)).toBeCloseTo(after, 6)

    // Restore the fixture for any later test in this file.
    await t.client`DELETE FROM attribution_record WHERE source_run_id = 'post-rollup'`
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
    const members = await completeProjectSpendByMember(t.db, projectId, mtd())
    expect(members.length).toBe(2)
    // dev's project rows: a1 .30 + a2 .15 + a3 .15 + a6 .005 = .605 > mate .60
    // (sorted on the RAW sums)
    expect(members[0]!.email).toBe('cn.dev@example.com')
    expect(members[0]!.costUsd).toBeCloseTo(0.605, 6)
    expect(members[1]!.costUsd).toBeCloseTo(0.6, 6)
    expect(members[0]!.tokens).toBe(165_000) // 100k+10k+50k+5k
    expect(members[0]!.activeDays).toBeGreaterThanOrEqual(1)
  })

  it('activity mix: tagged slices + NULL lane, cost desc', async () => {
    const mix = await completeProjectSpendByActivity(t.db, projectId, mtd())
    const labels = mix.map((m) => m.activity)
    expect(labels).toContain('feature-dev')
    expect(labels).toContain('research')
    expect(labels).toContain(null) // untagged-within-project (mate's row)
  })

  it('untagged pressure: members’ unallocated MTD spend, counts only', async () => {
    const up = await fetchUntaggedPressure(t.db, projectId, mtd())
    expect(up.conversations).toBe(1)
    expect(Number(up.cost_usd)).toBeCloseTo(0.09, 6)
  })

  it('untagged pressure STOPS AT NOW — a row dated later is not "pressure" yet', async () => {
    /*
     * The query used to be bounded from below only (`ts_event >=
     * date_trunc('month', now())`), so a row dated later today, later this
     * month, or in any later month counted towards a figure a PM reads as
     * "conversations to chase this week". A lower bound is not a window.
     */
    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)
    await t.db.insert(schema.attributionRecord).values({
      instanceId: INSTANCE,
      claudeSessionId: 'conv-cn-future-untagged',
      teammateId: devId,
      projectId: null,
      regionId,
      orgUnitId,
      costOwningUnitId: null,
      tool: 'claude-code',
      model: 'claude-fable-5',
      tokenType: 'input',
      tokens: 10_000n,
      costUsd: '4.000000',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      // A DAY into the future. Inside this month on all but one day of it, and
      // in the NEXT month on that day — both of which the old open-ended bound
      // counted, and neither of which the half-open window does.
      tsEvent: new Date(Date.now() + 86_400_000),
      sourceRunId: 'future-untagged',
      querySource: 'main',
    } as never)

    const up = await fetchUntaggedPressure(t.db, projectId, mtd())
    // Unchanged: still the ONE genuinely-past untagged conversation.
    expect(up.conversations).toBe(1)
    expect(Number(up.cost_usd)).toBeCloseTo(0.09, 6)

    // The row IS there — the silence above is the window, not a missing fixture.
    const laterWindow = { startIso: mtd().startIso, endIso: new Date(Date.now() + 172_800_000).toISOString() }
    const ahead = await fetchUntaggedPressure(t.db, projectId, laterWindow)
    expect(ahead.conversations).toBe(2)
    expect(Number(ahead.cost_usd)).toBeCloseTo(4.09, 6)

    await t.client`DELETE FROM attribution_record WHERE source_run_id = 'future-untagged'`
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

/*
 * fetchAdvisorySpend — the absence/zero distinction (external review, F1).
 *
 * THE DEFECT THIS PINS. The read used to be
 * `COALESCE(SUM(advisory_cost_usd), 0)` with a `?? 0` behind it, so a scope
 * whose rollup has NOT been materialised for the window came back as the number
 * 0 — indistinguishable from a scope the rollup HAS covered and measured at
 * zero advisory. The aggregate is the ONE cron-fed lane on the project page, so
 * "un-materialised" is a live state rather than a hypothetical, and collapsing
 * it publishes a measurement nobody made. NULL IS NOT 0. Restore either the
 * COALESCE or the `?? 0` and the first assertion goes red.
 */
describe('fetchAdvisorySpend — a missing aggregate is not a measured zero', () => {
  // A window far from every other fixture's rows, so "empty" is a property of
  // the window rather than of test ordering.
  const WINDOW = { startIso: '2031-03-01T00:00:00.000Z', endIso: '2031-03-31T00:00:00.000Z' }

  const cell = (day: string, costUsd: string, advisoryUsd: string) =>
    t.db.insert(schema.attributionAggregate).values({
      scopeType: 'project',
      scopeId: projectId,
      periodStart: new Date(`${day}T00:00:00Z`),
      periodEnd: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000),
      periodKind: 'day',
      model: 'claude-fable-5',
      tokenType: 'output',
      totalTokens: 100n,
      totalCostUsd: costUsd,
      advisoryCostUsd: advisoryUsd,
      recordCount: 1,
    })

  it('returns null when the aggregate holds no row for the scope+window', async () => {
    expect(await fetchAdvisorySpend(t.db, 'project', projectId, WINDOW)).toBeNull()
  })

  it('returns 0 — a NUMBER — when rows exist and they measured zero advisory', async () => {
    // Same call, same bounds as the assertion above; a different answer, because
    // a different fact. That contrast is the whole distinction being restored.
    await cell('2031-03-10', '4.000000', '0')
    expect((await fetchAdvisorySpend(t.db, 'project', projectId, WINDOW))?.usd).toBe(0)

    // …and a genuine tier-2 cell still sums — the absence handling ate nothing.
    await cell('2031-03-11', '7.500000', '2.250000')
    expect((await fetchAdvisorySpend(t.db, 'project', projectId, WINDOW))?.usd).toBeCloseTo(2.25, 6)

    await t.client`DELETE FROM attribution_aggregate
                   WHERE scope_id = ${projectId}::uuid AND period_start >= '2031-01-01'`
    expect(await fetchAdvisorySpend(t.db, 'project', projectId, WINDOW)).toBeNull()
  })

  /*
   * PARTIAL MATERIALISATION IS A THIRD ANSWER (external review r2). The absence
   * fix above only caught TOTAL absence: a window the rollup had covered for
   * some of its days still returned a confident sum with nothing to say it was
   * short. The figure now travels with the DAYS the aggregate actually holds, so
   * a caller can test them against the days it knows carry spend.
   *
   * RED ON REVERT: drop `materialisedDays` (return the bare number again) and
   * this goes red — there is then no way to tell these two windows apart.
   */
  it('reports WHICH days the rollup holds, not just the sum', async () => {
    await cell('2031-03-04', '1.000000', '0.500000')
    await cell('2031-03-06', '1.000000', '0.500000')
    const got = await fetchAdvisorySpend(t.db, 'project', projectId, WINDOW)
    expect(got!.usd).toBeCloseTo(1, 6)
    // Two of the window's thirty days — the sum is over those two, and says so.
    expect([...got!.materialisedDays].sort()).toEqual(['2031-03-04', '2031-03-06'])
    expect(got!.materialisedDays.has('2031-03-05')).toBe(false)

    await t.client`DELETE FROM attribution_aggregate
                   WHERE scope_id = ${projectId}::uuid AND period_start >= '2031-01-01'`
  })
})
