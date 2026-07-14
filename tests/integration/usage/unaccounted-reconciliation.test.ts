// @vitest-environment node
/*
 * Intent: docs/design/provider-billing-attribution-model.md §A — per-(teammate, day)
 * reconciliation of the provider API truth against OTel-captured usage.
 *
 * Executable statement of the owner's confirmed shape: the API is the complete truth;
 * OTel only captures enrolled containers; `unaccounted = max(0, API − OTel)` per day,
 * upserted as ONE taggable record per (teammate, day, tool); recompute is idempotent and
 * PRESERVES the tag (so late OTel just shrinks the delta — never double-counts, never
 * loses a tag the dev applied).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { reconcileUnaccountedUsage } from '../../../server/usage/unaccounted-reconciliation'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let teammateId = ''
let instanceId = ''
let projectId = ''

const WINDOW = { startDate: '2026-06-01', endDate: '2026-06-30' }

async function bill(day: string, costUsd: string, tool = 'claude-code'): Promise<void> {
  // The provider API truth (actual_spend, per teammate-day-tool).
  await t.db.insert(schema.actualSpend).values({
    teammateId,
    date: day,
    tool,
    inputTokens: 0n,
    outputTokens: 0n,
    costUsd,
    source: `api:${randomUUID().slice(0, 8)}`, // distinct sources can coexist; the recon SUMs them
  })
}

async function otel(day: string, costUsd: string, tool = 'claude-code'): Promise<void> {
  // What OTel captured (attribution_record), ts_event at noon UTC on `day`.
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    claudeSessionId: `sess-${randomUUID().slice(0, 8)}`,
    teammateId,
    regionId,
    orgUnitId,
    tool,
    model: 'opus',
    tokenType: 'output',
    tokens: 1000n,
    costUsd,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: new Date(`${day}T12:00:00.000Z`),
    sourceRunId: randomUUID(),
  })
}

async function records(): Promise<Array<{ day: string; tool: string; cost: number; project_id: string | null; activity: string | null }>> {
  const rows = await t.client<{ day: string; tool: string; cost_usd: string; project_id: string | null; activity: string | null }[]>`
    SELECT day::text AS day, tool, cost_usd::text AS cost_usd, project_id::text AS project_id, activity
    FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid ORDER BY day, tool`
  return rows.map((r) => ({ day: r.day, tool: r.tool, cost: Number(r.cost_usd), project_id: r.project_id, activity: r.activity }))
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'ua', displayName: 'UA' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ua', code: 'ua-bu', displayName: 'UA BU', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ua', email: 'ua@example.com', regionId, orgUnitId })
    .returning()
  teammateId = tm!.id
  const [p] = await t.db
    .insert(schema.project)
    .values({ code: 'UA-P', codeHash: 'h-ua-p', displayName: 'UA Project', type: 'billable', regionId, costOwningUnitId: orgUnitId })
    .returning()
  projectId = p!.id
  instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: 'oid-ua',
    teammateId,
    projectCodeHash: 'h-ua',
    rawProjectCode: 'UA',
    tool: 'claude-code',
    tsStart: new Date('2026-06-01T00:00:00.000Z'),
    regionId,
    orgUnitId,
  })
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM attribution_record WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM actual_spend WHERE teammate_id = ${teammateId}::uuid`
})

describe('reconcileUnaccountedUsage (§A)', () => {
  it("the owner's example: API $34, OTel $19 → ONE day record of $15", async () => {
    await bill('2026-06-10', '34.00') // API truth (enrolled $19 + un-enrolled $15)
    await otel('2026-06-10', '19.00') // OTel only saw the enrolled container
    const res = await reconcileUnaccountedUsage(t.db, WINDOW)
    expect(res).toMatchObject({ recordsWithDelta: 1 })
    expect(res.totalUnaccountedUsd).toBeCloseTo(15, 6)
    const rows = await records()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ day: '2026-06-10', tool: 'claude-code', cost: 15, project_id: null })
  })

  it('fully captured (API == OTel) → $0 delta', async () => {
    await bill('2026-06-11', '20.00')
    await otel('2026-06-11', '20.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const rows = await records()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cost).toBe(0) // the row exists but nets to 0 → not "needs tagging"
  })

  it('no OTel at all (un-enrolled all day) → the whole API total is unaccounted', async () => {
    await bill('2026-06-12', '50.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const [row] = await records()
    expect(row!.cost).toBe(50)
  })

  it('floors at 0 when OTel over-estimated (never negative)', async () => {
    await bill('2026-06-13', '10.00')
    await otel('2026-06-13', '15.00') // estimate above the bill
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const [row] = await records()
    expect(row!.cost).toBe(0)
  })

  it('one record PER DAY, never a single lump', async () => {
    await bill('2026-06-14', '40.00'); await otel('2026-06-14', '10.00') // 30
    await bill('2026-06-15', '25.00'); await otel('2026-06-15', '5.00') // 20
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const rows = await records()
    expect(rows.map((r) => [r.day, r.cost])).toEqual([
      ['2026-06-14', 30],
      ['2026-06-15', 20],
    ])
  })

  it('recompute PRESERVES the tag; late OTel shrinks the delta (no double-count, no lost tag)', async () => {
    await bill('2026-06-16', '34.00')
    await otel('2026-06-16', '19.00')
    await reconcileUnaccountedUsage(t.db, WINDOW) // → $15, untagged
    // The developer tags that day's record to a project + activity.
    await t.client`
      UPDATE unaccounted_usage SET project_id = ${projectId}::uuid, activity = 'research', tagged_at = now(), tagged_by = ${teammateId}::uuid
      WHERE teammate_id = ${teammateId}::uuid AND day = '2026-06-16'`
    // Later, OTel for that day catches up by $10 (a previously-un-enrolled container enrolled).
    await otel('2026-06-16', '10.00')
    await reconcileUnaccountedUsage(t.db, WINDOW) // recompute: 34 − 29 = $5
    const [row] = await records()
    expect(row!.cost).toBe(5) // delta shrank
    expect(row!.project_id).toBe(projectId) // TAG preserved
    expect(row!.activity).toBe('research') // activity preserved
  })

  it('is idempotent — a second run with no new data changes nothing', async () => {
    await bill('2026-06-17', '12.00'); await otel('2026-06-17', '4.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const rows = await records()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cost).toBe(8)
  })
})
