// @vitest-environment node
/*
 * GET /api/v1/admin/diagnostics — the workers[] STALL EVIDENCE fields (PR #319).
 * A module test is not a route test (CLAUDE.md rule 10): decideReadPathAlert /
 * streakSourceCoverage are proven elsewhere, but the SQL projection that turns
 * worker_run.result->'sourceCoverage' into the operator's page is only exercised
 * through the handler. Pins, against real Postgres:
 *   - a rows-arrived reader run surfaces sourceCoverage + rowsReceived +
 *     newEventsSeen on the azure-monitor-read row;
 *   - a run recorded BEFORE the probe shipped (no sourceCoverage key) surfaces
 *     null on all four, so the UI shows "?" (unknown), never a fabricated 0;
 *   - RBAC: a developer is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/admin/diagnostics/index.get'

let t: TestDb
let regionId: string
let ouId: string
let adminId: string
let devId: string

function ev(opts: { session: Session }) {
  const headers: Record<string, string> = {}
  const e = {
    path: '/api/v1/admin/diagnostics',
    node: {
      req: {
        method: 'GET',
        url: '/api/v1/admin/diagnostics',
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
  return e as unknown as Parameters<typeof handler>[0]
}

const admin = (): Session => ({ teammateId: adminId, email: 'dse-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'dse.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'dse-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'dse.svc' })

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000)

interface WorkerRow {
  worker: string
  rowsAffected: number | null
  sessionsProcessed: number | null
  newEventsSeen: number | null
  sourceCoverage: string | null
  sourceRowsReceived: number | null
  sourceRowsDropped: number | null
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'dse-r', displayName: 'DSE R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'dse.svc', code: 'dse-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [a] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-dse-admin', email: 'dse-admin@x.test', role: 'admin', regionId, orgUnitId: ouId })
    .returning()
  adminId = a!.id
  const [d] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-dse-dev', email: 'dse-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  devId = d!.id
})

afterAll(async () => {
  await stopTestDb(t)
})

async function readerRow(): Promise<WorkerRow> {
  const out = (await handler(ev({ session: admin() }))) as { workers: WorkerRow[] }
  const row = out.workers.find((w) => w.worker === 'azure-monitor-read')
  expect(row, 'the azure-monitor-read row must be present').toBeDefined()
  return row!
}

describe('GET /diagnostics — stall evidence (sourceCoverage / newEventsSeen)', () => {
  it('surfaces the ingest-coverage verdict + metrics on the latest reader run', async () => {
    await t.db.delete(schema.workerRun)
    await t.db.insert(schema.workerRun).values({
      workerName: 'azure-monitor-read',
      status: 'success',
      startedAt: minsAgo(2),
      finishedAt: minsAgo(2),
      rowsAffected: 0,
      result: {
        sessionsProcessed: 1,
        attributionRowsWritten: 0,
        newEventsSeen: 7,
        sourceCoverage: { status: 'rows-arrived', rowsReceived: 708, rowsDropped: 3 },
      },
    })
    const row = await readerRow()
    expect(row.sourceCoverage).toBe('rows-arrived')
    expect(row.sourceRowsReceived).toBe(708)
    expect(row.sourceRowsDropped).toBe(3)
    expect(row.newEventsSeen).toBe(7)
    expect(row.rowsAffected).toBe(0)
  })

  it('a PRE-DEPLOY run (no sourceCoverage key) surfaces null on all four — unknown, never 0', async () => {
    await t.db.delete(schema.workerRun)
    await t.db.insert(schema.workerRun).values({
      workerName: 'azure-monitor-read',
      status: 'success',
      startedAt: minsAgo(2),
      finishedAt: minsAgo(2),
      rowsAffected: 0,
      result: { sessionsProcessed: 5, attributionRowsWritten: 0 },
    })
    const row = await readerRow()
    expect(row.sourceCoverage).toBeNull()
    expect(row.sourceRowsReceived).toBeNull()
    expect(row.newEventsSeen).toBeNull()
  })

  it('refuses a developer', async () => {
    await expect(handler(ev({ session: dev() }))).rejects.toMatchObject({ statusCode: 403 })
  })
})
