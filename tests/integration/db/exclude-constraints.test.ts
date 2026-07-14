/*
 * EXCLUDE-USING-gist constraint tests.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 2 testing: "EXCLUDE constraints
 * fire on overlap". We assert overlap on the constraint that bites
 * earliest in production — allocation (per-project budget overlaps).
 * The pattern transfers to rate_card / limit_policy / tier_assignment /
 * spill_record per data-model.md (all use the same EXCLUDE shape).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('EXCLUDE USING gist on allocation', () => {
  it('rejects overlapping allocations for the same project + kind', async () => {
    // Bootstrap minimal seed for the FKs.
    const [region] = await t.client<{ id: string }[]>`
      INSERT INTO region (code, display_name) VALUES ('test-region', 'Test') RETURNING id
    `
    const [orgUnit] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, path, code, display_name, unit_type)
      VALUES (${region!.id}, 'test'::ltree, 'test-unit', 'Test Unit', 'bu')
      RETURNING id
    `
    const [project] = await t.client<{ id: string }[]>`
      INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES ('TEST-EXC', 'h-test-exc', 'Test', 'internal', ${region!.id}, ${orgUnit!.id})
      RETURNING id
    `
    const [event] = await t.client<{ id: string }[]>`
      INSERT INTO audit_event (event_type, actor_system, payload)
      VALUES ('test', 'test', '{}'::jsonb) RETURNING id
    `

    await t.client`
      INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
      VALUES ('project', ${project!.id}, 1000.00, '[2026-05-01, 2026-06-01)'::tstzrange, 'baseline', ${event!.id})
    `

    await expect(
      t.client`
        INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
        VALUES ('project', ${project!.id}, 500.00, '[2026-05-15, 2026-06-15)'::tstzrange, 'baseline', ${event!.id})
      `,
    ).rejects.toThrow(/exclusion constraint|conflicting key value|allocation/i)
  })

  it('allows non-overlapping allocations for the same project', async () => {
    const [region] = await t.client<{ id: string }[]>`
      INSERT INTO region (code, display_name) VALUES ('test-region-2', 'Test 2') RETURNING id
    `
    const [orgUnit] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, path, code, display_name, unit_type)
      VALUES (${region!.id}, 'test2'::ltree, 'test-unit-2', 'Test Unit 2', 'bu')
      RETURNING id
    `
    const [project] = await t.client<{ id: string }[]>`
      INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES ('TEST-NEXC', 'h-test-nexc', 'Test', 'internal', ${region!.id}, ${orgUnit!.id})
      RETURNING id
    `
    const [event] = await t.client<{ id: string }[]>`
      INSERT INTO audit_event (event_type, actor_system, payload)
      VALUES ('test', 'test', '{}'::jsonb) RETURNING id
    `

    await t.client`
      INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
      VALUES ('project', ${project!.id}, 1000.00, '[2026-05-01, 2026-06-01)'::tstzrange, 'baseline', ${event!.id})
    `
    // Non-overlapping window AND a different kind both succeed.
    await t.client`
      INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
      VALUES ('project', ${project!.id}, 500.00, '[2026-06-01, 2026-07-01)'::tstzrange, 'baseline', ${event!.id})
    `
    await t.client`
      INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
      VALUES ('project', ${project!.id}, 200.00, '[2026-05-15, 2026-05-20)'::tstzrange, 'top-up', ${event!.id})
    `

    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM allocation WHERE scope_id = ${project!.id}
    `
    expect(Number(rows[0]!.count)).toBe(3)
  })
})
