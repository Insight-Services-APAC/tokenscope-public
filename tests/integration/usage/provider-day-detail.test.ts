// @vitest-environment node
/*
 * Provider-recorded day detail — the read behind GET /me/unaccounted/{id}.
 * Design: docs/design/reporting-consolidation/05-api-sourced-usage-carries-its-
 * dimensions.md work item 2.
 *
 * Every assertion here was verified to FAIL with its fix reverted; the mutation
 * that reddens each one is recorded above it, and they are listed in the commit
 * message. Assertions are written against real rows in a real Postgres and the
 * real `fetchProviderDayDetail`, never a hand-shaped payload.
 *
 * The property under test throughout is that the panel reports what the PROVIDER
 * SENT for the key — no proportion, no apportionment, no ratio. The residual is
 * never split across models here; that is the separate contested question in
 * Decision 1 of the design, and nothing in this file touches it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { fetchProviderDayDetail } from '../../../server/usage/provider-day-detail'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let teammateId = ''
let otherTeammateId = ''

const DAY = '2026-07-15'
const CLAUDE = 'claude-code'
const COPILOT = 'copilot-cli'
const SRC_A = 'anthropic-analytics-api:org-a'
const SRC_B = 'anthropic-analytics-api:org-b'
const SRC_GH = 'copilot-consumption:ent-1'

/** The taggable record — one per (teammate, day, tool), as mig 0071 keys it. */
async function mkFill(opts: {
  tool?: string
  costUsd?: string
  tokens?: number
  teammate?: string
}): Promise<string> {
  const [r] = await t.db
    .insert(schema.unaccountedUsage)
    .values({
      teammateId: opts.teammate ?? teammateId,
      regionId,
      orgUnitId,
      day: DAY,
      tool: opts.tool ?? CLAUDE,
      costUsd: opts.costUsd ?? '20.000000',
      tokens: BigInt(opts.tokens ?? 0),
      source: 'api-reconciled',
    })
    .returning({ id: schema.unaccountedUsage.id })
  return r!.id
}

/*
 * A COST row: cost_type set, every token column NULL
 * (provider_usage_fact_measure_chk). provider_usage_fact is not in the Drizzle
 * schema — it is hand-written DDL — so these go in as raw SQL.
 */
async function costFact(o: {
  source?: string
  provider?: string
  tool?: string
  model: string | null
  costUsd: string
  costType?: string
}): Promise<void> {
  await t.client`
    INSERT INTO provider_usage_fact
      (source, provider, teammate_id, date, tool, model, cost_type, cost_usd, dimension_source)
    VALUES (${o.source ?? SRC_A}, ${o.provider ?? 'anthropic'}, ${teammateId}::uuid,
            ${DAY}::date, ${o.tool ?? CLAUDE}, ${o.model}, ${o.costType ?? 'tokens'},
            ${o.costUsd}::numeric, 'ingest-snapshot')`
}

/* A TOKEN row: cost_type NULL, cost_usd NULL, the token lanes + requests. */
async function tokenFact(o: {
  source?: string
  provider?: string
  tool?: string
  model: string | null
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  requests?: number
  webSearches?: number | null
}): Promise<void> {
  await t.client`
    INSERT INTO provider_usage_fact
      (source, provider, teammate_id, date, tool, model, cost_type,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       requests, web_search_requests, dimension_source)
    VALUES (${o.source ?? SRC_A}, ${o.provider ?? 'anthropic'}, ${teammateId}::uuid,
            ${DAY}::date, ${o.tool ?? CLAUDE}, ${o.model}, NULL,
            ${o.input ?? 0}, ${o.output ?? 0}, ${o.cacheRead ?? 0}, ${o.cacheWrite ?? 0},
            ${o.requests ?? 0}, ${o.webSearches ?? null}, 'ingest-snapshot')`
}

/*
 * The GitHub arm's rows AT THE SHAPES THE WORKER ACTUALLY WRITES
 * (provider-transform-github.ts, the three-row-shape table): a MODEL row
 * carries ONLY `requests` — model non-null, cost_type NULL, cost NULL, every
 * token column NULL — and the CLI TOKEN row carries ONLY tokens (model NULL,
 * requests NULL). `tokenFact` above defaults the token lanes and `requests`
 * to 0, which is a DIFFERENT claim ("measured zero") from the one these rows
 * make ("not measured") — and that difference is exactly what the Copilot
 * suite below is about.
 */
async function githubModelFact(o: { model: string; requests: number; tool?: string }): Promise<void> {
  await t.client`
    INSERT INTO provider_usage_fact
      (source, provider, teammate_id, date, tool, model, cost_type, requests, dimension_source)
    VALUES (${SRC_GH}, 'github', ${teammateId}::uuid, ${DAY}::date, ${o.tool ?? COPILOT},
            ${o.model}, NULL, ${o.requests}, 'ingest-snapshot')`
}
async function githubCliTokenFact(o: { input: number; output: number; tool?: string }): Promise<void> {
  await t.client`
    INSERT INTO provider_usage_fact
      (source, provider, teammate_id, date, tool, model, cost_type,
       input_tokens, output_tokens, dimension_source)
    VALUES (${SRC_GH}, 'github', ${teammateId}::uuid, ${DAY}::date, ${o.tool ?? COPILOT},
            NULL, NULL, ${o.input}, ${o.output}, 'ingest-snapshot')`
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'pd', displayName: 'PD' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'pd', code: 'pd-bu', displayName: 'PD', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-pd', email: 'pd@x.test', regionId, orgUnitId })
    .returning()
  teammateId = tm!.id
  const [tm2] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-pd2', email: 'pd2@x.test', regionId, orgUnitId })
    .returning()
  otherTeammateId = tm2!.id
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM provider_usage_fact`
  await t.client`DELETE FROM unaccounted_usage`
})

describe('provider-day detail — observed rows', () => {
  /*
   * MUTATION: in provider-day-detail.ts drop `model` from the by_model CTE's
   * GROUP BY (or hardcode `null`) — the two models collapse into one bucket and
   * both the length and the per-model costs below go red.
   */
  it('reports the provider’s own per-model cost for the key', async () => {
    const id = await mkFill({ costUsd: '30.000000' })
    await costFact({ model: 'claude-opus-4', costUsd: '20.000000' })
    await costFact({ model: 'claude-sonnet-4', costUsd: '10.000000' })

    const d = await fetchProviderDayDetail(t.db, teammateId, id)

    expect(d).not.toBeNull()
    expect(d!.detail_state).toBe('observed')
    expect(d!.provider_cost_usd).toBe('30.00')
    expect(d!.by_model.map((m) => [m.model, m.cost_usd])).toEqual([
      ['claude-opus-4', '20.00'],
      ['claude-sonnet-4', '10.00'],
    ])
    // Non-vacuous: rows WITH a model exist after the read, not merely that it ran.
    expect(d!.by_model.filter((m) => m.model !== null).length).toBe(2)
    expect(d!.by_model.every((m) => m.null_model_reason === null)).toBe(true)
  })

  /*
   * DECISION 4 — a model's dollar share is NOT its token share.
   *
   * Seeded so the two disagree sharply: opus holds 90% of the cost and 10% of
   * the tokens. A cost-proportional token split would give opus 90 000 of the
   * 100 000 tokens; the token rows say 10 000.
   *
   * MUTATION: compute a model's tokens as `total_tokens * (model_cost /
   * total_cost)` instead of reading the token aggregate — opus reads 90 000 and
   * sonnet 10 000, and both expectations below go red.
   */
  it('takes per-model tokens from the token rows, never from the cost proportion', async () => {
    const id = await mkFill({ costUsd: '100.000000' })
    await costFact({ model: 'claude-opus-4', costUsd: '90.000000' })
    await costFact({ model: 'claude-sonnet-4', costUsd: '10.000000' })
    await tokenFact({ model: 'claude-opus-4', input: 6_000, output: 4_000 })
    await tokenFact({ model: 'claude-sonnet-4', input: 60_000, output: 30_000 })

    const d = await fetchProviderDayDetail(t.db, teammateId, id)

    const byModel = Object.fromEntries(d!.by_model.map((m) => [m.model, m]))
    expect(byModel['claude-opus-4']!.cost_usd).toBe('90.00')
    expect(byModel['claude-opus-4']!.tokens).toBe(10_000)
    expect(byModel['claude-sonnet-4']!.cost_usd).toBe('10.00')
    expect(byModel['claude-sonnet-4']!.tokens).toBe(90_000)
    expect(d!.tokens).toBe(100_000)
  })

  /*
   * MUTATION: drop cache_read_tokens/cache_creation_tokens from the lane
   * scalars in `totals` — the cache lanes disappear from by_token_type and the
   * lane list below goes red. (Cache SAVINGS is deliberately absent: it would
   * price tokens at a rate divided out of disjoint cost and token rows.)
   */
  /*
   * Copilot review (PR #231). `provider_usage_fact_measure_chk` keeps cost rows
   * and token rows DISJOINT, so a model can be observed with tokens before any
   * cost row for it exists. Coercing that to '0.00' asserts a measurement
   * nobody made — and does it beside a `provider_cost_usd` that is correctly
   * null, so one card answers one question two ways.
   *
   * MUTATION: restore `cost_usd: usd(g.cost_usd ?? 0)` — the null expectation
   * below goes red. (The drawer's own suite cannot catch this: it mocks fetch
   * and never reaches the endpoint.)
   */
  it('reports an unpriced model as unknown cost, never $0.00', async () => {
    const id = await mkFill({ costUsd: '40.000000' })
    await costFact({ model: 'claude-opus-4', costUsd: '40.000000' })
    // Tokens observed for sonnet; no cost row for it yet.
    await tokenFact({ model: 'claude-sonnet-4', input: 60_000, output: 30_000 })

    const d = await fetchProviderDayDetail(t.db, teammateId, id)

    const byModel = Object.fromEntries(d!.by_model.map((m) => [m.model, m]))
    expect(byModel['claude-opus-4']!.cost_usd).toBe('40.00')
    // The unpriced one reports its OBSERVED dimensions and no dollars.
    expect(byModel['claude-sonnet-4']!.cost_usd).toBeNull()
    expect(byModel['claude-sonnet-4']!.tokens).toBe(90_000)
  })

  it('reports the four observed token lanes, cache included, and no lane cost', async () => {
    const id = await mkFill({})
    await tokenFact({ model: 'claude-opus-4', input: 100, output: 200, cacheRead: 300, cacheWrite: 400 })

    const d = await fetchProviderDayDetail(t.db, teammateId, id)

    expect(d!.by_token_type).toEqual([
      { token_type: 'input', tokens: 100 },
      { token_type: 'output', tokens: 200 },
      { token_type: 'cache-read', tokens: 300 },
      { token_type: 'cache-write', tokens: 400 },
    ])
    // The lane carries tokens ONLY — a cost on it could only come from a ratio.
    for (const lane of d!.by_token_type) expect(Object.keys(lane).sort()).toEqual(['token_type', 'tokens'])
  })

  /*
   * MUTATION: replace `SUM(web_search_requests)` with
   * `COALESCE(SUM(web_search_requests), 0)` — the "did not carry the field" case
   * below reads 0 instead of null and its assertion goes red.
   */
  it('keeps "the provider did not carry web searches" distinct from "it reported zero"', async () => {
    const idNone = await mkFill({})
    await tokenFact({ model: 'claude-opus-4', input: 10, webSearches: null })
    const none = await fetchProviderDayDetail(t.db, teammateId, idNone)
    expect(none!.web_search_requests).toBeNull()

    await t.client`DELETE FROM provider_usage_fact`
    await tokenFact({ model: 'claude-opus-4', input: 10, webSearches: 0 })
    const zero = await fetchProviderDayDetail(t.db, teammateId, idNone)
    expect(zero!.web_search_requests).toBe(0)

    await t.client`DELETE FROM provider_usage_fact`
    await tokenFact({ model: 'claude-opus-4', input: 10, webSearches: 7 })
    const some = await fetchProviderDayDetail(t.db, teammateId, idNone)
    expect(some!.web_search_requests).toBe(7)
  })
})

describe('provider-day detail — Copilot model rows carry their requests', () => {
  /*
   * THE DEV 2026-08-04 DRAWER DEFECT, pinned at the read. A Copilot day's three
   * row shapes (provider-transform-github.ts): CREDITS ($, model NULL), CLI
   * TOKENS (model NULL), and MODEL rows that exist PRECISELY to carry
   * `requests` = totals_by_model_feature[].user_initiated_interaction_count —
   * with cost NULL and every token column NULL, because Copilot never measures
   * money or tokens at model grain.
   *
   * The read must hand each model to the drawer with its OBSERVED requests, and
   * with tokens/cost NULL — not 0. `SUM(COALESCE(requests, 0))` and the token
   * COALESCE fabricated a "measured zero" for every never-measured cell, which
   * is the #231 unknown-stays-unknown defect: a payload zero is a claim the
   * provider recorded nothing, and it renders identically to a value that was
   * silently lost.
   *
   * MUTATION: restore `SUM(COALESCE(requests, 0))` (or the unconditional token
   * COALESCE) in provider-day-detail.ts's by_model CTE — the null expectations
   * below read 0 and go red. Drop `model` from that CTE's GROUP BY — the
   * day-grain row absorbs the model rows and the length assertion goes red.
   */
  it('hands each model to the drawer with its requests; unmeasured tokens/cost stay null', async () => {
    const id = await mkFill({ tool: COPILOT, costUsd: '31.900000', tokens: 52_760_000 })
    await costFact({
      source: SRC_GH, provider: 'github', tool: COPILOT,
      model: null, costType: 'ai-credits', costUsd: '31.900000',
    })
    await githubCliTokenFact({ input: 50_000_000, output: 2_760_000 })
    await githubModelFact({ model: 'haiku', requests: 41 })
    await githubModelFact({ model: 'gpt-5.6-sol', requests: 7 })

    const d = await fetchProviderDayDetail(t.db, teammateId, id)

    // The day-grain money row must NOT absorb the model rows.
    expect(d!.by_model.length).toBe(3)

    const byModel = Object.fromEntries(d!.by_model.map((m) => [m.model ?? 'DAY_GRAIN', m]))
    // Each model carries ITS OWN observed requests count…
    expect(byModel['haiku']!.requests).toBe(41)
    expect(byModel['gpt-5.6-sol']!.requests).toBe(7)
    // …and what Copilot never measures at model grain stays UNKNOWN, never 0.
    expect(byModel['haiku']!.tokens).toBeNull()
    expect(byModel['haiku']!.cost_usd).toBeNull()
    expect(byModel['gpt-5.6-sol']!.tokens).toBeNull()
    expect(byModel['gpt-5.6-sol']!.cost_usd).toBeNull()

    // The day-grain bucket holds what IS day grain — the money and the CLI
    // tokens — and no requests figure, fabricated or absorbed.
    expect(byModel['DAY_GRAIN']!.cost_usd).toBe('31.90')
    expect(byModel['DAY_GRAIN']!.tokens).toBe(52_760_000)
    expect(byModel['DAY_GRAIN']!.requests).toBeNull()
    expect(byModel['DAY_GRAIN']!.null_model_reason).toBe('provider-reports-day-grain')

    // The day totals are the sums of what WAS measured.
    expect(d!.requests).toBe(48)
    expect(d!.tokens).toBe(52_760_000)
    expect(d!.provider_cost_usd).toBe('31.90')
  })
})

describe('provider-day detail — the zero-fact-row case', () => {
  /*
   * DECISION 3 — specified, not discovered. A key can hold a fill with no
   * supporting fact rows for up to an hour (the two writers run on different
   * cadences), most likely TODAY.
   *
   * MUTATION: delete the `factRows === 0` branch in provider-day-detail.ts —
   * by_model comes back empty, provider_cost_usd is null and the residual is
   * silently dropped from the panel. Every expectation below goes red.
   */
  it('renders the whole residual in a disclosed bucket — never null, never $0', async () => {
    const id = await mkFill({ costUsd: '42.500000', tokens: 1_234 })

    const d = await fetchProviderDayDetail(t.db, teammateId, id)

    expect(d!.detail_state).toBe('awaiting-provider-detail')
    expect(d!.by_model).toEqual([
      {
        model: null,
        cost_usd: '42.50',
        tokens: 1_234,
        // Null, not 0: no provider row has measured requests for this key yet.
        requests: null,
        null_model_reason: 'awaiting-provider-detail',
      },
    ])
    // The money is present and is the residual — not null, not zero, not dropped.
    expect(d!.by_model[0]!.cost_usd).not.toBe('0.00')
    expect(d!.unallocated_cost_usd).toBe('42.50')
    // NULL rather than '0.00': "$0.00 recorded" is a different claim from
    // "nothing derived yet", and the panel must not make the first one.
    expect(d!.provider_cost_usd).toBeNull()
    expect(d!.source_count).toBe(0)
  })

  /*
   * DECISION 3, second half — the transient gap must be DISTINGUISHABLE from
   * Copilot's structural day-grain bucket. Reusing one label for both makes the
   * bucket look like it flickers per refresh, which is worse for trust than a
   * static one.
   *
   * MUTATION: return the same `null_model_reason` for both branches (e.g. always
   * 'awaiting-provider-detail') — the inequality assertion goes red.
   */
  it('is distinguishable from Copilot’s structural day-grain bucket', async () => {
    const transientId = await mkFill({ costUsd: '5.000000' })
    const transient = await fetchProviderDayDetail(t.db, teammateId, transientId)

    const structuralId = await mkFill({ tool: COPILOT, costUsd: '9.000000' })
    // Copilot's money is day grain: mig 0120's github_money_grain_chk makes a
    // github row carrying BOTH a model and a cost a constraint violation.
    await costFact({
      source: SRC_GH,
      provider: 'github',
      tool: COPILOT,
      model: null,
      costType: 'ai-credits',
      costUsd: '9.000000',
    })
    const structural = await fetchProviderDayDetail(t.db, teammateId, structuralId)

    expect(transient!.by_model[0]!.null_model_reason).toBe('awaiting-provider-detail')
    expect(structural!.by_model[0]!.null_model_reason).toBe('provider-reports-day-grain')
    expect(structural!.by_model[0]!.null_model_reason).not.toBe(
      transient!.by_model[0]!.null_model_reason,
    )
    expect(structural!.detail_state).toBe('observed')
  })

  /*
   * MUTATION: attribute the credits row's money onto the model rows (e.g. join
   * the github MODEL rows to the credits total) — the model row's cost stops
   * being '0.00' and the bucket stops holding the full $9.
   */
  it('never splits Copilot day-grain money across its model rows', async () => {
    const id = await mkFill({ tool: COPILOT, costUsd: '9.000000' })
    await costFact({
      source: SRC_GH, provider: 'github', tool: COPILOT,
      model: null, costType: 'ai-credits', costUsd: '9.000000',
    })
    // The GitHub arm's MODEL row: the dimension, carrying ACTIVITY and no money.
    await tokenFact({ source: SRC_GH, provider: 'github', tool: COPILOT, model: 'gpt-5', requests: 12 })

    const d = await fetchProviderDayDetail(t.db, teammateId, id)

    const bucket = d!.by_model.find((m) => m.model === null)!
    const gpt = d!.by_model.find((m) => m.model === 'gpt-5')!
    expect(bucket.cost_usd).toBe('9.00')
    /*
     * NULL, not '0.00'. GitHub does not report zero dollars against gpt-5 — it
     * reports the money at DAY grain and attributes none of it per model, so
     * this model's share is unknown, not measured-as-nothing. The whole $9 is
     * in the bucket above, which is where the money actually is.
     *
     * A provider that genuinely reported $0.00 for a model still reads '0.00':
     * that is a cost row whose value is zero, not an absent cost row.
     */
    expect(gpt.cost_usd).toBeNull()
    expect(gpt.requests).toBe(12)
    expect(d!.requests).toBe(12)
  })
})

describe('provider-day detail — the join spans source', () => {
  /*
   * DECISION 5 — `unaccounted_usage` keys on (teammate_id, day, tool) with no
   * source component (mig 0071); `provider_usage_fact`'s grain LEADS with source
   * (mig 0118). A teammate with licences in two provider orgs has ONE fill row
   * against TWO orgs' rows.
   *
   * MUTATION: add `AND f.source = <one source>` to the facts join in
   * provider-day-detail.ts — org B's $10 and its model vanish, and the total,
   * the model list and source_count all go red.
   */
  it('aggregates a multi-org teammate-day across sources — neither dropped nor doubled', async () => {
    const id = await mkFill({ costUsd: '25.000000' })
    await costFact({ source: SRC_A, model: 'claude-opus-4', costUsd: '15.000000' })
    await costFact({ source: SRC_B, model: 'claude-sonnet-4', costUsd: '10.000000' })
    await tokenFact({ source: SRC_A, model: 'claude-opus-4', input: 1_000, requests: 3 })
    await tokenFact({ source: SRC_B, model: 'claude-sonnet-4', input: 2_000, requests: 4 })

    const d = await fetchProviderDayDetail(t.db, teammateId, id)

    expect(d!.source_count).toBe(2)
    expect(d!.provider_cost_usd).toBe('25.00')
    expect(d!.by_model.map((m) => m.model)).toEqual(['claude-opus-4', 'claude-sonnet-4'])
    expect(d!.tokens).toBe(3_000)
    expect(d!.requests).toBe(7)
  })

  /*
   * The same MODEL seen in two orgs is ONE row summed once, not two rows and not
   * a doubled one — and every measure on it is the SUM across sources.
   *
   * MUTATION: add `source` to the by_model CTE's GROUP BY — the model appears
   * twice and the length assertion goes red. Replace `SUM(requests)` with
   * `MAX(requests)` — the row reads 4 instead of 7 and the requests assertion
   * goes red (sol review 2026-08-04: only same-model-across-sources exercises
   * that distinction; the multi-org test above has one model per source).
   */
  it('sums one model seen in two orgs into a single row', async () => {
    const id = await mkFill({ costUsd: '12.000000' })
    await costFact({ source: SRC_A, model: 'claude-opus-4', costUsd: '7.000000' })
    await costFact({ source: SRC_B, model: 'claude-opus-4', costUsd: '5.000000' })
    await tokenFact({ source: SRC_A, model: 'claude-opus-4', input: 1_000, requests: 3 })
    await tokenFact({ source: SRC_B, model: 'claude-opus-4', input: 2_000, requests: 4 })

    const d = await fetchProviderDayDetail(t.db, teammateId, id)

    expect(d!.by_model.length).toBe(1)
    expect(d!.by_model[0]!.cost_usd).toBe('12.00')
    expect(d!.by_model[0]!.tokens).toBe(3_000)
    expect(d!.by_model[0]!.requests).toBe(7)
    expect(d!.source_count).toBe(2)
  })
})

describe('provider-day detail — one statement, one grain, one owner', () => {
  /*
   * DECISION 2 — the total and its breakdown come from ONE statement.
   * `unaccounted_usage` recomputes 2-hourly and `provider_usage_fact` hourly, in
   * separate transactions under READ COMMITTED, so two independently-issued
   * queries can straddle a commit and show a breakdown that does not belong to
   * the total the user just clicked.
   *
   * Counted at the `tx.execute` seam, which is the only way this read reaches
   * the database.
   *
   * MUTATION: split the CTE into a fill query and a facts query — the count
   * becomes 2 and this goes red.
   */
  it('issues exactly one database round trip', async () => {
    const id = await mkFill({ costUsd: '11.000000' })
    await costFact({ model: 'claude-opus-4', costUsd: '11.000000' })

    let calls = 0
    const counting = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return (...args: unknown[]) => {
            calls += 1
            return (target.execute as (...a: unknown[]) => unknown)(...args)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as typeof t.db

    const d = await fetchProviderDayDetail(counting, teammateId, id)

    expect(calls).toBe(1)
    // Non-vacuous: the single round trip really did return the breakdown.
    expect(d!.by_model.length).toBe(1)
    expect(d!.provider_cost_usd).toBe('11.00')
  })

  /*
   * A GRAIN test, so a later fan-out of arm 2 fails loudly here rather than
   * silently turning one tagging decision into several. Mig 0071's
   * unaccounted_usage_teammate_day_tool_unique is what makes "a day is ONE
   * taggable thing that carries a breakdown" true.
   *
   * MUTATION: drop the unique constraint — the second insert succeeds and the
   * rejection assertion goes red.
   */
  it('keeps one taggable row per (teammate, day, tool)', async () => {
    await mkFill({ costUsd: '1.000000' })
    await expect(mkFill({ costUsd: '2.000000' })).rejects.toThrow()
    // A different tool on the same day IS a different record.
    await expect(mkFill({ tool: COPILOT, costUsd: '3.000000' })).resolves.toBeTruthy()
  })

  /*
   * Ownership is the WHERE clause: a record that belongs to someone else is
   * indistinguishable from one that does not exist.
   *
   * MUTATION: drop `AND u.teammate_id = ...` from the fill CTE — the foreign
   * record resolves and this goes red.
   */
  it('does not resolve another teammate’s record', async () => {
    const foreign = await mkFill({ teammate: otherTeammateId, costUsd: '99.000000' })
    expect(await fetchProviderDayDetail(t.db, teammateId, foreign)).toBeNull()
    expect(await fetchProviderDayDetail(t.db, otherTeammateId, foreign)).not.toBeNull()
  })

  /*
   * DECISION 6 — the read ships with its own index. 0118's only index leads on
   * `source` and was built for the prune; this read's predicate omits `source`
   * entirely, so without mig 0121 every drawer open is a sequential scan.
   *
   * MUTATION: delete drizzle/migrations/0121_*.sql — the index is absent and
   * this goes red.
   */
  it('ships the index its predicate needs', async () => {
    const rows = await t.client<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'provider_usage_fact'
         AND indexname = 'provider_usage_fact_teammate_date_tool_idx'`
    expect(rows.length).toBe(1)
    expect(rows[0]!.indexdef).toContain('teammate_id')
    expect(rows[0]!.indexdef).toContain('date')
    expect(rows[0]!.indexdef).toContain('tool')
  })
})

describe('provider-day detail — the two totals are different quantities', () => {
  /*
   * The residual (what a tag moves) and the provider's own total (what the model
   * rows sum to) are NOT the same number when OTel covered part of the day. Both
   * are reported, from the same snapshot, and neither is computed from the other.
   *
   * MUTATION: return `provider_cost_usd` as the residual (or vice versa) — the
   * two differing values below collapse and this goes red.
   */
  it('reports the residual and the provider total separately', async () => {
    // The provider recorded $50; OTel captured $30 of it, so reconciliation left
    // a $20 residual on the taggable record.
    const id = await mkFill({ costUsd: '20.000000' })
    await costFact({ model: 'claude-opus-4', costUsd: '50.000000' })

    const d = await fetchProviderDayDetail(t.db, teammateId, id)

    expect(d!.unallocated_cost_usd).toBe('20.00')
    expect(d!.provider_cost_usd).toBe('50.00')
    // The breakdown foots to the PROVIDER total, which is the one it describes.
    const sum = d!.by_model.reduce((a, m) => a + Number(m.cost_usd), 0)
    expect(sum).toBeCloseTo(50, 2)
  })
})
