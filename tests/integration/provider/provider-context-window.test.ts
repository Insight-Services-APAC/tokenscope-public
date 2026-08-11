// @vitest-environment node
/*
 * W0a — `context_window` on the provider facts
 * (docs/design/developer-pages-consolidation/01-build-design.md D1-D4, T1-T4).
 *
 * Written against the REAL paths, the provider-server-tool-use.test.ts
 * discipline: runEnterpriseAnalyticsPoll produces the `actual_spend.raw_payload`
 * that runProviderTransform reads, and the assertions are made on the rows those
 * two actually wrote. No hand-built INSERT except where the upsert statement
 * ITSELF is under test (T4).
 *
 * THE FAKE CLIENT MODELS THE PROVIDER'S group_by CONTRACT. The wire evidence
 * (provider-wire-captures/README.md, capture 2026-08-02) is that `context_window`
 * is in the contract and arrives NULL only because it is not in `group_by`.
 * The fake client therefore holds ONE canonical BANDED dataset per day and
 * serves it AS the provider would: grouped by `context_window` when the caller
 * asks for it, collapsed over the hidden dimension (key present, NULL) when it
 * does not. That is what makes T1 a real before/after: the same provider truth,
 * two revisions of the asking code.
 *
 * T1 GOLDEN (07-r1-M3 technique): one test run cannot compare two revisions of
 * the code, so the per-(date, tool, model, cost_type) rollup was serialized on
 * this fixture BEFORE the W0a change
 * (`WRITE_GOLDEN=1 npx vitest run tests/integration/provider/provider-context-window.test.ts -t conservation`)
 * and committed at tests/fixtures/context-window-conservation.golden.json.
 * Post-change, banded rows must PARTITION the old rows exactly — the rollup
 * over the new dimension is byte-equal to the pre-change rollup. Regenerating
 * is a deliberate act: only rerun WRITE_GOLDEN=1 when the billed lane's
 * figures are MEANT to move, and say so in the same commit.
 *
 * Each assertion was verified to FAIL with its fix reverted; the mutation is
 * recorded above it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runEnterpriseAnalyticsPoll, sourceForOrg } from '../../../server/workers/analytics-poller'
import { runProviderTransform } from '../../../server/workers/provider-transform'
import {
  grainKey,
  upsertProviderUsageFact,
  type FactRow,
} from '../../../server/workers/provider-fact'
import type { AnthropicEnterpriseClient } from '../../../server/anthropic/enterprise-client'
import * as schema from '../../../drizzle/schema'

const GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'context-window-conservation.golden.json',
)

let t: TestDb
let regionId: string
let orgUnitId: string
let teammateId: string

const EMAIL = 'ctx@provider-context-window.test'
const ORG = 'ctx-org'
const SOURCE = sourceForOrg(ORG)
const DAY = '2026-07-10'
const OLD_DAY = '2026-07-08'

const actor = () => ({ type: 'user_actor', email: EMAIL, deleted: false })

/* ── the canonical BANDED provider truth ──────────────────────────────────── */

interface BandedUsageRow {
  product: string
  model: string
  context_window: string | null
  in: number
  out: number
  cacheRead?: number
  cache5m?: number
  cache1h?: number
  requests?: number
  web?: number
}

interface BandedCostRow {
  product: string
  model: string
  cost_type: string
  context_window: string | null
  cents: number
}

/** Two bands on one (product, model) grain — the partition T1 turns on — plus a
 *  second model and a second product so tool/model dimensions are exercised. */
const USAGE_TRUTH: BandedUsageRow[] = [
  { product: 'claude_code', model: 'claude-opus-5', context_window: '0-200k', in: 100, out: 50, cacheRead: 10, cache5m: 3, cache1h: 2, requests: 4, web: 2 },
  { product: 'claude_code', model: 'claude-opus-5', context_window: '200k+', in: 40, out: 20, cacheRead: 5, requests: 1, web: 1 },
  { product: 'claude_code', model: 'claude-sonnet-5', context_window: '0-200k', in: 30, out: 15, requests: 2 },
  { product: 'chat', model: 'claude-opus-5', context_window: '0-200k', in: 7, out: 3, requests: 1 },
]

const COST_TRUTH: BandedCostRow[] = [
  { product: 'claude_code', model: 'claude-opus-5', cost_type: 'tokens', context_window: '0-200k', cents: 1234 },
  { product: 'claude_code', model: 'claude-opus-5', cost_type: 'tokens', context_window: '200k+', cents: 567 },
  { product: 'claude_code', model: 'claude-sonnet-5', cost_type: 'tokens', context_window: '0-200k', cents: 89 },
  { product: 'chat', model: 'claude-opus-5', cost_type: 'tokens', context_window: '0-200k', cents: 45 },
]

const wireUsageRow = (r: BandedUsageRow, contextWindow: string | null) => ({
  actor: actor(),
  product: r.product,
  model: r.model,
  context_window: contextWindow,
  uncached_input_tokens: r.in,
  output_tokens: r.out,
  cache_read_input_tokens: r.cacheRead ?? 0,
  cache_creation: {
    ephemeral_5m_input_tokens: r.cache5m ?? 0,
    ephemeral_1h_input_tokens: r.cache1h ?? 0,
  },
  total_tokens: r.in + r.out,
  requests: r.requests ?? 0,
  ...(r.web !== undefined ? { server_tool_use: { web_search_requests: r.web } } : {}),
})

const wireCostRow = (r: BandedCostRow, contextWindow: string | null) => ({
  actor: actor(),
  currency: 'USD',
  amount: String(r.cents),
  cost_type: r.cost_type,
  product: r.product,
  model: r.model,
  context_window: contextWindow,
  requests: null,
})

/** Collapse the banded truth over the hidden dimension — what the provider
 *  returns when `context_window` is NOT in group_by: the key is present and
 *  NULL, and the measures are summed (capture 2026-08-02: "sent, and NULL"). */
function collapseUsage(rows: BandedUsageRow[]): BandedUsageRow[] {
  const byKey = new Map<string, BandedUsageRow>()
  for (const r of rows) {
    const key = `${r.product}\u0000${r.model}`
    const into = byKey.get(key)
    if (!into) {
      byKey.set(key, { ...r, context_window: null })
      continue
    }
    into.in += r.in
    into.out += r.out
    into.cacheRead = (into.cacheRead ?? 0) + (r.cacheRead ?? 0)
    into.cache5m = (into.cache5m ?? 0) + (r.cache5m ?? 0)
    into.cache1h = (into.cache1h ?? 0) + (r.cache1h ?? 0)
    into.requests = (into.requests ?? 0) + (r.requests ?? 0)
    if (r.web !== undefined) into.web = (into.web ?? 0) + r.web
  }
  return [...byKey.values()]
}

function collapseCost(rows: BandedCostRow[]): BandedCostRow[] {
  const byKey = new Map<string, BandedCostRow>()
  for (const r of rows) {
    const key = `${r.product}\u0000${r.model}\u0000${r.cost_type}`
    const into = byKey.get(key)
    if (!into) {
      byKey.set(key, { ...r, context_window: null })
      continue
    }
    into.cents += r.cents
  }
  return [...byKey.values()]
}

interface DayTruth {
  usage: BandedUsageRow[]
  cost: BandedCostRow[]
}

/**
 * The provider double. `mode: 'grouped'` honours the caller's group_by exactly
 * (banded rows iff `context_window` is asked for); `mode: 'never-banded'`
 * always collapses, whatever is asked — a pre-collection provider state, used
 * to seed the NULL-band history T2 heals.
 */
function fakeClient(
  byDay: Record<string, DayTruth>,
  mode: 'grouped' | 'never-banded' = 'grouped',
): AnthropicEnterpriseClient {
  const day = (s: string) => s.slice(0, 10)
  const banded = (groupBy: string[] | undefined) =>
    mode === 'grouped' && (groupBy ?? []).includes('context_window')
  return {
    getUserUsageReport: async ({ startingAt, groupBy }: { startingAt: string; groupBy?: string[] }) => {
      const truth = byDay[day(startingAt)]?.usage ?? []
      const rows = banded(groupBy) ? truth : collapseUsage(truth)
      return { has_more: false, next_page: null, data: rows.map((r) => wireUsageRow(r, r.context_window)) }
    },
    getUserCostReport: async ({ startingAt, groupBy }: { startingAt: string; groupBy?: string[] }) => {
      const truth = byDay[day(startingAt)]?.cost ?? []
      const rows = banded(groupBy) ? truth : collapseCost(truth)
      return { has_more: false, next_page: null, data: rows.map((r) => wireCostRow(r, r.context_window)) }
    },
  } as unknown as AnthropicEnterpriseClient
}

async function poll(
  byDay: Record<string, DayTruth>,
  mode: 'grouped' | 'never-banded' = 'grouped',
): Promise<void> {
  const days = Object.keys(byDay).sort()
  await runEnterpriseAnalyticsPoll(t.db, fakeClient(byDay, mode), {
    startingAt: days[0]!,
    endingAt: days[days.length - 1]!,
    externalOrgId: ORG,
  })
}

const transform = (startingAt = DAY, endingAt = DAY) =>
  runProviderTransform(t.db, { startingAt, endingAt, source: SOURCE })

/** The T1 rollup — the fact grain WITHOUT the new dimension. Identical before
 *  and after the change iff banded rows partition the old rows exactly. */
async function grainRollup(): Promise<unknown[]> {
  return [
    ...(await t.client`
      SELECT date::text AS date, tool,
             COALESCE(model, '') AS model, COALESCE(cost_type, '') AS cost_type,
             SUM(cost_usd)::text AS cost_usd,
             SUM(input_tokens)::text AS input_tokens,
             SUM(output_tokens)::text AS output_tokens,
             SUM(cache_read_tokens)::text AS cache_read_tokens,
             SUM(cache_creation_tokens)::text AS cache_creation_tokens,
             SUM(requests)::text AS requests,
             SUM(web_search_requests)::text AS web_search_requests
        FROM provider_usage_fact
       WHERE source = ${SOURCE}
       GROUP BY date, tool, COALESCE(model, ''), COALESCE(cost_type, '')
       ORDER BY date, tool, COALESCE(model, ''), COALESCE(cost_type, '')`),
  ]
}

async function factRows(): Promise<
  Array<{ date: string; tool: string; model: string | null; cost_type: string | null; context_window: string | null; cost_usd: string | null; input_tokens: string | null }>
> {
  return [
    ...(await t.client`
      SELECT date::text AS date, tool, model, cost_type, context_window,
             cost_usd::text AS cost_usd, input_tokens::text AS input_tokens
        FROM provider_usage_fact
       WHERE source = ${SOURCE}
       ORDER BY date, tool, COALESCE(model, ''), COALESCE(cost_type, ''), COALESCE(context_window, '')`),
  ] as never
}

async function reset(): Promise<void> {
  await t.client`DELETE FROM provider_usage_fact`
  await t.client`DELETE FROM actual_spend`
  await t.client`DELETE FROM pending_placement`
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'ctx', displayName: 'CTX' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ctx', code: 'ctx-bu', displayName: 'CTX', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ctx', email: EMAIL, regionId, orgUnitId })
    .returning()
  teammateId = tm!.id
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(reset)

describe('T1 — conservation across the grain change', () => {
  /*
   * MUTATION: make the transform drop or double a banded row (e.g. skip the
   * '200k+' usage row, or add the band's cost into another band's fact) — the
   * rollup diverges from the golden on the exact grain that moved.
   */
  it('the per-(date, tool, model, cost_type) rollup equals the committed pre-change golden', async () => {
    await poll({ [DAY]: { usage: USAGE_TRUTH, cost: COST_TRUTH } })
    await transform()

    const rollup = await grainRollup()

    if (process.env.WRITE_GOLDEN) {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(rollup, null, 2)}\n`)
      console.warn(`[golden] wrote ${GOLDEN_PATH} — commit it with the change that is MEANT to move it`)
      return
    }

    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as unknown[]
    // Non-vacuous: the fixture really carries money and tokens to conserve.
    expect(JSON.stringify(golden)).toContain('18.01')
    expect(golden.length).toBeGreaterThan(0)
    expect(rollup).toEqual(golden)

    // And the partition is REAL, not a rollup of unbanded rows: the two-band
    // grain occupies two fact rows, one per band.
    const rows = await factRows()
    const opusCost = rows.filter(
      (r) => r.tool === 'claude-code' && r.model === 'claude-opus-5' && r.cost_type === 'tokens',
    )
    expect(opusCost.map((r) => r.context_window).sort()).toEqual(['0-200k', '200k+'])
    expect(opusCost.map((r) => r.cost_usd).sort()).toEqual(['12.340000', '5.670000'])
  })
})

describe('T2 — the windowed prune heals NULL-band history', () => {
  /*
   * MUTATION: scope the transform's guarded prune to `context_window IS NOT
   * NULL` (or skip the prune) — the in-window NULL-band rows survive beside the
   * banded ones and the no-NULL assertion goes red (a $X grain would read $2X).
   */
  it('re-polled days replace NULL-band rows wholesale; out-of-window days keep theirs', async () => {
    // Pre-collection history: the provider was never asked for the dimension.
    await poll(
      {
        [OLD_DAY]: { usage: USAGE_TRUTH, cost: COST_TRUTH },
        [DAY]: { usage: USAGE_TRUTH, cost: COST_TRUTH },
      },
      'never-banded',
    )
    await transform(OLD_DAY, DAY)

    const before = await factRows()
    expect(before.length).toBeGreaterThan(0)
    expect(before.every((r) => r.context_window === null)).toBe(true)

    // The poll window rolls forward: DAY is re-polled (now banded), OLD_DAY is
    // outside the window and cannot heal (raw holds only what group_by asked).
    await poll({ [DAY]: { usage: USAGE_TRUTH, cost: COST_TRUTH } })
    await transform(DAY, DAY)

    const after = await factRows()
    const dayRows = after.filter((r) => r.date === DAY)
    const oldRows = after.filter((r) => r.date === OLD_DAY)

    // The re-polled day is banded wholesale — no NULL-band survivor doubles it.
    expect(dayRows.length).toBeGreaterThan(0)
    expect(dayRows.every((r) => r.context_window !== null)).toBe(true)
    expect(dayRows.some((r) => r.context_window === '200k+')).toBe(true)

    // The out-of-window day keeps its NULL-band rows — history does not lie,
    // it stays reason-typed as un-banded (the D5 remainder's population).
    expect(oldRows.length).toBeGreaterThan(0)
    expect(oldRows.every((r) => r.context_window === null)).toBe(true)
  })
})

describe('T3 — band tolerance (the no-enum rationale, at rest)', () => {
  /*
   * The band vocabulary is the PROVIDER'S to extend. An unknown band must ride
   * through verbatim, never 500 and never be normalised away.
   *
   * MUTATION: normalise unknown bands in the transform (e.g. map anything
   * outside {'0-200k','200k+'} to null) — the '1m+' expectation goes red.
   */
  it('an unrecognised band string lands verbatim in the fact column', async () => {
    await poll({
      [DAY]: {
        usage: [{ product: 'claude_code', model: 'claude-opus-5', context_window: '1m+', in: 10, out: 5, requests: 1 }],
        cost: [{ product: 'claude_code', model: 'claude-opus-5', cost_type: 'tokens', context_window: '1m+', cents: 300 }],
      },
    })
    await transform()

    const rows = await factRows()
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.context_window === '1m+')).toBe(true)
  })

  /*
   * The derive is null- and garbage-tolerant: an explicit null stays NULL and a
   * whitespace-only band is NOT a band (the modelOf trim-only discipline —
   * trimming is the ONLY normalisation).
   *
   * MUTATION: land the raw string unconditionally (drop the trim/empty guard in
   * contextWindowOf) — the whitespace row keys as a distinct blank band, the
   * shape CHECK rejects it, and the transform throws instead of writing NULL.
   */
  it('an explicit null and a whitespace-only value both land as NULL; a padded band is trimmed', async () => {
    await poll({
      [DAY]: {
        usage: [
          { product: 'claude_code', model: 'claude-opus-5', context_window: null, in: 10, out: 5 },
          { product: 'claude_code', model: 'claude-sonnet-5', context_window: '   ', in: 20, out: 10 },
          { product: 'chat', model: 'claude-opus-5', context_window: ' 0-200k ', in: 5, out: 2 },
        ],
        cost: [{ product: 'claude_code', model: 'claude-opus-5', cost_type: 'tokens', context_window: null, cents: 100 }],
      },
    })
    await transform()

    const rows = await factRows()
    const byModelTool = (tool: string, model: string) =>
      rows.filter((r) => r.tool === tool && r.model === model)
    expect(byModelTool('claude-code', 'claude-opus-5').map((r) => r.context_window)).toEqual([null, null])
    expect(byModelTool('claude-code', 'claude-sonnet-5').map((r) => r.context_window)).toEqual([null])
    expect(byModelTool('claude-ai', 'claude-opus-5').map((r) => r.context_window)).toEqual(['0-200k'])
  })
})

describe('T4 — grainKey and the unique index agree on the extended grain', () => {
  const fact = (over: Partial<FactRow>): FactRow => ({
    source: SOURCE,
    provider: 'anthropic',
    providerOrgId: null,
    providerEnterpriseId: null,
    teammateId,
    actorRef: EMAIL,
    date: DAY,
    tool: 'claude-code',
    model: 'claude-opus-5',
    costType: 'tokens',
    currency: 'USD',
    costUsd: 5,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    requests: null,
    webSearchRequests: null,
    contextWindow: '0-200k',
    ...over,
  })

  /*
   * MUTATION: drop `contextWindow` from grainKey() — the two keys collide and
   * the inequality goes red (in-run dedup would silently merge two bands).
   */
  it('two facts differing only in context_window have distinct grain keys', () => {
    expect(grainKey(fact({}))).not.toBe(grainKey(fact({ contextWindow: '200k+' })))
    // NULL keys as '' — same nullable-member treatment as model/cost_type.
    expect(grainKey(fact({ contextWindow: null }))).not.toBe(grainKey(fact({})))
  })

  /*
   * MUTATION: drop `COALESCE(context_window, '')` from the 0127 index (or from
   * the upsert's ON CONFLICT target) — the second band CONFLICTS with the first
   * and overwrites it, so the two-row expectation goes red.
   */
  it('two bands occupy two rows; re-upserting one updates in place', async () => {
    await upsertProviderUsageFact(t.db, fact({}))
    await upsertProviderUsageFact(t.db, fact({ contextWindow: '200k+', costUsd: 7 }))

    let rows = await factRows()
    expect(rows.map((r) => [r.context_window, r.cost_usd])).toEqual([
      ['0-200k', '5.000000'],
      ['200k+', '7.000000'],
    ])

    // The extended key still DEDUPES: same band → in-place measure refresh.
    await upsertProviderUsageFact(t.db, fact({ costUsd: 9 }))
    rows = await factRows()
    expect(rows.map((r) => [r.context_window, r.cost_usd])).toEqual([
      ['0-200k', '9.000000'],
      ['200k+', '7.000000'],
    ])
  })
})
