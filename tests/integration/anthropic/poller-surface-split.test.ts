// @vitest-environment node
/*
 * #142 per-surface chargeback split — the Enterprise analytics poller writes ONE
 * actual_spend lane per `product` surface (mapProductToTool), converges stale
 * pre-split rows, guards against mass identity failure, audits consequential
 * adjustments, and threads the surface lane through the owed-bill (placement)
 * queue. Real Postgres (per-suite DB, full migrations incl. 0084); the
 * Enterprise client is stubbed per test in the poller.test.ts fixture style.
 *
 * Money invariants under test:
 *   - CONSERVATION: Σ split lane rows == Σ API fixture (nothing vanishes,
 *     nothing doubles);
 *   - unknown products land in the labelled claude-other lane and are REPORTED,
 *     never dropped;
 *   - the stale-row prune converges old collapsed rows but NEVER touches other
 *     sources, non-Claude tools, days outside the window — and is SKIPPED
 *     wholesale when identity resolution looks broken: the guard is a RATIO
 *     (prune only while skipped/total <= 0.5), so partial breakage skips the
 *     prune while a healthy few-skips run (and a genuinely quiet zero-row
 *     window) still converges;
 *   - runAnalyticsPollReconciledOrgs honours { onlyExternalOrgId } — one org
 *     polled, unknown id → clean no-op (#142 org scoping);
 *   - non-Code lanes never leak into the §A needs-tagging view — via mig 0084 at
 *     the time this file's fixtures were written, via mig 0101's
 *     INGEST_ONLY_USAGE_TOOLS today (v_teammate_usage_daily itself is restored
 *     to the complete usage truth; see the "migration 0101 (A1)" describe block
 *     below).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runEnterpriseAnalyticsPoll, runAnalyticsPollReconciledOrgs } from '../../../server/workers/analytics-poller'
import type { AnthropicEnterpriseClient } from '../../../server/anthropic/enterprise-client'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let priyaId: string
let meeraId: string
let rohanId: string

const PRIYA = 'priya.split@example.com'
const MEERA = 'meera.split@example.com'
const ROHAN = 'rohan.split@example.com'

/* ---------- Enterprise API fixture builders (poller.test.ts shapes) ---------- */

const actor = (email: string) => ({ type: 'user_actor', email, deleted: false })

const usageRow = (email: string, product: string | null, inTokens: number, outTokens: number) => ({
  actor: actor(email),
  product,
  model: 'claude-sonnet-4-6',
  uncached_input_tokens: inTokens,
  output_tokens: outTokens,
  total_tokens: inTokens + outTokens,
})

// `amount` is a fractional-CENTS decimal string ('25' -> $0.25).
const costRow = (email: string, product: string | null, cents: string, costType = 'tokens') => ({
  actor: actor(email),
  currency: 'USD',
  amount: cents,
  cost_type: costType,
  product,
})

/** A stubbed Enterprise client serving fixed per-day usage/cost fixtures. */
function fakeEnterpriseClient(
  byDay: Record<string, { usage?: unknown[]; cost?: unknown[] }>,
): AnthropicEnterpriseClient {
  const day = (startingAt: string) => startingAt.slice(0, 10)
  return {
    getUserUsageReport: async ({ startingAt, groupBy }: { startingAt: string; groupBy?: string[] }) => {
      usageGroupBySeen.push(groupBy ?? [])
      return {
        has_more: false,
        next_page: null,
        data: byDay[day(startingAt)]?.usage ?? [],
      }
    },
    getUserCostReport: async ({ startingAt, groupBy }: { startingAt: string; groupBy?: string[] }) => {
      /*
       * Record what the PRODUCTION caller asked for. The client-level test that
       * covers cost_type passes the arrays in by hand, so deleting cost_type
       * from analytics-poller.ts would leave it green -- a test that cannot
       * fail for the regression it is named after. This stub captures the real
       * request so the assertion below is about the caller, not the fixture.
       */
      costGroupBySeen.push(groupBy ?? [])
      return {
        has_more: false,
        next_page: null,
        data: byDay[day(startingAt)]?.cost ?? [],
      }
    },
  } as unknown as AnthropicEnterpriseClient
}

/** group_by[] as the poller actually sent it, per call, per report. */
const costGroupBySeen: string[][] = []
const usageGroupBySeen: string[][] = []

/* ------------------------------ DB helpers ------------------------------ */

/** Seed a pre-existing actual_spend row with a pulled_at safely BEFORE any run. */
async function seedSpend(
  teammateId: string,
  day: string,
  tool: string,
  costUsd: number,
  source: string,
): Promise<void> {
  await t.client`
    INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, pulled_at)
    VALUES (${teammateId}::uuid, ${day}::date, ${tool}, 0, 0, ${costUsd}, ${source}, now() - interval '1 hour')`
}

async function spendRows(
  source: string,
): Promise<Array<{ teammate_id: string; date: string; tool: string; cost_usd: number; input_tokens: number; output_tokens: number }>> {
  const rows = await t.client<
    { teammate_id: string; date: string; tool: string; cost_usd: string; input_tokens: string; output_tokens: string }[]
  >`
    SELECT teammate_id::text AS teammate_id, date::text AS date, tool,
           cost_usd::text AS cost_usd, input_tokens::text AS input_tokens, output_tokens::text AS output_tokens
    FROM actual_spend WHERE source = ${source} ORDER BY teammate_id, tool`
  return rows.map((r) => ({
    ...r,
    cost_usd: Number(r.cost_usd),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
  }))
}

async function surfaceAuditEvents(source: string): Promise<Array<{ actor_system: string | null; payload: Record<string, unknown> }>> {
  return await t.client<{ actor_system: string | null; payload: Record<string, unknown> }[]>`
    SELECT actor_system, payload FROM audit_event
    WHERE event_type = 'actual-spend-surface-adjusted' AND payload->>'source' = ${source}
    ORDER BY ts_recorded`
}

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.db.insert(schema.region).values({ code: 'spl', displayName: 'Split Region' }).returning()
  const [org] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: region!.id, path: 'spl', code: 'spl-bu', displayName: 'Split BU', unitType: 'bu' })
    .returning()
  const mkTeammate = async (oid: string, email: string): Promise<string> => {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: oid, email, regionId: region!.id, orgUnitId: org!.id })
      .returning()
    return tm!.id
  }
  priyaId = await mkTeammate('oid-priya-split', PRIYA)
  meeraId = await mkTeammate('oid-meera-split', MEERA)
  rohanId = await mkTeammate('oid-rohan-split', ROHAN)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('runEnterpriseAnalyticsPoll — per-surface split (#142)', () => {
  it('splits one teammate-day across product lanes with per-surface sums + CONSERVATION', async () => {
    const DAY = '2026-07-01'
    const SOURCE = 'anthropic-analytics-api:org-split'
    const client = fakeEnterpriseClient({
      [DAY]: {
        usage: [
          usageRow(PRIYA, 'claude_code', 5000, 3000),
          usageRow(PRIYA, 'chat', 100, 50),
          usageRow(PRIYA, 'cowork', 10, 5),
        ],
        cost: [
          costRow(PRIYA, 'claude_code', '25'), // $0.25
          costRow(PRIYA, 'chat', '10'), // $0.10
          costRow(PRIYA, 'cowork', '7.5'), // $0.075
        ],
      },
    })

    const result = await runEnterpriseAnalyticsPoll(t.db, client, {
      startingAt: DAY,
      endingAt: DAY,
      externalOrgId: 'org-split',
    })

    expect(result.daysPulled).toBe(1)
    expect(result.recordsTotal).toBe(6) // 3 usage + 3 cost rows considered
    expect(result.recordsUpserted).toBe(3) // one row per surface lane
    expect(result.recordsSkippedUnknownUser).toBe(0)
    expect(result.rowsByTool).toEqual({ 'claude-code': 1, 'claude-ai': 1, 'claude-cowork': 1 })
    expect(result.unknownProducts).toEqual({})
    expect(result.staleRowsDeleted).toBe(0)

    const rows = await spendRows(SOURCE)
    expect(rows).toHaveLength(3)
    const byTool = Object.fromEntries(rows.map((r) => [r.tool, r]))
    expect(byTool['claude-code']).toMatchObject({ input_tokens: 5000, output_tokens: 3000 })
    expect(byTool['claude-code']!.cost_usd).toBeCloseTo(0.25, 6)
    expect(byTool['claude-ai']).toMatchObject({ input_tokens: 100, output_tokens: 50 })
    expect(byTool['claude-ai']!.cost_usd).toBeCloseTo(0.1, 6)
    expect(byTool['claude-cowork']).toMatchObject({ input_tokens: 10, output_tokens: 5 })
    expect(byTool['claude-cowork']!.cost_usd).toBeCloseTo(0.075, 6)

    // CONSERVATION: Σ split rows == Σ fixture — nothing vanished, nothing doubled.
    expect(rows.reduce((a, r) => a + r.cost_usd, 0)).toBeCloseTo(0.25 + 0.1 + 0.075, 6)
    expect(rows.reduce((a, r) => a + r.input_tokens, 0)).toBe(5110)
    expect(rows.reduce((a, r) => a + r.output_tokens, 0)).toBe(3055)
  })

  it("an UNKNOWN product ('weird_new_surface') lands in claude-other + is reported — never dropped", async () => {
    const DAY = '2026-07-02'
    const SOURCE = 'anthropic-analytics-api:org-unknown'
    const client = fakeEnterpriseClient({
      [DAY]: {
        usage: [usageRow(PRIYA, 'weird_new_surface', 70, 30)],
        cost: [costRow(PRIYA, 'weird_new_surface', '5')], // $0.05
      },
    })

    const result = await runEnterpriseAnalyticsPoll(t.db, client, {
      startingAt: DAY,
      endingAt: DAY,
      externalOrgId: 'org-unknown',
    })

    expect(result.recordsUpserted).toBe(1)
    expect(result.rowsByTool).toEqual({ 'claude-other': 1 })
    // Both the usage and the cost row carried the unmapped value.
    expect(result.unknownProducts).toEqual({ weird_new_surface: 2 })

    const rows = await spendRows(SOURCE)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tool: 'claude-other', input_tokens: 70, output_tokens: 30 })
    expect(rows[0]!.cost_usd).toBeCloseTo(0.05, 6) // the money is IN the labelled lane, not dropped
  })

  it('STALE-ROW CONVERGENCE: old collapsed rows converge to split lanes with NO double count; other sources/tools/days untouched', async () => {
    const DAY = '2026-07-03'
    const SOURCE = 'anthropic-analytics-api:org-conv'
    const OTHER_SOURCE = 'anthropic-analytics-api:org-elsewhere'

    // Pre-split state (all pulled an hour ago):
    // - priya: collapsed claude-code row carrying code+chat combined ($0.35)
    await seedSpend(priyaId, DAY, 'claude-code', 0.35, SOURCE)
    // - meera: collapsed claude-code row, but her spend was ALL chat ($0.10)
    await seedSpend(meeraId, DAY, 'claude-code', 0.1, SOURCE)
    // - rohan: a row the API no longer returns at all (revised away)
    await seedSpend(rohanId, DAY, 'claude-code', 0.99, SOURCE)
    // - NOT prunable: a copilot row in the same source+window (outside the Claude family)
    await seedSpend(priyaId, DAY, 'copilot-cli', 4.0, SOURCE)
    // - NOT prunable: a claude-code row from a DIFFERENT source, same day
    await seedSpend(priyaId, DAY, 'claude-code', 1.11, OTHER_SOURCE)
    // - NOT prunable: a claude-code row in the same source OUTSIDE the window
    await seedSpend(priyaId, '2026-07-02', 'claude-code', 2.22, SOURCE)

    // The API truth is now SPLIT: priya = code $0.25 + chat $0.10; meera = chat only.
    const client = fakeEnterpriseClient({
      [DAY]: {
        usage: [
          usageRow(PRIYA, 'claude_code', 1000, 500),
          usageRow(PRIYA, 'chat', 200, 100),
          usageRow(MEERA, 'chat', 300, 150),
        ],
        cost: [costRow(PRIYA, 'claude_code', '25'), costRow(PRIYA, 'chat', '10'), costRow(MEERA, 'chat', '10')],
      },
    })

    const result = await runEnterpriseAnalyticsPoll(t.db, client, {
      startingAt: DAY,
      endingAt: DAY,
      externalOrgId: 'org-conv',
    })

    // Pruned: meera's collapsed claude-code row + rohan's revised-away row.
    // (priya's collapsed row was REPLACED in place by the re-asserted claude-code lane.)
    expect(result.staleRowsDeleted).toBe(2)

    const rows = await spendRows(SOURCE)
    const dayRows = rows.filter((r) => r.date === DAY)
    expect(dayRows.map((r) => `${r.teammate_id === priyaId ? 'priya' : r.teammate_id === meeraId ? 'meera' : 'rohan'}:${r.tool}`).sort()).toEqual(
      ['meera:claude-ai', 'priya:claude-ai', 'priya:claude-code', 'priya:copilot-cli'],
    )
    const priyaCode = dayRows.find((r) => r.teammate_id === priyaId && r.tool === 'claude-code')!
    expect(priyaCode.cost_usd).toBeCloseTo(0.25, 6) // code-only now — the collapsed $0.35 is GONE
    const priyaChat = dayRows.find((r) => r.teammate_id === priyaId && r.tool === 'claude-ai')!
    expect(priyaChat.cost_usd).toBeCloseTo(0.1, 6)
    const meeraChat = dayRows.find((r) => r.teammate_id === meeraId && r.tool === 'claude-ai')!
    expect(meeraChat.cost_usd).toBeCloseTo(0.1, 6)

    // NO DOUBLE COUNT: Σ claude-family lanes for this source+day == API truth ($0.45).
    const claudeFamilyTotal = dayRows.filter((r) => r.tool !== 'copilot-cli').reduce((a, r) => a + r.cost_usd, 0)
    expect(claudeFamilyTotal).toBeCloseTo(0.45, 6)

    // Untouched bystanders: the copilot row, the other source's row, the out-of-window row.
    expect(dayRows.find((r) => r.tool === 'copilot-cli')!.cost_usd).toBeCloseTo(4.0, 6)
    const otherSource = await spendRows(OTHER_SOURCE)
    expect(otherSource).toHaveLength(1)
    expect(otherSource[0]!.cost_usd).toBeCloseTo(1.11, 6)
    expect(rows.find((r) => r.date === '2026-07-02')!.cost_usd).toBeCloseTo(2.22, 6)

    // The prune left an audit trail.
    const events = await surfaceAuditEvents(SOURCE)
    expect(events).toHaveLength(1)
    expect(events[0]!.actor_system).toBe('worker:analytics-poll')
    expect(events[0]!.payload).toMatchObject({ staleRowsDeleted: 2 })
  })

  it('MASS-IDENTITY-FAILURE guard: API rows but ZERO binds (ratio 1.0 > 0.5) → NO prune, pre-seeded rows survive', async () => {
    const DAY = '2026-07-04'
    const SOURCE = 'anthropic-analytics-api:org-massfail'
    await seedSpend(priyaId, DAY, 'claude-code', 2.0, SOURCE) // would be pruned if the guard failed

    const client = fakeEnterpriseClient({
      [DAY]: {
        usage: [usageRow('nobody@nowhere.com', 'chat', 10, 5)],
        cost: [costRow('nobody@nowhere.com', 'chat', '5')],
      },
    })
    const result = await runEnterpriseAnalyticsPoll(t.db, client, {
      startingAt: DAY,
      endingAt: DAY,
      externalOrgId: 'org-massfail',
    })

    expect(result.recordsTotal).toBe(2)
    expect(result.recordsUpserted).toBe(0) // identity resolution bound NOTHING
    expect(result.recordsSkippedUnknownUser).toBe(2) // ratio 2/2 = 1.0 > PRUNE_MAX_SKIP_RATIO
    expect(result.staleRowsDeleted).toBe(0) // the guard: our defect must not erase the window

    const rows = await spendRows(SOURCE)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cost_usd).toBeCloseTo(2.0, 6) // the pre-existing bill row SURVIVED
  })

  it('RATIO guard, PARTIAL breakage: 2 of 3 rows fail to bind (0.67 > 0.5) → prune SKIPPED, stale row survives', async () => {
    const DAY = '2026-07-09'
    const SOURCE = 'anthropic-analytics-api:org-partialfail'
    // A stale collapsed row the run does NOT re-assert — pruned iff the prune fires.
    await seedSpend(meeraId, DAY, 'claude-code', 1.5, SOURCE)

    // 3 usage rows (no cost rows keeps the arithmetic legible): priya binds,
    // two ghosts don't → skipped/total = 2/3 ≈ 0.67 > 0.5.
    const client = fakeEnterpriseClient({
      [DAY]: {
        usage: [
          usageRow(PRIYA, 'chat', 100, 50),
          usageRow('ghost-a@nowhere.com', 'chat', 10, 5),
          usageRow('ghost-b@nowhere.com', 'chat', 10, 5),
        ],
      },
    })
    const result = await runEnterpriseAnalyticsPoll(t.db, client, {
      startingAt: DAY,
      endingAt: DAY,
      externalOrgId: 'org-partialfail',
    })

    expect(result.recordsTotal).toBe(3)
    expect(result.recordsUpserted).toBe(1) // priya's chat lane DID land
    expect(result.recordsSkippedUnknownUser).toBe(2)
    expect(result.staleRowsDeleted).toBe(0) // ratio guard: majority-broken identity → no prune

    const rows = await spendRows(SOURCE)
    expect(rows).toHaveLength(2) // priya's fresh lane + meera's SURVIVING stale row
    const meeraStale = rows.find((r) => r.teammate_id === meeraId)
    expect(meeraStale).toMatchObject({ tool: 'claude-code' })
    expect(meeraStale!.cost_usd).toBeCloseTo(1.5, 6)
  })

  it('RATIO guard, HEALTHY skips: 1 of 4 rows fails to bind (0.25 <= 0.5) → prune RUNS, stale row pruned', async () => {
    const DAY = '2026-07-10'
    const SOURCE = 'anthropic-analytics-api:org-healthyskip'
    // A stale lane the pull no longer returns — the prune must converge it away.
    await seedSpend(priyaId, DAY, 'claude-cowork', 0.5, SOURCE)

    // 4 usage rows: three bind, one ghost → skipped/total = 1/4 = 0.25 — the
    // normal "api_actors / not-yet-provisioned users" background rate.
    const client = fakeEnterpriseClient({
      [DAY]: {
        usage: [
          usageRow(PRIYA, 'claude_code', 1000, 500),
          usageRow(MEERA, 'chat', 200, 100),
          usageRow(ROHAN, 'chat', 300, 150),
          usageRow('ghost-c@nowhere.com', 'chat', 10, 5),
        ],
      },
    })
    const result = await runEnterpriseAnalyticsPoll(t.db, client, {
      startingAt: DAY,
      endingAt: DAY,
      externalOrgId: 'org-healthyskip',
    })

    expect(result.recordsTotal).toBe(4)
    expect(result.recordsUpserted).toBe(3)
    expect(result.recordsSkippedUnknownUser).toBe(1) // ratio 0.25 <= PRUNE_MAX_SKIP_RATIO
    expect(result.staleRowsDeleted).toBe(1) // the un-re-asserted cowork lane is GONE

    const rows = await spendRows(SOURCE)
    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.tool === 'claude-cowork')).toBeUndefined()
  })

  it('a genuinely quiet window (zero API rows) DOES prune revised-away rows', async () => {
    const DAY = '2026-07-08'
    const SOURCE = 'anthropic-analytics-api:org-quiet'
    await seedSpend(priyaId, DAY, 'claude-ai', 3.0, SOURCE)

    const result = await runEnterpriseAnalyticsPoll(t.db, fakeEnterpriseClient({}), {
      startingAt: DAY,
      endingAt: DAY,
      externalOrgId: 'org-quiet',
    })
    expect(result.recordsTotal).toBe(0)
    expect(result.staleRowsDeleted).toBe(1)
    expect(await spendRows(SOURCE)).toHaveLength(0)
  })

  it('AUDIT: routine no-change run writes NO surface-adjusted event; an unknown product writes one with the run payload', async () => {
    const DAY = '2026-07-06'
    const SOURCE = 'anthropic-analytics-api:org-audit'

    // Run 1 — routine: known products only, nothing stale.
    await runEnterpriseAnalyticsPoll(
      t.db,
      fakeEnterpriseClient({ [DAY]: { usage: [usageRow(PRIYA, 'chat', 100, 50)], cost: [costRow(PRIYA, 'chat', '10')] } }),
      { startingAt: DAY, endingAt: DAY, externalOrgId: 'org-audit' },
    )
    expect(await surfaceAuditEvents(SOURCE)).toHaveLength(0)

    // Run 2 — same window, now with an unmapped product (re-asserts chat so no prune;
    // the audit event is purely unknown-product-triggered).
    const result = await runEnterpriseAnalyticsPoll(
      t.db,
      fakeEnterpriseClient({
        [DAY]: {
          usage: [usageRow(PRIYA, 'chat', 100, 50), usageRow(PRIYA, 'mystery_lane', 9, 4)],
          cost: [costRow(PRIYA, 'chat', '10'), costRow(PRIYA, 'mystery_lane', '3')],
        },
      }),
      { startingAt: DAY, endingAt: DAY, externalOrgId: 'org-audit' },
    )
    expect(result.staleRowsDeleted).toBe(0)
    expect(result.unknownProducts).toEqual({ mystery_lane: 2 })

    const events = await surfaceAuditEvents(SOURCE)
    expect(events).toHaveLength(1)
    expect(events[0]!.actor_system).toBe('worker:analytics-poll')
    expect(events[0]!.payload).toMatchObject({
      window: { startingAt: DAY, endingAt: DAY },
      source: SOURCE,
      staleRowsDeleted: 0,
      unknownProducts: { mystery_lane: 2 },
    })
    expect(events[0]!.payload.rowsByTool).toMatchObject({ 'claude-ai': 1, 'claude-other': 1 })
  })

  it('OWED bills carry the per-surface lane: unknown-email chat spend queues a claude-ai pending_placement row', async () => {
    const DAY = '2026-07-07'
    const NEWBIE = 'newbie.split@example.com'
    const client = fakeEnterpriseClient({
      [DAY]: {
        usage: [usageRow(NEWBIE, 'chat', 300, 150)],
        cost: [costRow(NEWBIE, 'chat', '20')], // $0.20
      },
    })
    const result = await runEnterpriseAnalyticsPoll(t.db, client, {
      startingAt: DAY,
      endingAt: DAY,
      externalOrgId: 'org-owed',
    })
    expect(result.recordsUpserted).toBe(0)
    expect(result.recordsSkippedUnknownUser).toBe(2)

    // ONE aggregated owed row per (email, day, tool) — usage tokens + cost combined,
    // with the SURFACE lane (not claude-code) so placement replay preserves it.
    const owed = await t.client<
      { provider: string; actual_source: string; tool: string; date: string; cost_usd: string; input_tokens: string; output_tokens: string }[]
    >`
      SELECT provider, actual_source, tool, date::text AS date, cost_usd::text AS cost_usd,
             input_tokens::text AS input_tokens, output_tokens::text AS output_tokens
      FROM pending_placement WHERE lower(identity_email) = ${NEWBIE}`
    expect(owed).toHaveLength(1)
    expect(owed[0]).toMatchObject({
      provider: 'anthropic',
      actual_source: 'anthropic-analytics-api:org-owed',
      tool: 'claude-ai',
      date: DAY,
      input_tokens: '300',
      output_tokens: '150',
    })
    expect(Number(owed[0]!.cost_usd)).toBeCloseTo(0.2, 6)
  })
})

/*
 * { onlyExternalOrgId } scoping (#142): the operator companion to a window
 * override — a historical re-pull walks ONE org, not every reconciled org
 * against the shared 60-RPM cap. Uses a real HTTP stub (the poller.test.ts
 * pattern) because runAnalyticsPollReconciledOrgs constructs its own Enterprise
 * client from NUXT_ANTHROPIC_API_ENDPOINT + the per-org credential env var.
 */
describe('runAnalyticsPollReconciledOrgs — { onlyExternalOrgId } scoping (#142)', () => {
  const DAY = '2026-07-11'
  const ORG1 = 'org-scope1'
  const ORG2 = 'org-scope2'
  const SOURCE1 = `anthropic-analytics-api:${ORG1}`
  const SOURCE2 = `anthropic-analytics-api:${ORG2}`
  let stub: Server

  beforeAll(async () => {
    // Enterprise Analytics stub: every org/day serves one resolvable priya
    // usage row + one token-cost row (25 fractional cents = $0.25).
    stub = createServer((req, res) => {
      if (req.url?.startsWith('/v1/organizations/analytics/user_usage_report')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ has_more: false, next_page: null, data: [usageRow(PRIYA, 'claude_code', 1000, 500)] }))
        return
      }
      if (req.url?.startsWith('/v1/organizations/analytics/user_cost_report')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ has_more: false, next_page: null, data: [costRow(PRIYA, 'claude_code', '25')] }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
    process.env.NUXT_ANTHROPIC_API_ENDPOINT = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
    process.env.NUXT_ANTHROPIC_KEY_ANTHROPIC_SCOPE1 = 'k-scope1'
    process.env.NUXT_ANTHROPIC_KEY_ANTHROPIC_SCOPE2 = 'k-scope2'
    // TWO reconciled enterprise orgs, both fully pollable (key + endpoint) — so
    // "only org1 was polled" is attributable to the SCOPE, not a missing key.
    // (external_org_id is CHECK-constrained lowercase, mig 0064; api_kind mig 0063.)
    await t.client.unsafe(`
      INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, billing, api_kind, credential_secret_name) VALUES
        ('anthropic', '${ORG1}', 'Org Scope 1', 'reconciled', 'tracked', 'enterprise-analytics', 'anthropic-scope1'),
        ('anthropic', '${ORG2}', 'Org Scope 2', 'reconciled', 'tracked', 'enterprise-analytics', 'anthropic-scope2');
    `)
  })

  afterAll(async () => {
    delete process.env.NUXT_ANTHROPIC_API_ENDPOINT
    delete process.env.NUXT_ANTHROPIC_KEY_ANTHROPIC_SCOPE1
    delete process.env.NUXT_ANTHROPIC_KEY_ANTHROPIC_SCOPE2
    await new Promise<void>((resolve) => stub.close(() => resolve()))
    await t.client.unsafe(`DELETE FROM actual_spend WHERE source IN ('${SOURCE1}', '${SOURCE2}')`)
    await t.client.unsafe(`DELETE FROM provider_org WHERE external_org_id IN ('${ORG1}', '${ORG2}')`)
  })

  it('scoping to org1 polls ONLY org1 — org2 (equally pollable) gets no rows', async () => {
    const res = await runAnalyticsPollReconciledOrgs(
      t.db,
      { startingAt: DAY, endingAt: DAY },
      { onlyExternalOrgId: ORG1 },
    )
    expect(res.orgsConsidered).toBe(1) // the SQL filter, not a post-hoc skip
    expect(res.orgsPolled).toBe(1)
    expect(res.orgsSkippedNoCredential).toBe(0)
    expect(res.perOrg).toHaveLength(1)
    expect(res.perOrg[0]).toMatchObject({ externalOrgId: ORG1, polled: true })
    expect(res.perOrg[0]!.result?.recordsUpserted).toBe(1)

    // Only org1's source rows were written; org2 was never touched.
    const rows1 = await spendRows(SOURCE1)
    expect(rows1).toHaveLength(1)
    expect(rows1[0]).toMatchObject({ teammate_id: priyaId, date: DAY, tool: 'claude-code' })
    expect(rows1[0]!.cost_usd).toBeCloseTo(0.25, 6)
    expect(await spendRows(SOURCE2)).toHaveLength(0)
  })

  it('an UNKNOWN external id is a clean no-op: orgsConsidered 0, nothing polled, nothing written', async () => {
    const before1 = (await spendRows(SOURCE1)).length
    const res = await runAnalyticsPollReconciledOrgs(
      t.db,
      { startingAt: DAY, endingAt: DAY },
      { onlyExternalOrgId: 'org-does-not-exist' },
    )
    expect(res).toEqual({ orgsConsidered: 0, orgsPolled: 0, orgsSkippedNoCredential: 0, perOrg: [] })
    expect((await spendRows(SOURCE1)).length).toBe(before1) // no side effects
    expect(await spendRows(SOURCE2)).toHaveLength(0)
  })
})

describe('migration 0101 (A1) — §A view is RESTORED to include non-Code surfaces', () => {
  it('v_teammate_usage_daily returns EVERY surface lane for a teammate-day with mixed surfaces (mig 0084 reverted)', async () => {
    /*
     * Migration 0084 excluded the non-Code Claude surfaces from this view so
     * they could never become a taggable `unaccounted_usage` worklist item —
     * but that exclusion ALSO removed them from `v_complete_usage`'s
     * completeness rollups, since this view was the reconciliation worker's
     * only source (docs/design/usage-completeness-and-provider-governance.md
     * §1.1's arithmetic-impossibility finding). Migration 0101 (A1) reverts the
     * exclusion here and moves worklist safety to A2
     * (INGEST_ONLY_USAGE_TOOLS in server/usage/unaccounted-reconciliation.ts) —
     * so this view is restored to being the complete per-(teammate, day, tool)
     * USAGE truth its name and header claim, and the historical
     * migration-0084 pin (tests/unit/usage/surface.test.ts, parsing 0084's own
     * file text) is left untouched: 0084 genuinely excluded these tools WHEN IT
     * SHIPPED, and that pin is a fact about that migration's file, not about
     * today's live view.
     */
    const DAY = '2026-07-05'
    await seedSpend(priyaId, DAY, 'claude-code', 5.0, 'seed-view-a')
    await seedSpend(priyaId, DAY, 'claude-ai', 7.0, 'seed-view-a')
    await seedSpend(priyaId, DAY, 'claude-cowork', 2.0, 'seed-view-a')

    const rows = await t.client<{ tool: string; usage_usd: string }[]>`
      SELECT tool, usage_usd::text AS usage_usd FROM v_teammate_usage_daily
      WHERE teammate_id = ${priyaId}::uuid AND day = ${DAY}::date ORDER BY tool`
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => [r.tool, Number(r.usage_usd)])).toEqual([
      ['claude-ai', 7],
      ['claude-code', 5],
      ['claude-cowork', 2],
    ])
  })

  it('copilot-cli / copilot-agent remain excluded from the actual_spend branch (unchanged reason: their usage truth is reconciliation_record)', async () => {
    const DAY = '2026-07-12'
    await seedSpend(priyaId, DAY, 'claude-code', 5.0, 'seed-view-b')
    // Neither of these should ever reach v_teammate_usage_daily FROM actual_spend
    // (a future §B bill writer might land one there; the exclusion firewalls it).
    await seedSpend(priyaId, DAY, 'copilot-cli', 99.0, 'seed-view-b')
    await seedSpend(priyaId, DAY, 'copilot-agent', 88.0, 'seed-view-b')

    const rows = await t.client<{ tool: string }[]>`
      SELECT tool FROM v_teammate_usage_daily
      WHERE teammate_id = ${priyaId}::uuid AND day = ${DAY}::date ORDER BY tool`
    expect(rows.map((r) => r.tool)).toEqual(['claude-code'])
  })
})

describe('the group_by the poller ACTUALLY sends', () => {
  it('asks the cost report for cost_type, and does not ask the usage report for it', () => {
    /*
     * This is what makes the cost_type fix regression-proof at the CALLER.
     * enterprise-client.test.ts covers the wire shape but passes the arrays in
     * by hand, so removing cost_type from analytics-poller.ts would leave it
     * green -- a test that cannot fail for the thing it is named after.
     *
     * Two directions, both load-bearing:
     *  - cost_type ON the cost report is what makes the web_search /
     *    code_execution exclusion reachable at all (it is null until grouped,
     *    so the filter reading it had never once fired).
     *  - cost_type OFF the usage report matters because UsageRow has no such
     *    field: sending it fragments those rows by a dimension we cannot read
     *    back, multiplying them against the 100-page ceiling for nothing.
     */
    expect(costGroupBySeen.length).toBeGreaterThan(0)
    expect(usageGroupBySeen.length).toBeGreaterThan(0)
    for (const g of costGroupBySeen) expect(g).toContain('cost_type')
    for (const g of usageGroupBySeen) expect(g).not.toContain('cost_type')
    // Both still carry the dimensions the model work depends on.
    for (const g of [...costGroupBySeen, ...usageGroupBySeen]) {
      expect(g).toContain('product')
      expect(g).toContain('model')
      /*
       * W0a D3, and the canon clause it implements verbatim: "Add
       * `context_window` and `speed` to BOTH reports or neither — the usage
       * and cost reports are at different grains and a dimension on one side
       * only makes the join harder" (target-state-data-architecture.md).
       * Pinned at the CALLER for the same reason cost_type is above:
       * enterprise-client.test.ts passes its arrays in by hand, so dropping
       * the dimension from analytics-poller.ts would leave it green.
       * `speed` is deliberately NOT requested (no card needs it).
       */
      expect(g).toContain('context_window')
      expect(g).not.toContain('speed')
    }
  })
})

describe('org-grain tool rows and the stale-prune identity guard', () => {
  it('does not let web_search/code_execution rows dilute the skip ratio', async () => {
    /*
     * A regression introduced BY requesting cost_type, and the reason the
     * filter now runs before `total` is incremented.
     *
     * `total` is the denominator of the prune's identity guard
     * (skipped/total <= PRUNE_MAX_SKIP_RATIO = 0.5). The guard refuses a prune
     * when an outsized share of rows failed to bind a teammate, because that is
     * OUR failure and pruning then deletes rows the broken run merely failed to
     * re-assert.
     *
     * Org-grain tool rows never attempt identity resolution. Counting them makes
     * ONE unbindable token row beside TWO tool rows read as 1/3 = 0.33 -- under
     * the threshold, so the prune fires -- when it is really 1/1 = 1.0 and must
     * not. Before cost_type was requested these rows could not appear at all.
     *
     * THE FIXTURE MUST HAVE SOMETHING TO LOSE. An earlier version of this test
     * asserted staleRowsDeleted === 0 with no pre-existing rows, so it passed
     * whether the guard blocked the prune or the prune ran and found nothing --
     * green under the mutation it was named after. So: run once with a
     * RESOLVABLE actor to write real rows, then run again for the same day with
     * only unresolvable + org-grain rows. The first run's rows are now stale by
     * pulled_at. If the guard is diluted they are deleted; if it holds they
     * survive.
     */
    const good = PRIYA // seeded in beforeAll, so the resolver binds it
    const unknown = { type: 'user_actor', email: 'nobody-here@x.test' }

    const seedRun = fakeEnterpriseClient({
      '2026-07-09': {
        usage: [],
        cost: [costRow(good, 'claude_code', '2000.000000')],
      },
    })
    await runEnterpriseAnalyticsPoll(t.db, seedRun, { startingAt: '2026-07-09', endingAt: '2026-07-09' })

    const before = await t.client`
      SELECT id FROM actual_spend WHERE date = '2026-07-09'::date AND tool = 'claude-code'
    `
    // Guard the guard: if the seed wrote nothing, the assertion below is vacuous.
    expect(before.length).toBeGreaterThan(0)

    const brokenRun = fakeEnterpriseClient({
      '2026-07-09': {
        usage: [],
        cost: [
          { actor: unknown, amount: '1000.000000', currency: 'USD', cost_type: null, product: 'claude_code' },
          { actor: unknown, amount: '500.000000', currency: 'USD', cost_type: 'web_search', product: null },
          { actor: unknown, amount: '500.000000', currency: 'USD', cost_type: 'code_execution', product: null },
        ],
      },
    })
    const res = await runEnterpriseAnalyticsPoll(t.db, brokenRun, {
      startingAt: '2026-07-09',
      endingAt: '2026-07-09',
    })

    // Every identity-eligible row failed to bind, so the prune must be refused.
    expect(res.staleRowsDeleted).toBe(0)
    const after = await t.client`
      SELECT id FROM actual_spend WHERE date = '2026-07-09'::date AND tool = 'claude-code'
    `
    expect(after.length).toBe(before.length)
  })
})
