// @vitest-environment node
/*
 * Authorization-scope contract for the rollup + finance surfaces.
 *
 * Security regression for the endpoint sweep: a manager's per-project /
 * week-over-week rollup must not span outside their org subtree.
 * global-finops / admin (org-wide vs region) bypass as designed.
 *
 * These assert the APP-LEVEL predicate (the GUC-reading scope clause in
 * manager.get.ts) — the live gate, since RLS is bypassed here (test connects
 * as the table owner, same as the running app until Epic 10's non-owner role
 * lands).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { withRlsContext } from '../../../server/db/rls'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionAId: string
let regionBId: string
let alphaOuId: string
let betaOuId: string
let gammaOuId: string
let projAId: string
let projGId: string

const A_PATH = 'r1.alpha'
const B_PATH = 'r1.beta'

async function project(code: string, regionId: string, couId: string): Promise<string> {
  const [p] = await t.db
    .insert(schema.project)
    .values({ code, codeHash: 'h-' + code, displayName: code, type: 'billable', regionId, costOwningUnitId: couId })
    .returning({ id: schema.project.id })
  return p!.id
}

beforeAll(async () => {
  t = await startTestDb()

  const [rA, rB] = await t.db
    .insert(schema.region)
    .values([
      { code: 'r1', displayName: 'Region One' },
      { code: 'r2', displayName: 'Region Two' },
    ])
    .returning()
  regionAId = rA!.id
  regionBId = rB!.id

  const [alpha, beta] = await t.db
    .insert(schema.orgUnit)
    .values([
      { regionId: regionAId, path: A_PATH, code: 'alpha', displayName: 'Alpha', unitType: 'practice', isCostOwningUnit: true },
      { regionId: regionAId, path: B_PATH, code: 'beta', displayName: 'Beta', unitType: 'practice', isCostOwningUnit: true },
    ])
    .returning()
  alphaOuId = alpha!.id
  betaOuId = beta!.id
  const [gamma] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionBId, path: 'r2.gamma', code: 'gamma', displayName: 'Gamma', unitType: 'practice', isCostOwningUnit: true })
    .returning()
  gammaOuId = gamma!.id

  const [devA, devB, devG] = await t.db
    .insert(schema.teammate)
    .values([
      { entraOid: 'oid-a', email: 'a@r1.com', displayName: 'A', regionId: regionAId, orgUnitId: alphaOuId },
      { entraOid: 'oid-b', email: 'b@r1.com', displayName: 'B', regionId: regionAId, orgUnitId: betaOuId },
      { entraOid: 'oid-g', email: 'g@r2.com', displayName: 'G', regionId: regionBId, orgUnitId: gammaOuId },
    ])
    .returning()

  projAId = await project('P-A', regionAId, alphaOuId)
  const projBId = await project('P-B', regionAId, betaOuId)
  projGId = await project('P-G', regionBId, gammaOuId)

  const [rc] = await t.db.select({ id: schema.rateCard.id, version: schema.rateCard.version }).from(schema.rateCard).limit(1)
  async function emit(teammateId: string, projectId: string, regionId: string, ouId: string) {
    const sid = randomUUID()
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: sid, principalOid: 'oid-' + sid, teammateId, projectCodeHash: 'h', rawProjectCode: 'X',
      tool: 'claude-code', sessionTokenHash: 'tok-' + sid, tsStart: new Date(), regionId, orgUnitId: ouId, costOwningUnitId: ouId,
    })
    await t.db.insert(schema.attributionRecord).values({
      instanceId: sid, teammateId, projectId, regionId, orgUnitId: ouId, costOwningUnitId: ouId,
      tool: 'claude-code', model: 'claude-opus-4-1', tokenType: 'output', tokens: BigInt(1000), costUsd: '100.000000',
      rateCardId: rc!.id, rateCardVersion: rc!.version, fidelityTier: 'tier-1', costBasis: 'estimated', tsEvent: new Date(),
    })
  }
  await emit(devA!.id, projAId, regionAId, alphaOuId)
  await emit(devB!.id, projBId, regionAId, betaOuId)
  await emit(devG!.id, projGId, regionBId, gammaOuId)
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

/** Run the manager per_project scope clause for a role/orgPath; return project codes. */
async function perProjectCodes(role: string, orgPath: string): Promise<string[]> {
  return withRlsContext(
    t.db as never,
    { userRole: role as never, userOrgPath: orgPath, userRegionId: regionAId, userTeammateId: projAId },
    async (tx) => {
      const rows = await tx.execute<{ code: string }>(sql`
        SELECT p.code AS code
        FROM project p
        WHERE (
          current_setting('app.user_role', true) IN ('admin', 'global-finops')
          OR p.cost_owning_unit_id IN (
            SELECT id FROM org_unit WHERE path <@ current_setting('app.user_org_path', true)::ltree
          )
        )
        ORDER BY p.code
      `)
      return [...rows].map((r) => r.code)
    },
  )
}

describe('manager rollup per_project org-scope', () => {
  it('manager in alpha sees only alpha-owned projects', async () => {
    const codes = await perProjectCodes('manager', A_PATH)
    expect(codes).toEqual(['P-A'])
  })

  it('manager in beta sees only beta-owned projects', async () => {
    const codes = await perProjectCodes('manager', B_PATH)
    expect(codes).toEqual(['P-B'])
  })

  it('admin/global-finops see projects across the org', async () => {
    const codes = await perProjectCodes('admin', A_PATH)
    expect(codes).toEqual(['P-A', 'P-B', 'P-G'])
  })
})
