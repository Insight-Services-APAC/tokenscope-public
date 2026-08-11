// @vitest-environment node
/*
 * finance_period — close/reopen/restate (design §4.1/§8.4). Covers §9's:
 *   - open billing edit changes B; closed edit does not
 *   - concurrent close/recompute serialization
 *   - reopen/restatement audited
 *   - unresolved never chargeable but showback-visible
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { closeFinancePeriod, reopenFinancePeriod, restateFinancePeriod, FinancePeriodError } from '../../../server/governance/finance-period'
import { recomputeGovernanceVerdicts } from '../../../server/governance/recompute'
import { activateGovernanceCutover, preflightGovernanceCutover } from '../../../server/governance/cutover'

let t: TestDb
let regionId: string
let ouId: string
let financeActorId: string
let teammateId: string
let anthOrgId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'fp-r', displayName: 'FP R' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'fp.svc', code: 'fp-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = ou!.id
  const [finActor] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-fp-fin', email: 'fp-fin@x.test', role: 'global-finops', regionId, orgUnitId: ouId })
    .returning()
  financeActorId = finActor!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-fp-dev', email: 'fp-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  teammateId = tm!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

const PERIOD_MONTH = '2026-05'
const PERIOD_DATE = '2026-05-15'

beforeEach(async () => {
  await t.client`DELETE FROM finance_period`
  await t.client`UPDATE governance_cutover_state SET status = 'not_started', preflight_snapshot = NULL, preflight_verified_at = NULL, preflight_verified_by = NULL, activated_at = NULL, activated_by = NULL, rolled_back_at = NULL, rolled_back_by = NULL WHERE id = 1`
  await t.client`DELETE FROM actual_spend`
  await t.client`DELETE FROM provider_org`

  const [org] = await t.db
    .insert(schema.providerOrg)
    .values({ provider: 'anthropic', externalOrgId: `fp-org-${randomUUID()}`, displayName: 'FP Org', reconciliationMode: 'reconciled', billing: 'billed' })
    .returning()
  anthOrgId = org!.id

  // Activate governance so provider_org.billing is authoritative for this suite.
  await t.db.transaction((tx) => preflightGovernanceCutover(tx, { actorTeammateId: financeActorId }))
  await t.db.transaction((tx) => activateGovernanceCutover(tx, { actorTeammateId: financeActorId }))
})

async function seedActualSpend(): Promise<string> {
  const [row] = await t.db
    .insert(schema.actualSpend)
    .values({
      teammateId,
      date: PERIOD_DATE,
      tool: 'claude-code',
      inputTokens: 100n,
      outputTokens: 50n,
      costUsd: '10.000000',
      source: `anthropic-analytics-api:${(await t.client<{ external_org_id: string }[]>`SELECT external_org_id FROM provider_org WHERE id = ${anthOrgId}::uuid`)[0]!.external_org_id}`,
      providerOrgId: anthOrgId,
      chargebackExempt: false,
      governanceVerdictSource: 'governance:billed',
    })
    .returning()
  return row!.id
}

async function readRow(id: string) {
  const rows = await t.client<{ chargeback_exempt: boolean; governance_verdict_source: string | null; governance_verdict_locked_at: string | null }[]>`
    SELECT chargeback_exempt, governance_verdict_source, governance_verdict_locked_at::text AS governance_verdict_locked_at
    FROM actual_spend WHERE id = ${id}::uuid`
  return rows[0]!
}

describe('open billing edit changes B; closed edit does not', () => {
  it('an open period recomputes to the new verdict when billing changes', async () => {
    const id = await seedActualSpend()
    expect((await readRow(id)).chargeback_exempt).toBe(false)

    await t.client`UPDATE provider_org SET billing = 'tracked' WHERE id = ${anthOrgId}::uuid`
    await t.db.transaction((tx) => recomputeGovernanceVerdicts(tx, { providerOrgId: anthOrgId }))

    const after = await readRow(id)
    expect(after.chargeback_exempt).toBe(true)
    expect(after.governance_verdict_source).toBe('governance:tracked')
    expect(after.governance_verdict_locked_at).toBeNull()
  })

  it('a closed period does NOT move when billing changes afterwards', async () => {
    const id = await seedActualSpend()
    await t.db.transaction((tx) => closeFinancePeriod(tx, { periodMonth: PERIOD_MONTH, actorTeammateId: financeActorId }))
    const lockedAt = (await readRow(id)).governance_verdict_locked_at
    expect(lockedAt).not.toBeNull()

    await t.client`UPDATE provider_org SET billing = 'tracked' WHERE id = ${anthOrgId}::uuid`
    // Both the scoped recompute AND the writer's own re-poll path must respect the freeze.
    await t.db.transaction((tx) => recomputeGovernanceVerdicts(tx, { providerOrgId: anthOrgId }))

    const after = await readRow(id)
    expect(after.chargeback_exempt).toBe(false) // UNCHANGED — still billed, frozen at close
    expect(after.governance_verdict_source).toBe('governance:billed')
    expect(after.governance_verdict_locked_at).toBe(lockedAt) // untouched
  })
})

describe('concurrent close/recompute serialization', () => {
  it('a close holds the cutover lock until commit so rollback cannot pass concurrently', async () => {
    await seedActualSpend()

    await t.db.transaction(async (tx) => {
      await closeFinancePeriod(tx, { periodMonth: PERIOD_MONTH, actorTeammateId: financeActorId })
      const locks = await tx.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid = 5
          AND pid = pg_backend_pid()
          AND granted
      `)
      expect(Number(locks[0]!.n)).toBeGreaterThanOrEqual(1)
    })
  })

  it('holds the shared finance-period advisory lock until the recompute transaction commits', async () => {
    await seedActualSpend()

    await t.db.transaction(async (tx) => {
      await recomputeGovernanceVerdicts(tx, { providerOrgId: anthOrgId })
      const locks = await tx.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid = 4
          AND pid = pg_backend_pid()
          AND granted
      `)
      expect(Number(locks[0]!.n)).toBeGreaterThanOrEqual(1)
    })
  })

  it('two simultaneous close attempts on the same period serialize — exactly one succeeds, the other sees already-closed', async () => {
    await seedActualSpend()
    const results = await Promise.allSettled([
      t.db.transaction((tx) => closeFinancePeriod(tx, { periodMonth: PERIOD_MONTH, actorTeammateId: financeActorId })),
      t.db.transaction((tx) => closeFinancePeriod(tx, { periodMonth: PERIOD_MONTH, actorTeammateId: financeActorId })),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(FinancePeriodError)
    expect(((rejected[0] as PromiseRejectedResult).reason as FinancePeriodError).code).toBe('already-closed')

    const rows = await t.client<{ state: string }[]>`SELECT state FROM finance_period WHERE period_month = ${PERIOD_MONTH + '-01'}::date`
    expect(rows).toHaveLength(1) // no duplicate row from the race
    expect(rows[0]!.state).toBe('closed')
  })

  it('a close and a scoped recompute on the same period serialize without corrupting the freeze', async () => {
    const id = await seedActualSpend()
    const results = await Promise.allSettled([
      t.db.transaction((tx) => closeFinancePeriod(tx, { periodMonth: PERIOD_MONTH, actorTeammateId: financeActorId })),
      t.db.transaction((tx) =>
        recomputeGovernanceVerdicts(tx, { providerOrgId: anthOrgId, periodMonth: `${PERIOD_MONTH}-01` }),
      ),
    ])
    // Neither call should ever throw an unexpected error (a transaction abort or a
    // constraint violation) — recompute silently no-ops on an already-closed period.
    for (const r of results) expect(r.status).toBe('fulfilled')

    // Whichever interleaving occurred, the FINAL state is coherent: closed, and a
    // real timestamp locked.
    const finalRow = await readRow(id)
    expect(finalRow.governance_verdict_locked_at).not.toBeNull()
    const periodRows = await t.client<{ state: string }[]>`SELECT state FROM finance_period WHERE period_month = ${PERIOD_MONTH + '-01'}::date`
    expect(periodRows[0]!.state).toBe('closed')
  })
})

describe('reopen / restate — audited', () => {
  async function auditCount(eventType: string, since: Date): Promise<number> {
    const rows = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event WHERE event_type = ${eventType} AND ts_recorded >= ${since.toISOString()}::timestamptz`
    return Number(rows[0]!.n)
  }

  it('reopen unlocks the period and its rows without recomputing; a subsequent scoped recompute then applies', async () => {
    const since = new Date()
    const id = await seedActualSpend()
    await t.db.transaction((tx) => closeFinancePeriod(tx, { periodMonth: PERIOD_MONTH, actorTeammateId: financeActorId }))
    expect((await readRow(id)).governance_verdict_locked_at).not.toBeNull()

    const reopened = await t.db.transaction((tx) =>
      reopenFinancePeriod(tx, { periodMonth: PERIOD_MONTH, actorTeammateId: financeActorId, reason: 'late bill correction' }),
    )
    expect(reopened.period.state).toBe('open')
    expect((await readRow(id)).governance_verdict_locked_at).toBeNull() // unlocked, but NOT recomputed yet
    expect((await readRow(id)).chargeback_exempt).toBe(false) // verdict itself unchanged by reopen alone

    await t.client`UPDATE provider_org SET billing = 'tracked' WHERE id = ${anthOrgId}::uuid`
    await t.db.transaction((tx) => recomputeGovernanceVerdicts(tx, { providerOrgId: anthOrgId }))
    expect((await readRow(id)).chargeback_exempt).toBe(true) // NOW it applies, because the period is open again

    expect(await auditCount('finance-period-reopened', since)).toBe(1)
  })

  it('restate recomputes to convergence and re-freezes in one audited action, without leaving the period open', async () => {
    const since = new Date()
    const id = await seedActualSpend()
    await t.db.transaction((tx) => closeFinancePeriod(tx, { periodMonth: PERIOD_MONTH, actorTeammateId: financeActorId }))

    // A late governance edit — simulates a late bill anchor / corrected billing.
    await t.client`UPDATE provider_org SET billing = 'tracked' WHERE id = ${anthOrgId}::uuid`

    const restated = await t.db.transaction((tx) =>
      restateFinancePeriod(tx, { periodMonth: PERIOD_MONTH, actorTeammateId: financeActorId, reason: 'late bill anchor' }),
    )
    expect(restated.period.state).toBe('closed') // re-frozen, not left open
    expect(restated.rowsRecomputed).toBeGreaterThanOrEqual(1)

    const after = await readRow(id)
    expect(after.chargeback_exempt).toBe(true) // picked up the late edit
    expect(after.governance_verdict_locked_at).not.toBeNull() // re-frozen

    expect(await auditCount('finance-period-restated', since)).toBe(1)
  })

  it('restate and reopen both reject a period that is not currently closed', async () => {
    await seedActualSpend()
    await expect(
      t.db.transaction((tx) => reopenFinancePeriod(tx, { periodMonth: PERIOD_MONTH, actorTeammateId: financeActorId, reason: 'x' })),
    ).rejects.toMatchObject({ code: 'not-closed' })
    await expect(
      t.db.transaction((tx) => restateFinancePeriod(tx, { periodMonth: PERIOD_MONTH, actorTeammateId: financeActorId, reason: 'x' })),
    ).rejects.toMatchObject({ code: 'not-closed' })
  })
})

describe('unresolved governance — never chargeable, always showback-visible', () => {
  it('a row with no resolvable provider_org_id is exempt with source=unresolved, and still appears in v_complete_usage', async () => {
    const [row] = await t.db
      .insert(schema.actualSpend)
      .values({
        teammateId,
        date: PERIOD_DATE,
        tool: 'claude-ai', // a non-Code Claude surface — reaches §A via v_complete_usage's
        // ingest-only arm 3 (see shared/usage/surface.ts INGEST_ONLY_USAGE_TOOLS); a plain
        // 'claude-code' actual_spend row only reaches v_complete_usage indirectly via OTel/
        // unaccounted_usage, neither of which this test seeds, so it would prove nothing here.
        inputTokens: 10n,
        outputTokens: 5n,
        costUsd: '1.000000',
        source: 'anthropic-analytics-api', // legacy bare-prefix row — no org suffix, unresolvable
        providerOrgId: null,
        chargebackExempt: false,
      })
      .returning()

    await t.db.transaction((tx) => recomputeGovernanceVerdicts(tx, {}))
    const r = await readRow(row!.id)
    expect(r.chargeback_exempt).toBe(true)
    expect(r.governance_verdict_source).toBe('unresolved')

    // Showback (§A, v_complete_usage) never filters on chargeback_exempt — the row
    // must still be visible there regardless of its (never-chargeable) verdict.
    const visible = await t.client<{ cost_usd: string }[]>`
      SELECT cost_usd FROM v_complete_usage WHERE teammate_id = ${teammateId}::uuid AND tool = 'claude-ai' AND cost_usd = 1.000000`
    expect(visible.length).toBeGreaterThanOrEqual(1)
  })
})
