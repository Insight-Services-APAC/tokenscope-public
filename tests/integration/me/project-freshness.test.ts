// @vitest-environment node
/*
 * Freshness disclosure — server/usage/freshness.ts against a real Postgres.
 *
 * Two claims are pinned here, and both were made and then contradicted by the
 * code that made them:
 *
 *   1. "As fresh as its STALEST source." The /projects page quotes ONE rollup
 *      age for a whole set of projects. It was a MAX over `refresh_at`, i.e. the
 *      FRESHEST one — so a single recently-rolled project spoke for every card,
 *      and the projects the disclosure exists for were the ones it hid. A
 *      project with no rollup row at all contributed nothing to either
 *      aggregate and disappeared entirely.
 *
 *   2. "Freshness". The lane leg measured the age of the newest EVENT, which is
 *      not how stale the data is: a reconciliation written seconds ago for
 *      yesterday reads as a day old, and a future-dated provider row reads as a
 *      NEGATIVE age. It is now named `latestUsageEventMinutes`, clamped at zero,
 *      and kept out of the worst-of-sources figure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import {
  aggregateSetFreshness,
  latestUsageEventMinutes,
  worstFreshness,
} from '../../../server/usage/freshness'

let t: TestDb
let regionId: string
let orgUnitId: string
let devId: string
/** Rolled up 10 minutes ago. */
let projFresh: string
/** Rolled up 6 hours ago — the STALEST of the three. */
let projStale: string
/** Never rolled up at all. */
let projNever: string
const INSTANCE = randomUUID()

const MIN = 60_000

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'apac-fresh', displayName: 'APAC' })
    .returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'apac.fresh', code: 'fresh', displayName: 'Fresh', unitType: 'bu' })
    .returning()
  orgUnitId = bu!.id
  const [dev] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-fresh-dev', email: 'fresh.dev@example.com', regionId, orgUnitId })
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
  projFresh = await mkProject('FRESH-1')
  projStale = await mkProject('FRESH-2')
  projNever = await mkProject('FRESH-3')

  const day = new Date(Date.UTC(2026, 4, 10))
  const mkAgg = async (scopeId: string, refreshAt: Date) => {
    await t.db.insert(schema.attributionAggregate).values({
      scopeType: 'project',
      scopeId,
      periodStart: day,
      periodEnd: new Date(day.getTime() + 86_400_000),
      periodKind: 'day',
      totalTokens: 1000n,
      totalCostUsd: '1.000000',
      recordCount: 1,
      refreshAt,
    })
  }
  const now = Date.now()
  await mkAgg(projFresh, new Date(now - 10 * MIN))
  await mkAgg(projStale, new Date(now - 360 * MIN))
  // projNever deliberately gets NO aggregate row.

  await t.db.insert(schema.instanceAttestation).values({
    instanceId: INSTANCE,
    principalOid: 'oid-fresh-inst',
    teammateId: devId,
    projectCodeHash: 'h-fresh',
    rawProjectCode: 'FRESH',
    tool: 'claude-code',
    sessionTokenHash: 'tok-fresh',
    tsStart: new Date(now - 3 * MIN),
    regionId,
    orgUnitId,
    costOwningUnitId: orgUnitId,
  })
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('rollup freshness across a SET of projects', () => {
  it('reports the STALEST project, not the freshest', async () => {
    const f = await aggregateSetFreshness(t.db, 'project', [projFresh, projStale])
    // 360 minutes, not 10. A MAX(refresh_at) implementation returns ~10 here and
    // tells every card on the page it is ten minutes old.
    expect(f.stalestMinutes).toBeGreaterThanOrEqual(355)
    expect(f.stalestMinutes).toBeLessThanOrEqual(365)
    expect(f.neverRefreshed).toBe(0)
    expect(worstFreshness([f.stalestMinutes])).toBe(f.stalestMinutes)
  })

  it('counts projects with NO rollup instead of dropping them', async () => {
    const f = await aggregateSetFreshness(t.db, 'project', [projFresh, projStale, projNever])
    // The never-rolled project cannot make the timestamp older (it has none), so
    // the only honest way to keep it visible is to count it. Dropping it silently
    // is how "every project on this page is 10 minutes fresh" got said about a
    // project that had never been rolled up at all.
    expect(f.neverRefreshed).toBe(1)
    expect(f.stalestMinutes).toBeGreaterThanOrEqual(355)
  })

  it('a set with only never-rolled projects reports unknown, not zero', async () => {
    const f = await aggregateSetFreshness(t.db, 'project', [projNever])
    expect(f.stalestMinutes).toBeNull()
    expect(f.neverRefreshed).toBe(1)
    // null, not 0 — "no rollup" must never render as "refreshed just now".
    expect(worstFreshness([f.stalestMinutes])).toBeNull()
  })

  it('an empty set is unknown, without a round trip', async () => {
    expect(await aggregateSetFreshness(t.db, 'project', [])).toEqual({
      stalestMinutes: null,
      neverRefreshed: 0,
    })
  })
})

describe('latest usage event age (NOT freshness)', () => {
  const insertEvent = async (projectId: string, tsEvent: Date, run: string) => {
    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)
    await t.db.insert(schema.attributionRecord).values({
      instanceId: INSTANCE,
      claudeSessionId: `conv-fresh-${run}`,
      teammateId: devId,
      projectId,
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      tool: 'claude-code',
      model: 'claude-fable-5',
      tokenType: 'input',
      tokens: 1000n,
      costUsd: '1.000000',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent,
      sourceRunId: run,
      querySource: 'main',
    } as never)
  }

  it('null when the project has no §A spend at all', async () => {
    expect(await latestUsageEventMinutes(t.db, projNever)).toBeNull()
  })

  it('measures the NEWEST event, in minutes', async () => {
    await insertEvent(projFresh, new Date(Date.now() - 90 * MIN), 'fr-old')
    await insertEvent(projFresh, new Date(Date.now() - 25 * MIN), 'fr-new')
    const m = await latestUsageEventMinutes(t.db, projFresh)
    expect(m).toBeGreaterThanOrEqual(24)
    expect(m).toBeLessThanOrEqual(26)
  })

  it('a FUTURE-dated event reads as 0, never a negative age', async () => {
    /*
     * The §A lane carries day-grained arms: a provider row for today bins to
     * 00:00Z of a day still in progress, and any hand-seeded or clock-skewed row
     * can land ahead of `now`. `now - MAX(ts_event)` is then negative, and the
     * page rendered it as "-180 min ago". Clamped at the source so no surface has
     * to know.
     */
    await insertEvent(projStale, new Date(Date.now() + 180 * MIN), 'fr-future')
    expect(await latestUsageEventMinutes(t.db, projStale)).toBe(0)
  })
})
