// @vitest-environment node
/*
 * Intent: ADR-0011 D10 (design §5.4, §9 test strategy) — configurable
 * pooled-overage allocation, persisted. Covers:
 *   (A) consumption-share (default): weight = usage, proportional split.
 *   (B) excess-share: weight = max(0, usage - perSeatShare); a CoU with zero
 *       excess gets no row.
 *   (C) excess-equal: equal weight across everyone over the per-seat share.
 *   (D) seat-share: equal weight per active seat (the roster, not usage).
 *   (E) deterministic remainder: an uneven 3-way split is stable across a
 *       rerun with unchanged inputs (§9 R1-M7 "ties broken by a stable key").
 *   (F) conservation asserted AFTER persistence (a fresh read-back), not just
 *       in memory.
 *   (G) idempotent rerun: re-running with unchanged inputs does not duplicate
 *       or drift the persisted rows.
 *   (H) zero attributable weight -> one explicit unallocated row for the
 *       WHOLE overage net.
 *   (I) a CLOSED finance period refuses the write; reopening unblocks it
 *       (design §8.4 "no silent rewrite").
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import {
  persistCopilotOverageAllocation,
  CopilotOverageAllocationClosedPeriodError,
} from '../../../server/governance/copilot-overage-allocation'
import { closeFinancePeriod, reopenFinancePeriod } from '../../../server/governance/finance-period'

let t: TestDb
let regionId: string
let couA: string
let couB: string
let couC: string
let financeActorId: string
const ENT = 'ca-ent'
const MONTH = '2026-06-01'

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'ca-r', displayName: 'CA R' }).returning()
  regionId = r!.id
  const mkCou = async (code: string) => {
    const [ou] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId, path: `ca.${code}`, code, displayName: code, unitType: 'bu', isCostOwningUnit: true })
      .returning()
    return ou!.id
  }
  couA = await mkCou('ca-a')
  couB = await mkCou('ca-b')
  couC = await mkCou('ca-c')
  const [actor] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ca-actor', email: 'ca-actor@x.test', role: 'global-finops', regionId, orgUnitId: couA })
    .returning()
  financeActorId = actor!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

let entId: string

beforeEach(async () => {
  await t.client`DELETE FROM copilot_overage_allocation`
  await t.client`DELETE FROM copilot_pool_bill`
  await t.client`DELETE FROM reconciliation_record`
  await t.client`DELETE FROM actual_spend`
  await t.client`DELETE FROM finance_period`
  await t.client`DELETE FROM provider_enterprise WHERE external_id = ${ENT}`
  const [ent] = await t.db
    .insert(schema.providerEnterprise)
    .values({ provider: 'github', externalId: ENT, displayName: ENT, reconciliationMode: 'reconciled' })
    .returning({ id: schema.providerEnterprise.id })
  entId = ent!.id
})

async function mkTeammate(orgUnitId: string): Promise<string> {
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: `oid-ca-${randomUUID().slice(0, 8)}`, email: `ca.${randomUUID().slice(0, 8)}@x.test`, regionId, orgUnitId })
    .returning()
  return tm!.id
}

async function seedBill(overageNetUsd: number, opts?: { includedAllowanceUsd?: number; seats?: number }): Promise<void> {
  await t.db.insert(schema.copilotPoolBill).values({
    month: MONTH,
    providerEnterpriseId: entId,
    providerOrgId: null,
    costOwningUnitId: null,
    seats: opts?.seats ?? null,
    licenseNetUsd: null,
    includedAllowanceUsd: opts?.includedAllowanceUsd != null ? opts.includedAllowanceUsd.toFixed(6) : null,
    usageGrossUsd: null,
    overageNetUsd: overageNetUsd.toFixed(6),
    unclassifiedNetUsd: '0',
  })
}

async function seedUsage(teammateId: string, costOwningUnitId: string, actualUsd: number, category = 'copilot_interactive'): Promise<void> {
  await t.db.insert(schema.reconciliationRecord).values({
    teammateId,
    provider: 'github',
    enterpriseRef: ENT,
    licenseOrg: 'acme',
    periodDate: '2026-06-10',
    category,
    scope: 'teammate',
    costOwningUnitId,
    providerEnterpriseId: entId,
    actualUsd: actualUsd.toFixed(6),
    otelAttributedUsd: '0',
    deltaUsd: actualUsd.toFixed(6),
    spendClass: 'indicative',
    disposition: 'under',
    status: 'applied',
  })
}

async function seedSeat(teammateId: string, costOwningUnitId: string): Promise<void> {
  await t.db.insert(schema.actualSpend).values({
    teammateId,
    date: MONTH,
    tool: 'copilot-cli',
    inputTokens: 0n,
    outputTokens: 0n,
    costUsd: '39.00',
    source: `copilot-seat:acme-${randomUUID().slice(0, 6)}`,
    category: 'seat-license',
    providerEnterpriseId: entId,
    costOwningUnitId,
    chargebackExempt: false,
  })
}

async function sumAllocated(): Promise<number> {
  const [row] = await t.client<{ s: string }[]>`
    SELECT COALESCE(SUM(allocated_usd), 0)::text AS s FROM copilot_overage_allocation
    WHERE provider_enterprise_id = ${entId}::uuid AND month = ${MONTH}::date`
  return Number(row!.s)
}

describe('copilot-overage-allocation', () => {
  it('(A) consumption-share (default): proportional to usage', async () => {
    const tmA = await mkTeammate(couA)
    const tmB = await mkTeammate(couB)
    await seedUsage(tmA, couA, 300)
    await seedUsage(tmB, couB, 100)
    await seedBill(200)

    const result = await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    expect(result.policy).toBe('consumption-share')
    expect(result.overageNetUsd).toBe(200)
    const byou = new Map(result.recipients.map((r) => [r.costOwningUnitId, r.allocatedUsd]))
    expect(byou.get(couA)).toBe(150)
    expect(byou.get(couB)).toBe(50)
    expect(await sumAllocated()).toBe(200)
  })

  it('(B) excess-share: weight is excess above the blended per-seat share; a zero-excess CoU gets no row', async () => {
    await t.client`UPDATE provider_enterprise SET overage_allocation_policy = 'excess-share' WHERE id = ${entId}::uuid`
    const tmA = await mkTeammate(couA)
    const tmB = await mkTeammate(couB)
    await seedUsage(tmA, couA, 120) // excess 70 (perSeatShare = 100/2 = 50)
    await seedUsage(tmB, couB, 40) // excess 0 (below share) — excluded entirely
    await seedBill(70, { includedAllowanceUsd: 100, seats: 2 })

    const result = await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    expect(result.recipients).toHaveLength(1)
    expect(result.recipients[0]!.costOwningUnitId).toBe(couA)
    expect(result.recipients[0]!.allocatedUsd).toBe(70)
    expect(await sumAllocated()).toBe(70)
  })

  it('(C) excess-equal: equal weight across everyone over the per-seat share, regardless of HOW FAR over', async () => {
    await t.client`UPDATE provider_enterprise SET overage_allocation_policy = 'excess-equal' WHERE id = ${entId}::uuid`
    const tmA = await mkTeammate(couA) // usage 120 — over
    const tmB = await mkTeammate(couB) // usage 80 — over
    const tmC = await mkTeammate(couC) // usage 40 — NOT over (share is 50)
    await seedUsage(tmA, couA, 120)
    await seedUsage(tmB, couB, 80)
    await seedUsage(tmC, couC, 40)
    await seedBill(100, { includedAllowanceUsd: 100, seats: 2 })

    const result = await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    const byou = new Map(result.recipients.map((r) => [r.costOwningUnitId, r.allocatedUsd]))
    expect(byou.get(couA)).toBe(50)
    expect(byou.get(couB)).toBe(50)
    expect(byou.has(couC)).toBe(false)
    expect(await sumAllocated()).toBe(100)
  })

  it('(D) seat-share: equal weight per ACTIVE SEAT (the roster), not usage', async () => {
    await t.client`UPDATE provider_enterprise SET overage_allocation_policy = 'seat-share' WHERE id = ${entId}::uuid`
    const tmA1 = await mkTeammate(couA)
    const tmA2 = await mkTeammate(couA)
    const tmB1 = await mkTeammate(couB)
    await seedSeat(tmA1, couA)
    await seedSeat(tmA2, couA)
    await seedSeat(tmB1, couB)
    await seedBill(90)

    const result = await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    const byou = new Map(result.recipients.map((r) => [r.costOwningUnitId, r.allocatedUsd]))
    expect(byou.get(couA)).toBe(60) // 2/3 of 90
    expect(byou.get(couB)).toBe(30) // 1/3 of 90
    expect(await sumAllocated()).toBe(90)
  })

  it('(E) deterministic remainder: an uneven 3-way split is stable across a rerun', async () => {
    const tmA = await mkTeammate(couA)
    const tmB = await mkTeammate(couB)
    const tmC = await mkTeammate(couC)
    await seedUsage(tmA, couA, 100)
    await seedUsage(tmB, couB, 100)
    await seedUsage(tmC, couC, 100)
    await seedBill(100) // equal weight -> 33.33 each, one cent must go somewhere

    const run = () =>
      t.db.transaction((tx) =>
        persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
      )
    const first = await run()
    const second = await run()
    function sortRecipients(result: Awaited<ReturnType<typeof run>>) {
      return result.recipients
        .map((r) => ({ costOwningUnitId: r.costOwningUnitId, allocatedUsd: r.allocatedUsd }))
        .sort((a, b) => (a.costOwningUnitId ?? '').localeCompare(b.costOwningUnitId ?? ''))
    }
    expect(sortRecipients(second)).toEqual(sortRecipients(first))
    expect(await sumAllocated()).toBe(100)
  })

  it('(F) conservation is asserted from a FRESH read-back after persistence', async () => {
    const tmA = await mkTeammate(couA)
    await seedUsage(tmA, couA, 50)
    await seedBill(33.33)
    await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    // Independent read-back (a NEW query, not the function's return value).
    const [row] = await t.client<{ s: string; overage: string }[]>`
      SELECT SUM(allocated_usd)::text AS s, MAX(overage_net_usd)::text AS overage FROM copilot_overage_allocation
      WHERE provider_enterprise_id = ${entId}::uuid AND month = ${MONTH}::date`
    expect(Number(row!.s)).toBeCloseTo(33.33, 2)
    expect(Number(row!.overage)).toBeCloseTo(33.33, 2)
  })

  it('(G) idempotent rerun: re-running with unchanged inputs does not duplicate or drift rows', async () => {
    const tmA = await mkTeammate(couA)
    const tmB = await mkTeammate(couB)
    await seedUsage(tmA, couA, 300)
    await seedUsage(tmB, couB, 100)
    await seedBill(200)

    await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    const firstRows = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM copilot_overage_allocation`
    await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    const secondRows = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM copilot_overage_allocation`
    expect(secondRows[0]!.n).toBe(firstRows[0]!.n)
    expect(await sumAllocated()).toBe(200)
  })

  it('(H) zero attributable weight -> one explicit unallocated row for the WHOLE overage net', async () => {
    // Paid overage but NO usage/seat data at all for this enterprise+month.
    await seedBill(450)
    const result = await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    expect(result.unallocated).toBe(true)
    expect(result.recipients).toHaveLength(1)
    expect(result.recipients[0]!.costOwningUnitId).toBeNull()
    expect(result.recipients[0]!.allocatedUsd).toBe(450)
    expect(await sumAllocated()).toBe(450)
  })

  /*
   * (H2) The same zero-weight path on a net that lands on an exact HALF-CENT.
   *
   * (H) above passes on any implementation, because 450 renders identically
   * however you round it. The unallocated branch used to write the raw net and
   * let the INSERT's toFixed(2) round it, while the conservation check compares
   * against Math.round(net * 100) — and those disagree at a half-cent. 1000.005
   * wrote 1000.00 against an expected 100001c and threw `conservation broken`,
   * rolling back the whole (enterprise, month) bill write on every retry, with
   * only a consola.warn to show for it.
   *
   * Reverting the branch to `allocatedUsd: overageNetUsd` makes this throw.
   * The weighted case is asserted alongside it because it ALREADY handled the
   * same net correctly (it routes through allocateCents), which is what
   * identified the branch as the defect rather than the check.
   */
  it('(H2) a half-cent overage net conserves in BOTH the zero-weight and weighted branches', async () => {
    await seedBill(1000.005)
    const unweighted = await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    expect(unweighted.unallocated).toBe(true)
    // Rounded ONCE, by the same Math.round(x*100) the conservation check uses.
    expect(unweighted.recipients[0]!.allocatedUsd).toBe(1000.01)
    expect(await sumAllocated()).toBe(1000.01)

    // Same net, now with attributable weight: the branch that was always correct.
    const tmA = await mkTeammate(couA)
    await seedUsage(tmA, couA, 10)
    const weighted = await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    expect(weighted.unallocated).toBe(false)
    expect(await sumAllocated()).toBe(1000.01)
  })

  it('(zero overage) a $0 recompute clears any stale prior allocation and writes nothing', async () => {
    const tmA = await mkTeammate(couA)
    await seedUsage(tmA, couA, 100)
    await seedBill(200)
    await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    expect(await sumAllocated()).toBe(200)
    const [{ n: auditBefore }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n
      FROM audit_event
      WHERE event_type = 'copilot-overage-allocation-computed'
        AND subject_id = ${entId}::uuid
    `

    // The bill is corrected to $0 overage (e.g. a re-pull) — the stale allocation must clear.
    await t.client`UPDATE copilot_pool_bill SET overage_net_usd = 0 WHERE provider_enterprise_id = ${entId}::uuid AND month = ${MONTH}::date`
    const result = await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    expect(result.skippedZeroOverage).toBe(true)
    const [{ n }] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM copilot_overage_allocation`
    expect(Number(n)).toBe(0)
    const [{ n: auditAfter }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n
      FROM audit_event
      WHERE event_type = 'copilot-overage-allocation-computed'
        AND subject_id = ${entId}::uuid
    `
    expect(Number(auditAfter)).toBe(Number(auditBefore) + 1)
  })

  it('(I) a CLOSED finance period refuses the write; reopening unblocks it', async () => {
    const tmA = await mkTeammate(couA)
    await seedUsage(tmA, couA, 100)
    await seedBill(50)

    await t.db.transaction((tx) => closeFinancePeriod(tx, { periodMonth: MONTH, actorTeammateId: financeActorId }))

    await expect(
      t.db.transaction((tx) =>
        persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
      ),
    ).rejects.toBeInstanceOf(CopilotOverageAllocationClosedPeriodError)
    expect(await sumAllocated()).toBe(0) // nothing was written

    await t.db.transaction((tx) =>
      reopenFinancePeriod(tx, { periodMonth: MONTH, actorTeammateId: financeActorId, reason: 'test reopen' }),
    )
    const result = await t.db.transaction((tx) =>
      persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: ENT, month: MONTH, actorSystem: 'test' }),
    )
    expect(result.skippedZeroOverage).toBe(false)
    expect(await sumAllocated()).toBe(50)
  })
})
