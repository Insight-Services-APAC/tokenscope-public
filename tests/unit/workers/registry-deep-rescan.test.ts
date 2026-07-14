/*
 * registry azure-monitor-read — operator-forceable deep-rescan threading.
 *
 * The gatherer already supports a deepRescan mode (ignore the per-instance
 * watermark, re-read the full window). Today it is ONLY auto-decided via
 * shouldDeepRescan. This test pins the NEW behaviour: the registry entry uses
 * ctx.opts.deepRescan when the operator forces it (through the signed run-worker
 * body), and falls back to shouldDeepRescan when no opt is passed.
 *
 * We assert on the exact `deepRescan` value the entry threads into runReadJoiner
 * — the single point where the two sources of truth converge. The gatherer
 * internals (selectRecentJoinableSessionIds / shouldDeepRescan / runReadJoiner)
 * and getTelemetryReader are stubbed so this is a pure unit test of the registry
 * glue (no DB, no Azure).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted above imports, so the mock fns must be created inside
// vi.hoisted() (which is hoisted with it) — a plain top-level const would be in
// the temporal dead zone when the factory runs.
const { runReadJoiner, shouldDeepRescan, selectRecentJoinableSessionIds } = vi.hoisted(() => ({
  runReadJoiner: vi.fn(async () => ({ deepRescan: false })),
  shouldDeepRescan: vi.fn(async () => false),
  selectRecentJoinableSessionIds: vi.fn(async () => ['inst-1']),
}))

vi.mock('../../../server/workers/azure-monitor-reader', () => ({
  runReadJoiner,
  shouldDeepRescan,
  selectRecentJoinableSessionIds,
}))
vi.mock('../../../server/azure/reader', () => ({
  getTelemetryReader: () => ({ getSessionUsage: async () => [] }),
}))

// vi.mock is hoisted above this import, so it must follow — the import/first rule
// is disabled for exactly that vitest idiom.
/* eslint-disable import/first */
import { getWorker } from '../../../server/workers/registry'
/* eslint-enable import/first */

// A stand-in db — never touched (all DB-facing calls are mocked out).
const fakeDb = {} as never

function azureMonitorRead() {
  const entry = getWorker('azure-monitor-read')
  if (!entry) throw new Error('azure-monitor-read not registered')
  return entry
}

/** The deepRescan value threaded into the (mocked) runReadJoiner. */
function threadedDeepRescan(): boolean {
  expect(runReadJoiner).toHaveBeenCalledTimes(1)
  const opts = runReadJoiner.mock.calls[0]![2] as { deepRescan?: boolean }
  return opts.deepRescan!
}

describe('registry azure-monitor-read — deepRescan threading', () => {
  beforeEach(() => {
    runReadJoiner.mockClear()
    shouldDeepRescan.mockClear()
    selectRecentJoinableSessionIds.mockClear()
    shouldDeepRescan.mockResolvedValue(false)
  })

  it('forces deepRescan=true from ctx.opts.deepRescan, WITHOUT consulting shouldDeepRescan', async () => {
    await azureMonitorRead().run(fakeDb, { runId: null, opts: { deepRescan: true } })
    expect(threadedDeepRescan()).toBe(true)
    // The operator override short-circuits the auto decision (?? never evaluates it).
    expect(shouldDeepRescan).not.toHaveBeenCalled()
  })

  it('honours an explicit ctx.opts.deepRescan=false override (still bypasses shouldDeepRescan)', async () => {
    // shouldDeepRescan WOULD say true, but the explicit false wins.
    shouldDeepRescan.mockResolvedValue(true)
    await azureMonitorRead().run(fakeDb, { runId: null, opts: { deepRescan: false } })
    expect(threadedDeepRescan()).toBe(false)
    expect(shouldDeepRescan).not.toHaveBeenCalled()
  })

  it('falls back to shouldDeepRescan when no opts are passed (auto path, true)', async () => {
    shouldDeepRescan.mockResolvedValue(true)
    await azureMonitorRead().run(fakeDb, { runId: null })
    expect(shouldDeepRescan).toHaveBeenCalledTimes(1)
    expect(threadedDeepRescan()).toBe(true)
  })

  it('falls back to shouldDeepRescan when ctx.opts is absent (auto path, false)', async () => {
    shouldDeepRescan.mockResolvedValue(false)
    await azureMonitorRead().run(fakeDb, { runId: null, opts: undefined })
    expect(shouldDeepRescan).toHaveBeenCalledTimes(1)
    expect(threadedDeepRescan()).toBe(false)
  })

  it('falls back to shouldDeepRescan when ctx itself is absent', async () => {
    shouldDeepRescan.mockResolvedValue(true)
    await azureMonitorRead().run(fakeDb)
    expect(shouldDeepRescan).toHaveBeenCalledTimes(1)
    expect(threadedDeepRescan()).toBe(true)
  })
})
