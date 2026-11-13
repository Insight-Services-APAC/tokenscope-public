// @vitest-environment node
/*
 * GET /api/v1/allocations (#632): the project budgets list.
 *
 * The route's own contract, not the scope predicate's (scope.test.ts owns that):
 * who may call it, what each role sees, the order (project name, newest period
 * first), paging by whole projects, the parsed period and `is_current`, the
 * budget in force from the project page's reader, and `total`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { routeEvent } from '../helpers/route-event'
import * as schema from '../../../drizzle/schema'
import type { Session } from '../../../server/utils/auth'
import listAllocations from '../../../server/api/v1/allocations/index.get'
import { fetchProjectAllocation } from '../../../server/usage/consumption'

let t: TestDb
let regionA: string
let regionB: string
let buA: string
let teammateId: string
let atlas: string
let boreas: string
let foreign: string

interface Line {
  id: string
  scope_id: string
  allocation_kind: string
  is_current: boolean
  is_pool: boolean
  effective_from: string | null
  effective_to: string | null
  project_code: string | null
  project_budget_now: number | null
}
interface ListOut {
  allocations: Line[]
  total: number
  total_lines: number
  limit: number
  offset: number
}

const session = (role: string, regionId: string): Session =>
  ({
    teammateId,
    email: 'al-list@x.test',
    displayName: 'List Reader',
    role,
    regionId,
    orgPath: 'ala.svc',
    issuedAt: '2026-10-28T00:00:00Z',
  }) as Session

async function alloc(
  projectId: string,
  budget: string,
  effective: string,
  kind: 'baseline' | 'top-up' | 'burst' = 'baseline',
): Promise<string> {
  const [e] = await t.db
    .insert(schema.auditEvent)
    .values({ eventType: 'allocation-created', subjectKind: 'project', subjectId: projectId, payload: { test: true } })
    .returning({ id: schema.auditEvent.id })
  const [a] = await t.db
    .insert(schema.allocation)
    .values({ scopeType: 'project', scopeId: projectId, budgetUsd: budget, effective, allocationKind: kind, auditEventId: e!.id })
    .returning({ id: schema.allocation.id })
  return a!.id
}

/* Ranges relative to the real clock: the route reads now(), as the project page does. */
function monthRange(offsetMonths: number): string {
  const now = new Date()
  const a = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1))
  const b = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths + 1, 1))
  return `[${a.toISOString()},${b.toISOString()})`
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [ra] = await t.db.insert(schema.region).values({ code: 'al-a', displayName: 'AL A' }).returning()
  const [rb] = await t.db.insert(schema.region).values({ code: 'al-b', displayName: 'AL B' }).returning()
  regionA = ra!.id
  regionB = rb!.id
  // A parented home unit: a manager placed at a region root sees nothing (placedBelowRegionRootPredicate).
  const [rootA] = await t.db.insert(schema.orgUnit).values({ regionId: regionA, path: 'ala', code: 'default', displayName: 'A', unitType: 'bu', isCostOwningUnit: true }).returning()
  const [oa] = await t.db.insert(schema.orgUnit).values({ regionId: regionA, parentId: rootA!.id, path: 'ala.svc', code: 'ala-svc', displayName: 'A Services', unitType: 'bu', isCostOwningUnit: true }).returning()
  const [ob] = await t.db.insert(schema.orgUnit).values({ regionId: regionB, path: 'alb.svc', code: 'alb-svc', displayName: 'B Services', unitType: 'bu', isCostOwningUnit: true }).returning()
  buA = oa!.id
  const [tm] = await t.db.insert(schema.teammate).values({ entraOid: 'al-list', email: 'al-list@x.test', regionId: regionA, orgUnitId: buA }).returning()
  teammateId = tm!.id
  const [pa] = await t.db.insert(schema.project).values({ code: 'ATLAS', codeHash: 'h-al-atlas', displayName: 'atlas', type: 'billable', regionId: regionA, costOwningUnitId: buA }).returning()
  const [pb] = await t.db.insert(schema.project).values({ code: 'BOREAS', codeHash: 'h-al-boreas', displayName: 'Boreas', type: 'billable', regionId: regionA, costOwningUnitId: buA }).returning()
  const [pf] = await t.db.insert(schema.project).values({ code: 'FOREIGN', codeHash: 'h-al-foreign', displayName: 'Abroad', type: 'billable', regionId: regionB, costOwningUnitId: ob!.id }).returning()
  atlas = pa!.id
  boreas = pb!.id
  foreign = pf!.id

  // Atlas: this month's baseline + a top-up, and two earlier months.
  await alloc(atlas, '1000.00', monthRange(-2))
  await alloc(atlas, '1000.00', monthRange(-1))
  await alloc(atlas, '1000.00', monthRange(0))
  await alloc(atlas, '500.00', monthRange(0), 'top-up')
  // Boreas: only an old budget, open-ended start and a burst that never counts.
  await alloc(boreas, '200.00', monthRange(-3))
  await alloc(boreas, '50.00', monthRange(0), 'burst')
  await alloc(foreign, '999.00', monthRange(0))
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('GET /api/v1/allocations', () => {
  it('a developer is refused', async () => {
    await expect(listAllocations(routeEvent({ method: 'GET', session: session('developer', regionA) }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a region admin sees only their region, grouped by project name, newest period first', async () => {
    const out = (await listAllocations(routeEvent({ method: 'GET', session: session('admin', regionA) }))) as ListOut
    expect(out.allocations.some((l) => l.scope_id === foreign)).toBe(false)
    expect(out.total).toBe(2)
    expect(out.total_lines).toBe(6)
    // Case-insensitive project order: "atlas" before "Boreas".
    expect(out.allocations.map((l) => l.project_code)).toEqual(['ATLAS', 'ATLAS', 'ATLAS', 'ATLAS', 'BOREAS', 'BOREAS'])
    const atlasFroms = out.allocations.filter((l) => l.scope_id === atlas).map((l) => l.effective_from!)
    expect([...atlasFroms].sort().reverse()).toEqual(atlasFroms)
  })

  it('each line carries its parsed period, is_current, and the budget in force the project page shows', async () => {
    const out = (await listAllocations(routeEvent({ method: 'GET', session: session('admin', regionA) }))) as ListOut
    const atlasLines = out.allocations.filter((l) => l.scope_id === atlas)
    const current = atlasLines.filter((l) => l.is_current)
    expect(current.map((l) => l.allocation_kind).sort()).toEqual(['baseline', 'top-up'])
    for (const l of atlasLines) {
      expect(l.effective_from).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/)
      expect(l.effective_to).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/)
      expect(l.is_pool).toBe(true)
    }
    const pageFigure = await fetchProjectAllocation(t.db as never, atlas)
    expect(pageFigure).toBe(1500)
    for (const l of atlasLines) expect(l.project_budget_now).toBe(pageFigure)
    // A burst is not budget in force; Boreas has nothing in force.
    for (const l of out.allocations.filter((x) => x.scope_id === boreas)) expect(l.project_budget_now).toBe(0)
  })

  it('pages by whole projects: limit 1 returns every line of the first project and none of the next', async () => {
    const first = (await listAllocations(routeEvent({ method: 'GET', query: { limit: '1' }, session: session('admin', regionA) }))) as ListOut
    expect(new Set(first.allocations.map((l) => l.scope_id))).toEqual(new Set([atlas]))
    expect(first.allocations).toHaveLength(4)
    expect(first.total).toBe(2)
    const second = (await listAllocations(routeEvent({ method: 'GET', query: { limit: '1', offset: '1' }, session: session('admin', regionA) }))) as ListOut
    expect(new Set(second.allocations.map((l) => l.scope_id))).toEqual(new Set([boreas]))
  })

  it('a manager sees their own part of the org', async () => {
    const out = (await listAllocations(routeEvent({ method: 'GET', session: session('manager', regionA) }))) as ListOut
    expect(new Set(out.allocations.map((l) => l.scope_id))).toEqual(new Set([atlas, boreas]))
  })
})
