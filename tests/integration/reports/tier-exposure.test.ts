// @vitest-environment node
/*
 * `fetchTierExposure` against a REAL Postgres with the REAL `model_catalog`
 * seed — the half the pure unit test cannot reach.
 *
 * WHAT ONLY THIS FILE CAN PROVE. The unit test fixes the catalog as a literal,
 * so it proves the BANDING never fans out. It cannot prove the same of the
 * SQL, and the SQL is where a fan-out would actually be introduced: the
 * tempting "optimisation" is to move the banding into a `JOIN model_catalog ON
 * position(mc.model_pattern in lower(f.model)) > 0`, which type-checks, reads
 * cleanly, and silently doubles every `gpt-5-mini` dollar because that string
 * matches BOTH the `gpt-5-mini` pattern (sort_order 50, lightweight) and the
 * `gpt-5` pattern (70, frontier). Here the catalog is whatever migration 0046
 * actually seeded, so the assertion goes red against the real overlap rather
 * than against a fixture someone remembered to write.
 *
 * It also pins the two invariants that need a real lane:
 *   - measure exclusivity (`0118:141-165`) — one GROUP BY over cost rows AND
 *     token rows must not multiply either measure;
 *   - distinct daily actives ≤ Σ per-tool actives, STRICTLY less when someone
 *     uses both tools (04-prototype-delta.md §7).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { wholeCompanyFinance, clampedFinance, clampedUsage } from '../../../server/reporting/engine/scope'
import { fetchTierExposure } from '../../../server/reporting/engine/tier-exposure'
import { fetchDailyMetrics } from '../../../server/reporting/engine/usage-series'
import { fetchAcrossActiveTrend } from '../../../server/reporting/across-regions'
import type { TierExposure, TierBand } from '../../../shared/reports/tier-exposure'
import { resolveServerClock } from '../../../shared/reports/clock'

/*
 * A PINNED clock. `fetchDailyMetrics` / `fetchChargebackTrend` no longer read
 * `CURRENT_DATE` (F1/D2) — the axis frontier is `clock.settledThrough`, passed
 * in. Fixed well past every window below, so the frontier is the window's own
 * end and these assertions are about the CLAMP, not about the calendar.
 */
const CLOCK = resolveServerClock(new Date('2026-12-31T12:00:00Z'))


let t: TestDb
let regionA = ''
let regionB = ''
let unitA = ''
let unitB = ''
let alice = ''
let bob = ''

/** June 1-4 — the exposure window. */
const WINDOW = { startIso: '2026-06-01T00:00:00.000Z', endIso: '2026-06-05T00:00:00.000Z' }

/** The exact amount the fan-out test turns on. Deliberately not round, so a */
/** doubled figure cannot be mistaken for a different fixture's number.       */
const MINI_USD = 137.5

async function fact(over: {
  provider?: string
  model?: string | null
  contextWindow?: string | null
  date?: string
  costUsd?: number | null
  input?: number | null
  output?: number | null
  requests?: number | null
  teammate?: string
  region?: string
  unit?: string
}): Promise<void> {
  // cost_type is what the measure-exclusivity CHECK keys on: NULL = the token
  // row (tokens, never cost), non-NULL = a cost row (cost, never tokens).
  const isCost = over.costUsd != null
  await t.client`
    INSERT INTO provider_usage_fact
      (source, provider, teammate_id, date, tool, model, cost_type, context_window, cost_usd,
       input_tokens, output_tokens, requests, region_id, org_unit_id, cost_owning_unit_id)
    VALUES (
      'test-source',
      ${over.provider ?? 'anthropic'},
      ${over.teammate ?? alice}::uuid,
      ${over.date ?? '2026-06-02'}::date,
      'claude-code',
      ${over.model === undefined ? 'claude-opus-5' : over.model},
      ${isCost ? 'tokens' : null},
      ${over.contextWindow ?? null},
      ${isCost ? over.costUsd : null},
      ${isCost ? null : (over.input ?? null)},
      ${isCost ? null : (over.output ?? null)},
      ${isCost ? null : (over.requests ?? null)},
      ${over.region ?? regionA}::uuid,
      ${over.unit ?? unitA}::uuid,
      ${over.unit ?? unitA}::uuid)`
}

const arm = (e: TierExposure, provider: string) => e.providers.find((p) => p.provider === provider)!
const band = (e: TierExposure, provider: string, id: TierBand) =>
  arm(e, provider).bands.find((b) => b.band === id)!

beforeAll(async () => {
  t = await startTestDb()

  await t.client`INSERT INTO region (code, display_name) VALUES ('tea', 'Tier A'), ('teb', 'Tier B')`
  ;[{ id: regionA }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='tea'`
  ;[{ id: regionB }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='teb'`

  const mkUnit = async (region: string, code: string) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${code}::ltree, ${code}, ${code}, 'practice', true)`
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code=${code}`
    return u!.id
  }
  unitA = await mkUnit(regionA, 'tua')
  unitB = await mkUnit(regionB, 'tub')

  const mkTeammate = async (region: string, unit: string, email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES (${'oid-' + email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid, true)`
    const [m] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return m!.id
  }
  alice = await mkTeammate(regionA, unitA, 'tier-alice@x.test')
  bob = await mkTeammate(regionB, unitB, 'tier-bob@x.test')

  /*
   * THE FAN-OUT FIXTURE. `gpt-5-mini` is the one seeded model whose name
   * contains another seeded pattern, so it is the only row that can prove the
   * absence of a fan-out. Its money is the whole of the economy band.
   */
  // Banded since W0a (mig 0127): the context-window dimension rides the same
  // rows the tier tests read, so those tests double as the "tier figures are
  // unchanged by the finer grain" proof.
  await fact({ model: 'gpt-5-mini', contextWindow: '0-200k', costUsd: MINI_USD })
  await fact({ model: 'gpt-5-mini', contextWindow: '0-200k', input: 800, output: 200 })

  // A frontier model, so "economy is not everything" is also load-bearing: a
  // fan-out would move MINI_USD into frontier ALONGSIDE this, not instead of it.
  // Its cost is '200k+'-banded; its TOKEN row predates collection (NULL band),
  // so the context volume bar has a not-counted band to state.
  await fact({ model: 'claude-opus-5', contextWindow: '200k+', costUsd: 60 })
  await fact({ model: 'claude-opus-5', input: 300, output: 100 })

  // A model migration 0046 does not seed → Unclassified, SHOWN, never economy.
  await fact({ model: 'gemini-3-ultra', costUsd: 25 })

  // A record with no model at all → its own band, distinct from unclassified.
  await fact({ model: null, costUsd: 10 })

  // Region B, so the clamp has something to exclude.
  await fact({ model: 'claude-sonnet-5', costUsd: 500, teammate: bob, region: regionB, unit: unitB })

  /*
   * §A usage for the actives invariant: alice on BOTH tools on 2026-06-02, bob
   * on claude-code only. Distinct actives that day = 2; Σ per-tool = 3.
   */
  const mkInstance = async (tm: string, region: string, unit: string, tool: string) => {
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), ${'p-' + tm + tool}, ${tm}::uuid, ${tool}, ${region}::uuid, ${unit}::uuid, 'h', 'P')`
    const [i] = await t.client<{ id: string }[]>`
      SELECT instance_id::text AS id FROM instance_attestation
      WHERE teammate_id=${tm}::uuid AND tool=${tool} LIMIT 1`
    return i!.id
  }
  const ar = async (tm: string, region: string, unit: string, tool: string, usd: number) => {
    const inst = await mkInstance(tm, region, unit, tool)
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd,
         fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${region}::uuid, ${unit}::uuid, ${tool},
              'claude-sonnet-5', 'input', 1000, ${usd}, 'tier-1', 'estimated',
              '2026-06-02T00:00:00Z'::timestamptz, ${'conv-' + tm + tool})`
  }
  await ar(alice, regionA, unitA, 'claude-code', 12)
  await ar(alice, regionA, unitA, 'copilot-cli', 4)
  await ar(bob, regionB, unitB, 'claude-code', 9)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('fetchTierExposure — no fan-out against the REAL model_catalog seed', () => {
  it('counts a gpt-5-mini dollar exactly once, in economy', async () => {
    const e = await fetchTierExposure(t.db, wholeCompanyFinance, WINDOW)

    // The catalog genuinely contains both patterns — if this precondition ever
    // stops holding, the fan-out assertion below becomes vacuous and must be
    // re-pointed at whatever the new overlap is.
    const [{ n }] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM model_catalog
      WHERE is_active AND position(model_pattern IN 'gpt-5-mini') > 0`
    expect(n).toBe(2)

    expect(band(e, 'anthropic', 'economy').spendUsd).toBeCloseTo(MINI_USD, 6)
    // A SUBSTRING equijoin would put MINI_USD here TOO, on top of the opus 60.
    expect(band(e, 'anthropic', 'frontier').spendUsd).toBeCloseTo(60, 6)
    expect(band(e, 'anthropic', 'frontier').spendUsd).not.toBeCloseTo(60 + MINI_USD, 2)
  })

  it('bands sum to the lane total, and the lane total is the money inserted', async () => {
    const e = await fetchTierExposure(t.db, wholeCompanyFinance, WINDOW)
    const a = arm(e, 'anthropic')
    const inserted = MINI_USD + 60 + 25 + 10 + 500
    expect(a.bandedSpendUsd).toBeCloseTo(inserted, 6)
    expect(a.bands.reduce((s, b) => s + b.spendUsd, 0)).toBeCloseTo(inserted, 6)
  })

  it('shows an unseeded model as Unclassified, never folded into Economy', async () => {
    const e = await fetchTierExposure(t.db, wholeCompanyFinance, WINDOW)
    expect(band(e, 'anthropic', 'unclassified').spendUsd).toBeCloseTo(25, 6)
    expect(band(e, 'anthropic', 'no-model').spendUsd).toBeCloseTo(10, 6)
    // Economy holds the mini row and nothing else.
    expect(band(e, 'anthropic', 'economy').spendUsd).toBeCloseTo(MINI_USD, 6)
  })

  it('threads the scope clamp — region B’s $500 is excluded from region A', async () => {
    const e = await fetchTierExposure(
      t.db,
      clampedFinance(sql`region_id = ${regionA}::uuid`),
      WINDOW,
    )
    expect(arm(e, 'anthropic').bandedSpendUsd).toBeCloseTo(MINI_USD + 60 + 25 + 10, 6)
    expect(band(e, 'anthropic', 'mid').spendUsd).toBe(0)
  })
})

describe('fetchTierExposure — the context-window exposure reads the column (W0a D6, T6)', () => {
  /*
   * MUTATION: drop `context_window` from the scan's SELECT/GROUP BY — every
   * dollar lands in the un-banded remainder, the two band expectations go red,
   * and the "reads the column" claim is exactly what fails.
   */
  it('bands the fact column and types the un-banded remainder', async () => {
    const e = await fetchTierExposure(t.db, wholeCompanyFinance, WINDOW)
    const ctx = arm(e, 'anthropic').contextWindow!

    expect(ctx.bands.map((b) => b.band)).toEqual(['0-200k', '200k+'])
    expect(ctx.bands[0]!.spendUsd).toBeCloseTo(MINI_USD, 6)
    expect(ctx.bands[1]!.spendUsd).toBeCloseTo(60, 6)
    // The '0-200k' token row is counted; the '200k+' band has cost only — its
    // tokens are NOT COUNTED, never claimed as zero (the opus token row
    // predates collection and sits in no band).
    expect(ctx.bands[0]!.tokens).toBe(1000)
    expect(ctx.bands[1]!.tokens).toBeNull()

    // Pre-collection money is the reason-typed remainder, never a band:
    // gemini 25 + no-model 10 + region-B sonnet 500 all carry NULL bands.
    expect(ctx.unbandedSpendUsd).toBeCloseTo(25 + 10 + 500, 6)
    expect(ctx.unbandedReason).toBe('before-collection')

    // Both partitions of the same cost rows foot to the arm's lane total.
    expect(ctx.bandedSpendUsd + ctx.unbandedSpendUsd).toBeCloseTo(
      arm(e, 'anthropic').bandedSpendUsd,
      6,
    )

    // No fake symmetry: the Copilot wire has no context-window dimension, so
    // its arm carries NO leg — absence, not an all-remainder lie.
    expect(arm(e, 'github').contextWindow).toBeNull()
  })

  it('threads the scope clamp — region B stays out of region A’s remainder', async () => {
    const e = await fetchTierExposure(
      t.db,
      clampedFinance(sql`region_id = ${regionA}::uuid`),
      WINDOW,
    )
    const ctx = arm(e, 'anthropic').contextWindow!
    expect(ctx.unbandedSpendUsd).toBeCloseTo(25 + 10, 6)
    expect(ctx.bandedSpendUsd).toBeCloseTo(MINI_USD + 60, 6)
  })
})

describe('fetchTierExposure — measure exclusivity holds through one GROUP BY', () => {
  it('does not multiply cost by the token rows loaded beside it', async () => {
    const e = await fetchTierExposure(t.db, wholeCompanyFinance, WINDOW)
    // gpt-5-mini has ONE cost row and ONE token row in the window. A merged view
    // or a join across the two would give 2 × MINI_USD and 2 × 1000 tokens.
    expect(band(e, 'anthropic', 'economy').spendUsd).toBeCloseTo(MINI_USD, 6)
    expect(band(e, 'anthropic', 'economy').consumption).toBe(1000)
    expect(band(e, 'anthropic', 'frontier').consumption).toBe(400)
  })

  it('reports a band with money and no token row as NOT COUNTED, not zero', async () => {
    const e = await fetchTierExposure(t.db, wholeCompanyFinance, WINDOW)
    // unclassified + no-model carry cost rows only.
    expect(band(e, 'anthropic', 'unclassified').consumption).toBeNull()
    expect(band(e, 'anthropic', 'no-model').consumption).toBeNull()
    // …so the volume denominator is the counted subset, and the arm says how
    // much money that subset covers.
    expect(arm(e, 'anthropic').totalConsumption).toBe(1400)
    expect(arm(e, 'anthropic').consumptionCoveredSpendUsd).toBeCloseTo(MINI_USD + 60, 6)
  })
})

describe('fetchTierExposure — `no-data-yet` is not a zero', () => {
  it('reports github as no-data-yet while its adapter has written nothing', async () => {
    const e = await fetchTierExposure(t.db, wholeCompanyFinance, WINDOW)
    expect(arm(e, 'github').availability).toBe('no-data-yet')
    expect(arm(e, 'anthropic').availability).toBe('ok')
  })

  it('a scope with no rows in the window is a GENUINE zero, still `ok`', async () => {
    // Anthropic HAS written to the lane; this window simply holds nothing.
    const e = await fetchTierExposure(t.db, wholeCompanyFinance, {
      startIso: '2025-01-01T00:00:00.000Z',
      endIso: '2025-01-05T00:00:00.000Z',
    })
    expect(arm(e, 'anthropic').availability).toBe('ok')
    expect(arm(e, 'anthropic').bandedSpendUsd).toBe(0)
  })

  it('flips to `ok` — and never bands the money — once a github row lands', async () => {
    /*
     * THE MONEY GOES ON A `model IS NULL` ROW. This fixture used to put the $90
     * on a `gpt-5-mini` row, which mig 0120's
     * `provider_usage_fact_github_money_grain_chk` now rejects outright: Copilot
     * sends `ai_credits_used` at the RECORD ROOT, at day grain, and a GitHub row
     * carrying both a model and a cost could only have got there by splitting a
     * day's credits across models by a share — a ratio. The constraint turned
     * this fixture's own premise into an INSERT error, which is the arm working
     * exactly as designed. The assertions below are unchanged: the money is
     * still reported whole and unbanded, and the model dimension still carries
     * activity only.
     */
    await fact({ provider: 'github', model: null, costUsd: 90, date: '2026-06-03' })
    await fact({ provider: 'github', model: 'gpt-5-mini', requests: 40, date: '2026-06-03' })
    await fact({ provider: 'github', model: 'gpt-4o', requests: 10, date: '2026-06-03' })
    try {
      const e = await fetchTierExposure(t.db, wholeCompanyFinance, WINDOW)
      const g = arm(e, 'github')
      expect(g.availability).toBe('ok')
      expect(g.kind).toBe('mix-only')
      // Day-grain credits are reported WHOLE. Splitting them 80/20 across the
      // two models by activity share would be a ratio, and this design has none.
      expect(g.bandedSpendUsd).toBe(0)
      expect(g.bands.every((b) => b.spendUsd === 0)).toBe(true)
      expect(g.unbandedSpendUsd).toBeCloseTo(90, 6)
      expect(band(e, 'github', 'economy').consumptionSharePct).toBeCloseTo(0.8, 9)
      expect(band(e, 'github', 'mid').consumptionSharePct).toBeCloseTo(0.2, 9)
    } finally {
      // Leave the lane as the other tests expect to find it.
      await t.client`DELETE FROM provider_usage_fact WHERE provider = 'github'`
    }
  })
})

describe('distinct daily actives vs the per-tool counts', () => {
  it('distinct ≤ Σ per-tool, and STRICTLY less on a day someone uses both', async () => {
    const daily = await fetchDailyMetrics(t.db, clampedUsage(sql`TRUE`), WINDOW, CLOCK)
    const perTool = await fetchAcrossActiveTrend(t.db, WINDOW)

    const byDay = new Map(perTool.map((p) => [p.day, p.claudeCode + p.copilot]))
    for (const d of daily) {
      const sum = byDay.get(d.day) ?? 0
      expect(d.activeUsers, `${d.day}: distinct must not exceed Σ per-tool`).toBeLessThanOrEqual(sum)
    }

    // The fixture's whole point: alice is on BOTH tools on 2026-06-02, so the
    // per-tool counts double-count her and the inequality must be STRICT there.
    // Without this the assertion above passes vacuously on any single-tool day.
    const both = daily.find((d) => d.day === '2026-06-02')!
    expect(both.activeUsers).toBe(2)
    expect(byDay.get('2026-06-02')).toBe(3)
    expect(both.activeUsers).toBeLessThan(byDay.get('2026-06-02')!)
  })
})
