// @vitest-environment node
/*
 * #582: Admin → Projects and Admin → Devices reach every row.
 *
 * Route tests (CLAUDE.md rule 10) for the two GET routes' new server search,
 * filters and offset paging. Both lists used to stop at their first window
 * (projects at 50, devices at the server default of 100) with nothing to refine
 * with. What must hold:
 *   - a search finds a row beyond the first window, and paging reaches the last;
 *   - every filter narrows the rows AND the total identically;
 *   - region scope still bounds every new parameter: a matching row in another
 *     region is never returned, and ?region= another region is still 403;
 *   - the devices "Silent" filter agrees with the row's own badge (the SQL
 *     predicate and projectInstanceRow must not drift);
 *   - a LIKE metacharacter in the search is literal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { recordBearerAuthFailed } from '../../../server/db/instance-health'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import projectsHandler from '../../../server/api/v1/admin/projects.get'
import instancesHandler from '../../../server/api/v1/admin/instances.get'

let t: TestDb
let regionA: string
let regionB: string
let ouA: string
let ouB: string

const ADMIN_A = '9a1e0000-0000-4000-8000-0000000005a1'
const PROJECT_COUNT = 120
const DEV_COUNT = 110
// Device of the 110th teammate, enrolled FIRST so it sorts last (ts_start DESC).
let lastDeviceId: string
let silentDeviceId: string
let cannotSendDeviceId: string
let notInUseDeviceIds: string[]
let activeDeviceId: string
let revokedDeviceId: string
let copilotDeviceId: string

const pad = (n: number) => String(n).padStart(3, '0')

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [ra] = await t.db.insert(schema.region).values({ code: 'als-a', displayName: 'ALS A' }).returning()
  regionA = ra!.id
  const [rb] = await t.db.insert(schema.region).values({ code: 'als-b', displayName: 'ALS B' }).returning()
  regionB = rb!.id
  const [oa] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionA, path: 'alsa.svc', code: 'alsa-svc', displayName: 'Svc A', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouA = oa!.id
  const [ob] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionB, path: 'alsb.svc', code: 'alsb-svc', displayName: 'Svc B', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouB = ob!.id

  await t.db.insert(schema.teammate).values({
    id: ADMIN_A, entraOid: 'oid-als-admin', email: 'als-admin@example.com', displayName: 'Admin A', role: 'admin', regionId: regionA, orgUnitId: ouA,
  })

  // ── Projects: 120 in region A (P-001..P-120), plus a same-named foil in B.
  // Every 10th has ended; every 4th has a budget.
  const now = Date.now()
  const projectRows = Array.from({ length: PROJECT_COUNT }, (_, i) => {
    const n = i + 1
    return {
      code: `P-${pad(n)}`,
      codeHash: `h-als-${n}`,
      displayName: n === 77 ? 'Harbour 100%_Rebuild' : `Project ${pad(n)}`,
      type: 'billable',
      regionId: regionA,
      costOwningUnitId: ouA,
      endDate: n % 10 === 0 ? new Date(now - 86_400_000) : null,
    }
  })
  const inserted = await t.db.insert(schema.project).values(projectRows).returning()
  const [audit] = await t.db
    .insert(schema.auditEvent)
    .values({ eventType: 'allocation-created', actorSystem: 'test', payload: {} })
    .returning()
  const byCode = new Map(inserted.map((p) => [p.code, p.id]))
  await t.db.insert(schema.allocation).values(
    Array.from({ length: PROJECT_COUNT / 4 }, (_, i) => ({
      scopeType: 'project',
      scopeId: byCode.get(`P-${pad((i + 1) * 4)}`)!,
      budgetUsd: '1000.00',
      effective: '[2026-01-01,2099-01-01)',
      allocationKind: 'baseline',
      auditEventId: audit!.id,
    })),
  )
  await t.db.insert(schema.project).values({
    code: 'P-119-B', codeHash: 'h-als-b', displayName: 'Project 119 in B', type: 'billable', regionId: regionB, costOwningUnitId: ouB,
  })

  // ── Devices: 110 teammates in region A, one device each, enrolled oldest
  // first for dev 110 so its device is the LAST row of the default order.
  const devs = await t.db
    .insert(schema.teammate)
    .values(
      Array.from({ length: DEV_COUNT }, (_, i) => ({
        entraOid: `oid-als-dev-${i + 1}`,
        email: `dev-${pad(i + 1)}@example.com`,
        displayName: `Dev ${pad(i + 1)}`,
        role: 'developer',
        regionId: regionA,
        orgUnitId: ouA,
      })),
    )
    .returning()
  const [foil] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-als-foil', email: 'dev-110@other.test', displayName: 'Dev 110 in B', role: 'developer', regionId: regionB, orgUnitId: ouB })
    .returning()

  const deviceIds = devs.map(() => randomUUID())
  lastDeviceId = deviceIds[DEV_COUNT - 1]!
  await t.db.insert(schema.instanceAttestation).values(
    devs.map((d, i) => ({
      instanceId: deviceIds[i]!,
      principalOid: d.entraOid,
      teammateId: d.id,
      // Dev 110 enrolled longest ago → last under ORDER BY ts_start DESC.
      tsStart: new Date(now - (DEV_COUNT - i) * 3_600_000 + (i === DEV_COUNT - 1 ? -60 * 86_400_000 : i === 7 ? -50 * 86_400_000 : 0)),
      tool: i === 5 ? 'copilot-cli' : 'claude-code',
      sessionTokenHash: `h-als-dev-${i}`,
      regionId: regionA,
      orgUnitId: ouA,
      attestationState: 'unassigned',
      tsActualEnd: i === 3 ? new Date(now - 3_600_000) : null,
    })),
  )
  revokedDeviceId = deviceIds[3]!
  copilotDeviceId = deviceIds[5]!
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: randomUUID(), principalOid: 'oid-als-foil', teammateId: foil!.id, tool: 'claude-code',
    sessionTokenHash: 'h-als-foil', regionId: regionB, orgUnitId: ouB, attestationState: 'unassigned',
  })

  // Dev 1's device emitted an hour ago (sending); dev 2's two days ago (idle);
  // dev 8's 40 days ago (not in use). Dev 110 was connected 60+ days ago and never
  // used (not in use). Dev 7's credential is being rejected (cannot send). Every
  // other live device was connected recently with no usage yet (idle).
  activeDeviceId = deviceIds[0]!
  silentDeviceId = deviceIds[1]!
  const [rc] = await t.db.select({ id: schema.rateCard.id, version: schema.rateCard.version }).from(schema.rateCard).limit(1)
  const rec = (i: number, at: Date) => ({
    instanceId: deviceIds[i]!,
    claudeSessionId: `conv-als-${i}`,
    teammateId: devs[i]!.id,
    projectId: null,
    regionId: regionA,
    orgUnitId: ouA,
    costOwningUnitId: null,
    tool: 'claude-code',
    model: 'claude-sonnet-4-6',
    tokenType: 'input',
    tokens: BigInt(1000),
    costUsd: '1.000000',
    rateCardId: rc!.id,
    rateCardVersion: rc!.version,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: at,
  })
  await t.db.insert(schema.attributionRecord).values([
    rec(0, new Date(now - 3_600_000)),
    rec(1, new Date(now - 2 * 86_400_000)),
    rec(7, new Date(now - 40 * 86_400_000)),
  ])
  cannotSendDeviceId = deviceIds[6]!
  await recordBearerAuthFailed(t.db as never, cannotSendDeviceId)
  notInUseDeviceIds = [deviceIds[7]!, lastDeviceId]
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

const adminA = (): Session =>
  ({ teammateId: ADMIN_A, email: 'als-admin@example.com', displayName: 'Admin A', role: 'admin', regionId: regionA, orgPath: 'alsa.svc' }) as Session

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
  return e as never
}

interface ProjectsOut { projects: { code: string; ended: boolean; has_budget: boolean }[]; total: number }
interface DevicesOut {
  instances: { instance_id: string; teammate_email: string; tool: string; revoked: boolean; state: string }[]
  total: number
  tools: string[]
}
const projects = (q: string) => projectsHandler(ev(adminA(), `region=${regionA}&${q}`)) as Promise<ProjectsOut>
const devices = (q: string) => instancesHandler(ev(adminA(), `region=${regionA}&${q}`)) as Promise<DevicesOut>

describe('GET /api/v1/admin/projects: search, filters, paging (#582)', () => {
  it('a code that sorts 119th is found by search, and only in the caller region', async () => {
    const out = await projects('q=P-119&limit=50')
    expect(out.projects.map((p) => p.code)).toEqual(['P-119'])
    expect(out.total).toBe(1)
  })

  it('searches the display name too, with LIKE metacharacters taken literally', async () => {
    const pct = await projects(`q=${encodeURIComponent('100%_')}`)
    expect(pct.projects.map((p) => p.code)).toEqual(['P-077'])
    // A bare "%" would match everything if it were not escaped.
    const bare = await projects(`q=${encodeURIComponent('%')}`)
    expect(bare.projects.map((p) => p.code)).toEqual(['P-077'])
  })

  it('pages: the first page is 1 to 50 of 120, and Next reaches row 120', async () => {
    const first = await projects('limit=50&offset=0')
    expect(first.projects).toHaveLength(50)
    expect(first.total).toBe(PROJECT_COUNT)
    expect(first.projects[0]!.code).toBe('P-001')
    const last = await projects('limit=50&offset=100')
    expect(last.projects).toHaveLength(20)
    expect(last.projects.at(-1)!.code).toBe('P-120')
  })

  it('status and budget filters narrow the rows and the total alike', async () => {
    const ended = await projects('status=ended&limit=200')
    expect(ended.total).toBe(12)
    expect(ended.projects).toHaveLength(12)
    expect(ended.projects.every((p) => p.ended)).toBe(true)

    const active = await projects('status=active&limit=200')
    expect(active.total).toBe(PROJECT_COUNT - 12)
    expect(active.projects.every((p) => !p.ended)).toBe(true)

    const noBudget = await projects('budget=none&limit=200')
    expect(noBudget.total).toBe(PROJECT_COUNT - PROJECT_COUNT / 4)
    expect(noBudget.projects.every((p) => !p.has_budget)).toBe(true)

    // Combined: ended AND no budget. Ended = multiples of 10; budget = multiples of 4.
    const both = await projects('status=ended&budget=none&limit=200')
    expect(both.projects.map((p) => p.code)).toEqual(['P-010', 'P-030', 'P-050', 'P-070', 'P-090', 'P-110'])
    expect(both.total).toBe(6)
  })

  it('a region admin still cannot read another region, with or without a search', async () => {
    await expect(projectsHandler(ev(adminA(), `region=${regionB}&q=P-119`))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects an unknown filter value', async () => {
    await expect(projects('status=retired')).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('GET /api/v1/admin/instances: search, filters, paging (#582)', () => {
  it('a search by teammate email finds a device beyond the first 100, and only in the caller region', async () => {
    const first = await devices('limit=100&offset=0')
    expect(first.total).toBe(DEV_COUNT)
    expect(first.instances.map((i) => i.instance_id)).not.toContain(lastDeviceId)

    const found = await devices('q=dev-110@')
    expect(found.instances.map((i) => i.instance_id)).toEqual([lastDeviceId])
    expect(found.total).toBe(1)
  })

  it('searches the teammate name too', async () => {
    const found = await devices(`q=${encodeURIComponent('Dev 110')}`)
    expect(found.instances.map((i) => i.instance_id)).toEqual([lastDeviceId])
  })

  it('Next reaches the last device', async () => {
    const last = await devices('limit=100&offset=100')
    expect(last.instances).toHaveLength(DEV_COUNT - 100)
    expect(last.instances.at(-1)!.instance_id).toBe(lastDeviceId)
  })

  it('status filters agree with the row badges, and narrow the total alike', async () => {
    const revoked = await devices('status=revoked&limit=500')
    expect(revoked.instances.map((i) => i.instance_id)).toEqual([revokedDeviceId])
    expect(revoked.total).toBe(1)

    const sending = await devices('status=sending&limit=500')
    expect(sending.instances.map((i) => i.instance_id)).toEqual([activeDeviceId])

    const cannot = await devices('status=cannot-send&limit=500')
    expect(cannot.instances.map((i) => i.instance_id)).toEqual([cannotSendDeviceId])

    const notInUse = await devices('status=not-in-use&limit=500')
    expect(notInUse.instances.map((i) => i.instance_id).sort()).toEqual([...notInUseDeviceIds].sort())

    const idle = await devices('status=idle&limit=500')
    expect(idle.instances.map((i) => i.instance_id)).toContain(silentDeviceId)
    expect(idle.total).toBe(DEV_COUNT - 5)

    // The filter and the row's own state agree row for row.
    for (const [state, page] of Object.entries({ revoked, sending, 'cannot-send': cannot, 'not-in-use': notInUse, idle })) {
      expect(page.instances.every((i) => i.state === state)).toBe(true)
    }
    // The five states partition the region.
    expect(revoked.total + sending.total + cannot.total + notInUse.total + idle.total).toBe(DEV_COUNT)
  })

  it('the old "silent" filter value is refused', async () => {
    await expect(devices('status=silent')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('the tool filter keeps one tool, and tools lists only this region', async () => {
    const out = await devices('tool=copilot-cli')
    expect(out.instances.map((i) => i.instance_id)).toEqual([copilotDeviceId])
    expect(out.tools).toEqual(['claude-code', 'copilot-cli'])
  })

  it('a region admin still cannot read another region, with or without a search', async () => {
    await expect(instancesHandler(ev(adminA(), `region=${regionB}&q=dev-110`))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects a malformed tool', async () => {
    await expect(devices(`tool=${encodeURIComponent("x' OR 1=1")}`)).rejects.toMatchObject({ statusCode: 400 })
  })
})
