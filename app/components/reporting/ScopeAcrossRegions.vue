<script setup lang="ts">
/*
 * ScopeAcrossRegions — the DATA CONTAINER for the Region scope's WHOLE-COMPANY
 * width (build-design §3; 04-prototype-delta.md §6). Owns the fetches and reads the
 * URL state via useReportState (the sole owner of month + the custom `from`/`to`
 * range), then hands everything to the pure View tree.
 *
 * It is no longer a scope of its own. `ScopeRegion` mounts it when the region
 * selector is on "All regions", and every request below carries `region=all` — the
 * width, spelled on the wire, so the endpoint routes to `wholeCompanyUsage` rather
 * than inferring an unclamped query from an absent parameter.
 *
 * TWO WINDOWS (deliberately decoupled):
 *   1. The KPI window (`windowQuery`) — the index + month-grained drivers honour
 *      the active window: a custom `[from, to]` range when the DateRangeControl set
 *      one, else `month` (else the server's current-month default). MoM/forecast
 *      come back null for a custom range; the View hides them.
 *   2. The TREND window (`trendWindowQuery`) — the spend trend, active-users trend
 *      show a TRAILING ROLLING window (last ~60 days) in month mode
 *      so the first impression is rich, rather than the current month's 3-day
 *      sliver. A custom range overrides it. The in-progress-month forecast tail is
 *      still appended (buildAcrossTrend) so the dashed run-rate continuation shows.
 *
 * DRIVERS window on the ACTIVE period — the SAME window as the KPI index: a custom
 * `[from, to]` range when the DateRangeControl set one, else `month`. The CSV export
 * windows the SAME range, so screen + export stay byte-identical in every mode.
 *
 * This width is whole-company (the `across` grant) — no `ou` drill, there being
 * nothing to drill within. Selecting a region (the Regions table or the region
 * selector) narrows the SAME scope to that region via the shared URL state. The
 * drivers table no longer offers a region axis and therefore no longer drills:
 * Region has its own card, and one fact needs one home (prototype fix 4a).
 */
import { computed, ref } from 'vue'
import ScopeAcrossRegionsView from './ScopeAcrossRegionsView.vue'
import { monthLabel } from './window-labels'
import { useReportState } from '../../composables/useReportState'
import { rollingTrendWindow } from './trend-window'
import { useDrillGrants, useDrillWindow } from '../../composables/useDrillContract'
import type { AcrossReport, AcrossDriversResp } from './across/across-view-types'
import { ALL_REGIONS, type AcrossTrend, type ActiveTrend } from '#shared/reports/types'
import type { BehaviourReport } from '#shared/reports/behaviour'

const rs = useReportState()

/*
 * THE DRILL CONTRACT's two container-level reads (D29/D30). They live HERE, with
 * every other fetch and URL read on this scope, and travel down as props — the
 * presentational view stays mountable without a Nuxt context, which is the same
 * split every other prop on it already follows.
 */
const drillGrants = useDrillGrants()
const drillWindow = useDrillWindow()

// The drivers-table axis is table-local (not URL state). PROJECT, not teammate:
// the unit of account is the budgeted project (decisions D1), so the whole-company
// view opens on which projects carry the spend — person-level detail is a
// spot-check, never the default. (The region axis DID duplicate the Regions table
// directly above, and the two diverged; it has been retired from the axis set.)
const axis = ref('project')

// Active KPI window: a custom range wins when BOTH bounds are set; else the month
// param (absent ⇒ the endpoints default to the current UTC month).
const windowQuery = computed<Record<string, string>>(() => {
  // `region=all` on EVERY request from this container — it is the width, and the
  // endpoint serves the clamped width when it is absent.
  const q: Record<string, string> = { region: ALL_REGIONS }
  if (rs.from.value && rs.to.value) {
    q.from = rs.from.value
    q.to = rs.to.value
  } else if (rs.month.value) {
    q.month = rs.month.value
  }
  return q
})

// ── Trend window (decoupled) — rolling ~60 days in month mode, else the range ──
const ROLLING_DAYS = 60
/*
 * The rolling band ends at the SERVER's settled edge (F1/D3 + D6). This block
 * and ScopeRegional's used to be byte-identical copies of a browser clock; they
 * now share ONE `rollingTrendWindow`, which is what makes "both trends share an
 * x-extent" a property rather than a coincidence.
 */
const { clock } = useServerClock()
const trendWindowQuery = computed<Record<string, string>>(() => {
  if (rs.from.value && rs.to.value)
    return { region: ALL_REGIONS, from: rs.from.value, to: rs.to.value }
  // No clock yet ⇒ no from/to; the endpoint serves its own default. NEVER a
  // browser-guessed band (see ScopeRegional for the full reasoning).
  if (!clock.value) return { region: ALL_REGIONS } as Record<string, string>
  const band = rollingTrendWindow(clock.value, ROLLING_DAYS)
  return { region: ALL_REGIONS, from: band.from, to: band.to }
})
const trendWindowLabel = computed(() =>
  rs.from.value && rs.to.value
    ? `${rs.from.value} → ${rs.to.value}`
    : `Last ${ROLLING_DAYS} days`,
)

/*
 * The word over the drivers' VALUE column — the period those rows actually cover,
 * from the state that requested them.
 *
 * All three branches are things this container KNOWS, which is the point: the
 * prototype's column reads "this month" because its window is a month, and
 * copying that word down as a constant would have named a month over a custom
 * range. `windowQuery` is the same source, so the header and the fetch cannot
 * disagree — an absent month IS the current UTC month (the endpoint's default).
 */
const driversPeriodLabel = computed(() =>
  rs.from.value && rs.to.value
    ? 'Selected range'
    : rs.month.value
      ? monthLabel(rs.month.value)
      : 'This month',
)

// Drivers window on the SAME active period as the KPI index (windowQuery): a custom
// `[from, to]` range when set, else `month`. No longer month-anchored — the drivers,
// top-models & concentration reflect the FULL selected range (the drivers endpoint
// windows it usage-lane-cleanly, and the CSV export windows the same range).
//
// `lane` rides EVERY drivers request at this width too, for the same reason it
// does at the region width: the endpoint is ONE handler serving both, and a
// toggle that reached the rows on one screen and not the other would be worse
// than one that reached neither — the two widths would disagree about what the
// same lane means.
const driversQuery = computed<Record<string, string>>(() => ({
  ...windowQuery.value,
  axis: axis.value,
  lane: rs.lane.value,
}))
// Top-models is a dedicated always-model-axis fetch, on the same window.
const modelDriversQuery = computed<Record<string, string>>(() => ({
  ...windowQuery.value,
  axis: 'model',
  lane: rs.lane.value,
}))

const {
  data: report,
  pending,
  error,
} = useFetch<AcrossReport>('/api/v1/reports/region', {
  query: windowQuery,
  key: 'reports-across-regions',
  lazy: true,
  server: false,
  // No auto-retry on 5xx (plan D9): ofetch would re-fire the request once with
  // zero backoff, doubling load exactly when the server is struggling. Same on
  // every report fetch on this page.
  retry: false,
})

const { data: trend } = useFetch<AcrossTrend>('/api/v1/reports/region/trend', {
  query: trendWindowQuery,
  key: 'reports-across-regions-trend',
  lazy: true,
  server: false,
  retry: false,
})

/*
 * NO SEASONALITY FETCH. "When spend happens" is deleted (prototype `note('back',
 * …)`: day-of-week seasonality is interesting once, not every week) along with
 * its §B twin, so nothing on this page consumes `/reports/region/seasonality`.
 * The endpoint is left standing — it is still reachable and the CSV export path
 * is untouched — but this page no longer pays a round-trip for a card it does
 * not draw.
 */
const { data: activeTrend } = useFetch<ActiveTrend>(
  '/api/v1/reports/region/active-trend',
  { query: trendWindowQuery, key: 'reports-across-regions-active-trend', lazy: true, server: false, retry: false },
)

const { data: drivers } = useFetch<AcrossDriversResp>('/api/v1/reports/region/drivers', {
  query: driversQuery,
  key: 'reports-across-regions-drivers',
  lazy: true,
  server: false,
  retry: false,
})

// The two BEHAVIOUR cards ride the TREND window, not the KPI one: they are the
// rolling band's cards, and a share metric or a 30-vs-30 delta needs a window
// long enough to hold two halves — which the current month's opening days are not.
// The endpoint is `region/behaviour` post-merge: the Across and Regional pair
// collapsed into one handler exactly as the other paired routes did.
const { data: behaviour } = useFetch<BehaviourReport>(
  '/api/v1/reports/region/behaviour',
  { query: trendWindowQuery, key: 'reports-across-regions-behaviour', lazy: true, server: false, retry: false },
)

const { data: modelDrivers } = useFetch<AcrossDriversResp>(
  '/api/v1/reports/region/drivers',
  { query: modelDriversQuery, key: 'reports-across-regions-model-drivers', lazy: true, server: false, retry: false },
)

// Export windows the SAME active period as the drivers screen (byte-identical rule).
// `region=all` rides in from windowQuery, so the CSV is the same width as the screen.
const exportParams = computed(() => ({
  scope: 'region',
  report: 'drivers',
  axis: axis.value,
  // Part of "byte-identical": without it, exporting from the chargeback view
  // downloads ATTRIBUTED rows for the BILLED table on screen.
  lane: rs.lane.value,
  ...windowQuery.value,
}))
const windowSlug = computed(() =>
  rs.from.value && rs.to.value ? `${rs.from.value}_${rs.to.value}` : (rs.month.value ?? 'current'),
)
const exportFilename = computed(
  () => `tokenscope-across-regions-drivers-${axis.value}-${windowSlug.value}.csv`,
)

/*
 * Region selected → narrow THIS scope to that region (shared URL state). It used to
 * switch `scope` as well, because the region view was a different tab; now the only
 * thing that changes is the width, so the month, the range and the lens all survive
 * the move — which is the point of the merge.
 *
 * The null "Unassigned" bucket has no region to narrow to — ignore it.
 */
function onSelectRegion(regionId: string | null) {
  if (!regionId) return
  rs.patch({ region: regionId })
}

/** The selector's own change event already carries the sentinel or a region id. */
function onRegionChange(regionId: string) {
  rs.patch({ region: regionId || null })
}
</script>

<template>
  <ScopeAcrossRegionsView
    :report="report ?? null"
    :trend="trend ?? null"
    :active-trend="activeTrend ?? null"
    :behaviour="behaviour ?? null"
    :drivers="drivers ?? null"
    :model-drivers="modelDrivers ?? null"
    :pending="pending"
    :error="error"
    :drivers-axis="axis"
    :lane="rs.lane.value"
    :trend-window-label="trendWindowLabel"
    :drivers-period-label="driversPeriodLabel"
    :export-params="exportParams"
    :export-filename="exportFilename"
    :drill-grants="drillGrants"
    :drill-window="drillWindow"
    @update:drivers-axis="axis = $event"
    @update:region="onRegionChange"
    @select-region="onSelectRegion"
  />
</template>
