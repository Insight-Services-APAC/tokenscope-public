// @vitest-environment node
/*
 * Migration 0082 — the extended v_complete_usage. Testcontainers Postgres runs ALL
 * migrations (incl. 0082), then a seeded fixture proves:
 *   - existing-column semantics are UNCHANGED (cost_usd sums identically vs the raw
 *     source tables) — appending (model, token_type) moves no money;
 *   - the attribution branch carries the REAL model/token_type; the unaccounted
 *     branch carries NULL model + 'unknown' token_type (the explicit "unattributed"
 *     bar), and model drivers SUM BACK through that NULL bucket to the headline;
 *   - the quarantined-telemetry exclusion is folded in: a dev-confirmed forgery
 *     (session_quarantine reason='api-uncorroborated', open) is EXCLUDED, while the
 *     informational 'no-covering-heartbeat' coverage flag is NOT (mirrors me-queries).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'

let t: TestDb
let regionId = ''
let unitId = ''
let teammateId = ''
let instanceId = ''

beforeAll(async () => {
  t = await startTestDb()

  await t.client`INSERT INTO region (code, display_name) VALUES ('cu', 'Complete-Usage Region')`
  ;[{ id: regionId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='cu'`

  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'cu'::ltree, 'cu', 'CU', 'practice', true)`
  ;[{ id: unitId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='cu'`

  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
    VALUES ('oid-cu', 'cu@x.test', 'CU', ${regionId}::uuid, ${unitId}::uuid)`
  ;[{ id: teammateId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='cu@x.test'`

  await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${regionId}::uuid, ${unitId}::uuid, 'h', 'P')`
  ;[{ id: instanceId }] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid LIMIT 1`

  const ar = async (model: string, tokenType: string, cost: number, conv: string) => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${instanceId}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${unitId}::uuid,
              'claude-code', ${model}, ${tokenType}, 1000, ${cost}, 'tier-1', 'estimated', now(), ${conv})`
  }
  // Legit attribution rows (real model/token_type).
  await ar('claude-sonnet-4-6', 'input', 10, 'conv-legit')
  await ar('claude-opus-4-6', 'output', 5, 'conv-legit')
  // A dev-CONFIRMED forgery → excluded from usage.
  await ar('claude-sonnet-4-6', 'input', 999, 'conv-forged')
  // A merely coverage-flagged session → NOT a usage exclusion (only api-uncorroborated is).
  await ar('claude-haiku-4-6', 'input', 7, 'conv-heartbeat')

  const quarantine = async (conv: string, reason: string) => {
    await t.client`INSERT INTO session_quarantine
        (conversation_id, instance_id, teammate_id, region_id, org_unit_id, session_ts_start, session_ts_end, instance_ts_start, reason)
      VALUES (${conv}, ${instanceId}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${unitId}::uuid,
              now(), now(), now(), ${reason})`
  }
  await quarantine('conv-forged', 'api-uncorroborated') // excluded
  await quarantine('conv-heartbeat', 'no-covering-heartbeat') // NOT excluded

  // Unaccounted (API−OTel gap): no model split. cost>0 lands; cost=0 is filtered.
  await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${teammateId}::uuid, ${regionId}::uuid, ${unitId}::uuid, DATE '2026-06-10', 'copilot-cli', 30, 0, 'api-reconciled')`
  await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${teammateId}::uuid, ${regionId}::uuid, ${unitId}::uuid, DATE '2026-06-11', 'copilot-cli', 0, 0, 'api-reconciled')`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('migration 0082 — extended v_complete_usage', () => {
  it('sums existing columns IDENTICALLY to the raw source tables (appended cols move no money)', async () => {
    const [view] = await t.client<{ total: string; rows: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total, COUNT(*)::text AS rows FROM v_complete_usage`
    // legit 10 + 5, heartbeat 7 (NOT excluded), unaccounted 30 (cost>0). forged 999 + zero-cost 0 dropped.
    expect(Number(view!.total)).toBe(52)

    // Same figure computed straight from the source tables with the same predicates.
    const [src] = await t.client<{ total: string }[]>`
      SELECT (
        (SELECT COALESCE(SUM(cost_usd),0) FROM attribution_record ar
          WHERE NOT EXISTS (
            SELECT 1 FROM session_quarantine sq
            WHERE sq.teammate_id = ar.teammate_id AND sq.conversation_id = ar.claude_session_id
              AND sq.resolved_at IS NULL AND sq.reason = 'api-uncorroborated'))
        + (SELECT COALESCE(SUM(cost_usd),0) FROM unaccounted_usage WHERE cost_usd > 0)
      )::text AS total`
    expect(Number(src!.total)).toBe(Number(view!.total))
  })

  it('the dev-confirmed forgery (api-uncorroborated) is EXCLUDED', async () => {
    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM v_complete_usage WHERE cost_usd = 999`
    expect(Number(n)).toBe(0)
  })

  it('a RESOLVED forgery stops excluding spend (resolved_at gate)', async () => {
    // The exclusion is scoped to OPEN quarantine rows. Without the
    // `resolved_at IS NULL` gate, resolving a forgery claim would leave its spend
    // excluded FOREVER — the dev could never get wrongly-disowned spend back, and
    // heartbeat-coverage's auto-resolve path (which clears rows once a session is
    // covered again) would silently never restore anything.
    const conv = 'conv-resolved-forgery'
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${instanceId}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${unitId}::uuid,
              'claude-code', 'claude-sonnet-4-6', 'input', 1000, 42, 'tier-1', 'estimated', now(), ${conv})`
    await t.client`INSERT INTO session_quarantine
        (conversation_id, instance_id, teammate_id, region_id, org_unit_id, session_ts_start, session_ts_end, instance_ts_start, reason, resolved_at)
      VALUES (${conv}, ${instanceId}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${unitId}::uuid,
              now(), now(), now(), 'api-uncorroborated', now())`

    const rows = await t.client<{ c: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS c FROM v_complete_usage
       WHERE teammate_id = ${teammateId}::uuid AND cost_usd = 42`
    expect(Number(rows[0]!.c)).toBe(42) // resolved => the spend is BACK
  })

  it("the informational 'no-covering-heartbeat' flag is NOT a usage exclusion (mirrors me-queries)", async () => {
    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM v_complete_usage WHERE cost_usd = 7`
    expect(Number(n)).toBe(1)
  })

  it('attribution rows carry the real model; the API gap carries NULL model + unknown token_type', async () => {
    const models = await t.client<{ model: string | null; token_type: string }[]>`
      SELECT DISTINCT model, token_type FROM v_complete_usage ORDER BY model NULLS LAST`
    // real models present
    expect(models.map((m) => m.model)).toEqual(
      expect.arrayContaining(['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-6']),
    )
    // the unaccounted bar: NULL model, 'unknown' token_type
    const nullBar = models.find((m) => m.model === null)
    expect(nullBar).toBeDefined()
    expect(nullBar!.token_type).toBe('unknown')

    const [{ n, gap }] = await t.client<{ n: string; gap: string }[]>`
      SELECT COUNT(*)::text AS n, COALESCE(SUM(cost_usd),0)::text AS gap
      FROM v_complete_usage WHERE model IS NULL`
    expect(Number(n)).toBe(1) // exactly the one unaccounted row (cost>0)
    expect(Number(gap)).toBe(30)
  })

  it('model drivers SUM BACK to the headline, incl. the NULL-model bucket', async () => {
    const groups = await t.client<{ model: string | null; usd: string }[]>`
      SELECT model, SUM(cost_usd)::text AS usd FROM v_complete_usage GROUP BY model`
    const groupTotal = groups.reduce((a, g) => a + Number(g.usd), 0)
    const [{ total }] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd),0)::text AS total FROM v_complete_usage`
    expect(groupTotal).toBe(Number(total)) // Σ model groups (incl NULL) = headline
    expect(groups.some((g) => g.model === null && Number(g.usd) === 30)).toBe(true)
  })

  it('the reporting-scan indexes exist', async () => {
    const idx = await t.client<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE indexname IN ('actual_spend_date_idx', 'unaccounted_usage_day_idx')`
    expect(idx.map((r) => r.indexname).sort()).toEqual([
      'actual_spend_date_idx',
      'unaccounted_usage_day_idx',
    ])
  })
})

// ── Migration 0101 (Workstream A, §3.1 A3) — the ingest-only completeness arm ──
describe('migration 0101 — v_complete_usage third arm (ingest-only completeness)', () => {
  let regionId2 = ''
  let unitId2 = ''
  let unhomedUnitId = ''
  let teammateId2 = ''
  let unhomedTeammateId = ''

  beforeAll(async () => {
    await t.client`INSERT INTO region (code, display_name) VALUES ('cu3', 'Complete-Usage Arm3 Region')`
    ;[{ id: regionId2 }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='cu3'`

    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId2}::uuid, 'cu3'::ltree, 'cu3', 'CU3', 'practice', true)`
    ;[{ id: unitId2 }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='cu3'`

    // A NON-cost-owning unit, so a teammate homed here has NO cost-owning
    // ancestor at all — the explicit unallocated bucket (R1-M8).
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId2}::uuid, 'cu3.unhomed'::ltree, 'cu3-unhomed', 'CU3 Unhomed', 'bu', false)`
    ;[{ id: unhomedUnitId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='cu3-unhomed'`

    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
      VALUES ('oid-cu3', 'cu3@x.test', 'CU3', ${regionId2}::uuid, ${unitId2}::uuid)`
    ;[{ id: teammateId2 }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='cu3@x.test'`

    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
      VALUES ('oid-cu3-unhomed', 'cu3-unhomed@x.test', 'CU3 Unhomed', ${regionId2}::uuid, ${unhomedUnitId}::uuid)`
    ;[{ id: unhomedTeammateId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='cu3-unhomed@x.test'`
  }, 60_000)

  it('a non-Code Claude actual_spend row reaches v_complete_usage through arm 3, with the dimension snapshot and provenance carried through', async () => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
        region_id, org_unit_id, cost_owning_unit_id, dimension_source)
      VALUES (${teammateId2}::uuid, '2026-06-12'::date, 'claude-ai', 1000, 1000, 25, 'anthropic-analytics-api',
        ${regionId2}::uuid, ${unitId2}::uuid, ${unitId2}::uuid, 'ingest-snapshot')`

    const rows = await t.client<{
      cost: string
      model: string | null
      token_type: string
      identity_state: string
      provenance: string
      project_id: string | null
      region_id: string
      org_unit_id: string
      cost_owning_unit_id: string | null
    }[]>`
      SELECT cost_usd::text AS cost, model, token_type, identity_state,
             usage_provenance AS provenance, project_id::text AS project_id,
             region_id::text AS region_id, org_unit_id::text AS org_unit_id,
             cost_owning_unit_id::text AS cost_owning_unit_id
      FROM v_complete_usage WHERE teammate_id = ${teammateId2}::uuid AND tool = 'claude-ai'`
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(Number(row.cost)).toBe(25)
    expect(row.model).toBeNull()
    expect(row.token_type).toBe('unknown')
    expect(row.identity_state).toBe('confirmed')
    expect(row.provenance).toBe('provider-usage')
    expect(row.project_id).toBeNull()
    expect(row.region_id).toBe(regionId2)
    expect(row.org_unit_id).toBe(unitId2)
    expect(row.cost_owning_unit_id).toBe(unitId2) // homed, since cu3 is itself cost-owning
  })

  it('an UNHOMED teammate\'s ingest-only usage is RETAINED in v_complete_usage with cost_owning_unit_id NULL (R1-M8) — never silently dropped', async () => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
        region_id, org_unit_id, cost_owning_unit_id, dimension_source)
      VALUES (${unhomedTeammateId}::uuid, '2026-06-13'::date, 'claude-cowork', 500, 500, 9, 'anthropic-analytics-api',
        ${regionId2}::uuid, ${unhomedUnitId}::uuid, NULL, 'ingest-snapshot')`

    const rows = await t.client<{ cost: string; cost_owning_unit_id: string | null }[]>`
      SELECT cost_usd::text AS cost, cost_owning_unit_id::text AS cost_owning_unit_id
      FROM v_complete_usage WHERE teammate_id = ${unhomedTeammateId}::uuid AND tool = 'claude-cowork'`
    expect(rows).toHaveLength(1) // present, not dropped
    expect(Number(rows[0]!.cost)).toBe(9)
    expect(rows[0]!.cost_owning_unit_id).toBeNull() // explicit unallocated bucket
  })

  it('the coding-agent lane reaches v_complete_usage through arm 3 via reconciliation_record, using ITS dimension snapshot', async () => {
    await t.client`INSERT INTO reconciliation_record
        (teammate_id, provider, enterprise_ref, period_date, category, scope, region_id, org_unit_id, cost_owning_unit_id,
         actual_qty, actual_unit_type, actual_usd, otel_attributed_usd, delta_usd, spend_class, disposition, status)
      VALUES (${teammateId2}::uuid, 'github', 'ent-cu3', '2026-06-14'::date, 'copilot_coding_agent', 'teammate',
        ${regionId2}::uuid, ${unitId2}::uuid, ${unitId2}::uuid,
        '10', 'ai-credits', '18.00', '0', '18.00', 'indicative', 'ingest_only', 'proposed')`

    const rows = await t.client<{ cost: string; provenance: string; cost_owning_unit_id: string | null }[]>`
      SELECT cost_usd::text AS cost, usage_provenance AS provenance, cost_owning_unit_id::text AS cost_owning_unit_id
      FROM v_complete_usage WHERE teammate_id = ${teammateId2}::uuid AND tool = 'copilot-agent'`
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.cost)).toBe(18)
    expect(rows[0]!.provenance).toBe('provider-usage')
    expect(rows[0]!.cost_owning_unit_id).toBe(unitId2)
  })

  /*
   * STRUCTURAL disjointness (R1-M1), not conventional: simulate a DATA ANOMALY
   * that should be impossible in a correctly-behaved deployment — an
   * ingest-only tool literal landing directly in attribution_record and
   * unaccounted_usage, bypassing every application code path that would
   * normally prevent it. Arms 1 and 2's EXPLICIT tool exclusions must still
   * hold even against a row that got there some other way; only arm 3 may ever
   * carry these tools. This is what makes the mutual exclusion a property of
   * the VIEW DEFINITION rather than an accident of which code paths happen to
   * run today.
   */
  it('arms 1 and 2 EXCLUDE an ingest-only tool even if a data anomaly puts a row directly into attribution_record / unaccounted_usage', async () => {
    const [inst] = await t.client<{ instance_id: string }[]>`
      INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'oid-cu3-anomaly', ${teammateId2}::uuid, 'claude-code', ${regionId2}::uuid, ${unitId2}::uuid, 'h', 'P')
      RETURNING instance_id::text AS instance_id`
    // Anomalous: a non-Code tool literal in attribution_record (should never happen — no session ever emits OTel for it).
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst!.instance_id}::uuid, ${teammateId2}::uuid, ${regionId2}::uuid, ${unitId2}::uuid,
              'claude-slack', 'claude-sonnet-4-6', 'input', 1000, 500, 'tier-1', 'estimated', now(), 'anomaly-conv-arm1')`
    // Anomalous: a copilot-agent row in unaccounted_usage (should never happen — A2 excludes it from the reconciliation write).
    await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
      VALUES (${teammateId2}::uuid, ${regionId2}::uuid, ${unitId2}::uuid, '2026-06-15'::date, 'copilot-agent', 700, 0, 'api-reconciled')`

    const slack = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM v_complete_usage WHERE teammate_id = ${teammateId2}::uuid AND tool = 'claude-slack' AND cost_usd = 500`
    expect(Number(slack[0]!.n)).toBe(0) // arm 1's explicit exclusion holds even against the anomaly

    const agent = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM v_complete_usage WHERE teammate_id = ${teammateId2}::uuid AND tool = 'copilot-agent' AND cost_usd = 700`
    expect(Number(agent[0]!.n)).toBe(0) // arm 2's explicit exclusion holds even against the anomaly
  })

  /*
   * The provenance axis as the general disjointness proof: every row is
   * EITHER an ingest-only tool with provenance='provider-usage' (arm 3 only)
   * OR a non-ingest-only tool with provenance IN ('otel-emitted',
   * 'api-reconciled') (arms 1/2 only) — never the other combination, over the
   * WHOLE view, not just the rows this suite happened to plant.
   */
  it('every v_complete_usage row is EITHER (ingest-only tool, provider-usage) OR (ordinary tool, otel-emitted/api-reconciled) — never crossed', async () => {
    const crossed = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM v_complete_usage
      WHERE (usage_provenance = 'provider-usage') != (tool IN (
        'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
        'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
      ))`
    expect(Number(crossed[0]!.n)).toBe(0)
  })
})
