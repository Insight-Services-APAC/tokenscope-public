// @vitest-environment node
/*
 * Reconciliation engine — conflict-key aggregation (ING-4, robustness review
 * 2026-06-09). Two ReconciledLines colliding on the proposed-record key
 * (provider, enterprise_ref, period_date, category, scope, teammate) previously
 * REPLACED each other via the DO UPDATE upsert — and each was classified against
 * the full-day OTel operand, producing nonsense deltas. They must SUM first.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReconcileEngine } from '../../../server/reconciliation/engine'
import type { ReconciledLine } from '../../../server/reconciliation/types'

let t: TestDb
let teammateId = ''
const NOW = new Date('2026-06-08T12:00:00.000Z')

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'apac-ag', 'APAC')`
  const [region] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'apac-ag'`
  await t.client`
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
    VALUES (gen_random_uuid(), ${region!.id}, 'apac.ag', 'ag-bu', 'AG BU', 'bu')`
  const [org] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code = 'ag-bu'`
  await t.client`
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
    VALUES (gen_random_uuid(), 'oid-ag', 'ag@example.com', ${region!.id}, ${org!.id})`
  const [tm] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-ag'`
  teammateId = tm!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  await t.client`DELETE FROM reconciliation_record`
})

function line(over: Partial<ReconciledLine> = {}): ReconciledLine {
  return {
    provider: 'anthropic',
    enterpriseRef: 'org-ag',
    licenseOrg: null,
    periodDate: '2026-06-08',
    subject: { kind: 'teammate', teammateId },
    category: 'model_tokens',
    unit: { quantity: 1000, unitType: 'tokens' },
    rateUsdPerUnit: '0',
    amountUsd: '5.00',
    spendClass: 'estimated',
    raw: { test: true },
    ...over,
  }
}

describe('runReconcileEngine — aggregate by conflict key (ING-4)', () => {
  it('two same-key lines SUM into one record, not clobber', async () => {
    const r = await runReconcileEngine(
      t.db,
      [
        line({ amountUsd: '5.00', unit: { quantity: 1000, unitType: 'tokens' }, raw: { sku: 'api' } }),
        line({ amountUsd: '2.50', unit: { quantity: 500, unitType: 'tokens' }, raw: { sku: 'subscription' } }),
      ],
      { now: NOW },
    )
    expect(r.linesProcessed).toBe(2)
    expect(r.recordsWritten).toBe(1) // ONE merged record

    const rows = await t.client<{ actual_usd: string; actual_qty: string; raw: unknown }[]>`
      SELECT actual_usd::text AS actual_usd, actual_qty::text AS actual_qty, raw
      FROM reconciliation_record`
    expect(rows.length).toBe(1)
    expect(Number(rows[0]!.actual_usd)).toBeCloseTo(7.5, 6) // 5.00 + 2.50, not 2.50
    expect(Number(rows[0]!.actual_qty)).toBeCloseTo(1500, 6)
    expect(Array.isArray(rows[0]!.raw)).toBe(true) // both contributors preserved
  })

  it('distinct keys still write distinct records', async () => {
    const r = await runReconcileEngine(
      t.db,
      [line({ periodDate: '2026-06-07' }), line({ periodDate: '2026-06-08' })],
      { now: NOW },
    )
    expect(r.recordsWritten).toBe(2)
  })

  it('an invalid line is rejected without poisoning its valid same-key sibling', async () => {
    const r = await runReconcileEngine(
      t.db,
      [line({ amountUsd: 'not-a-number' }), line({ amountUsd: '3.00' })],
      { now: NOW },
    )
    expect(r.skippedInvalid).toBe(1)
    expect(r.recordsWritten).toBe(1)
    const rows = await t.client<{ actual_usd: string }[]>`
      SELECT actual_usd::text AS actual_usd FROM reconciliation_record`
    expect(Number(rows[0]!.actual_usd)).toBeCloseTo(3, 6)
  })
})
