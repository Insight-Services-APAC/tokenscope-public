// @vitest-environment node
/*
 * Read-joiner robustness regressions (robustness review 2026-06-09):
 *   - ING-1: a late-arriving event (event-time older than watermark − 5 min)
 *     is dropped by a normal tick but recovered by the deep-rescan tick;
 *     shouldDeepRescan decides from worker_run.result.
 *   - ING-6: one throwing session does not abort the tick — the remaining
 *     sessions still attribute, and JoinResult.errors counts the bad one.
 *   - ING-8: the unauthorized-spill counter/audit fires only for NEWLY-written
 *     rows — an overlap re-read that dedups to zero re-emits nothing.
 *   - ING-5: Copilot span cost carrier is deterministic, and a re-run over a
 *     half-written span never adds a second full-cost row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  runReadJoiner,
  shouldDeepRescan,
} from '../../../server/workers/azure-monitor-reader'
import { WATERMARK_LOOKBACK_MS, type TelemetryReader, type UsageRecord } from '../../../server/azure/reader'

let t: TestDb

const TEAM = '33333333-3333-3333-3333-333333333333'

class StubReader {
  public readonly calls: Array<{ sessionId: string; sinceTsEvent?: Date }> = []
  constructor(public readonly map: Map<string, UsageRecord[]>) {}
  async getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    this.calls.push({ sessionId, sinceTsEvent })
    const all = this.map.get(sessionId) ?? []
    if (!sinceTsEvent) return all
    const cutoff = sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS
    return all.filter((u) => new Date(u.tsEvent).getTime() > cutoff)
  }
}

/** A reader that throws for the given instance ids and serves the rest. */
class FaultyReader extends StubReader {
  constructor(map: Map<string, UsageRecord[]>, private readonly failFor: Set<string>) {
    super(map)
  }
  override async getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    if (this.failFor.has(sessionId)) throw new Error(`reader HTTP 502 for ${sessionId}`)
    return super.getSessionUsage(sessionId, sinceTsEvent)
  }
}

function asReader(r: StubReader): TelemetryReader {
  return r as unknown as TelemetryReader
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'apac', 'APAC');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
              'apac.services'::ltree, 'apac-svcs', 'APAC Services', 'bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES ('${TEAM}', 'oid', 'dev@i.com',
              '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
    INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES ('44444444-4444-4444-4444-444444444444', 'AFL-AII', 'h-afl-aii', 'AFL · AI Insights',
              'billable', '11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222'),
             ('55555555-5555-5555-5555-555555555555', 'INT-PLT', 'h-int-plt', 'Internal Platform',
              'internal', '11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222');
    INSERT INTO project_assignment (project_id, teammate_id, effective)
      VALUES ('44444444-4444-4444-4444-444444444444', '${TEAM}', '[2026-01-01, 2099-01-01)'::tstzrange);
  `)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function insertInstance(id: string, tool = 'claude-code'): Promise<void> {
  await t.client.unsafe(`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
       raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
       region_id, org_unit_id, cost_owning_unit_id)
    VALUES
      ('${id}', 'oid', 'dev@i.com', '${TEAM}', 'h-afl-aii', 'AFL-AII',
       '${tool}', 'hash-${id}', '2026-05-24 09:00:00+00', '2026-05-24 09:30:00+00',
       '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
       '22222222-2222-2222-2222-222222222222');
  `)
}

const rec = (over: Partial<UsageRecord> & { tokens: number; tsEvent: string }): UsageRecord => ({
  tokenType: 'input',
  model: 'claude-sonnet-4-7',
  projectCodeHash: 'h-afl-aii',
  ...over,
})

describe('ING-1 — deep rescan recovers late-arriving telemetry', () => {
  const INST = 'a1a1a1a1-0000-0000-0000-000000000001'

  it('a normal tick drops an event older than watermark − lookback; the deep-rescan tick attributes it exactly once', async () => {
    await insertInstance(INST)
    // Tick 1: two events establish the watermark at 09:10.
    const reader1 = new StubReader(
      new Map([[INST, [
        rec({ tokens: 100, tsEvent: '2026-05-24T09:05:00Z' }),
        rec({ tokens: 200, tsEvent: '2026-05-24T09:10:00Z', tokenType: 'output' }),
      ]]]),
    )
    const r1 = await runReadJoiner(t.db, asReader(reader1), { sessionIds: [INST] })
    expect(r1.attributionRowsWritten).toBe(2)
    expect(r1.deepRescan).toBe(false)
    expect(r1.errors).toBe(0)

    // A LATE event lands in the store with event-time 09:00 — older than
    // watermark (09:10) − 5 min lookback (09:05). A normal tick never sees it.
    const all = [
      rec({ tokens: 100, tsEvent: '2026-05-24T09:05:00Z' }),
      rec({ tokens: 200, tsEvent: '2026-05-24T09:10:00Z', tokenType: 'output' }),
      rec({ tokens: 999, tsEvent: '2026-05-24T09:00:00Z', tokenType: 'cache-read' }),
    ]
    const reader2 = new StubReader(new Map([[INST, all]]))
    const r2 = await runReadJoiner(t.db, asReader(reader2), { sessionIds: [INST] })
    expect(reader2.calls[0]!.sinceTsEvent).toBeInstanceOf(Date) // watermark applied
    expect(r2.attributionRowsWritten).toBe(0) // the late event was dropped — the ING-1 bug

    // Deep rescan: watermark ignored → full-window read → the late event lands.
    const reader3 = new StubReader(new Map([[INST, all]]))
    const r3 = await runReadJoiner(t.db, asReader(reader3), { sessionIds: [INST], deepRescan: true })
    expect(reader3.calls[0]!.sinceTsEvent).toBeUndefined()
    expect(r3.attributionRowsWritten).toBe(1)
    expect(r3.deepRescan).toBe(true)

    // Idempotent: a second deep rescan changes nothing.
    const reader4 = new StubReader(new Map([[INST, all]]))
    const r4 = await runReadJoiner(t.db, asReader(reader4), { sessionIds: [INST], deepRescan: true })
    expect(r4.attributionRowsWritten).toBe(0)

    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM attribution_record WHERE instance_id = ${INST}::uuid`
    expect(Number(rows[0]!.count)).toBe(3)
  })
})

describe('ING-1 — shouldDeepRescan (worker_run-backed daily cadence)', () => {
  it('true with no prior deep pass; false within the interval; true again after it', async () => {
    await t.client`DELETE FROM worker_run WHERE worker_name = 'azure-monitor-read'`
    expect(await shouldDeepRescan(t.db)).toBe(true)

    // A recent successful deep pass → no deep rescan needed.
    await t.client`
      INSERT INTO worker_run (worker_name, status, started_at, finished_at, result)
      VALUES ('azure-monitor-read', 'success', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour',
              '{"deepRescan": true}'::jsonb)`
    expect(await shouldDeepRescan(t.db)).toBe(false)

    // Normal (non-deep) successes don't count.
    await t.client`UPDATE worker_run SET result = '{"deepRescan": false}'::jsonb WHERE worker_name = 'azure-monitor-read'`
    expect(await shouldDeepRescan(t.db)).toBe(true)

    // A deep pass older than the interval has aged out.
    await t.client`
      UPDATE worker_run SET result = '{"deepRescan": true}'::jsonb, started_at = NOW() - INTERVAL '25 hours'
      WHERE worker_name = 'azure-monitor-read'`
    expect(await shouldDeepRescan(t.db)).toBe(true)

    // A FAILED deep pass must be retried.
    await t.client`
      UPDATE worker_run SET status = 'failure', started_at = NOW() - INTERVAL '1 hour'
      WHERE worker_name = 'azure-monitor-read'`
    expect(await shouldDeepRescan(t.db)).toBe(true)
  })

  it('a SCOPED recovery batch does NOT satisfy the fleet-wide cadence', async () => {
    // A scoped run deep-rescans only its own instances. Letting it count would
    // suppress the real fleet-wide deep pass for 24h — and a recovery campaign
    // runs many such batches back to back, silently disarming the mechanism that
    // recovers late-arriving telemetry for everyone else.
    await t.client`DELETE FROM worker_run WHERE worker_name = 'azure-monitor-read'`
    await t.client`
      INSERT INTO worker_run (worker_name, status, started_at, finished_at, result)
      VALUES ('azure-monitor-read', 'success', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour',
              '{"deepRescan": true, "scoped": true}'::jsonb)`
    expect(await shouldDeepRescan(t.db)).toBe(true) // still owed a fleet-wide pass

    // The same row unscoped DOES satisfy it — proving the scoped flag is what
    // makes the difference, not some other property of the row.
    await t.client`
      UPDATE worker_run SET result = '{"deepRescan": true, "scoped": false}'::jsonb
      WHERE worker_name = 'azure-monitor-read'`
    expect(await shouldDeepRescan(t.db)).toBe(false)
  })

  it('a PRE-CHANGE row with no "scoped" key still counts (no deep-rescan storm on deploy)', async () => {
    // Rows written before the scoped flag existed have no key at all; SQL NULL
    // IS DISTINCT FROM 'true' is TRUE, so they keep counting. If they stopped,
    // every environment would fire a fleet-wide deep pass the moment this deploys.
    await t.client`DELETE FROM worker_run WHERE worker_name = 'azure-monitor-read'`
    await t.client`
      INSERT INTO worker_run (worker_name, status, started_at, finished_at, result)
      VALUES ('azure-monitor-read', 'success', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour',
              '{"deepRescan": true}'::jsonb)`
    expect(await shouldDeepRescan(t.db)).toBe(false)
  })
})

describe('ING-6 — per-session fault isolation', () => {
  const BAD = 'a6a6a6a6-0000-0000-0000-000000000bad'
  const GOOD = 'a6a6a6a6-0000-0000-0000-00000000900d'

  it('a throwing session is counted in errors and the remaining sessions still attribute', async () => {
    await insertInstance(BAD)
    await insertInstance(GOOD)
    const reader = new FaultyReader(
      new Map([[GOOD, [rec({ tokens: 300, tsEvent: '2026-05-24T09:12:00Z' })]]]),
      new Set([BAD]),
    )
    const res = await runReadJoiner(t.db, asReader(reader), { sessionIds: [BAD, GOOD] })
    expect(res.errors).toBe(1)
    expect(res.attributionRowsWritten).toBe(1)
    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM attribution_record WHERE instance_id = ${GOOD}::uuid`
    expect(Number(rows[0]!.count)).toBe(1)
  })
})

describe('ING-8 — spill counter/audit gated on newly-written rows', () => {
  const INST = 'a8a8a8a8-0000-0000-0000-000000000001'
  // Tagged to INT-PLT, which the teammate is NOT a member of → unauthorized spill.
  const events = [rec({ tokens: 400, tsEvent: '2026-05-24T09:14:00Z', projectCodeHash: 'h-int-plt' })]

  it('first pass spills + audits once; the overlap re-read (all dedup) re-emits nothing', async () => {
    await insertInstance(INST)
    const r1 = await runReadJoiner(t.db, asReader(new StubReader(new Map([[INST, events]]))), {
      sessionIds: [INST],
    })
    expect(r1.spansSpilledUnauthorized).toBe(1)
    expect(r1.attributionRowsWritten).toBe(1)
    const audits1 = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_event
      WHERE event_type = 'attribution-spill-unauthorized' AND subject_id = ${INST}::uuid`
    expect(Number(audits1[0]!.count)).toBe(1)

    // The watermark now equals the event's ts; the 5-min lookback re-reads it.
    const reader2 = new StubReader(new Map([[INST, events]]))
    const r2 = await runReadJoiner(t.db, asReader(reader2), { sessionIds: [INST] })
    expect(reader2.calls[0]!.sinceTsEvent).toBeInstanceOf(Date)
    expect(r2.attributionRowsWritten).toBe(0) // all deduped
    expect(r2.spansSpilledUnauthorized).toBe(0) // counter does NOT re-inflate
    const audits2 = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_event
      WHERE event_type = 'attribution-spill-unauthorized' AND subject_id = ${INST}::uuid`
    expect(Number(audits2[0]!.count)).toBe(1) // no duplicate audit row
  })

  it('unknown-project audit is gated the same way', async () => {
    const INST2 = 'a8a8a8a8-0000-0000-0000-000000000002'
    await insertInstance(INST2)
    const events2 = [rec({ tokens: 410, tsEvent: '2026-05-24T09:15:00Z', projectCodeHash: 'h-nope' })]
    await runReadJoiner(t.db, asReader(new StubReader(new Map([[INST2, events2]]))), { sessionIds: [INST2] })
    await runReadJoiner(t.db, asReader(new StubReader(new Map([[INST2, events2]]))), { sessionIds: [INST2] })
    const audits = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_event
      WHERE event_type = 'attribution-unknown-project' AND subject_id = ${INST2}::uuid`
    expect(Number(audits[0]!.count)).toBe(1)
  })
})

describe('ING-5 — deterministic Copilot cost carrier', () => {
  // nano_aiu 9.11e9 → 9.11 credits → $0.0911 on exactly ONE row per span.
  const NANO = 9_110_000_000
  const copilotRec = (tokenType: string, tokens: number): UsageRecord => ({
    tokens,
    tokenType,
    model: 'claude-sonnet-4-6',
    tsEvent: '2026-05-24T09:20:00Z',
    sourceRunId: 'req-span-1',
    claudeSessionId: 'conv-cop-1',
    nanoAiu: NANO,
  })

  it('cost lands on the priority carrier regardless of record order', async () => {
    const INST = 'a5a5a5a5-0000-0000-0000-000000000001'
    await insertInstance(INST, 'copilot-cli')
    // Deliberately reversed order: cache-read first, input LAST.
    const reader = new StubReader(
      new Map([[INST, [copilotRec('cache-read', 50), copilotRec('output', 20), copilotRec('input', 10)]]]),
    )
    const res = await runReadJoiner(t.db, asReader(reader), { sessionIds: [INST] })
    expect(res.attributionRowsWritten).toBe(3)
    const rows = await t.client<{ token_type: string; cost_usd: string; credit_qty: string }[]>`
      SELECT token_type, cost_usd::text AS cost_usd, credit_qty::text AS credit_qty
      FROM attribution_record WHERE instance_id = ${INST}::uuid ORDER BY token_type`
    const priced = rows.filter((r) => Number(r.cost_usd) > 0)
    expect(priced.length).toBe(1)
    expect(priced[0]!.token_type).toBe('input') // the fixed-priority carrier
    expect(Number(priced[0]!.cost_usd)).toBeCloseTo(0.0911, 4)
    expect(Number(priced[0]!.credit_qty)).toBeCloseTo(9.11, 4)
  })

  it('re-running over a half-written span does not add a second full-cost row', async () => {
    const INST = 'a5a5a5a5-0000-0000-0000-000000000002'
    await insertInstance(INST, 'copilot-cli')
    // Simulate a crashed prior tick that persisted ONLY the 'output' row — and
    // (arrival-order pricing) put the full span cost on it.
    await t.client.unsafe(`
      INSERT INTO attribution_record
        (instance_id, claude_session_id, teammate_id, region_id, org_unit_id, tool, model,
         token_type, tokens, cost_usd, credit_qty, fidelity_tier, cost_basis, ts_event, source_run_id)
      VALUES
        ('${INST}', 'conv-cop-1', '${TEAM}', '11111111-1111-1111-1111-111111111111',
         '22222222-2222-2222-2222-222222222222', 'copilot-cli', 'claude-sonnet-4-6',
         'output', 20, 0.091100, 9.110000, 'tier-2', 'telemetry-only',
         '2026-05-24T09:20:00Z', 'req-span-1');
    `)
    // The next tick re-reads the whole span (input/output/cache-read).
    const reader = new StubReader(
      new Map([[INST, [copilotRec('input', 10), copilotRec('output', 20), copilotRec('cache-read', 50)]]]),
    )
    const res = await runReadJoiner(t.db, asReader(reader), { sessionIds: [INST] })
    expect(res.attributionRowsWritten).toBe(2) // input + cache-read; output dedups

    const rows = await t.client<{ cost_usd: string; credit_sum: string; count: string }[]>`
      SELECT COUNT(*)::text AS count,
             COALESCE(SUM(cost_usd), 0)::text AS cost_usd,
             COALESCE(SUM(credit_qty), 0)::text AS credit_sum
      FROM attribution_record WHERE instance_id = ${INST}::uuid`
    expect(Number(rows[0]!.count)).toBe(3)
    // The span is priced exactly once — no second full-cost row (ING-5).
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(0.0911, 4)
    expect(Number(rows[0]!.credit_sum)).toBeCloseTo(9.11, 4)
  })
})
