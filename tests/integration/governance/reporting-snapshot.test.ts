// @vitest-environment node
/*
 * reporting_snapshot — recording a month, and reporting when it moves.
 *
 * REPLACES `finance-period.test.ts`, which proved the opposite behaviour: that a
 * closed month refused edits, that reopen unlocked it and that restate was the
 * audited way back in. All of that is deleted. The timeline that ended it: we
 * close at +2 after month end, the provider corrects its rows at +6, the bill
 * lands at +10 — and the product rejected the authoritative source because of a
 * state we set ourselves.
 *
 * So the assertions here are the inverse of the ones they replace, and the most
 * important test in the file is the one proving a recorded month still accepts
 * the bill.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import {
  closeReportingSnapshot,
  getReportingSnapshot,
  reportingSnapshotDelta,
  ReportingSnapshotError,
} from '../../../server/governance/reporting-snapshot'
import { recomputeGovernanceVerdicts } from '../../../server/governance/recompute'
import { activateGovernanceCutover, preflightGovernanceCutover } from '../../../server/governance/cutover'

let t: TestDb
let regionId = ''
let ouId = ''
let actorId = ''
let teammateId = ''
let orgId = ''
let orgExternalId = ''

const MONTH = '2026-04'
const PERIOD_DATE = '2026-04-15'

beforeAll(async () => {
  t = await startTestDb()
  ;[{ id: regionId }] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES ('rs', 'RS') RETURNING id::text AS id`
  ;[{ id: ouId }] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'rs'::ltree, 'rs', 'RS BU', 'bu', true) RETURNING id::text AS id`
  ;[{ id: actorId }] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-rs-actor', 'rs-actor@x.test', 'Actor', ${regionId}::uuid, ${ouId}::uuid, true)
    RETURNING id::text AS id`
  ;[{ id: teammateId }] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-rs-tm', 'rs-tm@x.test', 'TM', ${regionId}::uuid, ${ouId}::uuid, true)
    RETURNING id::text AS id`
  orgExternalId = `rs-org-${randomUUID()}`
  const [org] = await t.db
    .insert(schema.providerOrg)
    .values({
      provider: 'anthropic',
      externalOrgId: orgExternalId,
      displayName: 'RS Org',
      reconciliationMode: 'reconciled',
      billing: 'billed',
    })
    .returning()
  orgId = org!.id

  // Governance must be ACTIVATED for `provider_org.billing` to be the authority
  // recompute derives verdicts from; without it recompute has nothing to say and
  // the verdict test below would pass or fail for the wrong reason.
  await t.db.transaction((tx) => preflightGovernanceCutover(tx, { actorTeammateId: actorId }))
  await t.db.transaction((tx) => activateGovernanceCutover(tx, { actorTeammateId: actorId }))
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  await t.client`DELETE FROM reporting_snapshot`
  await t.client`DELETE FROM actual_spend`
  seedSeq = 0
})

/*
 * `actual_spend` is unique on (teammate, date, tool, source), so each seeded row
 * needs its own tool — two rows on one key is an upsert, not a second row.
 */
let seedSeq = 0
async function seedSpend(costUsd: string, exempt = false): Promise<string> {
  const [row] = await t.db
    .insert(schema.actualSpend)
    .values({
      teammateId,
      date: PERIOD_DATE,
      tool: `claude-code-${++seedSeq}`,
      inputTokens: 100n,
      outputTokens: 50n,
      costUsd,
      source: `anthropic-analytics-api:${orgExternalId}`,
      providerOrgId: orgId,
      chargebackExempt: exempt,
      governanceVerdictSource: 'governance:billed',
    })
    .returning()
  return row!.id
}

const close = () =>
  t.db.transaction((tx) => closeReportingSnapshot(tx, { periodMonth: MONTH, actorTeammateId: actorId }))

describe('recording a month', () => {
  it('records what the month reads, and who recorded it', async () => {
    await seedSpend('10.000000')
    await seedSpend('4.000000', true) // exempt

    const { snapshot } = await close()

    expect(snapshot.periodMonth).toBe('2026-04-01')
    expect(snapshot.closedBy).toBe(actorId)
    expect(snapshot.chargeableUsd).toBeCloseTo(10, 2)
    expect(snapshot.exemptUsd).toBeCloseTo(4, 2)
    expect(snapshot.basis).toBe('project-homed')
  })

  it('refuses to record the same month twice — that would overwrite the record', async () => {
    /*
     * Idempotence is deliberately NOT offered. A second close would silently
     * replace what was reported the first time, which is the one thing a
     * snapshot exists to preserve.
     */
    await seedSpend('10.000000')
    await close()
    await expect(close()).rejects.toBeInstanceOf(ReportingSnapshotError)
  })

  it('a month with no snapshot reads as null — absence is not a state', async () => {
    expect(await getReportingSnapshot(t.db, MONTH)).toBeNull()
  })
})

describe('a recorded month is not locked', () => {
  it('THE BILL STILL LANDS — new spend can be written after the month is recorded', async () => {
    /*
     * The test this file exists for. Its predecessor asserted the opposite: a
     * closed month refused the write, and the operator had to reopen or restate.
     * A database trigger enforced it for Anthropic and a 409 for Copilot.
     *
     * Close at +2, the provider corrects at +6, the bill lands at +10. Refusing
     * it never protected the month; it guaranteed the month stayed wrong.
     */
    await seedSpend('10.000000')
    await close()

    await expect(seedSpend('7.500000')).resolves.toBeTruthy()

    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT round(SUM(cost_usd), 2)::text AS n FROM actual_spend`
    expect(Number(n)).toBeCloseTo(17.5, 2)
  })

  it('an existing row can be amended and deleted after the month is recorded', async () => {
    // The 0116 trigger refused amount-UPDATE and DELETE outright.
    const id = await seedSpend('10.000000')
    await close()
    await t.client`UPDATE actual_spend SET cost_usd = 12.5 WHERE id = ${id}::uuid`
    await t.client`DELETE FROM actual_spend WHERE id = ${id}::uuid`
    const [{ n }] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM actual_spend`
    expect(n).toBe('0')
  })

  it('governance recompute reaches a recorded month', async () => {
    /*
     * `recomputeGovernanceVerdicts` used to structurally exclude closed months,
     * so a rule change could never touch them. That protected our own
     * classification by making the product unable to correct it — and a recorded
     * month is exactly where a correction matters, being the one somebody read.
     */
    await seedSpend('10.000000')
    await close()

    const r = await t.db.transaction((tx) =>
      recomputeGovernanceVerdicts(tx, { periodMonth: '2026-04-01' }),
    )

    /*
     * SCANNED, not the verdict value. What changed is REACHABILITY: the
     * candidate query used to `LEFT JOIN finance_period … state = 'open'`, so a
     * recorded month returned zero candidates and no rule change could ever
     * touch it. Whether a given row then flips depends on the governance config
     * this fixture would have to replicate exactly; that is verdict.ts's own
     * business and it has its own tests.
     *
     * Mutation-proof in the direction that matters: restore the exclusion and
     * this is 0.
     */
    expect(r.scanned).toBeGreaterThan(0)
  })
})

describe('the delta', () => {
  it('reports a chargeable movement against what was recorded', async () => {
    await seedSpend('10.000000')
    await close()
    await seedSpend('5.000000')

    const d = (await reportingSnapshotDelta(t.db, MONTH))!
    expect(d.chargeableUnchanged).toBe(false)
    expect(d.snapshot.chargeableUsd).toBeCloseTo(10, 2)
    expect(d.current.chargeableUsd).toBeCloseTo(15, 2)
    expect(d.deltaUsd!.chargeable).toBeCloseTo(5, 2)
  })

  it('a verdict flip shows up even though neither total moved on its own', async () => {
    // $10 chargeable → $10 exempt. Attributed is untouched and chargeable falls
    // by exactly what exempt gains, which is why exempt is snapshotted at all.
    const id = await seedSpend('10.000000')
    await close()
    await t.client`UPDATE actual_spend SET chargeback_exempt = true WHERE id = ${id}::uuid`

    const d = (await reportingSnapshotDelta(t.db, MONTH))!
    expect(d.chargeableUnchanged).toBe(false)
    expect(d.deltaUsd!.chargeable).toBeCloseTo(-10, 2)
    expect(d.deltaUsd!.exempt).toBeCloseTo(10, 2)
  })

  it('a month that has not moved says so', async () => {
    await seedSpend('10.000000')
    await close()
    const d = (await reportingSnapshotDelta(t.db, MONTH))!
    expect(d.chargeableUnchanged).toBe(true)
    expect(d.deltaUsd!.chargeable).toBeCloseTo(0, 2)
  })

  it('REFUSES to subtract across a basis change, and says why', async () => {
    /*
     * A month recorded under `project-homed` and read under `person-placed` has
     * not moved by the difference — the difference is what changing the question
     * costs. Presenting it as movement would be a confident wrong number, so the
     * figures are returned and only the arithmetic is withheld.
     */
    await seedSpend('10.000000')
    await close()

    const d = (await reportingSnapshotDelta(t.db, MONTH, { currentBasis: 'person-placed' }))!
    expect(d.incomparableReason).toBe('basis-changed')
    expect(d.deltaUsd).toBeNull()
    expect(d.snapshot.chargeableUsd).toBeCloseTo(10, 2) // both still reported
    expect(d.current.chargeableUsd).toBeCloseTo(10, 2)
  })

  it('a LEGACY month reports its figures as absent, not as zero', async () => {
    /*
     * A pre-0128 `finance_period` row stored a state machine and no totals, so
     * the migration's zero defaults would render as "this month read $0.00" —
     * a fabricated figure rather than a missing one. Version 0 is the explicit
     * marker, and it makes the delta incomparable rather than subtracting
     * against invented numbers.
     */
    await seedSpend('10.000000')
    await close()
    await t.client`UPDATE reporting_snapshot SET snapshot_version = 0 WHERE period_month = '2026-04-01'::date`

    const d = (await reportingSnapshotDelta(t.db, MONTH))!
    expect(d.snapshotVersion).toBe(0)
    expect(d.incomparableReason).toBe('version-changed')
    expect(d.deltaUsd).toBeNull()
    expect(d.current.chargeableUsd).toBeCloseTo(10, 2) // what it reads NOW is still real
  })

  it('a month with no snapshot has no delta', async () => {
    expect(await reportingSnapshotDelta(t.db, MONTH)).toBeNull()
  })
})
