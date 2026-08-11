// @vitest-environment node
/*
 * Migration 0116 — a closed month's MONEY cannot move, whatever the write path.
 *
 * 0102 froze the governance VERDICT and left amounts writable. The gap was not
 * theoretical: `upsertActualSpend`'s ON CONFLICT gates two columns behind the
 * close lock and updates cost_usd / input_tokens / output_tokens
 * unconditionally, so a re-poll of a closed month -- routine, since Anthropic
 * revises figures for up to 30 days -- silently rewrote the charge.
 *
 * These tests exercise the guard through RAW SQL rather than through
 * `upsertActualSpend`, deliberately. A guard proven only through the one caller
 * that motivated it proves nothing about the five other writers (copilot-bill's
 * INSERT and its convergence DELETE, the poller's stale-row DELETE,
 * governance-key-backfill's UPDATEs, placement-store's INSERT), and it is the
 * DELETEs that no ON CONFLICT clause could ever have reached.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { closeFinancePeriod, reopenFinancePeriod } from '../../../server/governance/finance-period'
import { upsertActualSpend } from '../../../server/workers/analytics-poller'

let t: TestDb
let regionId: string
let ouId: string
let actorId: string
let teammateId: string

/** A day inside the month under test, and that month's first-of-month key. */
const DAY = '2026-05-14'
const MONTH = '2026-05-01'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'cg-r', displayName: 'CG R' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'cg.svc', code: 'cg-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = ou!.id
  const [fin] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-cg-fin', email: 'cg-fin@x.test', role: 'global-finops', regionId, orgUnitId: ouId })
    .returning()
  actorId = fin!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-cg-dev', email: 'cg-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  teammateId = tm!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  /*
   * ORDER MATTERS, and the reason is the feature. Clearing finance_period
   * first reopens every month; only then can the spend rows be deleted. The
   * reverse order fails against the guard, which is exactly the protection
   * this file exists to prove -- a leftover closed month from a previous test
   * refuses to have its rows removed.
   */
  await t.client`DELETE FROM finance_period`
  await t.client`DELETE FROM actual_spend`
})

/** One spend row for the month under test. Returns its id. */
async function seedSpend(costUsd = '10.0000'): Promise<string> {
  const id = randomUUID()
  await t.client`
    INSERT INTO actual_spend (id, teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source)
    VALUES (${id}::uuid, ${teammateId}::uuid, ${DAY}::date, 'claude-code', 100, 50, ${costUsd}, 'test')
  `
  return id
}

async function close() {
  await t.db.transaction(async (tx) => {
    await closeFinancePeriod(tx as never, { periodMonth: MONTH, actorTeammateId: actorId, reason: 'test close' })
  })
}

describe('0116 — a closed finance period freezes the money, not just the verdict', () => {
  it('refuses an amount-changing UPDATE from ANY writer, not just the poller', async () => {
    const id = await seedSpend()
    await close()
    /*
     * Raw UPDATE, bypassing upsertActualSpend entirely. This is the shape of
     * the defect: the poller re-runs a closed day inside Anthropic's 30-day
     * revision window and overwrites the charge with no error and no audit.
     */
    await expect(
      t.client`UPDATE actual_spend SET cost_usd = '99.0000' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/finance period .* is closed/i)

    const [row] = await t.client`SELECT cost_usd FROM actual_spend WHERE id = ${id}::uuid`
    expect(Number(row!.cost_usd)).toBeCloseTo(10, 4)
  })

  it('refuses a DELETE — the path no ON CONFLICT clause could ever have covered', async () => {
    const id = await seedSpend()
    await close()
    /*
     * Two convergence prunes DELETE from actual_spend (the poller's stale-row
     * prune and copilot-bill's seat prune). Either could erase a closed
     * month's charge. A guard written into the upsert would have left both
     * wide open, which is why this is enforced at the table.
     */
    await expect(
      t.client`DELETE FROM actual_spend WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/finance period .* is closed/i)

    const rows = await t.client`SELECT id FROM actual_spend WHERE id = ${id}::uuid`
    expect(rows.length).toBe(1)
  })

  it('refuses an INSERT into a closed month — late spend is a restatement, not a silent top-up', async () => {
    await close()
    await expect(seedSpend('5.0000')).rejects.toThrow(/finance period .* is closed/i)
    const rows = await t.client`SELECT id FROM actual_spend WHERE date = ${DAY}::date`
    expect(rows.length).toBe(0)
  })

  it('PERMITS a non-amount UPDATE while closed — maintenance is not a restatement', async () => {
    const id = await seedSpend()
    await close()
    /*
     * governance-key-backfill legitimately rewrites governance keys on closed
     * rows. Freezing every column would break it, and would push someone
     * toward disabling the guard rather than working with it. Only the three
     * money columns are frozen.
     */
    await t.client`UPDATE actual_spend SET raw_payload = '{"touched":true}'::jsonb WHERE id = ${id}::uuid`
    const [row] = await t.client`SELECT raw_payload FROM actual_spend WHERE id = ${id}::uuid`
    expect((row!.raw_payload as { touched?: boolean }).touched).toBe(true)
  })

  it('allows everything while the period is OPEN, and an absent row means open', async () => {
    const id = await seedSpend()
    // No finance_period row at all — 0102's convention is that absent = open.
    await t.client`UPDATE actual_spend SET cost_usd = '12.0000' WHERE id = ${id}::uuid`
    const [row] = await t.client`SELECT cost_usd FROM actual_spend WHERE id = ${id}::uuid`
    expect(Number(row!.cost_usd)).toBeCloseTo(12, 4)
    await t.client`DELETE FROM actual_spend WHERE id = ${id}::uuid`
    expect((await t.client`SELECT id FROM actual_spend WHERE id = ${id}::uuid`).length).toBe(0)
  })

  it('reopen releases the freeze WITHOUT the guard needing an exemption for it', async () => {
    const id = await seedSpend()
    await close()
    await expect(
      t.client`UPDATE actual_spend SET cost_usd = '99.0000' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/finance period .* is closed/i)

    await t.db.transaction(async (tx) => {
      await reopenFinancePeriod(tx as never, {
        periodMonth: MONTH,
        actorTeammateId: actorId,
        reason: 'test reopen',
      })
    })

    /*
     * The guard keys on finance_period.state, and reopen sets it to 'open'
     * before touching anything. So the sanctioned correction path passes with
     * no special case in the trigger — which matters because an exemption is a
     * hole a future writer can walk through, while a state check is a rule that
     * forces the audited path.
     */
    await t.client`UPDATE actual_spend SET cost_usd = '99.0000' WHERE id = ${id}::uuid`
    const [row] = await t.client`SELECT cost_usd FROM actual_spend WHERE id = ${id}::uuid`
    expect(Number(row!.cost_usd)).toBeCloseTo(99, 4)
  })

  it('refuses to RE-DATE a row out of a closed month, or into one', async () => {
    /*
     * The subtler hole, and the one a per-column amount check misses entirely:
     * the money never changes, the row just moves. Resolving the guard's month
     * from NEW alone would read the OPEN destination and wave it through,
     * draining the closed month while every amount column stayed untouched.
     * Pointed the other way it is the same defect -- spend appearing inside a
     * month someone has already signed off.
     */
    const closedId = await seedSpend()
    await close()

    // Out of the closed month.
    await expect(
      t.client`UPDATE actual_spend SET date = '2026-06-14'::date WHERE id = ${closedId}::uuid`,
    ).rejects.toThrow(/finance period is closed/i)

    // And into it, from an open month.
    const openId = randomUUID()
    await t.client`
      INSERT INTO actual_spend (id, teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source)
      VALUES (${openId}::uuid, ${teammateId}::uuid, '2026-06-14'::date, 'claude-code', 1, 1, '3.0000', 'test')
    `
    await expect(
      t.client`UPDATE actual_spend SET date = ${DAY}::date WHERE id = ${openId}::uuid`,
    ).rejects.toThrow(/finance period is closed/i)

    // Guard the guard: a move BETWEEN two open months is untouched.
    await t.client`UPDATE actual_spend SET date = '2026-07-14'::date WHERE id = ${openId}::uuid`
    const [row] = await t.client`SELECT date FROM actual_spend WHERE id = ${openId}::uuid`
    expect(String(row!.date)).toContain('2026-07')
  })

  it('lets an UNCHANGED re-poll through the REAL upsert — the guard must not cause an outage', async () => {
    /*
     * The defect this test exists for, and the reason it goes through
     * upsertActualSpend rather than raw SQL.
     *
     * Every production writer is `INSERT ... ON CONFLICT DO UPDATE`. A BEFORE
     * INSERT trigger fires BEFORE Postgres resolves the conflict, so a blanket
     * refusal rejects a routine re-poll of a closed month even when nothing
     * changes. The poller's per-org catch turns that throw into "poll failed"
     * and the org stops writing rows AT ALL -- a guard against silent money
     * movement causing a silent ingestion outage, which is the worse bug.
     *
     * The earlier tests used raw INSERT/UPDATE and were all green while this
     * was broken. That is the whole lesson: exercise the shape production
     * issues, not a convenient approximation of it.
     */
    const agg = {
      teammateId,
      date: DAY,
      tool: 'claude-code',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 10,
      rawPayload: { first: true },
    }
    const gov = {
      key: { providerOrgId: null, providerEnterpriseId: null } as never,
      verdict: { exempt: false, source: 'governance:tracked' } as never,
    }

    await upsertActualSpend(t.db as never, agg as never, 'test-src', gov)
    await close()

    // Same amounts, second time. Must succeed, and must not have moved anything.
    await expect(upsertActualSpend(t.db as never, agg as never, 'test-src', gov)).resolves.toBeDefined()

    const [row] = await t.client`
      SELECT cost_usd FROM actual_spend WHERE teammate_id = ${teammateId}::uuid AND date = ${DAY}::date AND source = 'test-src'
    `
    expect(Number(row!.cost_usd)).toBeCloseTo(10, 4)
  })

  it('still refuses a re-poll through the REAL upsert when the amount CHANGED', async () => {
    /*
     * Guard the guard: letting conflict-updates through must not become
     * letting everything through. This is the case the whole migration exists
     * for -- a provider revision inside Anthropic's 30-day window rewriting a
     * signed-off charge.
     */
    const base = {
      teammateId,
      date: DAY,
      tool: 'claude-code',
      inputTokens: 100,
      outputTokens: 50,
      rawPayload: {},
    }
    const gov = {
      key: { providerOrgId: null, providerEnterpriseId: null } as never,
      verdict: { exempt: false, source: 'governance:tracked' } as never,
    }

    await upsertActualSpend(t.db as never, { ...base, costUsd: 10 } as never, 'test-src', gov)
    await close()

    /*
     * Drizzle wraps the PostgresError as "Failed query: INSERT ...", so the
     * guard's own message lives on `cause`. Asserting the wrapper alone would
     * pass for ANY query failure -- including one caused by a broken fixture --
     * so this reaches through to the reason.
     */
    const err = await upsertActualSpend(t.db as never, { ...base, costUsd: 77 } as never, 'test-src', gov).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    const reason = `${(err as Error).message} ${String((err as { cause?: unknown }).cause ?? '')}`
    expect(reason).toMatch(/finance period .* is closed/i)

    const [row] = await t.client`
      SELECT cost_usd FROM actual_spend WHERE teammate_id = ${teammateId}::uuid AND date = ${DAY}::date AND source = 'test-src'
    `
    expect(Number(row!.cost_usd)).toBeCloseTo(10, 4)
  })

  it('refuses TRUNCATE while any period is closed', async () => {
    await seedSpend()
    await close()
    await expect(t.client`TRUNCATE actual_spend`).rejects.toThrow(/refusing to TRUNCATE/i)
  })

  it('freezes a closed month only — a neighbouring open month is untouched', async () => {
    /*
     * Guard the guard: without this, a trigger that refused EVERY write would
     * pass every test above while breaking the entire product.
     */
    const closedId = await seedSpend()
    const openId = randomUUID()
    await t.client`
      INSERT INTO actual_spend (id, teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source)
      VALUES (${openId}::uuid, ${teammateId}::uuid, '2026-06-14'::date, 'claude-code', 1, 1, '7.0000', 'test')
    `
    await close()

    await expect(
      t.client`UPDATE actual_spend SET cost_usd = '99.0000' WHERE id = ${closedId}::uuid`,
    ).rejects.toThrow(/finance period .* is closed/i)

    await t.client`UPDATE actual_spend SET cost_usd = '8.0000' WHERE id = ${openId}::uuid`
    const [row] = await t.client`SELECT cost_usd FROM actual_spend WHERE id = ${openId}::uuid`
    expect(Number(row!.cost_usd)).toBeCloseTo(8, 4)
  })
})
