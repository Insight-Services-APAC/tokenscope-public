// @vitest-environment node
/*
 * Model driver rows — end-to-end integration proof for the model-axis
 * subtraction read side (mig 0124;
 * docs/design/reporting-consolidation/07-model-axis-subtraction-build.md D4-D6).
 *
 * The unit test (tests/unit/reports/model-attribution.test.ts) pins the
 * key/label/classifier helpers in isolation; this proves the WHOLE pipeline
 * agrees end-to-end — the real `fetchAcrossDrivers` / `fetchRegionalDrivers` /
 * `fetchCostCentreBurnDrivers` SQL plus the helpers produce NAMED arm-2/arm-3
 * model rows (non-vacuous, design test 12), REASON-TYPED remainder rows
 * (design test 20's shape), one row per model id ACROSS lanes (never
 * double-listed), and a sum-back that still foots to the headline.
 *
 * Deliberately its OWN small fixture rather than reusing
 * known-outcome-fixture.ts: that fixture is shared, exact-total-asserted
 * across a dozen other report surfaces in known-outcome-validation.test.ts,
 * and inserting a new row into it would risk silently shifting one of those
 * totals for a test that runs later in the same file.
 *
 * FIXTURE (September 2026, one teammate):
 *   arm 1 (OTel)          claude-sonnet-4-6  $40
 *   arm 2 (fill, $9)      children: sonnet $6 (12k tok) + opus $2 (4k tok)
 *                         → remainder $1, reason 'unmodelled-provider-cost'
 *                         (children seeded exactly as the S1 writer stores
 *                         them — the view reads unaccounted_usage_model, 0123)
 *   arm 3 (claude-ai $17) provider fact: haiku cost $10
 *                         → named haiku $10 + remainder $7, 'surface-remainder'
 *
 * So claude-sonnet-4-6 exists in TWO lanes (OTel + arm-2 child) and must be
 * ONE $46 row — the D9 pairing case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup } from '../helpers/usage-rollup'
import { fetchAcrossDrivers } from '../../../server/reporting/across-regions'
import { resolveRegionalScope, fetchRegionalDrivers } from '../../../server/reporting/regional'
import { fetchCostCentreBurnDrivers } from '../../../server/reporting/cost-centres'
import {
  MODEL_GAP_REASON_LABELS,
  PROVIDER_USAGE_MODEL_KEY,
  PROVIDER_USAGE_MODEL_LABEL,
  UNATTRIBUTED_MODEL_KEY,
  UNATTRIBUTED_MODEL_LABEL,
  modelBucketKind,
} from '../../../shared/reports/model-attribution'

type Tx = PostgresJsDatabase<Record<string, unknown>>

let t: TestDb
let tx: Tx
let regionId: string
let unitId: string
let teammateId: string
let instanceId: string

const WIN = { startIso: '2026-09-01T00:00:00.000Z', endIso: '2026-10-01T00:00:00.000Z' }

beforeAll(async () => {
  t = await startTestDb()
  tx = t.db as unknown as Tx
  const c = t.client

  await c`INSERT INTO region (code, display_name) VALUES ('mdl', 'Model Driver Region')`
  ;[{ id: regionId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='mdl'`
  await c`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'mdl'::ltree, 'mdl-cc', 'MDL CC', 'practice', true)`
  ;[{ id: unitId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='mdl-cc'`
  await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
    VALUES ('oid-mdl', 'mdl@x.test', 'MDL', ${regionId}::uuid, ${unitId}::uuid)`
  ;[{ id: teammateId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='mdl@x.test'`
  instanceId = randomUUID()
  await c`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, cost_owning_unit_id, project_code_hash, raw_project_code)
    VALUES (${instanceId}::uuid, 'oid-mdl', ${teammateId}::uuid, 'claude-code', ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid, 'h', 'P')`

  // arm 1: a real model (claude-sonnet-4-6), $40.
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instanceId}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
            'claude-code', 'claude-sonnet-4-6', 'input', 80000, 40, 'tier-1', 'estimated', '2026-09-05T00:00:00Z'::timestamptz, 'conv-mdl-sonnet')`

  // arm 2: the API-OTel fill, $9 / 18k tokens — WITH its write-time model
  // children (mig 0123's shape: Σ children ≤ parent; the $1 shortfall is
  // model-less provider cost, so the parent's stamped reason stays NULL and
  // the view types the remainder 'unmodelled-provider-cost').
  await c`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${teammateId}::uuid, ${regionId}::uuid, ${unitId}::uuid, '2026-09-06'::date, 'claude-code', 9, 18000, 'api-reconciled')`
  const [{ id: uuId }] = await c<{ id: string }[]>`
    SELECT id::text AS id FROM unaccounted_usage WHERE teammate_id=${teammateId}::uuid AND day='2026-09-06'::date`
  await c`INSERT INTO unaccounted_usage_model (unaccounted_usage_id, model, cost_usd, tokens) VALUES
    (${uuId}::uuid, 'claude-sonnet-4-6', 6, 12000),
    (${uuId}::uuid, 'claude-opus-4-6',   2,  4000)`

  // arm 3: ingest-only (non-Code Claude), $17 — usage_provenance='provider-usage'.
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
      region_id, org_unit_id, cost_owning_unit_id, dimension_source)
    VALUES (${teammateId}::uuid, '2026-09-07'::date, 'claude-ai', 1000, 1000, 17, 'anthropic-analytics-api',
      ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid, 'ingest-snapshot')`
  // …and the provider FACT that models $10 of it (cost row, model NOT NULL) —
  // arm 3 fans out against provider_usage_fact for the same key (D5).
  await c`INSERT INTO provider_usage_fact
      (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd,
       region_id, org_unit_id, cost_owning_unit_id)
    VALUES ('anthropic-analytics-api', 'anthropic', ${teammateId}::uuid, 'mdl@x.test',
            '2026-09-07'::date, 'claude-ai', 'claude-haiku-4-6', 'tokens', 10,
            ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid)`
  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
}, 120_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('model drivers — named rows from BOTH fanned arms + reason-typed remainders, sum-back holds', () => {
  it('fetchAcrossDrivers (whole company)', async () => {
    const { rows, headlineUsd } = await fetchAcrossDrivers(tx, WIN, 'model')
    expect(headlineUsd).toBeCloseTo(66, 6) // 40 + 9 + 17

    // NON-VACUOUS named arm-2 rows (design test 12): the sonnet id pairs
    // ACROSS lanes into ONE row (OTel $40 + arm-2 child $6), never two.
    const sonnetRows = rows.filter((r) => r.key === 'claude-sonnet-4-6')
    expect(sonnetRows).toHaveLength(1)
    expect(sonnetRows[0]!.usd).toBeCloseTo(46, 6)
    // The arm-2-only child is its own named row…
    expect(rows.find((r) => r.key === 'claude-opus-4-6')!.usd).toBeCloseTo(2, 6)
    // …and the arm-3 fan-out names the haiku dollars (provider-usage lane).
    expect(rows.find((r) => r.key === 'claude-haiku-4-6')!.usd).toBeCloseTo(10, 6)

    // The remainders are REASON-TYPED rows, one per (provenance, reason).
    const arm2Rem = rows.find((r) => r.gap_reason === 'unmodelled-provider-cost')!
    expect(arm2Rem.usd).toBeCloseTo(1, 6) // 9 − (6 + 2)
    expect(arm2Rem.key).toBe(`${UNATTRIBUTED_MODEL_KEY}:unmodelled-provider-cost`)
    expect(arm2Rem.label).toBe(MODEL_GAP_REASON_LABELS['unmodelled-provider-cost'])
    const arm3Rem = rows.find((r) => r.gap_reason === 'surface-remainder')!
    expect(arm3Rem.usd).toBeCloseTo(7, 6) // 17 − 10
    expect(arm3Rem.key).toBe(`${PROVIDER_USAGE_MODEL_KEY}:surface-remainder`)
    expect(arm3Rem.label).toBe(MODEL_GAP_REASON_LABELS['surface-remainder'])

    // Every remainder classifies as remainder, never as a rankable model.
    for (const r of [arm2Rem, arm3Rem]) expect(modelBucketKind(r.key)).toBe('remainder')

    // The rows fully account for the headline — the fan-out changes SHAPE,
    // never the sum-back total (design test 10, model axis).
    expect(rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(headlineUsd, 6)
  })

  it('fetchRegionalDrivers (region scope)', async () => {
    const scope = await resolveRegionalScope(
      tx,
      { role: 'global-finops', regionId },
      { region: regionId },
    )
    const { rows, headlineUsd } = await fetchRegionalDrivers(tx, scope, WIN, 'model')
    expect(headlineUsd).toBeCloseTo(66, 6)
    expect(rows.find((r) => r.key === 'claude-sonnet-4-6')!.usd).toBeCloseTo(46, 6)
    expect(rows.find((r) => r.gap_reason === 'unmodelled-provider-cost')!.usd).toBeCloseTo(1, 6)
    expect(rows.find((r) => r.gap_reason === 'surface-remainder')!.usd).toBeCloseTo(7, 6)
    expect(rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(headlineUsd, 6)
  })

  it('fetchCostCentreBurnDrivers (cost-centre scope) — arm 2 invisible, remainder REASONS stay distinct rows', async () => {
    // Cost-centre scope filters on `cost_owning_unit_id = ccId`. Arm 2 (the
    // api-reconciled fill AND its fanned children) ALWAYS carries a NULL
    // cost_owning_unit_id in v_complete_usage (unaccounted_usage has no CoU
    // concept — the fan-out inherits the parent's NULLs), so the $6 + $2 + $1
    // are invisible at this scope by construction — only arm 1 ($40) and
    // arm 3 reaches it.
    //
    // TWO SIMULTANEOUS REASONS in ONE cost centre: alongside the fixture's
    // $7 'surface-remainder' (claude-ai 09-07), seed an overrun day — facts $8
    // above a $5 vtd claude-office day → one unfanned $5
    // 'provider-revision-drift' row (r1-H3). The CC reader groups by
    // (model, provenance, gap_reason) exactly like the engine's model axis, so
    // the two reasons must surface as TWO reason-typed remainder rows — a
    // (model, provenance)-only GROUP BY would collapse them into one bare
    // bucket. Seeded HERE (this file runs in order, this test is last) so the
    // whole-estate assertions above keep their hand-computed figures.
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
        region_id, org_unit_id, cost_owning_unit_id, dimension_source)
      VALUES (${teammateId}::uuid, '2026-09-08'::date, 'claude-office', 1000, 1000, 5, 'anthropic-analytics-api',
        ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid, 'ingest-snapshot')`
    await t.client`INSERT INTO provider_usage_fact
        (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES ('anthropic-analytics-api', 'anthropic', ${teammateId}::uuid, 'mdl@x.test',
              '2026-09-08'::date, 'claude-office', 'claude-opus-4-6', 'tokens', 8,
              ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid)`

    // In scope now: arm 1 $40 + arm 3 ($10 haiku + $7 surface-remainder +
    // $5 revision-drift) = 62. headlineUsd is the caller-supplied burn figure
    // (echoed back, not recomputed), so pass the matching 62.
    const { rows, headlineUsd } = await fetchCostCentreBurnDrivers(tx, unitId, WIN, 'model', 62)
    expect(headlineUsd).toBeCloseTo(62, 6)
    expect(rows.find((r) => r.label === UNATTRIBUTED_MODEL_LABEL)).toBeUndefined()
    expect(rows.find((r) => r.key === 'claude-sonnet-4-6')!.usd).toBeCloseTo(40, 6)
    expect(rows.find((r) => r.key === 'claude-haiku-4-6')!.usd).toBeCloseTo(10, 6)

    // The two reasons are TWO reason-typed rows — keys suffixed, labels
    // reason-specific, dollars separate, each carrying its gap_reason.
    const surfaceRem = rows.find((r) => r.key === `${PROVIDER_USAGE_MODEL_KEY}:surface-remainder`)!
    expect(surfaceRem).toBeDefined()
    expect(surfaceRem.usd).toBeCloseTo(7, 6)
    expect(surfaceRem.label).toBe(MODEL_GAP_REASON_LABELS['surface-remainder'])
    expect(surfaceRem.label).toBe(PROVIDER_USAGE_MODEL_LABEL)
    expect(surfaceRem.gap_reason).toBe('surface-remainder')
    const driftRem = rows.find((r) => r.key === `${PROVIDER_USAGE_MODEL_KEY}:provider-revision-drift`)!
    expect(driftRem).toBeDefined()
    expect(driftRem.usd).toBeCloseTo(5, 6)
    expect(driftRem.label).toBe(MODEL_GAP_REASON_LABELS['provider-revision-drift'])
    expect(driftRem.gap_reason).toBe('provider-revision-drift')

    // Never a bare collapsed bucket, and both classify as remainders.
    expect(rows.find((r) => r.key === PROVIDER_USAGE_MODEL_KEY)).toBeUndefined()
    for (const r of [surfaceRem, driftRem]) expect(modelBucketKind(r.key)).toBe('remainder')

    expect(rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(62, 6)
  })
})
