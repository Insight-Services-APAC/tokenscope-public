<script setup lang="ts">
/*
 * ScopeRegional — the DATA CONTAINER for the Regional reporting scope
 * (build-design §3), rebuilt on the reporting chart kit + the wave-B endpoints.
 *
 * Owns every fetch and reads the URL state via useReportState (the sole owner of
 * month + region + ou + the custom `from`/`to` range), then hands everything to
 * the pure ScopeRegionalView tree.
 *
 * WINDOW: all fetches honour the active window — a custom `[from, to]` range when
 * the DateRangeControl set one, else `month` (else the server's current-month
 * default). Forecast/MoM come back null for a custom range; the View hides them.
 *
 * DRIVERS: three axis-fixed cuts so each card is stable and self-contained —
 *   - `drivers`         : the switchable DriversTable (axis = table state)
 *   - `modelDrivers`    : Top-models ranked bar (axis=model)
 *   - `teammateDrivers` : Concentration (axis=teammate) — computed client-side
 *
 * DEFAULT REGION: cross-region viewers (who get a region picker) land on the
 * LARGEST region by spend, not the server's home-or-first (which can be an empty
 * DEMO region). We resolve it once from the whole-company region ranking — the
 * "first non-empty" fallback — and patch the URL.
 *
 * MoM: the Regional endpoint does not (yet) return a month-over-month delta, so we
 * compute it client-side from a prior-month genuine fetch (month mode only). The
 * clean home is a server `momDeltaPct` mirroring Across — see the report notes.
 */
import { computed, ref, watch } from 'vue'
import ScopeRegionalView from './ScopeRegionalView.vue'
import { useReportState } from '../../composables/useReportState'
import { buildConcentration } from './regional/build-concentration'
import type { RegionalReport, RegionalDriversResp, RegionalTrendResp } from './regional/regional-view-types'
import type { ActiveTrend, Seasonality } from '#shared/reports/types'

const rs = useReportState()

// The drivers-table axis is table-local (not URL state). Reset to the teammate
// view on entering/leaving a drill so a stale "practice" axis can't survive it.
const axis = ref('teammate')
watch(
  () => rs.ou.value,
  () => {
    axis.value = 'teammate'
  },
)

// Active window: a custom range wins when BOTH bounds are set; else the month
// param (absent ⇒ the endpoints default to the current UTC month) + region/ou.
const scopeQuery = computed<Record<string, string>>(() => {
  const q: Record<string, string> = {}
  if (rs.from.value && rs.to.value) {
    q.from = rs.from.value
    q.to = rs.to.value
  } else if (rs.month.value) {
    q.month = rs.month.value
  }
  if (rs.region.value) q.region = rs.region.value
  if (rs.ou.value) q.ou = rs.ou.value
  return q
})
// Drivers / top-models / concentration window on the SAME active period + scope as the
// KPI index (scopeQuery): a custom `[from, to]` range when set, else `month`, plus
// region/ou. No longer month-anchored — they reflect the FULL selected range (the
// drivers endpoint windows it usage-lane-cleanly; the CSV export windows the same range).
const driversQuery = computed(() => ({ ...scopeQuery.value, axis: axis.value }))
const modelQuery = computed(() => ({ ...scopeQuery.value, axis: 'model' }))
const teammateQuery = computed(() => ({ ...scopeQuery.value, axis: 'teammate' }))

// ── Trend window (decoupled) — rolling ~60 days in month mode, else the range,
// region/ou-scoped. Mirrors the Across flagship so the trend / active-users /
// seasonality show a rich trailing window instead of the current month's sliver.
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
const trendScopeQuery = computed<Record<string, string>>(() => {
  const q: Record<string, string> =
    rs.from.value && rs.to.value
      ? { from: rs.from.value, to: rs.to.value }
      : { from: daysAgo(ROLLING_DAYS - 1), to: daysAgo(0) }
  if (rs.region.value) q.region = rs.region.value
  if (rs.ou.value) q.ou = rs.ou.value
  return q
})
const trendWindowLabel = computed(() =>
  rs.from.value && rs.to.value ? `${rs.from.value} → ${rs.to.value}` : `Last ${ROLLING_DAYS} days`,
)

const {
  data: report,
  pending,
  error,
} = useFetch<RegionalReport>('/api/v1/reports/regional', {
  query: scopeQuery,
  key: 'reports-regional',
  lazy: true,
  server: false,
})
const { data: drivers } = useFetch<RegionalDriversResp>('/api/v1/reports/regional/drivers', {
  query: driversQuery,
  key: 'reports-regional-drivers',
  lazy: true,
  server: false,
})
const { data: modelDrivers } = useFetch<RegionalDriversResp>('/api/v1/reports/regional/drivers', {
  query: modelQuery,
  key: 'reports-regional-drivers-model',
  lazy: true,
  server: false,
})
const { data: teammateDrivers } = useFetch<RegionalDriversResp>('/api/v1/reports/regional/drivers', {
  query: teammateQuery,
  key: 'reports-regional-drivers-teammate',
  lazy: true,
  server: false,
})
const { data: trend } = useFetch<RegionalTrendResp>('/api/v1/reports/regional/trend', {
  query: trendScopeQuery,
  key: 'reports-regional-trend',
  lazy: true,
  server: false,
})
const { data: activeTrend } = useFetch<ActiveTrend>('/api/v1/reports/regional/active-trend', {
  query: trendScopeQuery,
  key: 'reports-regional-active-trend',
  lazy: true,
  server: false,
})
const { data: seasonality } = useFetch<Seasonality>('/api/v1/reports/regional/seasonality', {
  query: trendScopeQuery,
  key: 'reports-regional-seasonality',
  lazy: true,
  server: false,
})

// Concentration — computed client-side from the axis-stable teammate cut.
const concentration = computed(() =>
  teammateDrivers.value ? buildConcentration(teammateDrivers.value.rows) : null,
)

// ── Default region (largest by spend, not empty DEMO) ────────────────────────
// Only cross-region viewers get a region picker (regionOptions populated); every
// other role is server-forced to their own region, so there is nothing to default.
const autoRegionResolved = ref(false)
watch(
  report,
  async (r) => {
    if (autoRegionResolved.value || !r) return
    if (rs.region.value || r.regionOptions.length === 0) {
      autoRegionResolved.value = true
      return
    }
    autoRegionResolved.value = true
    try {
      // The whole-company region ranking (spend DESC) — same cross-region gate as
      // the picker, so this only ever runs for a viewer allowed to hit it. The top
      // real region is the "largest by spend" / "first non-empty" default.
      const ranking = await $fetch<{ rows: { key: string; usd: number }[] }>(
        '/api/v1/reports/across-regions/drivers',
        { query: { axis: 'region' } },
      )
      const top = ranking.rows.find((row) => row.usd > 0 && !row.key.startsWith('__null'))
      if (top && top.key !== r.region?.id) rs.patch({ region: top.key, ou: null })
    } catch {
      // Ranking unavailable (e.g. not cross-region) — keep the server default.
    }
  },
  { immediate: true },
)

// ── MoM (client-side, month mode only) ───────────────────────────────────────
const momDeltaPct = ref<number | null>(null)
function prevMonthKey(m: string): string {
  const y = Number(m.slice(0, 4))
  const mo = Number(m.slice(5, 7))
  const d = new Date(Date.UTC(y, mo - 1, 1))
  d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
watch(
  () =>
    [
      report.value?.meta.month,
      report.value?.kpis.genuineUsd,
      rs.region.value,
      rs.ou.value,
      rs.from.value,
      rs.to.value,
    ] as const,
  async () => {
    const r = report.value
    // MoM is month-anchored: null in custom-range mode (matches Across hiding it).
    if (!r || (rs.from.value && rs.to.value)) {
      momDeltaPct.value = null
      return
    }
    const prev = prevMonthKey(r.meta.month)
    const regionOu = {
      ...(rs.region.value ? { region: rs.region.value } : {}),
      ...(rs.ou.value ? { ou: rs.ou.value } : {}),
    }
    // Like-for-like PACE: compare this month's data-covered span [monthStart, asOf]
    // to the SAME first-N days of the previous month, N = the data frontier's
    // (meta.asOfDate) day-of-month. IDENTICAL to the Across server-side momPaceWindow
    // (both scopes use the same denominator) — asOf is always inside the viewed
    // month, so a complete month paces to the whole previous month. No asOf (no data)
    // ⇒ no MoM.
    const asOf = r.meta.asOfDate
    if (!asOf) {
      momDeltaPct.value = null
      return
    }
    const asOfDom = Number(asOf.slice(8, 10))
    const prevDaysInMonth = new Date(
      Date.UTC(Number(prev.slice(0, 4)), Number(prev.slice(5, 7)), 0),
    ).getUTCDate()
    const dom = Math.min(asOfDom, prevDaysInMonth)
    const prevQuery: Record<string, string> = {
      from: `${prev}-01`,
      to: `${prev}-${String(dom).padStart(2, '0')}`,
      ...regionOu,
    }
    try {
      const resp = await $fetch<RegionalReport>('/api/v1/reports/regional', { query: prevQuery })
      const prevGenuine = resp.kpis.genuineUsd
      momDeltaPct.value = prevGenuine > 0 ? (r.kpis.genuineUsd - prevGenuine) / prevGenuine : null
    } catch {
      momDeltaPct.value = null
    }
  },
  { immediate: true },
)

// ── Export (byte-identical to the drivers table) ─────────────────────────────
// Windows the SAME active period + scope as the on-screen drivers (scopeQuery), so
// screen == CSV in every mode — month AND custom range.
const exportParams = computed(() => ({
  scope: 'regional',
  report: 'drivers',
  axis: axis.value,
  ...scopeQuery.value,
}))
const windowSlug = computed(() =>
  rs.from.value && rs.to.value ? `${rs.from.value}_${rs.to.value}` : (rs.month.value ?? 'current'),
)
const exportFilename = computed(
  () => `tokenscope-regional-drivers-${axis.value}-${windowSlug.value}.csv`,
)

function onRegion(regionId: string) {
  // Switching region clears any drill (its `ou` belongs to the old region).
  rs.patch({ region: regionId || null, ou: null })
}
</script>

<template>
  <ScopeRegionalView
    :report="report ?? null"
    :drivers="drivers ?? null"
    :model-drivers="modelDrivers ?? null"
    :concentration="concentration"
    :trend="trend ?? null"
    :active-trend="activeTrend ?? null"
    :seasonality="seasonality ?? null"
    :mom-delta-pct="momDeltaPct"
    :lane="rs.lane.value"
    :trend-window-label="trendWindowLabel"
    :pending="pending"
    :error="error"
    :drivers-axis="axis"
    :export-params="exportParams"
    :export-filename="exportFilename"
    @update:region="onRegion"
    @update:drivers-axis="axis = $event"
    @drill="rs.patch({ ou: $event })"
    @clear-drill="rs.patch({ ou: null })"
  />
</template>
