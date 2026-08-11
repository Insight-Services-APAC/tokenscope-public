// @vitest-environment node
/*
 * T5 — the context-window residency read (W0a D5,
 * docs/design/developer-pages-consolidation/01-build-design.md).
 *
 * Banded + NULL-band facts → banded segments + a reason-typed remainder, and
 * Σ segments (+ remainder) = the caller's window total. The exclusions are the
 * load-bearing half: token rows (measure exclusivity — pricing the lever means
 * cost rows only), other teammates, out-of-window days, and GitHub rows (whose
 * NULL band means "no such dimension", not "before collection began" — filing
 * them under the remainder would assert a history that never existed).
 *
 * Facts are hand-seeded HERE, deliberately: this read's contract is over the
 * fact table, and the poll+transform path that fills it is pinned by
 * tests/integration/provider/provider-context-window.test.ts.
 *
 * Each assertion was verified to FAIL with its fix reverted; the mutation is
 * recorded above it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { contextWindowResidency } from '../../../server/usage/context-residency'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let alice = ''
let bob = ''

const WINDOW = { from: '2026-07-01', to: '2026-07-31' }

async function fact(over: {
  teammate: string
  date: string
  provider?: string
  contextWindow?: string | null
  costUsd?: number
  tokens?: { input: number; output: number }
}): Promise<void> {
  const isCost = over.costUsd != null
  await t.client`
    INSERT INTO provider_usage_fact
      (source, provider, teammate_id, date, tool, model, cost_type, context_window,
       cost_usd, input_tokens, output_tokens)
    VALUES (
      'test-source',
      ${over.provider ?? 'anthropic'},
      ${over.teammate}::uuid,
      ${over.date}::date,
      ${(over.provider ?? 'anthropic') === 'github' ? 'copilot-cli' : 'claude-code'},
      ${isCost && (over.provider ?? 'anthropic') === 'github' ? null : 'claude-opus-5'},
      ${isCost ? 'tokens' : null},
      ${over.contextWindow ?? null},
      ${isCost ? over.costUsd : null},
      ${isCost ? null : (over.tokens?.input ?? 0)},
      ${isCost ? null : (over.tokens?.output ?? 0)})`
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'cwr', displayName: 'CWR' }).returning()
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: r!.id, path: 'cwr', code: 'cwr-bu', displayName: 'CWR', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  const mk = async (email: string) => {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: `oid-${email}`, email, regionId: r!.id, orgUnitId: ou!.id })
      .returning()
    return tm!.id
  }
  alice = await mk('cwr-alice@x.test')
  bob = await mk('cwr-bob@x.test')

  // Alice, in window: two bands + a pre-collection day.
  await fact({ teammate: alice, date: '2026-07-10', contextWindow: '0-200k', costUsd: 30 })
  await fact({ teammate: alice, date: '2026-07-11', contextWindow: '0-200k', costUsd: 12.5 })
  await fact({ teammate: alice, date: '2026-07-12', contextWindow: '200k+', costUsd: 7.25 })
  await fact({ teammate: alice, date: '2026-07-05', contextWindow: null, costUsd: 4 })

  // A banded TOKEN row — measure exclusivity: it must not mint a segment.
  await fact({ teammate: alice, date: '2026-07-10', contextWindow: '200k+', tokens: { input: 900, output: 100 } })

  // Copilot day-grain money for alice — NULL band because the wire HAS no such
  // dimension; it must not enter this read at all.
  await fact({ teammate: alice, date: '2026-07-10', provider: 'github', costUsd: 99 })

  // Out of window, and another teammate — both excluded.
  await fact({ teammate: alice, date: '2026-06-20', contextWindow: '0-200k', costUsd: 1000 })
  await fact({ teammate: bob, date: '2026-07-10', contextWindow: '0-200k', costUsd: 500 })
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('contextWindowResidency (T5)', () => {
  /*
   * MUTATION: fold NULL-band money into a band (drop the `context_window IS
   * NULL` split), or drop the GROUP BY — the segments/remainder split
   * collapses and every expectation below goes red.
   */
  it('returns banded segments + a reason-typed remainder that foot to the window total', async () => {
    const out = await contextWindowResidency(t.db as never, alice, WINDOW)

    expect(out.segments).toEqual([
      { band: '0-200k', costUsd: 42.5 },
      { band: '200k+', costUsd: 7.25 },
    ])
    expect(out.remainder).toEqual({
      costUsd: 4,
      reason: 'before-collection',
      label: 'not banded — before collection began',
    })
    // Σ segments + remainder = the window total — the card's honesty invariant.
    expect(out.totalUsd).toBeCloseTo(42.5 + 7.25 + 4, 9)
    expect(out.window).toEqual(WINDOW)
  })

  /*
   * MUTATION: drop `provider = 'anthropic'` — the $99 Copilot day lands in the
   * remainder under a reason that is FALSE for it, and 4 becomes 103.
   * MUTATION: drop `cost_type IS NOT NULL` — the banded token row mints a
   * zero-dollar '200k+' contribution and the segment sums shift.
   */
  it('excludes github rows, token rows, other teammates and out-of-window days', async () => {
    const out = await contextWindowResidency(t.db as never, alice, WINDOW)
    expect(out.totalUsd).toBeCloseTo(53.75, 9)
    expect(out.remainder!.costUsd).toBe(4)
  })

  it('a fully-banded window has NO remainder — the healed steady state', async () => {
    const out = await contextWindowResidency(t.db as never, alice, {
      from: '2026-07-10',
      to: '2026-07-12',
    })
    expect(out.remainder).toBeNull()
    expect(out.segments.map((s) => s.band)).toEqual(['0-200k', '200k+'])
    expect(out.totalUsd).toBeCloseTo(49.75, 9)
  })

  it('a window with no rows is an honest empty, not a zero-band invention', async () => {
    const out = await contextWindowResidency(t.db as never, bob, {
      from: '2026-01-01',
      to: '2026-01-31',
    })
    expect(out.segments).toEqual([])
    expect(out.remainder).toBeNull()
    expect(out.totalUsd).toBe(0)
  })
})
