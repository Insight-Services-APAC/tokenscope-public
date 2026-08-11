/*
 * Phase A acceptance (ledger-retention epic): the durable spend_rollup_daily +
 * spend_session_daily must let the dev / PM / finance personas be reconstructed
 * from the ROLLUP ALONE — i.e. after raw is retired. Exercises spill
 * (project NULL), the cost_basis indicative split, multi-contributor per project,
 * the activity dimension, session count, totals tie-out, and idempotency.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runAggregateRollup, DEFAULT_BACKFILL_DAYS } from '../../../server/workers/aggregate-rollup'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId = ''
let bu = ''
let p1 = ''
let t1 = ''
let t2 = ''

/*
 * RELATIVE, and DERIVED — for the same reason in both halves.
 *
 * This was a fixed `2026-05-10` measured against a relative window: the
 * worker's backfill horizon. On 2026-08-08 the seeded day aged out of that
 * horizon, the worker correctly wrote nothing for it, and seven assertions here
 * began reading "expected 29, got 0" — on every branch, for a reason none of
 * them had changed. An absolute date measured against a relative window is a
 * test with an expiry date on it.
 *
 * The seed day has to satisfy BOTH ends at once:
 *   · OLDER than the freeze floor — the freeze-floor case below needs it
 *     beneath the floor to prove such a day is not recomputed
 *   · NEWER than the backfill horizon — or the default backfill never reaches it
 *
 * So it is the MIDPOINT of that band, computed from the worker's own exported
 * constant rather than a copy of it. The first version of this fix hard-coded
 * `90` here beside `DAY_AGE_DAYS = 45`; had the worker moved to 40, that guard
 * would still have passed and this suite would still have failed with seven
 * zeroes — a guard whose message claimed to watch the worker's defaults while
 * watching two literals of its own. Import the horizon and the day re-centres
 * itself; the guard below then genuinely fails when the band closes.
 */
const FREEZE_FLOOR_DAYS = 30
const DAY_AGE_DAYS = Math.round((FREEZE_FLOOR_DAYS + DEFAULT_BACKFILL_DAYS) / 2)
const DAY = new Date(Date.now() - DAY_AGE_DAYS * 86_400_000).toISOString()

if (DAY_AGE_DAYS <= FREEZE_FLOOR_DAYS || DAY_AGE_DAYS >= DEFAULT_BACKFILL_DAYS) {
  throw new Error(
    `DAY_AGE_DAYS=${DAY_AGE_DAYS} must sit strictly between the ${FREEZE_FLOOR_DAYS}-day ` +
      `freeze floor and the ${DEFAULT_BACKFILL_DAYS}-day backfill horizon ` +
      `(aggregate-rollup.ts DEFAULT_BACKFILL_DAYS) — outside that band this suite fails ` +
      `with zeroes for a reason that has nothing to do with the code under test.`,
  )
}

interface Row {
  tm: string
  project: string | null
  tool: string
  model: string
  tokenType: string
  cost: string
  basis: 'estimated' | 'telemetry-only'
  session: string
  activity: string | null
}

async function emit(r: Row): Promise<void> {
  const instanceId = crypto.randomUUID()
  const attested = r.project != null
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: `oid-${r.tm}`,
    teammateId: r.tm,
    projectCodeHash: attested ? `h-${r.project}` : null,
    rawProjectCode: attested ? 'P' : null,
    tool: r.tool,
    tsStart: new Date(DAY),
    regionId,
    orgUnitId: bu,
    costOwningUnitId: attested ? bu : null,
    attestationState: attested ? 'attested' : 'unassigned',
  })
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    claudeSessionId: r.session,
    teammateId: r.tm,
    projectId: r.project,
    regionId,
    orgUnitId: bu,
    costOwningUnitId: r.project ? bu : null,
    tool: r.tool,
    model: r.model,
    tokenType: r.tokenType,
    tokens: 1000n,
    costUsd: r.cost,
    fidelityTier: r.basis === 'telemetry-only' ? 'tier-2' : 'tier-1',
    costBasis: r.basis,
    tsEvent: new Date(DAY),
    activity: r.activity,
    querySource: 'main',
  })
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'sr', displayName: 'R' }).returning()
  regionId = r!.id
  const [b] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'sr.bu', code: 'sr-bu', displayName: 'BU', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  bu = b!.id
  const projs = await t.db
    .insert(schema.project)
    .values([
      { code: 'P1', codeHash: 'h-P1', displayName: 'P1', type: 'billable', regionId, costOwningUnitId: bu },
      { code: 'P2', codeHash: 'h-P2', displayName: 'P2', type: 'billable', regionId, costOwningUnitId: bu },
    ])
    .returning()
  p1 = projs.find((x) => x.code === 'P1')!.id
  // P2 is seeded but unused (it must NOT produce phantom rollup cells).
  const tms = await t.db
    .insert(schema.teammate)
    .values([
      { entraOid: 'o-t1', email: 't1@x.com', regionId, orgUnitId: bu },
      { entraOid: 'o-t2', email: 't2@x.com', regionId, orgUnitId: bu },
    ])
    .returning()
  t1 = tms.find((x) => x.email === 't1@x.com')!.id
  t2 = tms.find((x) => x.email === 't2@x.com')!.id

  // T1 on P1: two token_types in ONE session (s1) + a copilot/indicative session (s2)
  await emit({ tm: t1, project: p1, tool: 'claude-code', model: 'opus', tokenType: 'output', cost: '10', basis: 'estimated', session: 's1', activity: 'coding' })
  await emit({ tm: t1, project: p1, tool: 'claude-code', model: 'opus', tokenType: 'input', cost: '2', basis: 'estimated', session: 's1', activity: 'coding' })
  await emit({ tm: t1, project: p1, tool: 'copilot-cli', model: 'gpt', tokenType: 'input', cost: '5', basis: 'telemetry-only', session: 's2', activity: null })
  // T2 on P1
  await emit({ tm: t2, project: p1, tool: 'claude-code', model: 'sonnet', tokenType: 'output', cost: '8', basis: 'estimated', session: 's3', activity: 'review' })
  // T1 spill: tagged (research) + untagged, both telemetry-only
  await emit({ tm: t1, project: null, tool: 'claude-code', model: 'opus', tokenType: 'output', cost: '3', basis: 'telemetry-only', session: 's4', activity: 'research' })
  await emit({ tm: t1, project: null, tool: 'claude-code', model: 'opus', tokenType: 'output', cost: '1', basis: 'telemetry-only', session: 's5', activity: null })

  await runAggregateRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

const num = (rows: { v: string | null }[]): number => Number(rows[0]?.v ?? 0)

describe('spend_rollup_daily — reconstructable persona views from the rollup alone', () => {
  it('totals tie out to the raw ledger (cost + tokens)', async () => {
    const raw = await t.client<{ v: string }[]>`SELECT round(sum(cost_usd),4)::text AS v FROM attribution_record`
    const roll = await t.client<{ v: string }[]>`SELECT round(sum(total_cost_usd),4)::text AS v FROM spend_rollup_daily`
    expect(num(roll)).toBe(num(raw))
    expect(num(roll)).toBe(29) // 10+2+5+8+3+1
    const rawTok = await t.client<{ v: string }[]>`SELECT sum(tokens)::text AS v FROM attribution_record`
    const rollTok = await t.client<{ v: string }[]>`SELECT sum(total_tokens)::text AS v FROM spend_rollup_daily`
    expect(num(rollTok)).toBe(num(rawTok))
  })

  it('finance: per-CoU total, indicative split, and spill are all present', async () => {
    const cou = await t.client<{ v: string }[]>`SELECT round(sum(total_cost_usd),2)::text AS v FROM spend_rollup_daily WHERE cost_owning_unit_id = ${bu}::uuid`
    expect(num(cou)).toBe(25) // project-attributed only: 10+2+5+8
    const indicative = await t.client<{ v: string }[]>`SELECT round(sum(indicative_cost_usd),2)::text AS v FROM spend_rollup_daily`
    expect(num(indicative)).toBe(9) // telemetry-only: 5+3+1
    const spill = await t.client<{ v: string }[]>`SELECT round(sum(total_cost_usd),2)::text AS v FROM spend_rollup_daily WHERE project_id IS NULL`
    expect(num(spill)).toBe(4) // 3+1
  })

  it('PM: per-contributor spend on a project is reconstructable', async () => {
    const t1OnP1 = await t.client<{ v: string }[]>`SELECT round(sum(total_cost_usd),2)::text AS v FROM spend_rollup_daily WHERE project_id = ${p1}::uuid AND teammate_id = ${t1}::uuid`
    expect(num(t1OnP1)).toBe(17) // 10+2+5
    const t2OnP1 = await t.client<{ v: string }[]>`SELECT round(sum(total_cost_usd),2)::text AS v FROM spend_rollup_daily WHERE project_id = ${p1}::uuid AND teammate_id = ${t2}::uuid`
    expect(num(t2OnP1)).toBe(8)
    // activity dimension survives
    const coding = await t.client<{ v: string }[]>`SELECT round(sum(total_cost_usd),2)::text AS v FROM spend_rollup_daily WHERE activity = 'coding'`
    expect(num(coding)).toBe(12)
    expect(num(await t.client<{ v: string }[]>`SELECT count(DISTINCT period_start)::text AS v FROM spend_rollup_daily WHERE project_id = ${p1}::uuid`)).toBe(1)
  })

  it('dev: query_source + token_type + model mix derivable', async () => {
    const cells = await t.client<{ v: string }[]>`SELECT count(*)::text AS v FROM spend_rollup_daily WHERE teammate_id = ${t1}::uuid AND query_source = 'main'`
    expect(num(cells)).toBeGreaterThan(0)
    const byType = await t.client<{ token_type: string; c: string }[]>`SELECT token_type, round(sum(total_cost_usd),2)::text AS c FROM spend_rollup_daily WHERE teammate_id = ${t1}::uuid GROUP BY token_type ORDER BY token_type`
    expect(byType.length).toBeGreaterThanOrEqual(2) // input + output
  })

  it('session companion: distinct sessions per (teammate, project, day)', async () => {
    const t1p1 = await t.client<{ v: string }[]>`SELECT distinct_session_count::text AS v FROM spend_session_daily WHERE teammate_id = ${t1}::uuid AND project_id = ${p1}::uuid`
    expect(num(t1p1)).toBe(2) // s1, s2
    const t2p1 = await t.client<{ v: string }[]>`SELECT distinct_session_count::text AS v FROM spend_session_daily WHERE teammate_id = ${t2}::uuid AND project_id = ${p1}::uuid`
    expect(num(t2p1)).toBe(1) // s3
    const t1spill = await t.client<{ v: string }[]>`SELECT distinct_session_count::text AS v FROM spend_session_daily WHERE teammate_id = ${t1}::uuid AND project_id IS NULL`
    expect(num(t1spill)).toBe(2) // s4, s5
  })

  it('idempotent — re-running does not duplicate or change cells', async () => {
    const before = await t.client<{ v: string }[]>`SELECT count(*)::text AS v FROM spend_rollup_daily`
    const beforeS = await t.client<{ v: string }[]>`SELECT count(*)::text AS v FROM spend_session_daily`
    await runAggregateRollup(t.db)
    expect(num(await t.client<{ v: string }[]>`SELECT count(*)::text AS v FROM spend_rollup_daily`)).toBe(num(before))
    expect(num(await t.client<{ v: string }[]>`SELECT count(*)::text AS v FROM spend_session_daily`)).toBe(num(beforeS))
    // totals still tie out after re-run
    const roll = await t.client<{ v: string }[]>`SELECT round(sum(total_cost_usd),2)::text AS v FROM spend_rollup_daily`
    expect(num(roll)).toBe(29)
  })

  it('freeze-floor — a day below the floor is NOT recomputed or erased (C2)', async () => {
    // The seed day (DAY) sits mid-band, so it is below the freeze floor by
    // construction. Add raw to it, then roll up WITH the floor: the cold cells
    // must stay untouched — raw grows, the rollup does not (and is not wiped).
    await emit({ tm: t1, project: p1, tool: 'claude-code', model: 'opus', tokenType: 'output', cost: '7', basis: 'estimated', session: 's9', activity: 'coding' })
    const rawAfter = await t.client<{ v: string }[]>`SELECT round(sum(cost_usd),2)::text AS v FROM attribution_record`
    expect(num(rawAfter)).toBe(36) // 29 + 7

    await runAggregateRollup(t.db, { freezeFloorDays: FREEZE_FLOOR_DAYS })

    const roll = await t.client<{ v: string }[]>`SELECT round(sum(total_cost_usd),2)::text AS v FROM spend_rollup_daily`
    expect(num(roll)).toBe(29) // unchanged — the $7 below the floor was NOT folded in
    // and not erased: the cold cells survive
    expect(num(await t.client<{ v: string }[]>`SELECT count(*)::text AS v FROM spend_rollup_daily`)).toBeGreaterThan(0)
  })
})
