/*
 * Mig 0045 capture — query_source + law-cost belt-and-braces through the
 * read joiner (design: docs/design/session-granularity-sprint.md WS-1).
 *
 *   - query_source lands on attribution_record (NULL = legacy/unknown,
 *     never defaulted to 'main')
 *   - lawCostUsd lands in metadata.law_cost_usd, MERGED with the backfill
 *     flag (not clobbering it)
 *   - v_cost_drift compares SUM(our cost) vs MAX(law cost) per span
 *     (the KQL mv-expand duplicates the per-event cost onto all four
 *     token-type rows — the view must not 4× it)
 *   - dedup/idempotency is byte-identical to pre-0045 behaviour
 *
 * UPDATED for docs/design/provider-cost-precedence.md. The "never 4× the law
 * cost" property this file has always pinned is now MORE load-bearing, not
 * less: the law cost is no longer a belt-and-braces cross-check, it IS the
 * cost. So the span-level assertion is tightened from "the view does not
 * multiply it" to "SUM(cost_usd) equals the provider figure EXACTLY, and the
 * drift is exactly zero" — which is only true if the joiner takes MAX per span
 * (never SUM) and groups spans the same way v_cost_drift does.
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
    // ONE span (four token-type rows of the same api_request), priced by the
    // provider and sliced by the rate card.
    expect(result.costingRungs).toEqual({ provider: 1, rateCard: 0, carrier: 0, skipped: 0 })

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

  it('the span total is the PROVIDER figure, exactly — sliced across the 4 rows, never 4× it', async () => {
    // The whole point of provider-cost-precedence: the four rows of one span
    // carry the provider's single figure between them. Asserted as an EXACT
    // string comparison on the numeric column, not toBeCloseTo — "close" is
    // precisely what this design exists to stop being good enough.
    const [sum] = await t.client<{ total: string }[]>`
      SELECT SUM(cost_usd)::text AS total FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid AND source_run_id = 'req_gran_1'
    `
    expect(sum!.total).toBe(LAW_COST.toFixed(6))

    // Provenance: the provider priced it, so the rate card is NOT pinned (mig
    // 0036 semantics) and cost_basis names the rung.
    const rows = await t.client<
      { cost_basis: string; rate_card_id: string | null; rate_card_version: number | null }[]
    >`
      SELECT cost_basis, rate_card_id::text AS rate_card_id, rate_card_version
      FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid AND source_run_id = 'req_gran_1'
    `
    expect(rows).toHaveLength(4)
    for (const r of rows) {
      expect(r.cost_basis).toBe('provider-reported')
      expect(r.rate_card_id).toBeNull()
      expect(r.rate_card_version).toBeNull()
    }
  })

  it('never 1-4× the law cost: it appears ONCE per span (MAX), not once per token-type row', async () => {
    // The property this file has always pinned, restated on the axis that now
    // matters. The provider's figure is duplicated onto all four rows by the KQL
    // mv-expand; the span-level view must MAX it, and the joiner must take MAX
    // when it costs the span. If either summed, this would read 4 × LAW_COST.
    const drift = await t.client<{ span_key: string; model: string; law_cost_usd: string }[]>`
      SELECT span_key, model, law_cost_usd
      FROM v_cost_drift
      WHERE instance_id = ${INSTANCE}::uuid AND span_key = 'req_gran_1'
    `
    expect(drift).toHaveLength(1)
    expect(drift[0]!.model).toBe('claude-fable-5')
    expect(Number(drift[0]!.law_cost_usd)).toBeCloseTo(LAW_COST, 9)

    // …and the ledger side of the same property, asserted EXACTLY. This is what
    // catches a slicing-residue bug: a lost or duplicated micro-dollar in the
    // largest-remainder allocation shows up here and nowhere else.
    const [sum] = await t.client<{ total: string }[]>`
      SELECT SUM(cost_usd)::text AS total FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid AND source_run_id = 'req_gran_1'
    `
    expect(sum!.total).toBe(LAW_COST.toFixed(6))

    // NOTE the assertion that is deliberately NOT here: `rate_card_cost_usd ==
    // SUM(cost_usd)` held only while cost_usd WAS the rate-card estimate. Now
    // that the provider's figure lives there, the view (mig 0091) reads the
    // estimate from metadata.rate_card_cost_usd instead — pinned in the next
    // test. Asserting the old equality would pin a tautology.
  })

  it('the displaced rate-card estimate is persisted PER ROW as metadata.rate_card_cost_usd', async () => {
    // rate_card_id is NULL on a provider-priced row, so nothing can re-derive
    // the estimate afterwards; if the joiner did not persist it, the cost-drift
    // diagnostic would compare the provider against itself and print ~0 forever
    // — going green exactly when the rate card is most wrong.
    //
    // claude-fable-5 has no model-specific lines (mig 0061 covers opus/sonnet/
    // haiku), so it falls back to the seeded wildcard placeholders: input $3,
    // output $15, cache-read $0.30, cache-write $3.75 per 1M.
    const rows = await t.client<{ token_type: string; est: string | null }[]>`
      SELECT token_type, metadata->>'rate_card_cost_usd' AS est
      FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid AND source_run_id = 'req_gran_1'
      ORDER BY token_type
    `
    expect(rows.map((r) => [r.token_type, r.est])).toEqual([
      ['cache-read', '0.015000'], //  50,000 × $0.30/1M
      ['cache-write', '0.015000'], //  4,000 × $3.75/1M
      ['input', '0.003000'], //        1,000 × $3.00/1M
      ['output', '0.003000'], //         200 × $15.00/1M
    ])
    // PER ROW, SUMmed — the mirror image of law_cost_usd, which is span-
    // duplicated and MAXed. Writing a span total into this key would 4× the
    // estimate and manufacture drift out of nothing.
    const [est] = await t.client<{ total: string }[]>`
      SELECT SUM((metadata->>'rate_card_cost_usd')::numeric)::text AS total
      FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid AND source_run_id = 'req_gran_1'
    `
    expect(est!.total).toBe('0.036000')
    // The estimate and the provider figure genuinely differ (here the card
    // over-prices ~3×), which is the whole point: the diagnostic stays a
    // diagnostic instead of collapsing to a tautological zero.
    expect(Number(est!.total)).toBeGreaterThan(LAW_COST)
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
    // No provider cost → rung 2. This is the case the design ALERTS on, and the
    // counter is what makes the alert possible.
    expect(result.costingRungs).toEqual({ provider: 0, rateCard: 1, carrier: 0, skipped: 0 })

    const [row] = await t.client<
      { query_source: string | null; metadata: unknown; cost_basis: string; rate_card_id: string | null }[]
    >`
      SELECT query_source, metadata, cost_basis, rate_card_id::text AS rate_card_id
      FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid AND source_run_id = 'req_legacy_1'
    `
    expect(row!.query_source).toBeNull()
    expect(row!.metadata).toBeNull()
    // Rate-card-priced rows keep 'estimated' and the pinned card, exactly as
    // before the design — history keeps behaving as it always has.
    expect(row!.cost_basis).toBe('estimated')
    expect(row!.rate_card_id).not.toBeNull()

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
      {
        backfill: string | null
        law_cost: string | null
        fidelity_tier: string
        cost_basis: string
        cost_usd: string
      }[]
    >`
      SELECT metadata->>'backfill' AS backfill, metadata->>'law_cost_usd' AS law_cost,
             fidelity_tier, cost_basis, cost_usd::text AS cost_usd
      FROM attribution_record
      WHERE instance_id = ${INSTANCE}::uuid AND source_run_id = 'req_bf_1'
    `
    expect(row!.backfill).toBe('true')
    expect(Number(row!.law_cost)).toBeCloseTo(0.002, 9)
    // The provider still priced it (single-row span → the whole figure).
    expect(row!.cost_usd).toBe('0.002000')
    // Backfill provenance class unchanged by the merge — and it OUTRANKS the
    // rung literal. 'telemetry-only' answers "is this reconcilable?" (no), which
    // every reconciliation query keys on; 'provider-reported' only answers "which
    // rung priced it?". Promoting this row would walk a non-reconcilable
    // re-emission into the reconcilable lane.
    expect(row!.fidelity_tier).toBe('tier-2')
    expect(row!.cost_basis).toBe('telemetry-only')
  })
})
