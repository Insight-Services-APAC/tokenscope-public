// @vitest-environment node
/*
 * dispatchWorker — the shared worker-run core used by BOTH trigger surfaces (the
 * HMAC cron endpoint and the admin "Run now" UI). Pins the behaviour the two paths
 * MUST share so they can never drift:
 *   (a) happy path: runs the worker, returns {worker,duration_ms,result}, records
 *       a 'success' worker_run with the extracted rows count;
 *   (b) threads runId + opts into the worker;
 *   (c) failure: re-throws the worker's own error (never swallowed) and records
 *       a 'failure' worker_run;
 *   (d) single-flight: when the per-worker lock is already held, throws 409 and
 *       does NOT run the worker (no duplicate run).
 *
 * Real testcontainers Postgres per AGENTS.md (never mock Drizzle). Each test uses a
 * unique worker name, so there is exactly one worker_run row per name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { workerRun } from '../../../drizzle/schema'
import { acquireWorkerDispatchLock } from '../../../server/workers/dispatch-lock'
import { dispatchWorker } from '../../../server/workers/dispatch'
import type { WorkerEntry, WorkerRunContext } from '../../../server/workers/registry'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function entry(name: string, run: WorkerEntry['run']): WorkerEntry {
  return { name, run, recommendedCron: '* * * * *', description: 'test worker' }
}

async function latestRun(name: string) {
  const [row] = await t.db.select().from(workerRun).where(eq(workerRun.workerName, name)).limit(1)
  return row
}

describe('dispatchWorker', () => {
  it('happy path: runs the worker, returns its result, records success + rows', async () => {
    const name = 'test-dispatch-ok'
    const out = await dispatchWorker(t.db, entry(name, async () => ({ rowsWritten: 4 })))
    expect(out.worker).toBe(name)
    expect(typeof out.duration_ms).toBe('number')
    expect((out.result as { rowsWritten: number }).rowsWritten).toBe(4)

    const row = await latestRun(name)
    expect(row?.status).toBe('success')
    expect(row?.rowsAffected).toBe(4)
  })

  it('threads runId + opts through to the worker', async () => {
    const name = 'test-dispatch-ctx'
    let seen: WorkerRunContext | undefined
    await dispatchWorker(
      t.db,
      entry(name, async (_db, ctx) => {
        seen = ctx
        return {}
      }),
      { deepRescan: true },
    )
    expect(seen?.opts).toEqual({ deepRescan: true })
    expect(typeof seen?.runId).toBe('string')
  })

  it('failure: re-throws the worker error (never swallowed) and records failure', async () => {
    const name = 'test-dispatch-fail'
    await expect(
      dispatchWorker(t.db, entry(name, async () => {
        throw new Error('boom-from-worker')
      })),
    ).rejects.toThrow('boom-from-worker')

    const row = await latestRun(name)
    expect(row?.status).toBe('failure')
    expect(row?.error).toContain('boom-from-worker')
  })

  it('lock already held: throws 409 and does NOT run the worker', async () => {
    const name = 'test-dispatch-locked'
    const held = await acquireWorkerDispatchLock(t.db, name)
    expect(held.acquired).toBe(true)

    let ran = false
    try {
      await expect(
        dispatchWorker(t.db, entry(name, async () => {
          ran = true
          return {}
        })),
      ).rejects.toMatchObject({ statusCode: 409 })
    } finally {
      await held.release()
    }
    expect(ran).toBe(false)
    // No run row was written for the blocked dispatch.
    expect(await latestRun(name)).toBeUndefined()
  })
})
