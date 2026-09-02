// @vitest-environment node
/*
 * Migrations 0126 and 0135 are PERF-ONLY: v_complete_usage's output is
 * byte-identical to 0125's. This file is the committed half of that proof
 * (docs/design/reporting-consolidation/09-reports-performance-plan.md D3/D4;
 * docs/design/request-floor-performance.md for 0135; the fixture halves ran
 * pre-cut: EXCEPT ALL empty both directions over 23,699 rows for 0126 and
 * 24,717 for 0135).
 *
 * T1 — identity: the 0125 definition is rebuilt VERBATIM FROM ITS MIGRATION
 *      FILE under a scratch name, and `EXCEPT ALL` must be empty in BOTH
 *      directions over an estate that exercises every arm-3 edge the rewrite
 *      touches: multi-model key (the window partition itself), fully-fanned
 *      equality day (guard boundary: key_usd = vtd ⇒ fan-out, no remainder),
 *      shortfall remainder, cost-exact/token-short ($0 remainder carrying
 *      tokens, 0125's rule), overrun (facts > vtd ⇒ NO fan-out, whole-day
 *      'provider-revision-drift'), no-facts day, copilot-agent github day
 *      ('provider-day-grain'), facts-with-no-vtd-row (arm 3 emits nothing),
 *      plus arm-1/arm-2 rows and an api-uncorroborated quarantine exclusion
 *      riding along. Goes red if the rewrite's semantics drift (proven by
 *      mutation in the build: guard `<=`→`<` and a dropped partition column
 *      both fail here).
 *
 * T2 — plan-shape guard: the 0126/0135 SHAPE, asserted structurally so a
 *      revert to either predecessor cannot land silently:
 *        (a) WindowAgg present — 0125 has no window function;
 *        (b) ZERO CTE scans on any arm3 operand — 0135 declares them
 *            single-referenced NOT MATERIALIZED, so the planner inlines both
 *            (0125 materialized arm3_fact_key twice; 0126 materialized the
 *            shared arm3_fact_model — the fence that made every scan
 *            aggregate ALL of provider_usage_fact);
 *        (c) the three 0126 expression indexes AND 0134's two
 *            provider_usage_fact date indexes exist (reverting the index
 *            halves alone must fail too);
 *        (d) a GENEROUS wall-clock bound (5 s at this fixture's scale is
 *            ≥50x headroom — the regression signal is (a)/(b)/(e), not the
 *            clock);
 *        (e) 0135's reason for existing: a teammate-scoped read shows the
 *            teammate qual INSIDE the provider_usage_fact index condition —
 *            the pushdown the fence used to block. Reverting 0135's view
 *            body (re-fencing) fails this even with every index present.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'

let t: TestDb
let regionId = ''
let unitId = ''
let tmA = ''
let tmB = ''

beforeAll(async () => {
  t = await startTestDb()
  const c = t.client

  await c`INSERT INTO region (code, display_name) VALUES ('vri', 'View Rewrite Region')`
  ;[{ id: regionId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='vri'`
  await c`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'vri'::ltree, 'vri-cc', 'VRI CC', 'practice', true)`
  ;[{ id: unitId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='vri-cc'`

  const mkTeammate = async (email: string) => {
    await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${regionId}::uuid, ${unitId}::uuid)`
    const [r] = await c<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  tmA = await mkTeammate('a@vri.test')
  tmB = await mkTeammate('b@vri.test')

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
      VALUES ('anthropic-analytics-api', 'anthropic', ${tm}::uuid, 'x@vri.test',
              ${day}::date, ${tool}, ${model}, 'tokens', ${usd},
              ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid)`
  }
  /** A provider TOKEN fact (cost_type NULL — measure exclusivity, 0118). */
  const tokenFact = async (tm: string, day: string, tool: string, model: string, input: number, output: number) => {
    await c`INSERT INTO provider_usage_fact
        (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd,
         input_tokens, output_tokens, region_id, org_unit_id, cost_owning_unit_id)
      VALUES ('anthropic-analytics-api', 'anthropic', ${tm}::uuid, 'x@vri.test',
              ${day}::date, ${tool}, ${model}, NULL, NULL,
              ${input}, ${output}, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid)`
  }
  /** A copilot-agent day (reconciliation_record → vtd github branch → arm 3). */
  const agentDay = async (tm: string, day: string, usd: number) => {
    await c`INSERT INTO reconciliation_record
        (teammate_id, provider, enterprise_ref, period_date, category, scope, region_id, org_unit_id,
         cost_owning_unit_id, actual_qty, actual_unit_type, actual_usd, otel_attributed_usd, delta_usd,
         spend_class, disposition, status)
      VALUES (${tm}::uuid, 'github', 'ent-vri', ${day}::date, 'copilot_coding_agent',
              'teammate', ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
              '10', 'ai-credits', ${String(usd)}, '0', ${String(usd)},
              'indicative', 'ingest_only', 'proposed')`
  }
  const fill = async (tm: string, day: string, tool: string, usd: number, tokens: number, gapReason: string | null) => {
    await c`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source, model_gap_reason)
      VALUES (${tm}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${day}::date, ${tool}, ${usd}, ${tokens}, 'api-reconciled', ${gapReason})`
    const [r] = await c<{ id: string }[]>`
      SELECT id::text AS id FROM unaccounted_usage
      WHERE teammate_id=${tm}::uuid AND day=${day}::date AND tool=${tool}`
    return r!.id
  }

  // ── tmA: the arm-3 states the rewrite touches ─────────────────────────────
  // Multi-model + fully-fanned EQUALITY day (guard boundary key_usd = vtd,
  // both measures exact): fan-out only, no remainder row.
  await surface(tmA, '2026-09-05', 'claude-cowork', 17)
  await fact(tmA, '2026-09-05', 'claude-cowork', 'claude-haiku-4-6', 10)
  await fact(tmA, '2026-09-05', 'claude-cowork', 'claude-sonnet-4-6', 7)
  await tokenFact(tmA, '2026-09-05', 'claude-cowork', 'claude-haiku-4-6', 700, 500)
  await tokenFact(tmA, '2026-09-05', 'claude-cowork', 'claude-sonnet-4-6', 500, 300)
  // Shortfall: $17 day, $10 named → $7 'surface-remainder' + fan-out.
  await surface(tmA, '2026-09-06', 'claude-ai', 17)
  await fact(tmA, '2026-09-06', 'claude-ai', 'claude-haiku-4-6', 10)
  // A SECOND fact day on the SAME (teammate, tool): the window partition's
  // day column is load-bearing only when one (teammate, tool) spans several
  // days — without this, a partition missing `day` is invisible to the
  // identity proof (found by mutation in the build).
  await surface(tmA, '2026-09-10', 'claude-ai', 8)
  await fact(tmA, '2026-09-10', 'claude-ai', 'claude-haiku-4-6', 5)
  // Cost-exact / token-short: facts cover the $9 exactly, tokens fall 800
  // short of the 2000 vtd tokens → a $0 remainder row carrying the tokens.
  await surface(tmA, '2026-09-07', 'claude-office', 9)
  await fact(tmA, '2026-09-07', 'claude-office', 'claude-haiku-4-6', 9)
  await tokenFact(tmA, '2026-09-07', 'claude-office', 'claude-haiku-4-6', 800, 400)
  // No facts at all → whole-day 'surface-remainder'.
  await surface(tmA, '2026-09-08', 'claude-chrome', 6)
  // copilot-agent github day → whole-day 'provider-day-grain'.
  await agentDay(tmA, '2026-09-09', 13)

  // ── tmB: overrun + orphan facts + the taggable arms ───────────────────────
  // Overrun: facts $8 over a $5 day → NO fan-out, one 'provider-revision-drift'.
  await surface(tmB, '2026-09-05', 'claude-office', 5)
  await fact(tmB, '2026-09-05', 'claude-office', 'claude-haiku-4-6', 8)
  // Facts with NO vtd row → arm 3 emits nothing for the key.
  await fact(tmB, '2026-09-06', 'claude-slack', 'claude-haiku-4-6', 4)
  // Arm 1 + quarantine: one kept row, one api-uncorroborated exclusion.
  const inst = randomUUID()
  await c`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, cost_owning_unit_id, project_code_hash, raw_project_code)
    VALUES (${inst}::uuid, 'oid-b@vri.test', ${tmB}::uuid, 'claude-code', ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid, 'h', 'P')`
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${inst}::uuid, ${tmB}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
            'claude-code', 'claude-sonnet-4-6', 'input', 80000, 40, 'tier-1', 'estimated', '2026-09-05T00:00:00Z'::timestamptz, 'conv-vri-b')`
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${inst}::uuid, ${tmB}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
            'claude-code', 'claude-sonnet-4-6', 'input', 5000, 3, 'tier-1', 'estimated', '2026-09-06T00:00:00Z'::timestamptz, 'conv-vri-q')`
  await c`INSERT INTO session_quarantine
      (conversation_id, instance_id, teammate_id, region_id, org_unit_id, session_ts_start, session_ts_end, instance_ts_start, cost_usd, tokens, reason)
    VALUES ('conv-vri-q', ${inst}::uuid, ${tmB}::uuid, ${regionId}::uuid, ${unitId}::uuid,
            '2026-09-06T00:00:00Z'::timestamptz, '2026-09-06T01:00:00Z'::timestamptz,
            '2026-09-01T00:00:00Z'::timestamptz, 3, 5000, 'api-uncorroborated')`
  // Arm 2: children + shortfall remainder, and a token-only shortfall parent.
  const fb1 = await fill(tmB, '2026-09-07', 'claude-code', 9, 18000, null)
  await c`INSERT INTO unaccounted_usage_model (unaccounted_usage_id, model, cost_usd, tokens)
    VALUES (${fb1}::uuid, 'claude-sonnet-4-6', 6, 12000), (${fb1}::uuid, 'claude-opus-4-6', 2, 4000)`
  const fb2 = await fill(tmB, '2026-09-08', 'claude-code', 10, 5000, null)
  await c`INSERT INTO unaccounted_usage_model (unaccounted_usage_id, model, cost_usd, tokens)
    VALUES (${fb2}::uuid, 'claude-sonnet-4-6', 10, 3000)`

  // Rebuild the 0125 definition VERBATIM from its migration file, under a
  // scratch name — the comparison operand can never drift from what shipped.
  const src = await readFile(
    join(process.cwd(), 'drizzle/migrations/0125_complete_usage_token_remainder.sql'),
    'utf8',
  )
  const createStmt = src.slice(
    src.indexOf('CREATE OR REPLACE VIEW v_complete_usage'),
    src.indexOf('COMMENT ON VIEW'),
  )
  expect(createStmt.length).toBeGreaterThan(1000) // the slice found both markers
  await c.unsafe(
    createStmt.replace(
      'CREATE OR REPLACE VIEW v_complete_usage',
      'CREATE VIEW v_complete_usage_0125',
    ),
  )
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('T1 — 0126 ≡ 0125 (byte-identity by EXCEPT ALL, both directions)', () => {
  it('0126 minus 0125 is empty', async () => {
    const rows = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM (
        SELECT * FROM v_complete_usage
        EXCEPT ALL
        SELECT * FROM v_complete_usage_0125
      ) d`
    expect(rows[0]!.n).toBe(0)
  })

  it('0125 minus 0126 is empty', async () => {
    const rows = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM (
        SELECT * FROM v_complete_usage_0125
        EXCEPT ALL
        SELECT * FROM v_complete_usage
      ) d`
    expect(rows[0]!.n).toBe(0)
  })

  it('the estate actually exercises the arm-3 states (the proof has teeth)', async () => {
    // One row per state we claimed to plant — if a seed regresses, the
    // identity above would be comparing two views over a hollow estate.
    const reasons = await t.client<{ reason: string | null; n: number }[]>`
      SELECT model_gap_reason AS reason, COUNT(*)::int AS n
      FROM v_complete_usage
      WHERE usage_provenance = 'provider-usage'
      GROUP BY model_gap_reason ORDER BY reason NULLS FIRST`
    const byReason = Object.fromEntries(reasons.map((r) => [r.reason ?? 'null', r.n]))
    expect(byReason['null']).toBeGreaterThanOrEqual(4) // named fan-out rows
    expect(byReason['surface-remainder']).toBeGreaterThanOrEqual(2) // shortfall + no-facts
    expect(byReason['provider-day-grain']).toBe(1) // github day
    expect(byReason['provider-revision-drift']).toBe(1) // overrun
    // The cost-exact/token-short day: a $0 remainder row carrying tokens.
    const zeroDollar = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM v_complete_usage
      WHERE usage_provenance = 'provider-usage' AND cost_usd = 0 AND tokens > 0
        AND model_gap_reason = 'surface-remainder'`
    expect(zeroDollar[0]!.n).toBe(1)
    // Orphan facts (no vtd row) emit nothing.
    const orphan = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM v_complete_usage
      WHERE tool = 'claude-slack'`
    expect(orphan[0]!.n).toBe(0)
  })
})

describe('T2 — the 0126 plan shape cannot silently revert', () => {
  const planFor = async () => {
    const rows = await t.client<{ 'QUERY PLAN': string }[]>`
      EXPLAIN (COSTS OFF)
      SELECT SUM(cost_usd) FROM v_complete_usage
      WHERE ts_event >= '2026-09-01T00:00:00Z'::timestamptz
        AND ts_event <  '2026-10-01T00:00:00Z'::timestamptz`
    return rows.map((r) => r['QUERY PLAN']).join('\n')
  }

  it('arm 3a reads the window aggregate, not the fk×fm double CTE join', async () => {
    const plan = await planFor()
    // (a) the window carry exists — 0125's shape has no WindowAgg anywhere.
    expect(plan).toMatch(/WindowAgg/)
    // (b) NO arm-3 CTE is materialized (0135): both operands are
    // single-referenced NOT MATERIALIZED ⇒ inlined ⇒ zero CTE scans. 0126's
    // shared arm3_fact_model shows here as a `CTE Scan on arm3_fact_model`;
    // 0125's double-referenced arm3_fact_key as two `CTE Scan on
    // arm3_fact_key`. Either marker is a re-fencing revert.
    expect(plan).not.toMatch(/CTE Scan on arm3_fact/)
  })

  it('0135: a teammate-scoped read pushes the qual into provider_usage_fact', async () => {
    // The reason 0135 exists (docs/design/request-floor-performance.md): with
    // the fence down, the caller's teammate equality reaches the arm-3
    // aggregates and 0121's partial index serves them — per-teammate reads
    // stop aggregating the whole enterprise table. Re-fencing (a materialized
    // shared CTE) makes the qual stop at the CTE boundary and this goes red
    // even with every index in place.
    const rows = await t.client<{ 'QUERY PLAN': string }[]>`
      EXPLAIN (COSTS OFF)
      SELECT SUM(cost_usd) FROM v_complete_usage
      WHERE teammate_id = ${tmA}::uuid
        AND ts_event >= '2026-09-01T00:00:00Z'::timestamptz
        AND ts_event <  '2026-10-01T00:00:00Z'::timestamptz`
    const lines = rows.map((r) => r['QUERY PLAN'])
    // Every provider_usage_fact scan node must carry the teammate qual ON THE
    // SCAN ITSELF (Index Cond at real scale; Filter/Recheck at this estate's
    // tiny scale — the planner's access-method choice is cost-based and not
    // the point). A re-fenced revert scans the table UNQUALIFIED under the
    // materialized CTE and filters only above the aggregate, so no scan node
    // carries the qual and this goes red. On the fixture estate (24,717 rows)
    // the same plan shows Bitmap Index Scan on
    // provider_usage_fact_teammate_date_tool_idx with the qual as Index Cond.
    const scanIdx = lines
      .map((l, i) => (/(Scan (on|using) [^ ]*provider_usage_fact)/.test(l) ? i : -1))
      .filter((i) => i >= 0)
    expect(scanIdx.length).toBeGreaterThanOrEqual(2) // both arm-3 operands scan it
    for (const i of scanIdx) {
      const window = lines.slice(i, i + 4).join('\n')
      expect(window).toMatch(/teammate_id = /) // qual on the scan node
    }
  })

  it('the 0125 shape (the comparison operand) really does show the old markers', async () => {
    // Guards the guard: if PG's inlining rules ever change the fingerprint,
    // this fails loudly instead of the assertion above passing vacuously.
    const rows = await t.client<{ 'QUERY PLAN': string }[]>`
      EXPLAIN (COSTS OFF)
      SELECT SUM(cost_usd) FROM v_complete_usage_0125
      WHERE ts_event >= '2026-09-01T00:00:00Z'::timestamptz
        AND ts_event <  '2026-10-01T00:00:00Z'::timestamptz`
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(plan).not.toMatch(/WindowAgg/)
    expect(plan.match(/CTE Scan on arm3_fact_key/g)?.length ?? 0).toBe(2)
  })

  it('the three 0126 expression indexes exist with their exact expressions (r1-M3)', async () => {
    const rows = await t.client<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ('unaccounted_usage_day_utc_idx', 'actual_spend_date_utc_idx',
                          'reconciliation_record_period_date_utc_idx')
      ORDER BY indexname`
    expect(rows.map((r) => r.indexname)).toEqual([
      'actual_spend_date_utc_idx',
      'reconciliation_record_period_date_utc_idx',
      'unaccounted_usage_day_utc_idx',
    ])
    for (const r of rows) {
      expect(r.indexdef).toMatch(/::timestamp without time zone AT TIME ZONE 'UTC'::text/)
    }
  })

  it('the 0134 provider_usage_fact date indexes exist (the pushdown targets)', async () => {
    const rows = await t.client<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('provider_usage_fact_date_idx', 'provider_usage_fact_date_utc_idx')
      ORDER BY indexname`
    expect(rows.map((r) => r.indexname)).toEqual([
      'provider_usage_fact_date_idx',
      'provider_usage_fact_date_utc_idx',
    ])
  })

  it('a window-bounded scan completes inside a generous bound', async () => {
    const t0 = performance.now()
    await t.client`
      SELECT SUM(cost_usd) FROM v_complete_usage
      WHERE ts_event >= '2026-09-01T00:00:00Z'::timestamptz
        AND ts_event <  '2026-10-01T00:00:00Z'::timestamptz`
    expect(performance.now() - t0).toBeLessThan(5_000)
  })
})
