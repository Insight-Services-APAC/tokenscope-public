// @vitest-environment node
/*
 * RegionalScope.scopeKey — the cache key for the month floor.
 *
 * WHY THIS IS AN INTEGRATION TEST. The key exists to stop one scope's floor
 * being served to another, and the floor is enforced server-side as a 400, so a
 * collision does not merely show a wrong picker bound — it REFUSES a caller a
 * month they do have data in.
 *
 * The first version of the key listed the values it believed the predicate
 * used. It missed the ones that matter: managerScopePredicate's manager arm
 * scopes by the RLS session GUCs `app.user_org_path` and (inside
 * placedBelowRegionRootPredicate) `app.user_region_id`, read at execution time
 * rather than closed over (server/auth/org-subtree-scope.ts:145,103). Two
 * managers in ONE region with DIFFERENT subtrees produced different predicates
 * under an identical key.
 *
 * A unit test cannot catch that, because it supplies the keys itself. This one
 * drives the real resolveRegionalScope under real GUCs, which is the only way
 * the omission is visible.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { resolveRegionalScope } from '../../../server/reporting/regional'

let t: TestDb
let regionId = ''
let otherRegionId = ''

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (code, display_name) VALUES ('sk', 'Scope Key'), ('sk2', 'Scope Key 2')`
  ;[{ id: regionId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='sk'`
  ;[{ id: otherRegionId }] =
    await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='sk2'`

  const unit = async (path: string, code: string, region: string) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${code}, 'practice', true)`
  }
  await unit('sk', 'sk-root', regionId)
  await unit('sk.sales', 'sk-sales', regionId)
  await unit('sk.eng', 'sk-eng', regionId)
})

afterAll(async () => {
  await stopTestDb(t)
})

/** Resolve a scope with the RLS GUCs a real request would carry. */
async function scopeKeyFor(orgPath: string, role: string, region: string): Promise<string> {
  return await t.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_org_path', ${orgPath}, true)`)
    await tx.execute(sql`SELECT set_config('app.user_region_id', ${region}, true)`)
    await tx.execute(sql`SELECT set_config('app.user_role', ${role}, true)`)
    const scope = await resolveRegionalScope(tx, { role, regionId: region }, { region: null, ou: null })
    return scope.scopeKey
  })
}

describe('scopeKey separates scopes that resolve to different predicates', () => {
  it('two managers in ONE region with different subtrees do not collide', async () => {
    /*
     * The exact production bug. Both are role=manager in region sk, so every
     * value the old key listed (role, regionId, effectiveRegionId, ou) is
     * identical — but their predicates differ entirely, because the subtree
     * comes from app.user_org_path.
     */
    const sales = await scopeKeyFor('sk.sales', 'manager', regionId)
    const eng = await scopeKeyFor('sk.eng', 'manager', regionId)
    expect(sales).not.toBe(eng)
  })

  it('the same manager resolves to a STABLE key, so the cache still hits', async () => {
    const a = await scopeKeyFor('sk.sales', 'manager', regionId)
    const b = await scopeKeyFor('sk.sales', 'manager', regionId)
    expect(a).toBe(b)
  })

  it('a developer and a manager on one subtree do not collide', async () => {
    // Both map to scopeRole 'manager', so only the GUC role keeps them apart.
    const dev = await scopeKeyFor('sk.sales', 'developer', regionId)
    const mgr = await scopeKeyFor('sk.sales', 'manager', regionId)
    expect(dev).not.toBe(mgr)
  })

  it('the same subtree path in two regions does not collide', async () => {
    const a = await scopeKeyFor('sk.sales', 'manager', regionId)
    const b = await scopeKeyFor('sk.sales', 'manager', otherRegionId)
    expect(a).not.toBe(b)
  })

  it('carries the org path itself, not just a role and region', async () => {
    // A key that omitted the subtree would be identical for every manager in
    // the region; assert the path is genuinely part of the identity.
    const k = await scopeKeyFor('sk.sales', 'manager', regionId)
    expect(k).toContain('sk.sales')
  })
})
