// @vitest-environment node
/*
 * Provider-reported cost as the billed telemetry number, END TO END through the
 * real joiner and a real Postgres. Design: docs/design/provider-cost-precedence.md.
 *
 * THE PRINCIPLE: the provider states what it cost; record that, do not
 * re-derive it. The rate card is demoted to (a) a fallback when the provider
 * reported nothing, and (b) the thing that decides how the span total is SLICED
 * across our per-token-type rows.
 *
 * The pure arithmetic is unit-tested in tests/unit/usage/span-costing.test.ts.
 * What is only provable HERE, against the real schema, is that:
 *
 *   1. a provider-costed span writes rows summing EXACTLY to the provider's
 *      figure, with cost_basis='provider-reported' and rate_card_id NULL;
 *   2. MAX per span, never SUM — the KQL mv-expand copies the same figure onto
 *      every token-type row, so summing would 1-4× the cost;
 *   3. a span with no provider cost falls back to the rate card AND is counted
 *      (the alert the design is built around);
 *   4. the single-carrier fallback fires when the card cannot slice, and never
 *      drops the span;
 *   5. an UNKNOWN token type is CARRIED, not dropped and not mis-slotted;
 *   6. the numbers survive a numeric(14,6) round-trip and a re-run;
 *   7. a span's rows are written ALL-OR-NOTHING, so no rate-card edit between
 *      two passes can leave the span booked at anything but the provider's
 *      figure — and a figure the column cannot store degrades to rung 2 instead
 *      of throwing at the INSERT and wedging the session's attribution;
 *   8. none of the above disturbed the Copilot lane, which is priced from AI
 *      credits and never touched a rate card.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadJoiner } from '../../../server/workers/azure-monitor-reader'
import {
  WATERMARK_LOOKBACK_MS,
  type TelemetryReader,
  type UsageRecord,
} from '../../../server/azure/reader'

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

const reader = (sid: string, recs: UsageRecord[]) =>
  new StubReader(new Map([[sid, recs]])) as unknown as TelemetryReader

const APAC = '11111111-1111-1111-1111-111111111111'
const OU = '22222222-2222-2222-2222-222222222222'
const TEAM = '33333333-3333-3333-3333-333333333333'
// One instance per scenario: the per-instance watermark is MAX(ts_event) over
// already-written rows, so sharing an instance across scenarios would silently
// filter a later test's older events.
const INST_SLICE = '80000000-0000-4000-8000-000000000001'
const INST_RESIDUE = '80000000-0000-4000-8000-000000000002'
const INST_FALLBACK = '80000000-0000-4000-8000-000000000003'
const INST_UNKNOWN_TYPE = '80000000-0000-4000-8000-000000000004'
const INST_NO_CARD = '80000000-0000-4000-8000-000000000005'
const INST_GUARD = '80000000-0000-4000-8000-000000000006'
const INST_ROLLBACK = '80000000-0000-4000-8000-000000000007'
const INST_OVERSIZE = '80000000-0000-4000-8000-000000000008'
const INST_DUP = '80000000-0000-4000-8000-000000000009'
const INST_ORDER_A = '0000000a-0000-4000-8000-00000000d1a1'
const INST_ORDER_B = '0000000a-0000-4000-8000-00000000d1b2'
// Copilot lane — tool='copilot-cli' on the attestation row.
const INST_COPILOT = '80000000-0000-4000-8000-00000000000a'
// The rate-card-EDIT scenario gets its own region and its own card, because it
// MUTATES a rate line mid-test. Every other test here prices against the seeded
// global card, which must stay exactly as mig 0004 wrote it.
const EDIT_REGION = '11111111-1111-1111-1111-111111111112'
const EDIT_OU = '22222222-2222-2222-2222-222222222223'
const EDIT_CARD = 'a1000000-0000-4000-8000-000000000001'
const INST_EDIT = '80000000-0000-4000-8000-00000000000b'

// mig 0004 seeded global card, wildcard (model NULL) lines, per 1M tokens:
// input $3, output $15, cache-read $0.30, cache-write $3.75.
const GLOBAL_CARD = '90000000-0000-4000-8000-000000000001'

/** One api_request span: the same tsEvent + request_id on every token row, and
 *  the provider's per-request cost duplicated onto each of them — exactly the
 *  shape the KQL mv-expand produces (server/azure/reader.ts:399). */
function span(
  opts: {
    tsEvent: string
    sourceRunId: string
    model?: string
    lawCostUsd?: number
    claudeSessionId?: string
  },
  rows: ReadonlyArray<readonly [string, number]>,
): UsageRecord[] {
  return rows.map(([tokenType, tokens]) => ({
    tokens,
    tokenType,
    model: opts.model ?? 'claude-sonnet-4-7',
    tsEvent: opts.tsEvent,
    sourceRunId: opts.sourceRunId,
    ...(opts.claudeSessionId ? { claudeSessionId: opts.claudeSessionId } : {}),
    ...(opts.lawCostUsd === undefined ? {} : { lawCostUsd: opts.lawCostUsd }),
  }))
}

const rowsOf = (inst: string, runId: string) =>
  t.client<
    {
      token_type: string
      cost_usd: string
      cost_basis: string
      rate_card_id: string | null
      rate_card_version: number | null
    }[]
  >`
    SELECT token_type, cost_usd::text AS cost_usd, cost_basis,
           rate_card_id::text AS rate_card_id, rate_card_version
    FROM attribution_record
    WHERE instance_id = ${inst}::uuid AND source_run_id = ${runId}
    ORDER BY token_type`

const totalOf = async (inst: string, runId: string) => {
  const [r] = await t.client<{ total: string }[]>`
    SELECT SUM(cost_usd)::text AS total FROM attribution_record
    WHERE instance_id = ${inst}::uuid AND source_run_id = ${runId}`
  return r!.total
}

beforeAll(async () => {
  t = await startTestDb()
  // [instance_id, session_token_hash, tool, region_id, org_unit_id]
  const instances = [
    [INST_SLICE, 'hSlice', 'claude-code', APAC, OU],
    [INST_RESIDUE, 'hResidue', 'claude-code', APAC, OU],
    [INST_FALLBACK, 'hFallback', 'claude-code', APAC, OU],
    [INST_UNKNOWN_TYPE, 'hUnknownType', 'claude-code', APAC, OU],
    [INST_NO_CARD, 'hNoCard', 'claude-code', APAC, OU],
    [INST_GUARD, 'hGuard', 'claude-code', APAC, OU],
    [INST_ROLLBACK, 'hRollback', 'claude-code', APAC, OU],
    [INST_OVERSIZE, 'hOversize', 'claude-code', APAC, OU],
    [INST_DUP, 'hDup', 'claude-code', APAC, OU],
    [INST_ORDER_A, 'hOrdA', 'claude-code', APAC, OU],
    [INST_ORDER_B, 'hOrdB', 'claude-code', APAC, OU],
    [INST_COPILOT, 'hCopilot', 'copilot-cli', APAC, OU],
    [INST_EDIT, 'hEdit', 'claude-code', EDIT_REGION, EDIT_OU],
  ] as const
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('${APAC}','apac','APAC'),
      ('${EDIT_REGION}','edit','Rate-line-edit region');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type) VALUES
      ('${OU}','${APAC}','apac.services'::ltree,'apac-svcs','APAC Services','bu'),
      ('${EDIT_OU}','${EDIT_REGION}','edit.services'::ltree,'edit-svcs','Edit Services','bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES ('${TEAM}','oid','dev@i.com','${APAC}','${OU}');
    -- A region-scoped card so the rate-line EDIT below cannot disturb the
    -- seeded global card every other test in this file prices against
    -- (region tier > global tier, mig 0050). Same shape as the seed:
    -- input $3/1M, output $15/1M, cache-read $0.30/1M, wildcard model.
    INSERT INTO rate_card (id, scope_key, effective, basis, provenance, version, region_id, cou_id)
    VALUES ('${EDIT_CARD}','anthropic:claude-code','[2026-01-01, 2099-01-01)'::tstzrange,'list',
            '{"source":"test"}'::jsonb, 1, '${EDIT_REGION}', NULL);
    INSERT INTO rate_line (rate_card_id, unit, unit_qty, unit_cost_usd, model) VALUES
      ('${EDIT_CARD}', 'input', 1000000, 3.00, NULL),
      ('${EDIT_CARD}', 'output', 1000000, 15.00, NULL),
      ('${EDIT_CARD}', 'cache-read', 1000000, 0.30, NULL);
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
       tool, session_token_hash, ts_start, ts_actual_end, region_id, org_unit_id, cost_owning_unit_id,
       attestation_state)
    VALUES
      ${instances
        .map(
          ([id, h, tool, region, ou]) =>
            `('${id}','oid','dev@i.com','${TEAM}',NULL,NULL,'${tool}','${h}',
              '2026-05-10T09:00:00Z','2026-05-10T11:00:00Z','${region}','${ou}',NULL,'unassigned')`,
        )
        .join(',\n      ')};
  `)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('rung 1 — the provider priced it', () => {
  it('rows sum EXACTLY to the provider figure, cost_basis=provider-reported, rate card NOT pinned', async () => {
    // Seeded wildcard ratio for these token counts:
    //   input     1,000,000 -> $3.000000
    //   output      200,000 -> $3.000000
    //   cache-read 5,000,000 -> $1.500000
    //   cache-write 400,000 -> $1.500000            total $9.000000
    // i.e. shares of 1/3, 1/3, 1/6, 1/6. The provider says $0.036, so the rows
    // must come out $0.012 / $0.012 / $0.006 / $0.006.
    const res = await runReadJoiner(
      t.db,
      reader(
        INST_SLICE,
        span({ tsEvent: '2026-05-10T10:00:00Z', sourceRunId: 'req_slice', lawCostUsd: 0.036 }, [
          ['input', 1_000_000],
          ['output', 200_000],
          ['cache-read', 5_000_000],
          ['cache-write', 400_000],
        ]),
      ),
      { sessionIds: [INST_SLICE] },
    )
    expect(res.attributionRowsWritten).toBe(4)
    expect(res.spansSkippedNoRateCard).toBe(0)
    expect(res.costingRungs).toEqual({ provider: 1, rateCard: 0, carrier: 0, skipped: 0 })

    const rows = await rowsOf(INST_SLICE, 'req_slice')
    expect(rows.map((r) => [r.token_type, r.cost_usd])).toEqual([
      ['cache-read', '0.006000'],
      ['cache-write', '0.006000'],
      ['input', '0.012000'],
      ['output', '0.012000'],
    ])
    // EXACT, not approximate: this is the property every budget, rollup and
    // chargeback figure inherits.
    expect(await totalOf(INST_SLICE, 'req_slice')).toBe('0.036000')
    for (const r of rows) {
      expect(r.cost_basis).toBe('provider-reported')
      // mig 0036 semantics: the card decided the slice, not the amount, so the
      // pin stays NULL. No reader joins on it.
      expect(r.rate_card_id).toBeNull()
      expect(r.rate_card_version).toBeNull()
    }
  })

  it('MAX per span, never SUM — the figure duplicated on 4 rows is counted ONCE', async () => {
    // This is the regression that would silently 1-4× every heavy user's spend,
    // correlated with cache usage. Four rows each carrying lawCostUsd=0.036;
    // SUM would have produced $0.144.
    expect(await totalOf(INST_SLICE, 'req_slice')).toBe('0.036000')
    const [drift] = await t.client<{ law_cost_usd: string }[]>`
      SELECT law_cost_usd::text AS law_cost_usd
      FROM v_cost_drift
      WHERE instance_id = ${INST_SLICE}::uuid AND span_key = 'req_slice'`
    expect(Number(drift!.law_cost_usd)).toBeCloseTo(0.036, 9)
  })

  it('persists the displaced rate-card estimate PER ROW as metadata.rate_card_cost_usd', async () => {
    // rate_card_id is NULL on a provider-priced row, so the estimate cannot be
    // re-derived after the fact. Without this key the cost-drift diagnostic
    // (mig 0091) would compare the provider against itself and report a
    // tautological ~0 — going green exactly when the rate card is most wrong.
    //
    // These are the pre-cutover numbers: the seeded wildcard card would have
    // charged $9.00 for this span, against the provider's $0.036.
    const rows = await t.client<{ token_type: string; est: string | null }[]>`
      SELECT token_type, metadata->>'rate_card_cost_usd' AS est
      FROM attribution_record
      WHERE instance_id = ${INST_SLICE}::uuid AND source_run_id = 'req_slice'
      ORDER BY token_type`
    expect(rows.map((r) => [r.token_type, r.est])).toEqual([
      ['cache-read', '1.500000'],
      ['cache-write', '1.500000'],
      ['input', '3.000000'],
      ['output', '3.000000'],
    ])
    // PER ROW and SUMmed, the mirror image of law_cost_usd (span-duplicated and
    // MAXed). A span total written into this key would 4× the estimate.
    const [est] = await t.client<{ total: string }[]>`
      SELECT SUM((metadata->>'rate_card_cost_usd')::numeric)::text AS total
      FROM attribution_record
      WHERE instance_id = ${INST_SLICE}::uuid AND source_run_id = 'req_slice'`
    expect(est!.total).toBe('9.000000')
  })

  it('END-TO-END SEAM: the drift view reads what the joiner wrote, un-multiplied', async () => {
    /*
     * The one assertion neither half of this change could make on its own.
     *
     * The joiner writes metadata.rate_card_cost_usd PER ROW; v_cost_drift
     * (mig 0091) SUMs it. law_cost_usd is the mirror image — span-duplicated by
     * the KQL mv-expand, so the view MAXes it. Get either aggregate backwards and
     * the numbers stay individually plausible while the diagnostic silently
     * misreports by up to 4x, in a way that correlates with cache usage.
     *
     * The joiner tests assert the write shape; the diagnostics tests assert the
     * view against their own fixtures. Only this one runs the real joiner and
     * then reads the real view, which is where a contract drift between the two
     * would actually surface.
     */
    const [d] = await t.client<{
      rate_card_cost_usd: string
      law_cost_usd: string
      drift_usd: string
      booked_cost_usd: string
      priced_by: string
    }[]>`
      SELECT rate_card_cost_usd::text AS rate_card_cost_usd,
             law_cost_usd::text       AS law_cost_usd,
             drift_usd::text          AS drift_usd,
             booked_cost_usd::text    AS booked_cost_usd,
             priced_by
        FROM v_cost_drift
       WHERE instance_id = ${INST_SLICE}::uuid AND span_key = 'req_slice'`

    expect(d, 'a provider-priced span must still appear in the drift view').toBeTruthy()
    // SUMmed across 4 rows: 3.00 + 3.00 + 1.50 + 1.50. NOT 36.00 (4x).
    expect(Number(d!.rate_card_cost_usd)).toBeCloseTo(9.0, 9)
    // MAXed across the same 4 rows, each carrying 0.036. NOT 0.144 (4x).
    expect(Number(d!.law_cost_usd)).toBeCloseTo(0.036, 9)
    expect(Number(d!.drift_usd)).toBeCloseTo(9.0 - 0.036, 9)
    // The slicing residue lands here: what we actually booked must equal the
    // provider's figure to the cent, or the split lost/created money.
    expect(Number(d!.booked_cost_usd)).toBeCloseTo(0.036, 9)
    expect(d!.priced_by).toBe('provider')
  })

})

describe('rung 2 — the provider gave us nothing', () => {
  it('falls back to the rate card, keeps cost_basis=estimated + the pinned card, and is COUNTED', async () => {
    const res = await runReadJoiner(
      t.db,
      reader(
        INST_FALLBACK,
        span({ tsEvent: '2026-05-10T10:02:00Z', sourceRunId: 'req_fallback' }, [
          ['input', 1_000_000],
          ['output', 1_000_000],
        ]),
      ),
      { sessionIds: [INST_FALLBACK] },
    )
    expect(res.attributionRowsWritten).toBe(2)
    // THE ALERT. A healthy fleet is entirely `provider`; this counter is the
    // signal that our own price list priced real spend.
    expect(res.costingRungs).toEqual({ provider: 0, rateCard: 1, carrier: 0, skipped: 0 })

    const rows = await rowsOf(INST_FALLBACK, 'req_fallback')
    // Unchanged from before the design: each row keeps its own card estimate.
    expect(rows.map((r) => [r.token_type, r.cost_usd])).toEqual([
      ['input', '3.000000'],
      ['output', '15.000000'],
    ])
    for (const r of rows) {
      expect(r.cost_basis).toBe('estimated')
      expect(r.rate_card_id).toBe(GLOBAL_CARD)
      expect(r.rate_card_version).toBe(1)
    }
  })

  it('a rate-card-priced row carries NO estimate key — cost_usd already IS the estimate', async () => {
    const rows = await t.client<{ est: string | null; rate_card_id: string | null }[]>`
      SELECT metadata->>'rate_card_cost_usd' AS est, rate_card_id::text AS rate_card_id
      FROM attribution_record
      WHERE instance_id = ${INST_FALLBACK}::uuid AND source_run_id = 'req_fallback'`
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.est).toBeNull()
      // …and the pin is present, which is the exact rung marker for
      // tool='claude-code': a NULL pin can only mean the card did not price it.
      expect(r.rate_card_id).not.toBeNull()
    }
  })

  it('zero and negative provider costs take the same fallback (the ONLY guard)', async () => {
    // "missing, zero, or negative -> rate card, and ALERT". There is
    // deliberately no plausibility band, ceiling or ratio check beyond this.
    for (const [runId, lawCostUsd, ts] of [
      ['req_zero', 0, '2026-05-10T10:03:00Z'],
      ['req_negative', -1.25, '2026-05-10T10:04:00Z'],
    ] as const) {
      const res = await runReadJoiner(
        t.db,
        reader(INST_GUARD, span({ tsEvent: ts, sourceRunId: runId, lawCostUsd }, [['input', 1_000_000]])),
        { sessionIds: [INST_GUARD] },
      )
      expect(res.costingRungs).toEqual({ provider: 0, rateCard: 1, carrier: 0, skipped: 0 })
      const rows = await rowsOf(INST_GUARD, runId)
      expect(rows[0]!.cost_usd).toBe('3.000000')
      expect(rows[0]!.cost_basis).toBe('estimated')
      expect(rows[0]!.rate_card_id).toBe(GLOBAL_CARD)
    }
  })

  it('an implausibly LARGE provider cost is recorded, not rejected', async () => {
    // Deliberate, and the design says so explicitly: a units mix-up is a
    // million-fold error — the loudest failure available, obvious in every chart
    // within minutes — so a write-time ceiling would defend only the one thing
    // that cannot fail silently while catching none of the small errors. An
    // earlier draft had the band; it was removed on review.
    const res = await runReadJoiner(
      t.db,
      reader(
        INST_GUARD,
        span({ tsEvent: '2026-05-10T10:05:00Z', sourceRunId: 'req_huge', lawCostUsd: 12_345.6789 }, [
          ['input', 1_000],
        ]),
      ),
      { sessionIds: [INST_GUARD] },
    )
    expect(res.costingRungs).toEqual({ provider: 1, rateCard: 0, carrier: 0, skipped: 0 })
    const rows = await rowsOf(INST_GUARD, 'req_huge')
    expect(rows[0]!.cost_usd).toBe('12345.678900')
    expect(rows[0]!.cost_basis).toBe('provider-reported')
  })
})

describe('the single-carrier fallback — never drop the span', () => {
  it('an UNKNOWN token type is CARRIED, not dropped and not mis-slotted', async () => {
    // A future reasoning token / new cache tier has no line on the card, so no
    // share ratio exists and NO split across these rows is defensible. The whole
    // (correct) provider total lands on one deterministic row; every row is
    // still written, so the tokens are not lost either.
    const res = await runReadJoiner(
      t.db,
      reader(
        INST_UNKNOWN_TYPE,
        span({ tsEvent: '2026-05-10T10:06:00Z', sourceRunId: 'req_reasoning', lawCostUsd: 0.5 }, [
          ['input', 1_000_000],
          ['output', 200_000],
          ['reasoning', 50_000],
        ]),
      ),
      { sessionIds: [INST_UNKNOWN_TYPE] },
    )
    expect(res.attributionRowsWritten).toBe(3)
    expect(res.spansSkippedNoRateCard).toBe(0)
    expect(res.costingRungs).toEqual({ provider: 0, rateCard: 0, carrier: 1, skipped: 0 })

    const rows = await rowsOf(INST_UNKNOWN_TYPE, 'req_reasoning')
    // TOKEN_TYPE_PRIORITY: 'input' is the carrier; the unknown type is present
    // with its tokens and zero cost — never silently folded into another type.
    expect(rows.map((r) => [r.token_type, r.cost_usd])).toEqual([
      ['input', '0.500000'],
      ['output', '0.000000'],
      ['reasoning', '0.000000'],
    ])
    expect(await totalOf(INST_UNKNOWN_TYPE, 'req_reasoning')).toBe('0.500000')
    for (const r of rows) {
      expect(r.cost_basis).toBe('provider-reported')
      expect(r.rate_card_id).toBeNull()
    }

    const [tokens] = await t.client<{ tokens: string }[]>`
      SELECT tokens::text AS tokens FROM attribution_record
      WHERE instance_id = ${INST_UNKNOWN_TYPE}::uuid AND token_type = 'reasoning'`
    expect(tokens!.tokens).toBe('50000')
  })

  it('an unknown token type leaves the estimate ABSENT on that row (the view then drops the span)', async () => {
    // Degrading to silence is the honest option: SUMming a partial estimate
    // would under-report it and manufacture drift out of nothing.
    const rows = await t.client<{ token_type: string; est: string | null }[]>`
      SELECT token_type, metadata->>'rate_card_cost_usd' AS est
      FROM attribution_record
      WHERE instance_id = ${INST_UNKNOWN_TYPE}::uuid AND source_run_id = 'req_reasoning'
      ORDER BY token_type`
    expect(rows.map((r) => [r.token_type, r.est])).toEqual([
      ['input', '3.000000'],
      ['output', '3.000000'],
      ['reasoning', null], // no rate line exists for it — nothing to record
    ])
  })

  it('re-running the joiner is idempotent and does not re-cost the span', async () => {
    const res = await runReadJoiner(
      t.db,
      reader(
        INST_SLICE,
        span({ tsEvent: '2026-05-10T10:00:00Z', sourceRunId: 'req_slice', lawCostUsd: 0.036 }, [
          ['input', 1_000_000],
          ['output', 200_000],
          ['cache-read', 5_000_000],
          ['cache-write', 400_000],
        ]),
      ),
      { sessionIds: [INST_SLICE] },
    )
    expect(res.attributionRowsWritten).toBe(0)
    // The span is still SEEN and still counted — the tally is per span
    // considered, not per row written.
    expect(res.costingRungs).toEqual({ provider: 1, rateCard: 0, carrier: 0, skipped: 0 })
    expect(await totalOf(INST_SLICE, 'req_slice')).toBe('0.036000')
  })

  it('an indivisible total still balances: the residue goes to the largest remainders', async () => {
    // 7 micro-dollars over three equal shares. Truncation gives 2/2/2 and leaves
    // a residue of 1, which cannot be dropped (the total would stop being the
    // provider's) and cannot go negative (shares are truncated, never rounded
    // up). Largest remainder decides — here all remainders tie, so
    // TOKEN_TYPE_PRIORITY breaks it and 'input' takes the extra micro. A fixed
    // always-last plug would push that micro onto the same column forever.
    const res = await runReadJoiner(
      t.db,
      reader(
        INST_RESIDUE,
        span({ tsEvent: '2026-05-10T10:01:00Z', sourceRunId: 'req_residue', lawCostUsd: 0.000_007 }, [
          ['input', 1_000_000],
          ['output', 200_000],
          ['cache-write', 800_000],
        ]),
      ),
      { sessionIds: [INST_RESIDUE] },
    )
    expect(res.attributionRowsWritten).toBe(3)
    expect(res.costingRungs).toEqual({ provider: 1, rateCard: 0, carrier: 0, skipped: 0 })

    const rows = await rowsOf(INST_RESIDUE, 'req_residue')
    expect(rows.map((r) => [r.token_type, r.cost_usd])).toEqual([
      ['cache-write', '0.000002'],
      ['input', '0.000003'],
      ['output', '0.000002'],
    ])
    expect(await totalOf(INST_RESIDUE, 'req_residue')).toBe('0.000007')
  })
  it('the carrier is the earliest PRESENT token type, not literally input', async () => {
    // If input_tokens == 0 the reader prunes the input row (reader.ts:401) and a
    // hardcoded 'input' carrier would lose the cost entirely.
    const res = await runReadJoiner(
      t.db,
      reader(
        INST_UNKNOWN_TYPE,
        span({ tsEvent: '2026-05-10T10:07:00Z', sourceRunId: 'req_no_input', lawCostUsd: 0.25 }, [
          ['cache-read', 900_000],
          ['output', 400],
          ['reasoning', 10],
        ]),
      ),
      { sessionIds: [INST_UNKNOWN_TYPE] },
    )
    expect(res.costingRungs).toEqual({ provider: 0, rateCard: 0, carrier: 1, skipped: 0 })
    const rows = await rowsOf(INST_UNKNOWN_TYPE, 'req_no_input')
    expect(rows.map((r) => [r.token_type, r.cost_usd])).toEqual([
      ['cache-read', '0.000000'],
      ['output', '0.250000'],
      ['reasoning', '0.000000'],
    ])
    expect(await totalOf(INST_UNKNOWN_TYPE, 'req_no_input')).toBe('0.250000')
  })

  it('no rate card in force at all: the provider figure still lands (it no longer skips)', async () => {
    // 2025-12-15 predates the seeded card's [2026-01-01, ...) window, so no card
    // resolves. Before this design that meant the span was DROPPED. Now the card
    // only decides the slice, so its absence degrades the breakdown, not the money.
    const res = await runReadJoiner(
      t.db,
      reader(
        INST_NO_CARD,
        span({ tsEvent: '2025-12-15T10:00:00Z', sourceRunId: 'req_precard', lawCostUsd: 0.0042 }, [
          ['input', 1_000],
          ['output', 500],
        ]),
      ),
      { sessionIds: [INST_NO_CARD] },
    )
    expect(res.attributionRowsWritten).toBe(2)
    expect(res.spansSkippedNoRateCard).toBe(0)
    expect(res.costingRungs).toEqual({ provider: 0, rateCard: 0, carrier: 1, skipped: 0 })
    expect(await totalOf(INST_NO_CARD, 'req_precard')).toBe('0.004200')

    // …and with NO provider cost, the same instant still skips (rung 3
    // unchanged: under-reporting beats a silent zero).
    const skipped = await runReadJoiner(
      t.db,
      reader(
        INST_NO_CARD,
        span({ tsEvent: '2025-12-15T10:01:00Z', sourceRunId: 'req_precard_nocost' }, [
          ['input', 1_000],
        ]),
      ),
      { sessionIds: [INST_NO_CARD] },
    )
    expect(skipped.attributionRowsWritten).toBe(0)
    expect(skipped.spansSkippedNoRateCard).toBe(1)
    expect(skipped.costingRungs).toEqual({ provider: 0, rateCard: 0, carrier: 0, skipped: 1 })
  })
})

describe("a span's rows are ALL-OR-NOTHING", () => {
  it('a half-written span survives a RATE-LINE EDIT and still books exactly the provider figure', async () => {
    /*
     * THE REAL TRIGGER, end to end.
     *
     * Pass 1 writes two of the span's three rows. An admin then edits a rate
     * line — an ordinary action, and the whole reason the card is allowed to
     * change. Pass 2 sees the full span and re-plans the SAME provider total
     * against the NEW weights.
     *
     * The two rows already on the ledger are frozen (COST-8) and re-inserted
     * with ON CONFLICT DO NOTHING, so they keep the amounts the OLD weights
     * gave them. If the third row were then sliced with the new weights, the
     * span would book more than the provider ever charged — silently, with both
     * halves individually defensible. What must happen instead is that the
     * joiner treats what is already booked as a fact: the provider's figure is
     * fully accounted for, so the arriving row is worth nothing more.
     */
    const TS = '2026-05-10T10:20:00Z'
    const first = await runReadJoiner(
      t.db,
      reader(
        INST_EDIT,
        span({ tsEvent: TS, sourceRunId: 'req_edit', lawCostUsd: 0.036 }, [
          ['input', 1_000_000], // $3.00 on the card
          ['output', 1_000_000], // $15.00 on the card  → shares 1:5
        ]),
      ),
      { sessionIds: [INST_EDIT] },
    )
    expect(first.attributionRowsWritten).toBe(2)
    expect(first.costingRungs).toEqual({ provider: 1, rateCard: 0, carrier: 0, skipped: 0 })
    expect(await totalOf(INST_EDIT, 'req_edit')).toBe('0.036000')

    // The edit: output drops from $15/1M to $1/1M. Every slice weight changes.
    await t.client.unsafe(
      `UPDATE rate_line SET unit_cost_usd = 1.00
         WHERE rate_card_id = '${EDIT_CARD}' AND unit = 'output'`,
    )

    const second = await runReadJoiner(
      t.db,
      reader(
        INST_EDIT,
        span({ tsEvent: TS, sourceRunId: 'req_edit', lawCostUsd: 0.036 }, [
          ['input', 1_000_000],
          ['output', 1_000_000],
          ['cache-read', 5_000_000], // $1.50 on the card — the newly-arriving row
        ]),
      ),
      { sessionIds: [INST_EDIT] },
    )
    // Only the third row is new; the first two dedup on the unique index.
    expect(second.attributionRowsWritten).toBe(1)

    const rows = await rowsOf(INST_EDIT, 'req_edit')
    expect(rows.map((r) => [r.token_type, r.cost_usd])).toEqual([
      // Untouched, from pass 1 under the OLD weights.
      ['cache-read', '0.000000'],
      ['input', '0.006000'],
      ['output', '0.030000'],
    ])
    // THE INVARIANT. Under the naive re-plan the arriving row would have taken
    // 0.036 x 1.50/5.50 = 0.009818 and the span would book 0.045818.
    expect(await totalOf(INST_EDIT, 'req_edit')).toBe('0.036000')

    // …and the drift view agrees, which is where an operator would see it.
    const [d] = await t.client<
      { booked_cost_usd: string; law_cost_usd: string; priced_by: string }[]
    >`
      SELECT booked_cost_usd::text AS booked_cost_usd,
             law_cost_usd::text    AS law_cost_usd,
             priced_by
        FROM v_cost_drift
       WHERE instance_id = ${INST_EDIT}::uuid AND span_key = 'req_edit'`
    expect(d!.priced_by).toBe('provider')
    expect(Number(d!.booked_cost_usd)).toBeCloseTo(0.036, 9)
    expect(Number(d!.law_cost_usd)).toBeCloseTo(0.036, 9)
    expect(Number(d!.booked_cost_usd)).toBe(Number(d!.law_cost_usd))
  })

  it('a row the DATABASE rejects rolls the WHOLE span back — no half-written span survives', async () => {
    // The failure the per-session try/catch was always able to produce: the
    // second row of the span is unwritable (tokens past bigint), so the INSERT
    // throws AFTER the first row has already been sent. Before the per-span
    // transaction the first row stayed committed and the span was permanently
    // half-written; now nothing lands and the next pass writes it coherently.
    const TS = '2026-05-10T10:21:00Z'
    const poisoned = await runReadJoiner(
      t.db,
      reader(
        INST_ROLLBACK,
        span({ tsEvent: TS, sourceRunId: 'req_rollback', lawCostUsd: 0.02 }, [
          ['input', 1_000_000],
          ['output', 1e30], // beyond bigint — Postgres rejects it
        ]),
      ),
      { sessionIds: [INST_ROLLBACK] },
    )
    // ING-6: the session is isolated and retried, not the whole tick aborted.
    expect(poisoned.errors).toBe(1)
    expect(poisoned.attributionRowsWritten).toBe(0)
    expect(await rowsOf(INST_ROLLBACK, 'req_rollback')).toEqual([])

    // The retry writes the span whole.
    const retried = await runReadJoiner(
      t.db,
      reader(
        INST_ROLLBACK,
        span({ tsEvent: TS, sourceRunId: 'req_rollback', lawCostUsd: 0.02 }, [
          ['input', 1_000_000],
          ['output', 1_000_000],
        ]),
      ),
      { sessionIds: [INST_ROLLBACK] },
    )
    expect(retried.errors).toBe(0)
    expect(retried.attributionRowsWritten).toBe(2)
    expect(await totalOf(INST_ROLLBACK, 'req_rollback')).toBe('0.020000')
  })

  it('a full replay of an already-written span is still a clean no-op', async () => {
    const res = await runReadJoiner(
      t.db,
      reader(
        INST_ROLLBACK,
        span({ tsEvent: '2026-05-10T10:21:00Z', sourceRunId: 'req_rollback', lawCostUsd: 0.02 }, [
          ['input', 1_000_000],
          ['output', 1_000_000],
        ]),
      ),
      { sessionIds: [INST_ROLLBACK] },
    )
    expect(res.attributionRowsWritten).toBe(0)
    expect(res.errors).toBe(0)
    expect(res.costingRungs).toEqual({ provider: 1, rateCard: 0, carrier: 0, skipped: 0 })
    expect(await totalOf(INST_ROLLBACK, 'req_rollback')).toBe('0.020000')
  })

  it('two records for the SAME (token type, model) are ONE row, and the split is not lost on the duplicate', async () => {
    /*
     * The reader does NOT guarantee at most one record per (span, token type,
     * model) — nothing dedups a retried OTLP export, the local collector returns
     * whatever the store holds, and with NUXT_COPILOT_NATIVE_OTEL on the reader
     * concatenates two queries' rows. Both records describe ONE ledger row (the
     * unique index), so the plan must allocate over the DEDUPED key: allocating
     * to both would hand a share to a row that collapses on the way in, and the
     * span would book SHORT of the provider's figure.
     */
    const TS = '2026-05-10T10:22:00Z'
    const res = await runReadJoiner(
      t.db,
      reader(INST_DUP, [
        ...span({ tsEvent: TS, sourceRunId: 'req_dup', lawCostUsd: 0.036 }, [
          ['input', 1_000_000],
          ['output', 1_000_000],
        ]),
        // The same api_request delivered twice — same span, same token type,
        // same model, a different token count.
        ...span({ tsEvent: TS, sourceRunId: 'req_dup', lawCostUsd: 0.036 }, [['input', 900_000]]),
      ]),
      { sessionIds: [INST_DUP] },
    )
    expect(res.attributionRowsWritten).toBe(2)
    expect(res.costingRungs).toEqual({ provider: 1, rateCard: 0, carrier: 0, skipped: 0 })
    const rows = await rowsOf(INST_DUP, 'req_dup')
    expect(rows.map((r) => r.token_type)).toEqual(['input', 'output'])
    expect(await totalOf(INST_DUP, 'req_dup')).toBe('0.036000')
  })

  it('the SURVIVING duplicate is deterministic — arrival order cannot change what is booked', async () => {
    /*
     * The cost was already order-independent (dedupeSpanRows takes the larger
     * estimate). The persisted ROW was not: duplicates share a unique key, the
     * first INSERT wins, and the KQL has no ORDER BY — so which duplicate's
     * `tokens` survived depended on the order Azure happened to return them.
     * A replay of the same span could therefore book the same cost against
     * DIFFERENT tokens, and rows are frozen (COST-8), so the disagreement would
     * be permanent and invisible.
     *
     * Same two records, opposite arrival orders, must land identically.
     */
    const TS = '2026-05-10T10:24:00Z'
    const seen: { tokens: string; cost: string }[] = []

    for (const [inst, first, second] of [
      [INST_ORDER_A, 1_000_000, 900_000],
      [INST_ORDER_B, 900_000, 1_000_000],
    ] as const) {
      await runReadJoiner(
        t.db,
        reader(inst, [
          ...span({ tsEvent: TS, sourceRunId: 'req_order', lawCostUsd: 0.036 }, [['input', first]]),
          ...span({ tsEvent: TS, sourceRunId: 'req_order', lawCostUsd: 0.036 }, [['input', second]]),
        ]),
        { sessionIds: [inst] },
      )
      const [row] = await t.client<{ tokens: string; cost: string }[]>`
        SELECT tokens::text AS tokens, cost_usd::text AS cost
          FROM attribution_record
         WHERE instance_id = ${inst}::uuid AND source_run_id = 'req_order'`
      seen.push(row!)
    }

    // Identical in BOTH directions — not merely "each run is self-consistent".
    expect(seen[0]).toEqual(seen[1])
    // And it is the larger duplicate that survives, matching the estimate
    // dedupeSpanRows picks: within one (tokenType, model) the rate is identical,
    // so larger tokens and larger estimate are the same record. Persisting one
    // duplicate's tokens beside the other's cost would be the subtle failure.
    expect(seen[0]!.tokens).toBe('1000000')
    expect(seen[0]!.cost).toBe('0.036000')
  })
})

describe('a provider figure the numeric(14,6) column cannot store', () => {
  it('falls to the rate card and ALERTS instead of throwing at the INSERT', async () => {
    /*
     * $1,000,000,000 for one api_request: a plausible upstream units bug (cost
     * reported in a smaller unit, a corrupted attribute). It passes every guard
     * the design deliberately keeps — it is finite, positive, well-formed — and
     * then cannot be stored: NUMERIC(14,6) tops out at 99,999,999.999999.
     *
     * Letting it reach the INSERT throws a numeric field overflow INSIDE the
     * per-session try/catch, which swallows it and retries the SAME session on
     * every following tick, where the same span throws again. One poisoned span
     * would durably stop attribution for that whole session — silently. So the
     * figure is rejected in the pure layer instead and takes the SAME path as
     * "the provider reported nothing": rung 2, plus the counter that is the
     * alert. This is a storability check, NOT the plausibility band the design
     * rejected — the healthy span in the same tick still records its own absurd
     * five-figure cost untouched.
     */
    const res = await runReadJoiner(
      t.db,
      reader(INST_OVERSIZE, [
        ...span({ tsEvent: '2026-05-10T10:30:00Z', sourceRunId: 'req_oversize', lawCostUsd: 1e9 }, [
          ['input', 1_000_000],
        ]),
        // Healthy span in the SAME tick: the poisoned one must not starve it.
        ...span({ tsEvent: '2026-05-10T10:31:00Z', sourceRunId: 'req_healthy', lawCostUsd: 0.01 }, [
          ['input', 1_000_000],
        ]),
        // The largest figure the column CAN hold is still taken at face value.
        ...span({ tsEvent: '2026-05-10T10:32:00Z', sourceRunId: 'req_ceiling', lawCostUsd: 99_999_999.999999 }, [
          ['input', 1_000_000],
        ]),
      ]),
      { sessionIds: [INST_OVERSIZE] },
    )
    // Nothing threw: the session is not wedged.
    expect(res.errors).toBe(0)
    expect(res.attributionRowsWritten).toBe(3)
    expect(res.costingRungs).toEqual({ provider: 2, rateCard: 1, carrier: 0, skipped: 0 })

    // The unstorable span: priced by the card, card pinned, cost_basis estimated
    // — indistinguishable from any other rung-2 span, which is the point.
    const oversize = await rowsOf(INST_OVERSIZE, 'req_oversize')
    expect(oversize[0]!.cost_usd).toBe('3.000000')
    expect(oversize[0]!.cost_basis).toBe('estimated')
    expect(oversize[0]!.rate_card_id).toBe(GLOBAL_CARD)

    expect(await totalOf(INST_OVERSIZE, 'req_healthy')).toBe('0.010000')
    expect(await totalOf(INST_OVERSIZE, 'req_ceiling')).toBe('99999999.999999')
  })

  it('re-running does NOT re-fail — the session keeps attributing on every tick', async () => {
    // The wedge this guards against is not the first failure, it is the SECOND
    // and every one after it. Replaying the identical poisoned span must be as
    // uneventful as replaying a healthy one.
    const res = await runReadJoiner(
      t.db,
      reader(
        INST_OVERSIZE,
        span({ tsEvent: '2026-05-10T10:30:00Z', sourceRunId: 'req_oversize', lawCostUsd: 1e9 }, [
          ['input', 1_000_000],
        ]),
      ),
      { sessionIds: [INST_OVERSIZE] },
    )
    expect(res.errors).toBe(0)
    expect(res.attributionRowsWritten).toBe(0)
    expect(await totalOf(INST_OVERSIZE, 'req_oversize')).toBe('3.000000')
  })
})

describe('the Copilot lane is untouched', () => {
  // Copilot is priced from AI credits and never used a rate card (design
  // §"Where cost comes from"), so it has no ladder, no slice and nothing to
  // reconcile. Its records stay INDEPENDENT single-statement inserts.
  const copilotSpan = (tokenType: string, tokens: number) => ({
    tokens,
    tokenType,
    model: 'gpt-5',
    tsEvent: '2026-05-10T10:40:00Z',
    sourceRunId: 'req_cop',
    nanoAiu: 9_111_525_000,
  })

  it('prices the span ONCE on the deterministic carrier, from nano_aiu, with no card pinned', async () => {
    const res = await runReadJoiner(
      t.db,
      // 'output' first on the wire: the carrier must still be 'input' (ING-5
      // fixed priority), not "whichever record arrived first".
      reader(INST_COPILOT, [copilotSpan('output', 1_000), copilotSpan('input', 5_000)]),
      { sessionIds: [INST_COPILOT] },
    )
    expect(res.attributionRowsWritten).toBe(2)
    // The Claude-lane ladder tally stays empty — Copilot has no rung to report.
    expect(res.costingRungs).toEqual({ provider: 0, rateCard: 0, carrier: 0, skipped: 0 })

    const rows = await rowsOf(INST_COPILOT, 'req_cop')
    expect(rows.map((r) => [r.token_type, r.cost_usd])).toEqual([
      ['input', '0.091115'], // 9.111525 credits x $0.01
      ['output', '0.000000'],
    ])
    for (const r of rows) {
      expect(r.rate_card_id).toBeNull()
      expect(r.cost_basis).toBe('telemetry-only')
    }
    expect(await totalOf(INST_COPILOT, 'req_cop')).toBe('0.091115')

    // credit_qty rides the same carrier row, once per span.
    const credits = await t.client<{ token_type: string; credit_qty: string | null }[]>`
      SELECT token_type, credit_qty::text AS credit_qty FROM attribution_record
      WHERE instance_id = ${INST_COPILOT}::uuid AND source_run_id = 'req_cop'
      ORDER BY token_type`
    expect(credits.map((c) => [c.token_type, c.credit_qty])).toEqual([
      ['input', '9.111525'],
      ['output', '0.000000'],
    ])
  })

  it('a replay is a clean no-op and never carries the cost a second time', async () => {
    const res = await runReadJoiner(
      t.db,
      reader(INST_COPILOT, [copilotSpan('input', 5_000), copilotSpan('output', 1_000)]),
      { sessionIds: [INST_COPILOT] },
    )
    expect(res.attributionRowsWritten).toBe(0)
    expect(await totalOf(INST_COPILOT, 'req_cop')).toBe('0.091115')
  })
})

describe('mixed traffic in one tick', () => {
  it('the rung tally partitions the spans it considered', async () => {
    // Three spans on one instance, one per rung, in a single call: the counts
    // are mutually exclusive and add up.
    const res = await runReadJoiner(
      t.db,
      reader(INST_NO_CARD, [
        // rung 1, sliced (inside the seeded card's window)
        ...span({ tsEvent: '2026-05-10T10:10:00Z', sourceRunId: 'req_mix_provider', lawCostUsd: 0.02 }, [
          ['input', 1_000_000],
          ['output', 1_000_000],
        ]),
        // rung 2 (no provider cost)
        ...span({ tsEvent: '2026-05-10T10:11:00Z', sourceRunId: 'req_mix_ratecard' }, [
          ['input', 1_000_000],
        ]),
        // rung 1, carrier (unknown token type)
        ...span({ tsEvent: '2026-05-10T10:12:00Z', sourceRunId: 'req_mix_carrier', lawCostUsd: 0.01 }, [
          ['reasoning', 10],
        ]),
      ]),
      { sessionIds: [INST_NO_CARD] },
    )
    expect(res.costingRungs).toEqual({ provider: 1, rateCard: 1, carrier: 1, skipped: 0 })
    expect(res.attributionRowsWritten).toBe(4)
    // input $3 : output $15 → 1:5 of $0.02.
    const sliced = await rowsOf(INST_NO_CARD, 'req_mix_provider')
    expect(sliced.map((r) => r.cost_usd)).toEqual(['0.003333', '0.016667'])
    expect(await totalOf(INST_NO_CARD, 'req_mix_provider')).toBe('0.020000')
    expect(await totalOf(INST_NO_CARD, 'req_mix_carrier')).toBe('0.010000')
    expect(await totalOf(INST_NO_CARD, 'req_mix_ratecard')).toBe('3.000000')
  })
})
