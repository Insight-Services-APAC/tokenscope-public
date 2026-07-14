// @vitest-environment node
/*
 * ensureRealIdentity — admin-assign-time identity resolution. Against testcontainers Postgres so
 * the adopt UPDATE + the guards run for real. The directory lookup is injected (prod default is the
 * live Graph directory). Proves: a `bill:` placeholder owner is upgraded to a REAL Entra oid (so it
 * stops being invisible to the placement walk); `provisional:` shadows are refused; a same-oid /
 * different-email row is a collision (not a silent retarget); INACTIVE (is_active=false) teammates
 * are refused while a revoked-but-active teammate stays assignable (revoked_at is a session anchor,
 * not offboarding); and the no-op + directory-miss branches.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { ensureRealIdentity, type DirLookup } from '../../../server/auth/ensure-real-identity'
import type { DirectoryUser } from '../../../server/azure/directory'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

let t: TestDb
let regionA = ''
let unitId = ''
let actorId = ''

const dirUser = (oid: string, email: string): DirectoryUser =>
  ({ oid, email, displayName: email.split('@')[0]!, department: null, jobTitle: null, costCenter: null, division: null } as DirectoryUser)
// Resolves any @x.test email to a stable fake oid (`real-<local>`); unknown → null.
const lookup: DirLookup = async (email) => (email.endsWith('@x.test') ? dirUser(`real-${email.split('@')[0]}`, email) : null)

const db = () => t.db as unknown as PostgresJsDatabase<Record<string, unknown>>
const mkTeammate = async (entraOid: string, email: string, opts: { provisional?: boolean; active?: boolean; revoked?: boolean } = {}) => {
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, provisional, is_active, revoked_at)
    VALUES (${entraOid}, ${email}, ${email}, ${regionA}::uuid, ${unitId}::uuid, ${opts.provisional ?? false},
            ${opts.active ?? true}, ${opts.revoked ? new Date().toISOString() : null})`
  const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid=${entraOid}`
  return r!.id
}
const oidOf = async (id: string) => (await t.client<{ o: string }[]>`SELECT entra_oid AS o FROM teammate WHERE id=${id}::uuid`)[0]!.o

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (code, display_name) VALUES ('eri','Eri Region')`
  ;[{ id: regionA }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='eri'`
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionA}::uuid, 'eri.u', 'eri-u', 'Eri U', 'practice', true)`
  ;[{ id: unitId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='eri-u'`
  actorId = await mkTeammate('actor-real-oid', 'actor@x.test')
}, 120_000)
afterAll(async () => { await stopTestDb(t) })

describe('ensureRealIdentity', () => {
  it('a teammate with a real oid is a no-op', async () => {
    const id = await mkTeammate('already-real-oid', 'real1@x.test')
    const r = await ensureRealIdentity(db(), id, actorId, 'test', lookup)
    expect(r).toMatchObject({ teammateId: id, adopted: false })
    expect(await oidOf(id)).toBe('already-real-oid')
  })

  it('adopts a bill: placeholder in place → real oid, directory-sourced, now matchable', async () => {
    const id = await mkTeammate('bill:' + crypto.randomUUID(), 'kat@x.test')
    const r = await ensureRealIdentity(db(), id, actorId, 'test', lookup)
    expect(r).toMatchObject({ teammateId: id, adopted: true })
    expect(await oidOf(id)).toBe('real-kat') // no longer 'bill:%' → visible to loadActiveUnitOwners
    const [row] = await t.client<{ source: string }[]>`SELECT source FROM teammate WHERE id=${id}::uuid`
    expect(row!.source).toBe('directory')
  })

  it('refuses a provisional: shadow (unconfirmed claimed email) → 422, untouched', async () => {
    const id = await mkTeammate('provisional:' + crypto.randomUUID(), 'prov@x.test', { provisional: true })
    await expect(ensureRealIdentity(db(), id, actorId, 'test', lookup)).rejects.toMatchObject({ statusCode: 422 })
    expect(await oidOf(id)).toMatch(/^provisional:/)
  })

  it('directory miss → 422 (will not assign an unconfirmable identity), untouched', async () => {
    const id = await mkTeammate('bill:' + crypto.randomUUID(), 'ghost@nowhere.com')
    await expect(ensureRealIdentity(db(), id, actorId, 'test', lookup)).rejects.toMatchObject({ statusCode: 422 })
    expect(await oidOf(id)).toMatch(/^bill:/)
  })

  it('a different teammate already holds that oid under a DIFFERENT email → 409 collision (no silent retarget)', async () => {
    await mkTeammate('shared-oid', 'someone.else@x.test') // real teammate already on oid 'shared-oid'
    const placeholderId = await mkTeammate('bill:' + crypto.randomUUID(), 'collide@x.test')
    const collidingLookup: DirLookup = async () => dirUser('shared-oid', 'collide@x.test') // resolves to the taken oid
    await expect(ensureRealIdentity(db(), placeholderId, actorId, 'test', collidingLookup)).rejects.toMatchObject({ statusCode: 409 })
    expect(await oidOf(placeholderId)).toMatch(/^bill:/) // placeholder left intact
  })

  it('an INACTIVE teammate (is_active=false) cannot be assigned → 422', async () => {
    const inactive = await mkTeammate('bill:' + crypto.randomUUID(), 'gone@x.test', { active: false })
    await expect(ensureRealIdentity(db(), inactive, actorId, 'test', lookup)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('a revoked-but-ACTIVE teammate CAN be assigned — revoked_at is a session anchor, not offboarding', async () => {
    // A benign role/region change (or revoke-sessions) bumps revoked_at while leaving is_active=TRUE.
    // Such a teammate is a valid employee who simply re-logs-in, so assignment must SUCCEED, not 422.
    const revoked = await mkTeammate('real-revoked-oid', 'revd@x.test', { revoked: true })
    const r = await ensureRealIdentity(db(), revoked, actorId, 'test', lookup)
    expect(r).toMatchObject({ teammateId: revoked, adopted: false })
  })
})
