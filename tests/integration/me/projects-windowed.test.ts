// @vitest-environment node
/*
 * Developer-pages W3 — the SERVER halves of T20-T23, against real Postgres via
 * the REAL handlers (AGENTS.md §"Never mock Drizzle"):
 *
 *  T20 — /me/projects/summary carries the list-band operands: per-card
 *        `mine_mtd_usd` on the SAME lane/window/option as the card total, the
 *        caller's `untagged_usd` pull-through, and the same-window spark.
 *  T21 — /me/projects/{code} windows on the REPORT vocabulary (`?month` XOR
 *        `?from&to`): the headline follows the window, the payload carries the
 *        pace operands (days_elapsed/days_in_window) and per-tile MoM deltas
 *        paced on the data frontier; a custom range withholds them with the
 *        NAMED reason.
 *  T22 — changing `?month=` changes both the hero headline AND the model rows
 *        (r1-H9: revert the windowed mix read and the two months' mixes come
 *        back equal → red); the retired token-lane/cache legs are ABSENT.
 *  T23 — the team CSV export is membership-gated (non-member 404, the same
 *        not-found shape as the page) and windows like the page.
 *
 * Fixture months are FIXED (May/June/July 2026) so every delta assertion is
 * arithmetic on seeded rows, not on the wall clock; only the summary block
 * uses the current month (the list is MTD by owner decision).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import { resolveServerClock } from '../../../shared/reports/clock'
import type { Session } from '../../../server/utils/auth'
import projectHandler from '../../../server/api/v1/me/projects/[code]/index.get'
import teamExportHandler from '../../../server/api/v1/me/projects/[code]/team/export.get'
import summaryHandler from '../../../server/api/v1/me/projects/summary.get'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let devId = ''
let mateId = ''
let outsiderId = ''
let projectId = ''

const PROJECT_CODE = 'WIN-1'
const INSTANCE = randomUUID()
/** Now-anchored instant for the CURRENT-month (summary) rows. */
const ANCHOR = new Date(Date.now() - 60_000)

function ev(
  teammateId: string,
  url: string,
  routerParams: Record<string, string> = {},
  /**
   * Pre-seed the F1 request clock (`server/utils/request-clock.ts`). The whole
   * request — window resolution, the trailing burn bounds and the shipped
   * `ServerClock` alike — reads this instant instead of the wall clock. It is
   * the same seam the dev-only `?clock=` pin uses to let the parity capture
   * shoot a real day 1.
   */
  clockAt?: string,
) {
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: {
      params: routerParams,
      ...(clockAt ? { serverClock: resolveServerClock(new Date(clockAt)) } : {}),
    },
    node: {
      req: {
        method: 'GET',
        url,
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
    teammateId,
    email: 'win@x.test',
    displayName: 'Win',
    role: 'developer',
    regionId,
    orgPath: 'win',
    issuedAt: new Date().toISOString(),
  } as unknown as Session
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof projectHandler>[0]
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [r] = await t.db.insert(schema.region).values({ code: 'win', displayName: 'Win' }).returning()
  regionId = r!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'win', code: 'win', displayName: 'Win', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = bu!.id
  const mkTeammate = async (oid: string, email: string) => {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: oid, email, regionId, orgUnitId })
      .returning()
    return tm!.id
  }
  devId = await mkTeammate('oid-win-dev', 'win.dev@x.test')
  mateId = await mkTeammate('oid-win-mate', 'win.mate@x.test')
  outsiderId = await mkTeammate('oid-win-out', 'win.out@x.test')

  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: PROJECT_CODE,
      codeHash: 'h-win-1',
      displayName: 'Win One',
      type: 'billable',
      regionId,
      costOwningUnitId: orgUnitId,
    })
    .returning()
  projectId = proj!.id
  for (const teammateId of [devId, mateId]) {
    await t.db.insert(schema.projectAssignment).values({
      projectId,
      teammateId,
      effective: sql`'[2026-01-01, 2099-01-01)'::tstzrange`,
    })
  }

  await t.db.insert(schema.instanceAttestation).values({
    instanceId: INSTANCE,
    principalOid: 'oid-win-dev',
    teammateId: devId,
    projectCodeHash: 'h-win-1',
    rawProjectCode: PROJECT_CODE,
    tool: 'claude-code',
    sessionTokenHash: `tok-win-${INSTANCE}`,
    tsStart: new Date('2026-05-01T00:00:00Z'),
    regionId,
    orgUnitId,
    costOwningUnitId: orgUnitId,
  })

  const otel = (
    teammateId: string,
    tsEvent: Date,
    model: string,
    costUsd: string,
    tokens: number,
    projId: string | null = projectId,
  ) =>
    t.db.insert(schema.attributionRecord).values({
      instanceId: INSTANCE,
      claudeSessionId: `conv-win-${randomUUID().slice(0, 8)}`,
      teammateId,
      projectId: projId,
      regionId,
      orgUnitId,
      costOwningUnitId: projId ? orgUnitId : null,
      tool: 'claude-code',
      model,
      tokenType: 'output',
      tokens: BigInt(tokens),
      costUsd,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent,
      sourceRunId: randomUUID(),
    })

  // Fixed months: May $8 (fable) → June $12 (fable, day 20) → July $10 (haiku).
  await otel(devId, new Date('2026-05-10T10:00:00Z'), 'claude-fable-5', '8.000000', 800)
  await otel(devId, new Date('2026-06-20T10:00:00Z'), 'claude-fable-5', '12.000000', 1200)
  await otel(devId, new Date('2026-07-05T10:00:00Z'), 'claude-haiku-4-5', '10.000000', 1000)

  /*
   * ── THE PROVISIONAL SHADOW (r4-H2) ────────────────────────────────────────
   * An unauthenticated enrol mints an ACTIVE teammate whose email is a CLAIM
   * (mig 0057) and stamps its emissions `identity_state='provisional'`. It burns
   * $20 in JUNE, on a model NOTHING else in the fixture uses and on the same day
   * as the confirmed $12 — so if the mix or the daily stack ever counts it, it
   * shows up as an extra row rather than as a number that could be a rounding
   * artefact.
   *
   * The June headline already dropped it (`excludeProvisional`), so the whole
   * point is the OTHER side of the identity: the mix the panel divides by, and
   * the series stacked underneath, must drop it too or the card carries two
   * totals.
   */
  const shadowInstance = randomUUID()
  const [shadowTm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'provisional:win-shadow',
      email: 'win.shadow@x.test',
      regionId,
      orgUnitId,
      provisional: true,
    })
    .returning()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: shadowInstance,
    principalOid: 'p-win-shadow',
    teammateId: shadowTm!.id,
    projectCodeHash: 'h-win-1',
    rawProjectCode: PROJECT_CODE,
    tool: 'claude-code',
    sessionTokenHash: `tok-win-${shadowInstance}`,
    tsStart: new Date('2026-05-01T00:00:00Z'),
    regionId,
    orgUnitId,
    costOwningUnitId: orgUnitId,
    identityState: 'provisional',
  })
  await t.db.insert(schema.attributionRecord).values({
    instanceId: shadowInstance,
    claudeSessionId: 'conv-win-shadow',
    teammateId: shadowTm!.id,
    projectId,
    regionId,
    orgUnitId,
    costOwningUnitId: orgUnitId,
    tool: 'claude-code',
    model: 'claude-shadow-9',
    tokenType: 'output',
    tokens: 2000n,
    costUsd: '20.000000',
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: new Date('2026-06-20T11:00:00Z'),
    sourceRunId: randomUUID(),
    identityState: 'provisional',
  })
  // Current month (the summary's MTD window): dev $5 + mate $3 tagged, dev $2 untagged.
  await otel(devId, ANCHOR, 'claude-fable-5', '5.000000', 500)
  await otel(mateId, ANCHOR, 'claude-fable-5', '3.000000', 300)
  await otel(devId, ANCHOR, 'claude-fable-5', '2.000000', 200, null)
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

/** The payload legs these assertions read — loose on purpose (absence pins). */
interface ProjectPayload {
  budget: { window_cost_usd: string }
  window: {
    is_month: boolean
    month: string | null
    from: string
    to: string
    days_elapsed: number
    days_in_window: number
  }
  hero: {
    active_members: number
    assigned_members: number
    deltas: {
      empty_reason: string | null
      spend_pct: number | null
      burn_pct: number | null
      active_members_abs: number | null
      untagged_pct: number | null
    }
  }
  team: { members: Array<{ cost_usd: string }> }
  untagged_pressure: { conversations: number; cost_usd: string }
  providerStates: Array<{ vendor: string }>
  mix: { by_model: unknown; by_token_type?: unknown }
  series_by_model: unknown
  burn: {
    window_days: number
    from: string
    /** The last SETTLED day on the axis — `to` is the still-filling day beyond it. */
    settled_to: string
    to: string
    series_by_model: Array<{ day: string; model: string; cost_usd: string }>
    /** `null` = the aggregate holds no row for this window. NULL IS NOT 0. */
    advisory_cost_usd: string | null
    advisory_uncovered_days: number
    advisory_basis: string
  }
  cache?: unknown
  fidelity?: unknown
  window_days?: unknown
  series?: unknown
}

const getProject = (url: string, teammateId = devId, clockAt?: string) =>
  projectHandler(
    ev(teammateId, url, { code: PROJECT_CODE }, clockAt),
  ) as unknown as Promise<ProjectPayload>

/*
 * The pinned instant for the burn-window assertions. Chosen so the fixture's two
 * fixed-month rows fall on OPPOSITE sides of the trailing 30-day edge:
 *   settledThrough = 2026-06-24  →  trailing 30d = 2026-05-26 … 2026-06-25
 *   May 10 ($8)  OUTSIDE   ·   June 20 ($12)  INSIDE
 * so "does this card follow the page window or its own?" is answerable by which
 * rows come back, not by a count that could be a coincidence.
 */
const BURN_CLOCK = '2026-06-25T09:00:00Z'

describe('/me/projects/{code} — the window vocabulary (T21)', () => {
  it('?month= drives the headline, the window operands and the MoM deltas', async () => {
    const p = await getProject('/x?month=2026-06')
    expect(p.budget.window_cost_usd).toBe('12.00')
    expect(p.window).toMatchObject({
      is_month: true,
      month: '2026-06',
      from: '2026-06-01',
      to: '2026-06-30',
      days_elapsed: 30,
      days_in_window: 30,
    })
    // Deltas pace on the DATA FRONTIER (June 20): the prev side is May 1-20,
    // which holds the $8 May row → spend +50%; burn 12/20 vs 8/20 → +50%.
    expect(p.hero.deltas.empty_reason).toBeNull()
    expect(p.hero.deltas.spend_pct).toBeCloseTo(0.5, 4)
    expect(p.hero.deltas.burn_pct).toBeCloseTo(0.5, 4)
    expect(p.hero.deltas.active_members_abs).toBe(0)
    // No untagged rows either month → no operand, never a fake 0%.
    expect(p.hero.deltas.untagged_pct).toBeNull()
    // The team table foots to the same window.
    expect(p.team.members).toHaveLength(1)
    expect(p.team.members[0].cost_usd).toBe('12.00')
  })

  it('a custom range windows the figures and withholds deltas with the NAMED reason', async () => {
    const p = await getProject('/x?from=2026-06-01&to=2026-06-30')
    expect(p.budget.window_cost_usd).toBe('12.00')
    expect(p.window.is_month).toBe(false)
    expect(p.hero.deltas.empty_reason).toBe('no month-on-month for a custom range')
    expect(p.hero.deltas.spend_pct).toBeNull()
  })

  it('no params → the current month (the pre-window default, unchanged)', async () => {
    const p = await getProject('/x')
    // Current month: dev $5 + mate $3 tagged; the $2 untagged row stays out of
    // the headline and shows as pressure instead.
    expect(p.budget.window_cost_usd).toBe('8.00')
    expect(p.hero.active_members).toBe(2)
    expect(p.hero.assigned_members).toBe(2)
    expect(p.untagged_pressure.conversations).toBe(1)
    expect(p.untagged_pressure.cost_usd).toBe('2.00')
    // Chip-row operands ride along (D11/D14).
    expect(p.providerStates.map((s: { vendor: string }) => s.vendor).sort()).toEqual([
      'anthropic',
      'github',
      'usage',
    ])
  })
})

describe('/me/projects/{code} — the windowed model rows (T22, r1-H9)', () => {
  it('changing ?month= changes both the hero headline AND the model rows', async () => {
    const june = await getProject('/x?month=2026-06')
    const july = await getProject('/x?month=2026-07')
    expect(june.budget.window_cost_usd).toBe('12.00')
    expect(july.budget.window_cost_usd).toBe('10.00')
    expect(june.mix.by_model).toEqual([
      { key: 'claude-fable-5', label: 'claude-fable-5', cost_usd: '12.00', tokens: 1200, gap_reason: null },
    ])
    expect(july.mix.by_model).toEqual([
      { key: 'claude-haiku-4-5', label: 'claude-haiku-4-5', cost_usd: '10.00', tokens: 1000, gap_reason: null },
    ])
    // The series follows the same window: June rows only in June.
    expect(june.series_by_model).toEqual([
      { day: '2026-06-20', model: 'claude-fable-5', cost_usd: '12.00' },
    ])
  })

  /*
   * ── r4-H2 — the member depth's mix/series count the HEADLINE's money ───────
   *
   * MUTATION: drop `PROJECT_SPEND_OPTS` from either `completeProjectModelMix`
   * or `completeProjectModelSeries` in `/me/projects/{code}` and this goes red —
   * the shadow's $20 reappears as a `claude-shadow-9` row under a $12 headline.
   *
   * This is the SAME defect the reports depth closed one level up
   * (project-reports-depth.test.ts, "the model mix divides by the SAME money the
   * headline states"); the member depth kept it, so a PM and a cost-centre owner
   * looking at the same project saw the mix foot to two different totals.
   */
  it('the mix AND the daily stack foot to the headline — provisional spend is on neither', async () => {
    const june = await getProject('/x?month=2026-06')
    const headline = Number(june.budget.window_cost_usd)
    expect(headline).toBeCloseTo(12, 6)

    const mix = june.mix.by_model as Array<{ label: string; cost_usd: string }>
    expect(mix.reduce((a, m) => a + Number(m.cost_usd), 0)).toBeCloseTo(headline, 6)
    expect(mix.map((m) => m.label)).not.toContain('claude-shadow-9')

    const series = june.series_by_model as Array<{ model: string; cost_usd: string }>
    expect(series.reduce((a, d) => a + Number(d.cost_usd), 0)).toBeCloseTo(headline, 6)
    expect(series.map((d) => d.model)).not.toContain('claude-shadow-9')

    // The excluded dollar IS on the lane — the agreement is a rule, not an empty
    // fixture. `lane_coverage` is where the headline discloses what it dropped.
    const coverage = (june as unknown as { lane_coverage: { provisional_withheld_usd: string } })
      .lane_coverage
    expect(Number(coverage.provisional_withheld_usd)).toBeCloseTo(20, 6)
  })

  it('the retired token-lane/cache legs are ABSENT (D41 — pinned, not just unrendered)', async () => {
    const p = await getProject('/x?month=2026-06')
    expect(p.mix.by_token_type).toBeUndefined()
    expect(p.cache).toBeUndefined()
    expect(p.fidelity).toBeUndefined()
    expect(p.window_days).toBeUndefined()
    expect(p.series).toBeUndefined()
  })
})

/*
 * T27 + T28, server halves — the two capability losses from #237, restored.
 *
 * T28: the burn block is a TRAILING 30/90 window on `?window=`, resolved from
 *      the request clock, and it does NOT follow the page window.
 * T27: advisory (telemetry-only) spend is reported over THAT window, so the
 *      chart footer and the chart it sits under describe the same days.
 */
describe('/me/projects/{code} — the burn card owns its own window (T28)', () => {
  it('trails 30 days from the SETTLED edge, independent of the page window', async () => {
    // Page window = MAY. Its headline is May's $8…
    const p = await getProject('/x?month=2026-05', devId, BURN_CLOCK)
    expect(p.budget.window_cost_usd).toBe('8.00')
    expect(p.window.month).toBe('2026-05')

    // …and the burn block is the trailing 30 days, which is a different period.
    expect(p.burn.window_days).toBe(30)
    expect(p.burn.from).toBe('2026-05-26')
    expect(p.burn.to).toBe('2026-06-25')
    /*
     * `from`…`to` spans 31 DATES for a "30d" card, and that is the contract, not
     * an off-by-one: 30 SETTLED days (26 May … 24 Jun) plus the still-filling
     * `today` beyond the settled edge — exactly the dates `dayAxis` draws, with
     * the last one faded and excluded from trend lines and means. Trim the
     * window to 30 dates and the chart's leftmost bar falls outside the data
     * window and gets padded with a fabricated zero, which is the defect
     * `shared/reports/day-axis.ts` exists to prevent.
     *
     * So the settled edge is SHIPPED rather than left to be inferred from a
     * range whose length disagrees with its own label. Drop `settled_to` and the
     * client is back to inferring "which of these 31 dates are settled?" from
     * `window_days`. Goes red on removal.
     */
    expect(p.burn.settled_to).toBe('2026-06-24')
    const settledSpan =
      (Date.parse(`${p.burn.settled_to}T00:00:00Z`) - Date.parse(`${p.burn.from}T00:00:00Z`)) /
        86_400_000 +
      1
    expect(settledSpan).toBe(p.burn.window_days)
    /*
     * The proof, in rows rather than in a count: the trailing window carries the
     * JUNE row and not the May one — the exact inverse of the page window it
     * sits beside. Fold this chart back onto the page window (what #237 did) and
     * the June row disappears and the May row returns, so this goes red.
     */
    const days = p.burn.series_by_model.map((r) => r.day)
    expect(days).toContain('2026-06-20')
    expect(days).not.toContain('2026-05-10')
    // Provisional spend is excluded here exactly as it is in the headline — the
    // shadow $20 lands on the same June day and must not appear.
    expect(p.burn.series_by_model.map((r) => r.model)).not.toContain('claude-shadow-9')
  })

  it('90 widens ONLY the burn block; every other figure stays on the page window', async () => {
    const p = await getProject('/x?month=2026-05&window=90', devId, BURN_CLOCK)
    expect(p.burn.window_days).toBe(90)
    expect(p.burn.from).toBe('2026-03-27')
    // 90 days reaches back far enough to hold BOTH fixed-month rows…
    const days = p.burn.series_by_model.map((r) => r.day).sort()
    expect(days).toContain('2026-05-10')
    expect(days).toContain('2026-06-20')
    // …while the page window is untouched: the headline is still May's $8.
    expect(p.budget.window_cost_usd).toBe('8.00')
    expect(p.window).toMatchObject({ month: '2026-05', from: '2026-05-01', to: '2026-05-31' })
  })

  it('defaults to 30 and refuses a window it does not serve', async () => {
    expect((await getProject('/x', devId, BURN_CLOCK)).burn.window_days).toBe(30)
    // `WindowQuery` is the ONE definition of "30 or 90" (shared/schemas/usage.ts).
    await expect(getProject('/x?window=45', devId, BURN_CLOCK)).rejects.toThrow()
  })
})

describe('/me/projects/{code} — advisory spend, over the burn window (T27)', () => {
  /*
   * ORDER IS LOAD-BEARING: this case runs BEFORE the cells below are inserted,
   * so the aggregate genuinely holds nothing for this project. Nothing in this
   * file runs the rollup — which is the live state the assertion is about.
   */
  it('ships NULL, not "0.00", when the aggregate holds nothing for the window', async () => {
    /*
     * The aggregate is the ONE cron-fed lane on this page. An un-materialised
     * rollup is not a measurement of zero advisory spend, and a wire that says
     * "0.00" for both cannot be told apart by any client. NULL IS NOT 0.
     * Restore the `COALESCE(SUM(...), 0)` in `fetchAdvisorySpend` and this goes
     * red with '0.00'.
     */
    const p = await getProject('/x?month=2026-05', devId, BURN_CLOCK)
    expect(p.burn.advisory_cost_usd).toBeNull()
    // The series above it is NOT empty — so "null" is about the advisory lane's
    // silence, not about a project with nothing in the window.
    expect(p.burn.series_by_model.length).toBeGreaterThan(0)
  })

  /*
   * The advisory figure and the chart it annotates are DIFFERENT POPULATIONS and
   * the payload has to say so. `attribution_aggregate` has no identity
   * dimension at all (drizzle/schema/attribution.ts) and `aggregate-rollup.ts`
   * applies no identity filter, so it spans PROVISIONAL identities — which the
   * series beside it drops via `excludeProvisional`. It is also OTel-only (no
   * arm 2/3) and skips none of `v_complete_usage` arm 1's exclusions. No filter
   * argument can close that: the dimension is not in the table. Naming the basis
   * is the honest fix; drop `advisory_basis` and the footer is back to implying
   * it describes the picture above it.
   */
  it('names the population it sums over — which is NOT the chart’s', async () => {
    const p = await getProject('/x?month=2026-05', devId, BURN_CLOCK)
    expect(p.burn.advisory_basis).toBe('otel-aggregate-all-identities')
  })

  it('reports the advisory total for the trailing window, not the page window', async () => {
    /*
     * Two aggregate cells, on opposite sides of the trailing edge. Only the one
     * INSIDE it may be disclosed: the footer's sentence names the chart's
     * window, so counting a day the chart does not draw would be a figure with
     * no period.
     */
    const cell = (periodStart: string, advisory: string) =>
      t.db.insert(schema.attributionAggregate).values({
        scopeType: 'project',
        scopeId: projectId,
        periodStart: new Date(periodStart),
        periodEnd: new Date(Date.parse(periodStart) + 86_400_000),
        periodKind: 'day',
        model: 'claude-fable-5',
        tokenType: 'output',
        totalTokens: 100n,
        totalCostUsd: '9.000000',
        advisoryCostUsd: advisory,
        recordCount: 1,
      })
    await cell('2026-06-20T00:00:00Z', '3.500000') // inside the trailing 30d
    await cell('2026-05-10T00:00:00Z', '99.000000') // outside it (inside May, though)

    const p = await getProject('/x?month=2026-05', devId, BURN_CLOCK)
    expect(p.burn.advisory_cost_usd).toBe('3.50')

    // 90 days reaches the May cell too — the figure moves WITH its own window.
    const wide = await getProject('/x?month=2026-05&window=90', devId, BURN_CLOCK)
    expect(wide.burn.advisory_cost_usd).toBe('102.50')
  })

  /*
   * A PARTIALLY MATERIALISED ROLLUP IS NOT A WINDOW TOTAL (external review r2).
   *
   * The null-vs-zero fix above only detected TOTAL absence, so a window the
   * rollup had covered for some of its days came back as a confident trailing-30d
   * figure with nothing to say it was short — the same unknown, one step in. The
   * payload now counts the days that provably were NOT covered: days the LEDGER
   * says carried project spend and the aggregate holds no row for. (Days with no
   * ledger spend are not counted — absence there is genuinely ambiguous, and
   * guessing would be the completeness estimate this must not invent.)
   *
   * ORDER IS LOAD-BEARING: the case above left an aggregate cell on 2026-06-20,
   * which is the one ledger day inside the trailing window.
   *
   * RED ON REVERT: drop `advisory_uncovered_days` (or compute it from the
   * aggregate's own days alone, with no ledger cross-check) and the second half
   * goes red — a window missing its only spending day reads as complete.
   */
  it('counts the window’s spending days the rollup has NOT covered', async () => {
    const cell = (periodStart: string, advisory: string) =>
      t.db.insert(schema.attributionAggregate).values({
        scopeType: 'project',
        scopeId: projectId,
        periodStart: new Date(periodStart),
        periodEnd: new Date(Date.parse(periodStart) + 86_400_000),
        periodKind: 'day',
        model: 'claude-haiku-4-5',
        tokenType: 'output',
        totalTokens: 100n,
        totalCostUsd: '9.000000',
        advisoryCostUsd: advisory,
        recordCount: 1,
      })

    // Covered: the rollup holds 2026-06-20, the only ledger day in the window.
    const covered = await getProject('/x?month=2026-05', devId, BURN_CLOCK)
    expect(covered.burn.series_by_model.map((r) => r.day)).toEqual(['2026-06-20'])
    expect(covered.burn.advisory_uncovered_days).toBe(0)

    // Now lose that day from the rollup while another day in the window keeps
    // the SUM non-null — the exact state the old code reported as a window total.
    await t.client`DELETE FROM attribution_aggregate
                   WHERE scope_id = ${projectId}::uuid
                     AND period_start = '2026-06-20T00:00:00Z'::timestamptz`
    await cell('2026-06-01T00:00:00Z', '1.000000')

    const partial = await getProject('/x?month=2026-05', devId, BURN_CLOCK)
    expect(partial.burn.advisory_cost_usd).toBe('1.00') // still a confident-looking number…
    expect(partial.burn.advisory_uncovered_days).toBe(1) // …and it does NOT cover the window
  })
})

describe('/me/projects/{code}/team/export — membership-gated CSV (T23)', () => {
  it('a member gets the windowed named-row CSV with shares', async () => {
    const csv = (await teamExportHandler(
      ev(devId, '/x?month=2026-06', { code: PROJECT_CODE }) as unknown as Parameters<
        typeof teamExportHandler
      >[0],
    )) as string
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe(
      'member,email,cost_usd,tokens,active_days,cost_per_active_day,share_pct,last_activity',
    )
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('win.dev@x.test')
    expect(lines[1]).toContain('12.00')
    expect(lines[1]).toContain('100.0') // sole contributor that month
  })

  it('a non-member export attempt 404s with the not-found shape (no probing oracle)', async () => {
    await expect(
      teamExportHandler(
        ev(outsiderId, '/x?month=2026-06', { code: PROJECT_CODE }) as unknown as Parameters<
          typeof teamExportHandler
        >[0],
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

interface SummaryPayload {
  projects: Array<{
    code: string
    mtd_cost_usd: string
    mine_mtd_usd: string
    spark: Array<{ day: string; cost_usd: string }>
  }>
  untagged_usd: string
}

describe('/me/projects/summary — the list-band operands (T20)', () => {
  it('cards carry mine_mtd_usd + spark on the card’s own lane, and the caller’s untagged_usd', async () => {
    const s = (await summaryHandler(
      ev(devId, '/x') as unknown as Parameters<typeof summaryHandler>[0],
    )) as unknown as SummaryPayload
    expect(s.projects).toHaveLength(1)
    const card = s.projects[0]
    expect(card.code).toBe(PROJECT_CODE)
    // The card total is BOTH members' MTD; `mine` is the caller's slice of it.
    expect(card.mtd_cost_usd).toBe('8.00')
    expect(card.mine_mtd_usd).toBe('5.00')
    // The spark is the same window's per-day series (both members' spend).
    const anchorDay = ANCHOR.toISOString().slice(0, 10)
    expect(card.spark).toEqual([{ day: anchorDay, cost_usd: '8.00' }])
    // The caller's own taggable-but-untagged spend — the worklist pull-through.
    expect(s.untagged_usd).toBe('2.00')
  })

  it('the other member’s summary shows THEIR slice — mine is per-caller, not per-card-copy', async () => {
    const s = (await summaryHandler(
      ev(mateId, '/x') as unknown as Parameters<typeof summaryHandler>[0],
    )) as unknown as SummaryPayload
    expect(s.projects[0].mtd_cost_usd).toBe('8.00')
    expect(s.projects[0].mine_mtd_usd).toBe('3.00')
    expect(s.untagged_usd).toBe('0.00')
  })
})
