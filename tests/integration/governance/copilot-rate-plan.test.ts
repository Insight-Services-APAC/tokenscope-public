// @vitest-environment node
/*
 * Intent: ADR-0011 D9 (design §5.3, §9 test strategy) — effective-dated
 * Copilot rate plans. Covers:
 *   (1) non-overlap: a genuinely conflicting effective range 409s (EXCLUDE
 *       USING gist, migration 0106).
 *   (2) period-date lookup + boundaries: the plan in force for a given month
 *       resolves correctly at, either side of, and exactly on a boundary.
 *   (3) historical-month stability: adding a NEW plan for a future period
 *       never changes what resolveCopilotRatePlan returns for an ALREADY-
 *       PASSED month (design C3).
 *   (4) auto-truncate: creating a new plan closes the immediately-preceding
 *       open-ended plan at the new plan's start, in the SAME audited write.
 *   (5) scalar-fallback compatibility: an enterprise with NO rate_plan row at
 *       all still resolves from the legacy scalar fields (today's exact,
 *       period-blind behaviour) — the deprecation-safety contract.
 *   (6) migration 0106's backfill: an enterprise carrying scalar values
 *       BEFORE any rate_plan row exists gets an OPEN-ENDED plan seeded with
 *       the identical values, reproducing the migration's own INSERT.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import {
  resolveCopilotRatePlan,
  createCopilotRatePlan,
  listCopilotRatePlans,
} from '../../../server/governance/copilot-rate-plan'

let t: TestDb
let actorId: string

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'rp-r', displayName: 'RP R' }).returning()
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: r!.id, path: 'rp.svc', code: 'rp-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  const [actor] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rp-actor', email: 'rp-actor@x.test', role: 'global-finops', regionId: r!.id, orgUnitId: ou!.id })
    .returning()
  actorId = actor!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function mkEnterprise(externalId: string, scalarFlat?: number, scalarAllowance?: number): Promise<string> {
  const [ent] = await t.db
    .insert(schema.providerEnterprise)
    .values({
      provider: 'github',
      externalId,
      displayName: externalId,
      reconciliationMode: 'reconciled',
      flatSeatPriceUsd: scalarFlat != null ? scalarFlat.toFixed(6) : null,
      includedAllowanceUsd: scalarAllowance != null ? scalarAllowance.toFixed(6) : null,
    })
    .returning({ id: schema.providerEnterprise.id })
  return ent!.id
}

describe('copilot-rate-plan', () => {
  it('(2) period-date lookup: resolves the plan in force for a given month, on both sides of a boundary', async () => {
    const entId = await mkEnterprise(`rp-ent-${randomUUID().slice(0, 8)}`)
    await createCopilotRatePlan(t.db, {
      providerEnterpriseId: entId,
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-10-01T00:00:00.000Z',
      flatSeatPriceUsd: 39,
      includedAllowanceUsd: 70,
      actorTeammateId: actorId,
    })
    await createCopilotRatePlan(t.db, {
      providerEnterpriseId: entId,
      validFrom: '2026-10-01T00:00:00.000Z',
      validTo: null,
      flatSeatPriceUsd: 45,
      includedAllowanceUsd: 80,
      actorTeammateId: actorId,
    })

    const aug = await resolveCopilotRatePlan(t.db, { providerEnterpriseId: entId, periodMonth: '2026-08' })
    expect(aug.source).toBe('rate-plan')
    expect(aug.flatSeatPriceUsd).toBe(39)
    expect(aug.includedAllowanceUsd).toBe(70)

    // The boundary month itself belongs to the NEW plan (validFrom is inclusive).
    const oct = await resolveCopilotRatePlan(t.db, { providerEnterpriseId: entId, periodMonth: '2026-10' })
    expect(oct.flatSeatPriceUsd).toBe(45)
    expect(oct.includedAllowanceUsd).toBe(80)

    // The month immediately before the boundary still resolves the OLD plan (validTo exclusive).
    const sep = await resolveCopilotRatePlan(t.db, { providerEnterpriseId: entId, periodMonth: '2026-09' })
    expect(sep.flatSeatPriceUsd).toBe(39)

    const nov = await resolveCopilotRatePlan(t.db, { providerEnterpriseId: entId, periodMonth: '2026-11' })
    expect(nov.flatSeatPriceUsd).toBe(45)
  })

  it('(3) historical-month stability: a NEW future plan never changes an already-resolved past month', async () => {
    const entId = await mkEnterprise(`rp-ent-${randomUUID().slice(0, 8)}`)
    await createCopilotRatePlan(t.db, {
      providerEnterpriseId: entId,
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
      flatSeatPriceUsd: 39,
      includedAllowanceUsd: 70,
      actorTeammateId: actorId,
    })
    const before = await resolveCopilotRatePlan(t.db, { providerEnterpriseId: entId, periodMonth: '2026-06' })
    expect(before.flatSeatPriceUsd).toBe(39)

    // A plan change effective a future month (C3 — a rate-plan change must never re-cost a
    // closed/already-computed month).
    await createCopilotRatePlan(t.db, {
      providerEnterpriseId: entId,
      validFrom: '2026-10-01T00:00:00.000Z',
      validTo: null,
      flatSeatPriceUsd: 45,
      includedAllowanceUsd: 80,
      actorTeammateId: actorId,
    })

    const after = await resolveCopilotRatePlan(t.db, { providerEnterpriseId: entId, periodMonth: '2026-06' })
    expect(after.flatSeatPriceUsd).toBe(39)
    expect(after.includedAllowanceUsd).toBe(70)
    expect(after.ratePlanId).toBe(before.ratePlanId)
  })

  it('(4) auto-truncate: a new plan closes the immediately-preceding open-ended plan at its own start', async () => {
    const entId = await mkEnterprise(`rp-ent-${randomUUID().slice(0, 8)}`)
    const first = await createCopilotRatePlan(t.db, {
      providerEnterpriseId: entId,
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
      flatSeatPriceUsd: 39,
      includedAllowanceUsd: 70,
      actorTeammateId: actorId,
    })
    expect(first.truncatedPreviousPlanId).toBeNull()

    const second = await createCopilotRatePlan(t.db, {
      providerEnterpriseId: entId,
      validFrom: '2026-10-01T00:00:00.000Z',
      validTo: null,
      flatSeatPriceUsd: 45,
      includedAllowanceUsd: 80,
      actorTeammateId: actorId,
    })
    expect(second.truncatedPreviousPlanId).toBe(first.plan.id)

    const history = await listCopilotRatePlans(t.db, entId)
    const firstRow = history.find((p) => p.id === first.plan.id)!
    expect(firstRow.validTo).toContain('2026-10-01')
    expect(firstRow.retiredAt).toBeNull() // truncated, not retired — still a real historical row
  })

  it('(1) non-overlap: a genuinely conflicting effective range is rejected (409)', async () => {
    const entId = await mkEnterprise(`rp-ent-${randomUUID().slice(0, 8)}`)
    await createCopilotRatePlan(t.db, {
      providerEnterpriseId: entId,
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-06-01T00:00:00.000Z',
      flatSeatPriceUsd: 39,
      includedAllowanceUsd: 70,
      actorTeammateId: actorId,
    })
    // Overlaps the middle of the first plan's range — not the "supersede the open-ended
    // plan" case, so it must be rejected, not silently adjusted.
    await expect(
      createCopilotRatePlan(t.db, {
        providerEnterpriseId: entId,
        validFrom: '2026-03-01T00:00:00.000Z',
        validTo: '2026-04-01T00:00:00.000Z',
        flatSeatPriceUsd: 50,
        includedAllowanceUsd: 90,
        actorTeammateId: actorId,
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('(5) scalar-fallback: an enterprise with NO rate_plan row resolves from the legacy scalar fields', async () => {
    const entId = await mkEnterprise(`rp-ent-${randomUUID().slice(0, 8)}`, 39, 70)
    const resolved = await resolveCopilotRatePlan(t.db, { providerEnterpriseId: entId, periodMonth: '2026-06' })
    expect(resolved.source).toBe('scalar-fallback')
    expect(resolved.flatSeatPriceUsd).toBe(39)
    expect(resolved.includedAllowanceUsd).toBe(70)
    expect(resolved.ratePlanId).toBeNull()
  })

  it('(6) migration-0106-equivalent backfill: an open-ended plan seeded from the scalar fields reproduces every period identically', async () => {
    const entId = await mkEnterprise(`rp-ent-${randomUUID().slice(0, 8)}`, 39, 70)
    // Reproduce migration 0106 PART 4's exact backfill statement (a fresh enterprise that
    // predates any rate_plan row, exactly the pre-cutover shape).
    await t.client`
      INSERT INTO copilot_rate_plan (provider_enterprise_id, effective, flat_seat_price_usd, included_allowance_usd, notes)
      SELECT id, tstzrange(NULL, NULL), flat_seat_price_usd, included_allowance_usd, 'backfill-test'
      FROM provider_enterprise WHERE id = ${entId}::uuid AND (flat_seat_price_usd IS NOT NULL OR included_allowance_usd IS NOT NULL)`

    for (const month of ['2020-01', '2026-06', '2099-12']) {
      const resolved = await resolveCopilotRatePlan(t.db, { providerEnterpriseId: entId, periodMonth: month })
      expect(resolved.source).toBe('rate-plan')
      expect(resolved.flatSeatPriceUsd).toBe(39)
      expect(resolved.includedAllowanceUsd).toBe(70)
    }
  })
})
