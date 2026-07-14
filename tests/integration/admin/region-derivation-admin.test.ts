// @vitest-environment node
/*
 * Admin surfaces for org-Entra region derivation (mig 0068;
 * docs/design/org-entra-region-derivation.md):
 *   - region_leader CRUD  — GET/POST /admin/regions/{id}/leaders,
 *                           DELETE …/leaders/{leaderId} (soft-revoke)
 *   - department_to_region CRUD — GET/POST /admin/department-map,
 *                           DELETE …/department-map/{departmentLower}
 *   - region-delete emptiness fix — a region with a leader or a dept-map row
 *     is BLOCKED (clean 409, not a raw 23503 500).
 *
 * Mirrors the activity-types integration test's h3-event harness +
 * injectTestSession; runs against testcontainers Postgres so the real
 * partial-unique index, the upsert, and the FK posture are exercised.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import leadersGet from '../../../server/api/v1/admin/regions/[id]/leaders.get'
import leadersPost from '../../../server/api/v1/admin/regions/[id]/leaders.post'
import leaderDelete from '../../../server/api/v1/admin/regions/[id]/leaders/[leaderId].delete'
import deptMapGet from '../../../server/api/v1/admin/department-map.get'
import deptMapPost from '../../../server/api/v1/admin/department-map.post'
import deptMapDelete from '../../../server/api/v1/admin/department-map/[departmentLower].delete'
import regionDelete from '../../../server/api/v1/admin/regions/[id].delete'

let t: TestDb
let regionA: string
let regionB: string
let ouA: string
let adminAId: string
let platformId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [ra] = await t.db.insert(schema.region).values({ code: 'rd-a', displayName: 'RD A' }).returning()
  const [rb] = await t.db.insert(schema.region).values({ code: 'rd-b', displayName: 'RD B' }).returning()
  regionA = ra!.id
  regionB = rb!.id

  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionA, path: 'rda.svc', code: 'rda-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouA = ou!.id

  const [admin] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rd-admin', email: 'rd-admin@x.test', role: 'admin', regionId: regionA, orgUnitId: ouA })
    .returning()
  adminAId = admin!.id

  const [platform] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rd-platform', email: 'rd-platform@x.test', role: 'platform-admin', regionId: regionA, orgUnitId: ouA })
    .returning()
  platformId = platform!.id
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function ev(opts: {
  method: string
  params?: Record<string, string>
  query?: string
  body?: unknown
  session: Session
}) {
  const url = '/x' + (opts.query ? `?${opts.query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: opts.method,
    path: url,
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method: opts.method,
        url,
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof leadersPost>[0]
}

const adminA = (): Session => ({ teammateId: adminAId, email: 'rd-admin@x.test', displayName: 'Admin A', role: 'admin', regionId: regionA, orgPath: 'rda.svc', issuedAt: new Date().toISOString() })
const platformAdmin = (): Session => ({ teammateId: platformId, email: 'rd-platform@x.test', displayName: 'Platform', role: 'platform-admin', regionId: regionA, orgPath: 'rda.svc', issuedAt: new Date().toISOString() })

interface Leader { id: string; leader_oid: string; leader_email: string; kind: string; display_name: string | null }
interface LeadersResp { leaders: Leader[] }
interface Mapping { department: string; department_lower: string; region_id: string; region_code: string; region_display_name: string }
interface MappingsResp { mappings: Mapping[] }

describe('region_leader — add / list / revoke', () => {
  it('adds a leader, lists it active, then soft-revokes it', async () => {
    const created = (await leadersPost(
      ev({
        method: 'POST',
        params: { id: regionA },
        body: { leader_oid: 'oid-leader-1', leader_email: 'Leader.One@x.test', kind: 'region-svp', display_name: 'Leader One' },
        session: adminA(),
      }),
    )) as Leader
    expect(created.leader_oid).toBe('oid-leader-1')
    // email is normalised to lower-case on store.
    expect(created.leader_email).toBe('leader.one@x.test')

    const listed = (await leadersGet(
      ev({ method: 'GET', params: { id: regionA }, session: adminA() }),
    )) as LeadersResp
    expect(listed.leaders.map((l) => l.leader_oid)).toContain('oid-leader-1')

    const revoked = (await leaderDelete(
      ev({ method: 'DELETE', params: { id: regionA, leaderId: created.id }, session: adminA() }),
    )) as { revoked: boolean }
    expect(revoked.revoked).toBe(true)

    // Gone from the active list.
    const after = (await leadersGet(
      ev({ method: 'GET', params: { id: regionA }, session: adminA() }),
    )) as LeadersResp
    expect(after.leaders.find((l) => l.id === created.id)).toBeUndefined()

    // The audit trail recorded both the assign and the revoke.
    const audit = await t.client<{ event_type: string }[]>`
      SELECT event_type FROM audit_event WHERE event_type IN ('region-leader-assigned','region-leader-revoked')`
    const types = audit.map((a) => a.event_type)
    expect(types).toContain('region-leader-assigned')
    expect(types).toContain('region-leader-revoked')
  })

  it('409s on a duplicate ACTIVE leader oid (partial-unique)', async () => {
    await leadersPost(
      ev({
        method: 'POST',
        params: { id: regionA },
        body: { leader_oid: 'oid-dup', leader_email: 'dup@x.test', kind: 'region-svp' },
        session: adminA(),
      }),
    )
    await expect(
      leadersPost(
        ev({
          method: 'POST',
          params: { id: regionB },
          body: { leader_oid: 'oid-dup', leader_email: 'dup2@x.test', kind: 'region-svp' },
          session: platformAdmin(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a region admin cannot manage another region (403)', async () => {
    await expect(
      leadersPost(
        ev({
          method: 'POST',
          params: { id: regionB },
          body: { leader_oid: 'oid-foreign', leader_email: 'foreign@x.test', kind: 'region-svp' },
          session: adminA(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      leadersGet(ev({ method: 'GET', params: { id: regionB }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('re-assigning the same oid after revoke is allowed (a fresh active row)', async () => {
    const first = (await leadersPost(
      ev({
        method: 'POST',
        params: { id: regionA },
        body: { leader_oid: 'oid-reassign', leader_email: 'r@x.test', kind: 'region-svp' },
        session: adminA(),
      }),
    )) as Leader
    await leaderDelete(ev({ method: 'DELETE', params: { id: regionA, leaderId: first.id }, session: adminA() }))
    const second = (await leadersPost(
      ev({
        method: 'POST',
        params: { id: regionA },
        body: { leader_oid: 'oid-reassign', leader_email: 'r@x.test', kind: 'region-svp' },
        session: adminA(),
      }),
    )) as Leader
    expect(second.id).not.toBe(first.id)
  })
})

describe('department_to_region — upsert / list / delete (GLOBAL roles only)', () => {
  it('upserts (case-insensitive key), re-points on conflict, then deletes', async () => {
    const created = (await deptMapPost(
      ev({ method: 'POST', body: { department: 'Data & AI', region_id: regionA }, session: platformAdmin() }),
    )) as Mapping
    expect(created.department_lower).toBe('data & ai')
    expect(created.region_id).toBe(regionA)

    // Same department, different casing → upsert re-points to region B (one row).
    const re = (await deptMapPost(
      ev({ method: 'POST', body: { department: 'DATA & AI', region_id: regionB }, session: platformAdmin() }),
    )) as Mapping
    expect(re.department_lower).toBe('data & ai')
    expect(re.region_id).toBe(regionB)

    const listed = (await deptMapGet(ev({ method: 'GET', session: platformAdmin() }))) as MappingsResp
    const row = listed.mappings.find((m) => m.department_lower === 'data & ai')
    expect(row).toBeDefined()
    expect(row!.region_id).toBe(regionB)
    expect(row!.region_code).toBe('rd-b')
    // Exactly one row for that key (upsert, not insert).
    expect(listed.mappings.filter((m) => m.department_lower === 'data & ai')).toHaveLength(1)

    const removed = (await deptMapDelete(
      ev({ method: 'DELETE', params: { departmentLower: 'data & ai' }, session: platformAdmin() }),
    )) as { removed: boolean }
    expect(removed.removed).toBe(true)

    const after = (await deptMapGet(ev({ method: 'GET', session: platformAdmin() }))) as MappingsResp
    expect(after.mappings.find((m) => m.department_lower === 'data & ai')).toBeUndefined()
  })

  it('a region-admin is FORBIDDEN — the dept map is org-wide cross-region config (per design)', async () => {
    await expect(
      deptMapPost(ev({ method: 'POST', body: { department: 'Scoped', region_id: regionA }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(deptMapGet(ev({ method: 'GET', session: adminA() }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('deleting a missing department is a clean 404', async () => {
    await expect(
      deptMapDelete(ev({ method: 'DELETE', params: { departmentLower: 'no-such-dept' }, session: platformAdmin() })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('an unknown region_id is a 422', async () => {
    await expect(
      deptMapPost(
        ev({
          method: 'POST',
          body: { department: 'Ghost', region_id: '00000000-0000-0000-0000-000000000000' },
          session: platformAdmin(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('region-delete emptiness — leader / dept-map block the delete (HIGH fix)', () => {
  it('a region with an ACTIVE leader is BLOCKED (409, not a raw 23503)', async () => {
    const [r] = await t.db.insert(schema.region).values({ code: 'rd-leader', displayName: 'RD Leader' }).returning()
    await t.db.insert(schema.regionLeader).values({
      regionId: r!.id,
      leaderOid: 'oid-block',
      leaderEmail: 'block@x.test',
      kind: 'region-svp',
    })
    await expect(
      regionDelete(ev({ method: 'DELETE', params: { id: r!.id }, session: platformAdmin() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a region with a department mapping is BLOCKED (409)', async () => {
    const [r] = await t.db.insert(schema.region).values({ code: 'rd-dept', displayName: 'RD Dept' }).returning()
    await t.db.insert(schema.departmentToRegion).values({
      departmentLower: 'blocking dept',
      department: 'Blocking Dept',
      regionId: r!.id,
    })
    await expect(
      regionDelete(ev({ method: 'DELETE', params: { id: r!.id }, session: platformAdmin() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a region with a REVOKED leader is still BLOCKED (the row keeps the FK)', async () => {
    const [r] = await t.db.insert(schema.region).values({ code: 'rd-revoked', displayName: 'RD Revoked' }).returning()
    await t.db.insert(schema.regionLeader).values({
      regionId: r!.id,
      leaderOid: 'oid-revoked-block',
      leaderEmail: 'rb@x.test',
      kind: 'region-svp',
      revokedAt: new Date(),
    })
    await expect(
      regionDelete(ev({ method: 'DELETE', params: { id: r!.id }, session: platformAdmin() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a truly empty region still deletes', async () => {
    const [r] = await t.db.insert(schema.region).values({ code: 'rd-empty', displayName: 'RD Empty' }).returning()
    const out = (await regionDelete(
      ev({ method: 'DELETE', params: { id: r!.id }, session: platformAdmin() }),
    )) as { deleted: boolean }
    expect(out.deleted).toBe(true)
  })
})
