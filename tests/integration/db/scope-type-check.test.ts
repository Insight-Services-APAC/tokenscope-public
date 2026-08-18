// @vitest-environment node
/*
 * allocation / limit_policy — `scope_type` CHECK constraints (mig 0131, UF-8).
 *
 * `scope_type` was bare TEXT on both tables: a money row could claim any scope axis
 * at all, including one no reader knows about, and every `WHERE scope_type = 'project'`
 * clamp in server/ was the only thing standing between a mis-typed row and a budget
 * figure. The constraint bounds the TYPE TAG to what the code writes. It does NOT tie
 * `scope_id` to anything — the composite FK / region containment is D9.
 *
 * The constraints land `NOT VALID` on purpose: that constrains every future INSERT and
 * UPDATE without scanning what is already there, so the migration cannot fail on a
 * deployed database. The last case here pins that property, because "NOT VALID" is the
 * whole reason this half of UF-8 could ship without a production read — a later hand
 * dropping it to a validating constraint changes the deploy risk of the migration.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'

let t: TestDb
let projectId: string
let teammateId: string
let auditId: string

/** A range per case: allocation's EXCLUDE would otherwise reject on overlap and the
 *  test would pass for the wrong reason. */
let range = 0
function nextRange(): string {
  range += 1
  const lo = String(2000 + range).padStart(4, '0')
  return `[${lo}-01-01, ${lo}-02-01)`
}

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES ('scope-check', 'Scope Check') RETURNING id::text AS id`
  const [orgUnit] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (region_id, path, code, display_name, unit_type)
    VALUES (${region!.id}::uuid, 'scopecheck'::ltree, 'scope-check-unit', 'Scope Check Unit', 'bu')
    RETURNING id::text AS id`
  const [project] = await t.client<{ id: string }[]>`
    INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('SCOPE-CHK', 'h-scope-chk', 'Scope Check', 'internal', ${region!.id}::uuid, ${orgUnit!.id}::uuid)
    RETURNING id::text AS id`
  const [teammate] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
    VALUES ('scope-check-oid', 'scope-check@example.test', 'Scope Check', ${region!.id}::uuid, ${orgUnit!.id}::uuid)
    RETURNING id::text AS id`
  const [audit] = await t.client<{ id: string }[]>`
    INSERT INTO audit_event (event_type, actor_system, payload)
    VALUES ('test', 'test', '{}'::jsonb) RETURNING id::text AS id`
  projectId = project!.id
  teammateId = teammate!.id
  auditId = audit!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

/** Returns the query promise itself (never `await`ed here) so a `.resolves` assertion
 *  sees the inserted row rather than this helper's own `undefined`. */
function insertAllocation(scopeType: string, teammate: string | null = null) {
  return t.client<{ id: string }[]>`
    INSERT INTO allocation (scope_type, scope_id, teammate_id, budget_usd, effective, allocation_kind, audit_event_id)
    VALUES (${scopeType}, ${projectId}::uuid, ${teammate}::uuid, 100.00, ${nextRange()}::tstzrange, 'baseline', ${auditId}::uuid)
    RETURNING id::text AS id`
}

describe('allocation.scope_type', () => {
  it('accepts the value every writer writes', async () => {
    await expect(insertAllocation('project')).resolves.toBeDefined()
  })

  it("accepts 'region' — the other axis this repo writes, and the one the coverage clamp exists for", async () => {
    // tests/integration/reports/usage-budget-coverage.test.ts:301 stamps exactly this
    // row to prove `scope_type = 'project'` keeps a region's budget out of a project's
    // covered bucket. If this ever starts failing, that guard has been deleted with it.
    await expect(insertAllocation('region')).resolves.toBeDefined()
  })

  it("accepts 'teammate' and 'cou' — the canonical domain, not just today's writers", async () => {
    // A review caught the first version of this constraint deriving its domain from
    // CURRENT WRITERS and thereby making a PLANNED write illegal: the Business-Unit
    // epic's S6 ("CoU-scoped allocations get their reader") is about writing 'cou',
    // and Data-Model.md has always listed teammate | project | cou. An implementation
    // gap is not the domain.
    await expect(insertAllocation('teammate')).resolves.toBeDefined()
    await expect(insertAllocation('cou')).resolves.toBeDefined()
  })

  it('REJECTS an axis outside the canonical domain', async () => {
    await expect(insertAllocation('squad')).rejects.toThrow(/allocation_scope_type_check/)
  })

  it('REJECTS a case variant — a silently-invisible row under every lower-case clamp', async () => {
    await expect(insertAllocation('PROJECT')).rejects.toThrow(/allocation_scope_type_check/)
  })

  it('REJECTS empty string', async () => {
    await expect(insertAllocation('')).rejects.toThrow(/allocation_scope_type_check/)
  })

  it('REJECTS an UPDATE onto a bad value, not only an INSERT', async () => {
    // NOT VALID constrains updates too — a row can be legal at birth and illegal after.
    const eff = nextRange()
    const [row] = await t.client<{ id: string }[]>`
      INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
      VALUES ('project', ${projectId}::uuid, 100.00, ${eff}::tstzrange, 'baseline', ${auditId}::uuid)
      RETURNING id::text AS id`
    await expect(
      t.client`UPDATE allocation SET scope_type = 'squad' WHERE id = ${row!.id}::uuid`,
    ).rejects.toThrow(/allocation_scope_type_check/)
  })
})

describe('allocation scope shape — a per-developer cap rides a project or CoU budget', () => {
  it('accepts a teammate cap on a project-scoped row (the shape split.post.ts writes)', async () => {
    await expect(insertAllocation('project', teammateId)).resolves.toBeDefined()
  })

  it("accepts a teammate cap on a 'cou' row — S6's unit budgets take per-dev caps too", async () => {
    await expect(insertAllocation('cou', teammateId)).resolves.toBeDefined()
  })

  it('REJECTS a teammate cap on a region-scoped row', async () => {
    await expect(insertAllocation('region', teammateId)).rejects.toThrow(/allocation_scope_shape_check/)
  })
})

describe('limit_policy.scope_type is deliberately UNCONSTRAINED', () => {
  // No FK on scope_id, and nothing writes this table today — a real uuid stands in.
  const SCOPE = '9a1e0000-0000-4000-8000-000000000131'

  /*
   * The first version of mig 0131 CHECKed this to ('project'), derived from the one
   * value any code mentions. That was wrong twice over: the table has ZERO writers,
   * and velocity-limit-semantics.md:69 proposes a platform -> region -> CoU ->
   * teammate ladder that shares no value with it and is not even representable
   * ('platform' needs a nullable scope_id). Constraining an unsettled domain with no
   * writers encodes a guess. The constraint lands with the ladder.
   */
  it('accepts a scope axis the velocity ladder proposes, because the domain is not settled', async () => {
    await expect(
      t.client`
        INSERT INTO limit_policy (scope_type, scope_id, limit_kind, threshold_usd, effective)
        VALUES ('region', ${SCOPE}::uuid, 'velocity', 500.00, '[2031-01-01, 2031-02-01)'::tstzrange)`,
    ).resolves.toBeDefined()
  })

  it('has no scope_type CHECK at all — pinned, so re-adding one is a deliberate act', async () => {
    const rows = await t.client<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE conname = 'limit_policy_scope_type_check'`
    expect(rows).toHaveLength(0)
  })
})

describe('the constraints are NOT VALID', () => {
  it('neither was validated against existing rows — that is why the migration cannot fail a deploy', async () => {
    const rows = await t.client<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint
      WHERE conname IN (
        'allocation_scope_type_check',
        'allocation_scope_shape_check'
      )
      ORDER BY conname`
    expect(rows.map((r) => r.conname)).toEqual([
      'allocation_scope_shape_check',
      'allocation_scope_type_check',
    ])
    // A hand that later drops NOT VALID (or adds a VALIDATE CONSTRAINT step to the
    // migration) turns this red: that is a deliberate, per-environment operation
    // gated on reading the deployed data first, never a boot-time migration.
    expect(rows.every((r) => r.convalidated === false)).toBe(true)
  })
})
