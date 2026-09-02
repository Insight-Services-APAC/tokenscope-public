/*
 * GET /api/v1/me/usage?window=30|90 — the My-usage dashboard
 * payload in ONE fetch (brief §6.4). Thin consumer: every number comes from
 * the consumption/insights read-models over attribution_aggregate, plus the
 * existing getMyUsage quota math. Teammate-scoped via requireAuth +
 * withRequestRls (the 0046 aggregate RLS bridge applies under the
 * non-owner role).
 */
import { consola } from 'consola'
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { WindowQuery } from '../../../../shared/schemas/usage'
import { parseSpendLens } from '../../../../shared/usage/lens'
import { requireAuth } from '../../../auth/rbac'
import { getValidated } from '../../../utils/validated-body'
import { getDb } from '../../../db'
import { withRequestRls } from '../../../db/request-rls'
import { attributionStall } from '../../../usage/attribution-stall'
import {
  getMyProviderFeedFreshness,
  getMyProviderTruthMtd,
  getMyUsage,
  getUnallocatedSummary,
} from '../../../utils/me-queries'
import { buildMeHeadline, buildMeLensDisclosure } from '../../../utils/me-lens'
import {
  fetchDailySeries,
  fetchInsightCellsFromWindow,
  fetchModelSeries,
  fetchProjectAllocations,
  fetchWindowTotals,
} from '../../../usage/consumption'
import { runRate } from '../../../usage/projections'
import { detectFindings, fetchCatalog, fetchRateLines, fetchSignalCells } from '../../../usage/insights'
import { providerStatesForWindow } from '../../../reports/settling'
import { reportCoverageMeta } from '../../../reports/coverage-meta'
import { daysInMonthUtc, monthKeyUtc, monthStartIso, MONTH_REGEX } from '../../../utils/period'
import { DATE_REGEX, momPaceWindow, resolveReportWindow } from '../../../reporting/params'
import { contextWindowResidency } from '../../../usage/context-residency'
import { sessionEconomics } from '../../../usage/session-economics'
import { copilotEngagement } from '../../../usage/copilot-engagement'
import { completeProjectSpend, completeTeammateModelMix } from '../../../usage/complete-spend'
import {
  buildMeHeroTiles,
  dayAxis,
  DELTA_MIN_ELAPSED_DAYS,
  teammateClaudeWindow,
  teammateWindowChargeable,
  teammateWindowDaily,
  teammateWindowDailyForProjects,
  teammateWindowProjects,
  type MeHeroWindowWire,
  type TeammateWindowDaily,
} from '../../../usage/me-usage-window'
import { requestClock } from '../../../utils/request-clock'
import { resolveRollupCoverage, resolveRollupGates } from '../../../usage/rollup-gate'


/** Insight cards shown at once (PO cap — never a wall of advice). */
const MAX_INSIGHTS = 3

/**
 * `?window` (the trailing chart window) plus `?lane` — the ADR 0012 LENS. The
 * lane is coerced rather than rejected: a hand-typed value must not 500 a
 * dashboard, and `usage` is the ADR's default (decision 1).
 *
 * `?month` XOR `?from`/`?to` — the W2 window vocabulary (D16, T13): the hero
 * tiles and every new card resolve their window through `resolveReportWindow`,
 * the same entry point every windowed reporting endpoint uses. `?window` stays
 * the Daily-spend trend card's OWN trailing selector (D18 — kept as built,
 * independent of the presets), and `?lane` stays `usePersonalLens`'s key.
 */
const ConsumptionQuery = WindowQuery.extend({
  lane: z.unknown().optional(),
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
})

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  // getValidated, not h3's getValidatedQuery: a bad `?window` should return the
  // project's RFC-9457 400 with a usable `detail`, not h3's bare
  // "Validation Error". (~10 sibling handlers still use the h3 form; sweeping
  // them is its own change, tracked separately.)
  const parsed = await getValidated(event, ConsumptionQuery)
  const window = parsed.window
  const lane = parseSpendLens(parsed.lane)

  return await withRequestRls(event, async (tx) => {
    /*
     * ONE clock for the whole response, taken BEFORE the first read.
     *
     * `getMyUsage` used to default to its own `new Date()` while the block
     * below took a second one, several awaits later. Two clocks either side of
     * UTC midnight put the two halves of this payload in DIFFERENT MONTHS: the
     * headline and `attributed_usage_usd` come from `usage`, while
     * `declared_personal_usage_usd`, `tool_gaps` and the provider total are
     * computed from `now`. On the 1st that breaks the invariant the disclosure
     * rests on — the declared figure is a subset of the figure above it — in
     * production, while the test that pins it passes, because the test supplies
     * one clock to both.
     *
     * D29: that one clock is now the REQUEST's clock (`requestClock`), not a
     * fresh wall-clock read. Same instant for the whole response as before —
     * plus it is the same instant `/api/v1/clock` ships to the browser, so the
     * hero's "day N of 31" cannot disagree with the axis the charts draw. It is
     * also what lets the parity capture pin a real day 1 on THIS page, which is
     * the surface the month-start spark defect (S4) lives on.
     */
    const now = new Date(requestClock(event).now)
    // Existing quota math (buckets, allowance, activity-tagged spend).
    /*
     * ── W2: the page window (D16/D17, r1-H9) ──────────────────────────────
     * ONE resolved window for the hero tiles, residency, session economics,
     * model panel, Where-it-went and engagement — month XOR from/to, the
     * reporting vocabulary. The SPEND upper bound is clamped to `now`: the
     * current month resolves to a full calendar window, and a clock-skewed
     * future-dated row must not count toward a to-date figure (the
     * monthToDateWindow rule, applied to the resolved window).
     *
     * Resolved BEFORE the gates below, and only so they can be asked together —
     * it is a pure function of the parsed query and the request clock, so
     * nothing about the window changes by computing it a few lines earlier.
     */
    const resolved = resolveReportWindow(
      { month: parsed.month, from: parsed.from, to: parsed.to },
      { now },
    )
    const nowIso = now.toISOString()
    const clampedEnd =
      resolved.endIso <= nowIso ? resolved.endIso : resolved.startIso >= nowIso ? resolved.startIso : nowIso
    const spendWindow = { startIso: resolved.startIso, endIso: clampedEnd }

    /*
     * THE GATES, in TWO round trips instead of six.
     *
     * Coverage — backfill, sweep recency, worker liveness, pending refresh — is
     * a property of the ROLLUP, not of any window, so it is resolved once and
     * handed to both. Currency and the horizon are per-window, and the two
     * windows known at this point are asked in one statement.
     *
     * Still separate GATES, which is the part that matters: coverage is shared,
     * the verdicts are not. getMyUsage windows on month-to-date and the page
     * reads on the resolved window, and late in a month one can sit inside the
     * rollup's 40-day horizon while the other reaches past it. A false OPEN
     * produces wrong money where a false close only costs speed.
     *
     * The previous-period gate cannot join this batch: its window depends on
     * the frontier day the page read has not returned yet.
     */
    const rollupCoverage = await resolveRollupCoverage(tx, nowIso, session.teammateId)
    const mtdStartIso = monthStartIso(now)
    const [mtdGate, rollupGate] = await resolveRollupGates(
      tx,
      rollupCoverage,
      [{ startIso: mtdStartIso, endIso: nowIso }, spendWindow],
      nowIso,
      session.teammateId,
    )
    const usage = await getMyUsage(tx, session.teammateId, now, mtdGate ?? null)

    const today = nowIso.slice(0, 10)
    /** Inclusive day upper bound for the fact/day-grain reads and the sparks. */
    const dayTo = resolved.to <= today ? resolved.to : today
    const currentMonthKey = monthKeyUtc(now)
    const isCurrentMonth = resolved.isMonth && resolved.monthStr === currentMonthKey
    const daysInMonth = resolved.monthRange ? daysInMonthUtc(resolved.monthRange.monthStartUtc) : null
    const daysElapsed = resolved.isMonth ? (isCurrentMonth ? now.getUTCDate() : daysInMonth) : null
    // The quota is a CURRENT-calendar-month measure; any other window states
    // its basis instead of faking a "range quota" (D17).
    const quotaBasis: 'window-month' | 'not-current-month' | 'custom-range' = !resolved.isMonth
      ? 'custom-range'
      : isCurrentMonth
        ? 'window-month'
        : 'not-current-month'

    // Concurrent issuance on ONE tx connection: postgres-js pipelines and
    // answers in order — safe; the win is issuance without
    // per-query await gaps (one wave once statements are prepared on the
    // connection; first use still describes), not true parallelism.
    const [
      series,
      seriesByModel,
      totals,
      insightCells,
      signalCells,
      catalog,
      rateLines,
      acks,
      aggFresh,
      providerTruthMtd,
      providerFeedMinutes,
      coverage,
    ] = await Promise.all([
        fetchDailySeries(tx, 'teammate', session.teammateId, window),
        fetchModelSeries(tx, 'teammate', session.teammateId, window),
        fetchWindowTotals(tx, 'teammate', session.teammateId, window),
        fetchInsightCellsFromWindow(tx, session.teammateId, 28),
        fetchSignalCells(tx, session.teammateId, 28),
        fetchCatalog(tx),
        fetchRateLines(tx),
        tx.execute<{ finding_id: string }>(sql`
          SELECT finding_id FROM insight_ack
          WHERE teammate_id = ${session.teammateId}::uuid
            AND month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
        `),
        // Honesty principle: series/mix lag the ledger by the rollup cadence —
        // surface the aggregate's own freshness alongside the ledger's.
        tx.execute<{ minutes: string | null }>(sql`
          SELECT FLOOR(EXTRACT(EPOCH FROM (now() - MAX(refresh_at))) / 60)::text AS minutes
          FROM attribution_aggregate
          WHERE scope_type = 'teammate' AND scope_id = ${session.teammateId}::uuid
        `),
        // What the PROVIDERS reported for this person this month. Not a
        // headline any more (ADR 0012 decision 1 makes attributed usage the
        // primary quantity everywhere): it is the reconciliation reference the
        // lens disclosure quotes when the two lenses disagree materially.
        // `now` explicitly: this figure is one side of the materiality
        // comparison behind the disclosure, so it has to be on the request's
        // single clock like the attributed side it is compared against.
        getMyProviderTruthMtd(tx, session.teammateId, now),
        // §I3 worst-of-sources freshness: the provider-feed leg.
        getMyProviderFeedFreshness(tx, session.teammateId),
        // W0c D11: the reporting COVERAGE operand for the W1 chip row —
        // persisted-only (never a live probe), same helper the reports-depth
        // composites' `meta` legs use, so the chip renders from real operands
        // rather than re-derived prose.
        reportCoverageMeta(tx),
      ])

    /*
     * ── W2: the window-scoped reads (second wave) ─────────────────────────
     * All on the ONE resolved window above. §A reads the lane; the §B lead
     * tile (chargeback lens only) reads the finance view — never blended.
     */
    /*
     * THE PAGE'S GATE was resolved with month-to-date's above, in one round
     * trip. Every CALLER-SCOPED §A read on this window takes it, so those
     * figures cannot sit on different bases from each other.
     *
     * Caller-scoped is the whole qualification, and it is load-bearing: the
     * proof covers the requesting teammate's rows only. `completeProjectSpend`
     * below spans ALL teammates and therefore takes NO gate — passing this one
     * into it would serve a colleague's stale rows behind a proof that never
     * covered them.
     *
     * Null when coverage is not provable — a stalled worker, an incomplete
     * backfill, a window past the horizon, or a settled day the rollup has not
     * caught up with — and null means the reads behave exactly as they did
     * before this change, because the null branch IS the original query.
     */

    const [currentDaily, windowProjects, residency, econ, modelMix, copilot, claudeWin] =
      await Promise.all([
        teammateWindowDaily(tx, session.teammateId, spendWindow, rollupGate),
        teammateWindowProjects(tx, session.teammateId, spendWindow, rollupGate),
        contextWindowResidency(tx, session.teammateId, { from: resolved.from, to: dayTo }),
        sessionEconomics(tx, session.teammateId, spendWindow),
        completeTeammateModelMix(tx, session.teammateId, spendWindow, rollupGate),
        copilotEngagement(tx, session.teammateId, spendWindow),
        teammateClaudeWindow(
          tx,
          session.teammateId,
          spendWindow,
          { from: resolved.from, to: dayTo },
          rollupGate,
        ),
      ])

    const projectIds = windowProjects.map((p) => p.projectId)
    // The allocation operand the me/projects payloads already carry (D21):
    // current-effective baseline + top-ups per project; absent = no budget set.
    const allocations = await fetchProjectAllocations(tx, projectIds)
    const budgetedIds = projectIds.filter((id) => (allocations.get(id) ?? 0) > 0)
    const budgetedUsd = windowProjects
      .filter((p) => budgetedIds.includes(p.projectId))
      .reduce((a, p) => a + p.mineUsd, 0)
    const taggedUsd = windowProjects.reduce((a, p) => a + p.mineUsd, 0)
    const noBudgetUsd = taggedUsd - budgetedUsd
    // The ONE untagged remainder (D21): window attributed − Σ tagged project
    // spend. Foots by construction — rows + untagged = the window total.
    const untaggedUsd = Math.max(0, currentDaily.totalUsd - taggedUsd)
    /*
     * ── WHAT THE NO-PROJECT REMAINDER IS ACTUALLY MADE OF (r3-M5) ──────────
     *
     * `untaggedUsd` above is a SUBTRACTION — window total minus Σ tagged
     * projects — so it foots by construction and always will. What it is NOT is
     * a worklist: it folds activity-tagged spend (a decision already made),
     * DISMISSED spend (a decision explicitly made to leave it unallocated, mig
     * 0094) and §A arm-3 UNTAGGABLE spend (provider usage with no session and no
     * `unaccounted_usage` row to attach anything to, mig 0101) in with the
     * genuinely-awaiting-a-decision money. Rendered under "Untagged → worklist"
     * that claimed $35 of work owed where the queue held $3.
     *
     * The AUTHORITATIVE four-way split already exists and is the one the queue
     * itself is built from (`getUnallocatedSummary`, me-queries.ts:77-127) — it
     * is re-run here on the RESOLVED window rather than re-derived, so the
     * pull-through figure and the worklist below it can never disagree. Only its
     * money legs are used; `over_soft_cap` is a month-quota verdict and belongs
     * to `usage.unallocated`, not to an arbitrary window.
     */
    const { unallocated: windowNoProject } = await getUnallocatedSummary(
      tx,
      session.teammateId,
      resolved.startIso,
      Number(usage.base_allowance_usd),
      clampedEnd,
    )
    const [projectTotals, budgetedByDay] = await Promise.all([
      /*
       * The PROJECT's own window total — the same figure the PM and the reports
       * project axis see (manager-facing ⇒ excludeProvisional, PM-page rule).
       *
       * NO GATE, deliberately, and it is the only §A read on this page without
       * one. This total spans ALL teammates, and the gate's currency proof is
       * scoped to the CALLER: a colleague's late write or pending re-home
       * cannot close it, so a gated read here would serve their stale rows
       * behind a proof that never covered them. It would also disagree with
       * every other caller of this function — /me/projects, the budget alert,
       * the Business Unit reads — which pass no gate at all.
       *
       * Widening the proof to every contributing teammate is the alternative,
       * and it is the wrong trade: it would close the gate for this reader
       * whenever anyone on any of their projects had a recent write, which on a
       * busy estate is most of the time.
       */
      completeProjectSpend(tx, spendWindow, { projectIds, excludeProvisional: true }),
      teammateWindowDailyForProjects(tx, session.teammateId, spendWindow, budgetedIds, rollupGate),
    ])

    // ── MoM (same-elapsed prior window, paced on the data frontier — D17) ──
    const canMoM =
      resolved.isMonth &&
      resolved.monthRange != null &&
      (daysElapsed ?? 0) >= DELTA_MIN_ELAPSED_DAYS &&
      currentDaily.frontierDay != null
    let previousDaily: TeammateWindowDaily | null = null
    /** null = the previous period was not read at all, so it has no source. */
    let prevSettledSource: 'rollup' | 'view' | null = null
    let prevBudgetedUsd: number | null = null
    let prevWindow: { startIso: string; endIso: string } | null = null
    if (canMoM) {
      prevWindow = momPaceWindow(
        resolved.monthRange!,
        new Date(`${currentDaily.frontierDay}T00:00:00.000Z`),
      )
      /*
       * ITS OWN GATE. The gate above was validated against spendWindow's start,
       * and coverage is a property of the WINDOW, not of the request: late in a
       * current month the page window sits inside the 40-day horizon while the
       * previous-period comparison starts outside it. Reusing the gate there
       * would open the rollup for a range its own contract cannot guarantee —
       * and a false OPEN produces wrong money, where a false close only costs
       * speed.
       */
      const [prevGate] = await resolveRollupGates(
        tx,
        rollupCoverage,
        [prevWindow],
        nowIso,
        session.teammateId,
      )
      const [prevDaily, prevProjects] = await Promise.all([
        teammateWindowDaily(tx, session.teammateId, prevWindow, prevGate),
        teammateWindowProjects(tx, session.teammateId, prevWindow, prevGate),
      ])
      previousDaily = prevDaily
      prevSettledSource = prevGate ? 'rollup' : 'view'
      const prevAllocations = await fetchProjectAllocations(
        tx,
        prevProjects.map((p) => p.projectId),
      )
      prevBudgetedUsd = prevProjects
        .filter((p) => (prevAllocations.get(p.projectId) ?? 0) > 0)
        .reduce((a, p) => a + p.mineUsd, 0)
    }

    // §B lead tile — chargeback lens only; the finance view, never the lane.
    let chargeable: { totalUsd: number; byDay: Map<string, number>; prevTotalUsd: number | null } | undefined
    if (lane === 'chargeback') {
      const cur = await teammateWindowChargeable(tx, session.teammateId, {
        from: resolved.from,
        to: dayTo,
      })
      let prevTotalUsd: number | null = null
      if (prevWindow) {
        const prevBounds = {
          from: prevWindow.startIso.slice(0, 10),
          to: new Date(Date.parse(prevWindow.endIso) - 86_400_000).toISOString().slice(0, 10),
        }
        prevTotalUsd = (await teammateWindowChargeable(tx, session.teammateId, prevBounds)).totalUsd
      }
      chargeable = {
        totalUsd: cur.totalUsd,
        byDay: new Map(cur.days.map((d) => [d.day, d.usd])),
        prevTotalUsd,
      }
    }

    const heroWindow: MeHeroWindowWire = {
      from: resolved.from,
      to: resolved.to,
      is_month: resolved.isMonth,
      month: resolved.monthStr,
      days_elapsed: daysElapsed,
      days_in_month: daysInMonth,
      // The sparks run to `dayTo` = min(window end, today); they end on a
      // still-filling day exactly when that clamp bit.
      spark_partial: dayTo >= today,
    }
    const heroTiles = buildMeHeroTiles({
      lane,
      window: heroWindow,
      current: currentDaily,
      previous: previousDaily,
      budgetedUsd,
      noBudgetUsd,
      untaggedUsd,
      prevBudgetedUsd,
      sparkAxis: dayAxis(resolved.from, dayTo),
      budgetedByDay,
      chargeable,
      quotaBasis,
    })

    const dismissed = new Set([...acks].map((a) => a.finding_id))
    const insights = detectFindings(insightCells, catalog, rateLines, signalCells)
      .filter((f) => !dismissed.has(f.id))
      .slice(0, MAX_INSIGHTS)

    const aggMinutesRaw = [...aggFresh][0]?.minutes
    const aggregateMinutes = aggMinutesRaw == null ? null : Number(aggMinutesRaw)
    // Worst-of-sources page freshness (§I3): the STALEST of telemetry ledger /
    // aggregate rollup / provider feeds — one honest line, not three footnotes.
    const freshnessLegs = [usage.freshness_minutes_ago, aggregateMinutes, providerFeedMinutes]
      .filter((m): m is number => m != null)
    const worstMinutes = freshnessLegs.length ? Math.max(...freshnessLegs) : null

    // ADR 0012 — the page's headline and EVERYTHING derived from it, built
    // together under the selected lens so a quotient can never come from a
    // different lane than the scalar it renders beside (decision 4). `now` is
    // the request's single clock, taken at the top of this handler.
    /*
     * ONE operand, computed once, for BOTH the headline and the disclosure.
     *
     * TOTAL attributed usage — budgeted buckets PLUS unallocated (ADR 0012
     * decision 1a). This is the PATTERNS surface (D7): no budget axis, so no
     * reason to show only the budgeted slice, and a headline reading "your own
     * sessions" over a project-buckets-only figure was false. It is also what
     * makes the quota bar honest rather than merely self-consistent — the
     * denominator is base allowance + allocations, and that allowance IS the
     * allowance for unallocated spend.
     *
     * The DASHBOARD's HEADLINE is still the budgeted figure — its hero renders
     * budgeted and unallocated as two separately labelled halves, which is the
     * timesheet view. Its DISCLOSURE, though, takes this same total, because the
     * provider figure it is compared against covers the whole month across every
     * surface (see server/api/v1/me/home.get.ts). Both surfaces account for the
     * same total; one splits it, one sums it.
     *
     * Hoisted to a single const on purpose. The first version of 1a inlined it
     * at the headline call and left the disclosure on the budgeted figure, so
     * the card described a smaller total than the number above it — decision 4
     * broken by the fix for decision 1a. One binding makes that impossible.
     */
    const totalAttributedUsd = (
      Number(usage.total_cost_usd) + Number(usage.unallocated.total_cost_usd)
    ).toFixed(2)
    const [headline, disclosure] = await Promise.all([
      buildMeHeadline(tx, {
        teammateId: session.teammateId,
        lane,
        /*
         * TOTAL attributed usage — budgeted buckets PLUS unallocated (ADR 0012
         * decision 1a). This surface is the PATTERNS surface (D7): it has no
         * budget axis, so it has no reason to show only the budgeted slice, and
         * a headline reading "your own sessions" over a project-buckets-only
         * figure was simply false.
         *
         * It is also what makes the quota bar honest rather than merely
         * consistent: the denominator is `base allowance + project allocations`,
         * and the allowance IS the allowance for unallocated spend, so a
         * budgeted-only numerator over it was mismatched.
         *
         * The DASHBOARD deliberately passes the budgeted figure instead — its
         * hero renders budgeted and unallocated as two halves, which is the
         * timesheet view. Both surfaces account for the same total; one splits
         * it, one sums it.
         */
        attributedUsageUsd: totalAttributedUsd,
        baseAllowanceUsd: usage.base_allowance_usd,
        allocationUsd: usage.total_allocation_usd,
        quotaUsd: usage.total_quota_usd,
        now,
      }),
      buildMeLensDisclosure(tx, {
        teammateId: session.teammateId,
        // THE SAME operand as the headline. Passing the budgeted figure here
        // while the headline showed budgeted+unallocated made the disclosure
        // describe a smaller total than the number printed above it — the
        // decision-4 defect, reintroduced by the fix for decision 1a.
        attributedUsageUsd: totalAttributedUsd,
        providerReportedUsd: providerTruthMtd,
        now,
        // The MTD gate, so the disclosure sits on the same basis as the
        // headline it explains.
        gate: mtdGate,
      }),
    ])

    /*
     * The §A6.2 degradation-banner leg (additive key only). On the BASE handle,
     * not this RLS tx — the signal is GLOBAL (`instance_attestation` is
     * region-scoped under RLS; a viewer-scoped MAX(last_bearer_at) would give
     * two regions two different verdicts). See server/usage/attribution-stall.ts.
     */
    const attributionStallLeg = await attributionStall(getDb(), { now }).catch((err) => {
      // Additive leg: degrade to no-banner on error rather than failing the
      // page during the very outage the banner reports (the helper assigns
      // never-throws to the caller).
      consola.error('[me/usage] attribution-stall leg failed', err instanceof Error ? err.name : '')
      return null
    })

    return {
      // The ONE headline figure + its own derived statistics (ADR 0012).
      headline,
      /*
       * Why a dollar does or does not reach a cost centre (ADR 0012 decision
       * 5). SHARED — Home reads the same leg through /me/home for its
       * one-line chargeable disclosure, so it stays whole even though the
       * /usage card it also fed is retired: /usage now renders it behind the
       * lane toggle's (i) (MeLensDisclosure `dot`).
       */
      disclosure,
      month: {
        spend_usd: usage.total_cost_usd,
        tokens: usage.total_tokens,
        quota_usd: usage.total_quota_usd,
        base_allowance_usd: usage.base_allowance_usd,
        allocation_usd: usage.total_allocation_usd,
        run_rate: runRate(Number(usage.total_cost_usd), now),
      },
      window_days: window,
      series,
      series_by_model: seriesByModel,
      mix: {
        by_model: totals.by_model,
        by_token_type: totals.by_token_type,
        buckets: usage.buckets,
        tagged_spend: usage.tagged_spend,
        unallocated: usage.unallocated,
      },
      /*
       * D23 (owner ruling 2026-08-04): the `cache` and `aux` legs are RETIRED
       * with their cards — the harness decides both; nothing on either card was
       * a developer action. The detectors (insights.ts), the playbook and the
       * session drawer's own cache/aux sections are NOT touched.
       */
      fidelity: {
        window_cost_usd: totals.cost_usd.toFixed(2),
        advisory_cost_usd: totals.advisory_cost_usd.toFixed(2),
      },
      insights,
      freshness_minutes_ago: usage.freshness_minutes_ago,
      aggregate_refreshed_minutes_ago: aggregateMinutes,
      /*
       * ── W2 (D17): the four ScopeKpiTile operands, window-scoped ──────────
       *
       * D25 (owner ruling 2026-08-05): this used to sit BESIDE a §I3 `hero`
       * leg — the two weekly basis-group stacks behind "What kind of AI work
       * drove this". That card is retired (it answered no question a developer
       * has, and its own caption conceded the two bases could never be summed),
       * so the leg and `getMyConsumptionHero` went with it. `hero_tiles` keeps
       * its name and shape: it is the page's only hero now, and renaming a live
       * wire key to reclaim a retired one buys nothing.
       */
      hero_tiles: { window: heroWindow, tiles: heroTiles },
      /*
       * ── W2: the new card legs, all on the ONE resolved window ────────────
       * Module shapes ride as-is (the providerStates precedent): the client
       * types them, it does not re-derive them.
       */
      // D5/D19 — banded context residency with its reason-typed remainder.
      context_residency: residency,
      // D10/D19 — the OTel-arm session distribution (arm disclosed on the shape).
      session_economics: econ,
      // D20 — the Top-models panel rows + the mix's OWN denominator.
      model_mix: { rows: modelMix.rows, total_usd: modelMix.totalUsd.toFixed(2) },
      // D21 — "Where it went": per-project rows + the ONE untagged remainder.
      where_it_went: {
        total_usd: currentDaily.totalUsd.toFixed(2),
        /** The FOOTING remainder: rows + this = the window total, always. */
        untagged_usd: untaggedUsd.toFixed(2),
        /*
         * …and WHICH STATE that remainder is in (r3-M5). `worklist_usd` is the
         * ONLY leg the worklist pull-through may quote: it is the same predicate
         * the needs-tagging queue is built from. The other three are states the
         * developer is already out of (decided, dismissed) or can never be in
         * (untaggable), and each is shown as its own segment rather than
         * explained in a sentence.
         */
        no_project: {
          worklist_usd: windowNoProject.untagged_cost_usd,
          activity_tagged_usd: windowNoProject.tagged_cost_usd,
          dismissed_usd: windowNoProject.dismissed_cost_usd,
          untaggable_usd: windowNoProject.untaggable_cost_usd,
        },
        rows: windowProjects.map((p) => {
          const alloc = allocations.get(p.projectId)
          return {
            project_id: p.projectId,
            code: p.code,
            display_name: p.displayName,
            mine_usd: p.mineUsd.toFixed(2),
            // The PROJECT's state — the same figure the PM sees (prototype :536).
            project_total_usd: (projectTotals.get(p.projectId)?.costUsd ?? 0).toFixed(2),
            is_member: p.isMember,
            /*
             * Budgets are MONTHLY. Under a month window the cell consumes the
             * current allocation (null = "no budget set"); under a custom
             * range the key is ABSENT — a window-spend-over-monthly-budget
             * quotient would be two different periods in one figure, so the
             * cell renders n/a instead.
             */
            ...(resolved.isMonth
              ? { allocation_usd: alloc != null && alloc > 0 ? alloc.toFixed(2) : null }
              : {}),
          }
        }),
      },
      // D22 — engagement, each provider its OWN vocabulary; empty = null, never zeros.
      engagement: {
        claude:
          econ.sessions > 0 || claudeWin.surfaces.length > 0 || claudeWin.webSearches > 0
            ? {
                sessions: econ.sessions,
                active_days: claudeWin.activeDays,
                web_searches: claudeWin.webSearches,
                surfaces: claudeWin.surfaces.map((s) => ({ tool: s.tool, usd: s.usd.toFixed(2) })),
              }
            : null,
        copilot,
      },
      /*
       * What the PROVIDERS reported for this person (same per-user sources the
       * §A reconciliation reads — never the attribution/window numbers).
       *
       * This was the page's headline MTD scalar. ADR 0012 decision 1 moved the
       * headline to attributed usage on every surface that claims to show your
       * usage, so this figure is now the RECONCILIATION REFERENCE: it is what
       * `disclosure.provider_reported_usd` quotes, and it is what makes the gap
       * between the lenses visible when one exists. It is not rendered as a
       * competing month total.
       */
      provider_truth: {
        month: usage.month_to_date,
        mtd_usd: providerTruthMtd,
        run_rate: runRate(Number(providerTruthMtd), now),
      },
      page_freshness: {
        telemetry_minutes_ago: usage.freshness_minutes_ago,
        aggregate_minutes_ago: aggregateMinutes,
        provider_feed_minutes_ago: providerFeedMinutes,
        worst_minutes_ago: worstMinutes,
        /*
         * WHICH LANE THE SETTLED DAYS CAME FROM. The other legs here answer
         * "how old is the data"; this one answers "where did it come from",
         * and that is a different question an operator needs when a figure
         * looks wrong.
         *
         * 'rollup' means settled days were served from usage_rollup_daily and
         * today from the live view. 'view' means the coverage gate declined —
         * a stalled worker, an incomplete backfill, or a window past the
         * sweep's horizon — and everything came from the view. Both are
         * correct; they differ in cost, not in the answer.
         *
         * PER BASIS, because the gate is resolved per basis and the three can
         * legitimately disagree: the page window, month-to-date and the
         * previous period each carry their own start, and only the start
         * decides the horizon check. A page inside the 40-day sweep can be
         * served from the rollup while the comparison period behind it is not.
         * One value for three answers would be right by luck.
         *
         * `previous_period` is null when no previous period was read.
         */
        settled_source: {
          page: rollupGate ? ('rollup' as const) : ('view' as const),
          month_to_date: mtdGate ? ('rollup' as const) : ('view' as const),
          previous_period: prevSettledSource,
        },
      },
      // §A6.2 — the degradation banner's signal; null = healthy, banner hidden.
      attribution_stall: attributionStallLeg,
      /*
       * ── developer-pages W0c (D11): the reporting freshness operands ────────
       * Real operands for the W1 settlement/coverage chip row (CcHeaderNotes),
       * not re-derived prose. `providerStates` is the pure settling clock for
       * the window this payload's FIGURES describe; `coverage` is the
       * persisted GitHub org-coverage census marker. Both are the exact
       * helpers the reports-depth composites feed their `meta` legs with.
       *
       * THE RESOLVED WINDOW, never `now`'s month (r3-M4). The operands used to
       * be computed for the CURRENT month regardless of `?month`/`?from&to`, so
       * `?month=2026-06` returned June figures under AUGUST settlement chips —
       * a chip that describes a different period than the number beside it is
       * worse than no chip, because it reads as a fact about that number.
       * `providerStatesForWindow` already takes the least-settled month a
       * window spans; it just has to be given the window.
       */
      providerStates: providerStatesForWindow(
        { monthStr: resolved.monthStr, endIso: resolved.endIso },
        now,
      ),
      coverage,
    }
  },
  /*
   * ONE SNAPSHOT for every figure this transaction reads, for the same reason
   * there is one clock above it.
   *
   * This handler proves the rollup is current and then reads the two bases in
   * separate statements. Under READ COMMITTED each statement takes its own
   * snapshot, so a write committing after the proof lands in the view-backed
   * figures and not the split-backed ones — the proof would be true when taken
   * and false when used, which is worse than not proving it. One
   * repeatable-read snapshot makes the proof and every read it authorises
   * describe the same instant.
   *
   * NOT the whole response: the attribution-stall leg deliberately runs on the
   * base handle outside this transaction (it is a global signal RLS would scope
   * per region), so it reads its own snapshot. That is fine and stays fine — it
   * is a banner operand, not a money figure, and nothing foots against it.
   *
   * The trade, stated honestly rather than as "free": no row locks and no
   * change to how long a pooled connection is held, but the request's MVCC
   * snapshot is pinned for its whole duration, which on the slow fallback path
   * is seconds rather than milliseconds, and a pinned snapshot defers dead-tuple
   * reclamation while it is held. Acceptable at this route's volume; worth
   * revisiting if it is ever held much longer. READ-ONLY handlers only — a
   * writer under repeatable read can abort with a serialisation failure, which
   * a read has no way to reach.
   */
  { isolationLevel: 'repeatable read' })
})
