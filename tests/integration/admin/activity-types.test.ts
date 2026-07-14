// @vitest-environment node
/*
 * Admin activity-tag vocabulary endpoints (docs/design/activity-tagging-attribution.md;
 * the activity_type table from migration 0020):
 *   - GET    /admin/activity-types?region_id  → global + this region's entries
 *   - POST   /admin/activity-types            → add (region addition / global)
 *   - PATCH  /admin/activity-types/:id         → rename / reorder / (de)activate
 *
 * Authz contract:
 *   - a region admin creates a REGION tag in their own region (ok)
 *   - a region admin CANNOT create a GLOBAL tag (region_id null) → 403
 *   - a region admin CANNOT touch ANOTHER region (region_id = B) → 403
 *   - a platform-admin can manage the global set AND any region
 *   - a duplicate label in the same scope → 409 (the partial unique index)
 *   - deactivation (is_active=false) hides the tag from getActivityTypes
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { getActivityTypes } from '../../../server/utils/me-queries'
import { withRlsContext } from '../../../server/db/rls'
import listHandler from '../../../server/api/v1/admin/activity-types/index.get'
import createHandler from '../../../server/api/v1/admin/activity-types/index.post'
import patchHandler from '../../../server/api/v1/admin/activity-types/[id].patch'

let t: TestDb
let regionA: string
let regionB: string
let ouA: string
let adminAId: string
let platformId: string
let devAId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [ra] = await t.db.insert(schema.region).values({ code: 'at-a', displayName: 'AT A' }).returning()
  const [rb] = await t.db.insert(schema.region).values({ code: 'at-b', displayName: 'AT B' }).returning()
  regionA = ra!.id
  regionB = rb!.id

  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionA, path: 'ata.svc', code: 'ata-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouA = ou!.id

  const [admin] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-at-admin', email: 'at-admin@x.test', role: 'admin', regionId: regionA, orgUnitId: ouA })
    .returning()
  adminAId = admin!.id

  const [platform] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-at-platform', email: 'at-platform@x.test', role: 'platform-admin', regionId: regionA, orgUnitId: ouA })
    .returning()
  platformId = platform!.id

  const [dev] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-at-dev', email: 'at-dev@x.test', role: 'developer', regionId: regionA, orgUnitId: ouA })
    .returning()
  devAId = dev!.id
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function ev(opts: { method: string; id?: string; query?: string; body?: unknown; session: Session }) {
  const url = '/x' + (opts.query ? `?${opts.query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: opts.method,
    path: url,
    context: { params: opts.id ? { id: opts.id } : {} },
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
  return e as unknown as Parameters<typeof patchHandler>[0]
}

const adminA = (): Session => ({ teammateId: adminAId, email: 'at-admin@x.test', displayName: 'Admin A', role: 'admin', regionId: regionA, orgPath: 'ata.svc', issuedAt: new Date().toISOString() })
const platformAdmin = (): Session => ({ teammateId: platformId, email: 'at-platform@x.test', displayName: 'Platform', role: 'platform-admin', regionId: regionA, orgPath: 'ata.svc', issuedAt: new Date().toISOString() })

interface TagRow { id: string; region_id: string | null; label: string; is_standard: boolean; sort_order: number; is_active: boolean; scope: 'global' | 'region' }
interface ListResp { region_id: string; activity_types: TagRow[] }

describe('GET — global + region listing', () => {
  it('lists the seeded global set plus region scope, global first', async () => {
    const out = (await listHandler(ev({ method: 'GET', query: `region_id=${regionA}`, session: adminA() }))) as ListResp
    const labels = out.activity_types.map((r) => r.label)
    // The seeded global standards are present.
    expect(labels).toContain('development')
    expect(labels).toContain('research')
    // All seeded rows are global scope.
    const globals = out.activity_types.filter((r) => r.scope === 'global')
    expect(globals.length).toBeGreaterThanOrEqual(6)
    expect(globals.every((r) => r.region_id === null)).toBe(true)
  })
})

describe('POST — create authz (global vs region)', () => {
  it('a region admin creates a region tag in their own region', async () => {
    const out = (await createHandler(
      ev({ method: 'POST', body: { region_id: regionA, label: 'spike' }, session: adminA() }),
    )) as TagRow
    expect(out.scope).toBe('region')
    expect(out.region_id).toBe(regionA)
    // A region addition is non-standard.
    expect(out.is_standard).toBe(false)
  })

  it('a region admin CANNOT create a global tag (403)', async () => {
    await expect(
      createHandler(ev({ method: 'POST', body: { region_id: null, label: 'firmwide' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a region admin CANNOT create in another region (403)', async () => {
    await expect(
      createHandler(ev({ method: 'POST', body: { region_id: regionB, label: 'foreign' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a duplicate label in the same scope is a clean 409', async () => {
    await createHandler(ev({ method: 'POST', body: { region_id: regionA, label: 'dupe' }, session: adminA() }))
    await expect(
      // case-insensitive: 'DUPE' collides with 'dupe' in the same region scope.
      createHandler(ev({ method: 'POST', body: { region_id: regionA, label: 'DUPE' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a platform-admin can create a global tag AND in any region', async () => {
    const g = (await createHandler(
      ev({ method: 'POST', body: { region_id: null, label: 'platform-global' }, session: platformAdmin() }),
    )) as TagRow
    expect(g.scope).toBe('global')
    expect(g.is_standard).toBe(true)

    const b = (await createHandler(
      ev({ method: 'POST', body: { region_id: regionB, label: 'platform-region-b' }, session: platformAdmin() }),
    )) as TagRow
    expect(b.region_id).toBe(regionB)
  })
})

describe('PATCH — rename / reorder / deactivate', () => {
  it('a region admin cannot edit a global standard entry (403)', async () => {
    const rows = await t.client<{ id: string }[]>`SELECT id::text AS id FROM activity_type WHERE region_id IS NULL AND label = 'development'`
    const id = rows[0]!.id
    await expect(
      patchHandler(ev({ method: 'PATCH', id, body: { label: 'dev' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a region admin cannot edit ANOTHER region\'s entry (403, authz from the row\'s region)', async () => {
    // platform-admin seeds a region-B tag; admin A (region A) must not touch it.
    const bRow = (await createHandler(
      ev({ method: 'POST', body: { region_id: regionB, label: 'b-only-task' }, session: platformAdmin() }),
    )) as TagRow
    await expect(
      patchHandler(ev({ method: 'PATCH', id: bRow.id, body: { label: 'hijacked' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      patchHandler(ev({ method: 'PATCH', id: bRow.id, body: { is_active: false }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('renaming to an existing label in scope is a 409', async () => {
    await createHandler(ev({ method: 'POST', body: { region_id: regionA, label: 'alpha' }, session: adminA() }))
    const out = (await createHandler(ev({ method: 'POST', body: { region_id: regionA, label: 'beta' }, session: adminA() }))) as TagRow
    await expect(
      patchHandler(ev({ method: 'PATCH', id: out.id, body: { label: 'alpha' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('deactivation hides the tag from getActivityTypes (the picker reader)', async () => {
    const created = (await createHandler(
      ev({ method: 'POST', body: { region_id: regionA, label: 'hideme' }, session: adminA() }),
    )) as TagRow

    const before = await withRlsContext(
      t.db as never,
      { userRegionId: regionA, userOrgPath: 'ata.svc', userRole: 'developer', userTeammateId: devAId },
      (tx) => getActivityTypes(tx, regionA, devAId),
    )
    expect(before.some((a) => a.label.toLowerCase() === 'hideme')).toBe(true)

    await patchHandler(ev({ method: 'PATCH', id: created.id, body: { is_active: false }, session: adminA() }))

    const after = await withRlsContext(
      t.db as never,
      { userRegionId: regionA, userOrgPath: 'ata.svc', userRole: 'developer', userTeammateId: devAId },
      (tx) => getActivityTypes(tx, regionA, devAId),
    )
    expect(after.some((a) => a.label.toLowerCase() === 'hideme')).toBe(false)

    // Reactivation restores it.
    await patchHandler(ev({ method: 'PATCH', id: created.id, body: { is_active: true }, session: adminA() }))
    const restored = await withRlsContext(
      t.db as never,
      { userRegionId: regionA, userOrgPath: 'ata.svc', userRole: 'developer', userTeammateId: devAId },
      (tx) => getActivityTypes(tx, regionA, devAId),
    )
    expect(restored.some((a) => a.label.toLowerCase() === 'hideme')).toBe(true)
  })

  it('reorder via sort_order updates the row', async () => {
    const created = (await createHandler(
      ev({ method: 'POST', body: { region_id: regionA, label: 'orderme', sort_order: 5 }, session: adminA() }),
    )) as TagRow
    const out = (await patchHandler(
      ev({ method: 'PATCH', id: created.id, body: { sort_order: 99 }, session: adminA() }),
    )) as TagRow
    expect(out.sort_order).toBe(99)
  })
})

describe('GET — region admin cannot view another region', () => {
  it('a region admin querying region B is forced/blocked to their own region', async () => {
    // region_id is forced to the caller's region for a region admin, so the
    // foreign query param is ignored and the response is region A's view.
    const out = (await listHandler(ev({ method: 'GET', query: `region_id=${regionB}`, session: adminA() }))) as ListResp
    expect(out.region_id).toBe(regionA)
    // No region-B-scoped rows leak.
    expect(out.activity_types.every((r) => r.region_id === null || r.region_id === regionA)).toBe(true)
  })
})
