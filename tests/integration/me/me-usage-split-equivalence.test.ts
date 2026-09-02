// @vitest-environment node
/*
 * The SPLIT read equals the VIEW read, cent for cent.
 *
 * `usage_rollup_daily` is derived from `v_complete_usage` by a worker
 * (usage-rollup-lane.md R3), so the two are identical by construction — for
 * days the worker has materialised. This asserts that identity on the actual
 * read helpers rather than trusting the derivation, because the helpers do the
 * SPLIT arithmetic themselves and that is where the mistake would live: a
 * boundary off by one day double-counts or drops a day, and both look like
 * plausible money.
 *
 * The golden suite cannot cover this: it exercises the route, which runs the
 * gate, and in a test estate the gate is closed (no worker_run rows). So the
 * split path needs to be driven directly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { seedKnownOutcomeCompany, KO_NOW, type KnownOutcomeIds } from '../helpers/known-outcome-fixture'
import { buildUsageRollup } from '../helpers/usage-rollup'
import {
  teammateWindowDaily,
  teammateWindowProjects,
  teammateClaudeWindow,
  teammateWindowDailyForProjects,
} from '../../../server/usage/me-usage-window'
import type { RollupGate } from '../../../server/usage/rollup-gate'
import {
  completeProjectSpend,
  completeTeammateModelMix,
} from '../../../server/usage/complete-spend'
import { getMyUsage } from '../../../server/utils/me-queries'
import { getMyToolGaps } from '../../../server/utils/me-lens'

let t: TestDb
let ids: KnownOutcomeIds

/** The fixture's clock: 2026-05-15T12:00:00Z — mid-day, mid-month. */
const NOW_ISO = KO_NOW.toISOString()
const TODAY = NOW_ISO.slice(0, 10)
const GATE: RollupGate = { settledThrough: '2026-05-14', todayUtc: TODAY }

/** The page's shape: month start to a CLAMPED, non-midnight end. */
const WINDOW = { startIso: '2026-05-01T00:00:00.000Z', endIso: NOW_ISO }

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  ids = await seedKnownOutcomeCompany(t)

  /*
   * SPEND ON THE BOUNDARY. The shared fixture puts all of alice's spend on
   * 05-05 — comfortably inside the settled range — so moving the split boundary
   * changed nothing and every mutation of it passed. Three rows fix that:
   *
   *   05-15 (TODAY)     exercises the LIVE arm; without it a broken live arm is
   *                     invisible and a rollup arm that over-claims today costs
   *                     nothing.
   *   05-14 (SETTLED)   the last day the rollup arm owns — the day an off-by-one
   *                     on either side moves.
   *   04-25 (BEFORE)    outside the window, so a rollup arm that ignores the
   *                     window start pulls it in and the totals diverge.
   */
  const inst = await t.client<{ id: string }[]>`
    SELECT instance_id::text AS id FROM attribution_record
     WHERE teammate_id = ${ids.alice}::uuid LIMIT 1`
  const instId = inst[0]!.id
  const boundaryRow = async (day: string, cost: number, projectId: string | null = null) => {
    await t.client`
      INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
         tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event,
         claude_session_id)
      VALUES (${instId}::uuid, ${ids.alice}::uuid, ${ids.regionApac}::uuid, ${ids.uApacCto}::uuid,
              ${ids.uApacCto}::uuid, ${projectId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input',
              1000, ${cost}, 'tier-1', 'estimated', ${day}::timestamptz,
              ${'conv-boundary-' + day + (projectId ?? '')})`
  }
  await boundaryRow('2026-05-15T09:00:00Z', 7)
  await boundaryRow('2026-05-14T09:00:00Z', 11)
  await boundaryRow('2026-04-25T09:00:00Z', 13)

  /*
   * The same three days again, but ATTRIBUTED TO A PROJECT. The rows above
   * carry project_id NULL, and teammateWindowProjects filters those out — so
   * with them alone its boundary is untested and both of its mutations passed.
   * A read that filters on a dimension needs boundary data carrying that
   * dimension; "there is spend near the boundary" is not sufficient.
   */
  await boundaryRow('2026-05-15T10:00:00Z', 5, ids.projScholarship)
  await boundaryRow('2026-05-14T10:00:00Z', 9, ids.projScholarship)
  await boundaryRow('2026-04-25T10:00:00Z', 17, ids.projScholarship)

  /*
   * A PROVISIONAL row on a SETTLED day. completeProjectSpend FILTERs on
   * identity_state, and with every fixture row NULL that filter is inert:
   * nulling the column out of the rollup arm changed no figure and the mutation
   * passed. It has to exist on the rollup side specifically, since that is the
   * arm whose columns the split chooses.
   */
  await t.client`
    UPDATE attribution_record SET identity_state = 'provisional'
     WHERE teammate_id = ${ids.alice}::uuid
       AND ts_event >= '2026-05-14T00:00:00Z'::timestamptz
       AND ts_event <  '2026-05-15T00:00:00Z'::timestamptz`

  await buildUsageRollup(t.db)
}, 300_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('teammateWindowDaily — split vs view', () => {
  it('returns exactly the same days and the same money', async () => {
    const viaView = await teammateWindowDaily(t.db, ids.alice, WINDOW, null)
    const viaSplit = await teammateWindowDaily(t.db, ids.alice, WINDOW, GATE)
    expect(viaSplit).toEqual(viaView)
  })

  it('the estate actually has money in it, so equality is not two empty sets', async () => {
    // Without this an off-by-one boundary that dropped EVERY day would pass the
    // assertion above by returning nothing on both sides.
    const viaView = await teammateWindowDaily(t.db, ids.alice, WINDOW, null)
    const total = viaView.days.reduce((a, d) => a + d.costUsd, 0)
    expect(viaView.days.length).toBeGreaterThan(0)
    expect(total).toBeGreaterThan(0)
  })

  it('spans the boundary: days on BOTH sides of settledThrough are present', async () => {
    /*
     * The split is only meaningfully exercised when the window contains settled
     * days AND today. If the fixture's spend all sat before settledThrough, the
     * live arm would contribute nothing and a broken live arm would go unnoticed.
     */
    const viaSplit = await teammateWindowDaily(t.db, ids.alice, WINDOW, GATE)
    const settled = viaSplit.days.filter((d) => d.day <= GATE.settledThrough)
    const live = viaSplit.days.filter((d) => d.day >= GATE.todayUtc)
    // BOTH arms must carry money, or a mutation of the silent one passes.
    expect(settled.length, 'no settled days — the rollup arm is untested').toBeGreaterThan(0)
    expect(live.length, 'no rows on today — the LIVE arm is untested').toBeGreaterThan(0)
    expect(settled.reduce((a, d) => a + d.costUsd, 0)).toBeGreaterThan(0)
    expect(live.reduce((a, d) => a + d.costUsd, 0)).toBeGreaterThan(0)
  })

  it('an OVERLAPPING settledThrough is harmless — the window end clips it', async () => {
    /*
     * This case used to assert that an overlapping boundary CHANGED the total,
     * on the theory that the rollup arm would then double-count today. Adding
     * the window's exclusive upper bound to the rollup arm made that false: the
     * arm is now clipped by endIso before settledThrough can over-reach, so the
     * two agree. The assertion is inverted to match, because the property is
     * worth pinning either way — a future change that removed the endIso bound
     * would make this pair diverge, and the three past-ended cases below would
     * go red alongside it.
     */
    const overlapping: RollupGate = { settledThrough: TODAY, todayUtc: TODAY }
    const good = await teammateWindowDaily(t.db, ids.alice, WINDOW, GATE)
    const bad = await teammateWindowDaily(t.db, ids.alice, WINDOW, overlapping)
    const sum = (r: typeof good) => r.days.reduce((a, d) => a + d.costUsd, 0)
    expect(sum(bad)).toBe(sum(good))
    // And the total is real, so this is not 0 === 0.
    expect(sum(good)).toBeGreaterThan(0)
  })
})

describe('teammateWindowProjects — split vs view', () => {
  it('returns the same projects, the same money, in the same order', async () => {
    const viaView = await teammateWindowProjects(t.db, ids.alice, WINDOW, null)
    const viaSplit = await teammateWindowProjects(t.db, ids.alice, WINDOW, GATE)
    expect(viaSplit).toEqual(viaView)
  })

  it('has projects with money on BOTH sides of the boundary', async () => {
    /*
     * Asserted BY DAY, not by aggregate. An earlier version checked only that
     * the total was positive, which stays green if every project row moves to
     * one side — the exact fixture drift this guard exists to catch, and the
     * reason the daily read's live arm was untested until boundary rows were
     * seeded. The name claimed both sides; only the sum was checked.
     */
    const [sides] = await t.client<{ settled: string; live: string }[]>`
      SELECT COALESCE(SUM(cost_usd) FILTER (
               WHERE (ts_event AT TIME ZONE 'UTC')::date <= ${GATE.settledThrough}::date), 0)::text AS settled,
             COALESCE(SUM(cost_usd) FILTER (
               WHERE (ts_event AT TIME ZONE 'UTC')::date >= ${GATE.todayUtc}::date), 0)::text AS live
        FROM v_complete_usage
       WHERE teammate_id = ${ids.alice}::uuid
         AND project_id IS NOT NULL
         AND ts_event >= ${WINDOW.startIso}::timestamptz
         AND ts_event < ${WINDOW.endIso}::timestamptz`
    expect(Number(sides!.settled), 'no project spend on the ROLLUP side').toBeGreaterThan(0)
    expect(Number(sides!.live), 'no project spend on the LIVE side').toBeGreaterThan(0)
  })
})

describe('teammateClaudeWindow — split vs view', () => {
  const DAY_BOUNDS = { from: '2026-05-01', to: '2026-05-15' }

  it('returns the same surfaces, money and ACTIVE DAY COUNT', async () => {
    const viaView = await teammateClaudeWindow(t.db, ids.alice, WINDOW, DAY_BOUNDS, null)
    const viaSplit = await teammateClaudeWindow(t.db, ids.alice, WINDOW, DAY_BOUNDS, GATE)
    expect(viaSplit).toEqual(viaView)
  })

  it('activeDays is a UNION of day sets, not a sum of two counts', async () => {
    /*
     * The failure this guards is specific: summing each arm's DISTINCT-day count
     * double-counts nothing here (the arms are disjoint by day) but WOULD if the
     * boundary ever overlapped. Unioning rows before counting makes the right
     * answer structural. Asserted against the view, which has only one arm and
     * therefore cannot make the mistake.
     */
    const viaView = await teammateClaudeWindow(t.db, ids.alice, WINDOW, DAY_BOUNDS, null)
    const viaSplit = await teammateClaudeWindow(t.db, ids.alice, WINDOW, DAY_BOUNDS, GATE)
    expect(viaSplit.activeDays).toBe(viaView.activeDays)
    // And the estate must actually span days, or equality is 0 === 0.
    expect(viaView.activeDays).toBeGreaterThan(1)
  })

  it('has claude spend on BOTH sides of the boundary', async () => {
    // By day, for the same reason as the project guard above: a positive total
    // proves the fixture is non-empty, not that it spans the boundary.
    const [sides] = await t.client<{ settled: string; live: string }[]>`
      SELECT COALESCE(SUM(cost_usd) FILTER (
               WHERE (ts_event AT TIME ZONE 'UTC')::date <= ${GATE.settledThrough}::date), 0)::text AS settled,
             COALESCE(SUM(cost_usd) FILTER (
               WHERE (ts_event AT TIME ZONE 'UTC')::date >= ${GATE.todayUtc}::date), 0)::text AS live
        FROM v_complete_usage
       WHERE teammate_id = ${ids.alice}::uuid
         AND tool = 'claude-code'
         AND ts_event >= ${WINDOW.startIso}::timestamptz
         AND ts_event < ${WINDOW.endIso}::timestamptz`
    expect(Number(sides!.settled), 'no claude spend on the ROLLUP side').toBeGreaterThan(0)
    expect(Number(sides!.live), 'no claude spend on the LIVE side').toBeGreaterThan(0)
  })
})

describe('frontierDay across the split', () => {
  it('is the MAXIMUM populated day, not the last day of either arm alone', async () => {
    // frontierDay drives month-over-month pacing. It comes off an ORDER BY day
    // over the UNIONED rows, so it is a max by construction — pinned because a
    // future refactor that merged two pre-sorted arms could silently take the
    // settled arm's last day instead.
    const viaView = await teammateWindowDaily(t.db, ids.alice, WINDOW, null)
    const viaSplit = await teammateWindowDaily(t.db, ids.alice, WINDOW, GATE)
    expect(viaSplit.frontierDay).toBe(viaView.frontierDay)
    // The live arm holds the latest day, so a settled-arm-only max would differ.
    expect(viaSplit.frontierDay).toBe(TODAY)
  })
})

describe('a PAST-ENDED window — the shape the current-month cases cannot expose', () => {
  /*
   * THE MISSING FOURTH STATE. Every case above uses a window ending at `now`,
   * where "settled through yesterday" and "before the window end" happen to
   * coincide. They cannot distinguish a rollup arm bounded by settledThrough
   * from one bounded by the window's own end.
   *
   * A COMPLETED window separates them: April's window ends 2026-05-01, but
   * settledThrough is 2026-05-14, so an unbounded rollup arm sweeps in two extra
   * weeks of May spend and reports it as April.
   */
  const APRIL = { startIso: '2026-04-01T00:00:00.000Z', endIso: '2026-05-01T00:00:00.000Z' }

  it('daily: a completed month must not absorb spend from after its end', async () => {
    const viaView = await teammateWindowDaily(t.db, ids.alice, APRIL, null)
    const viaSplit = await teammateWindowDaily(t.db, ids.alice, APRIL, GATE)
    expect(viaSplit).toEqual(viaView)
  })

  it('projects: same window, same guarantee', async () => {
    const viaView = await teammateWindowProjects(t.db, ids.alice, APRIL, null)
    const viaSplit = await teammateWindowProjects(t.db, ids.alice, APRIL, GATE)
    expect(viaSplit).toEqual(viaView)
  })

  it('claude: same window, same guarantee', async () => {
    const bounds = { from: '2026-04-01', to: '2026-04-30' }
    const viaView = await teammateClaudeWindow(t.db, ids.alice, APRIL, bounds, null)
    const viaSplit = await teammateClaudeWindow(t.db, ids.alice, APRIL, bounds, GATE)
    expect(viaSplit).toEqual(viaView)
  })

  it('the estate HAS spend after April, or these three prove nothing', async () => {
    // Without May spend, an unbounded rollup arm would sweep in nothing and the
    // equalities above would hold for the wrong reason.
    const may = await teammateWindowDaily(t.db, ids.alice, WINDOW, null)
    expect(may.days.length, 'no May spend — the over-read cannot be detected').toBeGreaterThan(0)
    expect(may.days.reduce((a, d) => a + d.costUsd, 0)).toBeGreaterThan(0)
  })
})

describe('teammateWindowDailyForProjects — split vs view', () => {
  it('returns the same per-day map for a current window', async () => {
    const projects = await teammateWindowProjects(t.db, ids.alice, WINDOW, null)
    const projectIds = projects.map((p) => p.projectId)
    expect(projectIds.length, 'no projects — the comparison is two empty maps').toBeGreaterThan(0)

    const viaView = await teammateWindowDailyForProjects(t.db, ids.alice, WINDOW, projectIds, null)
    const viaSplit = await teammateWindowDailyForProjects(t.db, ids.alice, WINDOW, projectIds, GATE)
    expect([...viaSplit.entries()].sort()).toEqual([...viaView.entries()].sort())
    expect(viaView.size).toBeGreaterThan(0)
  })

  it('and for a PAST-ENDED window, where the upper bound is load-bearing', async () => {
    const APRIL = { startIso: '2026-04-01T00:00:00.000Z', endIso: '2026-05-01T00:00:00.000Z' }
    const projects = await teammateWindowProjects(t.db, ids.alice, WINDOW, null)
    const projectIds = projects.map((p) => p.projectId)
    const viaView = await teammateWindowDailyForProjects(t.db, ids.alice, APRIL, projectIds, null)
    const viaSplit = await teammateWindowDailyForProjects(t.db, ids.alice, APRIL, projectIds, GATE)
    expect([...viaSplit.entries()].sort()).toEqual([...viaView.entries()].sort())
  })
})

describe('a window entirely inside TODAY — the rollup arm covers nothing', () => {
  /*
   * splitBounds returns rollupTo === null here, and the SQL then compares
   * `r.day <= NULL`, which is NULL and therefore excludes every row. That is
   * the correct outcome, but it is IMPLICIT — a reader could reasonably expect
   * an inverted range or an error — so it is pinned rather than assumed.
   */
  const TODAY_ONLY = { startIso: `${TODAY}T00:00:00.000Z`, endIso: NOW_ISO }

  it('daily agrees with the view', async () => {
    const viaView = await teammateWindowDaily(t.db, ids.alice, TODAY_ONLY, null)
    const viaSplit = await teammateWindowDaily(t.db, ids.alice, TODAY_ONLY, GATE)
    expect(viaSplit).toEqual(viaView)
    // And there IS spend today, so this is not two empty results agreeing.
    expect(viaView.days.length).toBeGreaterThan(0)
  })

  it('projects agrees with the view', async () => {
    const viaView = await teammateWindowProjects(t.db, ids.alice, TODAY_ONLY, null)
    const viaSplit = await teammateWindowProjects(t.db, ids.alice, TODAY_ONLY, GATE)
    expect(viaSplit).toEqual(viaView)
    expect(viaView.length).toBeGreaterThan(0)
  })
})

describe('complete-spend reads — split vs view', () => {
  it('completeTeammateModelMix agrees, current and past-ended windows', async () => {
    for (const w of [
      WINDOW,
      { startIso: '2026-04-01T00:00:00.000Z', endIso: '2026-05-01T00:00:00.000Z' },
    ]) {
      const viaView = await completeTeammateModelMix(t.db, ids.alice, w, null)
      const viaSplit = await completeTeammateModelMix(t.db, ids.alice, w, GATE)
      expect(viaSplit, `window ${w.startIso}`).toEqual(viaView)
    }
    // Non-trivial: the current window must carry money through this read.
    const cur = await completeTeammateModelMix(t.db, ids.alice, WINDOW, null)
    expect(cur.totalUsd).toBeGreaterThan(0)
  })

  it('completeProjectSpend takes NO gate — the signature is the guarantee', async () => {
    /*
     * It aggregates a project across ALL teammates, and a RollupGate certifies
     * ONE. There is no gate that could cover these rows, so the parameter is
     * gone rather than merely unused: the split path it fed was dead code
     * holding the door open for a caller to serve colleagues' stale rows under
     * a proof that looked reassuring.
     *
     * Asserted on the TYPE, which is what actually stops it — a fourth argument
     * is a compile error now, and this case exists so the behaviour that
     * replaced the split is still pinned.
     */
    const projects = await teammateWindowProjects(t.db, ids.alice, WINDOW, null)
    const projectIds = projects.map((p) => p.projectId)
    const cur = await completeProjectSpend(t.db, WINDOW, { projectIds, excludeProvisional: true })
    expect(cur.size, 'no project spend — the assertion below is vacuous').toBeGreaterThan(0)

    // Still window-bounded, which is the property the removed split had to
    // preserve and the one a refused-bounds fallback used to break.
    const narrow = await completeProjectSpend(
      t.db,
      { startIso: '2026-05-01T00:00:00.000Z', endIso: '2026-05-02T00:00:00.000Z' },
      { projectIds, excludeProvisional: true },
    )
    const wide = await completeProjectSpend(
      t.db,
      { startIso: '2020-01-01T00:00:00.000Z', endIso: KO_NOW.toISOString() },
      { projectIds, excludeProvisional: true },
    )
    const sum = (m: Map<string, { costUsd: number }>) =>
      [...m.values()].reduce((a, v) => a + v.costUsd, 0)
    expect(sum(narrow)).toBeLessThan(sum(wide))
  })
})

describe('getMyUsage — the MTD headline and quota', () => {
  it('agrees between split and view, including the project buckets', async () => {
    const viaView = await getMyUsage(t.db, ids.alice, KO_NOW, null)
    const viaSplit = await getMyUsage(t.db, ids.alice, KO_NOW, GATE)
    expect(viaSplit).toEqual(viaView)
  })

  it('carries real money and real buckets, so equality is not two empty shapes', async () => {
    const viaView = await getMyUsage(t.db, ids.alice, KO_NOW, null)
    expect(Number(viaView.total_cost_usd ?? 0)).toBeGreaterThan(0)
  })
})

describe('getMyToolGaps — the lens disclosure', () => {
  it('agrees between split and view', async () => {
    const viaView = await getMyToolGaps(t.db, ids.alice, KO_NOW, null)
    const viaSplit = await getMyToolGaps(t.db, ids.alice, KO_NOW, GATE)
    expect(viaSplit).toEqual(viaView)
    expect(viaView.length, 'no tool gaps — the comparison is two empty lists').toBeGreaterThan(0)
  })
})

describe('a REFUSED split still respects the window', () => {
  /*
   * The hole a refusable splitBounds opened, and the reason the fallback needs
   * its own coverage rather than being assumed equivalent to "no gate".
   *
   * Two helpers hoist the window predicate out of the source and switch it off
   * when the read is split, because a split source carries the window in its
   * own arms. Keyed on the GATE rather than on the BOUNDS, a refusal took the
   * unbounded view and no predicate: a window figure became all history.
   *
   * The shape below is one splitBounds refuses — a mid-day END on a day before
   * today, whose final partial day the live arm cannot reach.
   */
  const REFUSED = { startIso: '2026-05-01T00:00:00.000Z', endIso: '2026-05-10T12:00:00.000Z' }

  it('completeTeammateModelMix: a refused window equals the ungated window', async () => {
    const gated = await completeTeammateModelMix(t.db, ids.alice, REFUSED, GATE)
    const ungated = await completeTeammateModelMix(t.db, ids.alice, REFUSED, null)
    expect(gated).toEqual(ungated)
    const wider = await completeTeammateModelMix(
      t.db,
      ids.alice,
      { startIso: '2020-01-01T00:00:00.000Z', endIso: KO_NOW.toISOString() },
      null,
    )
    expect(gated.totalUsd).toBeGreaterThan(0)
    expect(gated.totalUsd).toBeLessThan(wider.totalUsd)
  })
})
