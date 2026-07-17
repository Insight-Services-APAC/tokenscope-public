<script setup lang="ts">
/*
 * ScopeRegionalView — the PRESENTATIONAL Regional dashboard, rebuilt to the locked
 * design language + AEUF parity (build-design §3). Region-scoped mirror of the
 * Across-Regions flagship: "how does ONE region use the tools, and who/what drives
 * it?"
 *
 * PURE + prop-driven (the fetches + URL state live in the ScopeRegional
 * container), so every render state is unit-testable. Never hand SVG — the branded
 * chart kit throughout (this also fixes the old bug where Claude rendered harmony
 * PURPLE; the kit paints Claude = brand-hunger MAGENTA, Copilot = brand-vision
 * blue):
 *
 *   header (region picker + DateRangeControl + ONE settling chip)
 *     → hero (forecast headline + KPI tiles, Genuine sparkline, neutral MoM)
 *     → provider split (donut + per-provider cards + active-developers trend)
 *     → spend trend (day-grain, two vendors, dashed run-rate tail, stacked toggle)
 *     → seasonality heatmap (real day-of-week × week cyclical pattern)
 *     → [top-level] spend by practice (magnitude ranked bars, click-to-drill)
 *     → top models + drivers (axis switch) + concentration
 *     → Signals (velocity exceptions, when present)
 *
 * Body renders exactly ONE of skeleton / error / empty / data; the header (with
 * the date control) persists across states so the range stays adjustable while a
 * fetch is in flight. Every figure is PROVISIONAL — the settling chip says so.
 */
import { computed } from 'vue'
import UiFetchErrorBanner from '../ui/FetchErrorBanner.vue'
import UiRegionSelector from '../ui/RegionSelector.vue'
import ReportSkeleton from './ReportSkeleton.vue'
import ReportEmpty from './ReportEmpty.vue'
import DateRangeControl from './DateRangeControl.vue'
import LaneToggle from './LaneToggle.vue'
import UsageOnlyCard from './UsageOnlyCard.vue'
import ChargebackSplitCard from './ChargebackSplitCard.vue'
import ChargebackTrendCard from './ChargebackTrendCard.vue'
import ChargebackDowCard from './ChargebackDowCard.vue'
import SettlingStateChip from './SettlingStateChip.vue'
import ExportCsvButton from './ExportCsvButton.vue'
import DriversTable, { type AxisOption } from './DriversTable.vue'
import ConcentrationCard, { type ConcentrationStats } from './ConcentrationCard.vue'
import UiCard from '../ui/Card.vue'
import LaneLegend from './LaneLegend.vue'
import RegionalHero from './regional/RegionalHero.vue'
import SurfaceHeroCard from './SurfaceHeroCard.vue'
import SurfaceDonutCard from './SurfaceDonutCard.vue'
import ActiveUsersTrendCard from './across/ActiveUsersTrendCard.vue'
import RegionalSpendTrend from './regional/RegionalSpendTrend.vue'
import RegionalSeasonality from './regional/RegionalSeasonality.vue'
import RegionalPracticeRank from './regional/RegionalPracticeRank.vue'
import RegionalChargebackRank from './regional/RegionalChargebackRank.vue'
import RegionalTopModels from './regional/RegionalTopModels.vue'
import RegionalSignals from './regional/RegionalSignals.vue'
import { buildRegionalTrend } from './regional/build-regional-trend'
import { buildSurfaceHero, heroLegendLanes } from './build-surface-hero'
import {
  buildChargebackLaneTrend,
  buildChargebackLaneTrendWeekly,
  buildChargebackDonut,
  chargebackLegendLanes,
} from './build-chargeback-trend'
import type { ReportLane } from '../../composables/useReportState'
import type { RegionalReport, RegionalDriversResp, RegionalTrendResp } from './regional/regional-view-types'
import type { ActiveTrend, Seasonality, ProviderState, DriverRow } from '#shared/reports/types'

const props = withDefaults(
  defineProps<{
    report: RegionalReport | null
    drivers: RegionalDriversResp | null
    modelDrivers: RegionalDriversResp | null
    concentration: ConcentrationStats | null
    trend: RegionalTrendResp | null
    activeTrend: ActiveTrend | null
    seasonality: Seasonality | null
    /** (genuine − prev)/prev fraction (month mode), or null. */
    momDeltaPct: number | null
    /** The active lens (§A usage ⇄ §B chargeback) — drives the full re-lens. */
    lane?: ReportLane
    /** Label for the (rolling) trend window, e.g. "Last 60 days". */
    trendWindowLabel?: string
    pending: boolean
    error?: unknown
    driversAxis: string
    /** The export endpoint params echo the current scope so the CSV matches the screen. */
    exportParams: Record<string, string | number | boolean | null | undefined>
    exportFilename: string
  }>(),
  { error: undefined, lane: 'usage', trendWindowLabel: undefined },
)

// The active lens: chargeback re-lenses the hero + swaps the practice rank for the
// §B chargeback-by-cost-centre ranking, and replaces the inherently-§A analytics
// (provider split / trend / seasonality / drivers / signals) with a "usage-only"
// placeholder — never a broken empty card.
const isChargeback = computed(() => props.lane === 'chargeback')

const emit = defineEmits<{
  'update:region': [regionId: string]
  'update:driversAxis': [axis: string]
  drill: [ouId: string]
  clearDrill: []
}>()

// Exactly one of skeleton / error / empty / data.
const showSkeleton = computed(() => props.pending && !props.report)
const showError = computed(() => Boolean(props.error))
const isEmpty = computed(
  () =>
    Boolean(props.report) &&
    props.report!.kpis.genuineUsd === 0 &&
    props.report!.kpis.chargeableUsd === 0 &&
    props.report!.kpis.activeUsers === 0,
)
const showData = computed(() => Boolean(props.report) && !showError.value && !isEmpty.value)

const drill = computed(() => props.report?.drill ?? null)

// ── Header meta ──────────────────────────────────────────────────────────────
// ONE consolidated settling indicator (the §A usage lane), replacing the old row
// of three per-vendor freshness chips.
const usageState = computed<ProviderState | null>(
  () => props.report?.meta.providerStates.find((p) => p.vendor === 'usage') ?? null,
)

// ── Trend (+ run-rate projected tail) + Genuine sparkline ────────────────────
const built = computed(() =>
  buildRegionalTrend(
    props.trend?.series ?? [],
    props.report?.forecast ?? null,
    props.report?.meta.month ?? null,
  ),
)

// ── Usage-view composition hero + pinned donut (iter-2 I1, regional mirror) ──
// BILLED showback basis (region-clamped server-side), built from the trend
// response's weekly lane cells over its window — the ONE shared window object
// the hero and the donut both bind on (r2-2). `today` identifies the partial
// current week (rendered but excluded from ranking/deltas — r1-F4). It derives
// from SERVER data — the shared window's inclusive `to` (the rolling trend
// window ends on the server's today) — NEVER `new Date()` at setup scope: SSR
// and client hydration could evaluate that across a UTC midnight and disagree
// on the in-progress-week flag (hydration mismatch — iter2 review r1).
const todayUtc = computed(() => props.trend?.window?.to ?? null)
const surfaceHero = computed(() =>
  props.trend?.window
    ? buildSurfaceHero(props.trend.showbackWeeklyLanes ?? [], {
        from: props.trend.window.from,
        to: props.trend.window.to,
        today: props.trend.window.to,
      })
    : null,
)
// The usage page's ONE LaneLegend (V1 item 5): the hero's rendered lanes (the
// donut's lanes are a subset by construction — same fold membership).
const usageLegend = computed(() => heroLegendLanes(surfaceHero.value))

// ── §B chargeback-lane cards + the page-level lane legend (lane-visuals V2-Regional) ─
// The scope view owns every chargeback card's series (the container fetched
// them), so the folded card inputs AND the page legend derive from the SAME
// computed data — atomic with the page's data, no provide/inject, no
// registration timing (V1 item 5, r2-3). The run-rate tail is month-anchored
// exactly like the §A trend: only the in-progress month (forecast non-null)
// projects; the tail's MTD operand itself is §B (the chargeback total series).
const chargebackTailMonth = computed(() =>
  props.report?.forecast && !props.report.meta.range ? props.report.meta.month : null,
)
const chargebackBuilt = computed(() =>
  buildChargebackLaneTrend(
    props.trend?.chargeLanes ?? [],
    props.trend?.chargeSeries ?? [],
    chargebackTailMonth.value,
  ),
)
// The WEEKLY regrouping of the same folded lane series (iter-2 I2/I4) — the
// chargeback trend card's default grain; Σ(weekly) == Σ(daily) by construction.
const chargebackWeekly = computed(() =>
  // Guarded like surfaceHero: a null trend (pre-load / error) must yield null,
  // never feed mondayOf('') — an unguarded computed here threw RangeError
  // (review r2 HIGH).
  props.trend?.window
    ? buildChargebackLaneTrendWeekly(props.trend.chargeLanes ?? [], props.trend.chargeSeries ?? [], todayUtc.value ?? props.trend.window.to)
    : null,
)
const chargebackDonut = computed(() => buildChargebackDonut(props.report?.chargebackLanes ?? []))
// The UNION of lanes the page's chargeback cards actually render this period
// (folded remainder as its single entry) — the ONE page-level legend's input.
const chargebackLegend = computed(() =>
  chargebackLegendLanes([chargebackBuilt.value.laneIds, chargebackDonut.value.laneIds]),
)
// The ONE page-level lane-mode signal (r3-6): both chargeback cards derive
// their mode from THIS (the legend union renders from ≥ 2 lanes — LaneLegend's
// own threshold), never from each card's private, differently-scoped data — so
// a $0-Anthropic / pooled-Copilot month can't leave the trend card on its
// legacy path while the split card renders the lane donut.
const chargebackLaneMode = computed(() => chargebackLegend.value.length >= 2)

function monthLabel(m: string): string {
  const d = new Date(`${m}-01T00:00:00.000Z`)
  return Number.isNaN(d.getTime())
    ? m
    : d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

const windowLabel = computed(() => {
  const meta = props.report?.meta
  if (!meta) return ''
  return meta.range ? `${meta.range.from} → ${meta.range.to}` : monthLabel(meta.month)
})

// ── Drivers table axes ───────────────────────────────────────────────────────
const AXIS_OPTIONS: AxisOption[] = [
  { value: 'practice', label: 'Practice' },
  { value: 'teammate', label: 'Teammate' },
  { value: 'model', label: 'Model' },
  { value: 'project', label: 'Project' },
]
// The drill's DriversTable is the "users" table — no practice-within-a-practice.
const DRILL_AXIS_OPTIONS: AxisOption[] = AXIS_OPTIONS.filter((o) => o.value !== 'practice')

// Only a PRACTICE-axis row carries a real drill target (its key is a cost-owning
// unit id); teammate / model / project have no regional scope to drill into.
function onTableDrill(row: DriverRow) {
  if (
    props.driversAxis === 'practice' &&
    row.key !== 'unattributed' &&
    !row.key.startsWith('__null')
  ) {
    emit('drill', row.key)
  }
}
</script>

<template>
  <div data-testid="scope-regional">
    <!-- ── Header (persists across states) ─────────────────────────────────── -->
    <header class="flex items-start justify-between gap-4 flex-wrap mb-6">
      <div class="min-w-0">
        <div class="text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony">
          Reporting · Regional
        </div>
        <h2 class="text-2xl font-extrabold tracking-[-0.8px] text-carbon mt-0.5">
          {{ report?.region?.displayName ?? 'Regional' }}
        </h2>
        <div class="mt-2 flex items-center gap-3 flex-wrap">
          <UiRegionSelector
            v-if="report && !drill && report.regionOptions.length > 0"
            :model-value="report.region?.id ?? ''"
            :options="report.regionOptions"
            data-testid="regional-region-selector"
            @update:model-value="emit('update:region', $event)"
          />
          <SettlingStateChip
            v-if="usageState"
            :state="usageState.state"
            :horizon-date="usageState.settlesAt"
            data-testid="regional-settling"
          />
          <span
            v-if="report?.meta.pointInTimeDims"
            class="text-[11px] text-carbon-3 italic"
          >Usage dimensions as at emit (point-in-time)</span>
        </div>
      </div>

      <div class="flex items-start gap-4 flex-wrap shrink-0">
        <LaneToggle />
        <DateRangeControl />
      </div>
    </header>

    <!-- ── Body: exactly one of skeleton / error / empty / data ────────────── -->
    <ReportSkeleton v-if="showSkeleton" :kpis="6" />

    <UiFetchErrorBanner v-else-if="showError" :error="error" />

    <ReportEmpty
      v-else-if="isEmpty"
      headline="Nothing to report for this region and period yet."
      sub="As sessions and bills land for the selected range, this regional view fills in."
    />

    <div v-else-if="showData && report" data-testid="regional-data" class="space-y-6">
      <!-- Drill breadcrumb (practice) -->
      <nav
        v-if="drill"
        class="text-[12px] text-carbon-3"
        aria-label="Breadcrumb"
        data-testid="regional-drill-crumb"
      >
        <button type="button" class="hover:text-brand-harmony hover:underline" @click="emit('clearDrill')">
          {{ report.region?.displayName ?? 'Region' }}
        </button>
        <span class="mx-1.5">›</span>
        <span class="text-carbon-1 font-semibold">{{ drill.displayName }}</span>
      </nav>

      <RegionalHero :report="report" :lane="lane" :mom-delta-pct="momDeltaPct" />

      <!-- Provider split / trend / seasonality: the §A usage cards in usage mode, RE-LENSED
           to their §B bill-lane analogue in chargeback mode (per-teammate Anthropic bill;
           Copilot is pooled per cost-centre). -->
      <template v-if="!isChargeback">
        <!-- ONE page-level lane legend for the billed-basis hero + donut
             (iter-2 I1, V1 item 5) — the cards render no legends. -->
        <LaneLegend :lanes="usageLegend" />
        <!-- Composition hero (I1): billed showback, weekly, $ + 100%-share. -->
        <SurfaceHeroCard :built="surfaceHero" :window-label="trendWindowLabel ?? windowLabel" />
        <!-- The billed surface donut REPLACES the old §A provider donut (I1);
             attributed provider figures live ONLY in the §A KPI strip above. -->
        <SurfaceDonutCard
          :donut="surfaceHero?.donut ?? null"
          :window-label="trendWindowLabel ?? windowLabel"
        />

        <ActiveUsersTrendCard :active="activeTrend" :window-label="trendWindowLabel ?? windowLabel" />

        <RegionalSpendTrend
          :series="built.series"
          :forecast-from="built.forecastFrom"
          :window-label="trendWindowLabel ?? windowLabel"
        />

        <RegionalSeasonality v-if="seasonality" :seasonality="seasonality" />
      </template>
      <template v-else>
        <!-- ONE page-level lane legend for the chargeback cards (V1 item 5) —
             cards render no legends; identity = this legend + card tooltips. -->
        <LaneLegend :lanes="chargebackLegend" />
        <ChargebackSplitCard
          :split="report.chargebackProviderSplit"
          :donut="chargebackDonut"
          :lane-mode="chargebackLaneMode"
        />
        <ChargebackTrendCard
          :series="trend?.chargeSeries ?? []"
          :built="chargebackBuilt"
          :built-weekly="chargebackWeekly"
          :lane-mode="chargebackLaneMode"
          :window-label="trendWindowLabel ?? windowLabel"
        />
      </template>

      <!-- Rank card (top-level only; the drill is already inside a practice): the §A
           practice ranking in usage mode ⇄ the §B chargeback-by-cost-centre ranking. -->
      <template v-if="!drill">
        <RegionalPracticeRank
          v-if="!isChargeback && report.practices.length"
          :practices="report.practices"
          @select="emit('drill', $event)"
        />
        <RegionalChargebackRank
          v-else-if="isChargeback"
          :rows="report.chargebackByCostCentre"
        />
      </template>

      <!-- DoW card DEMOTED below the rankings (iter-2 I2) — still chargeback-only. -->
      <ChargebackDowCard
        v-if="isChargeback"
        :buckets="seasonality?.chargeDow ?? []"
        :window-label="trendWindowLabel ?? windowLabel"
      />

      <!-- Top models + drivers + concentration — all §A usage cuts. Replaced by one
           usage-only placeholder in chargeback mode. -->
      <div v-if="!isChargeback" class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div class="lg:col-span-2 space-y-4">
          <RegionalTopModels :rows="modelDrivers ? modelDrivers.rows : null" />

          <UiCard>
            <div class="text-sm font-semibold text-carbon-1 mb-3">{{ drill ? 'Users' : 'Drivers' }}</div>
            <DriversTable
              v-if="drivers"
              :rows="drivers.rows"
              :headline-usd="drivers.headlineUsd"
              :axis="driversAxis"
              :axis-options="drill ? DRILL_AXIS_OPTIONS : AXIS_OPTIONS"
              :denominator-label="drill ? 'practice usage' : 'region usage'"
              @update:axis="emit('update:driversAxis', $event)"
              @drill="onTableDrill"
            />
            <p v-else class="text-xs text-carbon-3 italic py-8 text-center">Loading drivers…</p>
          </UiCard>
        </div>

        <ConcentrationCard v-if="concentration" :stats="concentration" />
      </div>
      <UsageOnlyCard v-else title="Top models, drivers & concentration" :min-height="160" />

      <RegionalSignals
        v-if="!isChargeback && report.exceptions.length"
        :exceptions="report.exceptions"
        :velocity-threshold="report.velocityThreshold"
      />

      <!-- Export -->
      <div class="flex justify-end pt-2">
        <ExportCsvButton
          endpoint="/api/v1/reports/export"
          :params="exportParams"
          :filename="exportFilename"
        />
      </div>
    </div>
  </div>
</template>
