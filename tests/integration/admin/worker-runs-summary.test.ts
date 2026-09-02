// @vitest-environment node
/*
 * GET /api/v1/admin/worker-runs?summary=24h — the O4 duty-cycle aggregate
 * (docs/design/performance-observability-baseline.md, dr-M8 population
 * semantics). Pins, against real Postgres:
 *   - RBAC: a developer is rejected 403 (same gate as the list — unchanged);
 *   - the response-shape decision: summary mode returns { summary } ONLY,
 *     and the default mode still returns the paginated list with NO summary;
 *   - population: 'success' + 'failure' count; 'skipped', still-running
 *     (finished_at NULL) and stale (>24 h old) rows are excluded; a worker
 *     with ONLY excluded rows has no entry at all (the UI's em-dash case);
 *   - the math: p50 exact on an odd set, INTERPOLATED on an even set
 *     (percentile_cont, not _disc), max/busy summed over counted rows;
 *   - a reaped run ('failure', finished, NULL duration_ms — run-health.ts):
 *     its finished_at - started_at span IS its p50/max/busy contribution
 *     (r3-M3 — a worker wedged for hours must show hours, never 0)
 *     counts toward `runs` but contributes nothing to p50/max/busy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/admin/worker-runs/index.get'

let t: TestDb
let regionId: string
let ouId: string
let adminId: string
let devId: string

/** Minimal h3-shaped event with a query string + injected session. */
function ev(opts: { session: Session; query?: Record<string, string> }) {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
  const headers: Record<string, string> = {}
  const e = {
    // h3's getQuery reads event.path, NOT node.req.url — a mock without it
    // silently yields an empty query, so every param test would pass vacuously.
    path: `/api/v1/admin/worker-runs${qs}`,
    node: {
      req: {
        method: 'GET',
        url: `/api/v1/admin/worker-runs${qs}`,
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

const admin = (): Session => ({ teammateId: adminId, email: 'wrs-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'wrs.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'wrs-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'wrs.svc' })

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000)

type SummaryEntry = { workerName: string; runs: number; p50Ms: number | null; maxMs: number | null; busyMs: number }

async function getSummary(): Promise<SummaryEntry[]> {
  const out = (await handler(ev({ session: admin(), query: { summary: '24h' } }))) as { summary: SummaryEntry[] }
  return out.summary
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'wrs-r', displayName: 'WRS R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'wrs.svc', code: 'wrs-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [a] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-wrs-admin', email: 'wrs-admin@x.test', role: 'admin', regionId, orgUnitId: ouId })
    .returning()
  adminId = a!.id
  const [d] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-wrs-dev', email: 'wrs-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  devId = d!.id

  // One fixed dataset; every test reads it. Times are relative to NOW because
  // the endpoint's window is NOW() - 24 h (the endpoint owns the clock; there
  // is no injectable "today" here).
  await t.db.insert(schema.workerRun).values([
    // alpha — three counted successes (odd set: p50 exact = 200)...
    { workerName: 'alpha', status: 'success', startedAt: hoursAgo(1), finishedAt: hoursAgo(1), durationMs: 100 },
    { workerName: 'alpha', status: 'success', startedAt: hoursAgo(2), finishedAt: hoursAgo(2), durationMs: 200 },
    { workerName: 'alpha', status: 'success', startedAt: hoursAgo(3), finishedAt: hoursAgo(3), durationMs: 300 },
    // ...plus one of each EXCLUDED shape (dr-M8): skipped bookkeeping row,
    // still-running row, and a success started outside the 24 h window.
    { workerName: 'alpha', status: 'skipped', startedAt: hoursAgo(1), finishedAt: hoursAgo(1), durationMs: 0 },
    { workerName: 'alpha', status: 'running', startedAt: hoursAgo(0.5), finishedAt: null, durationMs: null },
    { workerName: 'alpha', status: 'success', startedAt: hoursAgo(25), finishedAt: hoursAgo(25), durationMs: 9_999 },
    // beta — a failure COUNTS (design: success + error runs), and the even set
    // {100, 400} distinguishes percentile_cont (250) from percentile_disc (100).
    { workerName: 'beta', status: 'success', startedAt: hoursAgo(4), finishedAt: hoursAgo(4), durationMs: 100 },
    { workerName: 'beta', status: 'failure', startedAt: hoursAgo(5), finishedAt: hoursAgo(5), durationMs: 400 },
    // gamma — a reaped run: terminal 'failure', finished 3 h after start, but
    // NO duration (run-health.ts reapStaleWorkerRuns sets none) — the wedge
    // span itself is the busy signal (r3-M3).
    { workerName: 'gamma', status: 'failure', startedAt: hoursAgo(6), finishedAt: hoursAgo(3), durationMs: null },
    // delta — ONLY excluded rows → must have no summary entry at all.
    { workerName: 'delta', status: 'skipped', startedAt: hoursAgo(1), finishedAt: hoursAgo(1), durationMs: 0 },
  ])
}, 180_000)

afterAll(async () => { await stopTestDb(t) }, 30_000)

describe('GET /admin/worker-runs?summary=24h', () => {
  it('a developer is rejected 403 (gate unchanged from the list mode)', async () => {
    await expect(handler(ev({ session: dev(), query: { summary: '24h' } }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('summary mode returns { summary } only; default mode returns the list with no summary', async () => {
    const summaryOut = (await handler(ev({ session: admin(), query: { summary: '24h' } }))) as Record<string, unknown>
    expect(Object.keys(summaryOut).sort()).toEqual(['summary'])

    const listOut = (await handler(ev({ session: admin() }))) as Record<string, unknown>
    expect(listOut).toMatchObject({ total: expect.any(Number), limit: 50, offset: 0 })
    expect(Array.isArray(listOut.runs)).toBe(true)
    expect(listOut).not.toHaveProperty('summary')
  })

  it('excludes skipped, running and stale rows; aggregates the counted set right', async () => {
    const alpha = (await getSummary()).find((s) => s.workerName === 'alpha')
    // runs=3 proves all three exclusions at once: any of the skipped / running /
    // 25 h-old rows leaking in would make it 4+.
    expect(alpha).toEqual({ workerName: 'alpha', runs: 3, p50Ms: 200, maxMs: 300, busyMs: 600 })
  })

  it('failures count, and p50 interpolates on an even set (percentile_cont)', async () => {
    const beta = (await getSummary()).find((s) => s.workerName === 'beta')
    expect(beta).toEqual({ workerName: 'beta', runs: 2, p50Ms: 250, maxMs: 400, busyMs: 500 })
  })

  it('a reaped run (NULL duration) falls back to finished-started for busy time (r3-M3)', async () => {
    const gamma = (await getSummary()).find((s) => s.workerName === 'gamma')
    const threeHoursMs = 3 * 60 * 60 * 1000
    expect(gamma).toBeDefined()
    expect(gamma!.runs).toBe(1)
    // The reap stamps finished_at at reap time; the span IS the wedge.
    expect(gamma!.busyMs).toBeGreaterThanOrEqual(threeHoursMs - 5_000)
    expect(gamma!.busyMs).toBeLessThanOrEqual(threeHoursMs + 5_000)
    expect(gamma!.p50Ms).toBe(gamma!.busyMs)
    expect(gamma!.maxMs).toBe(gamma!.busyMs)
  })

  it('a worker with only excluded rows has NO entry (the em-dash case, not zeros)', async () => {
    expect((await getSummary()).some((s) => s.workerName === 'delta')).toBe(false)
  })

  it('rejects a summary window the contract does not offer', async () => {
    await expect(handler(ev({ session: admin(), query: { summary: '7d' } }))).rejects.toMatchObject({ statusCode: 400 })
  })
})
