// @vitest-environment node
/*
 * The project axis's rollup source (usage-rollup-lane.md R5b.2) — proof that
 * `projectAxisRows` returns THE SAME rows from `usage_rollup_daily` as from
 * `v_complete_usage` once the worker has run, including the provisional
 * filter's NULL semantics.
 *
 * The identity_state fixture matters: arm 1 rows can carry NULL (an unstamped
 * ledger row), and the view projects the literal 'confirmed' on arms 2/3 (mig
 * 0135) — `IS DISTINCT FROM 'provisional'` must include BOTH on BOTH paths,
 * which is only true on the rollup because identity_state is a grain column
 * (mig 0138): a mixed provisional/confirmed day splits into two cells and the
 * filter drops exactly the provisional one.
 *
 * Also pinned: the rollup path really READS the rollup (a lane write invisible
 * until the next refresh — the R5b.4 freshness residual, asserted rather than
 * assumed), and the UTC-midnight window assertion at the integration seam.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup, rebuildUsageRollup } from '../helpers/usage-rollup'
import {
  completeProjectAxisSpend,
  completeProjectAxisPopulation,
} from '../../../server/usage/complete-spend'

let t: TestDb
let regionId = ''
let ccId = ''
let tmId = ''
let instId = ''
let projId = ''

const WINDOW = { startIso: '2026-09-10T00:00:00.000Z', endIso: '2026-09-12T00:00:00.000Z' }

beforeAll(async () => {
  t = await startTestDb()
  const c = t.client

  await c`INSERT INTO region (code, display_name) VALUES ('rax', 'Rollup Axis Region')`
  ;[{ id: regionId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='rax'`
  await c`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'rax'::ltree, 'rax-cc', 'RAX CC', 'practice', true)`
  ;[{ id: ccId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='rax-cc'`
  await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
    VALUES ('oid-x@rax.test', 'x@rax.test', 'x@rax.test', ${regionId}::uuid, ${ccId}::uuid)`
  ;[{ id: tmId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='x@rax.test'`
  await c`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'oid-x@rax.test', ${tmId}::uuid, 'claude-code', ${regionId}::uuid, ${ccId}::uuid, 'h', 'AX')`
  ;[{ id: instId }] = await c<{ id: string }[]>`
    SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${tmId}::uuid`
  await c`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PROJ-AX1', 'hash-PROJ-AX1', 'PROJ-AX1', 'billable', ${regionId}::uuid, ${ccId}::uuid)`
  ;[{ id: projId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='PROJ-AX1'`

  const ar = async (
    day: string,
    usd: number,
    conv: string,
    identity: string | null,
    project: string | null,
    cou: string | null,
  ) => {
    await c`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
         token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id, identity_state)
      VALUES (${instId}::uuid, ${tmId}::uuid, ${regionId}::uuid, ${ccId}::uuid, ${cou}::uuid, ${project}::uuid,
              'claude-code', 'claude-sonnet-4-6', 'input', 1000, ${usd}, 'tier-1', 'estimated',
              (${day}::date::timestamp AT TIME ZONE 'UTC') + interval '9 hours', ${conv}, ${identity})`
  }
  // NULL identity (the unstamped arm-1 shape) — the provisional filter must
  // INCLUDE it on both paths.
  await ar('2026-09-10', 10, 'conv-ax-null', null, projId, ccId)
  // Provisional — dropped by the filter on both paths; same (day, project) key
  // as the NULL row, so a rollup grain WITHOUT identity_state could not
  // separate them.
  await ar('2026-09-10', 5, 'conv-ax-prov', 'provisional', projId, ccId)
  // Confirmed, on the LAST day the half-open window admits — an off-by-one in
  // the day translation loses exactly this dollar amount.
  await ar('2026-09-11', 2, 'conv-ax-edge', 'confirmed', projId, ccId)
  // Confirmed and UNTAGGED (no project, no burn home) — the untagged bucket.
  await ar('2026-09-10', 1.25, 'conv-ax-untag', 'confirmed', null, null)
  // OUTSIDE the window (the exclusive end day) — both paths must exclude it.
  await ar('2026-09-12', 100, 'conv-ax-out', 'confirmed', projId, ccId)
  // Arm 2 (api-reconciled), TAGGED to the project — 'confirmed' by
  // construction on the view (mig 0135), so it survives the filter.
  await c`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source, project_id)
    VALUES (${tmId}::uuid, ${regionId}::uuid, ${ccId}::uuid, '2026-09-10'::date, 'claude-code', 3, 6000, 'api-reconciled', ${projId}::uuid)`

  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('projectAxisRows: view ≡ rollup (R5b.2)', () => {
  it('identical rows from both sources with the filter OFF', async () => {
    const view = await completeProjectAxisSpend(t.db, WINDOW, { scope: sql`TRUE` })
    const rollup = await completeProjectAxisSpend(t.db, WINDOW, {
      scope: sql`TRUE`,
      source: 'rollup',
    })
    expect(rollup).toEqual(view)
    const p1 = rollup.find((r) => r.projectId === projId)!
    expect(p1.costUsd).toBe(20) // 10 (NULL) + 5 (provisional) + 2 (edge day) + 3 (arm 2)
    const untagged = rollup.find((r) => r.projectId === null)!
    expect(untagged.costUsd).toBe(1.25)
  })

  it('excludeProvisional drops EXACTLY the provisional cell on both paths — NULL identity stays', async () => {
    const view = await completeProjectAxisSpend(t.db, WINDOW, {
      scope: sql`TRUE`,
      excludeProvisional: true,
    })
    const rollup = await completeProjectAxisSpend(t.db, WINDOW, {
      scope: sql`TRUE`,
      excludeProvisional: true,
      source: 'rollup',
    })
    expect(rollup).toEqual(view)
    const p1 = rollup.find((r) => r.projectId === projId)!
    // 10 (NULL identity — INCLUDED) + 2 + 3; the $5 provisional cell is gone.
    expect(p1.costUsd).toBe(15)
  })

  it('the population variant agrees under the Business-Unit clamp (the cost-centres.ts shape)', async () => {
    const scope = sql`( p.cost_owning_unit_id = ${ccId}::uuid
                        OR (u.project_id IS NULL AND u.cost_owning_unit_id = ${ccId}::uuid) )`
    const view = await completeProjectAxisPopulation(t.db, WINDOW, {
      scope,
      excludeProvisional: true,
    })
    const rollup = await completeProjectAxisPopulation(t.db, WINDOW, {
      scope,
      excludeProvisional: true,
      source: 'rollup',
    })
    expect(rollup).toEqual(view)
    expect(rollup.find((r) => r.projectId === projId)!.costUsd).toBe(15)
  })

  it("source: 'rollup' really reads the rollup — a lane write is invisible until the next refresh (R5b.4)", async () => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
         token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id, identity_state)
      VALUES (${instId}::uuid, ${tmId}::uuid, ${regionId}::uuid, ${ccId}::uuid, ${ccId}::uuid, ${projId}::uuid,
              'claude-code', 'claude-sonnet-4-6', 'input', 1000, 50, 'tier-1', 'estimated',
              '2026-09-10T12:00:00Z'::timestamptz, 'conv-ax-late', 'confirmed')`
    const view = await completeProjectAxisSpend(t.db, WINDOW, { scope: sql`TRUE` })
    const rollup = await completeProjectAxisSpend(t.db, WINDOW, {
      scope: sql`TRUE`,
      source: 'rollup',
    })
    expect(view.find((r) => r.projectId === projId)!.costUsd).toBe(70) // sees the write
    expect(rollup.find((r) => r.projectId === projId)!.costUsd).toBe(20) // lags ≤ one cadence

    // Refreshed, the two sources agree again — the residual self-heals.
    await rebuildUsageRollup(t.db)
    const healed = await completeProjectAxisSpend(t.db, WINDOW, {
      scope: sql`TRUE`,
      source: 'rollup',
    })
    expect(healed).toEqual(view)
  })

  it('non-midnight window bounds THROW on the rollup path and pass on the view path', async () => {
    const skewed = { startIso: WINDOW.startIso, endIso: '2026-09-11T17:30:00.000Z' }
    await expect(
      completeProjectAxisSpend(t.db, skewed, { scope: sql`TRUE`, source: 'rollup' }),
    ).rejects.toThrow(/UTC-midnight/)
    // The view path takes the instant literally — no assertion, no throw.
    await expect(
      completeProjectAxisSpend(t.db, skewed, { scope: sql`TRUE` }),
    ).resolves.toBeDefined()
  })
})
