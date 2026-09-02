// @vitest-environment node
/*
 * The path from "Unplaced · N teammates" to placed, end to end against real PG.
 *
 * Covers, per docs/design/placement-remediation/00-spec.md:
 *   C1  the placement filter + the "N of M" pair on GET /admin/teammates
 *   C2  the holding node cannot be made cost-owning, on EITHER write door
 *   C3  the directory snapshot + the window spend columns
 *   C4  POST /admin/users/bulk-place — authorisation, containment, partial
 *       failure, audit
 *   C6  the teammates-placed checklist item
 *   C8b/C8c  owner ambiguity + realised reach on the org-units tree
 *
 * THE FIXTURE IS DELIBERATELY CROSS-REGION. Every authorisation assertion below
 * targets a row that genuinely belongs to the OTHER region — an authorisation
 * test whose fixture has nothing foreign in it passes for the wrong reason and
 * proves nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import bulkPlace from '../../../server/api/v1/admin/users/bulk-place.post'
import teammatesGet from '../../../server/api/v1/admin/teammates.get'
import orgUnitsGet from '../../../server/api/v1/admin/org-units.get'
import orgUnitPatch from '../../../server/api/v1/admin/org-units/[id].patch'
import orgUnitsPost from '../../../server/api/v1/admin/org-units.post'
import regionGet from '../../../server/api/v1/admin/region/[regionId]/index.get'
import { unplacedOrgUnitIdForRegion } from '../../../server/auth/placement-home'
import { captureDirectorySnapshot } from '../../../server/reconciliation/directory-snapshot'

let t: TestDb
// Region A = the admin's home region. Region B = the cross-region foil.
let regionAId: string
let regionBId: string
let couAId: string // cost-owning unit in A
let teamAId: string // NON-cost-owning unit in A
let retiredAId: string // retired cost-owning unit in A
let holdingAId: string // A's __UNPLACED__ holding node
let couBId: string // cost-owning unit in B
let holdingBId: string
let adminAId: string
let finopsId: string
// Unplaced teammates in A, and one in B.
let unplacedA: string[] = []
let unplacedB: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [ra] = await t.db.insert(schema.region).values({ code: 'pr-a', displayName: 'PR A' }).returning()
  const [rb] = await t.db.insert(schema.region).values({ code: 'pr-b', displayName: 'PR B' }).returning()
  regionAId = ra!.id
  regionBId = rb!.id

  const [couA] = await t.db.insert(schema.orgUnit).values({
    regionId: regionAId, path: 'pra.core', code: 'pra-core', displayName: 'A Core',
    unitType: 'practice', isCostOwningUnit: true,
  }).returning()
  couAId = couA!.id
  const [teamA] = await t.db.insert(schema.orgUnit).values({
    regionId: regionAId, path: 'pra.team', code: 'pra-team', displayName: 'A Team',
    unitType: 'team', isCostOwningUnit: false,
  }).returning()
  teamAId = teamA!.id
  const [retA] = await t.db.insert(schema.orgUnit).values({
    regionId: regionAId, path: 'pra.gone', code: 'pra-gone', displayName: 'A Gone',
    unitType: 'practice', isCostOwningUnit: true, retiredAt: new Date(),
  }).returning()
  retiredAId = retA!.id
  const [couB] = await t.db.insert(schema.orgUnit).values({
    regionId: regionBId, path: 'prb.core', code: 'prb-core', displayName: 'B Core',
    unitType: 'practice', isCostOwningUnit: true,
  }).returning()
  couBId = couB!.id

  // The holding nodes, minted by the product's own writer so the fixture cannot
  // disagree with what placement actually creates.
  holdingAId = await unplacedOrgUnitIdForRegion(t.db, regionAId)
  holdingBId = await unplacedOrgUnitIdForRegion(t.db, regionBId)

  const [adm] = await t.db.insert(schema.teammate).values({
    entraOid: 'oid-pr-admin-a', email: 'pr-admin-a@x.test', role: 'admin',
    regionId: regionAId, orgUnitId: couAId,
  }).returning()
  adminAId = adm!.id
  const [fin] = await t.db.insert(schema.teammate).values({
    entraOid: 'oid-pr-finops', email: 'pr-finops@x.test', role: 'global-finops',
    regionId: regionAId, orgUnitId: couAId,
  }).returning()
  finopsId = fin!.id

  // Four unplaced people in A, on A's holding node, with directory snapshots.
  const insertedA = await t.db.insert(schema.teammate).values(
    [1, 2, 3, 4].map((n) => ({
      entraOid: `bill:pr-a-${n}`,
      email: `pr-a-${n}@x.test`,
      displayName: `A Person ${n}`,
      regionId: regionAId,
      orgUnitId: holdingAId,
      metadata: {
        directory: { department: n <= 3 ? 'Sales-Solution' : 'Delivery', companyName: 'Insight A' },
      },
    })),
  ).returning()
  unplacedA = insertedA.map((r) => r.id)

  // One unplaced person in B — the cross-region target.
  const [b1] = await t.db.insert(schema.teammate).values({
    entraOid: 'bill:pr-b-1', email: 'pr-b-1@x.test', displayName: 'B Person',
    regionId: regionBId, orgUnitId: holdingBId,
  }).returning()
  unplacedB = b1!.id
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

const adminA = (): Session => ({
  teammateId: adminAId, email: 'pr-admin-a@x.test', displayName: 'Admin A',
  role: 'admin', regionId: regionAId, orgPath: 'pra.core',
})
const finops = (): Session => ({
  teammateId: finopsId, email: 'pr-finops@x.test', displayName: 'Fin',
  role: 'global-finops', regionId: regionAId, orgPath: 'pra.core',
})

function ev(opts: {
  method?: string
  body?: unknown
  query?: Record<string, string>
  params?: Record<string, string>
  session: Session
}) {
  const method = opts.method ?? 'POST'
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
  const url = `/x${qs}`
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    'content-type': 'application/json',
  }
  const e = {
    method,
    path: url,
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method,
        url,
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() { return headers },
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
  return e as unknown as Parameters<typeof bulkPlace>[0]
}

async function call<T>(handler: (e: never) => unknown, e: unknown): Promise<T> {
  return (await handler(e as never)) as T
}

async function homeOf(teammateId: string): Promise<string> {
  const [row] = await t.client<{ org_unit_id: string }[]>`
    SELECT org_unit_id::text AS org_unit_id FROM teammate WHERE id = ${teammateId}::uuid`
  return row!.org_unit_id
}

interface BulkResponse {
  batch_id: string
  placed: number
  noop: number
  failed: number
  results: Array<{ teammate_id: string; status: string; reason?: string; status_code?: number }>
}

// ───────────────────────────────────────────────────────────────────────────
describe('C4 — bulk place: authorisation', () => {
  it('a region admin CANNOT place another region\'s teammate (and nothing moves)', async () => {
    const res = await call<BulkResponse>(bulkPlace, ev({
      session: adminA(),
      body: { teammate_ids: [unplacedB], org_unit_id: couAId },
    }))
    expect(res.placed).toBe(0)
    expect(res.failed).toBe(1)
    expect(res.results[0]!.status_code).toBe(403)
    // The foil is genuinely in region B and genuinely did not move.
    expect(await homeOf(unplacedB)).toBe(holdingBId)
  })

  it('a region admin CANNOT place their own teammate into another region\'s unit', async () => {
    await expect(
      call(bulkPlace, ev({
        session: adminA(),
        body: { teammate_ids: [unplacedA[0]!], org_unit_id: couBId },
      })),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(await homeOf(unplacedA[0]!)).toBe(holdingAId)
  })

  it('even global-finops cannot place ACROSS regions — the unit must be in the teammate\'s own region', async () => {
    // finops passes both region-scope checks (region-unbounded), so the ONLY
    // thing standing between this call and a silent cross-region move is the
    // containment rule inside placeTeammate.
    const res = await call<BulkResponse>(bulkPlace, ev({
      session: finops(),
      body: { teammate_ids: [unplacedB], org_unit_id: couAId },
    }))
    expect(res.placed).toBe(0)
    expect(res.results[0]!.status_code).toBe(422)
    expect(await homeOf(unplacedB)).toBe(holdingBId)
  })

  it('a developer is refused outright', async () => {
    await expect(
      call(bulkPlace, ev({
        session: { ...adminA(), role: 'developer' },
        body: { teammate_ids: [unplacedA[0]!], org_unit_id: couAId },
      })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('C4 — bulk place: target rules', () => {
  it('refuses a NON-cost-owning target', async () => {
    await expect(
      call(bulkPlace, ev({
        session: adminA(),
        body: { teammate_ids: [unplacedA[0]!], org_unit_id: teamAId },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
    expect(await homeOf(unplacedA[0]!)).toBe(holdingAId)
  })

  it('refuses a RETIRED target', async () => {
    await expect(
      call(bulkPlace, ev({
        session: adminA(),
        body: { teammate_ids: [unplacedA[0]!], org_unit_id: retiredAId },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
    expect(await homeOf(unplacedA[0]!)).toBe(holdingAId)
  })

  it('refuses the HOLDING node itself — the one target that would look like progress', async () => {
    await expect(
      call(bulkPlace, ev({
        session: adminA(),
        body: { teammate_ids: [unplacedA[0]!], org_unit_id: holdingAId },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('C4 — bulk place: the placement itself', () => {
  it('places the batch, drops the unplaced count by exactly that many, and audits each with ONE batch id', async () => {
    const before = await unplacedCount(regionAId)
    const ids = [unplacedA[0]!, unplacedA[1]!, unplacedA[2]!]
    const res = await call<BulkResponse>(bulkPlace, ev({
      session: adminA(),
      body: { teammate_ids: ids, org_unit_id: couAId },
    }))
    expect(res.placed).toBe(3)
    expect(res.failed).toBe(0)
    for (const id of ids) expect(await homeOf(id)).toBe(couAId)
    expect(await unplacedCount(regionAId)).toBe(before - 3)

    // One audit event per placement, all carrying the SAME batch id.
    const audit = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'teammate-org-unit-changed'
        AND payload->>'batchId' = ${res.batch_id}`
    expect(Number(audit[0]!.n)).toBe(3)
  })

  it('a bad id does NOT discard the good placements in the same batch', async () => {
    const good = unplacedA[3]!
    const ghost = '11111111-1111-4111-8111-111111111111'
    const res = await call<BulkResponse>(bulkPlace, ev({
      session: adminA(),
      body: { teammate_ids: [good, ghost, unplacedB], org_unit_id: couAId },
    }))
    expect(res.placed).toBe(1)
    expect(res.failed).toBe(2)
    // The good one committed…
    expect(await homeOf(good)).toBe(couAId)
    // …and the two refusals wrote no audit row at all (their SAVEPOINTs rolled back).
    const audit = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'teammate-org-unit-changed'
        AND payload->>'batchId' = ${res.batch_id}`
    expect(Number(audit[0]!.n)).toBe(1)
  })

  it('clears manager-chain provenance so re-enrichment cannot undo the placement', async () => {
    const [mate] = await t.db.insert(schema.teammate).values({
      entraOid: 'bill:pr-a-prov', email: 'pr-a-prov@x.test', regionId: regionAId,
      orgUnitId: holdingAId,
      metadata: { placedVia: 'manager-chain', placedOwnerOid: 'someone', keep: 'x' },
    }).returning()
    await call<BulkResponse>(bulkPlace, ev({
      session: adminA(),
      body: { teammate_ids: [mate!.id], org_unit_id: couAId },
    }))
    const [row] = await t.client<{ via: string | null; keep: string | null }[]>`
      SELECT metadata->>'placedVia' AS via, metadata->>'keep' AS keep
      FROM teammate WHERE id = ${mate!.id}::uuid`
    expect(row!.via).toBeNull()
    expect(row!.keep).toBe('x') // unrelated metadata survives
  })
})

async function unplacedCount(regionId: string): Promise<number> {
  const [row] = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM teammate t JOIN org_unit ou ON ou.id = t.org_unit_id
    WHERE t.region_id = ${regionId}::uuid AND t.is_active = TRUE AND ou.unit_type = 'holding'`
  return Number(row!.n)
}

// ───────────────────────────────────────────────────────────────────────────
interface TeammatesResponse {
  teammates: Array<{
    id: string
    email: string
    display_name: string | null
    department: string | null
    company_name: string | null
    directory_captured_at: string | null
    spend_usd: string
    on_holding_node: boolean
  }>
  total: number
  unfiltered_total: number
}

/*
 * The worklist blocks below own their OWN unplaced fixture. The C4 block above
 * deliberately empties region A's holding node — that is what it is testing — so
 * a filter test that leaned on its leftovers would be asserting against whatever
 * the previous describe happened to leave behind, and would go green or red for
 * reasons that have nothing to do with the filter.
 */
let filterFixtureIds: string[] = []

describe('C1 — the placement filter and the "N of M" pair', () => {
  beforeAll(async () => {
    const inserted = await t.db.insert(schema.teammate).values(
      [1, 2, 3].map((n) => ({
        entraOid: `bill:pr-filter-${n}`,
        email: `pr-filter-${n}@x.test`,
        displayName: `Filter Person ${n}`,
        regionId: regionAId,
        orgUnitId: holdingAId,
        metadata: {
          directory: { department: 'Sales-Solution', companyName: 'Insight A' },
        },
      })),
    ).returning()
    filterFixtureIds = inserted.map((r) => r.id)
  })

  it('unplaced returns ONLY holding-node teammates; the unfiltered total stays whole', async () => {
    const res = await call<TeammatesResponse>(teammatesGet, ev({
      method: 'GET', session: adminA(), query: { region: regionAId, placement: 'unplaced' },
    }))
    expect(res.teammates.length).toBeGreaterThan(0)
    expect(res.teammates.every((r) => r.on_holding_node)).toBe(true)
    expect(res.total).toBe(res.teammates.length)
    // 290 OF 513 — the denominator must not follow the filter.
    expect(res.unfiltered_total).toBeGreaterThan(res.total)
  })

  it('placed is the exact complement, and all = both', async () => {
    const q = (placement: string) =>
      call<TeammatesResponse>(teammatesGet, ev({
        method: 'GET', session: adminA(), query: { region: regionAId, placement },
      }))
    const [all, unplaced, placed] = await Promise.all([q('all'), q('unplaced'), q('placed')])
    expect(placed.teammates.every((r) => !r.on_holding_node)).toBe(true)
    expect(unplaced.total + placed.total).toBe(all.total)
    expect(all.total).toBe(all.unfiltered_total)
  })

  it('a region admin cannot read another region\'s worklist', async () => {
    await expect(
      call(teammatesGet, ev({
        method: 'GET', session: adminA(), query: { region: regionBId, placement: 'unplaced' },
      })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('C3 — what the directory knows, and what it costs', () => {
  it('surfaces the captured department + company, and null where nothing was captured', async () => {
    const res = await call<TeammatesResponse>(teammatesGet, ev({
      method: 'GET', session: adminA(), query: { region: regionAId, placement: 'all' },
    }))
    const withSnap = res.teammates.find((r) => r.email === 'pr-filter-1@x.test')
    expect(withSnap?.department).toBe('Sales-Solution')
    expect(withSnap?.company_name).toBe('Insight A')
    // The admin fixture never went through a placement lane, so it carries no
    // snapshot — NULL, meaning "not known", never an empty string that would read
    // as "the directory leaves this blank".
    const noSnap = res.teammates.find((r) => r.email === 'pr-admin-a@x.test')
    expect(noSnap).toBeDefined()
    expect(noSnap?.department).toBeNull()
    expect(noSnap?.company_name).toBeNull()
  })

  it('reports the teammate\'s chargeable spend in the window', async () => {
    const target = filterFixtureIds[0]!
    const today = new Date().toISOString().slice(0, 10)
    await t.client`
      INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source)
      VALUES (${target}::uuid, ${today}::date, 'claude-code', 100, 200, 12.5, 'pr-test')`
    const res = await call<TeammatesResponse>(teammatesGet, ev({
      method: 'GET', session: adminA(), query: { region: regionAId, placement: 'all' },
    }))
    const row = res.teammates.find((r) => r.id === target)
    expect(Number(row!.spend_usd)).toBeCloseTo(12.5, 6)
    // Everyone else in the window is $0.00, not null — a blank money cell reads
    // as "unknown" when the honest answer is "nothing".
    const other = res.teammates.find((r) => r.id === filterFixtureIds[1]!)
    expect(Number(other!.spend_usd)).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('C2 — the holding node can never be made cost-owning', () => {
  it('PATCH is_cost_owning_unit on the holding node → 422, flag unchanged', async () => {
    await expect(
      call(orgUnitPatch, ev({
        method: 'PATCH', session: adminA(), params: { id: holdingAId },
        body: { is_cost_owning_unit: true },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
    const [row] = await t.client<{ cou: boolean }[]>`
      SELECT is_cost_owning_unit AS cou FROM org_unit WHERE id = ${holdingAId}::uuid`
    expect(row!.cou).toBe(false)
  })

  it('PATCH that only sets the flag is still caught — the type comes from the EXISTING row', async () => {
    // The body carries no unit_type. A guard that read only the body would wave
    // this through; the effective-value check is what catches it.
    await expect(
      call(orgUnitPatch, ev({
        method: 'PATCH', session: adminA(), params: { id: holdingAId },
        body: { display_name: 'Unplaced', is_cost_owning_unit: true },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  /*
   * THE RETYPING BYPASS. The guard above evaluates the EFFECTIVE row, which is
   * exactly right for a flag-only body and exactly wrong for a body that also
   * changes the type: the effective row is then no longer a holding node, so the
   * cost-owning rule does not apply to it and the PATCH sails through — with
   * every unplaced teammate still sitting on the node while it becomes a cost
   * centre. Both the one-request and the two-request form of that are pinned.
   */
  it('retyping the holding node AND enabling cost-owning in one PATCH is refused', async () => {
    await expect(
      call(orgUnitPatch, ev({
        method: 'PATCH', session: adminA(), params: { id: holdingAId },
        body: { unit_type: 'team', is_cost_owning_unit: true },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
    const [row] = await t.client<{ ut: string; cou: boolean }[]>`
      SELECT unit_type AS ut, is_cost_owning_unit AS cou FROM org_unit WHERE id = ${holdingAId}::uuid`
    // Neither half landed: it is still a holding node, and still not cost-owning.
    expect(row!.ut).toBe('holding')
    expect(row!.cou).toBe(false)
  })

  it('the TWO-STEP is refused at step one — the retype alone', async () => {
    // Splitting the same bypass across two requests must not buy anything. Step
    // one is a plain, innocuous-looking rename of the type.
    await expect(
      call(orgUnitPatch, ev({
        method: 'PATCH', session: adminA(), params: { id: holdingAId },
        body: { unit_type: 'team' },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
    const [row] = await t.client<{ ut: string }[]>`
      SELECT unit_type AS ut FROM org_unit WHERE id = ${holdingAId}::uuid`
    expect(row!.ut).toBe('holding')
    // …so step two still meets the original guard rather than a retyped node.
    await expect(
      call(orgUnitPatch, ev({
        method: 'PATCH', session: adminA(), params: { id: holdingAId },
        body: { is_cost_owning_unit: true },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('the invariant is STRUCTURAL — raw SQL cannot make a holding node cost-owning either', async () => {
    /*
     * The API checks are the friendly error, not the guarantee. A migration, a
     * seed, a future worker or a psql session bypasses them entirely, and the
     * damage does not care which door it came through. mig 0110 is the guarantee.
     */
    await expect(
      t.client`UPDATE org_unit SET is_cost_owning_unit = TRUE WHERE id = ${holdingAId}::uuid`,
    ).rejects.toThrow(/org_unit_holding_never_cost_owning/)

    await expect(
      t.client`
        INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
        VALUES (${regionAId}::uuid, 'pra.holding3'::ltree, 'pra-holding-3', 'Third holding', 'holding', TRUE)`,
    ).rejects.toThrow(/org_unit_holding_never_cost_owning/)
  })

  it('renaming the holding node still works — the guard is about the flag, not the node', async () => {
    const out = await call<{ display_name: string }>(orgUnitPatch, ev({
      method: 'PATCH', session: adminA(), params: { id: holdingAId },
      body: { display_name: 'Unplaced' },
    }))
    expect(out.display_name).toBe('Unplaced')
  })

  it('CREATE of a cost-owning holding node is refused on the sibling door too', async () => {
    await expect(
      call(orgUnitsPost, ev({
        session: adminA(),
        body: {
          region_id: regionAId, code: 'pra-holding-2', display_name: 'Second holding',
          unit_type: 'holding', is_cost_owning_unit: true,
        },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })
})

// ───────────────────────────────────────────────────────────────────────────
interface TreeResponse {
  nodes: Array<{
    id: string
    code: string
    owners: Array<{
      teammate_id: string
      placement_status: 'resolves' | 'ambiguous' | 'inert'
      owns_unit_count: number
      places_count: number
    }>
  }>
}

describe('C8b/C8c — owner diagnostics come from the walk\'s own rule', () => {
  let ownerId: string
  let secondCouA: string

  beforeAll(async () => {
    const [owner] = await t.db.insert(schema.teammate).values({
      entraOid: 'oid-pr-owner', email: 'pr-owner@x.test', displayName: 'Owner One',
      regionId: regionAId, orgUnitId: couAId,
    }).returning()
    ownerId = owner!.id
    const [second] = await t.db.insert(schema.orgUnit).values({
      regionId: regionAId, path: 'pra.second', code: 'pra-second', displayName: 'A Second',
      unitType: 'practice', isCostOwningUnit: true,
    }).returning()
    secondCouA = second!.id
    await t.db.insert(schema.couOwner).values({ orgUnitId: couAId, teammateId: ownerId })
    // Two people this owner's chain placed into couA — the realised reach (C8c).
    await t.db.insert(schema.teammate).values([1, 2].map((n) => ({
      entraOid: `bill:pr-placed-${n}`, email: `pr-placed-${n}@x.test`,
      regionId: regionAId, orgUnitId: couAId,
      metadata: { placedVia: 'manager-chain', placedOwnerOid: 'oid-pr-owner' },
    })))
  })

  const treeA = () =>
    call<TreeResponse>(orgUnitsGet, ev({ method: 'GET', session: adminA(), query: { region: regionAId } }))

  it('the response shape survives the single-transaction read (admin-nav D5): same keys, same types', async () => {
    // The three reads (tree, owner counts, threshold) now issue concurrently in
    // ONE request transaction. A key snapshot is the cheapest proof that the
    // consumer-facing shape did not move with them.
    const tree = (await treeA()) as unknown as Record<string, unknown>
    expect(Object.keys(tree).sort()).toEqual(['default_unit_warn_threshold', 'nodes'])
    expect(typeof tree.default_unit_warn_threshold).toBe('number')
    const nodes = tree.nodes as Array<Record<string, unknown>>
    const node = nodes.find((n) => n.code === 'pra-core')!
    expect(Object.keys(node).sort()).toEqual([
      'code', 'default_occupancy', 'depth', 'display_name', 'id', 'is_cost_owning_unit', 'is_default',
      'owners', 'parent_id', 'path', 'project_count', 'teammate_count', 'unit_type',
    ])
    expect(typeof node.depth).toBe('number')
    expect(typeof node.teammate_count).toBe('number')
    const owner = (node.owners as Array<Record<string, unknown>>)[0]!
    expect(Object.keys(owner).sort()).toEqual([
      'display_name', 'email', 'owns_unit_count', 'placement_status', 'places_count', 'teammate_id',
    ])
  })

  it('one active cost-owning unit → resolves, with the count THIS owner actually places', async () => {
    /*
     * A SECOND owner on the same unit, with a different number of chain
     * placements, is what makes this assertion mean anything: with one owner,
     * "placed by this owner" and "placed by anyone" are the same number, and a
     * count that ignored the owner entirely would read correct.
     */
    const [owner2] = await t.db.insert(schema.teammate).values({
      entraOid: 'oid-pr-owner-2', email: 'pr-owner-2@x.test', displayName: 'Owner Two',
      regionId: regionAId, orgUnitId: couAId,
    }).returning()
    await t.db.insert(schema.couOwner).values({ orgUnitId: couAId, teammateId: owner2!.id })
    await t.db.insert(schema.teammate).values({
      entraOid: 'bill:pr-placed-by-2', email: 'pr-placed-by-2@x.test',
      regionId: regionAId, orgUnitId: couAId,
      metadata: { placedVia: 'manager-chain', placedOwnerOid: 'oid-pr-owner-2' },
    })

    const tree = await treeA()
    const owners = tree.nodes.find((n) => n.code === 'pra-core')!.owners
    const byId = new Map(owners.map((o) => [o.teammate_id, o]))
    expect(byId.get(ownerId)!.placement_status).toBe('resolves')
    expect(byId.get(ownerId)!.owns_unit_count).toBe(1)
    expect(byId.get(ownerId)!.places_count).toBe(2)
    // Same unit, three chain-placed people on it, but only one names owner two.
    expect(byId.get(owner2!.id)!.places_count).toBe(1)
  })

  it('a SECOND owned unit flips them to ambiguous — on BOTH units', async () => {
    await t.db.insert(schema.couOwner).values({ orgUnitId: secondCouA, teammateId: ownerId })
    const tree = await treeA()
    for (const code of ['pra-core', 'pra-second']) {
      const owner = tree.nodes.find((n) => n.code === code)!.owners[0]!
      expect(owner.placement_status).toBe('ambiguous')
      expect(owner.owns_unit_count).toBe(2)
    }
    // Clean up so the case below is read against a single-unit owner.
    await t.client`DELETE FROM cou_owner WHERE org_unit_id = ${secondCouA}::uuid`
  })

  it('an owner made ambiguous by a unit in ANOTHER region is still flagged here', async () => {
    // This is the case a region-clamped read would get wrong: the admin sees only
    // region A, but the walk sees every region, so the owner places nobody.
    await t.db.insert(schema.couOwner).values({ orgUnitId: couBId, teammateId: ownerId })
    const tree = await treeA()
    const owner = tree.nodes.find((n) => n.code === 'pra-core')!.owners[0]!
    expect(owner.placement_status).toBe('ambiguous')
    expect(owner.owns_unit_count).toBe(2)
    await t.client`DELETE FROM cou_owner WHERE org_unit_id = ${couBId}::uuid`
  })

  it('a placeholder-identity owner is inert, not ambiguous — it places nobody for a different reason', async () => {
    const [ghost] = await t.db.insert(schema.teammate).values({
      entraOid: 'bill:pr-ghost-owner', email: 'pr-ghost-owner@x.test',
      regionId: regionAId, orgUnitId: couAId,
    }).returning()
    await t.db.insert(schema.couOwner).values({ orgUnitId: secondCouA, teammateId: ghost!.id })
    const tree = await treeA()
    const owner = tree.nodes.find((n) => n.code === 'pra-second')!.owners[0]!
    expect(owner.placement_status).toBe('inert')
    expect(owner.owns_unit_count).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
interface RegionResponse {
  counts: Record<string, number>
  checklist: { items: Array<{ key: string; label: string; status: string; sub: string }> }
}

describe('C6 — the teammates-placed checklist item', () => {
  const item = (r: RegionResponse) => r.checklist.items.find((i) => i.key === 'teammates-placed')!

  it('reads in-progress with the real counts while some are unplaced', async () => {
    const res = await call<RegionResponse>(regionGet, ev({
      method: 'GET', session: adminA(), params: { regionId: regionAId },
    }))
    const unplaced = res.counts.teammates_unplaced!
    expect(unplaced).toBeGreaterThan(0)
    expect(unplaced).toBeLessThan(res.counts.teammates!)
    expect(item(res).status).toBe('in_progress')
    expect(item(res).sub).toContain(`${unplaced} of ${res.counts.teammates}`)
  })

  it('goes done once nobody is on the holding node', async () => {
    await t.client`
      UPDATE teammate SET org_unit_id = ${couAId}::uuid
      WHERE region_id = ${regionAId}::uuid AND org_unit_id = ${holdingAId}::uuid`
    const res = await call<RegionResponse>(regionGet, ev({
      method: 'GET', session: adminA(), params: { regionId: regionAId },
    }))
    expect(res.counts.teammates_unplaced).toBe(0)
    expect(item(res).status).toBe('done')
  })

  it('reads todo when EVERY teammate in the region is unplaced', async () => {
    // Region B's only teammate is on its holding node.
    const res = await call<RegionResponse>(regionGet, ev({
      method: 'GET', session: finops(), params: { regionId: regionBId },
    }))
    expect(res.counts.teammates_unplaced).toBe(res.counts.teammates)
    expect(item(res).status).toBe('todo')
  })
})

// ───────────────────────────────────────────────────────────────────────────
/*
 * Everything below owns its own fixtures and runs LAST, after the C6 block has
 * deliberately emptied region A's holding node. A test that leaned on an earlier
 * block's leftovers would pass or fail for reasons that have nothing to do with
 * what it claims to check.
 */
let seq = 0
async function freshUnplacedInA(opts?: { metadata?: Record<string, unknown> }): Promise<string> {
  seq += 1
  const [row] = await t.db.insert(schema.teammate).values({
    entraOid: `bill:pr-late-${seq}`,
    email: `pr-late-${seq}@x.test`,
    displayName: `Late Person ${seq}`,
    regionId: regionAId,
    orgUnitId: holdingAId,
    ...(opts?.metadata ? { metadata: opts.metadata } : {}),
  }).returning()
  return row!.id
}

async function auditCountFor(teammateId: string): Promise<number> {
  const [row] = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM audit_event
    WHERE event_type = 'teammate-org-unit-changed' AND subject_id = ${teammateId}::uuid`
  return Number(row!.n)
}

describe('C4 — the authorisation holds against a CONCURRENT change, not just a sequential one', () => {
  /*
   * Both cases below are the same defect: every check placeTeammate makes reads a
   * row another transaction can change before the UPDATE lands, and under READ
   * COMMITTED each statement takes its own snapshot. Checked-then-changed is not
   * reproducible on a quiescent database, so it is provoked here — one connection
   * holds an uncommitted change while the placement runs, and commits it inside
   * the window the placement would otherwise sail through.
   */
  const settle = () => new Promise((r) => setTimeout(r, 250))

  it('a target retired MID-PLACEMENT does not receive the teammate', async () => {
    const mate = await freshUnplacedInA()
    const [doomed] = await t.db.insert(schema.orgUnit).values({
      regionId: regionAId, path: 'pra.doomed', code: 'pra-doomed', displayName: 'A Doomed',
      unitType: 'practice', isCostOwningUnit: true,
    }).returning()

    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    let held!: () => void
    const holding = new Promise<void>((r) => { held = r })

    // A second connection retires the destination and sits on it, uncommitted.
    const holder = t.client.begin(async (tx) => {
      await tx`UPDATE org_unit SET retired_at = now() WHERE id = ${doomed!.id}::uuid`
      held()
      await released
    })
    await holding

    const placing = call<BulkResponse>(bulkPlace, ev({
      session: adminA(),
      body: { teammate_ids: [mate], org_unit_id: doomed!.id },
    }))
    // Long enough that an unlocked placement would have finished by now: without
    // the lock it validates against the pre-retire row and commits the move.
    await settle()
    release()
    await holder
    const res = await placing

    expect(res.placed).toBe(0)
    expect(res.results[0]!.status).toBe('failed')
    expect(res.results[0]!.status_code).toBe(422)
    expect(await homeOf(mate)).toBe(holdingAId)
  })

  it('a teammate reassigned to another region MID-PLACEMENT is not placed by their old region\'s admin', async () => {
    const mate = await freshUnplacedInA()

    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    let held!: () => void
    const holding = new Promise<void>((r) => { held = r })

    // A second connection moves them to region B (region_id follows org_unit_id
    // via the mig-0066 trigger) and holds the row, uncommitted.
    const holder = t.client.begin(async (tx) => {
      await tx`UPDATE teammate SET org_unit_id = ${holdingBId}::uuid WHERE id = ${mate}::uuid`
      held()
      await released
    })
    await holding

    const placing = call<BulkResponse>(bulkPlace, ev({
      session: adminA(),
      body: { teammate_ids: [mate], org_unit_id: couAId },
    }))
    await settle()
    release()
    await holder
    const res = await placing

    // Region A's admin has no scope over them any more, so this is a 403 — and
    // the region-A unit never becomes a region-B teammate's home.
    expect(res.placed).toBe(0)
    expect(res.results[0]!.status_code).toBe(403)
    expect(await homeOf(mate)).toBe(holdingBId)
  })
})

describe('C4 — a no-op re-place writes nothing', () => {
  it('re-placing someone into the unit they are ALREADY in returns noop and keeps their provenance', async () => {
    /*
     * Bulk place is reachable from the All and Placed views, so this is a
     * mis-click, not an exotic case. The person does not move either way — what
     * is at stake is that falling through would audit a placement that never
     * happened and STRIP placedVia/placedOwnerOid, converting a live
     * manager-chain placement into a manual override and removing them from
     * re-enrichment permanently.
     */
    const mate = await freshUnplacedInA({
      metadata: { placedVia: 'manager-chain', placedOwnerOid: 'oid-pr-owner' },
    })
    await t.client`UPDATE teammate SET org_unit_id = ${couAId}::uuid WHERE id = ${mate}::uuid`

    const res = await call<BulkResponse>(bulkPlace, ev({
      session: adminA(),
      body: { teammate_ids: [mate], org_unit_id: couAId },
    }))

    expect(res.noop).toBe(1)
    expect(res.placed).toBe(0)
    expect(res.failed).toBe(0)
    expect(res.results[0]!.status).toBe('noop')

    const [row] = await t.client<{ via: string | null; owner: string | null }[]>`
      SELECT metadata->>'placedVia' AS via, metadata->>'placedOwnerOid' AS owner
      FROM teammate WHERE id = ${mate}::uuid`
    expect(row!.via).toBe('manager-chain')
    expect(row!.owner).toBe('oid-pr-owner')
    // Nothing happened, so nothing is audited as having happened.
    expect(await auditCountFor(mate)).toBe(0)
  })

  it('a no-op into an ILLEGAL target is still a refusal — "nothing to do" is not a reason to stop checking', async () => {
    // Already on the holding node, re-placed onto the holding node. The target is
    // the one destination that would look like progress and be none, so the
    // target rule must win over the no-op shortcut.
    const mate = await freshUnplacedInA()
    await expect(
      call(bulkPlace, ev({
        session: adminA(),
        body: { teammate_ids: [mate], org_unit_id: holdingAId },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('C4 — a database failure is not a per-user refusal', () => {
  it('fails the request loudly and commits nothing, rather than reporting a 200 with the driver\'s message', async () => {
    /*
     * The batch's per-id isolation exists for REFUSALS — decisions this endpoint
     * made about one teammate. A deadlock, a dropped connection, a constraint
     * violation or a plain bug is none of those: nobody decided anything, and
     * every id after it ran against a database that had just failed. Catching
     * everything turned that into a tidy 200 full of "refused" rows carrying the
     * raw error text.
     *
     * Provoked with a real statement failure INSIDE the placement, after the good
     * id has already written its audit row and its UPDATE — so the assertion is
     * also that the committed-looking work is rolled back with it.
     */
    const good = await freshUnplacedInA()
    const poison = await freshUnplacedInA()
    await t.client`UPDATE teammate SET email = 'pr-poison@x.test' WHERE id = ${poison}::uuid`

    await t.client.unsafe(`
      CREATE FUNCTION pr_poison_placement() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.email = 'pr-poison@x.test' THEN RAISE EXCEPTION 'poisoned placement'; END IF;
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER pr_poison_placement_trg BEFORE UPDATE ON teammate
        FOR EACH ROW EXECUTE FUNCTION pr_poison_placement();`)
    try {
      await expect(
        call(bulkPlace, ev({
          session: adminA(),
          // `good` FIRST: it places and audits before the failure is reached.
          body: { teammate_ids: [good, poison], org_unit_id: couAId },
        })),
      ).rejects.toThrow()

      // Nothing survived — not the placement, not its audit row.
      expect(await homeOf(good)).toBe(holdingAId)
      expect(await homeOf(poison)).toBe(holdingAId)
      expect(await auditCountFor(good)).toBe(0)
      expect(await auditCountFor(poison)).toBe(0)
    } finally {
      await t.client.unsafe(`
        DROP TRIGGER IF EXISTS pr_poison_placement_trg ON teammate;
        DROP FUNCTION IF EXISTS pr_poison_placement();`)
    }
  })
})

describe('C3 — the directory snapshot is dated, so it can be judged stale', () => {
  it('returns capturedAt, and null for a teammate no placement lane has looked up', async () => {
    /*
     * The snapshot module's claim is that a stale department is legible AS stale.
     * That claim is only true if the capture time reaches the screen: the two
     * columns beside it are indistinguishable from live truth without it, and an
     * admin moving 40 people because they share a department is acting on a fact
     * that may be months old.
     */
    const dated = await freshUnplacedInA()
    await captureDirectorySnapshot(
      t.db as unknown as Parameters<typeof captureDirectorySnapshot>[0],
      dated,
      { department: 'Sales-Solution', companyName: 'Insight A' },
    )

    const res = await call<TeammatesResponse>(teammatesGet, ev({
      method: 'GET', session: adminA(), query: { region: regionAId, placement: 'all', limit: '200' },
    }))
    const row = res.teammates.find((r) => r.id === dated)
    expect(row?.department).toBe('Sales-Solution')
    expect(row?.directory_captured_at).toBeTruthy()
    expect(Number.isNaN(Date.parse(String(row!.directory_captured_at)))).toBe(false)

    // Never captured is NULL, not a date that would imply we had looked.
    const never = res.teammates.find((r) => r.email === 'pr-admin-a@x.test')
    expect(never?.directory_captured_at).toBeNull()
  })
})
