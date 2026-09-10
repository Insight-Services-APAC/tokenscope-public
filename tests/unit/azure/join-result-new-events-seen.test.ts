// @vitest-environment node
/*
 * JoinResult.newEventsSeen / usageRowsFetched — the DIAGNOSTIC producer counters
 * (folded from PR #316). They are NOT the stall gate any more (that is the
 * ingest-side sourceCoverage, server/azure/dcr-metrics.ts); they are the middle
 * term of the operator narrative "source received N · reader saw M new · wrote R".
 * This pins what the PRODUCER records, and that runReadJoiner ECHOES the caller's
 * sourceCoverage verdict without probing itself.
 *
 * Same fake-db seam as telemetry-only-spend.test.ts: untagged Copilot records
 * take the simplest write path. The second `execute` call is the watermark batch
 * query, so that is where the fixture's MAX(ts_event) is returned.
 */
import { describe, it, expect, vi } from 'vitest'
import type { TelemetryReader, UsageRecord, SessionSummary, ReaderHealth } from '../../../server/azure/reader'
import { countNewerThanWatermark, runReadJoiner } from '../../../server/workers/azure-monitor-reader'

const REGION_ID = '33333333-3333-4333-8333-333333333333'
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'
const WATERMARK_ISO = '2026-07-01T11:30:00.000Z'

function makeCopilotSessionRow() {
  return {
    instance_id: INSTANCE_ID,
    teammate_id: '22222222-2222-4222-8222-222222222222',
    region_id: REGION_ID,
    org_unit_id: '44444444-4444-4444-8444-444444444444',
    cost_owning_unit_id: '55555555-5555-4555-8555-555555555555',
    project_code_hash: null,
    tool: 'copilot-cli',
    identity_state: 'confirmed',
  }
}

function makeInsertChain(returnRows: unknown[]) {
  const chain = {
    values: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn(async () => returnRows),
  }
  return chain
}

function makeFakeDb(watermarkText: string | null) {
  const execute = vi.fn()
  execute.mockResolvedValueOnce([makeCopilotSessionRow()])
  execute.mockResolvedValueOnce(watermarkText === null ? [] : [{ instance_id: INSTANCE_ID, max_ts: watermarkText }])
  execute.mockResolvedValue([])
  const insert = vi.fn(() => makeInsertChain([{ id: 'attr-row-1' }]))
  const transaction = vi.fn(async (cb: (tx: { execute: typeof execute; insert: typeof insert }) => Promise<unknown>) =>
    cb({ execute, insert }),
  )
  return { execute, insert, transaction }
}

function copilotRecord(tsEvent: string): UsageRecord {
  return { tokens: 100, tokenType: 'input', model: 'gpt-4o', tsEvent, nanoAiu: 1_000_000_000 }
}

/** Returns a fixed set of records and remembers what watermark it was asked for. */
class FixedReader implements TelemetryReader {
  readonly calls: Array<Date | undefined> = []
  constructor(private readonly records: UsageRecord[]) {}
  async getSessionUsage(_id: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    this.calls.push(sinceTsEvent)
    return this.records
  }
  async listSessions(): Promise<SessionSummary[]> {
    return []
  }
  async healthCheck(): Promise<ReaderHealth> {
    return { ok: true, kind: 'local', latencyMs: 0 }
  }
}

// One below the watermark (inside the lookback the reader re-reads), one AT it,
// one past it. Only the last is new work.
const THREE = [
  copilotRecord('2026-07-01T11:27:00.000Z'),
  copilotRecord(WATERMARK_ISO),
  copilotRecord('2026-07-01T12:00:00.000Z'),
]

describe('countNewerThanWatermark', () => {
  const wm = new Date(WATERMARK_ISO)

  it('counts only records STRICTLY newer than the watermark', () => {
    expect(countNewerThanWatermark(THREE, wm)).toBe(1)
  })

  it('no watermark (never attributed) = every record is new', () => {
    expect(countNewerThanWatermark(THREE, undefined)).toBe(3)
    expect(countNewerThanWatermark([], undefined)).toBe(0)
  })

  it('an unparseable ts_event is never counted', () => {
    expect(countNewerThanWatermark([copilotRecord('not a date')], wm)).toBe(0)
  })

  it('compares at millisecond precision', () => {
    const ledger = new Date('2026-07-01 11:30:00.123456+00')
    expect(countNewerThanWatermark([copilotRecord('2026-07-01T11:30:00.123Z')], ledger)).toBe(0)
    expect(countNewerThanWatermark([copilotRecord('2026-07-01T11:30:00.124Z')], ledger)).toBe(1)
  })
})

describe('runReadJoiner — diagnostics counters and the sourceCoverage echo', () => {
  const NOW = new Date('2026-07-02T00:00:00Z')

  it('records fetched vs past-the-watermark separately: re-read history is NOT new work', async () => {
    const db = makeFakeDb('2026-07-01 11:30:00+00')
    const reader = new FixedReader(THREE)
    const result = await runReadJoiner(db as never, reader, { sessionIds: [INSTANCE_ID], now: NOW })
    expect(reader.calls).toEqual([new Date(WATERMARK_ISO)])
    expect(result.sessionsProcessed).toBe(1)
    expect(result.usageRowsFetched).toBe(3)
    expect(result.newEventsSeen).toBe(1)
  })

  it('an instance with no watermark yet counts every fetched record as new', async () => {
    const db = makeFakeDb(null)
    const reader = new FixedReader(THREE)
    const result = await runReadJoiner(db as never, reader, { sessionIds: [INSTANCE_ID], now: NOW })
    expect(reader.calls).toEqual([undefined])
    expect(result.newEventsSeen).toBe(3)
  })

  it('a DEEP-RESCAN tick withholds the watermark from the reader but still measures against it', async () => {
    const db = makeFakeDb('2026-07-01 11:30:00+00')
    const reader = new FixedReader(THREE)
    const result = await runReadJoiner(db as never, reader, { sessionIds: [INSTANCE_ID], now: NOW, deepRescan: true })
    expect(reader.calls).toEqual([undefined]) // full-window read
    expect(result.newEventsSeen).toBe(1) // measured against the watermark regardless
  })

  it('the idle laptop, as the producer records it: selected 1, fetched N, new 0', async () => {
    const db = makeFakeDb('2026-07-01 12:00:00+00')
    const reader = new FixedReader(THREE) // nothing newer than 12:00
    const result = await runReadJoiner(db as never, reader, { sessionIds: [INSTANCE_ID], now: NOW })
    expect(result.sessionsProcessed).toBe(1)
    expect(result.usageRowsFetched).toBe(3)
    expect(result.newEventsSeen).toBe(0)
  })

  it('an EMPTY read writes nothing and records 0 on both counters (#316 review: assert written 0)', async () => {
    const db = makeFakeDb('2026-07-01 11:30:00+00')
    const reader = new FixedReader([])
    const result = await runReadJoiner(db as never, reader, { sessionIds: [INSTANCE_ID], now: NOW })
    expect(result.usageRowsFetched).toBe(0)
    expect(result.newEventsSeen).toBe(0)
    expect(result.attributionRowsWritten).toBe(0)
  })

  it('runReadJoiner ECHOES the caller sourceCoverage verdict and NEVER probes itself', async () => {
    const db = makeFakeDb('2026-07-01 11:30:00+00')
    const reader = new FixedReader(THREE)
    const coverage = { status: 'rows-arrived' as const, rowsReceived: 708, rowsDropped: 0, transformationErrors: 0, windowMinutes: 15 }
    const result = await runReadJoiner(db as never, reader, { sessionIds: [INSTANCE_ID], now: NOW, sourceCoverage: coverage })
    expect(result.sourceCoverage).toEqual(coverage)
  })

  it('with no sourceCoverage passed, the field is null (recovery / tests never probe)', async () => {
    const db = makeFakeDb('2026-07-01 11:30:00+00')
    const reader = new FixedReader(THREE)
    const result = await runReadJoiner(db as never, reader, { sessionIds: [INSTANCE_ID], now: NOW })
    expect(result.sourceCoverage).toBeNull()
  })
})
