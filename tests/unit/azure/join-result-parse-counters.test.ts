// @vitest-environment node
/*
 * S10 — proves the ingest-boundary reject counter actually REACHES
 * runReadJoiner's returned JoinResult (== worker_run.result; registry.ts's
 * azure-monitor-read entry is a bare `return runReadJoiner(...)`, so nothing
 * downstream renames or drops a field on the way to the stored result).
 *
 * WHY THIS TEST EXISTS, SPECIFICALLY. A test that only asserts on the
 * PARSER's local counter object (as tests/unit/server/log-analytics-parser
 * .test.ts does) would keep passing even if the wiring from
 * TelemetryReader.getSessionUsage's `counters` param into JoinResult were
 * silently dropped somewhere in the joiner — the exact failure mode this
 * story exists to close ("skippedNoTimestamp was already counted locally and
 * only ever reached a console.warn"). So this test drives the REAL
 * runReadJoiner with a reader that mutates the caller-supplied ParseCounters
 * the way a real over-rejecting LogAnalyticsReader would, and asserts the
 * reject is visible on the function's own return value — no parser involved.
 *
 * The db is a minimal hand-built fake (no testcontainers — this is a unit
 * test): one session, whose reader.getSessionUsage returns ZERO usage
 * records (every record in the batch was rejected) but still reports the
 * reject count. That drives runReadJoiner through processSession's
 * `if (usage.length === 0) return` early exit, which means the ONLY
 * `db.execute` calls made are the sessions query, the watermark batch query,
 * loadLifecyclePolicyResolver's query, and sweepStaleDismissals' two
 * queries inside a transaction — none of which need real data for this
 * scenario, so a generic "first call returns the session row, every
 * subsequent call returns []" fake is sufficient and does not need to track
 * exact call order beyond that.
 */
import { describe, it, expect, vi } from 'vitest'
import type {
  TelemetryReader,
  UsageRecord,
  SessionSummary,
  ReaderHealth,
  ParseCounters,
} from '../../../server/azure/reader'
import { runReadJoiner } from '../../../server/workers/azure-monitor-reader'

function makeSessionRow(instanceId: string) {
  return {
    instance_id: instanceId,
    teammate_id: '22222222-2222-4222-8222-222222222222',
    region_id: '33333333-3333-4333-8333-333333333333',
    org_unit_id: '44444444-4444-4444-8444-444444444444',
    cost_owning_unit_id: '55555555-5555-4555-8555-555555555555',
    project_code_hash: null,
    tool: 'claude-code',
    identity_state: 'confirmed',
  }
}

/**
 * A minimal fake db: the FIRST `execute` call is the sessions query (returns
 * the supplied rows); every subsequent call — the watermark batch query,
 * loadLifecyclePolicyResolver's query, and sweepStaleDismissals' two queries
 * inside a transaction — returns []. Nothing in this test's scenario needs
 * those to carry real data (usage.length === 0 short-circuits processSession
 * before any per-group query runs), so this stays a generic, order-tolerant
 * stub rather than a query-text-sniffing one.
 */
function makeFakeDb(sessionRows: ReturnType<typeof makeSessionRow>[]) {
  const execute = vi.fn()
  execute.mockResolvedValueOnce(sessionRows)
  execute.mockResolvedValue([])
  const failIfInsertCalled = () => {
    throw new Error('unexpected insert — this scenario writes nothing')
  }
  const tx = { execute, insert: failIfInsertCalled }
  const transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx))
  return { execute, transaction, insert: failIfInsertCalled }
}

/** A reader whose every session's records were ALL rejected at the ingest
 *  boundary — records comes back empty, but the reject is still reported via
 *  the caller-supplied `counters` accumulator, exactly as LogAnalyticsReader
 *  does (reader.ts: `if (callerCounters) mergeParseCounters(callerCounters, counters)`
 *  runs unconditionally, before the empty-records return). */
class AllRejectedReader implements TelemetryReader {
  constructor(private readonly rejectsPerSession: number) {}
  async getSessionUsage(
    _sessionId: string,
    _sinceTsEvent?: Date,
    counters?: ParseCounters,
  ): Promise<UsageRecord[]> {
    if (counters) counters.rejectedClaudeSessionId += this.rejectsPerSession
    return []
  }
  async listSessions(): Promise<SessionSummary[]> {
    return []
  }
  async healthCheck(): Promise<ReaderHealth> {
    return { ok: true, kind: 'local', latencyMs: 0 }
  }
  // getSignalUsage deliberately OMITTED (optional on TelemetryReader) — this
  // reader carries no signal lane, matching LocalCollectorReader's shape.
}

describe('runReadJoiner — ParseCounters reaches JoinResult (S10)', () => {
  it('a session whose records were ALL rejected reports the reject on JoinResult.parseCounters, not just a local object the caller never sees', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111'
    const db = makeFakeDb([makeSessionRow(instanceId)])
    const reader = new AllRejectedReader(2)

    const result = await runReadJoiner(db as never, reader, {
      sessionIds: [instanceId],
      now: new Date('2026-07-01T00:00:00Z'),
    })

    // The failure this story exists to avoid: a counter that stays local to
    // the reader and never reaches the caller. JoinResult IS what
    // registry.ts returns as worker_run.result verbatim, so asserting here
    // covers both.
    expect(result.parseCounters.rejectedClaudeSessionId).toBe(2)
    expect(result.parseCounters.rejectedModel).toBe(0)
    expect(result.parseCounters.rejectedProjectCodeHash).toBe(0)
    expect(result.parseCounters.rejectedSourceRunId).toBe(0)
    expect(result.parseCounters.skippedNoTimestamp).toBe(0)
    // No records survived, so nothing was written or processed further —
    // the reject is visible EVEN THOUGH there is otherwise nothing to show
    // for this session ("cannot evaluate" must not read as "nothing to report").
    expect(result.sessionsProcessed).toBe(1)
    expect(result.attributionRowsWritten).toBe(0)
    expect(result.errors).toBe(0)
    // JoinResult always carries the field (never omitted on a quiet tick) —
    // matches this file's existing "never omit the object" convention for
    // costingRungs/telemetryOnlySpend.
    expect(result.telemetryOnlySpend).toEqual([])
  })

  it('accumulates rejects ADDITIVELY across multiple sessions in one tick', async () => {
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '99999999-9999-4999-8999-999999999999'
    const db = makeFakeDb([makeSessionRow(idA), makeSessionRow(idB)])
    const reader = new AllRejectedReader(3)

    const result = await runReadJoiner(db as never, reader, {
      sessionIds: [idA, idB],
      now: new Date('2026-07-01T00:00:00Z'),
    })

    expect(result.sessionsProcessed).toBe(2)
    // 3 rejects per session × 2 sessions — the SAME accumulator, not two
    // separate ones each caller has to remember to sum.
    expect(result.parseCounters.rejectedClaudeSessionId).toBe(6)
  })
})
