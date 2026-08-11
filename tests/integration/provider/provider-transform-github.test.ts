// @vitest-environment node
/*
 * provider-transform, the GITHUB arm (#49) — the second provider landing in the
 * normalised lane.
 *
 * WHAT IS BEING PROVEN, and why it is not the Anthropic arm's invariant:
 * `provider_usage_fact` GitHub rows are CONSUMPTION facts, not bill facts.
 * Copilot's authoritative bill is `copilot_pool_bill` at (org, sku, month) —
 * pooled and net of the included allowance — and a per-user table cannot
 * conserve against it. The four claims this arm makes are G1..G4 in
 * server/workers/provider-transform-github.ts's header; each has a test below,
 * named for it.
 *
 * Every fixture is driven through the REAL adapter normaliser
 * (`normaliseMetricsCreditLine`) and the REAL persister (`runReconcileEngine`),
 * so what the transform reads is what production writes. A hand-built INSERT
 * into `reconciliation_record` would let this suite keep passing while the
 * adapter's envelope changed shape underneath it — which is exactly how the
 * ~90 undeclared wire fields went unread for months.
 *
 * Each assertion below was verified to FAIL with its fix reverted — the
 * mutations are recorded in the commit message and beside the assertion.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runEnterpriseAnalyticsPoll, sourceForOrg } from '../../../server/workers/analytics-poller'
import { runProviderTransform } from '../../../server/workers/provider-transform'
import { sourceForGithubEnterprise } from '../../../server/workers/provider-transform-github'
import { normaliseMetricsCreditLine } from '../../../server/reconciliation/adapters/github'
import { runReconcileEngine } from '../../../server/reconciliation/engine'
import type { AnthropicEnterpriseClient } from '../../../server/anthropic/enterprise-client'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let orgA: string
let orgB: string
let teammateId: string
let providerEnterpriseId: string

const ENTERPRISE = 'acme-partner-demo'
const GH_SOURCE = sourceForGithubEnterprise(ENTERPRISE)
const LOGIN = 'octocat'
const DAY = '2026-08-01'

/** The Anthropic side, for the both-providers and no-cross-talk assertions. */
const AN_ORG = 'ptxg-org'
const AN_SOURCE = sourceForOrg(AN_ORG)
const AN_EMAIL = 'billed@provider-transform-github.test'

/*
 * One users-1-day NDJSON record, shaped exactly as the 2026-08-02 capture
 * observed it (docs/design/provider-wire-captures/). `ai_credits_used` sits at
 * the ROOT; the model rows carry activity, never money; `totals_by_cli` is
 * optional because 153/200 stored records do not have it.
 */
function metricsRecord(opts: {
  credits: number
  modelFeatures?: Array<{ model: string; feature: string; interactions: number }>
  cliTokens?: { prompt: number; output: number }
  login?: string
}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    user_login: opts.login ?? LOGIN,
    user_id: 1,
    day: DAY,
    ai_credits_used: opts.credits,
    enterprise_id: 'E_abc',
    code_generation_activity_count: 12,
    totals_by_language_model: [{ model: 'gpt-5', language: 'typescript' }],
  }
  if (opts.modelFeatures) {
    record.totals_by_model_feature = opts.modelFeatures.map((m) => ({
      model: m.model,
      feature: m.feature,
      user_initiated_interaction_count: m.interactions,
    }))
  }
  if (opts.cliTokens) {
    record.totals_by_cli = {
      prompt_count: 3,
      request_count: 9,
      session_count: 2,
      token_usage: {
        prompt_tokens_sum: opts.cliTokens.prompt,
        output_tokens_sum: opts.cliTokens.output,
        avg_tokens_per_request: 100,
      },
    }
  }
  return record
}

/** Land one Copilot user-day in `reconciliation_record` through the real path.
 *  AIC_USD_RATE is $0.01/credit, so `credits` dollars = credits / 100. */
async function reconcile(
  records: Array<ReturnType<typeof metricsRecord>>,
  opts: { periodDate?: string; teammate?: string } = {},
): Promise<void> {
  const periodDate = opts.periodDate ?? DAY
  const lines = records.map((record) =>
    normaliseMetricsCreditLine({
      enterpriseRef: ENTERPRISE,
      teammateId: opts.teammate ?? teammateId,
      periodDate,
      credits: Number(record.ai_credits_used),
      login: String(record.user_login),
      chargebackExempt: false,
      raw: record,
    }),
  )
  await runReconcileEngine(t.db, lines)
}

async function transformGithub(startingAt = DAY, endingAt = DAY) {
  return runProviderTransform(t.db, { startingAt, endingAt, source: GH_SOURCE })
}

interface FactRow {
  source: string
  provider: string
  teammate_id: string | null
  actor_ref: string | null
  date: string
  tool: string
  model: string | null
  cost_type: string | null
  cost_usd: string | null
  input_tokens: string | null
  output_tokens: string | null
  requests: string | null
  region_id: string | null
  org_unit_id: string | null
  cost_owning_unit_id: string | null
  provider_enterprise_id: string | null
}

async function facts(provider?: string): Promise<FactRow[]> {
  const rows = await t.client<FactRow[]>`
    SELECT source, provider, teammate_id::text AS teammate_id, actor_ref, date::text AS date,
           tool, model, cost_type, cost_usd::text AS cost_usd,
           input_tokens::text AS input_tokens, output_tokens::text AS output_tokens,
           requests::text AS requests, region_id::text AS region_id,
           org_unit_id::text AS org_unit_id, cost_owning_unit_id::text AS cost_owning_unit_id,
           provider_enterprise_id::text AS provider_enterprise_id
      FROM provider_usage_fact
     ORDER BY provider, date, tool, COALESCE(model,''), COALESCE(cost_type,'')`
  return provider ? rows.filter((r) => r.provider === provider) : rows
}

async function reset(): Promise<void> {
  await t.client`DELETE FROM provider_usage_fact`
  await t.client`DELETE FROM reconciliation_record`
  await t.client`DELETE FROM copilot_pool_bill`
  await t.client`DELETE FROM actual_spend`
  await t.client`DELETE FROM pending_placement`
  await t.client`UPDATE teammate SET org_unit_id = ${orgA}::uuid WHERE id = ${teammateId}::uuid`
}

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.db.insert(schema.region).values({ code: 'ptxg', displayName: 'PTX GitHub' }).returning()
  regionId = region!.id
  const [a] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ptxg.a', code: 'ptxg-a', displayName: 'PTXG A', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgA = a!.id
  const [b] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ptxg.b', code: 'ptxg-b', displayName: 'PTXG B', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgB = b!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ptxg', email: AN_EMAIL, regionId, orgUnitId: orgA })
    .returning()
  teammateId = tm!.id
  // The governance key the reconcile engine stamps on a github line.
  const [ent] = await t.db
    .insert(schema.providerEnterprise)
    .values({ provider: 'github', externalId: ENTERPRISE, displayName: 'Acme Partner Demo' })
    .returning()
  providerEnterpriseId = ent!.id
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(reset)

// ──────────────────────────────────────────────────────────────────────────────

describe('the arm exists: an enterprise with both providers yields rows for both', () => {
  it("writes provider='github' rows beside provider='anthropic' rows, each under its own source", async () => {
    /*
     * The acceptance criterion, stated as a single assertion: the normalised
     * layer is provider-agnostic, both adapters land in it, and each row carries
     * the right discriminator.
     *
     * MUTATION: delete the GitHub branch from `armFor` in provider-transform.ts
     * → the un-scoped run derives only Anthropic and `providers` is
     * ['anthropic'], red on the first assertion.
     */
    await reconcile([metricsRecord({ credits: 500, modelFeatures: [{ model: 'gpt-5', feature: 'chat', interactions: 4 }] })])
    await runEnterpriseAnalyticsPoll(t.db, anthropicClient(), {
      startingAt: DAY,
      endingAt: DAY,
      externalOrgId: AN_ORG,
    })

    // No `source` option — the orchestrator discovers BOTH lanes.
    const res = await runProviderTransform(t.db, { startingAt: DAY, endingAt: DAY })
    expect(res.sourcesProcessed).toBe(2)

    const rows = await facts()
    const providers = [...new Set(rows.map((r) => r.provider))].sort()
    expect(providers).toEqual(['anthropic', 'github'])

    // Each provider's rows carry ONLY its own source — no cross-talk.
    expect(rows.filter((r) => r.provider === 'github').every((r) => r.source === GH_SOURCE)).toBe(true)
    expect(rows.filter((r) => r.provider === 'anthropic').every((r) => r.source === AN_SOURCE)).toBe(true)
    // The GitHub rows carry the enterprise governance key resolved at reconcile.
    expect(rows.filter((r) => r.provider === 'github').every((r) => r.provider_enterprise_id === providerEnterpriseId)).toBe(true)
  })
})

describe('G1 — conservation with the ledger it derives from', () => {
  it('Σ cost_usd (github) = the live reconciliation_record actual_usd, per (teammate, date, tool, source)', async () => {
    /*
     * The invariant this arm CAN hold. Not `= actual_spend` (Copilot has no
     * per-user actual_spend row) and not `= copilot_pool_bill` (pooled, net,
     * month grain) — the ledger it reads, neither inventing nor losing money.
     *
     * MUTATION: multiply `usd` by 0.9 in deriveGithubFacts's credits row (an
     * "apply the allowance" edit) → the two sides diverge and this goes red.
     */
    await reconcile([
      metricsRecord({
        credits: 562.57, // $5.6257 at the flat $0.01/credit rate
        modelFeatures: [{ model: 'gpt-5', feature: 'chat', interactions: 9 }],
        cliTokens: { prompt: 900, output: 100 },
      }),
    ])
    await transformGithub()

    const [row] = await t.client<{ fact_total: string; ledger_total: string }[]>`
      SELECT
        (SELECT COALESCE(SUM(f.cost_usd), 0)::text
           FROM provider_usage_fact f
          WHERE f.provider = 'github' AND f.source = ${GH_SOURCE}
            AND f.teammate_id = r.teammate_id AND f.date = r.period_date
            AND f.tool = 'copilot-cli') AS fact_total,
        r.actual_usd::text AS ledger_total
      FROM reconciliation_record r
      WHERE r.provider = 'github' AND r.period_date = ${DAY}::date`
    expect(row).toBeTruthy()
    expect(Number(row!.ledger_total)).toBeCloseTo(5.6257, 6)
    expect(Number(row!.fact_total)).toBeCloseTo(Number(row!.ledger_total), 6)

    // And the money sits on exactly ONE row — the day-grain credits row.
    const priced = (await facts('github')).filter((f) => f.cost_usd !== null)
    expect(priced).toHaveLength(1)
    expect(priced[0]!.cost_type).toBe('ai-credits')
    expect(priced[0]!.model).toBeNull()
  })

  /*
   * ── THE LIVE ROW: TWO MECHANISMS, AND THE ONE TEST THAT IS NOT WRITTEN ─────
   *
   * `deriveGithubFacts` picks one ledger row per logical key with two
   * independent guards, and they cover DIFFERENT cases:
   *
   *   status NOT IN ('rejected','superseded')  — a key whose ONLY row is
   *       terminal. DISTINCT ON has nothing to prefer it over and would return
   *       it, booking money that was explicitly withdrawn.
   *   DISTINCT ON + the CASE ordering          — two NON-TERMINAL rows for one
   *       key ('applied' beside a lingering 'proposed', mig 0086:84-87). The
   *       status predicate admits both; only the ordering picks between them.
   *
   * The obvious third fixture — a superseded revision sitting beside its live
   * replacement — is DELIBERATELY ABSENT. It is caught by EITHER guard, so it
   * stays green with either one reverted and cannot pin either: exactly the
   * shape of a test that certifies nothing. It was written, measured against
   * both mutations, found green under both, and removed. The two tests below
   * each go red under a mutation that is stated and was run.
   */
  it('books NOTHING for a key whose only ledger row is terminal', async () => {
    /*
     * Where `status NOT IN ('rejected','superseded')` earns its keep, and it is
     * a money bug rather than a tidiness one: a revision that withdrew the day,
     * or a proposal an operator rejected, would otherwise be booked — and the
     * guarded prune cannot help, because the run re-asserts the row it should
     * have dropped.
     *
     * MUTATION (run): drop `AND r.status NOT IN ('rejected', 'superseded')` from
     * deriveGithubFacts → a rejected day books $10 and this goes red.
     */
    await reconcile([metricsRecord({ credits: 1000, modelFeatures: [{ model: 'gpt-5', feature: 'chat', interactions: 4 }] })])
    await t.client`UPDATE reconciliation_record SET status = 'rejected' WHERE provider = 'github'`
    await transformGithub()

    expect(await facts('github')).toHaveLength(0)
  })

  it("'applied' beats a lingering 'proposed' — two NON-terminal rows still yield one figure", async () => {
    /*
     * The case the status predicate cannot reach: both rows are live by status,
     * so only DISTINCT ON's `CASE status WHEN 'applied' THEN 0 WHEN 'proposed'
     * THEN 1` picks between them. This is mig 0086:84-87's rule, copied so the
     * billed lane and the §A usage view can never report two different Copilot
     * totals for one enterprise.
     *
     * MUTATION: remove the `DISTINCT ON (...)` and its ORDER BY from
     * deriveGithubFacts (leaving a plain SELECT) → both rows contribute, $15,
     * red here. Dropping the status predicate alone leaves this GREEN, which is
     * exactly why it is its own test.
     */
    await reconcile([metricsRecord({ credits: 1000 })])
    await t.client`UPDATE reconciliation_record SET status = 'applied' WHERE provider = 'github'`
    // The partial unique index only covers status='proposed', so the next
    // reconcile INSERTs beside the applied row rather than refreshing it.
    await reconcile([metricsRecord({ credits: 500 })])
    const live = await t.client<{ status: string }[]>`
      SELECT status FROM reconciliation_record WHERE provider = 'github' ORDER BY status`
    expect(live.map((r) => r.status)).toEqual(['applied', 'proposed']) // the fixture is real

    await transformGithub()
    const priced = (await facts('github')).filter((f) => f.cost_usd !== null)
    expect(priced).toHaveLength(1)
    expect(Number(priced[0]!.cost_usd)).toBeCloseTo(10, 6) // the APPLIED row, not the sum
  })
})

describe('G2 — the money is at DAY grain and a ratio cannot be written', () => {
  it('the model dimension carries ACTIVITY and never cost', async () => {
    /*
     * The capture is flat: `ai_credits_used` is at the record root and the model
     * rows carry no credits. Splitting the day across models by activity share
     * would be a ratio — a number the provider never sent, indistinguishable at
     * read time from one it did.
     *
     * MUTATION: in deriveGithubFacts's model loop, set
     * `into.costUsd = usd * (interactions / totalInteractions)` → mig 0120's
     * CHECK rejects the INSERT and the transform throws, red immediately.
     */
    await reconcile([
      metricsRecord({
        credits: 1000,
        modelFeatures: [
          { model: 'gpt-5', feature: 'chat', interactions: 7 },
          { model: 'gpt-5', feature: 'agent', interactions: 3 }, // same model, SECOND feature
          { model: 'claude-sonnet-4-6', feature: 'chat', interactions: 5 },
        ],
      }),
    ])
    await transformGithub()

    const modelRows = (await facts('github')).filter((f) => f.model !== null)
    expect(modelRows).toHaveLength(2)
    const byModel = Object.fromEntries(modelRows.map((r) => [r.model!, r]))
    // One model under two features SUMS; it does not overwrite.
    expect(byModel['gpt-5']!.requests).toBe('10')
    expect(byModel['claude-sonnet-4-6']!.requests).toBe('5')
    for (const r of modelRows) {
      expect(r.cost_usd).toBeNull()
      expect(r.cost_type).toBeNull()
      expect(r.input_tokens).toBeNull()
    }
  })

  it('the schema REFUSES a github row carrying both a model and a cost', async () => {
    /*
     * Written against mig 0120's CHECK rather than the worker, deliberately: the
     * worker is one writer and the constraint is what stops the NEXT one. This
     * is the "never split day-grain credits by a ratio" rule made structural.
     *
     * MUTATION: drop provider_usage_fact_github_money_grain_chk from mig 0120 →
     * the INSERT succeeds and `rejects` never rejects, red.
     */
    const write = (provider: string, model: string | null) =>
      t.client`
        INSERT INTO provider_usage_fact (source, provider, teammate_id, date, tool, model, cost_type, cost_usd)
        VALUES (${GH_SOURCE}, ${provider}, ${teammateId}::uuid, ${DAY}::date, 'copilot-cli', ${model}, 'ai-credits', 1.000000)`

    await expect(write('github', 'gpt-5')).rejects.toThrow(/github_money_grain_chk/)
    // The same shape is LEGAL for Anthropic, which genuinely does send money at
    // model grain (data[].model 255/255 on the cost report). A blanket rule here
    // would have deleted the point of the table.
    await expect(write('anthropic', 'claude-opus-5')).resolves.toBeDefined()
    // And a github row with no model is legal — that is where the money goes.
    await expect(write('github', null)).resolves.toBeDefined()
  })

  it('CLI tokens land at DAY grain with model NULL, and are absent when the wire is silent', async () => {
    /*
     * `totals_by_cli` has no model beneath it, so its tokens can never be
     * attributed to a model from this surface. It is also SPARSE — 47/200
     * stored records carry it — and absence must mean "no CLI use", never a
     * fabricated zero row.
     *
     * MUTATION: return `{input: 0, output: 0}` instead of null from
     * deriveCliTokens when the subtree is absent → the second case gains a
     * phantom token row and goes red.
     */
    await reconcile([metricsRecord({ credits: 100, cliTokens: { prompt: 900, output: 100 } })])
    await transformGithub()
    const withCli = (await facts('github')).filter((f) => f.input_tokens !== null)
    expect(withCli).toHaveLength(1)
    expect(withCli[0]!.model).toBeNull()
    expect(withCli[0]!.cost_type).toBeNull()
    expect(withCli[0]!.input_tokens).toBe('900')
    expect(withCli[0]!.output_tokens).toBe('100')
    expect(withCli[0]!.cost_usd).toBeNull()

    await reset()
    await reconcile([metricsRecord({ credits: 100 })]) // no totals_by_cli
    await transformGithub()
    expect((await facts('github')).filter((f) => f.input_tokens !== null)).toHaveLength(0)
  })

  it('every measure is single-homed, so one GROUP BY cannot double count', async () => {
    /*
     * Cost on the credits row alone, tokens on the CLI row alone, `requests`
     * only on model rows. `totals_by_cli.request_count` is deliberately NOT
     * written for this reason.
     *
     * MUTATION: add `into.requests = tokens.requestCount` to the CLI token row →
     * the requests total becomes 19 and this goes red.
     */
    await reconcile([
      metricsRecord({
        credits: 1000,
        modelFeatures: [{ model: 'gpt-5', feature: 'chat', interactions: 10 }],
        cliTokens: { prompt: 900, output: 100 },
      }),
    ])
    await transformGithub()

    const [totals] = await t.client<{ cost: string; tokens: string; reqs: string; rows: string }[]>`
      SELECT SUM(cost_usd)::text AS cost,
             SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0))::text AS tokens,
             SUM(requests)::text AS reqs,
             COUNT(*)::text AS rows
        FROM provider_usage_fact WHERE provider = 'github'`
    expect(totals!.rows).toBe('3') // credits + one model + cli tokens
    expect(Number(totals!.cost)).toBeCloseTo(10, 6)
    expect(Number(totals!.tokens)).toBe(1000)
    expect(Number(totals!.reqs)).toBe(10)
  })
})

describe('G3 — the pooled bill is independent, and disagreeing with it breaks nothing', () => {
  it('a copilot_pool_bill that contradicts the summed consumption changes no fact row', async () => {
    /*
     * The acceptance criterion: "a fixture where Copilot's pooled bill and
     * per-user consumption disagree does NOT break it". They disagree by
     * construction — the bill is NET of the included allowance and POOLED at
     * (org, sku, month), the consumption is GROSS and per user — so an invariant
     * that broke here would be an invariant this arm must never have claimed.
     *
     * MUTATION: make deriveGithubFacts read copilot_pool_bill to net the
     * consumption down → G1's totals move with the bill and both this test and
     * G1 go red.
     */
    await reconcile([metricsRecord({ credits: 1000, modelFeatures: [{ model: 'gpt-5', feature: 'chat', interactions: 4 }] })])
    await transformGithub()
    const before = await facts('github')

    // The invoice says something else entirely: $3.50 net after a $6.50
    // allowance, pooled at the enterprise, for the whole month.
    await t.client`
      INSERT INTO copilot_pool_bill (month, provider_enterprise_id, license_net_usd,
                                     included_allowance_usd, usage_gross_usd, overage_net_usd)
      VALUES ('2026-08-01'::date, ${providerEnterpriseId}::uuid, 190.000000, 6.500000, 10.000000, 3.500000)`

    await transformGithub()
    const after = await facts('github')
    expect(after).toEqual(before)

    // G1 still holds against the LEDGER, untouched by the invoice.
    const [row] = await t.client<{ fact_total: string; ledger_total: string }[]>`
      SELECT (SELECT COALESCE(SUM(f.cost_usd), 0)::text
                FROM provider_usage_fact f
               WHERE f.provider = 'github' AND f.teammate_id = r.teammate_id
                 AND f.date = r.period_date) AS fact_total,
             r.actual_usd::text AS ledger_total
        FROM reconciliation_record r WHERE r.provider = 'github'`
    expect(Number(row!.fact_total)).toBeCloseTo(10, 6)
    expect(Number(row!.ledger_total)).toBeCloseTo(10, 6)
    // …and it is deliberately NOT the invoice's $3.50 net or $193.50 total.
    expect(Number(row!.fact_total)).not.toBeCloseTo(3.5, 2)
  })
})

describe('G4 — the Anthropic arm is untouched by the new neighbour', () => {
  it("Σ provider_usage_fact.cost_usd = actual_spend.cost_usd still holds with github rows in the table", async () => {
    /*
     * The Anthropic arm's own invariant, re-proven with a second provider
     * sharing the table. It holds because both the fact side and the comparison
     * side are scoped by source, which is provider-specific by construction.
     *
     * MUTATION: drop `f.source = a.source` from the correlated subquery → the
     * github credits fold into the Anthropic comparison and this goes red.
     */
    await reconcile([metricsRecord({ credits: 1000 })])
    await runEnterpriseAnalyticsPoll(t.db, anthropicClient(), {
      startingAt: DAY,
      endingAt: DAY,
      externalOrgId: AN_ORG,
    })
    await runProviderTransform(t.db, { startingAt: DAY, endingAt: DAY })

    const [row] = await t.client<{ fact_total: string; spend_total: string }[]>`
      SELECT (SELECT COALESCE(SUM(f.cost_usd), 0)::text
                FROM provider_usage_fact f
               WHERE f.teammate_id = a.teammate_id AND f.date = a.date
                 AND f.tool = a.tool AND f.source = a.source
                 AND f.cost_type NOT IN ('web_search', 'code_execution')) AS fact_total,
             a.cost_usd::text AS spend_total
        FROM actual_spend a
       WHERE a.source = ${AN_SOURCE} AND a.date = ${DAY}::date AND a.tool = 'claude-code'`
    expect(Number(row!.spend_total)).toBeCloseTo(13, 6)
    expect(Number(row!.fact_total)).toBeCloseTo(Number(row!.spend_total), 6)
  })
})

describe('identity, homing and the write pattern', () => {
  it('carries the provider login as actor_ref, and homes on the ledger teammate', async () => {
    await reconcile([metricsRecord({ credits: 100 })])
    await transformGithub()
    for (const f of await facts('github')) {
      expect(f.teammate_id).toBe(teammateId)
      expect(f.actor_ref).toBe(LOGIN)
      expect(f.org_unit_id).toBe(orgA)
      expect(f.cost_owning_unit_id).toBe(orgA)
      expect(f.region_id).toBe(regionId)
    }
  })

  it('a re-transform after a reorg does NOT re-home the github rows', async () => {
    /*
     * The shared upsert's SET-list omission, proven on the SECOND arm. Both arms
     * go through `upsertProviderUsageFact`, so a homing column added to that SET
     * list turns this AND the Anthropic suite's twin red at once — which is the
     * reason the statement is shared rather than written per arm.
     *
     * MUTATION: add `org_unit_id = EXCLUDED.org_unit_id` to the DO UPDATE SET
     * list in provider-fact.ts → the second assertion sees orgB, red.
     */
    await reconcile([metricsRecord({ credits: 100 })])
    await transformGithub()
    expect((await facts('github')).every((f) => f.org_unit_id === orgA)).toBe(true)

    await t.client`UPDATE teammate SET org_unit_id = ${orgB}::uuid WHERE id = ${teammateId}::uuid`
    await reconcile([metricsRecord({ credits: 250 })]) // the provider revises the day
    await transformGithub()

    const after = await facts('github')
    const priced = after.find((f) => f.cost_usd !== null)!
    expect(Number(priced.cost_usd)).toBeCloseTo(2.5, 6) // the MONEY refreshed…
    expect(after.every((f) => f.org_unit_id === orgA)).toBe(true) // …the homing did NOT
  })

  it('is idempotent, and prunes a model the provider stopped reporting', async () => {
    await reconcile([
      metricsRecord({
        credits: 100,
        modelFeatures: [
          { model: 'gpt-5', feature: 'chat', interactions: 4 },
          { model: 'claude-sonnet-4-6', feature: 'chat', interactions: 2 },
        ],
      }),
    ])
    const first = await transformGithub()
    const afterFirst = await facts('github')
    expect(afterFirst).toHaveLength(3) // credits + two models

    const second = await transformGithub()
    expect(await facts('github')).toEqual(afterFirst)
    expect(second.factRowsUpserted).toBe(first.factRowsUpserted)
    expect(second.factRowsPruned).toBe(0)

    // The provider revises the day down to one model.
    await reconcile([metricsRecord({ credits: 100, modelFeatures: [{ model: 'gpt-5', feature: 'chat', interactions: 4 }] })])
    const third = await transformGithub()
    const rows = await facts('github')
    expect(rows).toHaveLength(2)
    expect(rows.filter((f) => f.model !== null).map((f) => f.model)).toEqual(['gpt-5'])
    expect(third.factRowsPruned).toBe(1)
  })

  it('handles the MERGED envelope the engine writes when one teammate has two logins', async () => {
    /*
     * `aggregateByConflictKey` merges lines on (…, teammateId) and makes `raw`
     * an ARRAY of the contributors' raws (engine.ts:166). Reading it as a single
     * object would silently lose the second login's whole model dimension.
     *
     * MUTATION: drop the `Array.isArray` branch from `rawEnvelopes` → only one
     * model row survives and the length assertion goes red.
     */
    await reconcile([
      metricsRecord({ credits: 100, login: 'login-one', modelFeatures: [{ model: 'gpt-5', feature: 'chat', interactions: 4 }] }),
      metricsRecord({ credits: 200, login: 'login-two', modelFeatures: [{ model: 'claude-sonnet-4-6', feature: 'chat', interactions: 6 }] }),
    ])
    await transformGithub()

    const rows = await facts('github')
    expect(rows.filter((f) => f.model !== null).map((f) => f.model).sort()).toEqual(['claude-sonnet-4-6', 'gpt-5'])
    // The credits merged into ONE ledger row, so one credits fact for both.
    const priced = rows.filter((f) => f.cost_usd !== null)
    expect(priced).toHaveLength(1)
    expect(Number(priced[0]!.cost_usd)).toBeCloseTo(3, 6)
    // No single provider id owns this row, and the arm refuses to pick one.
    expect(priced[0]!.actor_ref).toBeNull()
  })
})

describe('scoping', () => {
  it('refuses a source no arm claims rather than deriving nothing and pruning its window', async () => {
    /*
     * The failure mode this guard exists for is DATA LOSS, not a no-op: a run
     * that derives nothing and then prunes deletes rows it never had the ability
     * to re-assert.
     */
    await expect(
      runProviderTransform(t.db, { startingAt: DAY, endingAt: DAY, source: 'copilot-seat:acme' }),
    ).rejects.toThrow(/no arm claims source/)
    await expect(
      runProviderTransform(t.db, { startingAt: DAY, endingAt: DAY, source: 'copilot-consumption:' }),
    ).rejects.toThrow(/no arm claims source/)
  })

  it('a github-scoped run never touches the anthropic rows, and vice versa', async () => {
    await reconcile([metricsRecord({ credits: 100 })])
    await runEnterpriseAnalyticsPoll(t.db, anthropicClient(), {
      startingAt: DAY,
      endingAt: DAY,
      externalOrgId: AN_ORG,
    })
    await runProviderTransform(t.db, { startingAt: DAY, endingAt: DAY })
    const anthropicBefore = await facts('anthropic')
    expect(anthropicBefore.length).toBeGreaterThan(0)

    // Re-run ONLY the github lane. Its prune is scoped to its own source, so the
    // Anthropic rows — which this run never re-asserted — must survive.
    await transformGithub()
    expect(await facts('anthropic')).toEqual(anthropicBefore)
  })
})

// ──────────────────────────────────────────────────────────────────────────────

/** A minimal Anthropic enterprise client: $13.00 of claude-code on DAY. */
function anthropicClient(): AnthropicEnterpriseClient {
  const actor = { type: 'user_actor', email: AN_EMAIL, deleted: false }
  return {
    getUserUsageReport: async () => ({
      has_more: false,
      next_page: null,
      data: [
        {
          actor,
          product: 'claude_code',
          model: 'claude-opus-5',
          uncached_input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
          total_tokens: 1500,
          requests: 3,
        },
      ],
    }),
    getUserCostReport: async () => ({
      has_more: false,
      next_page: null,
      data: [
        { actor, currency: 'USD', amount: '1300', cost_type: 'tokens', product: 'claude_code', model: 'claude-opus-5', requests: null },
      ],
    }),
  } as unknown as AnthropicEnterpriseClient
}
