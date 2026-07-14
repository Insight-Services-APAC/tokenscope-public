<script setup lang="ts">
/*
 * ScopeAcrossRegions — the DATA CONTAINER for the Across-Regions (whole-of-company)
 * FinOps dashboard (build-design §3). Owns the fetches and reads the URL state via
 * useReportState (the sole owner of month + the custom `from`/`to` range), then
 * hands everything to the pure View tree.
 *
 * TWO WINDOWS (deliberately decoupled):
 *   1. The KPI window (`windowQuery`) — the index + month-grained drivers honour
 *      the active window: a custom `[from, to]` range when the DateRangeControl set
 *      one, else `month` (else the server's current-month default). MoM/forecast
 *      come back null for a custom range; the View hides them.
 *   2. The TREND window (`trendWindowQuery`) — the spend trend, active-users trend
 *      and seasonality show a TRAILING ROLLING window (last ~60 days) in month mode
 *      so the first impression is rich, rather than the current month's 3-day
 *      sliver. A custom range overrides it. The in-progress-month forecast tail is
 *      still appended (buildAcrossTrend) so the dashed run-rate continuation shows.
 *
 * DRIVERS window on the ACTIVE period — the SAME window as the KPI index: a custom
 * `[from, to]` range when the DateRangeControl set one, else `month`. The CSV export
 * windows the SAME range, so screen + export stay byte-identical in every mode.
 *
 * This scope is whole-company (global-finops / platform-admin only) — no region/ou
 * state. Selecting a region (ranked bar / driver drill) navigates to the Regional
 * scope for that region via the shared URL state.
 */
import { computed, ref } from 'vue'
import ScopeAcrossRegionsView from './ScopeAcrossRegionsView.vue'
import { useReportState } from '../../composables/useReportState'
import type { AcrossReport, AcrossDriversResp } from './across/across-view-types'
import type { AcrossTrend, Seasonality, ActiveTrend } from '#shared/reports/types'

const rs = useReportState()

// The drivers-table axis is table-local (not URL state). Default to the top-users
// (teammate) read — the region axis would duplicate "Spend by region" directly above.
const axis = ref('teammate')

// Active KPI window: a custom range wins when BOTH bounds are set; else the month
// param (absent ⇒ the endpoints default to the current UTC month).
const windowQuery = computed<Record<string, string>>(() => {
  const q: Record<string, string> = {}
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
function isoUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
function todayMs(): number {
  const n = new Date()
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())
}
function daysAgo(n: number): string {
  return isoUTC(todayMs() - n * 86_400_000)
}
const trendWindowQuery = computed<Record<string, string>>(() => {
  if (rs.from.value && rs.to.value) return { from: rs.from.value, to: rs.to.value }
  return { from: daysAgo(ROLLING_DAYS - 1), to: daysAgo(0) }
})
const trendWindowLabel = computed(() =>
  rs.from.value && rs.to.value
    ? `${rs.from.value} → ${rs.to.value}`
    : `Last ${ROLLING_DAYS} days`,
)

// Drivers window on the SAME active period as the KPI index (windowQuery): a custom
// `[from, to]` range when set, else `month`. No longer month-anchored — the drivers,
// top-models & concentration reflect the FULL selected range (the drivers endpoint
// windows it usage-lane-cleanly, and the CSV export windows the same range).
const driversQuery = computed<Record<string, string>>(() => ({ ...windowQuery.value, axis: axis.value }))
// Top-models is a dedicated always-model-axis fetch, on the same window.
const modelDriversQuery = computed<Record<string, string>>(() => ({ ...windowQuery.value, axis: 'model' }))

const {
  data: report,
  pending,
  error,
} = useFetch<AcrossReport>('/api/v1/reports/across-regions', {
  query: windowQuery,
  key: 'reports-across-regions',
  lazy: true,
  server: false,
})

const { data: trend } = useFetch<AcrossTrend>('/api/v1/reports/across-regions/trend', {
  query: trendWindowQuery,
  key: 'reports-across-regions-trend',
  lazy: true,
  server: false,
})

const { data: seasonality } = useFetch<Seasonality>(
  '/api/v1/reports/across-regions/seasonality',
  { query: trendWindowQuery, key: 'reports-across-regions-seasonality', lazy: true, server: false },
)

const { data: activeTrend } = useFetch<ActiveTrend>(
  '/api/v1/reports/across-regions/active-trend',
  { query: trendWindowQuery, key: 'reports-across-regions-active-trend', lazy: true, server: false },
)

const { data: drivers } = useFetch<AcrossDriversResp>('/api/v1/reports/across-regions/drivers', {
  query: driversQuery,
  key: 'reports-across-regions-drivers',
  lazy: true,
  server: false,
})

const { data: modelDrivers } = useFetch<AcrossDriversResp>(
  '/api/v1/reports/across-regions/drivers',
  { query: modelDriversQuery, key: 'reports-across-regions-model-drivers', lazy: true, server: false },
)

// Export windows the SAME active period as the drivers screen (byte-identical rule).
const exportParams = computed(() => ({
  scope: 'across-regions',
  report: 'drivers',
  axis: axis.value,
  ...windowQuery.value,
}))
const windowSlug = computed(() =>
  rs.from.value && rs.to.value ? `${rs.from.value}_${rs.to.value}` : (rs.month.value ?? 'current'),
)
const exportFilename = computed(
  () => `tokenscope-across-regions-drivers-${axis.value}-${windowSlug.value}.csv`,
)

// Region selected → navigate to the Regional scope for that region (shared URL
// state). The null "Unassigned" bucket has no scope to drill into — ignore it.
function onSelectRegion(regionId: string | null) {
  if (!regionId) return
  rs.patch({ scope: 'regional', region: regionId })
}
</script>

<template>
  <ScopeAcrossRegionsView
    :report="report ?? null"
    :trend="trend ?? null"
    :seasonality="seasonality ?? null"
    :active-trend="activeTrend ?? null"
    :drivers="drivers ?? null"
    :model-drivers="modelDrivers ?? null"
    :pending="pending"
    :error="error"
    :drivers-axis="axis"
    :lane="rs.lane.value"
    :trend-window-label="trendWindowLabel"
    :export-params="exportParams"
    :export-filename="exportFilename"
    @update:drivers-axis="axis = $event"
    @select-region="onSelectRegion"
  />
</template>
