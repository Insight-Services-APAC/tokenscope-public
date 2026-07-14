/*
 * Phase E — scale validation for the ledger-retention design. Two theses the
 * epic rests on, asserted on a synthetic multi-month load:
 *   1. Phase C (partitioning): a date-bounded read prunes to the covering
 *      monthly partition(s) — it does NOT scan every partition.
 *   2. Phase A (rollup): the durable rollup's row count is bounded by the GRAIN
 *      (distinct dimension combos × days), so it compresses raw heavily and
 *      stays small as raw grows — the property that makes it a durable
 *      post-retention substrate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runAggregateRollup } from '../../../server/workers/aggregate-rollup'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId = ''
let bu = ''
let proj = ''
const teammates: string[] = []

// 3 cold-ish months spanning 3 distinct monthly partitions, 8 days each, with
// several sessions per (teammate, day). Grain combos are bounded: T teammates ×
// 1 project × 1 tool/model/token_type. Raw rows >> rollup cells by design.
const MONTHS = ['2026-02', '2026-03', '2026-04']
const DAYS = 8
const TEAMMATES = 3
const SESSIONS_PER_DAY = 6

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'sc', displayName: 'R' }).returning()
  regionId = r!.id
  const [b] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'sc.bu', code: 'sc-bu', displayName: 'BU', unitType: 'bu', isCostOwningUnit: true }).returning()
  bu = b!.id
  const [p] = await t.db.insert(schema.project).values({ code: 'P', codeHash: 'h-P', displayName: 'P', type: 'billable', regionId, costOwningUnitId: bu }).returning()
  proj = p!.id
  for (let i = 0; i < TEAMMATES; i++) {
    const [u] = await t.db.insert(schema.teammate).values({ entraOid: `o-${i}`, email: `u${i}@x.com`, regionId, orgUnitId: bu }).returning()
    teammates.push(u!.id)
  }

  // Batch the synthetic load: one instance + one attribution row per session.
  const instRows: (typeof schema.instanceAttestation.$inferInsert)[] = []
  const attrRows: (typeof schema.attributionRecord.$inferInsert)[] = []
  for (const month of MONTHS) {
    for (let d = 1; d <= DAYS; d++) {
      const day = `${month}-${String(d).padStart(2, '0')}T12:00:00.000Z`
      for (const tm of teammates) {
        for (let s = 0; s < SESSIONS_PER_DAY; s++) {
          const instanceId = crypto.randomUUID()
          instRows.push({
            instanceId, principalOid: `oid-${instanceId}`, teammateId: tm,
            projectCodeHash: 'h-P', rawProjectCode: 'P', tool: 'claude-code',
            tsStart: new Date(day), regionId, orgUnitId: bu, costOwningUnitId: bu, attestationState: 'attested',
          })
          attrRows.push({
            instanceId, claudeSessionId: instanceId, teammateId: tm, projectId: proj,
            regionId, orgUnitId: bu, costOwningUnitId: bu, tool: 'claude-code', model: 'opus',
            tokenType: 'output', tokens: 1000n, costUsd: '1.5', fidelityTier: 'tier-1',
            costBasis: 'estimated', tsEvent: new Date(day), querySource: 'main',
          })
        }
      }
    }
  }
  // Chunked inserts keep parameter counts under the protocol limit.
  for (let i = 0; i < instRows.length; i += 200) await t.db.insert(schema.instanceAttestation).values(instRows.slice(i, i + 200))
  for (let i = 0; i < attrRows.length; i += 200) await t.db.insert(schema.attributionRecord).values(attrRows.slice(i, i + 200))
  await runAggregateRollup(t.db, { backfillDays: 400 })
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('ledger scale', () => {
  it('Phase C: a single-month read prunes to that month\'s partition', async () => {
    const rows = await t.client<Record<string, string>[]>`
      EXPLAIN (COSTS OFF) SELECT count(*) FROM attribution_record
      WHERE ts_event >= '2026-03-01' AND ts_event < '2026-04-01'`
    const text = rows.map((r) => r['QUERY PLAN']).join('\n')
    // The covering partition is scanned; the non-covering months are pruned out.
    expect(text).toMatch(/attribution_record_2026_03/)
    expect(text).not.toMatch(/attribution_record_2026_02/)
    expect(text).not.toMatch(/attribution_record_2026_04/)
  })

  it('Phase A: rollup row count is bounded by the grain, not the raw volume', async () => {
    const raw = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM attribution_record`
    const roll = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM spend_rollup_daily`
    const rawN = Number(raw[0]!.n)
    const rollN = Number(roll[0]!.n)

    // Raw = months × days × teammates × sessions.
    expect(rawN).toBe(MONTHS.length * DAYS * TEAMMATES * SESSIONS_PER_DAY)
    // Rollup grain here = months × days × teammates (1 project/tool/model/token_type),
    // so cells == distinct (teammate, day); sessions collapse away entirely.
    expect(rollN).toBe(MONTHS.length * DAYS * TEAMMATES)
    // The compression that makes the rollup a durable substrate.
    expect(rollN).toBeLessThan(rawN)
    expect(rawN / rollN).toBeGreaterThanOrEqual(SESSIONS_PER_DAY)

    // And totals are conserved across the compression.
    const rawCost = await t.client<{ v: string }[]>`SELECT round(sum(cost_usd),2)::text AS v FROM attribution_record`
    const rollCost = await t.client<{ v: string }[]>`SELECT round(sum(total_cost_usd),2)::text AS v FROM spend_rollup_daily`
    expect(rollCost[0]!.v).toBe(rawCost[0]!.v)
  })
})
