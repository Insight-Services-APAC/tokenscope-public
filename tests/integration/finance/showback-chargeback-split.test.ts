// @vitest-environment node
/*
 * Intent: ADR-0010 rules 3 & 5 (mig 0073) + reporting-consolidation Wave 0 (mig 0081).
 *
 * SHOWBACK shows ALL genuine cost (incl. NFR/exempt); CHARGEBACK excludes it. TWO exclusions
 * apply to v_finance_bill_chargeback now:
 *   1. chargeback_exempt rows (the per-row flag) — the single place exempt cost is excluded.
 *   2. tool='copilot-cli' rows (Wave 0 / canonical §B) — the per-seat Copilot showback rows are
 *      display-only; the Copilot CHARGEBACK is POOLED and lives in copilot_pool_bill, so NO
 *      copilot actual_spend row is a chargeback figure. v_finance_bill_showback keeps them.
 *
 * If a future change re-hides exempt cost from showback, leaks exempt cost into chargeback, or
 * lets a per-seat copilot row back into the chargeback lane, THIS test fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId = ''
let couId = ''

const DAY = '2026-06-10'

async function mkTeammate(suffix: string): Promise<string> {
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-split-${suffix}-${randomUUID().slice(0, 8)}`,
      email: `${suffix}.${randomUUID().slice(0, 8)}@example.com`,
      regionId,
      orgUnitId: couId,
    })
    .returning({ id: schema.teammate.id })
  return tm!.id
}

async function bill(
  teammateId: string,
  costUsd: string,
  opts: { source: string; exempt: boolean; tool?: string },
): Promise<void> {
  await t.db.insert(schema.actualSpend).values({
    teammateId,
    date: DAY,
    tool: opts.tool ?? 'copilot-cli',
    inputTokens: 0n,
    outputTokens: 0n,
    costUsd,
    source: opts.source,
    chargebackExempt: opts.exempt,
  })
}

async function lanes(teammateId: string): Promise<{ showback: number; chargeback: number }> {
  const [sb] = await t.client<{ u: string }[]>`
    SELECT COALESCE(SUM(bill_usd), 0)::text AS u FROM v_finance_bill_showback WHERE teammate_id = ${teammateId}::uuid`
  const [cb] = await t.client<{ u: string }[]>`
    SELECT COALESCE(SUM(bill_usd), 0)::text AS u FROM v_finance_bill_chargeback WHERE teammate_id = ${teammateId}::uuid`
  return { showback: Number(sb!.u), chargeback: Number(cb!.u) }
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'split', displayName: 'Split' }).returning()
  regionId = r!.id
  const [co] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'split', code: 'split-co', displayName: 'CoU', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  couId = co!.id
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('ADR-0010 showback vs chargeback split', () => {
  it('a NON-exempt per-seat COPILOT row: showback shows it, chargeback does NOT (pooled chargeback lives in copilot_pool_bill)', async () => {
    const tm = await mkTeammate('chargeable')
    await bill(tm, '39.00', { source: 'copilot-seat:acme', exempt: false })
    const l = await lanes(tm)
    expect(l.showback).toBe(39) // showback (display) keeps the per-seat row
    expect(l.chargeback).toBe(0) // Wave 0: copilot-cli is NOT a chargeback operand
  })

  it('an EXEMPT copilot row appears in showback but is EXCLUDED from chargeback (doubly, now)', async () => {
    const tm = await mkTeammate('exempt')
    await bill(tm, '39.00', { source: 'copilot-seat:demo-co', exempt: true })
    const l = await lanes(tm)
    expect(l.showback).toBe(39) // rule 3: showback shows ALL genuine cost
    expect(l.chargeback).toBe(0) // excluded (exempt AND copilot-cli)
  })

  it('a teammate with copilot in BOTH a billed and an exempt org: showback sees both, chargeback sees none', async () => {
    const tm = await mkTeammate('mixed')
    await bill(tm, '39.00', { source: 'copilot-seat:acme', exempt: false }) // billed org
    await bill(tm, '39.00', { source: 'copilot-seat:demo-co', exempt: true }) // exempt org
    const l = await lanes(tm)
    expect(l.showback).toBe(78) // sees both orgs' cost
    expect(l.chargeback).toBe(0) // copilot per-seat rows never charge (pooled → copilot_pool_bill)
  })

  it('Anthropic-style rows (claude-code, exempt=false) are unchanged: both lanes equal', async () => {
    const tm = await mkTeammate('anthropic')
    await bill(tm, '123.45', { source: 'anthropic-analytics-api', exempt: false, tool: 'claude-code' })
    const l = await lanes(tm)
    expect(l.showback).toBe(123.45)
    expect(l.chargeback).toBe(123.45)
  })
})
