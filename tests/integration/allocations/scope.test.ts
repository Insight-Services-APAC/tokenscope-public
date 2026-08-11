// @vitest-environment node
/*
 * Epic 12 allocator — org-scope authorization contract.
 *
 * Security regression for the manager privilege-escalation finding: a
 * `manager` must only see/act on allocations whose project's
 * cost_owning_unit is within their own org subtree; admin / global-finops
 * are unbounded. The velocity rollup must not widen past the caller's
 * subtree when an ancestor/root ouId is supplied.
 *
 * Asserts the APP-LEVEL predicate (server/auth/allocation-scope.ts) and
 * the velocity ouscope clamp — these are the live gate. RLS itself is
 * bypassed here because the test connects as the table owner (same as
 * the running app until Epic 10's non-owner role lands), which is exactly
 * why the app-level predicate must carry the boundary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { withRlsContext } from '../../../server/db/rls'
import { allocationScopePredicate } from '../../../server/auth/allocation-scope'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let rootOuId: string
let alphaOuId: string
let betaOuId: string
let mgrAlphaId: string
let devAlphaId: string
let devBetaId: string
let allocAlphaId: string
let allocBetaId: string
// S3 part (c) — a second region, so the region-clamp fix to allocationScopePredicate
// (previously `role IN ('admin','global-finops')` was FULLY unbounded across every
// region) has something to actually clamp against.
let regionBId: string
let allocRegionBId: string

const ROOT_PATH = 'apac'
const ALPHA_PATH = 'apac.alpha'
const BETA_PATH = 'apac.beta'

async function makeAllocation(projectId: string, budget: string): Promise<string> {
  const [evt] = await t.db
    .insert(schema.auditEvent)
    .values({
      eventType: 'allocation-created',
      subjectKind: 'project',
      subjectId: projectId,
      payload: { initial: true },
    })
    .returning({ id: schema.auditEvent.id })
  const [alloc] = await t.db
    .insert(schema.allocation)
    .values({
      scopeType: 'project',
      scopeId: projectId,
      budgetUsd: budget,
      effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
      allocationKind: 'baseline',
      auditEventId: evt!.id,
    })
    .returning({ id: schema.allocation.id })
  return alloc!.id
}

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'apac-s', displayName: 'APAC' })
    .returning()
  regionId = region!.id

  const [root] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: ROOT_PATH, code: 'apac-root', displayName: 'APAC', unitType: 'region' })
    .returning()
  rootOuId = root!.id

  // S3 part (a): alpha/beta are genuine, parented children of `root` — parent_id
  // set (not just a path that LOOKS nested) — so a manager/developer whose own
  // home is alpha/beta passes placedBelowRegionRootPredicate() and this fixture
  // actually exercises the subtree clamp rather than accidentally passing
  // vacuously the way an un-parented "child" would now fail closed.
  const [alpha, beta] = await t.db
    .insert(schema.orgUnit)
    .values([
      { regionId, parentId: rootOuId, path: ALPHA_PATH, code: 'alpha', displayName: 'Alpha', unitType: 'bu' },
      { regionId, parentId: rootOuId, path: BETA_PATH, code: 'beta', displayName: 'Beta', unitType: 'bu' },
    ])
    .returning()
  alphaOuId = alpha!.id
  betaOuId = beta!.id

  const [mgrAlpha, devAlpha, devBeta] = await t.db
    .insert(schema.teammate)
    .values([
      { entraOid: 'oid-mgr-alpha', email: 'mgr.alpha@example.com', displayName: 'Mgr Alpha', regionId, orgUnitId: alphaOuId },
      { entraOid: 'oid-dev-alpha', email: 'dev.alpha@example.com', displayName: 'Dev Alpha', regionId, orgUnitId: alphaOuId },
      { entraOid: 'oid-dev-beta', email: 'dev.beta@example.com', displayName: 'Dev Beta', regionId, orgUnitId: betaOuId },
    ])
    .returning()
  mgrAlphaId = mgrAlpha!.id
  devAlphaId = devAlpha!.id
  devBetaId = devBeta!.id

  const [projAlpha, projBeta] = await t.db
    .insert(schema.project)
    .values([
      { code: 'P-ALPHA', codeHash: 'h-alpha', displayName: 'Alpha Project', type: 'billable', regionId, costOwningUnitId: alphaOuId },
      { code: 'P-BETA', codeHash: 'h-beta', displayName: 'Beta Project', type: 'billable', regionId, costOwningUnitId: betaOuId },
    ])
    .returning()

  allocAlphaId = await makeAllocation(projAlpha!.id, '10000.00')
  allocBetaId = await makeAllocation(projBeta!.id, '20000.00')

  // S3 part (c) — a SECOND region (fixture pattern: tests/integration/admin/
  // region-rbac.test.ts:20-45), so allocationScopePredicate's region clamp has
  // something real to clamp against: before S3, `role IN ('admin','global-finops')`
  // was unbounded across EVERY region, so a region-A admin could see/act on a
  // region-B allocation. This unit is its own genuine (parentless) region root —
  // no test places a manager/developer caller there, so it needs no parent_id.
  const [regionB] = await t.db.insert(schema.region).values({ code: 'emea-s', displayName: 'EMEA' }).returning()
  regionBId = regionB!.id
  const [ouB] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionBId, path: 'emea', code: 'emea-root', displayName: 'EMEA', unitType: 'region' })
    .returning()
  const [projRegionB] = await t.db
    .insert(schema.project)
    .values({ code: 'P-EMEA', codeHash: 'h-emea', displayName: 'EMEA Project', type: 'billable', regionId: regionBId, costOwningUnitId: ouB!.id })
    .returning()
  allocRegionBId = await makeAllocation(projRegionB!.id, '5000.00')

  // Velocity needs attribution rows in the current week for each dev.
  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)
  async function emit(teammateId: string, projectId: string, ouId: string) {
    const sid = randomUUID()
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: sid,
      principalOid: 'oid-' + sid,
      teammateId,
      projectCodeHash: 'h-x',
      rawProjectCode: 'P-X',
      tool: 'claude-code',
      sessionTokenHash: 'tok-' + sid,
      tsStart: new Date(),
      regionId,
      orgUnitId: ouId,
      costOwningUnitId: ouId,
    })
    await t.db.insert(schema.attributionRecord).values({
      instanceId: sid,
      teammateId,
      projectId,
      regionId,
      orgUnitId: ouId,
      costOwningUnitId: ouId,
      tool: 'claude-code',
      model: 'claude-opus-4-1',
      tokenType: 'output',
      tokens: BigInt(1000),
      costUsd: '100.000000',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(),
    })
  }
  await emit(devAlphaId, projAlpha!.id, alphaOuId)
  await emit(devBetaId, projBeta!.id, betaOuId)
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

/** Run the list-scope predicate as a given role/orgPath; return ids seen. */
async function listAllocationIds(role: string, orgPath: string): Promise<string[]> {
  return withRlsContext(
    t.db as never,
    { userRole: role as never, userOrgPath: orgPath, userRegionId: regionId, userTeammateId: mgrAlphaId },
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        SELECT a.id::text AS id
        FROM allocation a
        WHERE ${allocationScopePredicate('a')}
        ORDER BY a.budget_usd::numeric DESC
      `)
      return [...rows].map((r) => r.id)
    },
  )
}

describe('allocation list scope predicate', () => {
  it('manager sees only allocations in their org subtree', async () => {
    const ids = await listAllocationIds('manager', ALPHA_PATH)
    expect(ids).toContain(allocAlphaId)
    expect(ids).not.toContain(allocBetaId)
  })

  it('admin sees allocations across all org units', async () => {
    const ids = await listAllocationIds('admin', ALPHA_PATH)
    expect(ids).toContain(allocAlphaId)
    expect(ids).toContain(allocBetaId)
  })

  it('global-finops sees allocations across all org units', async () => {
    const ids = await listAllocationIds('global-finops', ALPHA_PATH)
    expect(ids).toContain(allocAlphaId)
    expect(ids).toContain(allocBetaId)
  })
})

describe('allocation detail/patch scope predicate', () => {
  it('manager cannot resolve an out-of-scope allocation by id (404 path)', async () => {
    const seen = await withRlsContext(
      t.db as never,
      { userRole: 'manager' as never, userOrgPath: ALPHA_PATH, userRegionId: regionId, userTeammateId: mgrAlphaId },
      async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          SELECT a.id::text AS id
          FROM allocation a
          WHERE a.id = ${allocBetaId}::uuid
            AND ${allocationScopePredicate('a')}
          LIMIT 1
        `)
        return [...rows][0]
      },
    )
    // No row → the handler throws 404 before any UPDATE/INSERT.
    expect(seen).toBeUndefined()
  })

  it('manager CAN resolve an in-scope allocation by id', async () => {
    const seen = await withRlsContext(
      t.db as never,
      { userRole: 'manager' as never, userOrgPath: ALPHA_PATH, userRegionId: regionId, userTeammateId: mgrAlphaId },
      async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          SELECT a.id::text AS id
          FROM allocation a
          WHERE a.id = ${allocAlphaId}::uuid
            AND ${allocationScopePredicate('a')}
          LIMIT 1
        `)
        return [...rows][0]
      },
    )
    expect(seen?.id).toBe(allocAlphaId)
  })
})

describe('allocation scope predicate — region clamp (S3 part c)', () => {
  // Before S3, allocationScopePredicate short-circuited TRUE for role IN
  // ('admin','global-finops') with NO region term at all — a region-A admin could
  // list, count, AND act on a region-B allocation. The fix wraps the region clamp
  // around the ownership check exactly like orgSubtreeScopePredicate; admin stays
  // unbounded WITHIN their own region, never across regions.
  it("a region-A admin's list AND count exclude the region-B allocation", async () => {
    const ids = await listAllocationIds('admin', ALPHA_PATH)
    expect(ids).toContain(allocAlphaId)
    expect(ids).not.toContain(allocRegionBId)

    const count = await withRlsContext(
      t.db as never,
      { userRole: 'admin' as never, userOrgPath: ALPHA_PATH, userRegionId: regionId, userTeammateId: mgrAlphaId },
      async (tx) => {
        const rows = await tx.execute<{ n: string }>(sql`
          SELECT COUNT(*)::text AS n FROM allocation a WHERE ${allocationScopePredicate('a')}
        `)
        return Number([...rows][0]!.n)
      },
    )
    // Exactly alpha + beta — never the region-B allocation (paging count parity
    // with the list, allocations/index.get.ts:48/:55).
    expect(count).toBe(2)
  })

  it('a region-A admin cannot resolve the region-B allocation by id', async () => {
    const seen = await withRlsContext(
      t.db as never,
      { userRole: 'admin' as never, userOrgPath: ALPHA_PATH, userRegionId: regionId, userTeammateId: mgrAlphaId },
      async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          SELECT a.id::text AS id
          FROM allocation a
          WHERE a.id = ${allocRegionBId}::uuid
            AND ${allocationScopePredicate('a')}
          LIMIT 1
        `)
        return [...rows][0]
      },
    )
    // No row → the WRITE handlers ([id].patch.ts, topups.post.ts) 404 before any
    // UPDATE/INSERT — the exact "escalation via cross-region write" this fix closes.
    expect(seen).toBeUndefined()
  })

  it('global-finops sees allocations in BOTH regions (unbounded by design)', async () => {
    const ids = await listAllocationIds('global-finops', ALPHA_PATH)
    expect(ids).toContain(allocAlphaId)
    expect(ids).toContain(allocBetaId)
    expect(ids).toContain(allocRegionBId)
  })
})

/** Run the velocity ouscope clamp for a role/orgPath against a focus ouId. */
async function velocityTeammateEmails(role: string, orgPath: string, ouId: string): Promise<string[]> {
  return withRlsContext(
    t.db as never,
    { userRole: role as never, userOrgPath: orgPath, userRegionId: regionId, userTeammateId: mgrAlphaId },
    async (tx) => {
      const rows = await tx.execute<{ email: string }>(sql`
        WITH ouscope AS (
          SELECT id FROM org_unit
          WHERE path <@ (SELECT path FROM org_unit WHERE id = ${ouId}::uuid)
            AND (
              current_setting('app.user_role', true) IN ('admin', 'global-finops')
              OR path <@ current_setting('app.user_org_path', true)::ltree
            )
        )
        SELECT DISTINCT t.email
        FROM teammate t
        JOIN attribution_record ar ON ar.teammate_id = t.id
        WHERE t.org_unit_id IN (SELECT id FROM ouscope)
      `)
      return [...rows].map((r) => r.email)
    },
  )
}

describe('velocity ouscope subtree clamp', () => {
  it('manager passing the ROOT ouId still only sees their own subtree', async () => {
    const emails = await velocityTeammateEmails('manager', ALPHA_PATH, rootOuId)
    expect(emails).toContain('dev.alpha@example.com')
    expect(emails).not.toContain('dev.beta@example.com')
  })

  it('admin passing the root ouId sees the whole subtree', async () => {
    const emails = await velocityTeammateEmails('admin', ALPHA_PATH, rootOuId)
    expect(emails).toContain('dev.alpha@example.com')
    expect(emails).toContain('dev.beta@example.com')
  })
})
