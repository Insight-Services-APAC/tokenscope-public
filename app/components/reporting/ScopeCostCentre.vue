<script setup lang="ts">
/*
 * ScopeCostCentre — the DATA CONTAINER for the Cost-Centre reporting scope
 * (build-design §3, Wave 3). Owns the fetches (`/reports/cost-centres{,/[ccId]}`)
 * and the URL state (via useReportState — the sole owner of month/cc), then hands
 * everything to the pure ScopeCostCentreView tree. The presentational states +
 * the two distinct on-track mechanics are unit-tested on the view.
 *
 * Fetches are client-only + reactive: the grid refetches on month change; the
 * drill fetches on `cc` / month / axis change (the URL is the source of truth for
 * scope; axis is table-local).
 */
import { computed, ref, watch } from 'vue'
import ScopeCostCentreView from './ScopeCostCentreView.vue'
import { useReportState } from '../../composables/useReportState'
import { useDrillGrants, useDrillWindow } from '../../composables/useDrillContract'
import type { CostCentreReport, CostCentreDrill, CostCentreTrend } from './cost-centre/cost-centre-view-types'
import type { MyCostCentresResponse } from '#shared/schemas/cost-centres'
import { ownerWindowLabel } from './window-labels'
import { rollingTrendWindow } from './trend-window'

const rs = useReportState()

/*
 * THE DRILL CONTRACT's two container-level reads (D29/D30). They live HERE, with
 * every other fetch and URL read on this scope, and travel down as props — the
 * presentational view stays mountable without a Nuxt context, which is the same
 * split every other prop on it already follows.
 */
const drillGrants = useDrillGrants()
const drillWindow = useDrillWindow()

/*
 * NO DRIVERS AXIS STATE, AND THAT IS THE FEATURE.
 *
 * This container used to own `axis = ref('project')` — the one line that decided
 * whether a cost-centre owner opened on budgets or on people. The drill now
 * renders BOTH lists at once (04-prototype-delta.md §5b), so there is no toggle
 * to default and nothing to reset on a cost-centre change. "Budgets first" is
 * now STRUCTURAL: the Budgets hero is the first card in CcDrill's template,
 * which cannot silently revert to a person view the way a ref could.
 *
 * The endpoint keeps its `?axis=` contract for the callers that address a single
 * axis (a script, a saved link, the CSV exports below); the screen simply no
 * longer sends one, and the server default is 'project' either way.
 */

// The grid AND the §A burn DRILL window on the SAME active period: a custom
// `from`/`to` range when present (both win over `month` server-side), else the
// `month`. Keeping them in lock-step means the drill headline reconciles to the
// tracker card burn in EVERY mode (This month / Last month / This quarter / Custom).
function windowParams(): Record<string, string> {
  if (rs.from.value && rs.to.value) return { from: rs.from.value, to: rs.to.value }
  if (rs.month.value) return { month: rs.month.value }
  return {}
}
const gridQuery = computed(windowParams)

const {
  data: report,
  pending,
  error,
} = useFetch<CostCentreReport>('/api/v1/reports/cost-centres', {
  query: gridQuery,
  key: 'reports-cost-centres',
  lazy: true,
  server: false,
  // No auto-retry on 5xx (plan D9) — every report fetch on this page opts out.
  retry: false,
})

/*
 * The P&L-owner view: the projects of the cost centres this viewer OWNS, with
 * their budgets. `/me/cost-centres` has always been able to answer "which project
 * is burning my budget"; its page was deleted at the reporting cutover, leaving
 * the payload unreachable from any browser. It windows on the SAME active period
 * as the grid, so the project table can never quote month-to-date under a header
 * that says June.
 *
 * Ownership is a RELATIONSHIP, not a role: a viewer who owns nothing gets an
 * empty list (200), and the view simply omits the section — no error, no gate.
 * `error`/`pending` are threaded through for exactly that reason: "you own
 * nothing" and "this request failed" both render as no section unless the two are
 * kept apart, so a 500 or an authorisation regression would look like a correct,
 * quiet answer.
 */
const {
  data: owned,
  pending: ownedPending,
  error: ownedError,
} = useFetch<MyCostCentresResponse>('/api/v1/me/cost-centres', {
  query: gridQuery,
  key: 'reports-cost-centres-owned',
  lazy: true,
  server: false,
})

// The window the owner table's figures cover, named on the section. Pure and
// unit-tested in window-labels.ts — the boundary cases (multi-month clamped
// ranges) are expensive to reach through a fetching container.
const ownedWindowLabel = computed(() => ownerWindowLabel(owned.value?.window))

/*
 * ── LANDING SCOPED (F5 D23) ──────────────────────────────────────────────────
 * *"The Cost-centre tab lands ON a cost centre. There is no unscoped state, and
 * never was."* (`R:551-559`.) A reader arriving with no `?cc=` is put on the
 * centre the SERVER resolved for them — their own where they own one — by
 * writing the URL key, so the landing is bookmarkable, shareable and reversible
 * exactly like a click, and every fetch below reacts to it the same way.
 *
 * WHY THE SERVER PICKS, NOT THIS FILE. The choice needs the ownership grant and
 * the visibility clamp, neither of which the browser holds; and
 * `fetchVisibleCostCentres` filters by visibility BEFORE returning, so a client
 * rule would be reasoning about a list it cannot know is complete.
 *
 * THE LANDING IS NOT ONE-SHOT, AND THAT IS THE FIX (external review B1).
 * It used to be: a `landed` ref armed once, plus a crumb that set `cc` to null.
 * Clearing the crumb therefore dropped the reader into the unscoped multi-centre
 * grid — the state the ruling says never existed — and the watcher, already
 * spent, could not put them back. Worse, `CcScopeLine` kept naming the DEFAULT
 * centre there, so the page labelled a scope it was not showing.
 *
 * There is now no clear-to-unscoped path at all (the drill's crumb is a label,
 * not a button), and this watcher is the belt to that braces: ANY way `cc`
 * reaches null with a resolvable default — a hand-edited URL, a stale bookmark,
 * a `?cc=` dropped by a tab switch — re-lands on the server's centre. `patch`
 * uses `router.replace`, so re-landing mints no history entry and a Back press
 * cannot fight it.
 *
 * The unscoped grid remains reachable only where it is honest: a reader for whom
 * the server resolved NO default centre (`defaultCcId` null) has nothing to be
 * scoped to, and `CcScopeLine` says so in words rather than borrowing a name.
 */
watch(
  [() => report.value?.scope?.defaultCcId ?? null, () => rs.cc.value],
  ([defaultCcId, cc]) => {
    if (!defaultCcId || cc) return
    rs.patch({ cc: defaultCcId })
  },
  { immediate: true },
)

// The drill is a per-`cc` resource — fetch imperatively so a null `cc` never fires
// a request to a placeholder id (and a foreign/unowned `cc` surfaces its 403 here).
const drill = ref<CostCentreDrill | null>(null)
const drillPending = ref(false)
const drillError = ref<unknown>(null)
/** Monotonic attempt id — see the guard in the watcher below. */
let drillSeq = 0
watch(
  [() => rs.cc.value, () => rs.month.value, () => rs.from.value, () => rs.to.value],
  async () => {
    /*
     * THE SAME GUARD AS THE BAND BELOW, and for the same three reasons. This
     * watcher had none: a stale success could overwrite the centre the reader is
     * now on, a stale `finally` could clear the new request's pending state
     * early, and the previous centre's hero, tables and EXPORT LINKS stayed on
     * screen under the new centre's header for the whole refetch. Fixing the
     * trend and leaving its sibling racy is how one defect becomes two.
     */
    const seq = ++drillSeq
    const cc = rs.cc.value
    if (!cc) {
      drill.value = null
      drillError.value = null
      drillPending.value = false
      return
    }
    drill.value = null
    drillPending.value = true
    drillError.value = null
    try {
      // No `axis`: the response carries BOTH heroes regardless, and asking for one
      // would imply the screen renders one.
      const q: Record<string, string> = { ...windowParams() }
      const res = await $fetch<CostCentreDrill>(`/api/v1/reports/cost-centres/${cc}`, {
        query: q,
        retry: false,
      })
      if (drillSeq !== seq) return
      drill.value = res
    } catch (e) {
      if (drillSeq !== seq) return
      drillError.value = e
      drill.value = null
    } finally {
      if (drillSeq === seq) drillPending.value = false
    }
  },
  { immediate: true },
)

/*
 * ── BAND 2, the rolling band (prototype parity) ──────────────────────────────
 * Its own window: ~60 days ending at the SERVER's settled edge, from the shared
 * `rollingTrendWindow` the Region scope uses, so both scopes' bands mean the
 * same thing and neither invents a clock. Deliberately NOT the month above it —
 * the band says as much on its face.
 *
 * Fetched imperatively for the same reason the drill is: a null `cc` must never
 * fire a request at a placeholder id, and a foreign id's 403 surfaces here.
 */
const { clock } = useServerClock()
const ROLLING_DAYS = 60
const trend = ref<CostCentreTrend | null>(null)
const trendPending = ref(false)
const trendError = ref<unknown>(null)
/*
 * A MONOTONIC ATTEMPT COUNTER, not a resource key. The first guard here keyed on
 * `${cc}|${from}|${to}`, which identifies the RESOURCE — so A→B→A gave the third
 * request the same identity as the first, and a slow first response could
 * overwrite the third and clear `pending` early. An attempt id is unique by
 * construction and cannot be reused.
 */
let trendSeq = 0
const trendWindow = computed(() =>
  clock.value ? rollingTrendWindow(clock.value, ROLLING_DAYS) : null,
)
/*
 * The REQUESTED band leads, the response is the fallback — and the order is the
 * point, not a detail. Deriving the label only from a successful response left
 * the pending and error states unlabelled, which is when a reader most needs to
 * know which window is being fetched. Response-first would reintroduce that for
 * every state except success, and it also reads as "whatever came back", when
 * the honest label during a fetch is what was asked for.
 */
const trendWindowLabel = computed(() => {
  const w = trendWindow.value ?? trend.value?.window
  return w ? `${w.from} \u2192 ${w.to}` : ''
})
watch(
  [() => rs.cc.value, trendWindow],
  async () => {
    const cc = rs.cc.value
    const band = trendWindow.value
    // Invalidate BEFORE every early return, or an in-flight response can land
    // after the page has been de-scoped and repopulate a band nothing is showing.
    const seq = ++trendSeq
    if (!cc || !band) {
      trend.value = null
      trendError.value = null
      trendPending.value = false
      return
    }
    /*
     * LAST-WRITE-WINS IS NOT GOOD ENOUGH HERE. Switching centres fires a second
     * request while the first is in flight, and whichever resolves LAST paints —
     * so a slow response for the previous centre can land under the current
     * centre's header, with nothing on screen saying the two disagree. Capture
     * the request's identity and discard any answer that is no longer the one
     * being asked for.
     */
    /*
     * CLEAR THE PAYLOAD, not just the error. The band's skeleton shows on
     * `pending && !trend`, so leaving the previous centre's `trend` in place kept
     * its charts on screen under the new centre's header for the whole refetch —
     * a wrong answer that looks like a loaded one.
     */
    trend.value = null
    trendPending.value = true
    trendError.value = null
    try {
      const res = await $fetch<CostCentreTrend>(`/api/v1/reports/cost-centres/${cc}/trend`, {
        query: { from: band.from, to: band.to },
        retry: false,
      })
      if (trendSeq !== seq) return
      trend.value = res
    } catch (e) {
      if (trendSeq !== seq) return
      trendError.value = e
      trend.value = null
    } finally {
      if (trendSeq === seq) trendPending.value = false
    }
  },
  { immediate: true },
)

// Exports window on the SAME active period as the screen (byte-identical rule).
const exportParams = computed(() => ({ scope: 'cost-centre', report: 'cards', ...windowParams() }))
// Range-aware slug so a quarter/custom export names the window (not "current") and
// two different ranges never collide on one filename.
const windowSlug = computed(() =>
  rs.from.value && rs.to.value ? `${rs.from.value}_${rs.to.value}` : (rs.month.value ?? 'current'),
)
const exportFilename = computed(() => `tokenscope-cost-centres-${windowSlug.value}.csv`)

/*
 * One export per HERO — each list is its own answer with its own denominator, so
 * one CSV carrying "the drivers" would have to pick which. The `axis` VALUES are
 * the unchanged wire keys ('project' / 'teammate'), not the labels the screen
 * shows, so the export column and every saved link are untouched by the rename.
 */
function drillExport(axis: 'project' | 'teammate') {
  const p: Record<string, string> = { scope: 'cost-centre', report: 'drivers', axis, ...windowParams() }
  if (rs.cc.value) p.cc = rs.cc.value
  return p
}
const budgetsExportParams = computed(() => drillExport('project'))
const peopleExportParams = computed(() => drillExport('teammate'))
const budgetsExportFilename = computed(
  () => `tokenscope-cost-centre-drivers-project-${windowSlug.value}.csv`,
)
const peopleExportFilename = computed(
  () => `tokenscope-cost-centre-drivers-teammate-${windowSlug.value}.csv`,
)

// The over-the-soft-cap card's own file. Deliberately carries NO `axis`: its
// population is the placed roster, which no drivers axis re-cuts — sending one
// would imply the file changes with the table selection above it, and it does not.
const overSoftCapExportParams = computed(() => {
  const p: Record<string, string> = { scope: 'cost-centre', report: 'over-soft-cap', ...windowParams() }
  if (rs.cc.value) p.cc = rs.cc.value
  return p
})
const overSoftCapExportFilename = computed(
  () => `tokenscope-cost-centre-over-soft-cap-${windowSlug.value}.csv`,
)
</script>

<template>
  <ScopeCostCentreView
    :report="report ?? null"
    :owned="owned?.cost_centres ?? null"
    :owned-window-label="ownedWindowLabel"
    :owned-pending="ownedPending"
    :owned-error="ownedError"
    :drill="drill"
    :is-drill="Boolean(rs.cc.value)"
    :pending="pending"
    :error="error"
    :drill-pending="drillPending"
    :drill-error="drillError"
    :trend="trend"
    :trend-pending="trendPending"
    :trend-error="trendError"
    :trend-window-label="trendWindowLabel"
    :lane="rs.lane.value"
    :export-params="exportParams"
    :export-filename="exportFilename"
    :over-soft-cap-export-params="overSoftCapExportParams"
    :over-soft-cap-export-filename="overSoftCapExportFilename"
    :budgets-export-params="budgetsExportParams"
    :budgets-export-filename="budgetsExportFilename"
    :people-export-params="peopleExportParams"
    :people-export-filename="peopleExportFilename"
    :drill-grants="drillGrants"
    :drill-window="drillWindow"
    @drill="rs.patch({ cc: $event })"
  />
</template>
