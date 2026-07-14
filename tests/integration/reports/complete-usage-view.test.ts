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
