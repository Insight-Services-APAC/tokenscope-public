// @vitest-environment node
/*
 * T16 (server half) — completeTeammateModelMix (developer-pages W2 D20,
 * docs/design/developer-pages-consolidation/01-build-design.md).
 *
 * The /usage Top-models panel's read: same lane, same reason-typed remainder
 * folding as the project mix, scoped by teammate_id over arms 1+2, and taking
 * RESOLVED window bounds (r1-H9) so the panel always follows the page window.
 *
 * Each assertion was verified to FAIL with its fix reverted; the mutation is
 * recorded above it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { completeTeammateModelMix } from '../../../server/usage/complete-spend'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let alice = ''
let bob = ''

/** July 2026, whole-month half-open window (the resolved-month shape). */
const JULY = { startIso: '2026-07-01T00:00:00.000Z', endIso: '2026-08-01T00:00:00.000Z' }

const instanceByTeammate = new Map<string, string>()

async function otel(tmId: string, model: string, costUsd: string, tsEvent: string): Promise<void> {
  let instanceId = instanceByTeammate.get(tmId)
  if (!instanceId) {
    instanceId = randomUUID()
    await t.db.insert(schema.instanceAttestation).values({
      instanceId,
      principalOid: `oid-${tmId}`,
      teammateId: tmId,
      projectCodeHash: 'h-tmm',
      rawProjectCode: 'TMM',
      tool: 'claude-code',
      tsStart: new Date('2026-06-01T00:00:00.000Z'),
      regionId,
      orgUnitId,
    })
    instanceByTeammate.set(tmId, instanceId)
  }
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    claudeSessionId: randomUUID(),
    teammateId: tmId,
    regionId,
    orgUnitId,
    tool: 'claude-code',
    model,
    tokenType: 'output',
    tokens: 1000n,
    costUsd,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: new Date(tsEvent),
    sourceRunId: randomUUID(),
  })
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'tmm', displayName: 'TMM' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'tmm', code: 'tmm-bu', displayName: 'TMM', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
  const mk = async (email: string) => {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: `oid-${email}`, email, regionId, orgUnitId })
      .returning()
    return tm!.id
  }
  alice = await mk('tmm-alice@x.test')
  bob = await mk('tmm-bob@x.test')

  // Arm 1: two named models in July, one of them twice (folds to one row).
  await otel(alice, 'claude-opus-5', '10.00', '2026-07-10T10:00:00.000Z')
  await otel(alice, 'claude-opus-5', '5.00', '2026-07-11T10:00:00.000Z')
  await otel(alice, 'claude-sonnet-5', '3.00', '2026-07-12T10:00:00.000Z')
  // Out of window (June) — must not enter a July read (r1-H9).
  await otel(alice, 'claude-opus-5', '400.00', '2026-06-20T10:00:00.000Z')
  // Another teammate — must never leak in.
  await otel(bob, 'claude-opus-5', '900.00', '2026-07-10T10:00:00.000Z')

  // Arm 2b: an untagged fill day with NO model children → the view emits ONE
  // reason-typed NULL-model remainder for it (mig 0124).
  await t.db.insert(schema.unaccountedUsage).values({
    teammateId: alice,
    regionId,
    orgUnitId,
    day: '2026-07-15',
    tool: 'claude-code',
    costUsd: '2.00',
    tokens: 100n,
    modelGapReason: 'awaiting-provider-detail',
  })
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('completeTeammateModelMix (T16 server half)', () => {
  /*
   * MUTATION: scope by project instead of teammate, or drop the teammate
   * predicate — bob's $900 lands and every figure goes red.
   * MUTATION: skip the fold — 'claude-opus-5' appears twice and rows.length
   * goes red.
   */
  it('returns reason-typed rows + the mix’s own Σ, teammate-scoped', async () => {
    const out = await completeTeammateModelMix(t.db as never, alice, JULY)

    const named = out.rows.filter((r) => !r.key.startsWith('__'))
    expect(named.map((r) => [r.key, r.cost_usd])).toEqual([
      ['claude-opus-5', '15.00'],
      ['claude-sonnet-5', '3.00'],
    ])
    // Named rows carry no gap reason.
    for (const r of named) expect(r.gap_reason).toBeNull()

    // The arm-2 remainder is ONE reason-typed row, never a category.
    const remainders = out.rows.filter((r) => r.key.startsWith('__'))
    expect(remainders).toHaveLength(1)
    expect(remainders[0]!.key).toBe('__null_model:awaiting-provider-detail')
    expect(remainders[0]!.gap_reason).toBe('awaiting-provider-detail')
    expect(remainders[0]!.cost_usd).toBe('2.00')

    // The denominator is the mix's OWN Σ (bars + remainder foot to it).
    expect(out.totalUsd).toBeCloseTo(20, 6)
  })

  /*
   * MUTATION (r1-H9): revert the windowed read to a trailing-days parameter —
   * a narrowed window no longer changes the rows and this goes red.
   */
  it('follows the RESOLVED window: narrowing it changes the rows', async () => {
    const narrow = await completeTeammateModelMix(t.db as never, alice, {
      startIso: '2026-07-12T00:00:00.000Z',
      endIso: '2026-07-13T00:00:00.000Z',
    })
    expect(narrow.rows.map((r) => r.key)).toEqual(['claude-sonnet-5'])
    expect(narrow.totalUsd).toBeCloseTo(3, 6)

    // June: only the out-of-July row.
    const june = await completeTeammateModelMix(t.db as never, alice, {
      startIso: '2026-06-01T00:00:00.000Z',
      endIso: '2026-07-01T00:00:00.000Z',
    })
    expect(june.rows.map((r) => [r.key, r.cost_usd])).toEqual([['claude-opus-5', '400.00']])
  })

  it('an empty window is an honest empty', async () => {
    const out = await completeTeammateModelMix(t.db as never, bob, {
      startIso: '2026-01-01T00:00:00.000Z',
      endIso: '2026-02-01T00:00:00.000Z',
    })
    expect(out.rows).toEqual([])
    expect(out.totalUsd).toBe(0)
  })
})
