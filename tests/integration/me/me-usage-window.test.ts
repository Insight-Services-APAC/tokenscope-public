// @vitest-environment node
/*
 * W2 — the /me/usage window additions (developer-pages build:
 * D16/D17/D20/D21/D22/D23), against real Postgres via the REAL handler
 * (AGENTS.md §"Never mock Drizzle"). Covers the server halves of T13, T14,
 * T15, T17 and T24:
 *
 *  - T13: `?month=` and `?from&to` resolve via resolveReportWindow — the
 *    window echo, the figures and the 400s all come from the ONE entry point;
 *  - T14: hero tiles carry per-tile deltas (same-elapsed MoM, paced on the
 *    data frontier) and NAMED deltaEmpty reasons;
 *  - T15: the chargeback lane leads with Chargeable and keeps four tiles;
 *  - T17: Where-it-went rows foot to the window total incl. the untagged row,
 *    and the against-budget operands are the PROJECT's (total + allocation),
 *    never the caller's share;
 *  - T24: the cache/aux payload legs are GONE (D23) while insights and the
 *    kept mix legs survive.
 *
 * Fixture: July 2026 (a COMPLETE month — deterministic against the real
 * clock), June behind it for MoM. Every figure below is derived from the
 * seeds, so the assertions are arithmetic, not snapshots.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import usageHandler from '../../../server/api/v1/me/usage.get'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let devId = ''
let otherId = ''
let p1Id = ''
let p2Id = ''

function ev(query: string) {
  const path = `/api/v1/me/usage?${query}`
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path,
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url: path,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, cookie: '' }
        },
      },
      res: {
        _headers: {} as Record<string, unknown>,
        statusCode: 200,
        getHeader() {},
        setHeader() {},
        removeHeader() {},
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  const session = {
    teammateId: devId,
    email: 'muw@x.test',
    displayName: 'Muw',
    role: 'developer',
    regionId,
    orgPath: 'muw',
    issuedAt: new Date().toISOString(),
  } as unknown as Session
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof usageHandler>[0]
}

const instanceByTeammate = new Map<string, string>()

async function otel(
  tmId: string,
  over: { projectId?: string | null; model?: string; costUsd: string; tsEvent: string },
): Promise<void> {
  let instanceId = instanceByTeammate.get(tmId)
  if (!instanceId) {
    instanceId = randomUUID()
    await t.db.insert(schema.instanceAttestation).values({
      instanceId,
      principalOid: `oid-${tmId}`,
      teammateId: tmId,
      projectCodeHash: 'h-muw',
      rawProjectCode: 'MUW',
      tool: 'claude-code',
      tsStart: new Date('2026-05-01T00:00:00.000Z'),
      regionId,
      orgUnitId,
    })
    instanceByTeammate.set(tmId, instanceId)
  }
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    claudeSessionId: randomUUID(),
    teammateId: tmId,
    projectId: over.projectId ?? null,
    regionId,
    orgUnitId,
    tool: 'claude-code',
    model: over.model ?? 'claude-opus-5',
    tokenType: 'output',
    tokens: 1000n,
    costUsd: over.costUsd,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: new Date(over.tsEvent),
    sourceRunId: randomUUID(),
  })
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [r] = await t.db.insert(schema.region).values({ code: 'muw', displayName: 'MUW' }).returning()
  regionId = r!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'muw', code: 'muw-bu', displayName: 'MUW', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = bu!.id
  const mk = async (email: string) => {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: `oid-${email}`, email, regionId, orgUnitId })
      .returning()
    return tm!.id
  }
  devId = await mk('muw@x.test')
  otherId = await mk('muw-other@x.test')

  const mkProject = async (code: string) => {
    const [p] = await t.db
      .insert(schema.project)
      .values({
        code,
        codeHash: `h-${code}`,
        displayName: code,
        type: 'billable',
        regionId,
        costOwningUnitId: orgUnitId,
      })
      .returning()
    return p!.id
  }
  p1Id = await mkProject('MUW-BUDGETED')
  p2Id = await mkProject('MUW-NOBUDGET')
  // The caller is a CURRENT member of P1 only — the D21 link-vs-plain operand.
  await t.db.insert(schema.projectAssignment).values({
    projectId: p1Id,
    teammateId: devId,
    effective: sql`'[2026-01-01, 2099-01-01)'::tstzrange`,
  })
  // P1 carries a $100 project-wide allocation, current-effective.
  const [evt] = await t.db
    .insert(schema.auditEvent)
    .values({
      eventType: 'allocation-created',
      subjectKind: 'project',
      subjectId: p1Id,
      payload: { initial: true },
    })
    .returning({ id: schema.auditEvent.id })
  await t.db.insert(schema.allocation).values({
    scopeType: 'project',
    scopeId: p1Id,
    allocationKind: 'baseline',
    budgetUsd: '100.00',
    effective: sql`'[2026-01-01, 2099-01-01)'::tstzrange`,
    auditEventId: evt!.id,
  })

  // ── July (the viewed month) — dev: 18.00 over 3 active days ──────────────
  await otel(devId, { projectId: p1Id, costUsd: '10.00', tsEvent: '2026-07-10T10:00:00.000Z' })
  await otel(devId, {
    projectId: p2Id,
    model: 'claude-sonnet-5',
    costUsd: '5.00',
    tsEvent: '2026-07-12T10:00:00.000Z',
  })
  await otel(devId, { projectId: null, costUsd: '3.00', tsEvent: '2026-07-20T10:00:00.000Z' })
  // The OTHER member makes P1's PROJECT total exceed its allocation (T17:
  // caller share small, project over — 125 > 100).
  await otel(otherId, { projectId: p1Id, costUsd: '115.00', tsEvent: '2026-07-11T10:00:00.000Z' })

  // ── June (the MoM operand) — dev: 9.00 on day 5, on P1 ───────────────────
  await otel(devId, { projectId: p1Id, costUsd: '9.00', tsEvent: '2026-06-05T10:00:00.000Z' })

  // ── Provider facts: banded residency + web searches (July) ───────────────
  await t.client`
    INSERT INTO provider_usage_fact
      (source, provider, teammate_id, date, tool, model, cost_type, context_window, cost_usd)
    VALUES
      ('test', 'anthropic', ${devId}::uuid, '2026-07-10'::date, 'claude-code', 'claude-opus-5', 'tokens', '0-200k', 6.00),
      ('test', 'anthropic', ${devId}::uuid, '2026-07-11'::date, 'claude-code', 'claude-opus-5', 'tokens', '200k+', 2.00)`
  await t.client`
    INSERT INTO provider_usage_fact
      (source, provider, teammate_id, date, tool, model, input_tokens, output_tokens, web_search_requests)
    VALUES
      ('test', 'anthropic', ${devId}::uuid, '2026-07-10'::date, 'claude-code', 'claude-opus-5', 900, 100, 7)`
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload legs are asserted shape-by-shape below
type Payload = Record<string, any>

describe('/me/usage — window resolution (T13 server half)', () => {
  it('?month= resolves the calendar month and echoes it on hero_tiles.window', async () => {
    const p = (await usageHandler(ev('window=30&month=2026-07'))) as Payload
    expect(p.hero_tiles.window).toMatchObject({
      from: '2026-07-01',
      to: '2026-07-31',
      is_month: true,
      month: '2026-07',
      days_in_month: 31,
      days_elapsed: 31, // a COMPLETE month — full-month elapsed, not the clock's day
    })
  })

  /*
   * `spark_partial` — does the hero sparks' LAST point fall on a still-filling
   * day? The sparks are dense over `[from … min(to, today)]`, so the answer is a
   * SERVER fact and nothing else on this echo can stand in for it: a finished
   * month and the current month's last day both have `days_elapsed ===
   * days_in_month`, and the client would have to guess between them (external
   * review r2 — the frame-inference defect in MonthSpark).
   *
   * RED ON REVERT: drop the field (or hard-code it) and one of these two goes
   * red — they are the same endpoint answering opposite windows.
   */
  it('says whether the sparks end on a still-filling day', async () => {
    const past = (await usageHandler(ev('window=30&month=2026-07'))) as Payload
    expect(past.hero_tiles.window.spark_partial).toBe(false)
    // No month ⇒ the CURRENT month, which always reaches today.
    const current = (await usageHandler(ev('window=30'))) as Payload
    expect(current.hero_tiles.window.is_month).toBe(true)
    expect(current.hero_tiles.window.spark_partial).toBe(true)
  })

  it('?from&to resolves the custom range (is_month false, no month key)', async () => {
    const p = (await usageHandler(ev('window=30&from=2026-07-10&to=2026-07-12'))) as Payload
    expect(p.hero_tiles.window).toMatchObject({
      from: '2026-07-10',
      to: '2026-07-12',
      is_month: false,
      month: null,
      days_elapsed: null,
      days_in_month: null,
    })
  })

  it('a partial range and a malformed month are 400s, not silent defaults', async () => {
    await expect(usageHandler(ev('window=30&from=2026-07-10'))).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(usageHandler(ev('window=30&month=2026-13'))).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})

describe('/me/usage — hero tiles (T14 server half)', () => {
  /*
   * MUTATION: pace MoM on `now` instead of the data frontier, or window the
   * tile reads on trailing days — every figure below goes red.
   */
  it('four usage-lane tiles with same-elapsed MoM deltas on the data frontier', async () => {
    const p = (await usageHandler(ev('window=30&month=2026-07'))) as Payload
    const tiles = p.hero_tiles.tiles as Payload[]
    expect(tiles.map((x) => x.key)).toEqual(['attributed', 'budgeted', 'quota', 'active_days'])

    const [attributed, budgeted, quota, activeDays] = tiles as [Payload, Payload, Payload, Payload]
    // Window attributed = 10 + 5 + 3 (dev's July; the other teammate's never).
    expect(attributed.value_usd).toBe('18.00')
    // MoM: July 18.00 vs June-paced-to-day-20 9.00 → +100%.
    expect(attributed.delta_pct).toBeCloseTo(1, 4)
    expect(attributed.delta_empty_reason).toBeNull()

    // Budgeted = spend on projects with an allocation (P1 only).
    expect(budgeted.value_usd).toBe('10.00')
    expect(budgeted.no_budget_usd).toBe('5.00')
    expect(budgeted.untagged_usd).toBe('3.00')
    expect(budgeted.delta_pct).toBeCloseTo((10 - 9) / 9, 4)

    // Quota is a CURRENT-month measure; a viewed past month states its basis.
    expect(quota.quota_basis).toBe('not-current-month')

    expect(activeDays.count).toBe(3)
    expect(activeDays.days_so_far).toBe(31)
    // Count delta is ABSOLUTE: 3 active days vs June's 1.
    expect(activeDays.delta_abs).toBe(2)
    // The spark rides the same window (zero-filled to the day axis).
    expect(activeDays.spark).toHaveLength(31)
  })

  /*
   * MUTATION: fold the custom-range case into 'too early to compare' (or
   * compute a bogus range-MoM) — the named reason goes red.
   */
  it('a custom range withholds every delta with the NAMED reason', async () => {
    const p = (await usageHandler(ev('window=30&from=2026-07-10&to=2026-07-12'))) as Payload
    const tiles = p.hero_tiles.tiles as Payload[]
    expect((tiles[0] as Payload).value_usd).toBe('15.00') // days 10+12 only
    for (const tile of tiles) {
      if (tile.key === 'quota') {
        expect(tile.quota_basis).toBe('custom-range')
        continue
      }
      expect(tile.delta_pct ?? tile.delta_abs ?? null).toBeNull()
      expect(tile.delta_empty_reason).toBe('no month-on-month for a custom range')
    }
  })

  it('the chargeback lane leads with Chargeable and keeps four tiles (T15)', async () => {
    const p = (await usageHandler(ev('window=30&month=2026-07&lane=chargeback'))) as Payload
    const tiles = p.hero_tiles.tiles as Payload[]
    expect(tiles.map((x) => x.key)).toEqual(['chargeable', 'attributed', 'quota', 'active_days'])
    // No finance rows seeded → an honest zero, never the §A figure re-labelled.
    expect((tiles[0] as Payload).value_usd).toBe('0.00')
    expect((tiles[1] as Payload).value_usd).toBe('18.00')
  })
})

describe('/me/usage — Where it went (T17 server half)', () => {
  /*
   * MUTATION: send the caller's share as the against-budget operand (mine
   * instead of the project total) — the 125.00 goes red.
   * MUTATION: drop the untagged remainder — the footing identity goes red.
   */
  it('rows foot to the window total, and the budget operands are the PROJECT’s', async () => {
    const p = (await usageHandler(ev('window=30&month=2026-07'))) as Payload
    const w = p.where_it_went as Payload
    expect(w.total_usd).toBe('18.00')
    expect(w.untagged_usd).toBe('3.00')

    const rows = w.rows as Payload[]
    const mineSum = rows.reduce((a, r) => a + Number(r.mine_usd), 0)
    expect(mineSum + Number(w.untagged_usd)).toBeCloseTo(Number(w.total_usd), 6)

    const p1 = rows.find((r) => r.code === 'MUW-BUDGETED')!
    expect(p1.mine_usd).toBe('10.00')
    // The PROJECT total over ALL members — over its $100 allocation while the
    // caller's own share is small. The cell must be able to show OVER.
    expect(p1.project_total_usd).toBe('125.00')
    expect(p1.allocation_usd).toBe('100.00')
    expect(p1.is_member).toBe(true)

    const p2 = rows.find((r) => r.code === 'MUW-NOBUDGET')!
    expect(p2.mine_usd).toBe('5.00')
    expect(p2.allocation_usd).toBeNull() // a project that COULD hold a budget: "no budget set"
    expect(p2.is_member).toBe(false) // renders plain text — never a dead link (D29 rule)
  })

  /*
   * ── r3-M5 — the no-project remainder, by the state it is in ───────────────
   *
   * The remainder is a SUBTRACTION (window total − Σ tagged projects), so it
   * foots by construction — and it folded four different states into a figure
   * the page rendered as "Untagged → worklist". Only ONE of them is a queue.
   * Seeded per-test and torn down so the rest of this suite's arithmetic stays
   * on the shared fixture.
   */
  async function seedNoProjectStates() {
    await otel(devId, { projectId: null, costUsd: '7.00', tsEvent: '2026-07-21T10:00:00.000Z' })
    await t.db.execute(sql`
      UPDATE attribution_record SET activity = 'Research', claude_session_id = 'mu-activity'
       WHERE teammate_id = ${devId}::uuid
         AND ts_event = '2026-07-21T10:00:00.000Z'::timestamptz`)
    await otel(devId, { projectId: null, costUsd: '5.00', tsEvent: '2026-07-22T10:00:00.000Z' })
    await t.db.execute(sql`
      UPDATE attribution_record SET claude_session_id = 'mu-dismissed'
       WHERE teammate_id = ${devId}::uuid
         AND ts_event = '2026-07-22T10:00:00.000Z'::timestamptz`)
    // DISMISSED: the developer decided to leave it unallocated (mig 0094). The
    // money stays in the total; the WORK does not exist.
    await t.db.execute(sql`
      INSERT INTO session_assignment (claude_session_id, teammate_id, dismissed_at)
      VALUES ('mu-dismissed', ${devId}::uuid, now())`)
    // UNTAGGABLE: §A arm 3 — provider usage with no session and no
    // unaccounted_usage row, so there is nothing to attach a project to.
    await t.db.execute(sql`
      INSERT INTO actual_spend
        (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
      VALUES (${devId}::uuid, '2026-07-23'::date, 'claude-ai', 0, 0, 20, 'anthropic-analytics-api', false)`)
  }
  async function clearNoProjectStates() {
    await t.db.execute(sql`
      DELETE FROM attribution_record
       WHERE teammate_id = ${devId}::uuid AND claude_session_id IN ('mu-activity', 'mu-dismissed')`)
    await t.db.execute(sql`DELETE FROM session_assignment WHERE claude_session_id = 'mu-dismissed'`)
    await t.db.execute(sql`DELETE FROM actual_spend WHERE tool = 'claude-ai'`)
  }

  it('the no-project remainder is split by state — only one of them is a worklist', async () => {
    await seedNoProjectStates()
    try {
      const p = (await usageHandler(ev('window=30&month=2026-07'))) as Payload
      const w = p.where_it_went as Payload
      // $3 taggable-and-untagged + $7 activity-tagged + $5 dismissed + $20 arm-3.
      expect(w.untagged_usd).toBe('35.00')
      expect(w.no_project).toEqual({
        worklist_usd: '3.00',
        activity_tagged_usd: '7.00',
        dismissed_usd: '5.00',
        untaggable_usd: '20.00',
      })
      // The one figure the "→ worklist" pull-through may quote is $3 — not the
      // $35 the label used to promise.
      expect(Number(w.no_project.worklist_usd)).toBeLessThan(Number(w.untagged_usd))
    } finally {
      await clearNoProjectStates()
    }
  })

  it('the split still foots to the same remainder — reclassifying moves no dollar', async () => {
    await seedNoProjectStates()
    try {
      const p = (await usageHandler(ev('window=30&month=2026-07'))) as Payload
      const w = p.where_it_went as Payload
      const np = w.no_project as Record<string, string>
      const sum = Object.values(np).reduce((a, v) => a + Number(v), 0)
      expect(sum).toBeCloseTo(Number(w.untagged_usd), 6)
      const mineSum = (w.rows as Payload[]).reduce((a, r) => a + Number(r.mine_usd), 0)
      expect(mineSum + Number(w.untagged_usd)).toBeCloseTo(Number(w.total_usd), 6)
    } finally {
      await clearNoProjectStates()
    }
  })

  /*
   * ── r4-M2 — the four-way split stops at the window's EXCLUSIVE upper bound ──
   *
   * `getUnallocatedSummary` takes an EXCLUSIVE instant bound, and every arm but
   * one honoured it: the day-grained `unaccounted_usage` arm compared
   * `uu.day <= spendEndIso::date`. Month-to-date callers pass `now`, where that
   * reads correctly (today's own fill row survives); `/me/usage` passes the
   * RESOLVED window's end, which for July 2026 is `2026-08-01T00:00:00Z` — so a
   * fill row dated exactly on the bound was counted INTO July.
   *
   * The failure is not a rounding one: `untagged_usd` is a subtraction over the
   * same window (it never saw the August row), so the split it must foot to came
   * out LARGER than the remainder itself.
   *
   * MUTATION: restore `AND uu.day <= ${spendEndIso}::date` in
   * server/utils/me-queries.ts and both assertions below go red.
   */
  it('a fill row dated ON the exclusive upper bound is outside the window', async () => {
    await seedNoProjectStates()
    // Exactly the exclusive bound of ?month=2026-07 — the first day OUT.
    await t.db.execute(sql`
      INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
      VALUES (${devId}::uuid, ${regionId}::uuid, ${orgUnitId}::uuid,
              '2026-08-01'::date, 'claude-code', 41, 4100, 'api-reconciled')`)
    try {
      const p = (await usageHandler(ev('window=30&month=2026-07'))) as Payload
      const w = p.where_it_went as Payload
      // Unmoved by a row a day outside the window — $3 of genuinely-untagged
      // July spend, not $44.
      expect(w.no_project.worklist_usd).toBe('3.00')
      // …and the split still foots to the remainder it decomposes.
      const sum = Object.values(w.no_project as Record<string, string>).reduce(
        (a, v) => a + Number(v),
        0,
      )
      expect(sum).toBeCloseTo(Number(w.untagged_usd), 6)
    } finally {
      await t.db.execute(sql`DELETE FROM unaccounted_usage WHERE teammate_id = ${devId}::uuid`)
      await clearNoProjectStates()
    }
  })

  it('the last day INSIDE the window is still counted — the bound moved, not the arm', async () => {
    // The guard on the fix: an exclusive bound that swallowed the window's own
    // final day would pass the assertion above for the wrong reason.
    await seedNoProjectStates()
    await t.db.execute(sql`
      INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
      VALUES (${devId}::uuid, ${regionId}::uuid, ${orgUnitId}::uuid,
              '2026-07-31'::date, 'claude-code', 41, 4100, 'api-reconciled')`)
    try {
      const p = (await usageHandler(ev('window=30&month=2026-07'))) as Payload
      const w = p.where_it_went as Payload
      expect(w.no_project.worklist_usd).toBe('44.00')
    } finally {
      await t.db.execute(sql`DELETE FROM unaccounted_usage WHERE teammate_id = ${devId}::uuid`)
      await clearNoProjectStates()
    }
  })

  it('a custom range carries NO allocation operand — budgets are monthly', async () => {
    const p = (await usageHandler(ev('window=30&from=2026-07-10&to=2026-07-12'))) as Payload
    for (const r of (p.where_it_went as Payload).rows as Payload[]) {
      expect('allocation_usd' in r).toBe(false)
    }
  })
})

/*
 * ── r3-M6 — the settlement chips describe the window the FIGURES are in ─────
 *
 * `providerStates` was computed for `now`'s month regardless of `?month=` /
 * `?from&to`, so a June request returned June figures under August chips. A
 * chip is read as a fact ABOUT the number beside it; describing a different
 * period is worse than describing none.
 */
describe('/me/usage — the chip operands follow the RESOLVED window (r3-M6)', () => {
  it('a historical month carries that month’s settling clock, not the current month’s', async () => {
    const p = (await usageHandler(ev('window=30&month=2026-07'))) as Payload
    const states = p.providerStates as { vendor: string; state: string; settlesAt?: string }[]
    // July 2026 closed on 2026-08-01; the horizons are measured from there —
    // anthropic +30 d, github +7 d (settling.ts). Fixed strings, independent of
    // the clock this test runs at.
    expect(states.find((v) => v.vendor === 'anthropic')!.settlesAt).toBe('2026-08-31T00:00:00.000Z')
    expect(states.find((v) => v.vendor === 'github')!.settlesAt).toBe('2026-08-08T00:00:00.000Z')
    // …and NOTHING reads `estimated`, which is what a still-open month says and
    // what every one of these said before the window was passed through.
    for (const v of states) expect(v.state).not.toBe('estimated')
  })

  it('a custom range takes the LEAST settled month it spans, still from the window', async () => {
    const p = (await usageHandler(ev('window=30&from=2026-07-10&to=2026-07-12'))) as Payload
    const states = p.providerStates as { vendor: string; state: string; settlesAt?: string }[]
    expect(states.find((v) => v.vendor === 'anthropic')!.settlesAt).toBe('2026-08-31T00:00:00.000Z')
    for (const v of states) expect(v.state).not.toBe('estimated')
  })
})

describe('/me/usage — the new card legs + the D23 retirement (T24 server half)', () => {
  it('carries residency / economics / model mix / engagement, window-scoped', async () => {
    const p = (await usageHandler(ev('window=30&month=2026-07'))) as Payload

    // D5: banded residency + honest total (6 + 2, cost rows only).
    expect((p.context_residency as Payload).segments).toEqual([
      { band: '0-200k', costUsd: 6 },
      { band: '200k+', costUsd: 2 },
    ])
    // D10: three July conversations, arm disclosed.
    expect((p.session_economics as Payload).sessions).toBe(3)
    expect((p.session_economics as Payload).arm).toBe('otel')
    // D20: reason-typed rows + the mix's OWN Σ.
    const mm = p.model_mix as Payload
    expect((mm.rows as Payload[]).map((r) => [r.key, r.cost_usd])).toEqual([
      ['claude-opus-5', '13.00'],
      ['claude-sonnet-5', '5.00'],
    ])
    expect(mm.total_usd).toBe('18.00')
    // D22: Claude's own vocabulary; Copilot honestly absent (no wire rows).
    const eng = p.engagement as Payload
    expect(eng.claude).toMatchObject({ sessions: 3, active_days: 3, web_searches: 7 })
    expect(eng.copilot).toBeNull()
    // And the Claude column NEVER carries a LOC figure (T9's endpoint half).
    expect(JSON.stringify(eng.claude)).not.toMatch(/loc/i)
  })

  /*
   * MUTATION (D23): put `cache`/`aux` back on the payload — this goes red.
   * [[feedback-retire-dead-surfaces]]: the legs leave WITH their cards.
   */
  it('the cache and aux legs are GONE; the kept legs survive', async () => {
    const p = (await usageHandler(ev('window=30&month=2026-07'))) as Payload
    expect('cache' in p).toBe(false)
    expect('aux' in p).toBe(false)
    // NOT retired: detectors' insights leg, the mix legs, the chip operands.
    expect(Array.isArray(p.insights)).toBe(true)
    expect(p.mix.by_model).toBeDefined()
    expect(p.providerStates).toBeDefined()
    expect(p.headline).toBeDefined()
  })
})
