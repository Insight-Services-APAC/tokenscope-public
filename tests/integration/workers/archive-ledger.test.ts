/*
 * Phase D — archive-ledger worker. Verifies the safety invariants: OFF by
 * default; never drop a cold partition unless the durable rollup reconciles AND
 * the export verifies; the rollup cells SURVIVE the raw drop; hot partitions are
 * untouched.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runAggregateRollup } from '../../../server/workers/aggregate-rollup'
import { runArchiveLedger, type PartitionExporter } from '../../../server/workers/archive-ledger'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId = ''
let bu = ''
let proj = ''
let tm = ''

// 2026-04 is cold (>30d before the real clock used by the worker) but within the
// rollup's 90-day backfill; 2026-06-10 is hot. (Test relies on now() > ~2026-06.)
const COLD = '2026-04-15T12:00:00.000Z'
const HOT = '2026-06-10T12:00:00.000Z'

async function emit(day: string, cost: string): Promise<void> {
  const instanceId = crypto.randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId, principalOid: `oid-${instanceId}`, teammateId: tm,
    projectCodeHash: 'h-P', rawProjectCode: 'P', tool: 'claude-code',
    tsStart: new Date(day), regionId, orgUnitId: bu, costOwningUnitId: bu, attestationState: 'attested',
  })
  await t.db.insert(schema.attributionRecord).values({
    instanceId, claudeSessionId: instanceId, teammateId: tm, projectId: proj,
    regionId, orgUnitId: bu, costOwningUnitId: bu, tool: 'claude-code', model: 'opus',
    tokenType: 'output', tokens: 1000n, costUsd: cost, fidelityTier: 'tier-1',
    costBasis: 'estimated', tsEvent: new Date(day), querySource: 'main',
  })
}

const partExists = async (name: string): Promise<boolean> => {
  const r = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM pg_class WHERE relname = ${name}`
  return Number(r[0]?.n ?? 0) > 0
}
const okExporter: PartitionExporter = async (_db, part) => ({ rowsExported: part.rows })

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'ar', displayName: 'R' }).returning()
  regionId = r!.id
  const [b] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'ar.bu', code: 'ar-bu', displayName: 'BU', unitType: 'bu', isCostOwningUnit: true }).returning()
  bu = b!.id
  const [p] = await t.db.insert(schema.project).values({ code: 'P', codeHash: 'h-P', displayName: 'P', type: 'billable', regionId, costOwningUnitId: bu }).returning()
  proj = p!.id
  const [u] = await t.db.insert(schema.teammate).values({ entraOid: 'o-u', email: 'u@x.com', regionId, orgUnitId: bu }).returning()
  tm = u!.id
  await emit(COLD, '12')
  await emit(COLD, '8') // cold month total 20
  await emit(HOT, '5')
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  // Rebuild the rollup before each test (some tests mutate it).
  await runAggregateRollup(t.db, { backfillDays: 400 })
})

describe('runArchiveLedger', () => {
  it('is OFF by default — no-op', async () => {
    const r = await runArchiveLedger(t.db)
    expect(r.enabled).toBe(false)
    expect(r.archived).toEqual([])
    expect(await partExists('attribution_record_2026_04')).toBe(true)
  })

  it('skips (does NOT drop) when the export fails', async () => {
    const failing: PartitionExporter = async () => {
      throw new Error('boom')
    }
    const r = await runArchiveLedger(t.db, { enabled: true, hotDays: 30, exporter: failing })
    expect(r.archived).toEqual([])
    expect(r.skipped.some((s) => s.name === 'attribution_record_2026_04')).toBe(true)
    expect(await partExists('attribution_record_2026_04')).toBe(true) // not dropped
  })

  it('skips when the rollup does not reconcile (measure mismatch — review M3)', async () => {
    // Corrupt the rollup coverage for the cold month, then archive: must skip.
    await t.client`DELETE FROM spend_rollup_daily WHERE period_start >= '2026-04-01' AND period_start < '2026-05-01'`
    const r = await runArchiveLedger(t.db, { enabled: true, hotDays: 30, exporter: okExporter })
    expect(r.archived).toEqual([])
    expect(r.skipped.some((s) => s.name === 'attribution_record_2026_04' && /mismatch/.test(s.reason))).toBe(true)
    expect(await partExists('attribution_record_2026_04')).toBe(true)
  })

  it('fail-closed: the env-driven path refuses a freeze-floor SMALLER than the hot window', async () => {
    // floor >= hot is required so a still-mutable month keeps being recomputed
    // (re-tags) until it archives; floor < hot would bake stale attribution.
    const saved = { ...process.env }
    try {
      process.env.LEDGER_ARCHIVE_ENABLED = 'true'
      process.env.LEDGER_HOT_DAYS = '30'
      process.env.LEDGER_ROLLUP_FREEZE_FLOOR_DAYS = '10' // < hot => unsafe
      await expect(runArchiveLedger(t.db)).rejects.toThrow(/freeze-floor .* >= hot window/)
      // floor == hot passes the guard; the default exporter then fails closed and
      // SKIPS (it does not throw on the floor check).
      process.env.LEDGER_ROLLUP_FREEZE_FLOOR_DAYS = '30'
      const r = await runArchiveLedger(t.db)
      expect(r.archived).toEqual([])
      expect(r.skipped.length).toBeGreaterThan(0)
    } finally {
      process.env = saved
    }
  })

  it('archives a verified cold partition: raw dropped, rollup survives, hot untouched', async () => {
    const coldRollupBefore = await t.client<{ v: string }[]>`SELECT round(sum(total_cost_usd),2)::text AS v FROM spend_rollup_daily WHERE period_start >= '2026-04-01' AND period_start < '2026-05-01'`
    expect(Number(coldRollupBefore[0]!.v)).toBe(20)

    const r = await runArchiveLedger(t.db, { enabled: true, hotDays: 30, exporter: okExporter })
    expect(r.archived).toContain('attribution_record_2026_04')

    // raw cold partition is gone
    expect(await partExists('attribution_record_2026_04')).toBe(false)
    const rawCold = await t.client<{ v: string }[]>`SELECT count(*)::text AS v FROM attribution_record WHERE ts_event >= '2026-04-01' AND ts_event < '2026-05-01'`
    expect(Number(rawCold[0]!.v)).toBe(0)
    // durable rollup SURVIVES the raw drop
    const coldRollupAfter = await t.client<{ v: string }[]>`SELECT round(sum(total_cost_usd),2)::text AS v FROM spend_rollup_daily WHERE period_start >= '2026-04-01' AND period_start < '2026-05-01'`
    expect(Number(coldRollupAfter[0]!.v)).toBe(20)
    // hot data untouched
    const rawHot = await t.client<{ v: string }[]>`SELECT round(sum(cost_usd),2)::text AS v FROM attribution_record WHERE ts_event >= '2026-06-01'`
    expect(Number(rawHot[0]!.v)).toBe(5)
  })
})
