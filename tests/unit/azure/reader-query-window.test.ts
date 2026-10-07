// @vitest-environment node
/*
 * LogAnalyticsReader — the OUTER query window actually sent to Azure.
 *
 * This is the guard against silently regressing the defect this whole branch
 * exists to fix. Before it, the window was `opts.lookbackDays === 1 ? 1 : 7`,
 * which clamped every wider request to 7 days — so a recovery read that asked
 * for 90 quietly scanned 7, found a fraction of the backlog, and reported
 * success. R6 proved the suite could not see that: reverting all three
 * `duration:` call sites to `Durations.sevenDays` left 2961 tests green.
 *
 * Worse, `appliedLookbackDays` (which the joiner echoes into worker_run.result
 * as the operator's evidence) is computed from the SAME opts, so a clamp
 * regression would report 90 while querying 7 — the evidence field certifying
 * the failure it exists to expose. These tests tie the reported window to the
 * emitted one so the two cannot drift.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// One EMPTY-but-present table: getSessionUsage returns early at `if (!table)`,
// so a `tables: []` mock never reaches the second (native-GenAI) query and the
// third duration call site would look untested when it merely was not run.
const queryWorkspace = vi.fn(async () => ({
  status: 'Success',
  tables: [{ columnDescriptors: [], rows: [] }],
}))

vi.mock('@azure/monitor-query', () => ({
  LogsQueryClient: class {
    queryWorkspace = queryWorkspace
  },
  LogsQueryResultStatus: { Success: 'Success' },
  Durations: { oneDay: 'P1D', sevenDays: 'P7D' },
}))
vi.mock('@azure/identity', () => ({
  // vi.fn() rather than `class {}` — newable either way, but an empty class
  // trips @typescript-eslint/no-extraneous-class and reddens the required lint job.
  DefaultAzureCredential: vi.fn(),
}))

/* eslint-disable import/first */
import {
  LogAnalyticsReader,
  isoDuration,
  buildSessionUsageKql,
  buildSessionUsageKqlGenAI,
  buildSignalUsageKql,
  eventWindowClause,
  WINDOWED_QUERY_TIMEOUT_S,
  JOINER_QUERY_TIMEOUT_S,
  JOINER_QUERY_ABORT_MS,
} from '../../../server/azure/reader'
/* eslint-enable import/first */

const SID = '11111111-1111-4111-8111-111111111111'
const DURATIONS = { oneDay: 'P1D', sevenDays: 'P7D' }

/** Every `duration` string this reader sent to Azure. */
function sentDurations(): string[] {
  return queryWorkspace.mock.calls.map((c) => (c as unknown as [string, string, { duration: string }])[2].duration)
}

beforeEach(() => {
  queryWorkspace.mockClear()
})

describe('LogAnalyticsReader — emitted query window', () => {
  it('defaults to a 7-day outer bound', async () => {
    const reader = new LogAnalyticsReader('ws', {})
    await reader.getSessionUsage(SID)
    expect(sentDurations()).toContain('P7D')
  })

  it('HONOURS a widened recovery window — the clamp that made a backlog look unrecoverable', async () => {
    const reader = new LogAnalyticsReader('ws', { lookbackDays: 90 })
    await reader.getSessionUsage(SID)
    // The old `=== 1 ? 1 : 7` would send P7D here.
    expect(sentDurations().every((d) => d === 'P90D')).toBe(true)
  })

  it('applies the window to the SIGNAL query too (both read paths, one bound)', async () => {
    const reader = new LogAnalyticsReader('ws', { lookbackDays: 30 })
    await reader.getSignalUsage(SID)
    expect(sentDurations()).toContain('P30D')
  })

  it('keeps the 1-day fast path', async () => {
    const reader = new LogAnalyticsReader('ws', { lookbackDays: 1 })
    await reader.getSessionUsage(SID)
    expect(sentDurations()).toContain('P1D')
  })

  it('applies the window to the native-GenAI query too (the third call site)', async () => {
    // The Copilot GenAI read is a SECOND query issued inside getSessionUsage,
    // behind a flag no other test enables — so its duration was the one call
    // site of three that could be re-clamped with the suite green. A widened
    // recovery would then read 90 days of Claude rows and 7 of Copilot rows
    // while the result reported 90: the evidence field certifying a partial
    // recovery as complete, which is precisely what this file exists to stop.
    const saved = process.env.NUXT_COPILOT_NATIVE_OTEL
    process.env.NUXT_COPILOT_NATIVE_OTEL = 'true'
    try {
      const reader = new LogAnalyticsReader('ws', { lookbackDays: 90 })
      await reader.getSessionUsage(SID)
      const sent = sentDurations()
      expect(sent.length).toBe(2) // the Claude query AND the GenAI query
      expect(sent.every((d) => d === 'P90D')).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.NUXT_COPILOT_NATIVE_OTEL
      else process.env.NUXT_COPILOT_NATIVE_OTEL = saved
    }
  })

  it('THE EVIDENCE INVARIANT: what it reports applied is what it actually sent', async () => {
    // worker_run.result->>'lookbackDaysApplied' comes from appliedLookbackDays.
    // If that can differ from the emitted duration, the operator's only check on
    // a silently-downgraded recovery lies to them.
    for (const lookbackDays of [undefined, 1, 7, 30, 90, 1000, 0]) {
      queryWorkspace.mockClear()
      const reader = new LogAnalyticsReader('ws', { lookbackDays })
      await reader.getSessionUsage(SID)
      const expected = isoDuration(reader.appliedLookbackDays, DURATIONS)
      expect(sentDurations().every((d) => d === expected)).toBe(true)
    }
  })
})

describe('LogAnalyticsReader — an instance-day window', () => {
  const from = new Date('2026-09-26T08:26:00.000Z')
  const to = new Date('2026-09-27T08:26:00.000Z')

  it('sends the window itself as the timespan on every call site, not a lookback from now', async () => {
    // A recovery request fixes its windows when it is queued; a lookback measured
    // from the tick's clock would clip the first day's early hours once the
    // request resumes later.
    const saved = process.env.NUXT_COPILOT_NATIVE_OTEL
    process.env.NUXT_COPILOT_NATIVE_OTEL = 'true'
    try {
      const reader = new LogAnalyticsReader('ws', { lookbackDays: 7 })
      await reader.getSessionUsage(SID, undefined, undefined, { from, to })
      await reader.getSignalUsage(SID, undefined, undefined, { from, to })
      const spans = queryWorkspace.mock.calls.map((c) => (c as unknown as [string, string, unknown])[2])
      expect(spans).toHaveLength(3) // Claude, native GenAI, signals
      for (const span of spans) expect(span).toEqual({ startTime: from, endTime: to })
      // Each windowed query carries a server timeout below the 200 s dispatch budget.
      const options = queryWorkspace.mock.calls.map((c) => (c as unknown as [string, string, unknown, unknown])[3])
      for (const o of options) {
        expect(o).toEqual({ serverTimeoutInSeconds: WINDOWED_QUERY_TIMEOUT_S, abortSignal: expect.any(AbortSignal) })
      }
      const kql = queryWorkspace.mock.calls.map((c) => (c as unknown as [string, string])[1])
      for (const q of kql) expect(q).toContain(eventWindowClause({ from, to }))
    } finally {
      if (saved === undefined) delete process.env.NUXT_COPILOT_NATIVE_OTEL
      else process.env.NUXT_COPILOT_NATIVE_OTEL = saved
    }
  })

  it('bounds every KQL lane with >= from and < to', () => {
    const closed = eventWindowClause({ from, to })
    expect(closed).toBe(
      '| where TimeGenerated >= datetime(2026-09-26T08:26:00.000Z) and TimeGenerated < datetime(2026-09-27T08:26:00.000Z)',
    )
    expect(eventWindowClause(undefined)).toBe('')
    for (const kql of [
      buildSessionUsageKql(SID, undefined, { from, to }),
      buildSessionUsageKqlGenAI(SID, undefined, { from, to }),
      buildSignalUsageKql(SID, undefined, { from, to }),
    ]) {
      expect(kql).toContain(closed)
    }
  })
})

describe('LogAnalyticsReader — every joiner query is bounded', () => {
  // The scheduled tick's deadline only holds if no single query can outlive it:
  // the service default is 3 minutes, past the 200 s dispatch budget on its own.
  it('sends a 40 s server timeout and a fresh 45 s client abort on the usage, GenAI and signal queries', async () => {
    const saved = process.env.NUXT_COPILOT_NATIVE_OTEL
    process.env.NUXT_COPILOT_NATIVE_OTEL = 'true'
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const reader = new LogAnalyticsReader('ws', {})
      await reader.getSessionUsage(SID, new Date('2026-10-01T00:00:00Z'))
      await reader.getSignalUsage(SID, new Date('2026-10-01T00:00:00Z'))
      const options = queryWorkspace.mock.calls.map(
        (c) => (c as unknown as [string, string, unknown, { serverTimeoutInSeconds: number; abortSignal: AbortSignal }])[3],
      )
      expect(options).toHaveLength(3) // Claude usage, native GenAI, signals
      for (const o of options) {
        expect(o.serverTimeoutInSeconds).toBe(JOINER_QUERY_TIMEOUT_S)
        expect(o.abortSignal).toBeInstanceOf(AbortSignal)
      }
      expect(JOINER_QUERY_TIMEOUT_S).toBe(40)
      expect(JOINER_QUERY_ABORT_MS).toBe(45_000)
      // One signal per query: AbortSignal.timeout starts its clock when created,
      // so a shared one would expire on the device's later queries.
      expect(new Set(options.map((o) => o.abortSignal)).size).toBe(3)
      expect(timeout.mock.calls).toEqual([[JOINER_QUERY_ABORT_MS], [JOINER_QUERY_ABORT_MS], [JOINER_QUERY_ABORT_MS]])
    } finally {
      timeout.mockRestore()
      if (saved === undefined) delete process.env.NUXT_COPILOT_NATIVE_OTEL
      else process.env.NUXT_COPILOT_NATIVE_OTEL = saved
    }
  })

  it('a query the client aborts is a thrown read, which the joiner counts as that device\'s error', async () => {
    queryWorkspace.mockImplementationOnce(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    const reader = new LogAnalyticsReader('ws', {})
    await expect(reader.getSessionUsage(SID, new Date('2026-10-01T00:00:00Z'))).rejects.toThrow(/timeout/)
  })
})

describe('getTelemetryReader — the wire from the signed option to the reader', () => {
  it('forwards lookbackDays to the LogAnalyticsReader it builds', async () => {
    // This one property is the ENTIRE path from a signed {"lookbackDays": 90}
    // recovery body to the query window. Dropping it makes every recovery run
    // silently reach back 7 days and report success — and the existing tests
    // construct LogAnalyticsReader directly, so they never touch the factory
    // production actually calls.
    const saved = { ...process.env }
    process.env.NUXT_TELEMETRY_READER = 'log-analytics'
    process.env.NUXT_LOG_ANALYTICS_WORKSPACE_ID = 'ws-test'
    try {
      const { getTelemetryReader } = await import('../../../server/azure/reader')
      expect(getTelemetryReader({ lookbackDays: 90 }).appliedLookbackDays).toBe(90)
      expect(getTelemetryReader().appliedLookbackDays).toBe(7) // default unchanged
    } finally {
      process.env = saved
    }
  })
})
