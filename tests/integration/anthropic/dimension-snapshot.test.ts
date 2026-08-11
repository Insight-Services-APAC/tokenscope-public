// @vitest-environment node
/*
 * Historical-homing dimension snapshot (mig 0101, Workstream A §3.1 "Historical
 * homing uses source snapshots, with an explicit legacy fallback").
 *
 * Two things this suite proves against the REAL writer path
 * (runEnterpriseAnalyticsPoll — the same function production polls run), not a
 * private helper:
 *
 *   1. A NEW actual_spend row is stamped with the teammate's CURRENT placement
 *      at write time, labelled 'ingest-snapshot'.
 *   2. An EXISTING row's snapshot is STABLE across a later re-poll of the same
 *      day, even after the teammate has been reorganised — a re-poll only
 *      refreshes cost/tokens/raw_payload, never the dimension snapshot,
 *      because that snapshot is the ON CONFLICT DO UPDATE SET list's
 *      deliberate omission (server/reconciliation/dimension-snapshot.ts).
 *
 * A THIRD test re-executes migration 0101's own backfill UPDATE (extracted
 * verbatim from the migration file, not re-implemented) against a row whose
 * dimension columns have been reset to NULL — the exact state a pre-0101 row
 * would have had before the migration's one-time backfill ran — and asserts
 * the 'legacy-current-placement' label and correct values. Re-executing the
 * FILE'S OWN SQL (rather than a hand-copied approximation) means this test can
 * never drift from what the migration actually does.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runEnterpriseAnalyticsPoll } from '../../../server/workers/analytics-poller'
import type { AnthropicEnterpriseClient } from '../../../server/anthropic/enterprise-client'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let orgA: string
let orgB: string
let teammateId: string

const EMAIL = 'reorg@dimension-snapshot.test'

const actor = () => ({ type: 'user_actor', email: EMAIL, deleted: false })
const usageRow = (inTok: number, outTok: number) => ({
  actor: actor(),
  product: 'claude_code',
  model: 'claude-sonnet-4-6',
  uncached_input_tokens: inTok,
  output_tokens: outTok,
  total_tokens: inTok + outTok,
})
const costRow = (cents: string) => ({ actor: actor(), currency: 'USD', amount: cents, cost_type: 'tokens', product: 'claude_code' })

function fakeClient(byDay: Record<string, { usage: unknown[]; cost: unknown[] }>): AnthropicEnterpriseClient {
  const day = (s: string) => s.slice(0, 10)
  return {
    getUserUsageReport: async ({ startingAt }: { startingAt: string }) => ({
      has_more: false,
      next_page: null,
      data: byDay[day(startingAt)]?.usage ?? [],
    }),
    getUserCostReport: async ({ startingAt }: { startingAt: string }) => ({
      has_more: false,
      next_page: null,
      data: byDay[day(startingAt)]?.cost ?? [],
    }),
  } as unknown as AnthropicEnterpriseClient
}

async function dims(day: string): Promise<{
  region_id: string | null
  org_unit_id: string | null
  cost_owning_unit_id: string | null
  dimension_source: string | null
  cost_usd: string
} | null> {
  const rows = await t.client<{
    region_id: string | null
    org_unit_id: string | null
    cost_owning_unit_id: string | null
    dimension_source: string | null
    cost_usd: string
  }[]>`
    SELECT region_id::text AS region_id, org_unit_id::text AS org_unit_id,
           cost_owning_unit_id::text AS cost_owning_unit_id, dimension_source,
           cost_usd::text AS cost_usd
    FROM actual_spend
    WHERE teammate_id = ${teammateId}::uuid AND date = ${day}::date AND tool = 'claude-code'`
  return rows[0] ?? null
}

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.db.insert(schema.region).values({ code: 'dimsnap', displayName: 'Dimension Snapshot' }).returning()
  regionId = region!.id
  const [a] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'dimsnap.a', code: 'dimsnap-a', displayName: 'Dimsnap A', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgA = a!.id
  const [b] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'dimsnap.b', code: 'dimsnap-b', displayName: 'Dimsnap B', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgB = b!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-dimsnap', email: EMAIL, regionId, orgUnitId: orgA })
    .returning()
  teammateId = tm!.id
}, 120_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('actual_spend dimension snapshot — writer stability across a reorg', () => {
  it('a NEW row is stamped with the CURRENT placement at write time (ingest-snapshot)', async () => {
    const client = fakeClient({ '2026-08-01': { usage: [usageRow(1000, 500)], cost: [costRow('500')] } })
    await runEnterpriseAnalyticsPoll(t.db, client, {
      startingAt: '2026-08-01',
      endingAt: '2026-08-01',
      externalOrgId: 'dimsnap-org',
    })

    const row = await dims('2026-08-01')
    expect(row).not.toBeNull()
    expect(row!.region_id).toBe(regionId)
    expect(row!.org_unit_id).toBe(orgA)
    expect(row!.cost_owning_unit_id).toBe(orgA)
    expect(row!.dimension_source).toBe('ingest-snapshot')
  })

  it('a REORG changes where a NEW day snapshots to — but a re-poll of the OLD day keeps its ORIGINAL snapshot', async () => {
    // Reorg: move the teammate from org A to org B.
    await t.client`UPDATE teammate SET org_unit_id = ${orgB}::uuid WHERE id = ${teammateId}::uuid`

    // A genuinely NEW day polled after the reorg snapshots the teammate's
    // CURRENT (post-reorg) placement — org B.
    const clientNewDay = fakeClient({ '2026-08-02': { usage: [usageRow(2000, 1000)], cost: [costRow('700')] } })
    await runEnterpriseAnalyticsPoll(t.db, clientNewDay, {
      startingAt: '2026-08-02',
      endingAt: '2026-08-02',
      externalOrgId: 'dimsnap-org',
    })
    const newDayRow = await dims('2026-08-02')
    expect(newDayRow!.org_unit_id).toBe(orgB)
    expect(newDayRow!.dimension_source).toBe('ingest-snapshot')

    // Re-poll the OLD day (08-01) with a revised cost, simulating a late
    // correction. The snapshot must NOT move to org B — it stays fixed at
    // whatever it was captured as on the FIRST write, org A.
    const clientRepoll = fakeClient({ '2026-08-01': { usage: [usageRow(1000, 500)], cost: [costRow('550')] } })
    await runEnterpriseAnalyticsPoll(t.db, clientRepoll, {
      startingAt: '2026-08-01',
      endingAt: '2026-08-01',
      externalOrgId: 'dimsnap-org',
    })
    const oldDayRow = await dims('2026-08-01')
    expect(Number(oldDayRow!.cost_usd)).toBeCloseTo(5.5, 6) // cost DID refresh
    expect(oldDayRow!.org_unit_id).toBe(orgA) // dimension snapshot did NOT move
    expect(oldDayRow!.cost_owning_unit_id).toBe(orgA)
    expect(oldDayRow!.dimension_source).toBe('ingest-snapshot') // unchanged label too
  })
})

describe('migration 0101 backfill — re-executed verbatim from the migration file', () => {
  const MIGRATION = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'drizzle',
    'migrations',
    '0101_usage_completeness_ingest_only_arm.sql',
  )

  /** Extract the exact backfill UPDATE statement between its two stable
   *  anchors, so this test can never drift from what the migration runs. */
  function extractBackfillSql(): string {
    const raw = readFileSync(MIGRATION, 'utf8')
    const start = raw.indexOf('UPDATE actual_spend a')
    const end = raw.indexOf('COMMENT ON COLUMN actual_spend.dimension_source')
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('migration 0101: could not locate the backfill UPDATE block between its anchors')
    }
    return raw.slice(start, end)
  }

  it("labels a pre-existing (dimension_source IS NULL) row 'legacy-current-placement', backfilled from the teammate's CURRENT placement", async () => {
    // Simulate "a row that predates the 0101 columns": every column this
    // migration adds is nullable, so resetting them to NULL on an
    // already-migrated row is indistinguishable, for this UPDATE's purposes,
    // from a row that has never been touched by it.
    await t.client`
      INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source)
      VALUES (${teammateId}::uuid, '2026-01-15'::date, 'claude-code', 1000, 1000, 12.5, 'legacy-backfill-test')`
    // teammate is currently homed to org B (the reorg above) — the backfill
    // must record THAT placement, since it has no historical evidence.
    await t.client.unsafe(extractBackfillSql())

    const rows = await t.client<{
      region_id: string | null
      org_unit_id: string | null
      cost_owning_unit_id: string | null
      dimension_source: string | null
    }[]>`
      SELECT region_id::text AS region_id, org_unit_id::text AS org_unit_id,
             cost_owning_unit_id::text AS cost_owning_unit_id, dimension_source
      FROM actual_spend
      WHERE teammate_id = ${teammateId}::uuid AND date = '2026-01-15'::date AND source = 'legacy-backfill-test'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.region_id).toBe(regionId)
    expect(rows[0]!.org_unit_id).toBe(orgB) // current placement — no historical evidence exists
    expect(rows[0]!.cost_owning_unit_id).toBe(orgB)
    expect(rows[0]!.dimension_source).toBe('legacy-current-placement')
  })

  it('is idempotent / non-destructive: a row that ALREADY has a dimension_source is left untouched (WHERE a.dimension_source IS NULL)', async () => {
    // A genuine 'ingest-snapshot' row from the writer-stability suite above
    // (08-01, still homed to org A) must not be silently reclassified as
    // 'legacy-current-placement' by re-running the backfill.
    const before = await dims('2026-08-01')
    await t.client.unsafe(extractBackfillSql())
    const after = await dims('2026-08-01')
    expect(after).toEqual(before)
    expect(after!.dimension_source).toBe('ingest-snapshot')
  })
})
