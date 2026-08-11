// @vitest-environment node
/*
 * Work item 1 — Anthropic's `server_tool_use.web_search_requests` is DECLARED,
 * CARRIED, and re-derived from retained raw. Design:
 * docs/design/reporting-consolidation/05-api-sourced-usage-carries-its-
 * dimensions.md.
 *
 * Written against the REAL paths, the same discipline provider-transform.test.ts
 * states: runEnterpriseAnalyticsPoll produces the `actual_spend.raw_payload`
 * that runProviderTransform reads, and the assertions are made on the rows those
 * two actually wrote. No hand-built INSERT, no private helper.
 *
 * THE HEADLINE CLAIM IS "CHANGES NO DOLLAR FIGURE", NOT "INERT".
 * provider-transform.ts:40-45 explicitly retracts the word "inert" for this
 * table, because server/reporting/engine/billed-axis.ts reads it live. The §B
 * invariance test at the bottom therefore compares an actual billed-lane
 * RESPONSE, byte for byte, rather than grepping for the absence of a name.
 *
 * NO RE-POLL IS NEEDED for history: the poller has always retained each
 * teammate-day's usage rows verbatim, and `.passthrough()` has been carrying
 * `server_tool_use` into them (257/257 stored rows in the 2026-08-02 capture).
 * The "re-derives from a payload already on disk" test proves exactly that — it
 * writes the payload, then transforms WITHOUT polling again.
 *
 * Each assertion was verified to FAIL with its fix reverted; the mutation is
 * recorded above it and in the commit message.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runEnterpriseAnalyticsPoll, sourceForOrg } from '../../../server/workers/analytics-poller'
import { runProviderTransform } from '../../../server/workers/provider-transform'
import { fetchBilledAxis, BILLED_AXES } from '../../../server/reporting/engine/billed-axis'
import type { AnthropicEnterpriseClient } from '../../../server/anthropic/enterprise-client'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let orgUnitId: string

const EMAIL = 'stu@provider-server-tool-use.test'
const ORG = 'stu-org'
const SOURCE = sourceForOrg(ORG)
const DAY = '2026-07-10'

const actor = () => ({ type: 'user_actor', email: EMAIL, deleted: false })

/**
 * A usage-report row. `serverToolUse` is passed through EXACTLY as given so a
 * test can distinguish the three states the wire actually has: the key absent,
 * the key present with a number, and the key present as an explicit null.
 */
const usageRow = (opts: {
  model?: string | null
  inTok?: number
  outTok?: number
  requests?: number
  serverToolUse?: unknown
}) => {
  const row: Record<string, unknown> = {
    actor: actor(),
    product: 'claude_code',
    model: opts.model === undefined ? 'claude-opus-5' : opts.model,
    uncached_input_tokens: opts.inTok ?? 0,
    output_tokens: opts.outTok ?? 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    total_tokens: (opts.inTok ?? 0) + (opts.outTok ?? 0),
    requests: opts.requests ?? 0,
  }
  if ('serverToolUse' in opts) row.server_tool_use = opts.serverToolUse
  return row
}

/** A cost-report row: an amount in fractional CENTS, no tokens. */
const costRow = (opts: { model?: string | null; cents: string }) => ({
  actor: actor(),
  currency: 'USD',
  amount: opts.cents,
  cost_type: 'tokens',
  product: 'claude_code',
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

const transform = () => runProviderTransform(t.db, { startingAt: DAY, endingAt: DAY, source: SOURCE })

/** The token rows only — `web_search_requests` rides the token row, like `requests`. */
async function tokenRows(): Promise<{ model: string | null; requests: string | null; web: string | null }[]> {
  return t.client<{ model: string | null; requests: string | null; web: string | null }[]>`
    SELECT model, requests::text AS requests, web_search_requests::text AS web
      FROM provider_usage_fact
     WHERE cost_type IS NULL
     ORDER BY COALESCE(model, '')`
}

async function reset(): Promise<void> {
  await t.client`DELETE FROM provider_usage_fact`
  await t.client`DELETE FROM actual_spend`
  await t.client`DELETE FROM pending_placement`
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'stu', displayName: 'STU' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'stu', code: 'stu-bu', displayName: 'STU', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
  await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-stu', email: EMAIL, regionId, orgUnitId })
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(reset)

describe('server_tool_use — declared and carried', () => {
  /*
   * MUTATION: delete the `web_search_requests` column from the INSERT column
   * list and VALUES in server/workers/provider-fact.ts — the column stays NULL
   * and the `'9'` expectation goes red.
   */
  it('carries web_search_requests from the wire onto the token row', async () => {
    await poll({
      [DAY]: {
        usage: [usageRow({ inTok: 100, outTok: 50, requests: 4, serverToolUse: { web_search_requests: 9 } })],
        cost: [costRow({ cents: '1000' })],
      },
    })
    await transform()

    const rows = await tokenRows()
    expect(rows.length).toBe(1)
    expect(rows[0]!.web).toBe('9')
    // Single-homed alongside, never folded into, `requests`.
    expect(rows[0]!.requests).toBe('4')
  })

  /*
   * NULL IS NOT ZERO. A payload captured before the field existed must not be
   * turned into a positive assertion that the provider reported zero searches.
   *
   * MUTATION: replace the `if (webSearches !== null)` guard in
   * provider-transform.ts with an unguarded
   * `into.webSearchRequests = (into.webSearchRequests ?? 0) + (webSearches ?? 0)`
   * — the absent case writes 0 and the `toBeNull()` below goes red.
   */
  it('leaves the column NULL when the provider did not carry the field', async () => {
    await poll({ [DAY]: { usage: [usageRow({ inTok: 10 })], cost: [costRow({ cents: '100' })] } })
    await transform()
    expect((await tokenRows())[0]!.web).toBeNull()
  })

  it('records an explicit zero as zero, not as absent', async () => {
    await poll({
      [DAY]: {
        usage: [usageRow({ inTok: 10, serverToolUse: { web_search_requests: 0 } })],
        cost: [costRow({ cents: '100' })],
      },
    })
    await transform()
    expect((await tokenRows())[0]!.web).toBe('0')
  })

  /*
   * Copilot review (PR #231). `n > 0 ? Math.trunc(n) : 0` turned a NEGATIVE or
   * FRACTIONAL count — a value the provider should never send, and a signal
   * something upstream is wrong — into a positive assertion of "zero searches".
   * That is a measurement, and it destroys the very NULL-vs-0 distinction the
   * column exists to carry: an explicit 0 above and a corrupt value here would
   * be indistinguishable downstream.
   *
   * A count we cannot trust is ABSENT.
   *
   * MUTATION: restore `return n > 0 ? Math.trunc(n) : 0` — both assertions read
   * '0' instead of null and go red.
   */
  it('treats a value that is not a count as absent, never as zero', async () => {
    await poll({
      [DAY]: {
        usage: [usageRow({ inTok: 10, serverToolUse: { web_search_requests: -3 } })],
        cost: [costRow({ cents: '100' })],
      },
    })
    await transform()
    expect((await tokenRows())[0]!.web).toBeNull()

    await reset()
    await poll({
      [DAY]: {
        usage: [usageRow({ inTok: 10, serverToolUse: { web_search_requests: 2.7 } })],
        cost: [costRow({ cents: '100' })],
      },
    })
    await transform()
    expect((await tokenRows())[0]!.web).toBeNull()
  })

  /*
   * THE TRANSFORM tolerates an explicit null at either level and still writes
   * both rows.
   *
   * SCOPE, STATED PRECISELY BECAUSE IT IS NARROWER THAN IT LOOKS: this proves
   * the DERIVE is null-tolerant, and NOTHING about the Zod declaration. The fake
   * client above hands the poller row objects DIRECTLY, so no parse runs in this
   * file at all — narrowing `server_tool_use` to a non-nullish shape leaves every
   * assertion here green (verified). The declaration's null-tolerance, which is
   * the half that can silently kill an org's polling, is pinned where a real
   * parse happens: tests/integration/anthropic/enterprise-client.test.ts,
   * "accepts an explicit null server_tool_use, and a null leaf".
   *
   * MUTATION: make webSearchRequestsOf throw or coerce on a null leaf (e.g. drop
   * the `typeof n !== 'number'` guard so `null` flows into Math.trunc) — the rows
   * carry 0 instead of NULL and the last assertion goes red.
   */
  it('derives both rows when the payload carries an explicit null at either level', async () => {
    await poll({
      [DAY]: {
        usage: [
          usageRow({ model: 'claude-opus-5', inTok: 10, serverToolUse: null }),
          usageRow({ model: 'claude-sonnet-5', inTok: 20, serverToolUse: { web_search_requests: null } }),
        ],
        cost: [costRow({ cents: '100' })],
      },
    })
    await transform()

    const rows = await tokenRows()
    // Both rows landed — the parse did not throw and the day was not lost.
    expect(rows.map((r) => r.model)).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    expect(rows.every((r) => r.web === null)).toBe(true)
  })

  /*
   * "RE-DERIVE FROM RETAINED RAW", proven: the second transform runs with NO
   * second poll, so the only possible source for the value is the payload
   * already sitting in actual_spend.raw_payload.
   *
   * MUTATION: make webSearchRequestsOf return null unconditionally — the
   * re-derived value goes back to NULL and this goes red.
   */
  it('re-derives from a payload already on disk, with no re-poll', async () => {
    await poll({
      [DAY]: {
        usage: [usageRow({ inTok: 100, serverToolUse: { web_search_requests: 5 } })],
        cost: [costRow({ cents: '1000' })],
      },
    })
    await transform()
    expect((await tokenRows())[0]!.web).toBe('5')

    // Drop the derived rows, keep the retained raw, and transform again.
    await t.client`DELETE FROM provider_usage_fact`
    await transform()

    const rows = await tokenRows()
    expect(rows.length).toBe(1)
    expect(rows[0]!.web).toBe('5')
  })

  /*
   * Several products can map to one tool lane, so two payload rows can share one
   * grain key. The measure must SUM rather than overwrite — the same ING-4
   * aggregate defect the poller guards against.
   *
   * MUTATION: change the accumulate body to
   * `into.webSearchRequests = webSearches` — the second row overwrites the first
   * and the total reads 3 instead of 10.
   */
  it('sums, never overwrites, when two payload rows share one grain', async () => {
    await poll({
      [DAY]: {
        usage: [
          usageRow({ inTok: 10, serverToolUse: { web_search_requests: 7 } }),
          usageRow({ inTok: 20, serverToolUse: { web_search_requests: 3 } }),
        ],
        cost: [costRow({ cents: '100' })],
      },
    })
    await transform()

    const rows = await tokenRows()
    expect(rows.length).toBe(1)
    expect(rows[0]!.web).toBe('10')
  })
})

describe('§B behavioural invariance — a billed-lane read is unchanged', () => {
  /*
   * THE CLAIM UNDER TEST: carrying server_tool_use changes NO dollar figure.
   *
   * This is asserted as an actual RESPONSE COMPARISON, not a grep. Two estates
   * are built through the real poll+transform path, identical in every respect
   * except that one carries `server_tool_use` on every usage row and the other
   * omits the key entirely. Every billed-lane axis is then read through
   * `fetchBilledAxis` — the live reader that provider-transform.ts:40-45 names
   * when it retracts the word "inert" — and the two payloads must serialise
   * identically.
   *
   * MUTATION (the defect this exists to catch): make the transform add
   * `webSearches` into `into.costUsd`, or write the count into `cost_usd` on the
   * cost row — the `region`/`model`/`teammate` axis values diverge and the
   * deep-equality assertion goes red. Verified by doing exactly that.
   */
  async function readEveryBilledAxis() {
    const range = { startIso: `${DAY}T00:00:00.000Z`, endIso: '2026-07-11T00:00:00.000Z' }
    const out: Record<string, unknown> = {}
    for (const axis of BILLED_AXES) {
      out[axis] = await fetchBilledAxis(
        t.db as never,
        sql`TRUE`,
        range as never,
        axis,
      )
    }
    return out
  }

  it('returns a byte-identical billed-lane response with and without the field', async () => {
    const cost = [costRow({ model: 'claude-opus-5', cents: '12345' }), costRow({ model: 'claude-sonnet-5', cents: '6789' })]

    // WITHOUT the field — the key is absent from every usage row.
    await poll({
      [DAY]: {
        usage: [
          usageRow({ model: 'claude-opus-5', inTok: 500, outTok: 250, requests: 8 }),
          usageRow({ model: 'claude-sonnet-5', inTok: 300, outTok: 100, requests: 3 }),
        ],
        cost,
      },
    })
    await transform()
    const before = JSON.stringify(await readEveryBilledAxis())
    // Non-vacuous: the estate really does carry billed money to compare.
    // Non-vacuous: the response really carries this estate's billed money, per
    // provider and per model, so an equality over it is comparing something.
    expect(before).toContain('123.45')
    expect(before).toContain('67.89')
    expect(before).toContain('claude-opus-5')
    expect(before).toContain('anthropic')
    expect((await tokenRows()).every((r) => r.web === null)).toBe(true)

    // WITH the field — same money, same models, same tokens, plus server_tool_use.
    await reset()
    await poll({
      [DAY]: {
        usage: [
          usageRow({ model: 'claude-opus-5', inTok: 500, outTok: 250, requests: 8, serverToolUse: { web_search_requests: 41 } }),
          usageRow({ model: 'claude-sonnet-5', inTok: 300, outTok: 100, requests: 3, serverToolUse: { web_search_requests: 17 } }),
        ],
        cost,
      },
    })
    await transform()
    const after = JSON.stringify(await readEveryBilledAxis())

    // The field genuinely landed — otherwise this comparison proves nothing.
    expect((await tokenRows()).map((r) => r.web).sort()).toEqual(['17', '41'])

    expect(after).toBe(before)
  })
})
