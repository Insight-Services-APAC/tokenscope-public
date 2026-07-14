// @vitest-environment node
/*
 * GET /api/v1/admin/repos — `total` must be a real COUNT(*) over the
 * region's mappings, not the page size (API-8: with >limit mappings the
 * UI saw total=limit and never paged). Handler-level against
 * testcontainers Postgres (lifecycle-policy.test.ts harness pattern).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import reposGet from '../../../server/api/v1/admin/repos.get'

let t: TestDb
let regionId: string
let ouId: string
let finopsId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [r] = await t.db.insert(schema.region).values({ code: 'rt-r', displayName: 'RT R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'rt.svc', code: 'rt-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [f] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rt-fin', email: 'rt-fin@x.test', role: 'global-finops', regionId, orgUnitId: ouId })
    .returning()
  finopsId = f!.id
  const [p] = await t.db
    .insert(schema.project)
    .values({
      code: 'RT-PRJ',
      codeHash: 'h-rt-prj',
      displayName: 'Repos Total',
      type: 'billable',
      regionId,
      costOwningUnitId: ouId,
    })
    .returning()

  await t.db.insert(schema.repoProjectMap).values(
    ['alpha', 'bravo', 'charlie'].map((name) => ({
      repoProvider: 'github',
      repoFullName: `insight/${name}`,
      projectId: p!.id,
    })),
  )
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function ev(query: string) {
  const session: Session = {
    teammateId: finopsId,
    email: 'rt-fin@x.test',
    displayName: 'Fin',
    role: 'global-finops',
    regionId,
    orgPath: 'rt.svc',
  }
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path: `/x?${query}`,
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url: `/x?${query}`,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers }
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof reposGet>[0]
}

describe('admin/repos total (API-8)', () => {
  it('returns the FULL count as total while the page honours limit', async () => {
    const res = (await reposGet(ev(`region=${regionId}&limit=2&offset=0`))) as {
      repos: unknown[]
      total: number
      limit: number
      offset: number
    }
    expect(res.repos.length).toBe(2)
    expect(res.total).toBe(3) // was 2 (the page size) before the fix
  })

  it('pages past the first page and total stays the full count', async () => {
    const res = (await reposGet(ev(`region=${regionId}&limit=2&offset=2`))) as {
      repos: unknown[]
      total: number
    }
    expect(res.repos.length).toBe(1)
    expect(res.total).toBe(3)
  })
})
