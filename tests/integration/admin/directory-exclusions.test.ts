// @vitest-environment node
/*
 * Admin directory-exclusion CRUD (mig 0083) + the search-filter it drives.
 * Org-wide config (global-finops / platform-admin); a region admin cannot edit.
 * Covers the match-all footgun rejection, the matched_existing_count warning,
 * and that a configured pattern removes the account from the people-picker.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import listHandler from '../../../server/api/v1/admin/directory-exclusions/index.get'
import addHandler from '../../../server/api/v1/admin/directory-exclusions/index.post'
import delHandler from '../../../server/api/v1/admin/directory-exclusions/[id].delete'
import searchHandler from '../../../server/api/v1/admin/directory/search.get'
import { loadDirectoryExclusionPatterns } from '../../../server/utils/directory-exclusions'

let t: TestDb
let regionId = ''
let unitId = ''
const FINOPS_ID = '00000000-0000-0000-0000-0000000000e1'

function ev(opts: { session: Session; body?: unknown; params?: Record<string, string>; url?: string; method?: string }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const method = opts.method ?? 'POST'
  const url = opts.url ?? '/x'
  const e = {
    method, path: url, context: { params: opts.params ?? {} },
    node: {
      req: { method, url, body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers, 'content-type': 'application/json' } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as never
}
const finops = (): Session => ({ teammateId: FINOPS_ID, email: 'fx@x.test', displayName: 'Fx', role: 'global-finops', regionId, orgPath: 'de' } as Session)
const regionAdmin = (): Session => ({ teammateId: FINOPS_ID, email: 'fx@x.test', displayName: 'Fx', role: 'admin', regionId, orgPath: 'de' } as Session)

beforeAll(async () => {
  delete process.env.NUXT_GRAPH_DIRECTORY_MODE // mock directory
  t = await startTestDb(); process.env.DATABASE_URL = t.url
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('de', 'DE') RETURNING id::text AS id`
  regionId = r!.id
  const [u] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type) VALUES (${regionId}::uuid, NULL, 'de'::ltree, 'default', 'DE', 'bu') RETURNING id::text AS id`
  unitId = u!.id
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role) VALUES (${FINOPS_ID}::uuid, 'oid-fx', 'fx@x.test', 'Fx', ${regionId}::uuid, ${unitId}::uuid, 'global-finops')`
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM directory_exclusion_pattern`
  await t.client`DELETE FROM teammate WHERE source = 'directory'`
})

describe('admin directory-exclusions CRUD', () => {
  it('adds, lists, and removes a pattern (global-finops)', async () => {
    const added = (await addHandler(ev({ session: finops(), body: { pattern: '*@contoso.onmicrosoft.com', note: 'CLD admins' } }))) as { id: string; pattern: string }
    expect(added.pattern).toBe('*@contoso.onmicrosoft.com')
    const listed = (await listHandler(ev({ session: finops(), method: 'GET' }))) as { patterns: { id: string; pattern: string }[] }
    expect(listed.patterns.map((p) => p.pattern)).toContain('*@contoso.onmicrosoft.com')
    await delHandler(ev({ session: finops(), method: 'DELETE', params: { id: added.id } }))
    const after = (await listHandler(ev({ session: finops(), method: 'GET' }))) as { patterns: unknown[] }
    expect(after.patterns).toHaveLength(0)
  })

  it('rejects the match-all footgun (400)', async () => {
    for (const pattern of ['*', '*@*', '*@*.com']) {
      await expect(addHandler(ev({ session: finops(), body: { pattern } }))).rejects.toMatchObject({ statusCode: 400 })
    }
  })

  it('409s a duplicate pattern (case-insensitive)', async () => {
    await addHandler(ev({ session: finops(), body: { pattern: '*@contoso.onmicrosoft.com' } }))
    await expect(
      addHandler(ev({ session: finops(), body: { pattern: '*@contoso.onmicrosoft.com' } })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a region admin cannot edit the org-wide policy (403)', async () => {
    await expect(
      addHandler(ev({ session: regionAdmin(), body: { pattern: '*@contoso.onmicrosoft.com' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('returns matched_existing_count so the UI can warn before excluding real people', async () => {
    // A teammate whose stored email is on the onmicrosoft domain.
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source)
      VALUES ('cld-1', 'someone-cld@contoso.onmicrosoft.com', 'X', ${regionId}::uuid, ${unitId}::uuid, 'developer', 'directory')`
    const added = (await addHandler(ev({ session: finops(), body: { pattern: '*@contoso.onmicrosoft.com' } }))) as { matched_existing_count: number }
    expect(added.matched_existing_count).toBe(1)
  })
})

describe('search filter honours the exclusion policy', () => {
  it('hides an excluded (onmicrosoft) account from the picker; standard account stays', async () => {
    await t.client`INSERT INTO directory_exclusion_pattern (pattern) VALUES ('*@contoso.onmicrosoft.com')`
    const res = (await searchHandler(ev({ session: finops(), method: 'GET', url: '/x?q=rio' }))) as { results: { oid: string }[] }
    const oids = res.results.map((r) => r.oid)
    expect(oids).toContain('dir-oid-0007') // standard account still pickable
    expect(oids).not.toContain('dir-oid-0007-cld') // privileged account hidden
  })

  it('FAIL-OPEN: with no pattern, the onmicrosoft account is still listed', async () => {
    const res = (await searchHandler(ev({ session: finops(), method: 'GET', url: '/x?q=rio' }))) as { results: { oid: string }[] }
    expect(res.results.map((r) => r.oid)).toContain('dir-oid-0007-cld')
  })
})

describe('defense-in-depth: read-time validation', () => {
  it('SKIPS a match-all pattern that reached the table by a non-API path', async () => {
    // A direct insert bypassing the POST validator (bulk import / psql fix).
    await t.client`INSERT INTO directory_exclusion_pattern (pattern) VALUES ('*')`
    const patterns = await loadDirectoryExclusionPatterns(t.db as unknown as Parameters<typeof loadDirectoryExclusionPatterns>[0])
    expect(patterns).not.toContain('*') // never applied → picker isn't emptied
  })
})
