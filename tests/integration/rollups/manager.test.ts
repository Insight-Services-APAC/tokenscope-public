// @vitest-environment node
/*
 * GET /api/v1/rollups/manager — region scope + selector. Runs against testcontainers Postgres
 * via the OWNER connection (RLS is inert in prod too), so the in-query scopeClause is what's
 * exercised. Invoking the real handler also pins the CTE-chain SQL (the trailing-comma class of
 * regression that originally 500'd this page). Validates the finance-scope model:
 *   manager → own subtree; admin → own region (regionId ignored); global-finops → all regions or a
 *   selected one. The cross-region leak guard uses a SECOND region with real teammates.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/rollups/manager.get'

let t: TestDb
let regionA = ''
let regionB = ''
let regionC = '' // isolated — a Copilot-only person (unaccounted, no OTel) must still show their spend

const ev = (session: Session, query = '') => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET', path: url, context: { params: {} },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof handler>[0]
}
const sess = (role: string, orgPath: string, regionId: string): Session =>
  ({ teammateId: '00000000-0000-0000-0000-000000000001', email: 'x@x.test', displayName: 'X', role, regionId, orgPath, issuedAt: new Date().toISOString() } as unknown as Session)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const mkRegion = async (code: string, name: string) => {
    await t.client`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
    return r!.id
  }
  regionA = await mkRegion('mga', 'Mgr Region A')
  regionB = await mkRegion('mgb', 'Mgr Region B')

  const mkUnit = async (region: string, path: string, code: string, parent: string | null = null) => {
    await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${parent}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  // S3 part (a): 'a' is a genuine parent of 'a.bu' — used below as a MANAGER's own
  // placement, which now must pass placedBelowRegionRootPredicate() (parent_id IS
  // NOT NULL) or the manager gets a false "zero" subtree.
  const aRoot = await mkUnit(regionA, 'a', 'default')
  const aBu = await mkUnit(regionA, 'a.bu', 'a-bu', aRoot)
  const bBu = await mkUnit(regionB, 'b.bu', 'b-bu')

  const mkTeammate = async (region: string, unit: string, email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid, true)`
  }
  await mkTeammate(regionA, aBu, 'alice@a.test')
  await mkTeammate(regionB, bBu, 'bob@b.test')

  // Region C: dave is a Copilot-only person — NO attribution_record, only the §A unaccounted gap.
  // The team view read attribution_record alone, so he showed $0 (the "Trent $0" bug).
  regionC = await mkRegion('mgc', 'Mgr Region C')
  const cBu = await mkUnit(regionC, 'c.bu', 'c-bu')
  await mkTeammate(regionC, cBu, 'dave@c.test')
  const [dv] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='dave@c.test'`
  await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${dv!.id}::uuid, ${regionC}::uuid, ${cBu}::uuid, CURRENT_DATE, 'copilot-cli', 25, 0, 'api-reconciled')`
}, 120_000)
afterAll(async () => { await stopTestDb(t) })

interface Resp {
  per_teammate: { email: string; total_cost_usd: string }[]
  region_options: { id: string; code: string }[]
  selected_region: string | null
}
const emails = (r: Resp) => r.per_teammate.map((x) => x.email).sort()

describe('GET /api/v1/rollups/manager — region scope + selector', () => {
  it('a manager sees only their own subtree', async () => {
    const r = (await handler(ev(sess('manager', 'a.bu', regionA)))) as Resp
    expect(emails(r)).toEqual(['alice@a.test']) // not bob (other region/subtree)
    expect(r.region_options).toEqual([]) // no selector for a manager
    expect(r.selected_region).toBeNull()
  })

  it('a COPILOT-ONLY teammate shows their unaccounted spend in the team view (was $0)', async () => {
    const r = (await handler(ev(sess('admin', 'c.bu', regionC)))) as Resp
    const dave = r.per_teammate.find((x) => x.email === 'dave@c.test')
    expect(dave).toBeDefined() // he appears in the team list...
    expect(Number(dave!.total_cost_usd)).toBe(25) // ...with his real Copilot usage, not $0
  })

  it('a region admin sees only their OWN region — never another (the leak that #2 fixed)', async () => {
    const r = (await handler(ev(sess('admin', 'a.bu', regionA)))) as Resp
    expect(emails(r)).toEqual(['alice@a.test']) // region A only — bob (region B) INVISIBLE
    expect(r.selected_region).toBe(regionA)
    expect(r.region_options).toEqual([]) // admin is region-locked → no selector
  })

  it('a region admin cannot widen via ?regionId= (hard-bound, param ignored)', async () => {
    const r = (await handler(ev(sess('admin', 'a.bu', regionA), `regionId=${regionB}`))) as Resp
    expect(emails(r)).toEqual(['alice@a.test']) // still region A, never bob
    expect(r.selected_region).toBe(regionA)
  })

  it('global-finops sees ALL regions by default and gets the region picker', async () => {
    const r = (await handler(ev(sess('global-finops', 'a.bu', regionA)))) as Resp
    expect(emails(r)).toEqual(['alice@a.test', 'bob@b.test', 'dave@c.test']) // all three regions
    expect(r.selected_region).toBe('all')
    expect(r.region_options.map((o) => o.id).sort()).toEqual([regionA, regionB, regionC].sort())
  })

  it('global-finops can narrow to a single selected region', async () => {
    const r = (await handler(ev(sess('global-finops', 'a.bu', regionA), `regionId=${regionB}`))) as Resp
    expect(emails(r)).toEqual(['bob@b.test']) // only region B now
    expect(r.selected_region).toBe(regionB)
  })

  it('a well-formed but unknown selected region 404s (no silent fallback to all)', async () => {
    // A valid v4 uuid that doesn't exist (malformed ids are a 400 at the zod layer, tested implicitly).
    await expect(handler(ev(sess('global-finops', 'a.bu', regionA), 'regionId=11111111-1111-4111-8111-111111111111')))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})
