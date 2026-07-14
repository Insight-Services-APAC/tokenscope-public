// @vitest-environment node
/*
 * Session-granularity API layer (sprint design §3) — SQL-contract +
 * read-model integration tests.
 *
 *   - fetchBreakdownCells: breakdown sums re-add EXACTLY to the ledger
 *     totals (acceptance invariant 2) and are teammate-scoped (the
 *     cross-teammate denial that backs the [sid] 404)
 *   - fetchQuerySourceSplit: NULL lane stays separate (never folded to main)
 *   - export SQL contract: token-type FILTER sums + granularity=model rows
 *   - [sid] header contract: span_count = DISTINCT (ts_event, source_run_id)
 *   - finance attribution_pct: 'estimated' vocabulary yields a real ratio
 *     (the old 'rate-card' literal made it constant 0 — design §3.5)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import {
  fetchBreakdownCells,
  fetchQuerySourceSplit,
  pivotByModel,
  pivotByTokenType,
} from '../../../server/usage/breakdowns'

let t: TestDb
let devId: string
let otherId: string
let regionId: string
let orgUnitId: string
let projectId: string
const INSTANCE = randomUUID()
const CONV = 'conv-gran-api-1'

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db.insert(schema.region).values({ code: 'apac-g', displayName: 'APAC' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'apac.gran', code: 'gran', displayName: 'Gran', unitType: 'bu' })
    .returning()
  orgUnitId = bu!.id
  const [dev] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-dev-g', email: 'dev.gran@example.com', regionId, orgUnitId })
    .returning()
  devId = dev!.id
  const [other] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-other-g', email: 'other.gran@example.com', regionId, orgUnitId })
    .returning()
  otherId = other!.id
  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: 'GRN-API',
      codeHash: 'h-grn-api',
      displayName: 'Granularity API',
      type: 'billable',
      regionId,
      costOwningUnitId: orgUnitId,
    })
    .returning()
  projectId = proj!.id

  await t.db.insert(schema.instanceAttestation).values({
    instanceId: INSTANCE,
    principalOid: 'oid-dev-g',
    teammateId: devId,
    projectCodeHash: 'h-grn-api',
    rawProjectCode: 'GRN-API',
    tool: 'claude-code',
    sessionTokenHash: 'tok-gran-' + INSTANCE,
    tsStart: new Date('2026-06-01T09:00:00Z'),
    regionId,
    orgUnitId,
    costOwningUnitId: orgUnitId,
  })

  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)

  // One conversation, two spans:
  //   span A (req_a, main, Fable): all four token types, tier-1/estimated
  //   span B (req_b, generate_session_title, Haiku): input+output,
  //     tier-2/telemetry-only, NULL query_source on one row (legacy shape)
  const baseRow = {
    instanceId: INSTANCE,
    claudeSessionId: CONV,
    teammateId: devId,
    projectId,
    regionId,
    orgUnitId,
    costOwningUnitId: orgUnitId,
    tool: 'claude-code',
    rateCardId: rc!.id,
    rateCardVersion: rc!.version,
  }
  const spanA = new Date('2026-06-01T09:10:00Z')
  const spanB = new Date('2026-06-01T09:11:00Z')
  const rows = [
    { model: 'claude-fable-5', tokenType: 'input', tokens: 80_000n, costUsd: '0.240000', q: 'main', ts: spanA, run: 'req_a', tier: 'tier-1', basis: 'estimated' },
    { model: 'claude-fable-5', tokenType: 'output', tokens: 20_000n, costUsd: '0.300000', q: 'main', ts: spanA, run: 'req_a', tier: 'tier-1', basis: 'estimated' },
    { model: 'claude-fable-5', tokenType: 'cache-read', tokens: 1_200_000n, costUsd: '0.360000', q: 'main', ts: spanA, run: 'req_a', tier: 'tier-1', basis: 'estimated' },
    { model: 'claude-fable-5', tokenType: 'cache-write', tokens: 100_000n, costUsd: '0.376000', q: 'main', ts: spanA, run: 'req_a', tier: 'tier-1', basis: 'estimated' },
    { model: 'claude-haiku-4-5', tokenType: 'input', tokens: 5_000n, costUsd: '0.005000', q: 'generate_session_title', ts: spanB, run: 'req_b', tier: 'tier-2', basis: 'telemetry-only' },
    { model: 'claude-haiku-4-5', tokenType: 'output', tokens: 1_000n, costUsd: '0.004000', q: null, ts: spanB, run: 'req_b', tier: 'tier-2', basis: 'telemetry-only' },
  ]
  for (const r of rows) {
    await t.db.insert(schema.attributionRecord).values({
      ...baseRow,
      model: r.model,
      tokenType: r.tokenType,
      tokens: r.tokens,
      costUsd: r.costUsd,
      querySource: r.q,
      fidelityTier: r.tier,
      costBasis: r.basis,
      tsEvent: r.ts,
      sourceRunId: r.run,
    })
  }
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('usage read-model (DB layer)', () => {
  it('breakdown sums re-add EXACTLY to the ledger totals (invariant 2)', async () => {
    const cells = await fetchBreakdownCells(t.db, devId, [CONV])
    const byModel = pivotByModel(cells)
    const byType = pivotByTokenType(cells)

    const [ledger] = await t.client<{ tokens: string; cost: string }[]>`
      SELECT SUM(tokens)::text AS tokens, SUM(cost_usd)::text AS cost
      FROM attribution_record
      WHERE teammate_id = ${devId}::uuid
        AND COALESCE(claude_session_id, instance_id::text) = ${CONV}
    `
    const sumTokens = (xs: { tokens: number }[]) => xs.reduce((a, x) => a + x.tokens, 0)
    expect(sumTokens(byModel)).toBe(Number(ledger!.tokens))
    expect(sumTokens(byType)).toBe(Number(ledger!.tokens))
    const cellCost = cells.reduce((a, c) => a + c.cost_usd, 0)
    expect(cellCost).toBeCloseTo(Number(ledger!.cost), 6)

    // Dominant model by cost share = Fable (the chip contract).
    expect(byModel[0]!.model).toBe('claude-fable-5')
    // Advisory share = the two tier-2 rows.
    const tier2 = cells.reduce((a, c) => a + c.tier2_cost_usd, 0)
    expect(tier2).toBeCloseTo(0.009, 6)
  })

  it('teammate scoping: another teammate gets NO cells for the same conversation id (the [sid] 404 backing)', async () => {
    const cells = await fetchBreakdownCells(t.db, otherId, [CONV])
    expect(cells).toEqual([])
  })

  it('query-source split keeps the NULL lane separate from main', async () => {
    const split = await fetchQuerySourceSplit(t.db, devId, CONV)
    const lanes = new Map(split.map((s) => [s.query_source, s]))
    expect(lanes.get('main')!.tokens).toBe(1_400_000)
    expect(lanes.get('generate_session_title')!.tokens).toBe(5_000)
    expect(lanes.get(null)!.tokens).toBe(1_000)
  })
})

describe('endpoint SQL contracts', () => {
  it('[sid] header: span_count counts DISTINCT (ts_event, source_run_id)', async () => {
    const [row] = await t.client<{ record_count: string; span_count: string }[]>`
      SELECT COUNT(*)::text AS record_count,
             COUNT(DISTINCT (ts_event, COALESCE(source_run_id, '')))::text AS span_count
      FROM attribution_record
      WHERE teammate_id = ${devId}::uuid
        AND COALESCE(claude_session_id, instance_id::text) = ${CONV}
    `
    expect(Number(row!.record_count)).toBe(6)
    expect(Number(row!.span_count)).toBe(2)
  })

  it('export (default): token-type FILTER sums + semicolon model list per conversation', async () => {
    const rows = await t.client<Record<string, string>[]>`
      SELECT
        COALESCE(ar.claude_session_id, ar.instance_id::text) AS conversation_id,
        string_agg(DISTINCT ar.model, ';' ORDER BY ar.model) AS models,
        SUM(ar.tokens)::text AS tokens,
        COALESCE(SUM(ar.tokens) FILTER (WHERE ar.token_type = 'input'), 0)::text AS input_tokens,
        COALESCE(SUM(ar.tokens) FILTER (WHERE ar.token_type = 'output'), 0)::text AS output_tokens,
        COALESCE(SUM(ar.tokens) FILTER (WHERE ar.token_type = 'cache-read'), 0)::text AS cache_read_tokens,
        COALESCE(SUM(ar.tokens) FILTER (WHERE ar.token_type = 'cache-write'), 0)::text AS cache_write_tokens
      FROM attribution_record ar
      WHERE ar.teammate_id = ${devId}::uuid
      GROUP BY COALESCE(ar.claude_session_id, ar.instance_id::text)
    `
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.models).toBe('claude-fable-5;claude-haiku-4-5')
    expect(Number(r.input_tokens)).toBe(85_000)
    expect(Number(r.output_tokens)).toBe(21_000)
    expect(Number(r.cache_read_tokens)).toBe(1_200_000)
    expect(Number(r.cache_write_tokens)).toBe(100_000)
    // Type columns re-add to the total (invariant 2 for the CSV).
    expect(
      Number(r.input_tokens) + Number(r.output_tokens) +
        Number(r.cache_read_tokens) + Number(r.cache_write_tokens),
    ).toBe(Number(r.tokens))
  })

  it('export (granularity=model): one row per conversation × model', async () => {
    const rows = await t.client<Record<string, string>[]>`
      SELECT
        COALESCE(ar.claude_session_id, ar.instance_id::text) AS conversation_id,
        ar.model,
        SUM(ar.tokens)::text AS tokens
      FROM attribution_record ar
      WHERE ar.teammate_id = ${devId}::uuid
      GROUP BY COALESCE(ar.claude_session_id, ar.instance_id::text), ar.model
      ORDER BY ar.model
    `
    expect(rows).toHaveLength(2)
    expect(rows[0]!.model).toBe('claude-fable-5')
    expect(Number(rows[0]!.tokens)).toBe(1_400_000)
    expect(rows[1]!.model).toBe('claude-haiku-4-5')
    expect(Number(rows[1]!.tokens)).toBe(6_000)
  })

  it("finance attribution_pct: 'estimated' vocabulary yields the real estimated share (was constant 0)", async () => {
    const rows = await t.client<{ cou_id: string; attribution_pct: string }[]>`
      SELECT cost_owning_unit_id::text AS cou_id,
             (CASE WHEN SUM(cost_usd) > 0
               THEN SUM(CASE WHEN cost_basis = 'estimated' THEN cost_usd ELSE 0 END) / SUM(cost_usd)
               ELSE 0 END)::text AS attribution_pct
      FROM attribution_record
      WHERE cost_basis <> 'telemetry-only'
        AND cost_owning_unit_id IS NOT NULL
        AND teammate_id = ${devId}::uuid
      GROUP BY cost_owning_unit_id
    `
    expect(rows).toHaveLength(1)
    // The telemetry-only rows are excluded by the WHERE (matching the money
    // view); everything remaining is 'estimated' → ratio 1.
    expect(Number(rows[0]!.attribution_pct)).toBeCloseTo(1, 6)
  })
})
