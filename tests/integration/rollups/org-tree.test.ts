// @vitest-environment node
/*
 * GET /api/v1/rollups/org-tree — hierarchical spend rollup. Runs against testcontainers
 * Postgres via the OWNER connection (RLS is inert in prod too), so the IN-QUERY subtree +
 * region predicates are what's exercised — NOT RLS. Region B deliberately reuses region A's
 * 'apps' path to prove the region clamp (not just `path <@`) is what stops the cross-region
 * leak. Validates: forest roll-up under a synthetic region root, the cross-subtree leak guard,
 * the same-region ouId IDOR 403, the CROSS-region ouId 403, and the region-scoped unplaced line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/rollups/org-tree.get'

let t: TestDb
let regionA = ''
let regionB = ''
let appsId = ''
let dataId = ''
let t1Id = ''
let holdAId = ''
let bAppsId = '' // region B node whose path collides with region A's 'apps'
let unassignedRegion = ''

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
  process.env.DATABASE_URL = t.url // the handler's getDb() must hit this container

  const mkRegion = async (code: string, name: string) => {
    await t.client`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
    return r!.id
  }
  regionA = await mkRegion('ota', 'Org Test A')
  regionB = await mkRegion('otb', 'Org Test B')
  unassignedRegion = await mkRegion('__unassigned__', 'Unassigned') // synthetic fallback region (excluded from the picker)

  const ou = async (region: string, path: string, code: string, parent: string | null, type = 'bu', cou = false) => {
    await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${parent}::uuid, ${path}::ltree, ${code}, ${code}, ${type}, ${cou})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  // Region A is a FOREST (no single root, like real Insight): apps + data are both top-level
  // BY PATH (neither is a descendant of the other — that's what the admin "synthetic region
  // root" tests below validate, and it is UNCHANGED by parent_id). 'apps' additionally gets a
  // parent_id (S3 part a) because a MANAGER is placed there below and the security clamp now
  // requires the caller's OWN home to look genuinely placed (parent_id IS NOT NULL) — this is
  // the org-units.post.ts-legitimate "admin-created root-level BU" case org-subtree-scope.ts's
  // own docs name as the accepted false positive of that structural test; without SOME parent
  // link here the manager subtree-rollup test below would degrade to an (equally valid, but
  // untestable) empty tree instead of exercising the rollup it exists to validate.
  // unit_type 'holding' so it is excluded from BOTH the admin org-wide listing and the
  // unplaced-spend sum (org-tree.get.ts filters unit_type <> 'holding' for the tree, and
  // sums unit_type = 'holding' spend separately) — it exists ONLY as a parent_id target,
  // invisible everywhere else, so it cannot perturb any other assertion in this file.
  const s3ManagerRootId = await ou(regionA, 'ota_root', '__s3_root__', null, 'holding', false)
  appsId = await ou(regionA, 'apps', 'apps', s3ManagerRootId, 'bu', true)
  dataId = await ou(regionA, 'data', 'data', null, 'bu', true)
  t1Id = await ou(regionA, 'apps.t1', 't1', appsId, 'bu', true)
  holdAId = await ou(regionA, 'ota_unplaced', '__UNPLACED__', null, 'holding', false)
  // Region B reuses path 'apps' — a colliding path the region clamp must keep invisible to A.
  bAppsId = await ou(regionB, 'apps', 'apps', null, 'bu', true)

  const addSpend = async (region: string, orgUnitId: string, cost: number, tool = 'claude-code') => {
    await t.client`INSERT INTO teammate (entra_oid, email, region_id, org_unit_id)
      VALUES ('oid-'||gen_random_uuid(), 'm'||floor(random()*1e9)::text||'@x.test', ${region}::uuid, ${orgUnitId}::uuid)`
    const [tm] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE org_unit_id=${orgUnitId}::uuid ORDER BY joined_at DESC LIMIT 1`
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${tm!.id}::uuid, ${tool}, ${region}::uuid, ${orgUnitId}::uuid, 'h', 'P')`
    const [ia] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${tm!.id}::uuid LIMIT 1`
    await t.client`INSERT INTO attribution_record (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event)
      VALUES (${ia!.id}::uuid, ${tm!.id}::uuid, ${region}::uuid, ${orgUnitId}::uuid, ${tool}, 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated', now())`
  }
  await addSpend(regionA, appsId, 10) // claude-code
  await addSpend(regionA, t1Id, 5, 'copilot-cli') // copilot — exercises the vendor split
  await addSpend(regionA, dataId, 7)
  await addSpend(regionA, holdAId, 3)
  await addSpend(regionB, bAppsId, 100) // must NEVER appear in any region-A result
}, 120_000)
afterAll(async () => { await stopTestDb(t) })

interface Resp {
  root: {
    id: string; rolledCostUsd: number; userCount: number
    vendorUsd: { claude: number; copilot: number; other: number }
    children: { code: string; rolledCostUsd: number }[]
  } | null
  unplaced: { costUsd: number } | null
  selectedRegionId: string | null
  regionOptions: { id: string; code: string; displayName: string }[]
}

describe('GET /api/v1/rollups/org-tree', () => {
  it('a manager rooted at Apps sees Apps + its team rolled up; the Data BU + region B are INVISIBLE', async () => {
    const r = (await handler(ev(sess('manager', 'apps', regionA)))) as Resp
    expect(r.root!.rolledCostUsd).toBe(15) // apps 10 + t1 5 — NOT data (7), NOT region B's apps (100)
    expect(r.root!.vendorUsd).toEqual({ claude: 10, copilot: 5, other: 0 }) // apps=claude, t1=copilot
    expect(r.root!.userCount).toBe(2) // distinct emitters across apps + t1
    expect(r.root!.children.map((c) => c.code)).toContain('t1')
    expect(r.root!.children.find((c) => c.code === 'data')).toBeUndefined() // sibling BU not leaked
    expect(r.unplaced).toBeNull() // mid-tree manager: not shown
  })

  it('a same-region ouId outside the caller subtree → 403 (IDOR guard)', async () => {
    await expect(handler(ev(sess('manager', 'apps', regionA), `ouId=${dataId}`))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('an admin passing an ouId in ANOTHER region → 403 (cross-region guard)', async () => {
    await expect(handler(ev(sess('admin', 'apps', regionA), `ouId=${bAppsId}`))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('an admin gets a synthetic region root over the WHOLE region + unplaced; region B stays out', async () => {
    const r = (await handler(ev(sess('admin', 'apps', regionA)))) as Resp
    expect(r.root!.rolledCostUsd).toBe(22) // apps 10 + t1 5 + data 7 — region B's 100 excluded
    expect(r.root!.children.map((c) => c.code).sort()).toEqual(['apps', 'data']) // forest under synthetic root
    expect(r.unplaced!.costUsd).toBe(3) // region-A holding-node spend, surfaced separately (honest all-up)
  })

  it('a developer gets their own single-node subtree (degrades gracefully, no 403)', async () => {
    const r = (await handler(ev(sess('developer', 'apps.t1', regionA)))) as Resp
    expect(r.root!.rolledCostUsd).toBe(5) // just t1
  })

  it('an in-scope ouId drill re-roots to that node (happy path)', async () => {
    const r = (await handler(ev(sess('manager', 'apps', regionA), `ouId=${t1Id}`))) as Resp
    expect(r.root!.rolledCostUsd).toBe(5) // rooted at the t1 team
    expect(r.unplaced).toBeNull() // unplaced is hidden on an explicit drill
  })

  it('an ouId pointing at a holding node → 403 (not a drillable root, no 500)', async () => {
    await expect(handler(ev(sess('admin', 'apps', regionA), `ouId=${holdAId}`))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('global-finops gets a region selector and can switch to another region', async () => {
    const home = (await handler(ev(sess('global-finops', 'apps', regionA)))) as Resp
    expect(home.selectedRegionId).toBe(regionA) // defaults to home region
    expect(home.regionOptions.map((r) => r.id).sort()).toEqual([regionA, regionB].sort()) // both selectable
    expect(home.root!.rolledCostUsd).toBe(22) // region A

    const picked = (await handler(ev(sess('global-finops', 'apps', regionA), `regionId=${regionB}`))) as Resp
    expect(picked.selectedRegionId).toBe(regionB)
    expect(picked.root!.rolledCostUsd).toBe(100) // region B's spend, now in view
  })

  it('a region admin cannot switch regions — regionId is ignored (hard-bound to own region)', async () => {
    const r = (await handler(ev(sess('admin', 'apps', regionA), `regionId=${regionB}`))) as Resp
    expect(r.selectedRegionId).toBe(regionA) // request to view region B ignored
    expect(r.root!.rolledCostUsd).toBe(22) // still region A, never region B's 100
    expect(r.regionOptions).toEqual([]) // no selector for a region-bound admin
  })

  it('a cross-region leader homed in __unassigned__ defaults to a real, selectable region', async () => {
    const r = (await handler(ev(sess('global-finops', 'apps', unassignedRegion)))) as Resp
    // selectedRegionId must be a real region present in the picker (never the phantom unassigned one)
    expect(r.regionOptions.map((o) => o.id)).toContain(r.selectedRegionId)
    expect(r.regionOptions.map((o) => o.code)).not.toContain('__unassigned__')
    expect(r.selectedRegionId).toBe(regionA) // first real region by display_name (Org Test A)
  })
})
