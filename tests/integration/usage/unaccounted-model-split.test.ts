// @vitest-environment node
/*
 * The model axis reads what was measured — S1 write side.
 * Design: docs/design/reporting-consolidation/07-model-axis-subtraction-build.md
 * (owner ruling 2026-08-04), tests 1-5, 16, 17.
 *
 * A fill day's model split is `cap(GREATEST(0, api_m − otel_m))` — a
 * subtraction of two OBSERVED per-model operands (provider_usage_fact cost /
 * token rows vs corroborated OTel), NEVER an apportionment. Written by
 * reconcileUnaccountedUsage into unaccounted_usage_model in the SAME
 * transaction as the parent upsert (mig 0123), replaced wholesale per run.
 *
 * Each day below is its own (teammate, day, tool) cell, so scenarios cannot
 * contaminate one another through the per-cell completeness gate.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { reconcileUnaccountedUsage } from '../../../server/usage/unaccounted-reconciliation'
import { corroboratedOtelDaily } from '../../../server/usage/corroborated-otel'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let teammateId = ''
let instanceId = ''
let projectId = ''

const WINDOW = { startDate: '2026-06-01', endDate: '2026-06-30' }
const GH_SOURCE = 'copilot-consumption:model-split-ent'

type Lane = 'provider-billed' | 'self-billed' | 'unknown'

/** The provider API truth for (teammate, day, 'claude-code') — the PARENT operand. */
async function bill(day: string, costUsd: string, tokens = 0): Promise<void> {
  await t.db.insert(schema.actualSpend).values({
    teammateId,
    date: day,
    tool: 'claude-code',
    inputTokens: BigInt(tokens),
    outputTokens: 0n,
    costUsd,
    source: `api:${randomUUID().slice(0, 8)}`,
  })
}

/** One OTel row carrying a MODEL — the per-model subtrahend. */
async function otel(
  day: string,
  model: string,
  costUsd: string,
  opts: { lane?: Lane; tokens?: number } = {},
): Promise<void> {
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    claudeSessionId: `sess-${randomUUID().slice(0, 8)}`,
    teammateId,
    regionId,
    orgUnitId,
    tool: 'claude-code',
    model,
    tokenType: 'output',
    tokens: BigInt(opts.tokens ?? 0),
    costUsd,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: new Date(`${day}T12:00:00.000Z`),
    sourceRunId: randomUUID(),
    billingLane: opts.lane ?? 'provider-billed',
  })
}

/** One provider_usage_fact COST row (cost_type set, no tokens — mig 0118 measure_chk). */
async function factCost(
  day: string,
  model: string | null,
  costUsd: string,
  opts: { provider?: string; source?: string; tool?: string; costType?: string } = {},
): Promise<void> {
  await t.client`
    INSERT INTO provider_usage_fact (source, provider, teammate_id, date, tool, model, cost_type, cost_usd)
    VALUES (${opts.source ?? 'anthropic-analytics-api:model-split'}, ${opts.provider ?? 'anthropic'},
            ${teammateId}::uuid, ${day}::date, ${opts.tool ?? 'claude-code'}, ${model},
            ${opts.costType ?? 'tokens'}, ${costUsd})`
}

/** One provider_usage_fact TOKEN row (cost_type NULL, no cost — the disjoint measure). */
async function factTokens(
  day: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  opts: { provider?: string; source?: string; tool?: string; requests?: number } = {},
): Promise<void> {
  await t.client`
    INSERT INTO provider_usage_fact (source, provider, teammate_id, date, tool, model, cost_type,
                                     input_tokens, output_tokens, requests)
    VALUES (${opts.source ?? 'anthropic-analytics-api:model-split'}, ${opts.provider ?? 'anthropic'},
            ${teammateId}::uuid, ${day}::date, ${opts.tool ?? 'claude-code'}, ${model}, NULL,
            ${inputTokens}, ${outputTokens}, ${opts.requests ?? null})`
}

/** The copilot-cli API lane: v_teammate_usage_daily's github arm reads this ledger. */
async function copilotDay(day: string, usd: string, credits: number): Promise<void> {
  await t.db.insert(schema.reconciliationRecord).values({
    teammateId,
    provider: 'github',
    enterpriseRef: 'model-split-ent',
    periodDate: day,
    category: 'copilot_interactive',
    scope: 'teammate',
    regionId,
    orgUnitId,
    actualQty: String(credits),
    actualUnitType: 'ai-credits',
    actualUsd: usd,
    otelAttributedUsd: '0',
    deltaUsd: usd,
    spendClass: 'indicative',
    disposition: 'untagged',
    status: 'applied',
  })
}

async function children(day: string, tool = 'claude-code'): Promise<Array<{ model: string; cost: number; tokens: number }>> {
  const rows = await t.client<{ model: string; cost_usd: string; tokens: string }[]>`
    SELECT m.model, m.cost_usd::text AS cost_usd, m.tokens::text AS tokens
      FROM unaccounted_usage u
      JOIN unaccounted_usage_model m ON m.unaccounted_usage_id = u.id
     WHERE u.teammate_id = ${teammateId}::uuid AND u.day = ${day}::date AND u.tool = ${tool}
     ORDER BY m.model`
  return rows.map((r) => ({ model: r.model, cost: Number(r.cost_usd), tokens: Number(r.tokens) }))
}

async function parent(
  day: string,
  tool = 'claude-code',
): Promise<{ id: string; cost: number; tokens: number; reason: string | null; project_id: string | null } | null> {
  const [row] = await t.client<
    { id: string; cost_usd: string; tokens: string; model_gap_reason: string | null; project_id: string | null }[]
  >`
    SELECT id::text AS id, cost_usd::text AS cost_usd, tokens::text AS tokens, model_gap_reason,
           project_id::text AS project_id
      FROM unaccounted_usage
     WHERE teammate_id = ${teammateId}::uuid AND day = ${day}::date AND tool = ${tool}`
  if (!row) return null
  return {
    id: row.id,
    cost: Number(row.cost_usd),
    tokens: Number(row.tokens),
    reason: row.model_gap_reason,
    project_id: row.project_id,
  }
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'ms', displayName: 'MS' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ms', code: 'ms-bu', displayName: 'MS BU', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ms', email: 'ms@example.com', regionId, orgUnitId })
    .returning()
  teammateId = tm!.id
  const [p] = await t.db
    .insert(schema.project)
    .values({ code: 'MS-P', codeHash: 'h-ms-p', displayName: 'MS Project', type: 'billable', regionId, costOwningUnitId: orgUnitId })
    .returning()
  projectId = p!.id
  instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: 'oid-ms',
    teammateId,
    projectCodeHash: 'h-ms',
    rawProjectCode: 'MS',
    tool: 'claude-code',
    tsStart: new Date('2026-06-01T00:00:00.000Z'),
    regionId,
    orgUnitId,
  })
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  // unaccounted_usage_model cascades from its parent (mig 0123 FK).
  await t.client`DELETE FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM attribution_record WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM actual_spend WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM provider_usage_fact WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM reconciliation_record WHERE teammate_id = ${teammateId}::uuid`
})

describe('unaccounted_usage_model — the per-model residual children (design D1-D3)', () => {
  it('design test 1 — conservation, money: Σ children = parent.cost_usd exactly at 6dp, and reason is NULL', async () => {
    await bill('2026-06-10', '30.000000')
    await factCost('2026-06-10', 'claude-fable-5', '18.000000')
    await factCost('2026-06-10', 'claude-haiku-4-5', '12.000000')
    await otel('2026-06-10', 'claude-fable-5', '5.000000')
    await otel('2026-06-10', 'claude-haiku-4-5', '3.000000')

    await reconcileUnaccountedUsage(t.db, WINDOW)

    const p = await parent('2026-06-10')
    expect(p!.cost).toBe(22)
    expect(p!.reason).toBeNull() // children exist → nothing to explain (r1-H5)
    const rows = await children('2026-06-10')
    expect(rows.reduce((a, r) => a + r.cost, 0)).toBe(p!.cost)
    // The exact-at-6dp claim, SQL-side, not through float summing.
    const [foot] = await t.client<{ ok: boolean }[]>`
      SELECT SUM(m.cost_usd) = u.cost_usd AS ok
        FROM unaccounted_usage u JOIN unaccounted_usage_model m ON m.unaccounted_usage_id = u.id
       WHERE u.teammate_id = ${teammateId}::uuid AND u.day = '2026-06-10'::date AND u.tool = 'claude-code'
       GROUP BY u.id, u.cost_usd`
    expect(foot!.ok).toBe(true)
  })

  it('design test 2 — conservation, tokens: from the TOKEN lane, integer; a cost-proportion reuse must fail it', async () => {
    // Cost split 60/40 but token split 10/90 — deliberately decorrelated, so
    // children derived from cost proportions cannot satisfy this.
    await bill('2026-06-11', '30.000000', 10_000)
    await factCost('2026-06-11', 'claude-fable-5', '18.000000')
    await factCost('2026-06-11', 'claude-haiku-4-5', '12.000000')
    await factTokens('2026-06-11', 'claude-fable-5', 800, 200) // 1 000
    await factTokens('2026-06-11', 'claude-haiku-4-5', 8_000, 1_000) // 9 000
    await otel('2026-06-11', 'claude-fable-5', '5.000000', { tokens: 100 })
    await otel('2026-06-11', 'claude-haiku-4-5', '3.000000', { tokens: 400 })

    await reconcileUnaccountedUsage(t.db, WINDOW)

    const p = await parent('2026-06-11')
    expect(p!.tokens).toBe(9_500) // 10 000 − 500
    const rows = await children('2026-06-11')
    expect(rows).toEqual([
      { model: 'claude-fable-5', cost: 13, tokens: 900 }, // 1 000 − 100
      { model: 'claude-haiku-4-5', cost: 9, tokens: 8_600 }, // 9 000 − 400
    ])
    expect(rows.reduce((a, r) => a + r.tokens, 0)).toBe(p!.tokens)
  })

  it('design test 3 — pure subtraction: every child equals api_m − otel_m exactly (rescale provably a no-op)', async () => {
    await bill('2026-06-12', '20.004463')
    await factCost('2026-06-12', 'claude-fable-5', '10.104060')
    await factCost('2026-06-12', 'claude-opus-5', '7.000003')
    await factCost('2026-06-12', 'claude-haiku-4-5', '2.900400')
    await otel('2026-06-12', 'claude-fable-5', '0.104060')
    await otel('2026-06-12', 'claude-opus-5', '3.000003')

    await reconcileUnaccountedUsage(t.db, WINDOW)

    // R = 20.004463 − 3.104063 = 16.900400 = Σ floored → every named cell is
    // its untouched observed subtraction, at full 6dp precision.
    expect(await children('2026-06-12')).toEqual([
      { model: 'claude-fable-5', cost: 10, tokens: 0 },
      { model: 'claude-haiku-4-5', cost: 2.9004, tokens: 0 },
      { model: 'claude-opus-5', cost: 4, tokens: 0 },
    ])
  })

  it('design test 4 — drift: otel_m > api_m floors to 0, the DESCENDING cap truncates the tail, Σ = parent, deterministic', async () => {
    // fable drifts (OTel 5 > API 2 → floored 0); sonnet floored 16, haiku
    // floored 5; R = 28 − 10 = 18 < Σ floored 21 → the cap allocates sonnet
    // whole and truncates haiku to 2. An ASC walk would instead emit
    // haiku 5 + sonnet 13 — which is what makes this the cap-order tripwire.
    await bill('2026-06-13', '28.000000')
    await factCost('2026-06-13', 'claude-fable-5', '2.000000')
    await factCost('2026-06-13', 'claude-sonnet-5', '20.000000')
    await factCost('2026-06-13', 'claude-haiku-4-5', '6.000000')
    await otel('2026-06-13', 'claude-fable-5', '5.000000')
    await otel('2026-06-13', 'claude-sonnet-5', '4.000000')
    await otel('2026-06-13', 'claude-haiku-4-5', '1.000000')

    await reconcileUnaccountedUsage(t.db, WINDOW)
    const first = await children('2026-06-13')
    expect(first).toEqual([
      { model: 'claude-haiku-4-5', cost: 2, tokens: 0 }, // truncated: 5 observed, 2 remaining
      { model: 'claude-sonnet-5', cost: 16, tokens: 0 }, // its whole observed subtraction
    ])
    const p = await parent('2026-06-13')
    expect(first.reduce((a, r) => a + r.cost, 0)).toBe(p!.cost) // Σ = 18 = parent
    for (const r of first) expect(r.cost).toBeGreaterThanOrEqual(0) // no negative child
    // No named cell above its own observed subtraction; the drift model is absent.
    expect(first.find((r) => r.model === 'claude-fable-5')).toBeUndefined()
    expect(first.find((r) => r.model === 'claude-sonnet-5')!.cost).toBeLessThanOrEqual(16)
    expect(first.find((r) => r.model === 'claude-haiku-4-5')!.cost).toBeLessThanOrEqual(5)
    // Deterministic across runs: a recompute reproduces the identical set.
    await reconcileUnaccountedUsage(t.db, WINDOW)
    expect(await children('2026-06-13')).toEqual(first)
  })

  it('design test 4b — cap ties break by model name ASC, deterministically', async () => {
    // fable drifts to floored 0; opus and haiku TIE at floored 10 with
    // R = 14 — the name-ASC rule allocates haiku whole and truncates opus.
    await bill('2026-06-14', '22.000000')
    await factCost('2026-06-14', 'claude-haiku-4-5', '10.000000')
    await factCost('2026-06-14', 'claude-opus-5', '10.000000')
    await factCost('2026-06-14', 'claude-fable-5', '2.000000')
    await otel('2026-06-14', 'claude-fable-5', '8.000000')

    await reconcileUnaccountedUsage(t.db, WINDOW)
    expect(await children('2026-06-14')).toEqual([
      { model: 'claude-haiku-4-5', cost: 10, tokens: 0 },
      { model: 'claude-opus-5', cost: 4, tokens: 0 },
    ])
  })

  it('design test 5 — no facts vs github-only money: zero children, and the two absences carry DISTINCT reasons', async () => {
    // Key 1: fill with ZERO cost-bearing facts — the transient window
    // (fact lane refreshes hourly against the 2h reconcile cadence).
    await bill('2026-06-15', '20.000000')
    await otel('2026-06-15', 'claude-fable-5', '5.000000')
    // Key 2: copilot-cli backed ONLY by github money (day-grain, model NULL —
    // mig 0120) plus a MODEL row that is requests-only. The requests row must
    // never become a cost operand (design test 6's core).
    await copilotDay('2026-06-15', '8.000000', 200)
    await factCost('2026-06-15', null, '8.000000', {
      provider: 'github',
      source: GH_SOURCE,
      tool: 'copilot-cli',
      costType: 'ai-credits',
    })
    await factTokens('2026-06-15', 'gpt-5', 0, 0, { provider: 'github', source: GH_SOURCE, tool: 'copilot-cli', requests: 12 })

    await reconcileUnaccountedUsage(t.db, WINDOW)

    const code = await parent('2026-06-15', 'claude-code')
    expect(code!.cost).toBe(15)
    expect(code!.reason).toBe('awaiting-provider-detail')
    expect(await children('2026-06-15', 'claude-code')).toEqual([])

    const cli = await parent('2026-06-15', 'copilot-cli')
    expect(cli!.cost).toBe(8)
    expect(cli!.reason).toBe('provider-day-grain')
    expect(await children('2026-06-15', 'copilot-cli')).toEqual([]) // no money children from requests rows
  })

  it('design test 16 (r1-H1) — mixed billing lanes in ONE key: per-model OTel cells sum EXACTLY to the tool cell', async () => {
    const day = '2026-06-16'
    // One (teammate, day, tool) cell: fable rows still 'unknown' (pre-0119
    // shape), haiku rows fully-stamped self-billed. The gate is a per-CELL
    // decision — any unknown row holds the WHOLE cell on the old operand — so
    // it must not decompose per model.
    await otel(day, 'claude-fable-5', '4.000000', { lane: 'unknown', tokens: 100 })
    await otel(day, 'claude-fable-5', '1.000000', { lane: 'unknown', tokens: 50 })
    await otel(day, 'claude-haiku-4-5', '3.000000', { lane: 'self-billed', tokens: 300 })

    const bounds = {
      startExpr: sql`${day}::date::timestamptz`,
      endExpr: sql`(${day}::date + 1)::timestamptz`,
      extra: sql`AND ar.teammate_id = ${teammateId}::uuid`,
      withTool: true,
      withTokens: true,
    }
    const toolCells = await t.db.execute<{ otel_usd: string; otel_tokens: string }>(
      sql`SELECT otel_usd::text AS otel_usd, otel_tokens::text AS otel_tokens FROM (${corroboratedOtelDaily(bounds)}) q`,
    )
    const modelCells = await t.db.execute<{ model: string; otel_usd: string; otel_tokens: string }>(
      sql`SELECT model, otel_usd::text AS otel_usd, otel_tokens::text AS otel_tokens
          FROM (${corroboratedOtelDaily({ ...bounds, withModel: true })}) q ORDER BY model`,
    )
    expect(toolCells).toHaveLength(1)
    expect(modelCells).toHaveLength(2)
    // The unknown row holds the whole cell on the OLD operand: 5 + 3 = 8 — and
    // the model cells decompose that SAME decision, never a per-model one
    // (a per-model gate would zero the fully-stamped self-billed haiku cell).
    expect(Number(toolCells[0]!.otel_usd)).toBe(8)
    expect(modelCells.map((r) => [r.model, Number(r.otel_usd)])).toEqual([
      ['claude-fable-5', 5],
      ['claude-haiku-4-5', 3],
    ])
    expect(modelCells.reduce((a, r) => a + Number(r.otel_usd), 0)).toBe(Number(toolCells[0]!.otel_usd))
    expect(modelCells.reduce((a, r) => a + Number(r.otel_tokens), 0)).toBe(Number(toolCells[0]!.otel_tokens))

    // And through the writer: the children subtract exactly the operand the
    // parent subtracted, decomposed — Σ children = parent survives the mix.
    await bill(day, '10.000000')
    await factCost(day, 'claude-fable-5', '6.000000')
    await factCost(day, 'claude-haiku-4-5', '4.000000')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const p = await parent(day)
    expect(p!.cost).toBe(2) // 10 − 8, the old operand — the parent's own gate
    expect(await children(day)).toEqual([
      { model: 'claude-fable-5', cost: 1, tokens: 0 }, // 6 − 5, not 6 − 0
      { model: 'claude-haiku-4-5', cost: 1, tokens: 0 }, // 4 − 3, not capped-at-2
    ])
  })

  it('design test 17 (r1-M1) — a decided orphan is zeroed AND its children are deleted in the same transaction', async () => {
    await bill('2026-06-17', '25.000000')
    await factCost('2026-06-17', 'claude-fable-5', '15.000000')
    await factCost('2026-06-17', 'claude-haiku-4-5', '10.000000')
    await otel('2026-06-17', 'claude-fable-5', '5.000000')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    expect((await children('2026-06-17')).length).toBeGreaterThan(0)

    // The developer DECIDES about the day (tags it) — then the provider view
    // stops backing the key entirely (the API source for the day went away).
    await t.client`
      UPDATE unaccounted_usage SET project_id = ${projectId}::uuid, tagged_at = now(), tagged_by = ${teammateId}::uuid
      WHERE teammate_id = ${teammateId}::uuid AND day = '2026-06-17'`
    await t.client`DELETE FROM actual_spend WHERE teammate_id = ${teammateId}::uuid AND date = '2026-06-17'`

    await reconcileUnaccountedUsage(t.db, WINDOW)

    const p = await parent('2026-06-17')
    expect(p).not.toBeNull() // the decision is preserved history…
    expect(p!.project_id).toBe(projectId)
    expect(p!.cost).toBe(0) // …but its contribution drops to 0
    expect(p!.tokens).toBe(0)
    // …and its children are GONE — a zeroed parent with surviving children
    // would break Σ children ≤ parent, and arm 2's cost_usd > 0 filter would
    // hide that, not repair it.
    expect(await children('2026-06-17')).toEqual([])
  })

  it('undecided orphan: the parent DELETE cascades through the 0123 FK — no orphaned children survive', async () => {
    await bill('2026-06-18', '12.000000')
    await factCost('2026-06-18', 'claude-fable-5', '12.000000')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const p = await parent('2026-06-18')
    expect((await children('2026-06-18')).length).toBeGreaterThan(0)

    await t.client`DELETE FROM actual_spend WHERE teammate_id = ${teammateId}::uuid AND date = '2026-06-18'`
    await reconcileUnaccountedUsage(t.db, WINDOW)

    expect(await parent('2026-06-18')).toBeNull()
    const [orphans] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM unaccounted_usage_model WHERE unaccounted_usage_id = ${p!.id}::uuid`
    expect(Number(orphans!.n)).toBe(0)
  })

  it('multi-source facts aggregate per model — neither dropped nor doubled (05 test 5 survives)', async () => {
    // One fill key standing against TWO provider orgs' fact rows: the join
    // omits `source` on purpose (provider-day-detail.ts:43-50; the 0121 index).
    await bill('2026-06-19', '40.000000')
    await factCost('2026-06-19', 'claude-fable-5', '25.000000', { source: 'anthropic-analytics-api:org-a' })
    await factCost('2026-06-19', 'claude-fable-5', '5.000000', { source: 'anthropic-analytics-api:org-b' })
    await factCost('2026-06-19', 'claude-haiku-4-5', '10.000000', { source: 'anthropic-analytics-api:org-a' })
    await otel('2026-06-19', 'claude-fable-5', '6.000000')

    await reconcileUnaccountedUsage(t.db, WINDOW)
    expect(await children('2026-06-19')).toEqual([
      { model: 'claude-fable-5', cost: 24, tokens: 0 }, // (25 + 5) − 6 — the cross-source aggregate
      { model: 'claude-haiku-4-5', cost: 10, tokens: 0 },
    ])
  })

  it('children are replaced WHOLESALE on recompute — late OTel shrinks a model cell instead of stacking a second row', async () => {
    await bill('2026-06-20', '30.000000')
    await factCost('2026-06-20', 'claude-fable-5', '30.000000')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    expect(await children('2026-06-20')).toEqual([{ model: 'claude-fable-5', cost: 30, tokens: 0 }])

    await otel('2026-06-20', 'claude-fable-5', '10.000000') // late OTel arrives
    await reconcileUnaccountedUsage(t.db, WINDOW)
    expect(await children('2026-06-20')).toEqual([{ model: 'claude-fable-5', cost: 20, tokens: 0 }])
  })
})
