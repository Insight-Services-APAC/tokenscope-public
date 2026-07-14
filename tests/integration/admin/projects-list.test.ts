// @vitest-environment node
/*
 * GET /api/v1/admin/projects — the region-scoped projects list. Focus: the
 * `allocation_id` field that drives the Admin → Projects "Budget" deep-link
 * (to the allocation editor's top-up control).
 *
 * Load-bearing case (plan adversarial R1 / H1): for a per_dev_fixed project,
 * per-developer caps are ALSO allocation_kind='baseline' rows — only teammate_id
 * distinguishes them — and split.post.ts gives every cap the SAME effective window
 * as the pool baseline. So `ORDER BY lower(effective) DESC LIMIT 1` over
 * kind='baseline' alone is non-deterministic and can land on a developer cap.
 * allocation_id MUST be the shared POOL baseline (teammate_id IS NULL), never a cap.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import listHandler from '../../../server/api/v1/admin/projects.get'

let t: TestDb
let regionA: string
let ouA: string
let adminId: string
let devX: string
let devY: string

// Per-dev caps share the pool's window (split.post.ts) — same lower(effective).
const WINDOW = '[2026-01-01,2099-01-01)'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [ra] = await t.db.insert(schema.region).values({ code: 'bl-a', displayName: 'BL A' }).returning()
  regionA = ra!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionA, path: 'bla.svc', code: 'bla-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouA = o!.id
  const [admin] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-bl-admin', email: 'bl-admin@x.test', role: 'admin', regionId: regionA, orgUnitId: ouA })
    .returning()
  adminId = admin!.id
  const [dx] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-bl-x', email: 'bl-x@x.test', role: 'developer', regionId: regionA, orgUnitId: ouA })
    .returning()
  devX = dx!.id
  const [dy] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-bl-y', email: 'bl-y@x.test', role: 'developer', regionId: regionA, orgUnitId: ouA })
    .returning()
  devY = dy!.id
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function mkProject(code: string): Promise<string> {
  const [p] = await t.db
    .insert(schema.project)
    .values({ code, codeHash: `h-${code}`, displayName: code, type: 'billable', regionId: regionA, costOwningUnitId: ouA })
    .returning()
  return p!.id
}
async function auditId(): Promise<string> {
  const [e] = await t.db
    .insert(schema.auditEvent)
    .values({ eventType: 'allocation-created', actorSystem: 'test', payload: {} })
    .returning()
  return e!.id
}
/** Insert a baseline allocation; teammateId set = a per-developer cap, null = the shared pool. */
async function addBaseline(projectId: string, opts: { teammateId?: string; budget?: string } = {}): Promise<string> {
  const [a] = await t.db
    .insert(schema.allocation)
    .values({
      scopeType: 'project',
      scopeId: projectId,
      teammateId: opts.teammateId ?? null,
      budgetUsd: opts.budget ?? '1000.00',
      effective: WINDOW,
      allocationKind: 'baseline',
      auditEventId: await auditId(),
    })
    .returning()
  return a!.id
}

const adminA = (): Session => ({
  teammateId: adminId,
  email: 'bl-admin@x.test',
  displayName: 'Admin',
  role: 'admin',
  regionId: regionA,
  orgPath: 'bla.svc',
})

function ev(session: Session, query: string) {
  const url = '/x?' + query
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url,
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof listHandler>[0]
}

interface ProjRow { id: string; code: string; has_budget: boolean; allocation_id: string | null }

async function list(): Promise<ProjRow[]> {
  const res = await listHandler(ev(adminA(), `region=${regionA}&limit=200`))
  return (res as { projects: ProjRow[] }).projects
}

describe('GET /api/v1/admin/projects — allocation_id (Budget deep-link)', () => {
  it('per_dev_fixed project: allocation_id is the SHARED POOL baseline, never a developer cap (H1)', async () => {
    const id = await mkProject('BL-PERDEV')
    // Insert a cap BEFORE the pool (and one after). All three are kind='baseline'
    // in the SAME effective window, so lower(effective) ties — without the
    // teammate_id IS NULL guard the LIMIT 1 falls to heap/insertion order and would
    // return capX (inserted first), NOT the pool. This ordering makes the test
    // genuinely FAIL if the guard regresses (verified: guard-removed → returns capX).
    const capX = await addBaseline(id, { teammateId: devX, budget: '200.00' })
    const pool = await addBaseline(id) // teammate_id NULL — the shared pool
    const capY = await addBaseline(id, { teammateId: devY, budget: '200.00' })
    const row = (await list()).find((r) => r.id === id)!
    expect(row.has_budget).toBe(true)
    expect(row.allocation_id).toBe(pool)
    expect(row.allocation_id).not.toBe(capX)
    expect(row.allocation_id).not.toBe(capY)
  })

  it('shared-pool project: allocation_id is its baseline', async () => {
    const id = await mkProject('BL-POOL')
    const base = await addBaseline(id)
    const row = (await list()).find((r) => r.id === id)!
    expect(row.allocation_id).toBe(base)
  })

  it('no-budget project: has_budget false + allocation_id null (Budget link disabled)', async () => {
    const id = await mkProject('BL-NONE')
    const row = (await list()).find((r) => r.id === id)!
    expect(row.has_budget).toBe(false)
    expect(row.allocation_id).toBeNull()
  })
})
