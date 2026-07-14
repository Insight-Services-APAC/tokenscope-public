<script setup lang="ts">
/*
 * ScopeAcrossRegionsView — the whole-of-company FinOps dashboard (build-design §3).
 *
 * PURE + prop-driven (the fetches + URL state live in the ScopeAcrossRegions
 * container), so every render state is unit-testable without a Nuxt runtime.
 * Answers "what is the company on track to spend this period, and who/what is
 * driving it" with the branded chart kit — never hand SVG:
 *
 *   header (title + DateRangeControl + ONE settling indicator)
 *     → hero (forecast headline + KPI tiles, Genuine sparkline)
 *     → provider split (Claude Code vs GitHub Copilot: donut + cards + active-users trend)
 *     → spend trend (rolling window, two vendors, dashed run-rate tail, stacked toggle)
 *     → seasonality heatmap (real day-of-week × week cyclical read)
 *     → spend by region (ranked, click-to-drill)
 *     → top drivers (axis toggle) + top models + concentration
 *
 * Body renders exactly ONE of skeleton / error / empty / data; the header (with
 * the date control) persists across states so the range stays adjustable while a
 * fetch is in flight. Every figure is PROVISIONAL — the settling clock says so.
 */
import { computed } from 'vue'
import UiFetchErrorBanner from '../ui/FetchErrorBanner.vue'
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
import ConcentrationCard, { type ConcentrationStats as CardStats } from './ConcentrationCard.vue'
import AcrossHero from './across/AcrossHero.vue'
import ProviderSplitCard from './across/ProviderSplitCard.vue'
import ActiveUsersTrendCard from './across/ActiveUsersTrendCard.vue'
import SpendTrendCard from './across/SpendTrendCard.vue'
import SeasonalityCard from './across/SeasonalityCard.vue'
import RegionRankCard from './across/RegionRankCard.vue'
import TopDriversCard from './across/TopDriversCard.vue'
import TopModelsCard from './across/TopModelsCard.vue'
import { buildAcrossTrend } from './across/build-trend'
import type { ReportLane } from '../../composables/useReportState'
import type { AcrossReport, AcrossDriversResp } from './across/across-view-types'
import type { AcrossTrend, Seasonality, ActiveTrend, ProviderState } from '#shared/reports/types'

const props = withDefaults(
  defineProps<{
    report: AcrossReport | null
    trend: AcrossTrend | null
    seasonality: Seasonality | null
    activeTrend: ActiveTrend | null
    drivers: AcrossDriversResp | null
    /** The dedicated axis=model drivers response (Top-models card). */
    modelDrivers: AcrossDriversResp | null
    pending: boolean
    error?: unknown
    driversAxis: string
    /** The active lens (§A usage ⇄ §B chargeback) — drives the full re-lens. */
    lane?: ReportLane
    /** Label for the (decoupled) trend/seasonality window — rolling or custom range. */
    trendWindowLabel?: string
    /** Export endpoint params echo the current scope so the CSV matches the screen. */
    exportParams: Record<string, string | number | boolean | null | undefined>
    exportFilename: string
  }>(),
  { error: undefined, lane: 'usage', trendWindowLabel: undefined },
)

// The active lens: chargeback re-lenses money cards to §B and greys / swaps the
// inherently-§A analytics (daily trend / seasonality / provider+model split /
// drivers) for a deliberate "usage-only" placeholder — never a broken empty card.
const isChargeback = computed(() => props.lane === 'chargeback')

const emit = defineEmits<{
  'update:driversAxis': [axis: string]
  /** A region was chosen (ranked bar / driver drill) — navigate to its Regional scope. */
  'select-region': [regionId: string | null]
}>()

// Exactly one of skeleton / error / empty / data (build-design §3).
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

// ── Header meta ──────────────────────────────────────────────────────────────
// ONE consolidated settling indicator: all figures read the §A usage lane, which
// settles on its own clock. Replaces the old per-KPI row of amber chips.
const usageState = computed<ProviderState | null>(
  () => props.report?.meta.providerStates.find((p) => p.vendor === 'usage') ?? null,
)

// ── Trend (+ run-rate projected tail) + Genuine sparkline ────────────────────
// The trend/seasonality/active-users use the decoupled ROLLING window (container),
// but the projected tail is still anchored on the in-progress month's forecast so
// the dashed run-rate continuation lands correctly at month-end.
const built = computed(() =>
  buildAcrossTrend(
    props.trend?.series ?? [],
    props.report?.forecast ?? null,
    props.report?.meta.month ?? null,
  ),
)

// Concentration (from the same drivers lane) — mapped to the shared card's shape.
const concentrationStats = computed<CardStats | null>(() => {
  const c = props.drivers?.concentration
  if (!c) return null
  return {
    top1: c.top1,
    top5: c.top5,
    top10: c.top10,
    segments: c.segments.map((s) => ({ label: s.label, sharePct: s.sharePct, count: s.count })),
  }
})
</script>

<template>
  <div data-testid="scope-across-regions">
    <!-- ── Header (persists across states) ─────────────────────────────────── -->
    <header class="flex items-start justify-between gap-4 flex-wrap mb-6">
      <div class="min-w-0">
        <div class="text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony">
          Reporting · Whole of company
        </div>
        <h2 class="text-2xl font-extrabold tracking-[-0.8px] text-carbon mt-0.5">Across regions</h2>
        <div class="mt-2 flex items-center gap-3 flex-wrap">
          <SettlingStateChip
            v-if="usageState"
            :state="usageState.state"
            :horizon-date="usageState.settlesAt"
            data-testid="across-settling"
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
      headline="Nothing to report across the company for this period yet."
      sub="As sessions and bills land for the selected range, this whole-company view fills in."
    />

    <div v-else-if="showData && report" data-testid="across-data" class="space-y-6">
      <AcrossHero :report="report" :lane="lane" />

      <!-- Provider split / trend / seasonality: the §A usage cards in usage mode, RE-LENSED
           to their §B bill-lane analogue in chargeback mode (the per-teammate bill lane HAS
           the daily / token grain — Anthropic; Copilot is pooled per cost-centre). -->
      <template v-if="!isChargeback">
        <!-- Provider split: donut + per-provider cards + active-users-over-time -->
        <ProviderSplitCard :split="report.providerSplit" :copilot-pending="report.copilot.pending" />
        <ActiveUsersTrendCard :active="activeTrend" :window-label="trendWindowLabel" />

        <SpendTrendCard
          :series="built.series"
          :forecast-from="built.forecastFrom"
          :window-label="trendWindowLabel"
        />

        <SeasonalityCard :seasonality="seasonality" :window-label="trendWindowLabel" />
      </template>
      <template v-else>
        <ChargebackSplitCard :split="report.chargebackProviderSplit" />
        <ChargebackTrendCard :series="trend?.chargeSeries ?? []" :window-label="trendWindowLabel" />
        <ChargebackDowCard :buckets="seasonality?.chargeDow ?? []" :window-label="trendWindowLabel" />
      </template>

      <RegionRankCard
        :cards="report.regionCards"
        :chargeback-rows="report.chargebackByRegion"
        :lane="lane"
        @select="emit('select-region', $event)"
      />

      <!-- Top drivers (axis toggle, default teammate) + top models + concentration —
           all §A usage cuts, so replaced by ONE usage-only placeholder in chargeback mode. -->
      <div v-if="!isChargeback" class="grid grid-cols-1 lg:grid-cols-3 gap-4" data-testid="across-drivers-section">
        <TopDriversCard
          class="lg:col-span-2"
          :drivers="drivers"
          :axis="driversAxis"
          @update:axis="emit('update:driversAxis', $event)"
          @drill="emit('select-region', $event)"
        />
        <div class="space-y-4">
          <TopModelsCard :models="modelDrivers" />
          <ConcentrationCard v-if="concentrationStats" :stats="concentrationStats" />
        </div>
      </div>
      <UsageOnlyCard v-else title="Drivers, top models & concentration" :min-height="160" />

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
