/*
 * Phase E — finance cold-fallback. After archive-ledger DROPs a cold partition,
 * v_effective_spend / v_finance_reportable_spend must still return that period's
 * spend, now served from the durable rollup (spend_rollup_daily), with:
 *   - totals byte-identical to the pre-archive raw answer,
 *   - the estimated|indicative split preserved (advisory cost stays OUT of the
 *     finance-reportable view), and
 *   - cold rows marked source='rollup'.
 * The boundary is data-derived, so before any archive the views are unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runAggregateRollup } from '../../../server/workers/aggregate-rollup'
import { runArchiveLedger, type PartitionExporter } from '../../../server/workers/archive-ledger'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId = ''
let bu = ''
let proj = ''
let tm = ''

const COLD = '2026-04-15T12:00:00.000Z'
const HOT = '2026-06-10T12:00:00.000Z'

const okExporter: PartitionExporter = async (_db, part) => ({ rowsExported: part.rows })

async function emit(day: string, cost: string, basis: 'estimated' | 'telemetry-only'): Promise<void> {
  const instanceId = crypto.randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId, principalOid: `oid-${instanceId}`, teammateId: tm,
    projectCodeHash: 'h-P', rawProjectCode: 'P', tool: 'claude-code',
    tsStart: new Date(day), regionId, orgUnitId: bu, costOwningUnitId: bu, attestationState: 'attested',
  })
  await t.db.insert(schema.attributionRecord).values({
    instanceId, claudeSessionId: instanceId, teammateId: tm, projectId: proj,
    regionId, orgUnitId: bu, costOwningUnitId: bu, tool: 'claude-code', model: 'opus',
    tokenType: 'output', tokens: 1000n, costUsd: cost,
    fidelityTier: basis === 'estimated' ? 'tier-1' : 'tier-2',
    costBasis: basis, tsEvent: new Date(day), querySource: 'main',
  })
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'cf', displayName: 'R' }).returning()
  regionId = r!.id
  const [b] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'cf.bu', code: 'cf-bu', displayName: 'BU', unitType: 'bu', isCostOwningUnit: true }).returning()
  bu = b!.id
  const [p] = await t.db.insert(schema.project).values({ code: 'P', codeHash: 'h-P', displayName: 'P', type: 'billable', regionId, costOwningUnitId: bu }).returning()
  proj = p!.id
  const [u] = await t.db.insert(schema.teammate).values({ entraOid: 'o-cf', email: 'cf@x.com', regionId, orgUnitId: bu }).returning()
  tm = u!.id
  // BILL-ANCHORED (mig 0059): v_finance_reportable_spend is gate-free again (the
  // earlier coverage gate is gone). This suite exercises the cold-ROLLUP fallback
  // of v_effective_spend / v_finance_reportable_spend, unchanged by the finance
  // re-architecture, so no coverage setup is needed.
  // Cold month: 12 + 8 estimated (=20) + 7 advisory (telemetry-only).
  await emit(COLD, '12', 'estimated')
  await emit(COLD, '8', 'estimated')
  await emit(COLD, '7', 'telemetry-only')
  // Hot month: 5 estimated.
  await emit(HOT, '5', 'estimated')
  await runAggregateRollup(t.db, { backfillDays: 400 })
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

const finance = () => t.client<{ v: string }[]>`SELECT COALESCE(round(sum(cost_usd),2),0)::text AS v FROM v_finance_reportable_spend`
const effective = () => t.client<{ v: string }[]>`SELECT COALESCE(round(sum(cost_usd),2),0)::text AS v FROM v_effective_spend`
const effectiveTokens = () => t.client<{ v: string }[]>`SELECT COALESCE(sum(tokens),0)::text AS v FROM v_effective_spend`
const coldFromRollup = () => t.client<{ v: string }[]>`SELECT count(*)::text AS v FROM v_effective_spend WHERE source = 'rollup'`

describe('v_effective_spend cold-fallback', () => {
  it('before any archive: views read raw only (no rollup branch active)', async () => {
    // finance-reportable excludes the 7 advisory => 20 cold + 5 hot = 25
    expect(Number((await finance())[0]!.v)).toBe(25)
    // effective includes advisory => 20 + 7 + 5 = 32
    expect(Number((await effective())[0]!.v)).toBe(32)
    // nothing served from the rollup yet — boundary = oldest raw
    expect(Number((await coldFromRollup())[0]!.v)).toBe(0)
  })

  it('after archiving the cold partition: same totals, cold now from the rollup, split preserved', async () => {
    const tokensBefore = Number((await effectiveTokens())[0]!.v)

    const r = await runArchiveLedger(t.db, { enabled: true, hotDays: 30, exporter: okExporter })
    expect(r.archived).toContain('attribution_record_2026_04')

    // raw cold is gone...
    const rawCold = await t.client<{ v: string }[]>`SELECT count(*)::text AS v FROM attribution_record WHERE ts_event < '2026-05-01'`
    expect(Number(rawCold[0]!.v)).toBe(0)

    // ...but finance totals are unchanged (cold 20 now served from the rollup)
    expect(Number((await finance())[0]!.v)).toBe(25)
    expect(Number((await effective())[0]!.v)).toBe(32)
    // tokens preserved across the raw->rollup handover
    expect(Number((await effectiveTokens())[0]!.v)).toBe(tokensBefore)

    // the cold rows are now sourced from the rollup; hot stays raw
    expect(Number((await coldFromRollup())[0]!.v)).toBeGreaterThan(0)
    const hotRollup = await t.client<{ v: string }[]>`SELECT count(*)::text AS v FROM v_effective_spend WHERE source = 'rollup' AND occurred_at >= '2026-06-01'`
    expect(Number(hotRollup[0]!.v)).toBe(0)

    // the advisory 7 is in effective but NOT in finance-reportable, even cold
    const coldAdvisoryInFinance = await t.client<{ v: string }[]>`SELECT COALESCE(round(sum(cost_usd),2),0)::text AS v FROM v_finance_reportable_spend WHERE source = 'rollup' AND spend_class = 'indicative'`
    expect(Number(coldAdvisoryInFinance[0]!.v)).toBe(0)

    // the worker advanced the archive watermark to the dropped month's end
    const wm = await t.client<{ v: string | null }[]>`SELECT to_char(archived_through AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS v FROM ledger_archive_state WHERE id = 'singleton'`
    expect(wm[0]!.v).toBe('2026-05-01')
  })

  it('C1 regression: a stray row for the dropped month does not make it vanish', async () => {
    // After April is archived, a late/replayed April row routes to the DEFAULT
    // partition. A live-min boundary would snap back to April and exclude its
    // whole rollup; the watermark gates the raw branch (ts_event >= watermark)
    // so the stray row is simply excluded and April stays served from the rollup.
    await emit(COLD, '999', 'estimated')

    // totals unchanged — the stray 999 is NOT counted, April still = 20 from rollup
    expect(Number((await finance())[0]!.v)).toBe(25)
    expect(Number((await effective())[0]!.v)).toBe(32)
    // and the raw cold row exists physically (in DEFAULT) but is filtered out
    const rawCold = await t.client<{ v: string }[]>`SELECT count(*)::text AS v FROM attribution_record WHERE ts_event < '2026-05-01'`
    expect(Number(rawCold[0]!.v)).toBe(1)
  })
})
