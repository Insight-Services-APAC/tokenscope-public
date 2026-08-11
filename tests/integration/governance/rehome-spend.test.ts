// @vitest-environment node
/*
 * Migrate — re-homing a project's recorded §A usage onto a new Business Unit.
 *
 * The bug this exists for: `attribution_record.cost_owning_unit_id` is stamped
 * at write time and never refreshed, so a BU owner who corrected their projects
 * in admin watched the page stay at $0.00 while listing those very projects
 * carrying $4,200.20 and annotating each "$0.00 from this cost centre".
 *
 * Every guard below is asserted by OUTCOME, not by reading the SQL. The 2026-08-10
 * external review's whole point was that a guard nobody executes is a comment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { planRehome, applyRehome, RehomePlanStale } from '../../../server/governance/rehome-spend'

let t: TestDb
let regionId = ''
let buOld = ''
let buNew = ''
let projectId = ''
let teammateId = ''
let instanceId = ''

/** Two months back, so "this month" and "an earlier month" are distinguishable. */
const MONTH_NOW = new Date()
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const dayInMonthsAgo = (n: number, day = 15) =>
  isoDay(new Date(Date.UTC(MONTH_NOW.getUTCFullYear(), MONTH_NOW.getUTCMonth() - n, day)))
const monthFloor = (iso: string) => `${iso.slice(0, 7)}-01`

const RECENT = dayInMonthsAgo(0, 2)
const OLDER = dayInMonthsAgo(2, 10)

async function couOf(): Promise<Record<string, number>> {
  const rows = await t.client<{ cou: string | null; n: string }[]>`
    SELECT cost_owning_unit_id::text AS cou, count(*)::text AS n
      FROM attribution_record GROUP BY 1`
  return Object.fromEntries(rows.map((r) => [r.cou ?? 'null', Number(r.n)]))
}

beforeAll(async () => {
  t = await startTestDb()
  ;[{ id: regionId }] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES ('r1', 'R1') RETURNING id::text AS id`
  ;[{ id: buOld }] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'old'::ltree, 'old', 'Old BU', 'bu', true) RETURNING id::text AS id`
  ;[{ id: buNew }] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'new'::ltree, 'new', 'New BU', 'bu', true) RETURNING id::text AS id`
  ;[{ id: teammateId }] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-1', 'a@b.test', 'A', ${regionId}::uuid, ${buNew}::uuid, true) RETURNING id::text AS id`
  ;[{ id: projectId }] = await t.client<{ id: string }[]>`
    INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('P1', 'h1', 'P1', 'internal', ${regionId}::uuid, ${buNew}::uuid) RETURNING id::text AS id`
  ;[{ id: instanceId }] = await t.client<{ id: string }[]>`
    INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${regionId}::uuid, ${buNew}::uuid, 'h', 'P')
    RETURNING instance_id::text AS id`
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
})

/** One usage row stamped with the OLD BU — the shape a correction has to fix. */
async function seedRow(day: string, cost: number) {
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
       tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instanceId}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${buNew}::uuid, ${buOld}::uuid,
            ${projectId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 100, ${cost},
            'tier-1', 'estimated', ${day}::timestamptz, ${'s-' + day + '-' + cost})`
}

async function reset() {
  await t.client`DELETE FROM attribution_record`
  await t.client`DELETE FROM finance_period`
}

describe('Migrate — re-homing recorded usage onto a new Business Unit', () => {
  it('moves the rows, and reports the money it moved', async () => {
    await reset()
    await seedRow(RECENT, 10)
    await seedRow(OLDER, 5)

    const res = await applyRehome(t.db, {
      projectId,
      toCostOwningUnitId: buNew,
      range: { from: 'all', confirmUnbounded: true },
    })

    expect(res.updated).toBe(2)
    expect(res.totalUsd).toBeCloseTo(15, 2)
    expect((await couOf())[buNew]).toBe(2)
    expect((await couOf())[buOld]).toBeUndefined()
  })

  it('a CLOSED period is refused and NAMED — the money stays where it was', async () => {
    /*
     * The point is not merely that it is skipped: silently declining to move
     * money somebody asked to move is its own defect, so the refusal has to be
     * reportable back to the operator.
     */
    await reset()
    await seedRow(RECENT, 10)
    await seedRow(OLDER, 5)
    await t.client`INSERT INTO finance_period (period_month, state) VALUES (${monthFloor(OLDER)}::date, 'closed')`

    const res = await applyRehome(t.db, {
      projectId,
      toCostOwningUnitId: buNew,
      range: { from: 'all', confirmUnbounded: true },
    })

    expect(res.updated).toBe(1)
    expect(res.refused).toEqual([
      expect.objectContaining({ periodMonth: monthFloor(OLDER), reason: 'closed-period', rows: 1 }),
    ])
    // The closed row is still on the OLD BU — proof by data, not by predicate.
    const rows = await t.client<{ cou: string; day: string }[]>`
      SELECT cost_owning_unit_id::text AS cou, (ts_event AT TIME ZONE 'UTC')::date::text AS day
        FROM attribution_record ORDER BY day`
    expect(rows.find((r) => r.day === OLDER)!.cou).toBe(buOld)
    expect(rows.find((r) => r.day === RECENT)!.cou).toBe(buNew)
  })

  it('MUTATION: without the closed-period guard the closed row would move', async () => {
    /*
     * Runs the same scenario with the guard's predicate removed, to prove the
     * assertion above can fail. A guard nobody has watched fail is a comment.
     */
    await reset()
    await seedRow(OLDER, 5)
    await t.client`INSERT INTO finance_period (period_month, state) VALUES (${monthFloor(OLDER)}::date, 'closed')`

    await t.client`UPDATE attribution_record SET cost_owning_unit_id = ${buNew}::uuid
                    WHERE project_id = ${projectId}::uuid` // the un-guarded write
    expect((await couOf())[buNew]).toBe(1)

    // …and the guarded one leaves it alone.
    await t.client`UPDATE attribution_record SET cost_owning_unit_id = ${buOld}::uuid`
    const res = await applyRehome(t.db, {
      projectId,
      toCostOwningUnitId: buNew,
      range: { from: 'all', confirmUnbounded: true },
    })
    expect(res.updated).toBe(0)
    expect((await couOf())[buOld]).toBe(1)
  })

  it('honours a date floor — earlier months are simply out of range', async () => {
    await reset()
    await seedRow(RECENT, 10)
    await seedRow(OLDER, 5)

    const res = await applyRehome(t.db, {
      projectId,
      toCostOwningUnitId: buNew,
      range: { from: monthFloor(RECENT) },
    })
    expect(res.updated).toBe(1)
    // Out of range is NOT a refusal: nothing was declined, it was never asked for.
    expect(res.refused).toEqual([])
    expect((await couOf())[buOld]).toBe(1)
  })

  it('bumps ts_recorded, so the rollup worker can see the restatement', async () => {
    /*
     * The incremental rollup window keys on `ts_recorded`. Moving the BU without
     * bumping it leaves the aggregates carrying the old BU while the ledger
     * carries the new one — the exact silent-divergence class this whole page
     * is about. (External review 2026-08-10, HIGH 7.)
     */
    await reset()
    await seedRow(OLDER, 5)
    await t.client`UPDATE attribution_record SET ts_recorded = now() - interval '30 days'`
    const [before] = await t.client<{ ts: string }[]>`SELECT ts_recorded::text AS ts FROM attribution_record`

    await applyRehome(t.db, {
      projectId,
      toCostOwningUnitId: buNew,
      range: { from: 'all', confirmUnbounded: true },
    })

    const [after] = await t.client<{ ts: string }[]>`SELECT ts_recorded::text AS ts FROM attribution_record`
    expect(new Date(after!.ts).getTime()).toBeGreaterThan(new Date(before!.ts).getTime())
  })

  it('a stale preview token refuses rather than writing a set nobody saw', async () => {
    await reset()
    await seedRow(RECENT, 10)
    const plan = await planRehome(t.db, {
      projectId,
      toCostOwningUnitId: buNew,
      range: { from: 'all', confirmUnbounded: true },
    })

    // Ingest lands between preview and apply.
    await seedRow(RECENT, 99)

    await expect(
      applyRehome(t.db, {
        projectId,
        toCostOwningUnitId: buNew,
        range: { from: 'all', confirmUnbounded: true },
        expectToken: plan.token,
      }),
    ).rejects.toBeInstanceOf(RehomePlanStale)

    // Nothing moved.
    expect((await couOf())[buOld]).toBe(2)
  })

  it('an unchanged plan applies under its own token', async () => {
    await reset()
    await seedRow(RECENT, 10)
    const plan = await planRehome(t.db, {
      projectId,
      toCostOwningUnitId: buNew,
      range: { from: 'all', confirmUnbounded: true },
    })
    const res = await applyRehome(t.db, {
      projectId,
      toCostOwningUnitId: buNew,
      range: { from: 'all', confirmUnbounded: true },
      expectToken: plan.token,
    })
    expect(res.updated).toBe(1)
  })

  it('is idempotent — a second run moves nothing and claims nothing', async () => {
    await reset()
    await seedRow(RECENT, 10)
    const opts = {
      projectId,
      toCostOwningUnitId: buNew,
      range: { from: 'all' as const, confirmUnbounded: true as const },
    }
    expect((await applyRehome(t.db, opts)).updated).toBe(1)
    const second = await applyRehome(t.db, opts)
    expect(second.updated).toBe(0)
    expect(second.totalUsd).toBe(0)
  })

  it('planRehome writes nothing', async () => {
    await reset()
    await seedRow(RECENT, 10)
    await planRehome(t.db, {
      projectId,
      toCostOwningUnitId: buNew,
      range: { from: 'all', confirmUnbounded: true },
    })
    expect((await couOf())[buOld]).toBe(1)
  })
})
