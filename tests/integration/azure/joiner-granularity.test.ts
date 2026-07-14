/*
 * Mig 0045 capture — query_source + law-cost belt-and-braces through the
 * read joiner (design: docs/design/session-granularity-sprint.md WS-1).
 *
 *   - query_source lands on attribution_record (NULL = legacy/unknown,
 *     never defaulted to 'main')
 *   - lawCostUsd lands in metadata.law_cost_usd, MERGED with the backfill
 *     flag (not clobbering it)
 *   - v_cost_drift compares SUM(rate-card cost) vs MAX(law cost) per span
 *     (the KQL mv-expand duplicates the per-event cost onto all four
 *     token-type rows — the view must not 4× it)
 *   - dedup/idempotency is byte-identical to pre-0045 behaviour
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadJoiner } from '../../../server/workers/azure-monitor-reader'
import { WATERMARK_LOOKBACK_MS, type TelemetryReader, type UsageRecord } from '../../../server/azure/reader'

let t: TestDb

class StubReader {
  constructor(public readonly map: Map<string, UsageRecord[]>) {}
  async getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    const all = this.map.get(sessionId) ?? []
    if (!sinceTsEvent) return all
    const cutoff = sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS
    return all.filter((u) => new Date(u.tsEvent).getTime() > cutoff)
  }
}

const INSTANCE = 'aaaa1045-0000-0000-0000-000000000001'
const CONV = 'conv-granularity-1'

// One full api_request span: four token types, identical span identity
// (tsEvent + sourceRunId), law cost duplicated onto each row — exactly the
// shape the sandbox KQL mv-expand produces.
const SPAN_TS = '2026-05-24T09:10:00Z'
const LAW_COST = 0.0123
const fullSpan: UsageRecord[] = (
  [
    ['input', 1000],
    ['output', 200],
    ['cache-read', 50000],
    ['cache-write', 4000],
  ] as const
).map(([tokenType, tokens]) => ({
  tokens,
  tokenType,
  model: 'claude-fable-5',
  tsEvent: SPAN_TS,
  sourceRunId: 'req_gran_1',
  claudeSessionId: CONV,
  projectCodeHash: 'h-gran',
  querySource: 'main',
  lawCostUsd: LAW_COST,
}))

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'apac', 'APAC');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
              'apac.services'::ltree, 'apac-svcs', 'APAC Services', 'bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES ('33333333-3333-3333-3333-333333333333', 'oid', 'dev@i.com',
              '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
    INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES ('44444444-4444-4444-4444-444444444444', 'GRA-NUL', 'h-gran', 'Granularity Test',
              'billable', '11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222');
    INSERT INTO project_assignment (project_id, teammate_id, effective)
      VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333',
              '[2026-01-01, 2099-01-01)'::tstzrange);
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
       raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
       region_id, org_unit_id, cost_owning_unit_id)
    VALUES
      ('${INSTANCE}', 'oid', 'dev@i.com',
       '33333333-3333-3333-3333-333333333333', 'h-gran', 'GRA-NUL',
       'claude-code', 'hashG', '2026-05-24 09:00:00+00', '2026-05-24 09:30:00+00',
       '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
       '22222222-2222-2222-2222-222222222222');
  `)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('runReadJoiner — mig 0045 granularity capture', () => {
  it('writes query_source and metadata.law_cost_usd on every row of the span', async () => {
    const reader = new StubReader(new Map([[INSTANCE, fullSpan]])) as unknown as TelemetryReader
    const result = await runReadJoiner(t.db, reader, { sessionIds: [INSTANCE] })
    expect(result.attributionRowsWritten).toBe(4)

    const rows = await t.client<
      { token_type: string; query_source: string | null; law_cost: string | null }[]
    >`
      SELECT token_type, query_source, metadata->>'law_cost_usd' AS law_cost
      FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid
      ORDER BY token_type
    `
    expect(rows).toHaveLength(4)
    for (const r of rows) {
      expect(r.query_source).toBe('main')
      expect(Number(r.law_cost)).toBeCloseTo(LAW_COST, 9)
    }
  })

  it('re-run is idempotent — granularity fields do not perturb the dedup key', async () => {
    const reader = new StubReader(new Map([[INSTANCE, fullSpan]])) as unknown as TelemetryReader
    const result = await runReadJoiner(t.db, reader, { sessionIds: [INSTANCE] })
    expect(result.attributionRowsWritten).toBe(0)
  })

  it('v_cost_drift: one row per span — SUM(rate-card cost) vs MAX(law cost), never 4× the law cost', async () => {
    const drift = await t.client<
      {
        span_key: string
        model: string
        rate_card_cost_usd: string
        law_cost_usd: string
        drift_usd: string
      }[]
    >`
      SELECT span_key, model, rate_card_cost_usd, law_cost_usd, drift_usd
      FROM v_cost_drift
      WHERE instance_id = ${INSTANCE}::uuid
    `
    expect(drift).toHaveLength(1)
    expect(drift[0]!.span_key).toBe('req_gran_1')
    expect(drift[0]!.model).toBe('claude-fable-5')
    // law cost appears ONCE (MAX), not summed across the 4 duplicated rows.
    expect(Number(drift[0]!.law_cost_usd)).toBeCloseTo(LAW_COST, 9)

    // rate_card_cost_usd must equal the SUM of the stored per-type costs —
    // derived from the ledger, not from hardcoded rate-card numbers.
    const [sum] = await t.client<{ total: string }[]>`
      SELECT SUM(cost_usd)::text AS total FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid
    `
    expect(Number(drift[0]!.rate_card_cost_usd)).toBeCloseTo(Number(sum!.total), 6)
    expect(Number(drift[0]!.drift_usd)).toBeCloseTo(Number(sum!.total) - LAW_COST, 6)
  })

  it('legacy records (no querySource/lawCostUsd) → NULL query_source, NULL metadata, no drift row', async () => {
    const legacy: UsageRecord[] = [
      {
        tokens: 700,
        tokenType: 'input',
        model: 'claude-sonnet-4-6',
        tsEvent: '2026-05-24T09:20:00Z',
        sourceRunId: 'req_legacy_1',
        claudeSessionId: CONV,
        projectCodeHash: 'h-gran',
      },
    ]
    const reader = new StubReader(new Map([[INSTANCE, legacy]])) as unknown as TelemetryReader
    const result = await runReadJoiner(t.db, reader, { sessionIds: [INSTANCE] })
    expect(result.attributionRowsWritten).toBe(1)

    const [row] = await t.client<
      { query_source: string | null; metadata: unknown }[]
    >`
      SELECT query_source, metadata FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid AND source_run_id = 'req_legacy_1'
    `
    expect(row!.query_source).toBeNull()
    expect(row!.metadata).toBeNull()

    const drift = await t.client<{ span_key: string }[]>`
      SELECT span_key FROM v_cost_drift
      WHERE instance_id = ${INSTANCE}::uuid AND span_key = 'req_legacy_1'
    `
    expect(drift).toHaveLength(0)
  })

  it('backfill + law cost: metadata MERGES both keys (backfill flag not clobbered)', async () => {
    const backfilled: UsageRecord[] = [
      {
        tokens: 300,
        tokenType: 'output',
        model: 'claude-fable-5',
        tsEvent: '2026-05-24T09:25:00Z',
        sourceRunId: 'req_bf_1',
        claudeSessionId: CONV,
        projectCodeHash: 'h-gran',
        backfill: true,
        querySource: 'main',
        lawCostUsd: 0.002,
      },
    ]
    const reader = new StubReader(new Map([[INSTANCE, backfilled]])) as unknown as TelemetryReader
    const result = await runReadJoiner(t.db, reader, { sessionIds: [INSTANCE] })
    expect(result.attributionRowsWritten).toBe(1)

    const [row] = await t.client<
      { backfill: string | null; law_cost: string | null; fidelity_tier: string; cost_basis: string }[]
    >`
      SELECT metadata->>'backfill' AS backfill, metadata->>'law_cost_usd' AS law_cost,
             fidelity_tier, cost_basis
      FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid AND source_run_id = 'req_bf_1'
    `
    expect(row!.backfill).toBe('true')
    expect(Number(row!.law_cost)).toBeCloseTo(0.002, 9)
    // Backfill provenance class unchanged by the merge.
    expect(row!.fidelity_tier).toBe('tier-2')
    expect(row!.cost_basis).toBe('telemetry-only')
  })
})
