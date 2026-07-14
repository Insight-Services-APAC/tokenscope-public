// @vitest-environment node
/*
 * worker-execution-health — the signal the freshness panel CANNOT give.
 *
 * Motivation: the diagnostics freshness panel measures DATA recency
 * (max ts_recorded) and reported "flowing" green while the joiner cron
 * was FAILING every run with a 504 (a partially-completing worker still
 * advances ts_recorded). worker_run records each dispatch's OUTCOME so a
 * failing worker becomes visible.
 *
 * Covers:
 *   (a) a successful dispatch records status='success' + duration_ms.
 *   (b) a worker that throws records status='failure' + error AND the
 *       endpoint still RE-THROWS (the worker's own error is not swallowed).
 *   (c) a bookkeeping-insert failure does NOT break the worker (the run
 *       still completes and returns its result).
 *   (d) the diagnostics `workers` block reports a worker with trailing
 *       failures as 'failing' with the right consecutiveFailures, and a
 *       healthy one as 'ok'.
 *   (d3-d5) MEDIUM-1: a killed/wedged worker (a 'running' row that never
 *       transitioned) is surfaced as 'failing' (red), not masked as 'stale'
 *       (amber): a running row over a failure pile counts the trailing
 *       failures; a stale lone running (old started_at) is failing; a fresh
 *       running (just started) is in-progress, not failing.
 *
 * Real testcontainers Postgres per AGENTS.md (never mock Drizzle).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import {
  recordWorkerRunStart,
  recordWorkerRunOutcome,
} from '../../../server/workers/run-health'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

let t: TestDb
let regionId: string

beforeAll(async () => {
  process.env.NUXT_SESSION_SECRET = 'worker-run-health-test-padded-to-thirty-two'
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  vi.resetModules()

  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'wrh', displayName: 'Worker-Run-Health Region' })
    .returning()
  regionId = region!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function latestRun(workerName: string) {
  const rows = await t.client<
    {
      status: string
      duration_ms: number | null
      error: string | null
      finished_at: string | null
    }[]
  >`
    SELECT status, duration_ms, error, finished_at::text AS finished_at
      FROM worker_run
     WHERE worker_name = ${workerName}
     ORDER BY started_at DESC
     LIMIT 1
  `
  return rows[0]
}

// A faithful replica of the dispatch wrapper in
// server/api/v1/internal/run-worker/[name].post.ts — the bookkeeping
// contract under test (record start, transition on success/failure,
// re-throw the worker's error, never let bookkeeping break the worker).
async function dispatchWithBookkeeping(
  db: typeof t.db,
  name: string,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const startedAt = Date.now()
  const runId = await recordWorkerRunStart(db, name)
  let result: unknown
  try {
    result = await run()
  } catch (err) {
    await recordWorkerRunOutcome(db, runId, {
      status: 'failure',
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
  await recordWorkerRunOutcome(db, runId, {
    status: 'success',
    durationMs: Date.now() - startedAt,
  })
  return result
}

describe('worker_run bookkeeping (record start + outcome)', () => {
  it('(a) a successful run records status=success + duration', async () => {
    const result = await dispatchWithBookkeeping(t.db, 'wrh-success', async () => {
      await new Promise((r) => setTimeout(r, 2))
      return { ok: true }
    })
    expect(result).toEqual({ ok: true })

    const run = await latestRun('wrh-success')
    expect(run?.status).toBe('success')
    expect(run?.duration_ms).toBeGreaterThanOrEqual(0)
    expect(run?.finished_at).not.toBeNull()
    expect(run?.error).toBeNull()
  })

  it('(b) a throwing worker records status=failure + error AND re-throws', async () => {
    const boom = new Error('joiner 504 from log-analytics')
    await expect(
      dispatchWithBookkeeping(t.db, 'wrh-fail', async () => {
        throw boom
      }),
    ).rejects.toThrow('joiner 504 from log-analytics')

    const run = await latestRun('wrh-fail')
    expect(run?.status).toBe('failure')
    expect(run?.error).toContain('joiner 504')
    expect(run?.finished_at).not.toBeNull()
  })

  it('(b2) the error is truncated to ~500 chars (never an unbounded blob)', async () => {
    const long = 'x'.repeat(2000)
    await expect(
      dispatchWithBookkeeping(t.db, 'wrh-fail-long', async () => {
        throw new Error(long)
      }),
    ).rejects.toThrow()
    const run = await latestRun('wrh-fail-long')
    expect(run?.error?.length).toBeLessThanOrEqual(500)
  })

  it('(c) a bookkeeping-insert failure does NOT break the worker', async () => {
    // A DB whose insert always rejects — recordWorkerRunStart must swallow
    // and return null, and the worker must still run + return its result.
    const brokenDb = {
      insert: () => {
        throw new Error('bookkeeping table is on fire')
      },
      update: () => {
        throw new Error('bookkeeping table is on fire')
      },
    } as unknown as typeof t.db

    let ran = false
    const result = await dispatchWithBookkeeping(brokenDb, 'wrh-broken', async () => {
      ran = true
      return { value: 42 }
    })
    expect(ran).toBe(true)
    expect(result).toEqual({ value: 42 })
    // No row was written (insert failed) — but the worker still succeeded.
    const run = await latestRun('wrh-broken')
    expect(run).toBeUndefined()
  })

  it('(c2) recordWorkerRunStart returns null when the insert throws', async () => {
    const brokenDb = {
      insert: () => {
        throw new Error('nope')
      },
    } as unknown as typeof t.db
    const id = await recordWorkerRunStart(brokenDb, 'wrh-x')
    expect(id).toBeNull()
    // Outcome with a null runId is a safe no-op.
    await expect(
      recordWorkerRunOutcome(brokenDb, null, { status: 'success', durationMs: 1 }),
    ).resolves.toBeUndefined()
  })
})

// ── Diagnostics `workers` block ────────────────────────────────────
function makeEvent(initialSession: Session) {
  const cookies = new Map<string, string>()
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const ev = {
    cookies,
    method: 'GET',
    path: '/api/v1/admin/diagnostics',
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url: '/api/v1/admin/diagnostics',
        get headers() {
          const cookieHeader = Array.from(cookies.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; ')
          return { ...headers, cookie: cookieHeader, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(name: string) {
          return this._headers[name.toLowerCase()]
        },
        setHeader(name: string, value: string | string[]) {
          this._headers[name.toLowerCase()] = value
        },
        removeHeader(name: string) {
          this._headers[name.toLowerCase()] = ''
        },
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(ev as unknown as Parameters<typeof injectTestSession>[0], initialSession)
  return ev
}

function finopsSession(): Session {
  return {
    teammateId: '00000000-0000-0000-0000-000000000001',
    email: 'finops@wrh.test',
    displayName: 'Finops',
    role: 'global-finops',
    regionId,
    orgPath: 'wrh.svc',
  }
}

interface DiagResp {
  workers: {
    worker: string
    status: string
    consecutiveFailures: number
    rag: 'ok' | 'failing' | 'stale' | 'unknown'
    durationMs: number | null
    ageMinutes: number | null
    startedAgeMinutes: number | null
    finishedAt: string | null
    startedAt: string | null
  }[]
}

async function insertRun(
  workerName: string,
  status: string,
  startedAtIso: string,
  durationMs: number | null = 10,
) {
  await t.client`
    INSERT INTO worker_run (worker_name, status, started_at, finished_at, duration_ms)
    VALUES (
      ${workerName}, ${status}, ${startedAtIso}::timestamptz,
      ${status === 'running' ? null : startedAtIso}::timestamptz, ${durationMs}
    )
  `
}

describe('GET /api/v1/admin/diagnostics — workers block', () => {
  async function loadHandler() {
    vi.resetModules()
    return (await import('../../../server/api/v1/admin/diagnostics/index.get'))
      .default as (event: unknown) => Promise<DiagResp>
  }

  it('(d) reports a worker with trailing failures as failing, a healthy one as ok', async () => {
    // diag-healthy: one success → ok, consecutiveFailures 0.
    await insertRun('diag-healthy', 'success', '2026-06-05T10:00:00Z')
    // diag-failing: an old success, then THREE newer failures → failing, 3.
    await insertRun('diag-failing', 'success', '2026-06-05T08:00:00Z')
    await insertRun('diag-failing', 'failure', '2026-06-05T09:00:00Z')
    await insertRun('diag-failing', 'failure', '2026-06-05T10:00:00Z')
    await insertRun('diag-failing', 'failure', '2026-06-05T11:00:00Z')

    const handler = await loadHandler()
    const result = await handler(makeEvent(finopsSession()))

    const healthy = result.workers.find((w) => w.worker === 'diag-healthy')
    const failing = result.workers.find((w) => w.worker === 'diag-failing')

    expect(healthy).toBeDefined()
    expect(healthy!.rag).toBe('ok')
    expect(healthy!.status).toBe('success')
    expect(healthy!.consecutiveFailures).toBe(0)

    expect(failing).toBeDefined()
    expect(failing!.rag).toBe('failing')
    expect(failing!.status).toBe('failure')
    expect(failing!.consecutiveFailures).toBe(3)
  })

  it('(d2) failures after a recent success count only the trailing streak', async () => {
    // newest-first: failure, failure, SUCCESS, failure → trailing streak = 2.
    await insertRun('diag-streak', 'failure', '2026-06-05T07:00:00Z')
    await insertRun('diag-streak', 'success', '2026-06-05T08:00:00Z')
    await insertRun('diag-streak', 'failure', '2026-06-05T09:00:00Z')
    await insertRun('diag-streak', 'failure', '2026-06-05T10:00:00Z')

    const handler = await loadHandler()
    const result = await handler(makeEvent(finopsSession()))

    const streak = result.workers.find((w) => w.worker === 'diag-streak')
    expect(streak!.rag).toBe('failing')
    expect(streak!.consecutiveFailures).toBe(2)
  })

  it('(d3) MEDIUM-1: a running row over ≥1 failure is failing with the trailing failure count', async () => {
    // A worker killed mid-run: its run is stuck 'running' on top of a failure
    // pile. The streak terminator is SUCCESS-only, so the trailing failures
    // beneath the (non-success) running row are still counted. Old timestamps
    // ⇒ the running row is also stale ⇒ failing either way; consecutiveFailures
    // must reflect the 2 failures beneath it.
    await insertRun('diag-killed', 'failure', '2026-06-05T08:00:00Z')
    await insertRun('diag-killed', 'failure', '2026-06-05T09:00:00Z')
    await insertRun('diag-killed', 'running', '2026-06-05T10:00:00Z')

    const handler = await loadHandler()
    const result = await handler(makeEvent(finopsSession()))

    const killed = result.workers.find((w) => w.worker === 'diag-killed')
    expect(killed!.status).toBe('running')
    expect(killed!.rag).toBe('failing')
    expect(killed!.consecutiveFailures).toBe(2)
  })

  it('(d4) MEDIUM-1: a STALE running (old started_at, no failures beneath) is failing — wedged/killed', async () => {
    // A lone running row that never transitioned, started well over the
    // staleness threshold ago. No failures beneath ⇒ the staleness rule (not
    // the streak) is what flags it red.
    await insertRun('diag-wedged', 'running', '2020-01-01T00:00:00Z')

    const handler = await loadHandler()
    const result = await handler(makeEvent(finopsSession()))

    const wedged = result.workers.find((w) => w.worker === 'diag-wedged')
    expect(wedged!.status).toBe('running')
    expect(wedged!.consecutiveFailures).toBe(0)
    expect(wedged!.rag).toBe('failing')
  })

  it('(d5) MEDIUM-1: a FRESH running (just started, no failures beneath) is NOT failing — in-progress', async () => {
    // A run that started just now is genuinely in-flight, not wedged. Use a
    // real recent timestamp so it sits inside the staleness threshold.
    const justNow = new Date(Date.now() - 30_000).toISOString() // 30s ago
    await insertRun('diag-inflight', 'running', justNow, null)

    const handler = await loadHandler()
    const result = await handler(makeEvent(finopsSession()))

    const inflight = result.workers.find((w) => w.worker === 'diag-inflight')
    expect(inflight!.status).toBe('running')
    expect(inflight!.consecutiveFailures).toBe(0)
    expect(inflight!.rag).not.toBe('failing')
    expect(inflight!.rag).toBe('ok')
  })
})
