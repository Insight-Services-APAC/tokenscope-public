/*
 * GET /api/v1/me/cost-centres — the P&L-owner view (J3, mig 0048).
 *
 * One card per cost-owning unit the caller OWNS (active cou_owner row):
 * the projects whose lead CC it is, each with MTD burn vs allocation,
 * velocity, PM names, and cross-CC member composition; CC-level totals
 * on top. "What do I own and what's it burning" on one response.
 *
 * Authz is the RELATIONSHIP, not the role: any teammate with active
 * ownership rows gets their centres; everyone else gets an empty list
 * (200, not 403 — the nav uses total to decide whether to show the
 * entry point). App-layer gate via getOwnedCostCentreIds — RLS is inert
 * at runtime until Epic 10 (see server/auth/org-roles.ts).
 *
 * Per-project MTD burn is `completeProjectSpend` (server/usage/complete-spend.ts)
 * — THE project-spend definition, in ONE batched call across every centre the
 * caller owns. The CC-level `mtd_cost_usd` is Σ of those project figures, so it
 * is a PROJECT roll-up, not the cost centre's own §A burn: the two differ by
 * money on the lane that no project row can carry, and `reconciliation` publishes
 * the burn AND every term between them so the card adds up on its own face
 * rather than leaving an unexplained gap against /reports/cost-centres.
 *
 * BATCHED, not per centre. Every read below is one statement over the whole
 * owned set: projects, spend, the reconciliation terms, allocations, velocity
 * and member composition. It used to be a per-centre loop containing a
 * per-PROJECT pair of awaits — five statements per centre plus two per project,
 * for a response whose every figure is a GROUP BY on a set of ids.
 *
 * ── THE WINDOW IS A PARAM, AND IT IS STILL NEVER OPEN-ENDED ──────────────────
 * This card is the Cost-Centre reporting scope's primary table, and that scope
 * carries a period control — so the response windows on the period it is asked
 * for rather than always answering "this month so far" under a header that says
 * June. Absent params are byte-identical to the original behaviour.
 *
 * The upper bound is never the future: the current month is MONTH TO DATE
 * (`[month start, now)`), a past month is its whole calendar month, and an
 * explicit range is clamped at `now`. The EFFECTIVE window is published back
 * (`window`) rather than left for the caller to re-derive from the params it
 * sent: the clamp means the answered period is not always the requested one, and
 * a label built from the request would say "→ 2026-12-31" over a figure that
 * stops at today.
 *
 * Two DIFFERENT window facts gate the two forward-looking figures, because they
 * are two different claims:
 *   - `projected_exhaustion_date` is MTD arithmetic (spend ÷ day-of-month), so it
 *     is computed ONLY for a current-month month-to-date window. Over any other
 *     span the divisor is the wrong number of days — a quarter-to-date range
 *     divided by the day of the month reads as one month's burn and prints a
 *     confidently wrong date.
 *   - `velocity` is a LIVE rate (this ISO week vs the trailing four), so it is
 *     published only while the window still reaches `now`. A June table cannot
 *     honestly carry this week's run-rate; it is `null` there, not a zero.
 *
 * ── THE PROJECT LIST IS RANKED AND BOUNDED ───────────────────────────────────
 * A centre accumulates projects forever, and the ones that answer "what is
 * burning my budget" are the ones burning it. The rows are ranked by burn and
 * capped (OWNER_PROJECT_ROW_CAP); ended projects with no spend in the window are
 * held back entirely. Nothing is silently dropped: `omitted_projects` publishes
 * the count and the Σ, so the header roll-up (which is still Σ over EVERY
 * project, so the burn reconciliation keeps closing) is explained by the rows
 * below it. The per-project member/manager composition — three correlated
 * subqueries — is resolved for the RENDERED rows only, not for every project the
 * centre has ever led.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { activeProjectPredicate } from '../../../db/project-predicates'
import { exhaustionDate } from '../../../usage/projections'
import { getValidated } from '../../../utils/validated-body'
import {
  fetchProjectAllocations,
  fetchProjectVelocities,
  type VelocityState,
} from '../../../usage/consumption'
import {
  completeCostCentreProjectResiduals,
  completeProjectSpend,
  zeroCostCentreResidual,
} from '../../../usage/complete-spend'
import { resolveReportRange, DATE_REGEX } from '../../../reporting/params'
import {
  calendarMonthWindow,
  monthToDateWindow,
  monthStartIso,
  monthKeyUtc,
  MONTH_REGEX,
  type IsoWindow,
} from '../../../utils/period'
import {
  GOV_VELOCITY_SPIKE_THRESHOLD,
  loadGovernanceSettingResolver,
} from '../../../utils/governance-settings'
import { requestClock } from '../../../utils/request-clock'
import type { CostCentreCard, CostCentreProject } from '../../../../shared/schemas/cost-centres'

const Query = z.object({
  /** Nav probe — serve the ownership COUNT only, without the P&L aggregation. */
  count: z.enum(['1']).optional(),
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
})

/** The window this response answers for, plus what each bound licenses. */
export interface OwnerWindow extends IsoWindow {
  /**
   * True when the window's upper bound IS `now` — the only case in which a LIVE
   * rate (velocity: this ISO week vs the trailing four) describes the period on
   * screen. False for a completed month or a range that ended in the past.
   */
  runsToNow: boolean
  /**
   * True ONLY for the current month's `[month start, now)`.
   *
   * The exhaustion projection divides spend by the DAY OF THE MONTH
   * (`usage/projections.ts`), which is the right divisor for exactly this window
   * and no other: over a quarter-to-date range it treats a quarter's spend as one
   * month's burn and prints a date that is confidently wrong. Structural, not
   * param-based — `from=<1st of this month>&to=<today>` IS a month-to-date window
   * and gets the projection; `month=2026-06` and `from=<quarter start>` do not.
   */
  isMonthToDate: boolean
  /**
   * `YYYY-MM` when the window covers exactly that WHOLE calendar month, else
   * null. Lets the caller label a completed month by name instead of re-deriving
   * it from params the server may have clamped.
   */
  month: string | null
}

/** True when `[startIso, endIso)` is exactly one whole calendar month. */
function wholeCalendarMonth(win: IsoWindow): string | null {
  const start = new Date(win.startIso)
  if (Number.isNaN(start.getTime())) return null
  const cal = calendarMonthWindow(start)
  return cal.startIso === win.startIso && cal.endIso === win.endIso ? monthKeyUtc(start) : null
}

/** Decorate a resolved `[start, end)` with the two gates + the month label. */
function ownerWindow(win: IsoWindow, now: Date): OwnerWindow {
  const nowIso = now.toISOString()
  return {
    ...win,
    runsToNow: win.endIso === nowIso,
    isMonthToDate: win.endIso === nowIso && win.startIso === monthStartIso(now),
    month: wholeCalendarMonth(win),
  }
}

/**
 * Resolve the requested period into a half-open window whose upper bound is
 * never in the future.
 *
 * PURE and exported so the "no open upper bound" rule is testable without a
 * database: the failure it guards is a window that counts rows dated later than
 * the instant the figure is quoted, which `server/utils/period.ts` documents at
 * length and which no fixture with only past-dated rows can ever catch.
 */
export function resolveOwnerWindow(
  query: { month?: string; from?: string; to?: string },
  /*
   * REQUIRED — no default. A `= new Date()` default here is a second clock
   * hiding behind an optional argument: every current caller passes one, so the
   * default could only ever be reached by a future caller that forgot, and it
   * would silently window that response off the wall clock instead of the
   * request's. Making it mandatory turns that into a compile error.
   */
  now: Date,
): OwnerWindow {
  const nowIso = now.toISOString()
  const range = resolveReportRange(query)
  if (range) {
    // A range may legitimately be asked for open-endedly (`to` = a future date);
    // clamp so "spent" never includes instants that have not happened.
    const endIso = range.endIso > nowIso ? nowIso : range.endIso
    return ownerWindow(
      {
        startIso: range.startIso,
        // A range wholly in the future would invert; collapse it to empty instead.
        endIso: endIso < range.startIso ? range.startIso : endIso,
      },
      now,
    )
  }
  if (query.month && query.month !== monthKeyUtc(now)) {
    const monthStart = new Date(`${query.month}-01T00:00:00.000Z`)
    const win = calendarMonthWindow(monthStart)
    // A FUTURE month has nothing to report; clamping keeps the bound honest and
    // an entirely-future month collapses to empty rather than inverting.
    if (win.endIso > nowIso) {
      const endIso = win.startIso > nowIso ? win.startIso : nowIso
      return ownerWindow({ startIso: win.startIso, endIso }, now)
    }
    return ownerWindow(win, now)
  }
  return ownerWindow(monthToDateWindow(now), now)
}

/**
 * The effective window as INCLUSIVE calendar dates, for a label.
 *
 * `endIso` is the EXCLUSIVE upper bound, so the last day it covers is the day
 * containing `endIso − 1ms`. A collapsed (empty) window would otherwise report a
 * `to` before its `from`; it is floored at `from` instead.
 */
export function ownerWindowDates(win: IsoWindow): { from: string; to: string } {
  const from = win.startIso.slice(0, 10)
  const lastInstant = Date.parse(win.endIso) - 1
  const to = new Date(Math.max(lastInstant, Date.parse(win.startIso))).toISOString().slice(0, 10)
  return { from, to: to < from ? from : to }
}

/**
 * Max project rows one cost-centre card renders before the tail is folded into
 * `omitted_projects`.
 *
 * A P&L owner reads the top of this list to decide whether to extend a budget;
 * the hundredth-ranked project is not part of that decision, and every rendered
 * row costs three correlated subqueries (membership, cross-centre membership,
 * PMs). 25 matches the in-repo bound for a decision list of this class
 * (`fetchRegionalExceptions`), and the omitted Σ is published so the header
 * roll-up still adds up on the card's own face.
 */
export const OWNER_PROJECT_ROW_CAP = 25

interface CouRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  region_code: string
  region_id: string
}

/** A project with no rollup rows yet — quiet, not flagged. */
const ZERO_VELOCITY: VelocityState = {
  current_week_usd: '0.00',
  trailing_mean_usd: '0.00',
  delta_pct: null,
  is_flagged: false,
}

/** The cheap half: one indexed read of `project`, no per-row subqueries. */
interface ProjectRow extends Record<string, unknown> {
  cou_id: string
  id: string
  code: string
  display_name: string
  type: string
  wbs_code: string | null
  end_date: string | null
  ended: boolean
}

/** The expensive half — resolved for the RENDERED rows only (three subqueries each). */
interface ProjectCompositionRow extends Record<string, unknown> {
  id: string
  member_count: string
  cross_cou_member_count: string
  managers: string[] | null
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  // The repository's validated-query helper, NOT h3's: a bad `month`/`from`/`to`
  // must come back as this project's RFC 9457 problem document naming the field
  // and its rule, not as h3's bare "Validation Error".
  const query = await getValidated(event, Query)
  // R1 F9: the nav probe only needs the count — serve it without the
  // P&L aggregation (one indexed lookup, owner or not).
  const countOnly = query.count === '1'
  /*
   * F1/F6: the REQUEST's clock, never a second `new Date()`. `resolveOwnerWindow`
   * already took `now` as an injectable seam, so this is a swap, not a refactor.
   * It matters here specifically: this window bounds EVERY spend figure on the
   * cost-centre response, and F5 rebuilt that page in this same change — a page
   * whose window came from a different clock than `/usage` would disagree with
   * it across a UTC midnight, which is the S6/S7 defect class one surface over.
   */
  const now = new Date(requestClock(event).now)
  // ONE window for every spend figure on this response, and its upper bound is
  // never the future: month-to-date `[month start, now)` by default, the whole
  // calendar month for a completed one, a clamped `[from, to]` for a range.
  // Resolved BEFORE the count branch so every response — including the nav
  // probe — states the period it answered for.
  const monthWindow = resolveOwnerWindow(query, now)
  const windowDates = ownerWindowDates(monthWindow)
  const effectiveWindow = {
    from: windowDates.from,
    to: windowDates.to,
    month: monthWindow.month,
    runs_to_now: monthWindow.runsToNow,
  }

  return await withRequestRls(event, async (tx) => {
    if (countOnly) {
      const rows = await tx.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n
        FROM cou_owner co
        JOIN org_unit ou ON ou.id = co.org_unit_id
        WHERE co.teammate_id = ${session.teammateId}::uuid
          AND co.revoked_at IS NULL
          AND ou.retired_at IS NULL
      `)
      return { cost_centres: [], total: Number([...rows][0]?.n ?? 0), window: effectiveWindow }
    }

    // Single join on the ownership relation — no id-array round-trip.
    const cous = await tx.execute<CouRow>(sql`
      SELECT ou.id::text AS id, ou.code, ou.display_name, r.code AS region_code,
             ou.region_id::text AS region_id
      FROM cou_owner co
      JOIN org_unit ou ON ou.id = co.org_unit_id
      JOIN region r ON r.id = ou.region_id
      WHERE co.teammate_id = ${session.teammateId}::uuid
        AND co.revoked_at IS NULL
        AND ou.retired_at IS NULL
      ORDER BY ou.display_name
    `)
    if ([...cous].length === 0) {
      return { cost_centres: [], total: 0, window: effectiveWindow }
    }

    // Spike-threshold dial (mig 0049): one snapshot per request, applied
    // per COST CENTRE's region (R1 F2 — the subject's region decides the
    // bar; ownership can be cross-region).
    const thresholdFor = await loadGovernanceSettingResolver(tx, GOV_VELOCITY_SPIKE_THRESHOLD)

    const couList = [...cous]
    const couIds = couList.map((c) => c.id)

    /*
     * ONE query for every owned centre's projects, not one per centre — and only
     * the CHEAP columns. The per-project member/manager composition is three
     * correlated subqueries and it used to run here, for every project every
     * owned centre has EVER led; it now runs once the ranking below has decided
     * which rows are actually rendered.
     */
    const projRows = await tx.execute<ProjectRow>(sql`
      SELECT
        p.cost_owning_unit_id::text AS cou_id,
        p.id::text AS id, p.code, p.display_name, p.type, p.wbs_code,
        p.end_date::text AS end_date,
        (NOT ${activeProjectPredicate('p')}) AS ended
      FROM project p
      WHERE p.cost_owning_unit_id = ANY(ARRAY[${sql.join(
        couIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}])
      ORDER BY p.code
    `)
    const allProjects = [...projRows]
    const projectIds = allProjects.map((p) => p.id)
    const couById = new Map(couList.map((c) => [c.id, c]))
    const projectCouId = new Map(allProjects.map((p) => [p.id, p.cou_id]))

    // ONE lane read for EVERY project of EVERY owned centre; ONE residual read
    // for every centre; ONE allocation read across the lot. Spend and allocation
    // stay whole-set: the CC roll-up and the burn reconciliation are Σ over EVERY
    // project, so ranking must not narrow the operands they are computed from.
    const [spendByProject, residualByCou, allocByProject] = await Promise.all([
      completeProjectSpend(tx, monthWindow, {
        projectIds,
        excludeProvisional: true,
      }),
      completeCostCentreProjectResiduals(tx, couIds, monthWindow, { excludeProvisional: true }),
      fetchProjectAllocations(tx, projectIds),
    ])

    /*
     * RANK, FILTER, CAP — per centre, on the burn the card is about.
     *
     * Held back: a project that has ENDED and spent nothing in this window. It
     * cannot be the answer to "what is burning my budget", and a card that opens
     * with a decade of finished work buries the two rows that are. Everything
     * held back is counted and summed into `omitted_projects`, so the header
     * roll-up above the rows is still explained by them.
     */
    const burnOf = (p: ProjectRow) => spendByProject.get(p.id)?.costUsd ?? 0
    const dormant = (p: ProjectRow) => p.ended && burnOf(p) === 0
    const visibleByCou = new Map<string, ProjectRow[]>()
    const omittedByCou = new Map<string, { count: number; costUsd: number; dormant: number }>()
    for (const cou of couList) {
      const mine = allProjects.filter((p) => p.cou_id === cou.id)
      const dormantRows = mine.filter(dormant)
      const live = mine
        .filter((p) => !dormant(p))
        // Burn desc, then code — a stable order for equal burns (the client
        // re-sorts by burn too, so the two can never disagree about the top).
        .sort((a, b) => burnOf(b) - burnOf(a) || a.code.localeCompare(b.code))
      const shown = live.slice(0, OWNER_PROJECT_ROW_CAP)
      const tail = live.slice(OWNER_PROJECT_ROW_CAP)
      visibleByCou.set(cou.id, shown)
      omittedByCou.set(cou.id, {
        count: dormantRows.length + tail.length,
        costUsd: tail.reduce((s, p) => s + burnOf(p), 0),
        dormant: dormantRows.length,
      })
    }
    const visibleIds = [...visibleByCou.values()].flat().map((p) => p.id)

    /*
     * The EXPENSIVE half, for the rendered rows only: membership, cross-centre
     * membership and the PM list. A member's HOME CC is their nearest cost-owning
     * ancestor, and home <> lead = cross-CC.
     */
    const compositionById = new Map<string, ProjectCompositionRow>()
    if (visibleIds.length > 0) {
      const compRows = await tx.execute<ProjectCompositionRow>(sql`
        SELECT
          p.id::text AS id,
          (SELECT COUNT(DISTINCT pa.teammate_id) FROM project_assignment pa
            WHERE pa.project_id = p.id AND pa.effective @> now())::text AS member_count,
          (SELECT COUNT(DISTINCT pa.teammate_id)
            FROM project_assignment pa
            JOIN teammate t ON t.id = pa.teammate_id
            JOIN org_unit tou ON tou.id = t.org_unit_id
            LEFT JOIN LATERAL (
              SELECT cou2.id FROM org_unit cou2
              WHERE cou2.path @> tou.path AND cou2.is_cost_owning_unit
                AND cou2.region_id = tou.region_id
              ORDER BY nlevel(cou2.path) DESC LIMIT 1
            ) home ON TRUE
            WHERE pa.project_id = p.id AND pa.effective @> now()
              -- R1 F8: NULL home = UNHOMED (no cost-owning ancestor), not
              -- cross-CC — don't inflate the cross count with config gaps.
              AND home.id IS NOT NULL
              AND home.id IS DISTINCT FROM p.cost_owning_unit_id)::text AS cross_cou_member_count,
          (SELECT array_agg(COALESCE(t.display_name, t.email) ORDER BY t.display_name)
            FROM project_assignment pa
            JOIN teammate t ON t.id = pa.teammate_id
            WHERE pa.project_id = p.id AND pa.role = 'manager'
              AND pa.effective @> now()) AS managers
        FROM project p
        WHERE p.id = ANY(ARRAY[${sql.join(
          visibleIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}])
      `)
      for (const r of compRows) compositionById.set(r.id, r)
    }

    /*
     * Velocity is a LIVE rate — this ISO week against the trailing four
     * (consumption.ts derives the week keys from the CLOCK, never from the
     * requested period). It therefore describes the window only while the window
     * still reaches `now`; on a June table it would print this week's run-rate
     * under a June header. Outside the live window it is `null` — absent, not a
     * $0 that reads as "quiet".
     */
    const velocityByProject = monthWindow.runsToNow
      ? await fetchProjectVelocities(tx, visibleIds, (id) => {
          // The spike dial is resolved per the PROJECT's owning centre's region
          // (R1 F2 — the subject's region decides the bar, not the viewer's).
          const cou = couById.get(projectCouId.get(id) ?? '')
          return thresholdFor(cou?.region_id ?? couList[0]!.region_id)
        })
      : new Map<string, VelocityState>()

    // Distinct people across each centre's projects (a member on two projects
    // counts once at CC level) — one query for every centre.
    const memberTotals = await tx.execute<{ cou_id: string; members: string; cross: string }>(sql`
      SELECT
        p.cost_owning_unit_id::text AS cou_id,
        COUNT(DISTINCT pa.teammate_id)::text AS members,
        COUNT(DISTINCT pa.teammate_id) FILTER (
          WHERE home.id IS NOT NULL AND home.id IS DISTINCT FROM p.cost_owning_unit_id
        )::text AS cross
      FROM project_assignment pa
      JOIN project p ON p.id = pa.project_id
      JOIN teammate t ON t.id = pa.teammate_id
      JOIN org_unit tou ON tou.id = t.org_unit_id
      LEFT JOIN LATERAL (
        SELECT cou2.id FROM org_unit cou2
        WHERE cou2.path @> tou.path AND cou2.is_cost_owning_unit
          AND cou2.region_id = tou.region_id
        ORDER BY nlevel(cou2.path) DESC LIMIT 1
      ) home ON TRUE
      WHERE p.cost_owning_unit_id = ANY(ARRAY[${sql.join(
        couIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]) AND pa.effective @> now()
      GROUP BY p.cost_owning_unit_id
    `)
    const memberTotalsByCou = new Map([...memberTotals].map((r) => [r.cou_id, r]))

    const cards: CostCentreCard[] = couList.map((cou) => {
      const ccProjects = allProjects.filter((p) => p.cou_id === cou.id)
      const projects: CostCentreProject[] = (visibleByCou.get(cou.id) ?? []).map((m) => {
        const mtd = spendByProject.get(m.id)?.costUsd ?? 0
        const allocation = allocByProject.get(m.id) ?? 0
        const comp = compositionById.get(m.id)
        return {
          id: m.id,
          code: m.code,
          display_name: m.display_name,
          type: m.type,
          wbs_code: m.wbs_code,
          end_date: m.end_date,
          ended: m.ended,
          member_count: Number(comp?.member_count ?? 0),
          cross_cou_member_count: Number(comp?.cross_cou_member_count ?? 0),
          managers: comp?.managers ?? [],
          mtd_cost_usd: mtd.toFixed(2),
          allocation_usd: allocation.toFixed(2),
          utilisation: allocation > 0 ? Number((mtd / allocation).toFixed(4)) : null,
          // MTD arithmetic (spend ÷ day-of-month), so it is quoted ONLY over a
          // current-month month-to-date window — the same rule the reporting
          // cards apply (server/reporting/cost-centres.ts `isCurrentMonth`).
          // Gating on "does the window reach now" instead let a quarter-to-date
          // range be divided by the day of the month and printed as a date.
          projected_exhaustion_date: monthWindow.isMonthToDate
            ? exhaustionDate(mtd, allocation, now)
            : null,
          // null outside the live window (see the velocity note above) — a rate
          // that describes this week must not appear under a past period.
          velocity: monthWindow.runsToNow ? (velocityByProject.get(m.id) ?? ZERO_VELOCITY) : null,
        }
      })

      // Σ over EVERY project of the centre, not just the rendered ones: this is
      // the left-hand side of the burn reconciliation below, and a roll-up that
      // moved with the row cap would break an identity that must always close.
      const omitted = omittedByCou.get(cou.id) ?? { count: 0, costUsd: 0, dormant: 0 }
      const mtdTotal = ccProjects.reduce((s, p) => s + (spendByProject.get(p.id)?.costUsd ?? 0), 0)
      const allocTotal = ccProjects.reduce((s, p) => s + (allocByProject.get(p.id) ?? 0), 0)
      const residual = residualByCou.get(cou.id) ?? zeroCostCentreResidual()
      const totals = memberTotalsByCou.get(cou.id)

      return {
        id: cou.id,
        code: cou.code,
        display_name: cou.display_name,
        region_code: cou.region_code,
        // Every project the centre leads — the rendered rows are a ranked page of
        // them, and `omitted_projects` names the difference.
        project_count: ccProjects.length,
        member_count: Number(totals?.members ?? 0),
        cross_cou_member_count: Number(totals?.cross ?? 0),
        mtd_cost_usd: mtdTotal.toFixed(2),
        allocation_usd: allocTotal.toFixed(2),
        utilisation: allocTotal > 0 ? Number((mtdTotal / allocTotal).toFixed(4)) : null,
        /*
         * THE CARD ADDS UP. `mtd_cost_usd` is Σ of the project rows above; the
         * cost centre's own §A burn is `reconciliation.burn_usd`; and the four
         * terms between them are the whole of the difference:
         *
         *   Σ projects + ingest_only + untagged + foreign_project − off_centre
         *     = burn_usd
         *
         * An earlier cut published two of the four on the grounds that the other
         * two were "about other cost centres' projects, so not this card's
         * story". They are still required arithmetic: with them hidden the card's
         * own numbers did not close (245 + 51 ≠ 278), and an owner checking it
         * against /reports/cost-centres found a gap with no name. Every term a
         * reconciliation needs is published, or the reconciliation is decorative.
         *
         * `member_untagged_usd` sits OUTSIDE that identity on purpose — it is
         * measured on the TEAMMATE axis (spend by people whose home centre is
         * this one, carrying no project claim and no burn home at all), where
         * every other term is measured on the project axis. It is here because
         * it is otherwise money in the estate that appears in no cost centre's
         * anything; it must never be added into the burn.
         */
        reconciliation: {
          burn_usd: residual.burnUsd.toFixed(2),
          ingest_only_usd: residual.ingestOnlyUsd.toFixed(2),
          untagged_usd: residual.untaggedUsd.toFixed(2),
          foreign_project_usd: residual.foreignProjectUsd.toFixed(2),
          off_centre_usd: residual.offCentreUsd.toFixed(2),
          member_untagged_usd: residual.memberUntaggedUsd.toFixed(2),
        },
        projects,
        /*
         * What the rows above do NOT show, so `mtd_cost_usd` still adds up on the
         * card's own face: Σ rendered rows + `omitted_projects.cost_usd` =
         * `mtd_cost_usd`. `dormant_count` is the ended-and-silent subset — held
         * back on relevance, worth nothing, and offered as an expansion rather
         * than deleted from the count.
         */
        omitted_projects: {
          count: omitted.count,
          cost_usd: omitted.costUsd.toFixed(2),
          dormant_count: omitted.dormant,
        },
      }
    })

    return { cost_centres: cards, total: cards.length, window: effectiveWindow }
  })
})
