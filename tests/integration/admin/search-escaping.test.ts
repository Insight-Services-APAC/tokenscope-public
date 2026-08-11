// @vitest-environment node
/*
 * ILIKE-escaping across the admin search typeaheads, and the teammate-search
 * region clamp.
 *
 * WHY THIS FILE EXISTS. `q` is a caller-supplied free-text search term wrapped
 * `%${q}%` and bound into an ILIKE. Without escaping, `%` and `_` in `q` are
 * LIKE wildcards, not literal characters: a search for the literal string "%"
 * or "_" would match EVERY row instead of only rows that literally contain
 * that character — a broken/unescaped search silently returns the whole
 * roster rather than the (correct) empty result. `server/utils/sql-like.ts`'s
 * `escapeLikeLiteral` is what prevents that, at all three typeahead sites:
 * teammates.get.ts, users/index.get.ts, and
 * reconciliation/github/teammate-search.get.ts.
 *
 * The teammate-search route ALSO gets its own region-clamp case here: unlike
 * the other two (which already had requireRegionScope), it used to be
 * deliberately global — this pins that a region-scoped admin now sees only
 * their own region, while global-finops keeps the estate-wide picker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import teammatesHandler from '../../../server/api/v1/admin/teammates.get'
import usersHandler from '../../../server/api/v1/admin/users/index.get'
import teammateSearchHandler from '../../../server/api/v1/admin/reconciliation/github/teammate-search.get'

let t: TestDb
let regionAId: string
let regionBId: string
let ouAId: string
let ouBId: string

function ev(opts: { session: Session; query: Record<string, string>; path: string }) {
  const qs = `?${new URLSearchParams(opts.query).toString()}`
  const headers: Record<string, string> = {}
  const e = {
    path: `${opts.path}${qs}`,
    node: {
      req: {
        method: 'GET',
        url: `${opts.path}${qs}`,
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
  return e as never
}

const regionAAdmin = (): Session =>
  ({ teammateId: '00000000-0000-0000-0000-0000000000a1', email: 'se-admin-a@x.test', displayName: 'Admin A', role: 'admin', regionId: regionAId, orgPath: 'se-a' }) as Session
const globalFinops = (): Session =>
  ({ teammateId: '00000000-0000-0000-0000-0000000000f1', email: 'se-finops@x.test', displayName: 'Finops', role: 'global-finops', regionId: regionAId, orgPath: 'se-a' }) as Session

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [ra] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('se-a', 'SE A') RETURNING id::text AS id`
  regionAId = ra!.id
  const [rb] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('se-b', 'SE B') RETURNING id::text AS id`
  regionBId = rb!.id
  const [oa] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type) VALUES (${regionAId}::uuid, NULL, 'se_a'::ltree, 'default', 'SE A', 'bu') RETURNING id::text AS id`
  ouAId = oa!.id
  const [ob] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type) VALUES (${regionBId}::uuid, NULL, 'se_b'::ltree, 'default', 'SE B', 'bu') RETURNING id::text AS id`
  ouBId = ob!.id

  // Deliberately NEITHER `%` NOR `_` in any name or email — a broken escape
  // would make these match a search for the literal wildcard character.
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role)
    VALUES
      ('se-oid-a1', 'alice.anders@example.com', 'Alice Anders', ${regionAId}::uuid, ${ouAId}::uuid, 'developer'),
      ('se-oid-a2', 'bob.baker@example.com', 'Bob Baker', ${regionAId}::uuid, ${ouAId}::uuid, 'developer'),
      ('se-oid-b1', 'carol.chen@example.com', 'Carol Chen', ${regionBId}::uuid, ${ouBId}::uuid, 'developer')`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('ILIKE escaping — a literal wildcard character in q matches nothing, not everything', () => {
  for (const q of ['%', '_']) {
    it(`GET /admin/teammates?q=${q} — returns no rows (roster contains neither character)`, async () => {
      const res = (await teammatesHandler(
        ev({ session: regionAAdmin(), path: '/api/v1/admin/teammates', query: { region: regionAId, q } }),
      )) as { teammates: unknown[]; total: number }
      expect(res.teammates).toEqual([])
      expect(res.total).toBe(0)
    })

    it(`GET /admin/users?q=${q} — returns no rows (roster contains neither character)`, async () => {
      const res = (await usersHandler(
        ev({ session: regionAAdmin(), path: '/api/v1/admin/users', query: { region: regionAId, q } }),
      )) as { users: unknown[]; total: number }
      expect(res.users).toEqual([])
      expect(res.total).toBe(0)
    })

    it(`GET /admin/reconciliation/github/teammate-search?q=${q} — returns no rows (roster contains neither character)`, async () => {
      const res = (await teammateSearchHandler(
        ev({ session: globalFinops(), path: '/api/v1/admin/reconciliation/github/teammate-search', query: { q } }),
      )) as { teammates: unknown[] }
      expect(res.teammates).toEqual([])
    })
  }

  it('sanity: a real substring search still finds the right person on all three routes', async () => {
    const t1 = (await teammatesHandler(
      ev({ session: regionAAdmin(), path: '/api/v1/admin/teammates', query: { region: regionAId, q: 'alice' } }),
    )) as { teammates: Array<{ email: string }> }
    expect(t1.teammates.map((r) => r.email)).toContain('alice.anders@example.com')

    const t2 = (await usersHandler(
      ev({ session: regionAAdmin(), path: '/api/v1/admin/users', query: { region: regionAId, q: 'alice' } }),
    )) as { users: Array<{ email: string }> }
    expect(t2.users.map((r) => r.email)).toContain('alice.anders@example.com')

    const t3 = (await teammateSearchHandler(
      ev({ session: globalFinops(), path: '/api/v1/admin/reconciliation/github/teammate-search', query: { q: 'alice' } }),
    )) as { teammates: Array<{ email: string }> }
    expect(t3.teammates.map((r) => r.email)).toContain('alice.anders@example.com')
  })
})

describe('teammate-search — region clamp', () => {
  it('a region-A admin sees only region-A teammates (searching by a broad common substring)', async () => {
    const res = (await teammateSearchHandler(
      ev({ session: regionAAdmin(), path: '/api/v1/admin/reconciliation/github/teammate-search', query: { q: '@example.com' } }),
    )) as { teammates: Array<{ email: string; regionCode: string | null }> }
    const emails = res.teammates.map((r) => r.email)
    expect(emails).toContain('alice.anders@example.com')
    expect(emails).toContain('bob.baker@example.com')
    expect(emails).not.toContain('carol.chen@example.com') // region B — must not be offered
    expect(res.teammates.every((r) => r.regionCode === 'se-a')).toBe(true)
  })

  it('global-finops sees the whole estate — same population the map.post clamp must accept for global-finops too', async () => {
    const res = (await teammateSearchHandler(
      ev({ session: globalFinops(), path: '/api/v1/admin/reconciliation/github/teammate-search', query: { q: '@example.com' } }),
    )) as { teammates: Array<{ email: string }> }
    const emails = res.teammates.map((r) => r.email)
    expect(emails).toContain('alice.anders@example.com')
    expect(emails).toContain('carol.chen@example.com') // region B — visible to global-finops
  })
})
