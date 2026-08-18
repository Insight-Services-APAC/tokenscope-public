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
const { runReadJoiner, shouldDeepRescan, selectJoinableInstances, recordJoinerSelectionCap } =
  vi.hoisted(() => ({
    runReadJoiner: vi.fn(async () => ({ deepRescan: false })),
    shouldDeepRescan: vi.fn(async () => false),
    selectJoinableInstances: vi.fn(async () => ({ ids: ['inst-1'], capHit: null as number | null })),
    recordJoinerSelectionCap: vi.fn(async () => ({ raised: 0, skippedExisting: 0, autoResolved: 0 })),
  }))

// The factory must export EVERY name registry.ts imports: vitest throws on an
// unlisted export at USE site, so a missing one hides whichever branch touches
// it (R2 caught exactly that on the zero-session path).
vi.mock('../../../server/workers/azure-monitor-reader', () => ({
  runReadJoiner,
  shouldDeepRescan,
  selectJoinableInstances,
  recordJoinerSelectionCap,
}))
// getTelemetryReader is a SPY, not a zero-arg stub: the registry passes it the
// operator's lookbackDays, and a stub that discards its argument makes that
// threading structurally untestable (R4 proved the whole recovery route could be
// deleted with the suite green). resolveLookbackDays is the real implementation —
// the result must report the window actually applied, not the one requested.
const { getTelemetryReader } = vi.hoisted(() => ({
  getTelemetryReader: vi.fn((_opts?: { lookbackDays?: number }) => ({ getSessionUsage: async () => [] })),
}))
vi.mock('../../../server/azure/reader', async () => {
  const actual = await vi.importActual<typeof import('../../../server/azure/reader')>('../../../server/azure/reader')
  // emptyParseCounters is the REAL one: the zero-session branch reports it, and a
  // hand-rolled stub here would let the branch's counters drift from the interface
  // silently — the very drift UF-22 is about.
  return {
    getTelemetryReader,
    resolveLookbackDays: actual.resolveLookbackDays,
    emptyParseCounters: actual.emptyParseCounters,
  }
})

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
    selectJoinableInstances.mockClear()
    selectJoinableInstances.mockResolvedValue({ ids: ['inst-1'], capHit: null })
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

describe('registry azure-monitor-read — selection cap-hit + recovery threading', () => {
  beforeEach(() => {
    getTelemetryReader.mockClear()
    runReadJoiner.mockClear()
    shouldDeepRescan.mockClear()
    selectJoinableInstances.mockClear()
    recordJoinerSelectionCap.mockClear()
    shouldDeepRescan.mockResolvedValue(false)
    selectJoinableInstances.mockResolvedValue({ ids: ['inst-1'], capHit: null })
  })

  it('reports the cap hit to the SIGNAL recorder, not only to worker_run.result', async () => {
    // worker_run.result had five writers and no reader; the alert is what makes
    // the cap observable before it silently truncates the fleet.
    selectJoinableInstances.mockResolvedValue({ ids: ['inst-1'], capHit: 500 })
    await azureMonitorRead().run(fakeDb, { runId: null })
    expect(recordJoinerSelectionCap).toHaveBeenCalledWith(fakeDb, 500)
  })

  it('reports null on an uncapped run, which is what CLEARS an open signal', async () => {
    await azureMonitorRead().run(fakeDb, { runId: null })
    expect(recordJoinerSelectionCap).toHaveBeenCalledWith(fakeDb, null)
  })

  it('an operator sessionIds override never touches the signal (it ran no selection)', async () => {
    // Its capHit is null by construction, so passing it on would auto-resolve a
    // live signal mid-outage — exactly what read-path-health excludes scoped runs for.
    await azureMonitorRead().run(fakeDb, {
      runId: null,
      opts: { sessionIds: ['11111111-1111-4111-8111-111111111111'] },
    })
    expect(recordJoinerSelectionCap).not.toHaveBeenCalled()
  })

  it('a failing signal recorder never fails the tick (observability is fenced)', async () => {
    recordJoinerSelectionCap.mockRejectedValueOnce(new Error('inbox is down'))
    await expect(azureMonitorRead().run(fakeDb, { runId: null })).resolves.toBeDefined()
    expect(runReadJoiner).toHaveBeenCalledTimes(1) // the join still ran
  })

  it('threads the selection cap hit into runReadJoiner (so it reaches worker_run.result)', async () => {
    selectJoinableInstances.mockResolvedValue({ ids: ['inst-1'], capHit: 500 })
    await azureMonitorRead().run(fakeDb, { runId: null })
    const opts = runReadJoiner.mock.calls[0]![2] as { selectionCapHit?: number | null }
    expect(opts.selectionCapHit).toBe(500)
  })

  it('passes null when the cap was not hit', async () => {
    await azureMonitorRead().run(fakeDb, { runId: null })
    const opts = runReadJoiner.mock.calls[0]![2] as { selectionCapHit?: number | null }
    expect(opts.selectionCapHit).toBeNull()
  })

  it('RECOVERY: threads the operator lookbackDays into the reader and reports what was applied', async () => {
    // R4: every line of this route was deletable with the full suite green.
    // These assertions are the deletion test made permanent.
    await azureMonitorRead().run(fakeDb, {
      runId: null,
      opts: { lookbackDays: 90, sessionIds: ['11111111-1111-4111-8111-111111111111'] },
    })
    // The reader is what applies the window (and reports it back in the result),
    // so the threading assertion belongs on the constructor call.
    expect(getTelemetryReader).toHaveBeenCalledWith({ lookbackDays: 90 })
    const opts = runReadJoiner.mock.calls[0]![2] as { scoped?: boolean; sessionIds?: string[] }
    expect(opts.scoped).toBe(true)
  })

  it('RECOVERY: an operator sessionIds override REPLACES the scheduled selection', async () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    await azureMonitorRead().run(fakeDb, { runId: null, opts: { sessionIds: ids, lookbackDays: 30 } })
    expect(selectJoinableInstances).not.toHaveBeenCalled() // the whole point of scoping
    const opts = runReadJoiner.mock.calls[0]![2] as { sessionIds?: string[]; selectionCapHit?: number | null }
    expect(opts.sessionIds).toEqual(ids)
    expect(opts.selectionCapHit).toBeNull() // no selection ran, so no cap to report
  })

  it('a normal tick builds an UNWIDENED reader and is not marked scoped', async () => {
    // A malformed signed body is dropped fail-soft, so a run meant as a 90-day
    // recovery can execute as a 7-day tick and still return 200 with rows. The
    // applied window is the field that tells them apart after the fact.
    await azureMonitorRead().run(fakeDb, { runId: null })
    // No override → the reader is built with no lookback, so it applies its own
    // 7-day default and reports that in the result (asserted in joiner.test.ts).
    expect(getTelemetryReader).toHaveBeenCalledWith({ lookbackDays: undefined })
    const opts = runReadJoiner.mock.calls[0]![2] as { scoped?: boolean }
    expect(opts.scoped).toBe(false)
  })

  it('ZERO-SESSION branch: returns a well-formed result with no cap hit and never joins', async () => {
    // This branch was previously unreachable in test — the mock omitted an
    // export registry.ts imports, so vitest threw before the assertions ran.
    selectJoinableInstances.mockResolvedValue({ ids: [], capHit: null })
    const res = (await azureMonitorRead().run(fakeDb, { runId: null })) as Record<string, unknown>
    expect(runReadJoiner).not.toHaveBeenCalled()
    expect(res.sessionsProcessed).toBe(0)
    expect(res.selectionCapHit).toBeNull()
    expect(res.deepRescan).toBe(false) // a zero-session tick must not claim the daily deep pass
    // No reader was constructed and no query ran, so there is no applied window
    // to report — reporting one would be a fabricated recovery record.
    expect(res.lookbackDaysApplied).toBeNull()
    expect(res.scoped).toBe(false)
  })

  it('ZERO-SESSION branch: reports EVERY JoinResult field, never omits one (UF-22)', async () => {
    /*
     * The branch's own convention is "never omit the object" — a consumer of
     * worker_run.result must not have to special-case the empty tick. Three
     * fields had drifted out of it (parseCounters, telemetryOnlySpend,
     * staleDismissalsReturned) because WorkerEntry.run returns Promise<unknown>,
     * so no gate could see the omission. `satisfies JoinResult` in the registry
     * is the permanent fix; this asserts the observable half of it.
     */
    selectJoinableInstances.mockResolvedValue({ ids: [], capHit: null })
    const res = (await azureMonitorRead().run(fakeDb, { runId: null })) as Record<string, unknown>
    // Zero, not absent: `undefined` reads as "unknown" to a consumer, and a tick
    // that read nothing KNOWS the answer is nothing.
    expect(res.staleDismissalsReturned).toBe(0)
    expect(res.telemetryOnlySpend).toEqual([])
    // The whole counter object, all-zero — a consumer reading
    // result.parseCounters.rejectedModel must not have to guard for undefined.
    expect(res.parseCounters).toEqual({
      skippedNoTimestamp: 0,
      rejectedClaudeSessionId: 0,
      rejectedModel: 0,
      rejectedProjectCodeHash: 0,
      rejectedSourceRunId: 0,
      rejectedEmittingEmail: 0,
      rejectedOrganizationId: 0,
    })
  })
})
