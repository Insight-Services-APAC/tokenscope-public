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
    .values({ entraOid: 'oid-rp-actor', email: 'rp-actor@x.test', role: 'platform-admin', regionId: r!.id, orgUnitId: ou!.id })
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

    const history = await listCopilotRatePlans(t.db, entId, '2026-11')
    const firstRow = history.find((p) => p.id === first.plan.id)!
    expect(firstRow.validTo).toContain('2026-10-01')
    expect(firstRow.retiredAt).toBeNull() // truncated, not retired — still a real historical row
  })

  it('the history says which plan is in effect for the month, by the test billing uses', async () => {
    const entId = await mkEnterprise(`rp-ent-${randomUUID().slice(0, 8)}`)
    const mk = (validFrom: string, validTo: string | null) =>
      createCopilotRatePlan(t.db, {
        providerEnterpriseId: entId, validFrom, validTo,
        flatSeatPriceUsd: 39, includedAllowanceUsd: 70, actorTeammateId: actorId,
      })
    const ended = await mk('2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
    const retired = await mk('2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    const current = await mk('2026-07-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')
    const later = await mk('2026-12-01T00:00:00.000Z', null)
    await t.client`UPDATE copilot_rate_plan SET retired_at = now() WHERE id = ${retired.plan.id}::uuid`

    const byId = new Map((await listCopilotRatePlans(t.db, entId, '2026-11')).map((p) => [p.id, p.status]))
    expect(byId.get(ended.plan.id)).toBe('ended')
    expect(byId.get(retired.plan.id)).toBe('retired')
    expect(byId.get(current.plan.id)).toBe('in-effect')
    expect(byId.get(later.plan.id)).toBe('starts-later')

    // The plan called in effect is the one billing resolves for that month.
    const billed = await resolveCopilotRatePlan(t.db, { providerEnterpriseId: entId, periodMonth: '2026-11' })
    expect(billed.ratePlanId).toBe(current.plan.id)
    // A retired plan is never in effect, even for a month its range holds.
    const june = new Map((await listCopilotRatePlans(t.db, entId, '2026-06')).map((p) => [p.id, p.status]))
    expect(june.get(retired.plan.id)).toBe('retired')
    expect([...june.values()].filter((v) => v === 'in-effect')).toHaveLength(0)
  })

  it('a plan whose dates hold no 1st of a month is never billed, and says so', async () => {
    const entId = await mkEnterprise(`rp-ent-${randomUUID().slice(0, 8)}`)
    const mk = (validFrom: string, validTo: string) =>
      createCopilotRatePlan(t.db, {
        providerEnterpriseId: entId, validFrom, validTo,
        flatSeatPriceUsd: 39, includedAllowanceUsd: 70, actorTeammateId: actorId,
      })
    const inside = await mk('2026-11-10T00:00:00.000Z', '2026-11-20T00:00:00.000Z')
    const endsOnFirst = await mk('2026-05-15T00:00:00.000Z', '2026-06-01T00:00:00.000Z') // [15 May, 1 Jun): no 1st
    const startsOnFirst = await mk('2026-03-01T00:00:00.000Z', '2026-03-15T00:00:00.000Z') // holds 1 Mar

    for (const month of ['2026-01', '2026-11', '2027-02']) {
      const byId = new Map((await listCopilotRatePlans(t.db, entId, month)).map((p) => [p.id, p.status]))
      expect(byId.get(inside.plan.id), month).toBe('never-billed')
      expect(byId.get(endsOnFirst.plan.id), month).toBe('never-billed')
      expect(byId.get(startsOnFirst.plan.id), month).not.toBe('never-billed')
    }
    // And billing agrees: no month resolves to either never-billed plan.
    for (const month of ['2026-05', '2026-06', '2026-11', '2026-12']) {
      const r = await resolveCopilotRatePlan(t.db, { providerEnterpriseId: entId, periodMonth: month })
      expect([inside.plan.id, endsOnFirst.plan.id], month).not.toContain(r.ratePlanId)
    }
    const march = await resolveCopilotRatePlan(t.db, { providerEnterpriseId: entId, periodMonth: '2026-03' })
    expect(march.ratePlanId).toBe(startsOnFirst.plan.id)
  })

  it('never-billed is judged by containment, so stored [] and () bounds agree with billing', async () => {
    // One enterprise per range: these rows are written directly, past the app's own checks.
    const cases = [
      { range: `tstzrange('2026-05-15T00:00:00Z', '2026-06-01T00:00:00Z', '[]')`, month: '2026-06', billed: true },
      { range: `tstzrange('2026-03-01T00:00:00Z', '2026-03-15T00:00:00Z', '()')`, month: '2026-03', billed: false },
      { range: `tstzrange('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z', '(]')`, month: '2026-04', billed: true },
    ]
    for (const c of cases) {
      const entId = await mkEnterprise(`rp-ent-${randomUUID().slice(0, 8)}`)
      const [row] = await t.client.unsafe<{ id: string }[]>(
        `INSERT INTO copilot_rate_plan (provider_enterprise_id, effective, flat_seat_price_usd, included_allowance_usd, notes)
         VALUES ($1::uuid, ${c.range}, 39, 70, 'bounds-test') RETURNING id::text AS id`,
        [entId],
      )
      const status = (await listCopilotRatePlans(t.db, entId, '2025-01'))[0]!.status
      const resolved = await resolveCopilotRatePlan(t.db, { providerEnterpriseId: entId, periodMonth: c.month })
      expect(resolved.ratePlanId === row!.id, c.range).toBe(c.billed)
      if (c.billed) expect(status, c.range).not.toBe('never-billed')
      else expect(status, c.range).toBe('never-billed')
    }
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
