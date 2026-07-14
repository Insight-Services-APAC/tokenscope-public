// @vitest-environment node
/*
 * J1/J2 (mig 0048) — PM + CC-owner relationship gates, SQL contract.
 *
 * Per the tests/integration/allocations/editor.test.ts pattern: exercise
 * the org-roles helpers and the assignment-role schema directly against
 * testcontainers Postgres — assert the SQL contract, not the Nitro
 * transport. The relationship rows are the LIVE authz path (RLS is inert
 * on the owner connection until Epic 10).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { isProjectManager, getOwnedCostCentreIds } from '../../../server/auth/org-roles'
import { requireProjectMembership } from '../../../server/usage/consumption'

let t: TestDb
let regionId: string
let buId: string
let practiceId: string
let pmId: string
let memberId: string
let ownerId: string
let projectId: string

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db.insert(schema.region).values({ code: 'apac-oj', displayName: 'APAC' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'apacoj.svc', code: 'svc-oj', displayName: 'Services', unitType: 'bu' })
    .returning()
  buId = bu!.id
  const [practice] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      parentId: buId,
      path: 'apacoj.svc.delta',
      code: 'delta-oj',
      displayName: 'Practice Delta',
      unitType: 'practice',
      isCostOwningUnit: true,
    })
    .returning()
  practiceId = practice!.id

  const mk = async (suffix: string) => {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: `oid-${suffix}-oj`,
        email: `${suffix}.oj@example.com`,
        displayName: suffix,
        regionId,
        orgUnitId: practiceId,
      })
      .returning()
    return tm!.id
  }
  pmId = await mk('pm')
  memberId = await mk('member')
  ownerId = await mk('owner')

  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: 'OJ-PRJ',
      codeHash: 'h-oj-prj',
      displayName: 'Org Journey Project',
      type: 'billable',
      regionId,
      costOwningUnitId: practiceId,
    })
    .returning()
  projectId = proj!.id

  await t.db.insert(schema.projectAssignment).values([
    { projectId, teammateId: pmId, effective: '[2026-05-01T00:00:00+00,)', role: 'manager' },
    { projectId, teammateId: memberId, effective: '[2026-05-01T00:00:00+00,)', role: 'member' },
  ])
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('project_assignment.role contract (J2)', () => {
  it('PM with an open manager assignment passes isProjectManager', async () => {
    expect(await isProjectManager(t.db, pmId, projectId)).toBe(true)
  })

  it('plain member does NOT pass isProjectManager', async () => {
    expect(await isProjectManager(t.db, memberId, projectId)).toBe(false)
  })

  it('an ENDED manager assignment does not grant authority', async () => {
    // End the PM's assignment, assert the gate closes, then restore.
    await t.db.execute(sql`
      UPDATE project_assignment
      SET effective = '[2026-05-01T00:00:00+00,2026-05-02T00:00:00+00)'
      WHERE project_id = ${projectId}::uuid AND teammate_id = ${pmId}::uuid
    `)
    expect(await isProjectManager(t.db, pmId, projectId)).toBe(false)
    await t.db.execute(sql`
      UPDATE project_assignment
      SET effective = '[2026-05-01T00:00:00+00,)'
      WHERE project_id = ${projectId}::uuid AND teammate_id = ${pmId}::uuid
    `)
  })

  it('rejects an unknown assignment role at the DB layer (CHECK)', async () => {
    // Drizzle wraps the PG error — the constraint detail lives on `cause`.
    const err = await t.db
      .execute(sql`
        INSERT INTO project_assignment (project_id, teammate_id, effective, role)
        VALUES (${projectId}::uuid, ${ownerId}::uuid, '[2026-05-01T00:00:00+00,)', 'overlord')
      `)
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeTruthy()
    const cause = (err as { cause?: { code?: string; constraint_name?: string } }).cause
    expect(cause?.code).toBe('23514') // check_violation
    expect(cause?.constraint_name).toBe('project_assignment_role_check')
  })
})

describe('requireProjectMembership dual admission (R1 F1 / R2 F1)', () => {
  it('a current member is admitted with access=member', async () => {
    const p = await requireProjectMembership(t.db, memberId, 'OJ-PRJ')
    expect(p?.access).toBe('member')
    expect(p?.region_id).toBe(regionId)
  })

  it('an active CC owner who is NOT a member is admitted with access=cou-owner', async () => {
    await t.db.insert(schema.couOwner).values({ orgUnitId: practiceId, teammateId: ownerId })
    const p = await requireProjectMembership(t.db, ownerId, 'OJ-PRJ')
    expect(p?.access).toBe('cou-owner')
    await t.db.execute(sql`
      UPDATE cou_owner SET revoked_at = now(), revoked_by = ${ownerId}::uuid
      WHERE teammate_id = ${ownerId}::uuid AND revoked_at IS NULL
    `)
  })

  it('a REVOKED owner with no membership gets null (404 posture)', async () => {
    expect(await requireProjectMembership(t.db, ownerId, 'OJ-PRJ')).toBeNull()
  })

  it('membership wins the access label when the caller is both', async () => {
    await t.db.insert(schema.couOwner).values({ orgUnitId: practiceId, teammateId: pmId })
    const p = await requireProjectMembership(t.db, pmId, 'OJ-PRJ')
    expect(p?.access).toBe('member')
    await t.db.execute(sql`
      UPDATE cou_owner SET revoked_at = now(), revoked_by = ${pmId}::uuid
      WHERE teammate_id = ${pmId}::uuid AND revoked_at IS NULL
    `)
  })
})

describe('cou_owner contract (J1)', () => {
  it('active ownership rows resolve; revoked rows do not', async () => {
    await t.db.insert(schema.couOwner).values({ orgUnitId: practiceId, teammateId: ownerId })
    expect(await getOwnedCostCentreIds(t.db, ownerId)).toEqual([practiceId])

    await t.db.execute(sql`
      UPDATE cou_owner SET revoked_at = now(), revoked_by = ${ownerId}::uuid
      WHERE org_unit_id = ${practiceId}::uuid AND teammate_id = ${ownerId}::uuid
    `)
    expect(await getOwnedCostCentreIds(t.db, ownerId)).toEqual([])
  })

  it('re-assignment after revoke is allowed (partial unique is active-only)', async () => {
    await t.db.insert(schema.couOwner).values({ orgUnitId: practiceId, teammateId: ownerId })
    expect(await getOwnedCostCentreIds(t.db, ownerId)).toEqual([practiceId])
  })

  it('duplicate ACTIVE ownership collides on the partial unique index', async () => {
    const err = await t.db
      .insert(schema.couOwner)
      .values({ orgUnitId: practiceId, teammateId: ownerId })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeTruthy()
    const cause = (err as { cause?: { code?: string; constraint_name?: string } }).cause
    expect(cause?.code).toBe('23505') // unique_violation
    expect(cause?.constraint_name).toBe('cou_owner_active_unique')
  })
})
