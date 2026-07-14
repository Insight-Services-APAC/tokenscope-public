// @vitest-environment node
/*
 * Project-lifecycle policy (D9): platform default + region override, the
 * resolver precedence, and the admin endpoints' authorization.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import {
  resolveProjectLifecyclePolicy,
  loadLifecyclePolicyResolver,
} from '../../../server/db/project-lifecycle-policy'
import platformPut from '../../../server/api/v1/admin/settings/project-lifecycle.put'
import platformGet from '../../../server/api/v1/admin/settings/project-lifecycle.get'
import regionPut from '../../../server/api/v1/admin/regions/[id]/project-lifecycle.put'
import regionGet from '../../../server/api/v1/admin/regions/[id]/project-lifecycle.get'
import regionDelete from '../../../server/api/v1/admin/regions/[id]/project-lifecycle.delete'

let t: TestDb
let regionId: string
let ouId: string
let finopsId: string
let adminId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'lp-r', displayName: 'LP R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'lp.svc', code: 'lp-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [f] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-lp-fin', email: 'lp-fin@x.test', role: 'global-finops', regionId, orgUnitId: ouId })
    .returning()
  finopsId = f!.id
  const [a] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-lp-admin', email: 'lp-admin@x.test', role: 'admin', regionId, orgUnitId: ouId })
    .returning()
  adminId = a!.id
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function ev(opts: { method: string; id?: string; body?: unknown; session: Session }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: opts.method,
    path: '/x',
    context: { params: opts.id ? { id: opts.id } : {} },
    node: {
      req: {
        method: opts.method,
        url: '/x',
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
  return e as unknown as Parameters<typeof platformPut>[0]
}

const finops = (): Session => ({ teammateId: finopsId, email: 'lp-fin@x.test', displayName: 'Fin', role: 'global-finops', regionId, orgPath: 'lp.svc' })
const admin = (): Session => ({ teammateId: adminId, email: 'lp-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'lp.svc' })

describe('resolver precedence', () => {
  it('returns the seeded platform default {2,7} when no region override', async () => {
    const p = await resolveProjectLifecyclePolicy(t.db, regionId)
    expect(p).toEqual({ graceHours: 2, warnDays: 7 })
  })

  it('a region override wins over the platform row', async () => {
    await regionPut(ev({ method: 'PUT', id: regionId, body: { grace_hours: 12, warn_days: 14 }, session: admin() }))
    const p = await resolveProjectLifecyclePolicy(t.db, regionId)
    expect(p).toEqual({ graceHours: 12, warnDays: 14 })
    // A different region still inherits the platform default.
    const other = await resolveProjectLifecyclePolicy(t.db, '00000000-0000-0000-0000-000000000000')
    expect(other).toEqual({ graceHours: 2, warnDays: 7 })
    // The batch resolver agrees.
    const fn = await loadLifecyclePolicyResolver(t.db)
    expect(fn(regionId)).toEqual({ graceHours: 12, warnDays: 14 })
  })

  it('clearing the region override reverts to the platform default', async () => {
    await regionDelete(ev({ method: 'DELETE', id: regionId, session: admin() }))
    const p = await resolveProjectLifecyclePolicy(t.db, regionId)
    expect(p).toEqual({ graceHours: 2, warnDays: 7 })
  })
})

describe('platform endpoint authorization', () => {
  it('global-finops can set the platform default; GET reflects it', async () => {
    await platformPut(ev({ method: 'PUT', body: { grace_hours: 4, warn_days: 10 }, session: finops() }))
    const got = (await platformGet(ev({ method: 'GET', session: admin() }))) as {
      platform: { grace_hours: number; warn_days: number }
    }
    expect(got.platform).toEqual({ grace_hours: 4, warn_days: 10 })
  })

  it('a region admin cannot set the PLATFORM default (403)', async () => {
    await expect(
      platformPut(ev({ method: 'PUT', body: { grace_hours: 1, warn_days: 1 }, session: admin() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('region GET shows override + effective + platform', () => {
  it('reports null override when inheriting, then the override once set', async () => {
    const before = (await regionGet(ev({ method: 'GET', id: regionId, session: admin() }))) as {
      override: unknown
      effective: { grace_hours: number; warn_days: number }
    }
    expect(before.override).toBeNull()
    expect(before.effective).toEqual({ grace_hours: 4, warn_days: 10 }) // the platform default set above

    await regionPut(ev({ method: 'PUT', id: regionId, body: { grace_hours: 24, warn_days: 3 }, session: admin() }))
    const after = (await regionGet(ev({ method: 'GET', id: regionId, session: admin() }))) as {
      override: { grace_hours: number; warn_days: number } | null
      effective: { grace_hours: number; warn_days: number }
    }
    expect(after.override).toEqual({ grace_hours: 24, warn_days: 3 })
    expect(after.effective).toEqual({ grace_hours: 24, warn_days: 3 })
  })
})

describe('region PUT robustness (API-9 / SYS-1)', () => {
  it('PUT against a non-existent region UUID → 404 (was FK 23503 → 500)', async () => {
    await expect(
      regionPut(
        ev({
          method: 'PUT',
          id: '00000000-0000-0000-0000-000000000001',
          body: { grace_hours: 6, warn_days: 5 },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('PUT with a malformed region id → 400 via requireUuidParam', async () => {
    await expect(
      regionPut(
        ev({
          method: 'PUT',
          id: 'abcdefabcdefabcdefabcdefabcdefabcdef',
          body: { grace_hours: 6, warn_days: 5 },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('repeated PUTs upsert via ON CONFLICT — exactly one region row survives', async () => {
    await regionPut(ev({ method: 'PUT', id: regionId, body: { grace_hours: 8, warn_days: 6 }, session: admin() }))
    await regionPut(ev({ method: 'PUT', id: regionId, body: { grace_hours: 9, warn_days: 7 }, session: admin() }))
    const rows = await t.db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM project_lifecycle_policy
      WHERE scope_type = 'region' AND scope_id = ${regionId}::uuid
    `)
    expect(Number([...rows][0]!.n)).toBe(1)
    const p = await resolveProjectLifecyclePolicy(t.db, regionId)
    expect(p).toEqual({ graceHours: 9, warnDays: 7 })
  })
})
