// @vitest-environment node
/*
 * The model-axis subtraction READ side — mig 0124's v_complete_usage fan-out
 * (docs/design/reporting-consolidation/07-model-axis-subtraction-build.md
 * D4 + D5), proven against a real Postgres. Covers the design's tests:
 *
 *   7  — view Σ per (teammate, day, tool) key = the arm-2 parent, exactly;
 *        the untagged worklist grain (one taggable item per fill day) is
 *        unchanged by the fan-out.
 *   8  — arm-3 remainder cases: fully-modelled surface day → NO NULL row;
 *        copilot-agent day → ONE 'provider-day-grain' row = the vtd total;
 *        Σ per key = vtd.usage_usd always.
 *   10 — sum-back: every drivers axis Σ = headline, model axis included, with
 *        named models + reason-typed remainders in the rows.
 *   18 — arm-3 overrun guard: facts summing ABOVE the vtd total → one
 *        unfanned 'provider-revision-drift' row; correcting the facts resumes
 *        the fan-out (self-healing).
 *   19 — count stability: untaggable_count counts KEYS, not view rows —
 *        identical before and after the fan-out on the same estate, asserted
 *        against a hand-computed key count.
 *   20 — remainder typing: one response carries github day-grain money AND an
 *        awaiting-detail key as DISTINCT reasons; the per-reason figures
 *        reconcile named + remainders = headline; an unknown reason still
 *        classifies as a remainder, never a category.
 *
 * Plus the 0125 token-remainder rule (the remainder row is emitted when the
 * COST remainder OR the TOKEN remainder is positive, each measure capped
 * independently): a cost-exact/token-short parent surfaces a $0 remainder row
 * carrying the missing tokens (arm 2 AND arm 3), and token totals are
 * conserved per key across the whole fixture — see the final describe.
 *
 * ORDER MATTERS in this file and is deliberate: the whole-estate drivers
 * assertions (10, 20) run BEFORE the overrun correction (18) and the
 * fan-out-arrival insert (19), both of which mutate the estate. Each expected
 * figure below is hand-computed from the seeds and commented at its site.
 *
 * Children are seeded exactly as the S1 writer stores them (mig 0123:
 * Σ children ≤ parent, gap reasons stamped on childless parents) — the writer
 * itself is proven by tests/integration/usage/unaccounted-model-split.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup } from '../helpers/usage-rollup'
import { fetchAcrossDrivers } from '../../../server/reporting/across-regions'
import { getUnallocatedSummary } from '../../../server/utils/me-queries'
import {
  PROVIDER_USAGE_MODEL_KEY,
  UNATTRIBUTED_MODEL_KEY,
  modelBucketKind,
} from '../../../shared/reports/model-attribution'

type Tx = PostgresJsDatabase<Record<string, unknown>>

let t: TestDb
let tx: Tx
let regionId = ''
let unitId = ''
let tmA = '' // conservation + reasons
let tmB = '' // arm-3 remainder cases
let tmC = '' // overrun guard
let tmD = '' // count stability
let tmE = '' // token-only shortfalls (0125) — seeded in OCTOBER, outside WIN,
//              so the whole-estate September drivers figures above stand

const WIN = { startIso: '2026-09-01T00:00:00.000Z', endIso: '2026-10-01T00:00:00.000Z' }

/** Per-key view sums for one teammate, api-reconciled or provider-usage arm. */
async function keySums(teammateId: string, provenance: string) {
  return [
    ...(await t.client<
      { tool: string; day: string; usd: string; tokens: string; rows: number }[]
    >`
      SELECT tool, ts_event::date::text AS day,
             SUM(cost_usd)::text AS usd, SUM(tokens)::text AS tokens, COUNT(*)::int AS rows
      FROM v_complete_usage
      WHERE teammate_id = ${teammateId}::uuid AND usage_provenance = ${provenance}
      GROUP BY tool, ts_event::date
      ORDER BY tool, day`),
  ]
}

beforeAll(async () => {
  t = await startTestDb()
  tx = t.db as unknown as Tx
  const c = t.client

  await c`INSERT INTO region (code, display_name) VALUES ('mas', 'Model Axis Region')`
  ;[{ id: regionId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='mas'`
  await c`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'mas'::ltree, 'mas-cc', 'MAS CC', 'practice', true)`
  ;[{ id: unitId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='mas-cc'`

  const mkTeammate = async (email: string) => {
    await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${regionId}::uuid, ${unitId}::uuid)`
    const [r] = await c<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  tmA = await mkTeammate('a@mas.test')
  tmB = await mkTeammate('b@mas.test')
  tmC = await mkTeammate('c@mas.test')
  tmD = await mkTeammate('d@mas.test')
  tmE = await mkTeammate('e@mas.test')

  /** A fill row, optionally reason-stamped, returning its id. */
  const fill = async (
    tm: string,
    day: string,
    tool: string,
    usd: number,
    tokens: number,
    gapReason: string | null,
  ) => {
    await c`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source, model_gap_reason)
      VALUES (${tm}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${day}::date, ${tool}, ${usd}, ${tokens}, 'api-reconciled', ${gapReason})`
    const [r] = await c<{ id: string }[]>`
      SELECT id::text AS id FROM unaccounted_usage
      WHERE teammate_id=${tm}::uuid AND day=${day}::date AND tool=${tool}`
    return r!.id
  }
  const child = async (uuId: string, model: string, usd: number, tokens: number) => {
    await c`INSERT INTO unaccounted_usage_model (unaccounted_usage_id, model, cost_usd, tokens)
      VALUES (${uuId}::uuid, ${model}, ${usd}, ${tokens})`
  }
  /** An ingest-only surface day (actual_spend → vtd → arm 3). */
  const surface = async (tm: string, day: string, tool: string, usd: number) => {
    await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
        region_id, org_unit_id, cost_owning_unit_id, dimension_source)
      VALUES (${tm}::uuid, ${day}::date, ${tool}, 1000, 1000, ${usd}, 'anthropic-analytics-api',
        ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid, 'ingest-snapshot')`
  }
  /** A provider COST fact at model grain (the arm-3 fan-out operand). */
  const fact = async (tm: string, day: string, tool: string, model: string, usd: number) => {
    await c`INSERT INTO provider_usage_fact
        (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES ('anthropic-analytics-api', 'anthropic', ${tm}::uuid, 'x@mas.test',
              ${day}::date, ${tool}, ${model}, 'tokens', ${usd},
              ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid)`
  }
  /** A provider TOKEN fact at model grain (cost_type NULL — measure
   *  exclusivity, 0118): the arm-3 fan-out's TOKEN operand. */
  const tokenFact = async (
    tm: string,
    day: string,
    tool: string,
    model: string,
    input: number,
    output: number,
  ) => {
    await c`INSERT INTO provider_usage_fact
        (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd,
         input_tokens, output_tokens, region_id, org_unit_id, cost_owning_unit_id)
      VALUES ('anthropic-analytics-api', 'anthropic', ${tm}::uuid, 'x@mas.test',
              ${day}::date, ${tool}, ${model}, NULL, NULL,
              ${input}, ${output}, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid)`
  }
  /** A copilot-agent day (reconciliation_record → vtd's github branch → arm 3). */
  const agentDay = async (tm: string, day: string, usd: number) => {
    await c`INSERT INTO reconciliation_record
        (teammate_id, provider, enterprise_ref, period_date, category, scope, region_id, org_unit_id,
         cost_owning_unit_id, actual_qty, actual_unit_type, actual_usd, otel_attributed_usd, delta_usd,
         spend_class, disposition, status)
      VALUES (${tm}::uuid, 'github', 'ent-mas', ${day}::date, 'copilot_coding_agent',
              'teammate', ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
              '10', 'ai-credits', ${String(usd)}, '0', ${String(usd)},
              'indicative', 'ingest_only', 'proposed')`
  }

  // ── tmA: every reason at once ──────────────────────────────────────────────
  // arm 1: a real OTel model, $40.
  const instA = randomUUID()
  await c`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, cost_owning_unit_id, project_code_hash, raw_project_code)
    VALUES (${instA}::uuid, 'oid-a@mas.test', ${tmA}::uuid, 'claude-code', ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid, 'h', 'P')`
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instA}::uuid, ${tmA}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
            'claude-code', 'claude-sonnet-4-6', 'input', 80000, 40, 'tier-1', 'estimated', '2026-09-05T00:00:00Z'::timestamptz, 'conv-mas-a')`
  // fill with children + $1 shortfall → 'unmodelled-provider-cost'.
  const fa1 = await fill(tmA, '2026-09-06', 'claude-code', 9, 18000, null)
  await child(fa1, 'claude-sonnet-4-6', 6, 12000)
  await child(fa1, 'claude-opus-4-6', 2, 4000)
  // childless github-money fill → 'provider-day-grain' (stamped by the writer).
  await fill(tmA, '2026-09-08', 'copilot-cli', 30, 0, 'provider-day-grain')
  // childless no-facts fill → 'awaiting-provider-detail'.
  await fill(tmA, '2026-09-09', 'claude-code', 5, 1000, 'awaiting-provider-detail')
  // a reason the classifier has never heard of → still a remainder (test 20).
  await fill(tmA, '2026-09-10', 'copilot-cli', 4, 0, 'mystery-reason')
  // arm 3, partially modelled: $17 day, $10 named → $7 'surface-remainder'.
  await surface(tmA, '2026-09-07', 'claude-ai', 17)
  await fact(tmA, '2026-09-07', 'claude-ai', 'claude-haiku-4-6', 10)
  // arm 3, github: a $13 copilot-agent day → whole-day 'provider-day-grain'.
  await agentDay(tmA, '2026-09-12', 13)

  // ── tmB: the arm-3 remainder cases (test 8) ────────────────────────────────
  // Fully modelled IN BOTH MEASURES: $17 day, facts $10 + $7, AND token facts
  // covering the day's 2000 vtd tokens exactly (0125: a cost-exact day whose
  // facts left tokens short would now correctly emit a $0 token-remainder row
  // — "fully modelled → NO NULL row" requires the tokens to be modelled too).
  await surface(tmB, '2026-09-05', 'claude-cowork', 17)
  await fact(tmB, '2026-09-05', 'claude-cowork', 'claude-haiku-4-6', 10)
  await fact(tmB, '2026-09-05', 'claude-cowork', 'claude-sonnet-4-6', 7)
  await tokenFact(tmB, '2026-09-05', 'claude-cowork', 'claude-haiku-4-6', 700, 500)
  await tokenFact(tmB, '2026-09-05', 'claude-cowork', 'claude-sonnet-4-6', 500, 300)
  // copilot-agent day $11 → one 'provider-day-grain' row = the vtd total.
  await agentDay(tmB, '2026-09-06', 11)

  // ── tmC: the overrun (test 18) — facts $8 above a $5 vtd day ───────────────
  await surface(tmC, '2026-09-05', 'claude-office', 5)
  await fact(tmC, '2026-09-05', 'claude-office', 'claude-opus-4-6', 8)

  // ── tmD: count stability (test 19) — two surface keys, facts arrive LATER ──
  await surface(tmD, '2026-09-05', 'claude-ai', 20)
  await surface(tmD, '2026-09-06', 'claude-slack', 6)
  // …and one fill day with children — the worklist grain probe (test 7's
  // second half): one taggable item however many view rows the key fans into.
  const fd1 = await fill(tmD, '2026-09-07', 'claude-code', 9, 18000, null)
  await child(fd1, 'claude-sonnet-4-6', 6, 12000)
  await child(fd1, 'claude-opus-4-6', 2, 4000)

  // ── tmE: token-only shortfalls (0125) — OCTOBER, outside the drivers WIN ───
  // arm 2: children cover the $10 EXACTLY but only 3000 of 5000 tokens → the
  // cost remainder is 0 and 0124's cost-only predicate dropped 2000 tokens;
  // 0125 emits a $0 remainder row carrying them.
  const fe1 = await fill(tmE, '2026-10-05', 'claude-code', 10, 5000, null)
  await child(fe1, 'claude-sonnet-4-6', 10, 3000)
  // arm 3: an $8 surface day whose cost fact covers the money exactly but
  // models none of the day's 2000 vtd tokens → same rule, same $0 row.
  await surface(tmE, '2026-10-06', 'claude-ai', 8)
  await fact(tmE, '2026-10-06', 'claude-ai', 'claude-haiku-4-6', 8)

  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

// ── Test 7 — conservation through the view, per key ──────────────────────────
describe('arm 2: view Σ per (teammate, day, tool) = the parent, exactly', () => {
  it('a fanned key sums back to its parent in money AND tokens', async () => {
    const keys = await keySums(tmA, 'api-reconciled')
    const fa1 = keys.find((k) => k.day === '2026-09-06')!
    expect(Number(fa1.usd)).toBeCloseTo(9, 6) // 6 + 2 + 1
    expect(Number(fa1.tokens)).toBe(18000) // 12000 + 4000 + 2000
    expect(fa1.rows).toBe(3) // two children + one remainder
  })

  it('childless parents surface once, whole, reason-typed — never dropped, never split', async () => {
    const keys = await keySums(tmA, 'api-reconciled')
    for (const [day, usd] of [
      ['2026-09-08', 30],
      ['2026-09-09', 5],
      ['2026-09-10', 4],
    ] as const) {
      const k = keys.find((x) => x.day === day)!
      expect(Number(k.usd)).toBeCloseTo(usd, 6)
      expect(k.rows).toBe(1)
    }
  })

  it('the untagged worklist grain is unchanged: ONE taggable item per fill day', async () => {
    // tmD's fill fans into 3 view rows; the needs-tagging queue still counts 1.
    const { unallocated } = await getUnallocatedSummary(
      tx,
      tmD,
      '2026-09-01T00:00:00.000Z',
      1000,
      '2026-09-30T00:00:00.000Z',
    )
    expect(unallocated.needs_tagging_days).toBe(1)
    expect(Number(unallocated.untagged_cost_usd)).toBeCloseTo(9, 2)
  })
})

// ── Test 8 — arm-3 remainder cases ───────────────────────────────────────────
describe('arm 3: observed fan-out with an exact remainder', () => {
  it('a fully-modelled surface day emits NO NULL-model row at all', async () => {
    const rows = [
      ...(await t.client<{ model: string | null; usd: string; reason: string | null }[]>`
        SELECT model, cost_usd::text AS usd, model_gap_reason AS reason
        FROM v_complete_usage
        WHERE teammate_id = ${tmB}::uuid AND tool = 'claude-cowork'
        ORDER BY model`),
    ]
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.model !== null)).toBe(true)
    expect(rows.find((r) => r.model === 'claude-haiku-4-6')!.usd).toBe('10.000000')
    expect(rows.find((r) => r.model === 'claude-sonnet-4-6')!.usd).toBe('7.000000')
  })

  it('a copilot-agent day is ONE provider-day-grain row equal to the vtd total', async () => {
    const rows = [
      ...(await t.client<{ model: string | null; usd: string; reason: string | null }[]>`
        SELECT model, cost_usd::text AS usd, model_gap_reason AS reason
        FROM v_complete_usage
        WHERE teammate_id = ${tmB}::uuid AND tool = 'copilot-agent'`),
    ]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.model).toBeNull()
    expect(rows[0]!.reason).toBe('provider-day-grain')
    expect(Number(rows[0]!.usd)).toBeCloseTo(11, 6)
  })

  it('arm-3 Σ per key ALWAYS equals vtd.usage_usd — every seeded key, both teammates', async () => {
    for (const tm of [tmA, tmB]) {
      const perKey = await keySums(tm, 'provider-usage')
      const vtd = [
        ...(await t.client<{ tool: string; day: string; usd: string }[]>`
          SELECT tool, day::text AS day, usage_usd::text AS usd
          FROM v_teammate_usage_daily
          WHERE teammate_id = ${tm}::uuid
            AND tool IN ('copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
                         'claude-chrome', 'claude-design', 'claude-slack', 'claude-other')`),
      ]
      expect(vtd.length).toBeGreaterThan(0)
      for (const v of vtd) {
        const k = perKey.find((x) => x.tool === v.tool && x.day === v.day)!
        expect(k, `${v.tool} ${v.day}`).toBeDefined()
        expect(Number(k.usd)).toBeCloseTo(Number(v.usd), 6)
      }
    }
  })
})

// ── Tests 10 + 20 — the drivers response, whole estate ───────────────────────
/*
 * HAND-COMPUTED estate (September, BEFORE test 18's correction and test 19's
 * fact arrival — file order is load-bearing):
 *   named:  claude-sonnet-4-6 40+6+7+6 = 59 · claude-haiku-4-6 10+10 = 20 ·
 *           claude-opus-4-6 2+2 = 4                                → Σ 83
 *   remainders:
 *     __null_model:unmodelled-provider-cost      1 + 1 (tmA + tmD)  =  2
 *     __null_model:provider-day-grain            30                 = 30
 *     __null_model:awaiting-provider-detail      5                  =  5
 *     __null_model:mystery-reason                4                  =  4
 *     __provider_usage_model:provider-day-grain  13 + 11            = 24
 *     __provider_usage_model:surface-remainder   7 + 20 + 6         = 33
 *     __provider_usage_model:provider-revision-drift 5 (tmC)        =  5
 *                                                                  → Σ 103
 *   headline 83 + 103 = 186.
 */
describe('drivers: sum-back holds on every axis, and every remainder is reason-typed', () => {
  it('test 10: Σ rows = headline on every axis, model included', async () => {
    for (const axis of ['model', 'teammate', 'surface', 'practice', 'project'] as const) {
      const d = await fetchAcrossDrivers(tx, WIN, axis)
      const sum = d.rows.reduce((a, r) => a + r.usd, 0)
      expect(sum, `axis=${axis}`).toBeCloseTo(d.headlineUsd, 6)
    }
  })

  it('test 20: distinct reasons ride distinct rows and reconcile to the headline', async () => {
    const d = await fetchAcrossDrivers(tx, WIN, 'model')
    expect(d.headlineUsd).toBeCloseTo(186, 6)

    const byKey = new Map(d.rows.map((r) => [r.key, r]))
    // github money and the transient gap are DIFFERENT reasons in ONE response…
    expect(byKey.get(`${UNATTRIBUTED_MODEL_KEY}:provider-day-grain`)!.usd).toBeCloseTo(30, 6)
    expect(byKey.get(`${UNATTRIBUTED_MODEL_KEY}:awaiting-provider-detail`)!.usd).toBeCloseTo(5, 6)
    // …and the same reason under the OTHER provenance is its own row too.
    expect(byKey.get(`${PROVIDER_USAGE_MODEL_KEY}:provider-day-grain`)!.usd).toBeCloseTo(24, 6)
    expect(byKey.get(`${PROVIDER_USAGE_MODEL_KEY}:surface-remainder`)!.usd).toBeCloseTo(33, 6)
    expect(byKey.get(`${UNATTRIBUTED_MODEL_KEY}:unmodelled-provider-cost`)!.usd).toBeCloseTo(2, 6)
    expect(byKey.get(`${PROVIDER_USAGE_MODEL_KEY}:provider-revision-drift`)!.usd).toBeCloseTo(5, 6)

    // The UNKNOWN reason is carried, keyed apart, and classifies as remainder —
    // never a category/model row (default-safe, D6).
    const mystery = byKey.get(`${UNATTRIBUTED_MODEL_KEY}:mystery-reason`)!
    expect(mystery.usd).toBeCloseTo(4, 6)
    expect(mystery.gap_reason).toBe('mystery-reason')
    expect(modelBucketKind(mystery.key)).toBe('remainder')

    // The FOOTER figures reconcile: named + Σ(remainders) = headline, and the
    // named set is exactly the model-classified rows.
    const named = d.rows.filter((r) => modelBucketKind(r.key) === 'model')
    const remainders = d.rows.filter((r) => modelBucketKind(r.key) === 'remainder')
    expect(named.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(83, 6)
    expect(remainders.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(103, 6)
    // Every remainder row carries a reason; every named row carries none.
    for (const r of remainders) expect(r.gap_reason, r.key).toBeTruthy()
    for (const r of named) expect(r.gap_reason).toBeUndefined()
    // Named figures spot-checked against the hand computation.
    expect(byKey.get('claude-sonnet-4-6')!.usd).toBeCloseTo(59, 6)
    expect(byKey.get('claude-haiku-4-6')!.usd).toBeCloseTo(20, 6)
    expect(byKey.get('claude-opus-4-6')!.usd).toBeCloseTo(4, 6)
  })
})

// ── Test 18 — the overrun guard, and its self-healing ────────────────────────
describe('arm 3 overrun: stale facts above the vtd total are never emitted', () => {
  it('facts Σ > vtd → ONE unfanned provider-revision-drift row at the vtd total', async () => {
    const rows = [
      ...(await t.client<{ model: string | null; usd: string; reason: string | null }[]>`
        SELECT model, cost_usd::text AS usd, model_gap_reason AS reason
        FROM v_complete_usage
        WHERE teammate_id = ${tmC}::uuid AND tool = 'claude-office'`),
    ]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.model).toBeNull()
    expect(rows[0]!.reason).toBe('provider-revision-drift')
    expect(Number(rows[0]!.usd)).toBeCloseTo(5, 6) // the AUTHORITATIVE total, not the $8 facts
  })

  it('correcting the facts resumes the fan-out — named row + typed remainder, Σ unchanged', async () => {
    await t.client`UPDATE provider_usage_fact SET cost_usd = 3
      WHERE teammate_id = ${tmC}::uuid AND tool = 'claude-office' AND model = 'claude-opus-4-6'`
    const rows = [
      ...(await t.client<{ model: string | null; usd: string; reason: string | null }[]>`
        SELECT model, cost_usd::text AS usd, model_gap_reason AS reason
        FROM v_complete_usage
        WHERE teammate_id = ${tmC}::uuid AND tool = 'claude-office'
        ORDER BY model NULLS LAST`),
    ]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.model).toBe('claude-opus-4-6')
    expect(Number(rows[0]!.usd)).toBeCloseTo(3, 6)
    expect(rows[1]!.model).toBeNull()
    expect(rows[1]!.reason).toBe('surface-remainder')
    expect(Number(rows[1]!.usd)).toBeCloseTo(2, 6)
    expect(rows.reduce((a, r) => a + Number(r.usd), 0)).toBeCloseTo(5, 6)
  })
})

// ── Test 19 — count stability across the fan-out ─────────────────────────────
describe('untaggable_count counts KEYS, not view rows', () => {
  const summary = () =>
    getUnallocatedSummary(tx, tmD, '2026-09-01T00:00:00.000Z', 1000, '2026-09-30T00:00:00.000Z')

  it('is the hand-computed key count before AND after the facts land', async () => {
    // BEFORE any fact: 2 provider-day keys (claude-ai 09-05, claude-slack
    // 09-06), one view row each.
    const before = await summary()
    expect(before.unallocated.untaggable_count).toBe(2)
    expect(Number(before.unallocated.untaggable_cost_usd)).toBeCloseTo(26, 2)

    // The facts land → the claude-ai key fans into haiku $12 + sonnet $5 +
    // remainder $3 (three view rows; the estate is otherwise unchanged).
    await t.client`INSERT INTO provider_usage_fact
        (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('anthropic-analytics-api', 'anthropic', ${tmD}::uuid, 'd@mas.test',
         '2026-09-05'::date, 'claude-ai', 'claude-haiku-4-6', 'tokens', 12,
         ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid),
        ('anthropic-analytics-api', 'anthropic', ${tmD}::uuid, 'd@mas.test',
         '2026-09-05'::date, 'claude-ai', 'claude-sonnet-4-6', 'tokens', 5,
         ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid)`

    // The key really did fan out (the invariance below is not vacuous)…
    const viewRows = await t.client`
      SELECT 1 FROM v_complete_usage
      WHERE teammate_id = ${tmD}::uuid AND tool = 'claude-ai' AND usage_provenance = 'provider-usage'`
    expect([...viewRows].length).toBe(3)

    // …and the item count and dollars did NOT move: still 2 keys, still $26.
    const after = await summary()
    expect(after.unallocated.untaggable_count).toBe(2)
    expect(Number(after.unallocated.untaggable_cost_usd)).toBeCloseTo(26, 2)
  })
})

// ── The 0125 token-remainder rule — conservation must not ride on cost ───────
/*
 * 0124 gated both remainder arms on the COST remainder alone, so a parent
 * whose children covered the money exactly but not the tokens silently
 * dropped the token shortfall. 0125's rule: emit the remainder row when the
 * cost remainder OR the token remainder is positive, each measure
 * GREATEST(0, …)-capped independently. Runs LAST deliberately: the estate is
 * in its final (post-correction, post-arrival) state, so the fixture-wide
 * conservation sweep covers every mutation the file made.
 */
describe('token remainders (mig 0125): a token-only shortfall reaches the remainder row', () => {
  it('arm 2: a cost-exact/token-short parent emits a $0 remainder row with the missing tokens', async () => {
    const rows = [
      ...(await t.client<{ model: string | null; usd: string; tokens: string; reason: string | null }[]>`
        SELECT model, cost_usd::text AS usd, tokens::text AS tokens, model_gap_reason AS reason
        FROM v_complete_usage
        WHERE teammate_id = ${tmE}::uuid AND tool = 'claude-code'
          AND usage_provenance = 'api-reconciled'
        ORDER BY model NULLS LAST`),
    ]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.model).toBe('claude-sonnet-4-6')
    expect(Number(rows[0]!.usd)).toBeCloseTo(10, 6)
    expect(Number(rows[0]!.tokens)).toBe(3000)
    // The remainder: $0 (children covered the money exactly, GREATEST-capped,
    // never negative) but the 2000 missing tokens surface instead of dropping.
    expect(rows[1]!.model).toBeNull()
    expect(Number(rows[1]!.usd)).toBe(0)
    expect(Number(rows[1]!.tokens)).toBe(2000)
    expect(rows[1]!.reason).toBe('unmodelled-provider-cost')
    // …so the key conserves BOTH measures against its parent.
    const key = (await keySums(tmE, 'api-reconciled')).find((k) => k.day === '2026-10-05')!
    expect(Number(key.usd)).toBeCloseTo(10, 6)
    expect(Number(key.tokens)).toBe(5000)
  })

  it('arm 3: a cost-exact surface day with unmodelled tokens emits the $0 token remainder', async () => {
    const rows = [
      ...(await t.client<{ model: string | null; usd: string; tokens: string; reason: string | null }[]>`
        SELECT model, cost_usd::text AS usd, tokens::text AS tokens, model_gap_reason AS reason
        FROM v_complete_usage
        WHERE teammate_id = ${tmE}::uuid AND tool = 'claude-ai'
        ORDER BY model NULLS LAST`),
    ]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.model).toBe('claude-haiku-4-6')
    expect(Number(rows[0]!.usd)).toBeCloseTo(8, 6) // the cost fact covers the day exactly
    expect(rows[1]!.model).toBeNull()
    expect(rows[1]!.reason).toBe('surface-remainder')
    expect(Number(rows[1]!.usd)).toBe(0)
    expect(Number(rows[1]!.tokens)).toBe(2000) // the vtd tokens no fact modelled
  })

  it('token totals are conserved per key across the WHOLE fixture, both arms', async () => {
    // Arm 2: every parent the view scopes in (cost_usd > 0, taggable tools)
    // must have Σ view tokens = parent tokens. Empty result = conserved.
    const arm2Mismatches = [
      ...(await t.client`
        SELECT uu.teammate_id::text AS tm, uu.day::text AS day, uu.tool,
               COALESCE(uu.tokens, 0)::bigint AS parent_tokens,
               COALESCE(v.sum_tokens, -1)::bigint AS view_tokens
        FROM unaccounted_usage uu
        LEFT JOIN (
          SELECT teammate_id, ts_event::date AS day, tool, SUM(tokens)::bigint AS sum_tokens
          FROM v_complete_usage
          WHERE usage_provenance = 'api-reconciled'
          GROUP BY teammate_id, ts_event::date, tool
        ) v ON v.teammate_id = uu.teammate_id AND v.day = uu.day AND v.tool = uu.tool
        WHERE uu.cost_usd > 0
          AND uu.tool NOT IN ('copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
                              'claude-chrome', 'claude-design', 'claude-slack', 'claude-other')
          AND COALESCE(v.sum_tokens, -1) <> COALESCE(uu.tokens, 0)`),
    ]
    expect(arm2Mismatches).toEqual([])

    // Arm 3: every vtd key the view scopes in must have Σ view tokens =
    // vtd.tokens (NULL ⇒ 0 — the copilot lane meters credits, not tokens).
    const arm3Mismatches = [
      ...(await t.client`
        SELECT vtd.teammate_id::text AS tm, vtd.day::text AS day, vtd.tool,
               COALESCE(vtd.tokens, 0)::bigint AS vtd_tokens,
               COALESCE(v.sum_tokens, -1)::bigint AS view_tokens
        FROM v_teammate_usage_daily vtd
        LEFT JOIN (
          SELECT teammate_id, ts_event::date AS day, tool, SUM(tokens)::bigint AS sum_tokens
          FROM v_complete_usage
          WHERE usage_provenance = 'provider-usage'
          GROUP BY teammate_id, ts_event::date, tool
        ) v ON v.teammate_id = vtd.teammate_id AND v.day = vtd.day AND v.tool = vtd.tool
        WHERE vtd.usage_usd > 0
          AND vtd.tool IN ('copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
                           'claude-chrome', 'claude-design', 'claude-slack', 'claude-other')
          AND COALESCE(v.sum_tokens, -1) <> COALESCE(vtd.tokens, 0)`),
    ]
    expect(arm3Mismatches).toEqual([])
  })
})
