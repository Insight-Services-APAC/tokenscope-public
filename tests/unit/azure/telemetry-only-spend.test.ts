// @vitest-environment node
/*
 * S10 (C) — the measurement half of the audit's "count telemetry-only spend
 * as a first-class unreconcilable-spend metric per (region, day)" fix. This
 * proves runReadJoiner actually ACCUMULATES per-(region,day) telemetry-only
 * totals from newly-written rows and surfaces them on JoinResult
 * .telemetryOnlySpend — not just that the field exists (join-result-parse-
 * counters.test.ts already proves the empty case), but that real spend
 * flows into it correctly.
 *
 * Copilot is the simplest real write path to drive without testcontainers:
 * EVERY Copilot record is costBasis='telemetry-only' by construction (no
 * billing-API reconciliation in v1 — server/workers/azure-monitor-reader.ts:
 * `costBasis = isCopilot ? 'telemetry-only' : 'estimated'`), and an UNTAGGED
 * record (no project.code_hash, no claudeSessionId) skips the project/
 * membership resolution branch entirely, and a single-row Copilot unit takes
 * the non-transactional fast path (`pending.length === 1 && !needsReconcile`)
 * — so this is exercisable with a minimal hand-built fake db (chainable
 * insert stub), no testcontainers.
 */
import { describe, it, expect, vi } from 'vitest'
import type { TelemetryReader, UsageRecord, SessionSummary, ReaderHealth } from '../../../server/azure/reader'
import { runReadJoiner } from '../../../server/workers/azure-monitor-reader'

const REGION_ID = '33333333-3333-4333-8333-333333333333'
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'

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

/** A chainable `db.insert(table).values(v).onConflictDoNothing().returning(r)`
 *  stub — every insert this scenario makes "succeeds" (a fresh row, not a
 *  dedup conflict), returning one id. */
function makeInsertChain(returnRows: unknown[]) {
  const chain = {
    values: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn(async () => returnRows),
  }
  return chain
}

function makeFakeDb() {
  const execute = vi.fn()
  execute.mockResolvedValueOnce([makeCopilotSessionRow()]) // 1st call: sessions query
  // Every subsequent call — watermark batch, loadLifecyclePolicyResolver,
  // the Copilot "already priced?" probe, sweepStaleDismissals' two queries —
  // returns []. None of those need real data for this scenario: no
  // watermark means a full-window read (fine, the reader ignores it), no
  // lifecycle policy means the default (irrelevant — this record is
  // UNTAGGED, so lifecycle/spill logic never runs), and an empty
  // "already priced" probe correctly means "not yet priced".
  execute.mockResolvedValue([])
  const insert = vi.fn(() => makeInsertChain([{ id: 'attr-row-1' }]))
  const transaction = vi.fn(async (cb: (tx: { execute: typeof execute; insert: typeof insert }) => Promise<unknown>) =>
    cb({ execute, insert }),
  )
  return { execute, insert, transaction }
}

class UntaggedCopilotReader implements TelemetryReader {
  async getSessionUsage(): Promise<UsageRecord[]> {
    return [
      {
        tokens: 100,
        tokenType: 'input',
        model: 'gpt-4o',
        tsEvent: '2026-07-01T12:00:00.000Z',
        // 1e9 nano_aiu = 1 AI credit = $0.01 (COPILOT_AI_CREDIT_USD) — a
        // round number so the expected totalUsd is easy to eyeball.
        nanoAiu: 1_000_000_000,
      },
    ]
  }
  async listSessions(): Promise<SessionSummary[]> {
    return []
  }
  async healthCheck(): Promise<ReaderHealth> {
    return { ok: true, kind: 'local', latencyMs: 0 }
  }
}

describe('runReadJoiner — telemetry-only spend reaches JoinResult.telemetryOnlySpend (S10 C)', () => {
  it('a newly-written Copilot row (always telemetry-only) is bucketed under its (region, day)', async () => {
    const db = makeFakeDb()
    const reader = new UntaggedCopilotReader()

    const result = await runReadJoiner(db as never, reader, {
      sessionIds: [INSTANCE_ID],
      now: new Date('2026-07-02T00:00:00Z'),
    })

    expect(result.attributionRowsWritten).toBe(1)
    expect(result.telemetryOnlySpend).toEqual([{ regionId: REGION_ID, day: '2026-07-01', totalUsd: '0.010000' }])
  })
})
