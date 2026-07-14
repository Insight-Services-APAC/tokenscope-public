// @vitest-environment node
/*
 * Worker dispatch lock (ING-3, robustness review 2026-06-09).
 *
 * Nothing previously stopped the same worker running twice concurrently
 * (scheduler overlap/retry, manual + cron, HMAC replay) — duplicating inbox
 * items and double-pricing Copilot spans. acquireWorkerDispatchLock holds a
 * session-level advisory lock on a reserved connection: concurrent dispatches
 * of the SAME worker get exactly one winner; different workers don't contend;
 * release makes the name dispatchable again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { acquireWorkerDispatchLock } from '../../../server/workers/dispatch-lock'
import { reapStaleWorkerRuns } from '../../../server/workers/run-health'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('acquireWorkerDispatchLock', () => {
  it('concurrent dispatches of the same worker → exactly one winner', async () => {
    const locks = await Promise.all([
      acquireWorkerDispatchLock(t.db, 'azure-monitor-read'),
      acquireWorkerDispatchLock(t.db, 'azure-monitor-read'),
      acquireWorkerDispatchLock(t.db, 'azure-monitor-read'),
    ])
    const winners = locks.filter((l) => l.acquired)
    expect(winners.length).toBe(1)
    for (const l of locks) await l.release()
  })

  it('different worker names do not contend', async () => {
    const a = await acquireWorkerDispatchLock(t.db, 'azure-monitor-read')
    const b = await acquireWorkerDispatchLock(t.db, 'session-gc')
    expect(a.acquired).toBe(true)
    expect(b.acquired).toBe(true)
    await a.release()
    await b.release()
  })

  it('release frees the name for the next dispatch (and is idempotent)', async () => {
    const first = await acquireWorkerDispatchLock(t.db, 'budget-alert')
    expect(first.acquired).toBe(true)

    const blocked = await acquireWorkerDispatchLock(t.db, 'budget-alert')
    expect(blocked.acquired).toBe(false)
    await blocked.release() // loser release is a no-op

    await first.release()
    await first.release() // idempotent

    const second = await acquireWorkerDispatchLock(t.db, 'budget-alert')
    expect(second.acquired).toBe(true)
    await second.release()
  })
})

describe('reapStaleWorkerRuns (ING-7)', () => {
  it('fails runs stuck in running past the bound; leaves fresh ones', async () => {
    await t.client`
      INSERT INTO worker_run (worker_name, status, started_at)
      VALUES ('azure-monitor-read', 'running', NOW() - INTERVAL '3 hours'),
             ('session-gc', 'running', NOW() - INTERVAL '1 minute'),
             ('budget-alert', 'success', NOW() - INTERVAL '3 hours')`
    const reaped = await reapStaleWorkerRuns(t.db)
    expect(reaped).toBe(1)

    const rows = await t.client<{ worker_name: string; status: string; error: string | null }[]>`
      SELECT worker_name, status, error FROM worker_run ORDER BY worker_name`
    const stale = rows.find((r) => r.worker_name === 'azure-monitor-read')!
    expect(stale.status).toBe('failure')
    expect(stale.error).toMatch(/reaped/)
    expect(rows.find((r) => r.worker_name === 'session-gc')!.status).toBe('running')
    expect(rows.find((r) => r.worker_name === 'budget-alert')!.status).toBe('success')
  })
})
