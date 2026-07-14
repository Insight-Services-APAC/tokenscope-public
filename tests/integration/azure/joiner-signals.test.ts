/*
 * Read joiner — behavioural usage-signal lane (mig 0065). A StubReader returns
 * SignalRecords from getSignalUsage; assert they land in usage_signal_record,
 * dedup on re-run, advance by watermark, and that a signal-path fault is isolated
 * from token attribution (billing-sacred).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadJoiner } from '../../../server/workers/azure-monitor-reader'
import { fetchSignalCells } from '../../../server/usage/insights'
import {
  WATERMARK_LOOKBACK_MS,
  type SignalRecord,
  type UsageRecord,
} from '../../../server/azure/reader'

let t: TestDb

const INSTANCE = '66666666-6666-6666-6666-666666666666'
const TEAMMATE = '33333333-3333-3333-3333-333333333333'

// Implements both reader methods: no token rows, signals from the map (filtered by
// the watermark exactly as a real reader would, so the joiner sees the incremental slice).
class SignalStubReader {
  public readonly calls: Array<{ sessionId: string; sinceTsEvent?: Date }> = []
  constructor(
    public readonly map: Map<string, SignalRecord[]>,
    private readonly opts: { throwOnSignals?: boolean } = {},
  ) {}
  async getSessionUsage(): Promise<UsageRecord[]> {
    return []
  }
  async getSignalUsage(sessionId: string, sinceTsEvent?: Date): Promise<SignalRecord[]> {
    this.calls.push({ sessionId, sinceTsEvent })
    if (this.opts.throwOnSignals) throw new Error('synthetic signal-read failure')
    const all = this.map.get(sessionId) ?? []
    if (!sinceTsEvent) return all
    const cutoff = sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS
    return all.filter((s) => new Date(s.tsEvent).getTime() > cutoff)
  }
}

const sig = (signalName: string, value: number, tsEvent: string, sourceRunId: string): SignalRecord => ({
  signalName,
  value,
  tsEvent,
  sourceRunId,
})

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'apac', 'APAC');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
              'apac.services'::ltree, 'apac-svcs', 'APAC Services', 'bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES ('${TEAMMATE}', 'oid', 'dev@i.com',
              '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
       raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
       region_id, org_unit_id, cost_owning_unit_id)
    VALUES
      ('${INSTANCE}', 'oid', 'dev@i.com', '${TEAMMATE}', 'h-x', 'X',
       'copilot-cli', 'hashS', '2026-05-24 09:00:00+00', '2026-05-24 09:30:00+00',
       '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
       '22222222-2222-2222-2222-222222222222');
  `)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function signalRows() {
  return t.db.execute<{ signal_name: string; value: string; tool: string; teammate_id: string }>(sql`
    SELECT signal_name, value::text AS value, tool, teammate_id::text AS teammate_id
    FROM usage_signal_record WHERE instance_id = ${INSTANCE}::uuid
    ORDER BY signal_name
  `)
}

describe('runReadJoiner — usage-signal landing', () => {
  it('lands one usage_signal_record row per (span, signal), teammate-grain', async () => {
    const reader = new SignalStubReader(
      new Map([
        [
          INSTANCE,
          [
            sig('tool_count', 38, '2026-05-24T09:10:00Z', 'span-chat'),
            sig('ctx_pct', 72, '2026-05-24T09:10:00Z', 'span-chat'),
            sig('mcp_count', 4, '2026-05-24T09:10:01Z', 'span-inv'),
            sig('turn_count', 9, '2026-05-24T09:10:01Z', 'span-inv'),
          ],
        ],
      ]),
    )
    const res = await runReadJoiner(t.db, reader as never, { sessionIds: [INSTANCE] })
    expect(res.signalRowsWritten).toBe(4)
    expect(res.signalErrors).toBe(0)
    expect(res.attributionRowsWritten).toBe(0) // signals carry no tokens

    const rows = [...(await signalRows())]
    expect(rows).toHaveLength(4)
    const byName = Object.fromEntries(rows.map((r) => [r.signal_name, r]))
    expect(Number(byName.tool_count!.value)).toBe(38)
    expect(Number(byName.turn_count!.value)).toBe(9)
    // teammate-grain: resolved from instance_attestation, tagged copilot-cli
    expect(byName.tool_count!.teammate_id).toBe(TEAMMATE)
    expect(byName.tool_count!.tool).toBe('copilot-cli')
  })

  it('is idempotent: re-landing the SAME signals writes zero new rows (dedup)', async () => {
    const reader = new SignalStubReader(
      new Map([
        [INSTANCE, [sig('tool_count', 38, '2026-05-24T09:10:00Z', 'span-chat')]],
      ]),
    )
    const res = await runReadJoiner(t.db, reader as never, { sessionIds: [INSTANCE] })
    expect(res.signalRowsWritten).toBe(0) // already present from the first test
    const rows = [...(await signalRows())]
    expect(rows).toHaveLength(4) // unchanged
  })

  it('advances by watermark: a NEW signal newer than the high-water-mark lands', async () => {
    const reader = new SignalStubReader(
      new Map([
        [
          INSTANCE,
          [
            // older — inside the lookback re-read window, dedups
            sig('tool_count', 38, '2026-05-24T09:10:00Z', 'span-chat'),
            // newer span — must land
            sig('tool_count', 12, '2026-05-24T11:00:00Z', 'span-chat-2'),
          ],
        ],
      ]),
    )
    const res = await runReadJoiner(t.db, reader as never, { sessionIds: [INSTANCE] })
    expect(res.signalRowsWritten).toBe(1)
    // The reader was handed a watermark (not a full-window read)
    expect(reader.calls.at(-1)?.sinceTsEvent).toBeInstanceOf(Date)
    const rows = [...(await signalRows())]
    expect(rows).toHaveLength(5)
  })

  it('isolates a signal-read fault: signalErrors++ but token attribution is untouched', async () => {
    const reader = new SignalStubReader(new Map(), { throwOnSignals: true })
    const res = await runReadJoiner(t.db, reader as never, { sessionIds: [INSTANCE] })
    expect(res.signalErrors).toBe(1)
    expect(res.errors).toBe(0) // token path's error counter is unaffected
    expect(res.sessionsProcessed).toBe(1)
  })

  it('fetchSignalCells aggregates landed rows (count/sum/min/max) for the read path', async () => {
    // Wide window so the fixture-dated rows are included (they predate now()-28d).
    const cells = await fetchSignalCells(t.db, TEAMMATE, 100_000)
    const tool = cells.find((c) => c.signal_name === 'tool_count')!
    // two tool_count rows landed across the tests above: 38 (span-chat) + 12 (span-chat-2)
    expect(tool.tool).toBe('copilot-cli')
    expect(tool.sample_count).toBe(2)
    expect(tool.sum_value).toBe(50)
    expect(tool.max_value).toBe(38)
    expect(tool.min_value).toBe(12)
    expect(cells.find((c) => c.signal_name === 'turn_count')!.max_value).toBe(9)
  })

  it('distinct spans with EMPTY span id but different ts_event both land (no false-merge — review #1)', async () => {
    // Two real observations, same signal, NO source_run_id (the wire shape does not
    // guarantee a span id). Before ts_event was added to the dedup key these would
    // collapse onto (instance, '', signal) and the second would be silently dropped.
    const reader = new SignalStubReader(
      new Map([
        [
          INSTANCE,
          [
            { signalName: 'mcp_count', value: 3, tsEvent: '2026-05-25T08:00:00Z' },
            { signalName: 'mcp_count', value: 9, tsEvent: '2026-05-25T09:00:00Z' },
          ],
        ],
      ]),
    )
    const res = await runReadJoiner(t.db, reader as never, { sessionIds: [INSTANCE] })
    expect(res.signalRowsWritten).toBe(2) // both land — ts_event discriminates
    // same payload again → dedups to zero (idempotent on the 4-tuple key)
    const again = await runReadJoiner(t.db, reader as never, { sessionIds: [INSTANCE] })
    expect(again.signalRowsWritten).toBe(0)
  })
})
