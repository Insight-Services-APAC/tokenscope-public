// @vitest-environment node
/*
 * privileged-identity-cleanup worker — applies the directory-exclusion policy
 * (mig 0083) retroactively. REPORT by default; destructive apply is gated,
 * capped, and only touches provably-inert developer rows with no standing.
 *
 * Mock directory: dir-oid-0007-cld (upn rtanaka-cld@contoso.onmicrosoft.com)
 * and dir-oid-0008 (upn kwong@contoso.onmicrosoft.com) are onmicrosoft
 * accounts; dir-oid-0001 (sasha.kumar@example.com) is a standard account.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runPrivilegedIdentityCleanup } from '../../../server/workers/privileged-identity-cleanup'

let t: TestDb
let regionId = ''
let unitId = ''

const PATTERN = '*@contoso.onmicrosoft.com'

async function seedPattern(pattern = PATTERN) {
  await t.client`INSERT INTO directory_exclusion_pattern (pattern) VALUES (${pattern})`
}

async function seed(oid: string, opts?: { role?: string; email?: string }): Promise<string> {
  const [r] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source)
    VALUES (${oid}, ${opts?.email ?? oid + '@x.test'}, 'Seed', ${regionId}::uuid, ${unitId}::uuid, ${opts?.role ?? 'developer'}, 'directory')
    RETURNING id::text AS id`
  return r!.id
}

const oidActive = async (id: string) =>
  (await t.client<{ is_active: boolean }[]>`SELECT is_active FROM teammate WHERE id = ${id}::uuid`)[0]!.is_active

beforeAll(async () => {
  delete process.env.NUXT_GRAPH_DIRECTORY_MODE // mock directory
  t = await startTestDb()
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('pc', 'PC') RETURNING id::text AS id`
  regionId = r!.id
  const [u] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit) VALUES (${regionId}::uuid, NULL, 'pc'::ltree, 'default', 'PC', 'bu', true) RETURNING id::text AS id`
  unitId = u!.id
  // Padding: a realistic active population (source='manual' survives beforeEach;
  // entra_oid resolves to null in the mock → never excluded, just counted) so a
  // single candidate is a small fraction and the proportion cap doesn't fire.
  for (let i = 0; i < 15; i++) {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source)
      VALUES (${'pad-' + i}, ${'pad' + i + '@x.test'}, 'Pad', ${regionId}::uuid, ${unitId}::uuid, 'developer', 'manual')`
  }
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM cou_owner`
  await t.client`DELETE FROM region_leader`
  await t.client`DELETE FROM project_assignment`
  await t.client`DELETE FROM teammate WHERE source = 'directory'`
  await t.client`DELETE FROM directory_exclusion_pattern`
})

describe('privileged-identity-cleanup worker (#121)', () => {
  it('FAIL-OPEN: no patterns → does nothing, considers nothing', async () => {
    await seed('dir-oid-0007-cld')
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    expect(res.considered).toBe(0)
    expect(res.cleaned).toBe(0)
  })

  it('REPORT mode (default): counts an excluded inert developer as a candidate, mutates NOTHING', async () => {
    const id = await seed('dir-oid-0007-cld')
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db)
    expect(res.mode).toBe('report')
    expect(res.excluded).toBe(1)
    expect(res.candidates).toBe(1)
    expect(res.cleaned).toBe(0)
    expect(await oidActive(id)).toBe(true) // untouched
  })

  it('APPLY: deactivates an inert excluded developer + closes their (member) assignment', async () => {
    const id = await seed('dir-oid-0007-cld')
    await seedPattern()
    // An open plain-MEMBER assignment is inert attribution → safe to close.
    const [proj] = await t.client<{ id: string }[]>`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id) VALUES ('P1', 'h-p1', 'P1', 'billable', ${regionId}::uuid, ${unitId}::uuid) RETURNING id::text AS id`
    await t.client`INSERT INTO project_assignment (project_id, teammate_id, effective, role) VALUES (${proj!.id}::uuid, ${id}::uuid, tstzrange(now(), NULL), 'member')`
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    expect(res.cleaned).toBe(1)
    expect(await oidActive(id)).toBe(false)
    const [asg] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM project_assignment WHERE teammate_id = ${id}::uuid AND upper_inf(effective)`
    expect(asg!.n).toBe('0') // closed
  })

  it('does NOT touch a standard (non-excluded) account', async () => {
    const id = await seed('dir-oid-0001')
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    expect(res.excluded).toBe(0)
    expect(await oidActive(id)).toBe(true)
  })

  it('FLAGS (never deactivates) an excluded row with an elevated role', async () => {
    const id = await seed('dir-oid-0007-cld', { role: 'admin' })
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    expect(res.excluded).toBe(1)
    expect(res.flagged).toBe(1)
    expect(res.candidates).toBe(0)
    expect(await oidActive(id)).toBe(true)
  })

  it('FLAGS (never deactivates) an excluded developer who ACTIVELY OWNS a cost centre', async () => {
    // Rob's shape: the CLD row owns Cyber Security. Removing an owner leaves a
    // P&L gap a human must fill, so it is flagged, not silently de-owned.
    const id = await seed('dir-oid-0007-cld')
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${unitId}::uuid, ${id}::uuid)`
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    expect(res.flagged).toBe(1)
    expect(res.candidates).toBe(0)
    expect(await oidActive(id)).toBe(true)
    const [own] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM cou_owner WHERE teammate_id = ${id}::uuid AND revoked_at IS NULL`
    expect(own!.n).toBe('1') // ownership untouched
  })

  it('FLAGS (never deactivates) an excluded row that is a region_leader', async () => {
    const id = await seed('dir-oid-0007-cld')
    await t.client`INSERT INTO region_leader (region_id, leader_oid, leader_email) VALUES (${regionId}::uuid, 'dir-oid-0007-cld', 'x@x.test')`
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    expect(res.flagged).toBe(1)
    expect(await oidActive(id)).toBe(true)
  })

  it('CAP: aborts (mutates nothing) when candidates exceed the absolute cap', async () => {
    const ids = [await seed('dir-oid-0007-cld'), await seed('dir-oid-0008')]
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true, cap: { maxAbs: 1, maxPct: 1 } })
    expect(res.candidates).toBe(2)
    expect(res.aborted).toBe(true)
    expect(res.cleaned).toBe(0)
    for (const id of ids) expect(await oidActive(id)).toBe(true)
  })

  it('CAP: aborts on PROPORTION even when the absolute count is small (no dead zone)', async () => {
    // 2 candidates but a low maxPct → proportion trigger fires regardless of the
    // small absolute count (the PCT_FLOOR dead-zone this replaced).
    await seed('dir-oid-0007-cld')
    await seed('dir-oid-0008')
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true, cap: { maxAbs: 100, maxPct: 0.01 } })
    expect(res.aborted).toBe(true)
    expect(res.cleaned).toBe(0)
  })
})
