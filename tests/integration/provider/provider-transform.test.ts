// @vitest-environment node
/*
 * provider-transform — the BILLED lane derive
 * (docs/design/target-state-data-architecture.md §6, stage T0).
 *
 * Every test here is written against the REAL worker path (runProviderTransform)
 * and the REAL writer path (runEnterpriseAnalyticsPoll produces the
 * actual_spend.raw_payload it reads), not a private helper and not a hand-built
 * INSERT. That matters most for the homing tests: the invariant IS the ON
 * CONFLICT clause's omissions, so a test that issued its own INSERT could keep
 * passing while production re-homed every row.
 *
 * Each assertion below was verified to FAIL with its fix reverted — the
 * mutations are recorded in the commit message.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runEnterpriseAnalyticsPoll, sourceForOrg } from '../../../server/workers/analytics-poller'
import { runProviderTransform } from '../../../server/workers/provider-transform'
import type { AnthropicEnterpriseClient } from '../../../server/anthropic/enterprise-client'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let orgA: string
let orgB: string
let teammateId: string

const EMAIL = 'billed@provider-transform.test'
const ORG = 'ptx-org'
const SOURCE = sourceForOrg(ORG)

const actor = (email: string = EMAIL) => ({ type: 'user_actor', email, deleted: false })

/** A usage-report row: token lanes, NO cost. Carries all four lanes so the two
 *  the poller discards (cache_creation.*, cache_read_input_tokens) are proven
 *  to reach the fact table. */
const usageRow = (opts: {
  email?: string
  model?: string | null
  product?: string
  inTok?: number
  outTok?: number
  cacheRead?: number
  cache5m?: number
  cache1h?: number
  requests?: number
}) => ({
  actor: actor(opts.email),
  product: opts.product ?? 'claude_code',
  model: opts.model === undefined ? 'claude-opus-5' : opts.model,
  uncached_input_tokens: opts.inTok ?? 0,
  output_tokens: opts.outTok ?? 0,
  cache_read_input_tokens: opts.cacheRead ?? 0,
  cache_creation: {
    ephemeral_5m_input_tokens: opts.cache5m ?? 0,
    ephemeral_1h_input_tokens: opts.cache1h ?? 0,
  },
  total_tokens: (opts.inTok ?? 0) + (opts.outTok ?? 0),
  requests: opts.requests ?? 0,
})

/** A cost-report row: an amount in fractional CENTS, NO tokens. */
const costRow = (opts: {
  email?: string
  model?: string | null
  product?: string
  cents: string
  costType?: string | null
}) => ({
  actor: actor(opts.email),
  currency: 'USD',
  amount: opts.cents,
  cost_type: opts.costType === undefined ? 'tokens' : opts.costType,
  product: opts.product ?? 'claude_code',
  model: opts.model === undefined ? 'claude-opus-5' : opts.model,
  requests: null,
})

function fakeClient(byDay: Record<string, { usage: unknown[]; cost: unknown[] }>): AnthropicEnterpriseClient {
  const day = (s: string) => s.slice(0, 10)
  return {
    getUserUsageReport: async ({ startingAt }: { startingAt: string }) => ({
      has_more: false,
      next_page: null,
      data: byDay[day(startingAt)]?.usage ?? [],
    }),
    getUserCostReport: async ({ startingAt }: { startingAt: string }) => ({
      has_more: false,
      next_page: null,
      data: byDay[day(startingAt)]?.cost ?? [],
    }),
  } as unknown as AnthropicEnterpriseClient
}

async function poll(byDay: Record<string, { usage: unknown[]; cost: unknown[] }>): Promise<void> {
  const days = Object.keys(byDay).sort()
  await runEnterpriseAnalyticsPoll(t.db, fakeClient(byDay), {
    startingAt: days[0]!,
    endingAt: days[days.length - 1]!,
    externalOrgId: ORG,
  })
}

async function transform(startingAt: string, endingAt: string) {
  return runProviderTransform(t.db, { startingAt, endingAt, source: SOURCE })
}

interface FactRow {
  teammate_id: string | null
  actor_ref: string | null
  date: string
  tool: string
  model: string | null
  cost_type: string | null
  cost_usd: string | null
  input_tokens: string | null
  output_tokens: string | null
  cache_read_tokens: string | null
  cache_creation_tokens: string | null
  requests: string | null
  region_id: string | null
  org_unit_id: string | null
  cost_owning_unit_id: string | null
  dimension_source: string
}

async function facts(): Promise<FactRow[]> {
  return t.client<FactRow[]>`
    SELECT teammate_id::text AS teammate_id, actor_ref, date::text AS date, tool, model, cost_type,
           cost_usd::text AS cost_usd, input_tokens::text AS input_tokens,
           output_tokens::text AS output_tokens, cache_read_tokens::text AS cache_read_tokens,
           cache_creation_tokens::text AS cache_creation_tokens, requests::text AS requests,
           region_id::text AS region_id, org_unit_id::text AS org_unit_id,
           cost_owning_unit_id::text AS cost_owning_unit_id, dimension_source
      FROM provider_usage_fact
     ORDER BY date, tool, COALESCE(model,''), COALESCE(cost_type,''), COALESCE(actor_ref,'')`
}

/** Reset both the source and the derived table between tests so each one owns
 *  its own fixture. actual_spend first — provider_usage_fact has no FK to it,
 *  but leaving a payload behind would let the next transform re-derive it. */
async function reset(): Promise<void> {
  await t.client`DELETE FROM provider_usage_fact`
  await t.client`DELETE FROM actual_spend`
  await t.client`DELETE FROM pending_placement`
  // Extra identities a test minted (a second actor, an address-reassignment
  // impostor) go too — otherwise the restore below collides with whoever is
  // holding EMAIL, and one failed assertion cascades into every later test.
  await t.client`DELETE FROM teammate WHERE id <> ${teammateId}::uuid`
  await t.client`UPDATE teammate SET org_unit_id = ${orgA}::uuid, email = ${EMAIL} WHERE id = ${teammateId}::uuid`
}

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.db.insert(schema.region).values({ code: 'ptx', displayName: 'Provider Transform' }).returning()
  regionId = region!.id
  const [a] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ptx.a', code: 'ptx-a', displayName: 'PTX A', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgA = a!.id
  const [b] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ptx.b', code: 'ptx-b', displayName: 'PTX B', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgB = b!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ptx', email: EMAIL, regionId, orgUnitId: orgA })
    .returning()
  teammateId = tm!.id
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(reset)

describe('conservation — the billed lane reconciles to actual_spend', () => {
  it('Σ provider_usage_fact.cost_usd = actual_spend.cost_usd per (teammate, date, tool, source)', async () => {
    await poll({
      '2026-08-01': {
        usage: [
          usageRow({ model: 'claude-opus-5', inTok: 1000, outTok: 500 }),
          usageRow({ model: 'claude-haiku-4-5', inTok: 20, outTok: 10 }),
        ],
        cost: [
          costRow({ model: 'claude-opus-5', cents: '1234.5' }),
          costRow({ model: 'claude-haiku-4-5', cents: '65.5' }),
          // ORG-GRAIN rows. The poller drops these before building raw_payload,
          // so they never reach the fact table from this source — but the
          // comparison excludes them regardless, so this check stays correct
          // when the source becomes a raw batch that DOES carry them.
          costRow({ model: null, cents: '900', costType: 'web_search' }),
        ],
      },
    })
    await transform('2026-08-01', '2026-08-01')

    const [row] = await t.client<{ fact_total: string; spend_total: string }[]>`
      SELECT
        (SELECT COALESCE(SUM(f.cost_usd), 0)::text
           FROM provider_usage_fact f
          WHERE f.teammate_id = a.teammate_id AND f.date = a.date
            AND f.tool = a.tool AND f.source = a.source
            AND f.cost_type NOT IN ('web_search', 'code_execution')) AS fact_total,
        a.cost_usd::text AS spend_total
      FROM actual_spend a
      WHERE a.source = ${SOURCE} AND a.date = '2026-08-01'::date AND a.tool = 'claude-code'`
    expect(row).toBeTruthy()
    // 1234.5 + 65.5 fractional cents = $13.00; the web_search 900c is excluded
    // from BOTH sides, so the two agree exactly.
    expect(Number(row!.spend_total)).toBeCloseTo(13, 6)
    expect(Number(row!.fact_total)).toBeCloseTo(Number(row!.spend_total), 6)
  })
})

describe('homing — stamped once, never refreshed', () => {
  it('a re-transform after a reorg does NOT re-home (the SET-list omission)', async () => {
    await poll({ '2026-08-01': { usage: [usageRow({ inTok: 1000 })], cost: [costRow({ cents: '500' })] } })
    await transform('2026-08-01', '2026-08-01')

    const before = await facts()
    expect(before).toHaveLength(2) // one token row + one cost row
    for (const f of before) {
      expect(f.org_unit_id).toBe(orgA)
      expect(f.cost_owning_unit_id).toBe(orgA)
      expect(f.region_id).toBe(regionId)
      expect(f.dimension_source).toBe('ingest-snapshot')
    }

    // Reorg, then re-poll the SAME day with a revised cost and re-transform.
    await t.client`UPDATE teammate SET org_unit_id = ${orgB}::uuid WHERE id = ${teammateId}::uuid`
    await poll({ '2026-08-01': { usage: [usageRow({ inTok: 1000 })], cost: [costRow({ cents: '750' })] } })
    await transform('2026-08-01', '2026-08-01')

    const after = await facts()
    expect(after).toHaveLength(2)
    const cost = after.find((f) => f.cost_type !== null)!
    expect(Number(cost.cost_usd)).toBeCloseTo(7.5, 6) // the MONEY refreshed…
    for (const f of after) {
      expect(f.org_unit_id).toBe(orgA) // …and the homing did NOT
      expect(f.cost_owning_unit_id).toBe(orgA)
      expect(f.region_id).toBe(regionId)
    }
  })

  it('a genuinely NEW day still snapshots the CURRENT placement', async () => {
    // The counterpart to the test above: "never refreshed" must not be
    // implemented as "never stamped". Without this, a worker that simply wrote
    // NULL homing forever would pass the re-home test vacuously.
    await t.client`UPDATE teammate SET org_unit_id = ${orgB}::uuid WHERE id = ${teammateId}::uuid`
    await poll({ '2026-08-05': { usage: [usageRow({ inTok: 10 })], cost: [costRow({ cents: '100' })] } })
    await transform('2026-08-05', '2026-08-05')

    const rows = await facts()
    expect(rows).toHaveLength(2)
    for (const f of rows) expect(f.org_unit_id).toBe(orgB)
  })
})

describe('identity is INHERITED from actual_spend, never re-derived', () => {
  /*
   * An unresolved actor CANNOT arise from this source: the poller `continue`s an
   * unresolvable actor into the owed-bill queue before it can reach
   * actual_spend, and actual_spend.teammate_id is NOT NULL. So the tests that
   * used to live here — a directory rename orphaning a payload actor, two
   * orphaned actors colliding, resolution by re-derivation — all described a
   * state this worker cannot produce, and they only passed because the worker
   * re-resolved the payload's email instead of inheriting the row's teammate.
   *
   * What remains is the property that replaced them: the payload's actor email
   * is CARRIED (actor_ref) and never CONSULTED. The carry path itself lives in
   * the schema (mig 0118's NULL-safe grain key) for the raw-batch source, and is
   * pinned below at that layer.
   */
  it('an email REASSIGNED to another teammate does not move the billed identity', async () => {
    /*
     * The hazard re-resolution creates, in its sharpest form. Poll under EMAIL
     * (bound to `teammateId`), then hand that address to a DIFFERENT teammate.
     * A worker that re-resolved would bill the fact rows to the impostor while
     * actual_spend stayed with the original — per-teammate conservation broken,
     * silently, by a directory edit nobody connected to money.
     *
     * MUTATION: restore the payload-email lookup (resolveTeammateId) → the fact
     * rows carry `impostor` and this goes red on the first assertion.
     */
    await poll({ '2026-08-01': { usage: [usageRow({ inTok: 1000 })], cost: [costRow({ cents: '500' })] } })

    await t.client`UPDATE teammate SET email = 'moved-away@provider-transform.test' WHERE id = ${teammateId}::uuid`
    const [impostor] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-ptx-impostor', email: EMAIL, regionId, orgUnitId: orgB })
      .returning()

    await transform('2026-08-01', '2026-08-01')

    const rows = await facts()
    expect(rows).toHaveLength(2)
    for (const f of rows) {
      expect(f.teammate_id).toBe(teammateId) // the actual_spend row's owner…
      expect(f.teammate_id).not.toBe(impostor!.id) // …not whoever now holds the address
      // The actor email is still CARRIED verbatim, so a future re-derivation
      // against the raw-batch source has it without a re-fetch.
      expect(f.actor_ref).toBe(EMAIL)
      // Homing follows the inherited teammate, who is still in org A.
      expect(f.org_unit_id).toBe(orgA)
    }

    // Conservation still holds per teammate, which is the point of all of this.
    const [conserved] = await t.client<{ fact_total: string; spend_total: string }[]>`
      SELECT (SELECT COALESCE(SUM(f.cost_usd), 0)::text
                FROM provider_usage_fact f
               WHERE f.teammate_id = a.teammate_id AND f.date = a.date
                 AND f.tool = a.tool AND f.source = a.source) AS fact_total,
             a.cost_usd::text AS spend_total
        FROM actual_spend a
       WHERE a.source = ${SOURCE} AND a.date = '2026-08-01'::date`
    expect(Number(conserved!.fact_total)).toBeCloseTo(Number(conserved!.spend_total), 6)
  })

  it('the NULL-safe grain key keeps two unresolved actors apart (the raw-batch source)', async () => {
    /*
     * Written against the SCHEMA, not the worker, and deliberately so: unresolved
     * rows are the raw-batch source's shape and this worker cannot emit one, but
     * mig 0118's `COALESCE(teammate_id::text, 'actor:' || lower(actor_ref))` term
     * is what will keep them apart when it can. Without the actor_ref term both
     * rows key on one sentinel and the second silently overwrites the first.
     *
     * MUTATION: drop `'actor:' || lower(actor_ref)` from the unique index (leave
     * a bare COALESCE sentinel) → the second INSERT conflicts and this goes red.
     */
    const ins = async (actorRef: string, cents: string) =>
      t.client`
        INSERT INTO provider_usage_fact (source, provider, actor_ref, date, tool, cost_type, cost_usd)
        VALUES (${SOURCE}, 'anthropic', ${actorRef}, '2026-08-01'::date, 'claude-code', 'tokens', ${cents})`
    await ins('one@raw-batch.test', '5.000000')
    await ins('two@raw-batch.test', '7.000000')

    const rows = (await facts()).filter((f) => f.teammate_id === null)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((f) => f.actor_ref))).toEqual(
      new Set(['one@raw-batch.test', 'two@raw-batch.test']),
    )
    // No teammate means no placement, and we never guess one.
    expect(rows.every((f) => f.region_id === null && f.org_unit_id === null)).toBe(true)
  })
})

describe('measure exclusivity', () => {
  it('a token row carries NO cost and a cost row carries NO tokens', async () => {
    await poll({
      '2026-08-01': {
        usage: [usageRow({ inTok: 1000, outTok: 500, cacheRead: 300, cache5m: 40, cache1h: 60, requests: 7 })],
        cost: [costRow({ cents: '500' })],
      },
    })
    await transform('2026-08-01', '2026-08-01')

    const rows = await facts()
    const token = rows.find((f) => f.cost_type === null)!
    const cost = rows.find((f) => f.cost_type !== null)!

    expect(token.cost_usd).toBeNull()
    expect(token.input_tokens).toBe('1000')
    expect(token.output_tokens).toBe('500')
    // The two lanes the poller discards (analytics-poller.ts:536-537) DO reach
    // the fact table — cache is where cost hides.
    expect(token.cache_read_tokens).toBe('300')
    expect(token.cache_creation_tokens).toBe('100') // 5m + 1h, summed into one lane
    expect(token.requests).toBe('7')

    expect(Number(cost.cost_usd)).toBeCloseTo(5, 6)
    expect(cost.input_tokens).toBeNull()
    expect(cost.output_tokens).toBeNull()
    expect(cost.cache_read_tokens).toBeNull()
    expect(cost.cache_creation_tokens).toBeNull()
  })

  it('a single GROUP BY model yields both measures with NO double counting', async () => {
    await poll({
      '2026-08-01': {
        usage: [
          usageRow({ model: 'claude-opus-5', inTok: 1000, outTok: 500 }),
          usageRow({ model: 'claude-haiku-4-5', inTok: 20, outTok: 10 }),
        ],
        cost: [
          costRow({ model: 'claude-opus-5', cents: '1200' }),
          costRow({ model: 'claude-haiku-4-5', cents: '100' }),
        ],
      },
    })
    await transform('2026-08-01', '2026-08-01')

    // The design's own query, verbatim — no filter, no merged view.
    const rows = await t.client<{ model: string; cost: string | null; tokens: string | null }[]>`
      SELECT model, SUM(cost_usd)::text AS cost, SUM(input_tokens + output_tokens)::text AS tokens
        FROM provider_usage_fact GROUP BY model ORDER BY model`
    expect(rows).toHaveLength(2)
    const byModel = Object.fromEntries(rows.map((r) => [r.model, r]))
    expect(Number(byModel['claude-opus-5']!.cost)).toBeCloseTo(12, 6)
    expect(Number(byModel['claude-opus-5']!.tokens)).toBe(1500)
    expect(Number(byModel['claude-haiku-4-5']!.cost)).toBeCloseTo(1, 6)
    expect(Number(byModel['claude-haiku-4-5']!.tokens)).toBe(30)

    // And the totals equal the un-grouped ones — nothing multiplied.
    const [totals] = await t.client<{ cost: string; tokens: string }[]>`
      SELECT SUM(cost_usd)::text AS cost, SUM(input_tokens + output_tokens)::text AS tokens
        FROM provider_usage_fact`
    expect(Number(totals!.cost)).toBeCloseTo(13, 6)
    expect(Number(totals!.tokens)).toBe(1530)
  })
})

describe('idempotency', () => {
  it('running twice over the same window yields an identical row set and totals', async () => {
    await poll({
      '2026-08-01': {
        usage: [usageRow({ model: 'claude-opus-5', inTok: 1000, outTok: 500, cacheRead: 9 })],
        cost: [costRow({ model: 'claude-opus-5', cents: '500' })],
      },
      '2026-08-02': {
        usage: [usageRow({ model: 'claude-haiku-4-5', inTok: 7 })],
        cost: [costRow({ model: 'claude-haiku-4-5', cents: '25' })],
      },
    })
    const first = await transform('2026-08-01', '2026-08-02')
    const afterFirst = await facts()

    const second = await transform('2026-08-01', '2026-08-02')
    const afterSecond = await facts()

    expect(afterSecond).toEqual(afterFirst)
    expect(second.factRowsUpserted).toBe(first.factRowsUpserted)
    // The second run re-asserted every row, so its prune removed nothing.
    expect(second.factRowsPruned).toBe(0)
    expect(afterSecond).toHaveLength(4)
  })

  it('a row the provider revised away is pruned', async () => {
    await poll({
      '2026-08-01': {
        usage: [
          usageRow({ model: 'claude-opus-5', inTok: 1000 }),
          usageRow({ model: 'claude-haiku-4-5', inTok: 20 }),
        ],
        cost: [],
      },
    })
    await transform('2026-08-01', '2026-08-01')
    expect(await facts()).toHaveLength(2)

    // The provider revises the day down to a single model. The poller rewrites
    // raw_payload; the transform must converge the fact set to match.
    await poll({ '2026-08-01': { usage: [usageRow({ model: 'claude-opus-5', inTok: 1000 })], cost: [] } })
    const res = await transform('2026-08-01', '2026-08-01')
    const rows = await facts()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.model).toBe('claude-opus-5')
    expect(res.factRowsPruned).toBe(1)

    // The prune enqueues the affected teammate for a usage-rollup recompute
    // (usage-rollup-lane.md R4): a pruned row leaves no write instant behind,
    // so without this a day revised away to empty would keep its deleted
    // usage in usage_rollup_daily forever.
    const queued = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM usage_rollup_refresh`
    expect(queued[0]!.n).toBeGreaterThanOrEqual(1)
  })
})

describe('pre-#226 payloads', () => {
  it("a cost row with a NULL cost_type is stamped 'tokens'", async () => {
    /*
     * Before #226 (commit 3652c22) the cost report was not grouped by cost_type,
     * so the field was null on EVERY row — 395/395. Those payloads are a
     * bounded, knowable population, and production already treats their cost as
     * token cost (adapters/anthropic.ts:280-285). Stamping them here is what
     * keeps measure_chk from having to admit a row that is neither a token row
     * nor a cost row.
     */
    await poll({
      '2026-08-01': {
        usage: [usageRow({ inTok: 1000 })],
        cost: [costRow({ cents: '500', costType: null })],
      },
    })
    await transform('2026-08-01', '2026-08-01')

    const rows = await facts()
    const cost = rows.filter((f) => f.cost_usd !== null)
    expect(cost).toHaveLength(1)
    expect(cost[0]!.cost_type).toBe('tokens')
    expect(Number(cost[0]!.cost_usd)).toBeCloseTo(5, 6)
    // The token row is still keyed on a NULL cost_type — the two do not collide.
    expect(rows.filter((f) => f.cost_type === null)).toHaveLength(1)
  })
})

describe('scoping', () => {
  it('refuses a source NO ARM claims rather than pruning its window', async () => {
    /*
     * Every arm hardcodes its provider AND its payload shape — this one derives
     * `{day, usage[], cost[]}` into provider='anthropic'. Pointed at a source no
     * arm claims, a run would derive nothing and then prune that source's
     * window, deleting rows it never had the ability to re-assert.
     *
     * 'copilot-usage' is a §B CHARGEBACK LANE ID (github-surface.ts), not a
     * source any arm reads — the GitHub arm's own source is
     * 'copilot-consumption:<enterpriseRef>' (#49), which IS claimed and is
     * exercised in provider-transform-github.test.ts. The point of this
     * assertion is that growing the arm set does not turn an unclaimed source
     * into a silent prune.
     */
    await expect(
      runProviderTransform(t.db, { startingAt: '2026-08-01', endingAt: '2026-08-01', source: 'copilot-usage' }),
    ).rejects.toThrow(/no arm claims source/)
  })
})

describe('the rate card never reaches the billed lane', () => {
  it('an unparseable amount is skipped, never priced and never coerced to zero', async () => {
    await poll({
      '2026-08-01': {
        usage: [usageRow({ inTok: 1000 })],
        cost: [costRow({ model: 'claude-opus-5', cents: '500' })],
      },
    })
    // Corrupt the stored payload's amount — the poller's own parse guard sits
    // upstream, so this is the only way to exercise the transform's.
    await t.client`
      UPDATE actual_spend
         SET raw_payload = jsonb_set(raw_payload, '{cost,0,amount}', '"not-a-number"'::jsonb)
       WHERE source = ${SOURCE} AND date = '2026-08-01'::date`
    await transform('2026-08-01', '2026-08-01')

    const rows = await facts()
    // The token row survives; NO cost row was invented for the bad amount.
    expect(rows.filter((f) => f.cost_type !== null)).toHaveLength(0)
    expect(rows.filter((f) => f.cost_type === null)).toHaveLength(1)
  })
})
