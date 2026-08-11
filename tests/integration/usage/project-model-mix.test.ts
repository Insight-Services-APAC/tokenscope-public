// @vitest-environment node
/*
 * The model axis reads what was measured — S3 (project mix), design test 13
 * (07-model-axis D7), updated by developer-pages W3 D27.4 (r1-H9 + fix 3):
 *
 * The project page's `mix.by_model` / `series_by_model` read the §A lane
 * (arms 1+2 of v_complete_usage, scoped by project_id) via
 * completeProjectModelMix / completeProjectModelSeries, over the page's
 * RESOLVED window (month/custom bounds — never a trailing-days parameter),
 * returning REASON-TYPED rows for ModelSplitPanel. Pinned here:
 *
 *   1. a TAGGED fill day's write-time children (mig 0123) appear in the mix
 *      with their measured dollars, beside the OTel models;
 *   2. every NULL-model remainder is a `__`-sentinel row typed by its reason
 *      (one row PER REASON — the coverage footer prices each) and can never
 *      classify as a category row;
 *   3. arm 3 cannot reach a project mix (project_id NULL by construction);
 *   4. an OTel-only project's NAMED rows equal the old aggregate read's
 *      content (golden parity — the source switch changed nothing it wasn't
 *      meant to);
 *   5. untagging the fill day removes its models from the mix;
 *   6. the mix follows the WINDOW BOUNDS it is given (r1-H9) — a bound that
 *      excludes a day excludes that day's models.
 *
 * Reverting the source switch (mix back to the aggregate) must turn 1, 2 and
 * 5 red; reverting the windowed read (bounds ignored) must turn 6 red.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { runAggregateRollup } from '../../../server/workers/aggregate-rollup'
import {
  completeProjectModelMix,
  completeProjectModelSeries,
  type SpendWindow,
} from '../../../server/usage/complete-spend'
import { fetchModelSeries, fetchWindowTotals } from '../../../server/usage/consumption'
import {
  modelBucketKind,
  UNATTRIBUTED_MODEL_LABEL,
} from '../../../shared/reports/model-attribution'

let t: TestDb
let regionId: string
let orgUnitId: string
let devId: string
let projectA: string
let projectB: string
let fillParentId: string
let fillParent2Id: string
const INSTANCE = randomUUID()

/** Everything is anchored to ONE instant just in the past, so the UTC day of
 *  the OTel rows and the fill day can never straddle a midnight between two
 *  Date.now() reads (the consumption-readmodel anchor lesson). */
const ANCHOR = new Date(Date.now() - 60_000)
const dayOf = (d: Date): string => d.toISOString().slice(0, 10)
const FILL_DAY = dayOf(ANCHOR)
const FILL_DAY_2 = dayOf(new Date(ANCHOR.getTime() - 86_400_000))

/** The page-window shape the reads now take: trailing N days as bounds. */
const windowOf = (days: number): SpendWindow => ({
  startIso: new Date(ANCHOR.getTime() - days * 86_400_000).toISOString(),
  endIso: new Date(ANCHOR.getTime() + 60_000).toISOString(),
})
const WIN = windowOf(30)

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'apac-pmm', displayName: 'APAC' })
    .returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'apac.pmm', code: 'pmm', displayName: 'PMM', unitType: 'bu' })
    .returning()
  orgUnitId = bu!.id
  const [dev] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-pmm-dev', email: 'pmm.dev@example.com', regionId, orgUnitId })
    .returning()
  devId = dev!.id

  const mkProject = async (code: string) => {
    const [p] = await t.db
      .insert(schema.project)
      .values({
        code,
        codeHash: `h-${code.toLowerCase()}`,
        displayName: code,
        type: 'billable',
        regionId,
        costOwningUnitId: orgUnitId,
      })
      .returning()
    return p!.id
  }
  projectA = await mkProject('PMM-A') // OTel + tagged fill
  projectB = await mkProject('PMM-B') // OTel only — the parity control

  await t.db.insert(schema.instanceAttestation).values({
    instanceId: INSTANCE,
    principalOid: 'oid-pmm-dev',
    teammateId: devId,
    projectCodeHash: 'h-pmm-a',
    rawProjectCode: 'PMM-A',
    tool: 'claude-code',
    sessionTokenHash: `tok-pmm-${INSTANCE}`,
    tsStart: ANCHOR,
    regionId,
    orgUnitId,
    costOwningUnitId: orgUnitId,
  })

  // ── Arm 1 (OTel-emitted, project-tagged) ──────────────────────────────────
  const otel = (projectId: string, model: string, costUsd: string, tokens: number) =>
    t.db.insert(schema.attributionRecord).values({
      instanceId: INSTANCE,
      claudeSessionId: `conv-pmm-${randomUUID().slice(0, 8)}`,
      teammateId: devId,
      projectId,
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      tool: 'claude-code',
      model,
      tokenType: 'output',
      tokens: BigInt(tokens),
      costUsd,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: ANCHOR,
      sourceRunId: randomUUID(),
    })
  await otel(projectA, 'claude-fable-5', '1.000000', 1000)
  await otel(projectA, 'claude-fable-5', '1.000000', 1000)
  await otel(projectB, 'claude-fable-5', '2.000000', 1000)
  await otel(projectB, 'claude-haiku-4-5', '0.500000', 500)

  // ── Arm 2: one TAGGED fill day with measured children (Σ children < parent,
  //    so a positive 'unmodelled-provider-cost' remainder exists) ────────────
  const [p1] = await t.db
    .insert(schema.unaccountedUsage)
    .values({
      teammateId: devId,
      regionId,
      orgUnitId,
      day: FILL_DAY,
      tool: 'claude-code',
      costUsd: '10.000000',
      tokens: 5000n,
      projectId: projectA,
    })
    .returning()
  fillParentId = p1!.id
  await t.db.insert(schema.unaccountedUsageModel).values([
    { unaccountedUsageId: fillParentId, model: 'claude-fable-5', costUsd: '4.000000', tokens: 2000n },
    { unaccountedUsageId: fillParentId, model: 'claude-haiku-4-5', costUsd: '5.000000', tokens: 2500n },
  ])

  // A second tagged fill day with NO children and a DIFFERENT gap reason —
  // reason-typed remainders stay SEPARATE rows (one per reason), never fold
  // into each other and never into a category.
  const [p2] = await t.db
    .insert(schema.unaccountedUsage)
    .values({
      teammateId: devId,
      regionId,
      orgUnitId,
      day: FILL_DAY_2,
      tool: 'claude-code',
      costUsd: '2.500000',
      tokens: 0n,
      projectId: projectA,
      modelGapReason: 'awaiting-provider-detail',
    })
    .returning()
  fillParent2Id = p2!.id

  // ── Arm 3 (ingest-only): the same teammate's claude-ai day. It reaches
  //    v_complete_usage with project_id NULL BY CONSTRUCTION (mig 0101/0124)
  //    and must never enter a project mix. ─────────────────────────────────
  await t.db.insert(schema.actualSpend).values({
    teammateId: devId,
    date: FILL_DAY,
    tool: 'claude-ai',
    inputTokens: 100n,
    outputTokens: 100n,
    costUsd: '7.770000',
    source: `api:${randomUUID().slice(0, 8)}`,
  })

  // Materialise the aggregate — the OLD source, for the parity control.
  await runAggregateRollup(t.db)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('project model mix reads the §A lane, windowed and reason-typed (D7 + W3 D27.4)', () => {
  it('a tagged fill day’s child models appear in mix.by_model with their measured dollars', async () => {
    const mix = await completeProjectModelMix(t.db, projectA, WIN)
    // fable = $2 OTel + $4 child; haiku = $5 child; remainders: $1 shortfall
    // (parent 10 − Σ children 9, reason 'unmodelled-provider-cost') and the
    // $2.50 awaiting-detail day — TWO reason-typed rows, not one bucket.
    expect(mix).toEqual([
      { key: 'claude-fable-5', label: 'claude-fable-5', cost_usd: '6.00', tokens: 4000, gap_reason: null },
      { key: 'claude-haiku-4-5', label: 'claude-haiku-4-5', cost_usd: '5.00', tokens: 2500, gap_reason: null },
      {
        key: '__null_model:awaiting-provider-detail',
        label: 'Awaiting provider detail',
        cost_usd: '2.50',
        tokens: 0,
        gap_reason: 'awaiting-provider-detail',
      },
      {
        key: '__null_model:unmodelled-provider-cost',
        label: UNATTRIBUTED_MODEL_LABEL,
        cost_usd: '1.00',
        tokens: 500,
        gap_reason: 'unmodelled-provider-cost',
      },
    ])
  })

  it('every remainder is a __-sentinel row the classifier keeps OUT of the ranking (fix 3)', async () => {
    const mix = await completeProjectModelMix(t.db, projectA, WIN)
    for (const row of mix) {
      if (row.gap_reason != null) {
        expect(row.key.startsWith('__')).toBe(true)
        expect(modelBucketKind(row.key)).toBe('remainder')
      } else {
        expect(modelBucketKind(row.key)).toBe('model')
      }
    }
    // Named rows are exactly the two real models — a remainder never ranks.
    expect(mix.filter((m) => modelBucketKind(m.key) === 'model').map((m) => m.key)).toEqual([
      'claude-fable-5',
      'claude-haiku-4-5',
    ])
  })

  it('series_by_model carries the fill day’s models on the fill day, remainders reason-labelled per day', async () => {
    const series = await completeProjectModelSeries(t.db, projectA, WIN)
    const rows = (day: string) => series.filter((r) => r.day === day)
    expect(rows(FILL_DAY)).toEqual(
      expect.arrayContaining([
        { day: FILL_DAY, model: 'claude-fable-5', cost_usd: '6.00' },
        { day: FILL_DAY, model: 'claude-haiku-4-5', cost_usd: '5.00' },
        { day: FILL_DAY, model: UNATTRIBUTED_MODEL_LABEL, cost_usd: '1.00' },
      ]),
    )
    expect(rows(FILL_DAY)).toHaveLength(3)
    // The awaiting-detail day keeps its OWN reason wording — the stack's keys
    // are the mix's labels, so the two must agree per reason.
    expect(rows(FILL_DAY_2)).toEqual([
      { day: FILL_DAY_2, model: 'Awaiting provider detail', cost_usd: '2.50' },
    ])
    // Day-ordered like the aggregate series it replaced.
    expect(series.map((r) => r.day)).toEqual([...series.map((r) => r.day)].sort())
  })

  it('arm 3 never reaches a project mix (project_id NULL by construction)', async () => {
    const mix = await completeProjectModelMix(t.db, projectA, WIN)
    const total = mix.reduce((a, m) => a + Number(m.cost_usd), 0)
    // $14.50 = 2 OTel + 10 fill + 2.50 fill; the $7.77 claude-ai day is absent.
    expect(total).toBeCloseTo(14.5, 6)
    expect(mix.some((m) => m.cost_usd === '7.77')).toBe(false)
  })

  it('an OTel-only project is unchanged: the lane read’s named rows equal the old aggregate read', async () => {
    const laneMix = await completeProjectModelMix(t.db, projectB, WIN)
    const aggMix = (await fetchWindowTotals(t.db, 'project', projectB, 30)).by_model
    expect(laneMix.map((m) => ({ model: m.label, tokens: m.tokens, cost_usd: m.cost_usd }))).toEqual(
      aggMix,
    )
    expect(laneMix).toEqual([
      { key: 'claude-fable-5', label: 'claude-fable-5', cost_usd: '2.00', tokens: 1000, gap_reason: null },
      { key: 'claude-haiku-4-5', label: 'claude-haiku-4-5', cost_usd: '0.50', tokens: 500, gap_reason: null },
    ])

    const bySeriesKey = (a: { day: string; model: string }, b: { day: string; model: string }) =>
      a.day.localeCompare(b.day) || a.model.localeCompare(b.model)
    const laneSeries = [...(await completeProjectModelSeries(t.db, projectB, WIN))].sort(bySeriesKey)
    const aggSeries = [...(await fetchModelSeries(t.db, 'project', projectB, 30))].sort(bySeriesKey)
    expect(laneSeries).toEqual(aggSeries)
  })

  it('the mix follows its WINDOW BOUNDS (r1-H9): a bound that excludes a day excludes its models', async () => {
    // A window that ends BEFORE the fill/OTel day: only the older awaiting-
    // detail fill day is inside. Reverting the windowed read (ignoring the
    // bounds for a trailing clock) turns this red.
    const upToYesterday: SpendWindow = {
      startIso: new Date(ANCHOR.getTime() - 30 * 86_400_000).toISOString(),
      endIso: `${FILL_DAY}T00:00:00.000Z`,
    }
    const mix = await completeProjectModelMix(t.db, projectA, upToYesterday)
    expect(mix).toEqual([
      {
        key: '__null_model:awaiting-provider-detail',
        label: 'Awaiting provider detail',
        cost_usd: '2.50',
        tokens: 0,
        gap_reason: 'awaiting-provider-detail',
      },
    ])
    const series = await completeProjectModelSeries(t.db, projectA, upToYesterday)
    expect(series.every((r) => r.day < FILL_DAY)).toBe(true)
  })

  it('untagging the fill days removes their models from the mix; re-tagging restores them', async () => {
    await t.db
      .update(schema.unaccountedUsage)
      .set({ projectId: null })
      .where(eq(schema.unaccountedUsage.id, fillParentId))
    await t.db
      .update(schema.unaccountedUsage)
      .set({ projectId: null })
      .where(eq(schema.unaccountedUsage.id, fillParent2Id))

    const untagged = await completeProjectModelMix(t.db, projectA, WIN)
    expect(untagged).toEqual([
      { key: 'claude-fable-5', label: 'claude-fable-5', cost_usd: '2.00', tokens: 2000, gap_reason: null },
    ])
    const untaggedSeries = await completeProjectModelSeries(t.db, projectA, WIN)
    expect(untaggedSeries.every((r) => r.model === 'claude-fable-5')).toBe(true)

    // Re-tag (the session_assignment flow writes exactly this column) → back.
    await t.db
      .update(schema.unaccountedUsage)
      .set({ projectId: projectA })
      .where(eq(schema.unaccountedUsage.id, fillParentId))
    const retagged = await completeProjectModelMix(t.db, projectA, WIN)
    expect(retagged.map((m) => m.key)).toEqual([
      'claude-fable-5',
      'claude-haiku-4-5',
      '__null_model:unmodelled-provider-cost',
    ])
  })
})
