<script setup lang="ts">
/*
 * RegionalSpendTrend — the day-grain spend trend for one region (ChartTrend).
 *
 * Two provider series (Claude Code = brand-hunger MAGENTA, GitHub Copilot =
 * brand-vision blue — the fix for the old StackedBars painting Claude harmony
 * purple) over the selected window. For the in-progress month the builder appends
 * a run-rate tail; the `forecastFrom` boundary makes ChartTrend render it DASHED +
 * muted under the "projected" band. A local Lines ⇄ Stacked toggle flips the
 * series between plain lines and stacked areas (the stacked total reads as the
 * region spend curve). Axis + tooltip use a compact $ format so the scale stays
 * legible.
 *
 * In LINE mode the daily series is drawn faint under a bold 7-DAY TRAILING MEAN
 * (prototype fix 5): spend is a working-week signal, so the raw line is a
 * sawtooth and the eye reads the weekend dips rather than the direction. The
 * chart owns the key line naming the two strokes (it is the only thing that
 * knows whether one was drawn); stacked mode leaves the daily line alone.
 */
import { computed, ref } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartTrend from '../charts/ChartTrend.client.vue'
import LaneSwitchLink from '../LaneSwitchLink.vue'
import { computePeakDay } from '../charts/weekly-lanes'
import { shortDay, TRAILING_MEAN_DAYS } from '../charts/chart-utils'
import { fmtUsd } from '../../../composables/useFormat'
import type { TrendSeries } from './build-regional-trend'

const props = defineProps<{
  series: TrendSeries[]
  /** First projected day; when set the tail renders dashed (in-progress month). */
  forecastFrom?: string
  /** Inclusive window label, e.g. "2026-07-01 → 2026-07-31". */
  windowLabel?: string
}>()

const stacked = ref(false)

// Peak-day chip (iter-2 I4): computed FROM THE CHART'S OWN rendered day series
// (the exact `series` ChartTrend stacks, projected tail excluded — r2-3), so
// the chip and the chart can never disagree. Daily stays TRUE linear scale.
const peakDay = computed(() =>
  computePeakDay(props.series, { excludeFrom: props.forecastFrom }),
)

/** Compact $ for axis/tooltip — region sums can run to thousands. */
function compactUsd(v: number): string {
  const a = Math.abs(v)
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (a >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}
</script>

<template>
  <UiCard data-testid="regional-trend-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-3">
      <div class="min-w-0">
        <div class="text-sm font-semibold text-carbon-1">Spend trend</div>
        <div class="text-[11px] text-carbon-3 truncate">
          Daily attributed usage by provider<template v-if="windowLabel"> · {{ windowLabel }}</template>
        </div>
      </div>

      <div
        class="inline-flex p-0.5 bg-calm-2 rounded-lg gap-0.5 shrink-0"
        role="group"
        aria-label="Trend display mode"
      >
        <button
          type="button"
          class="px-3 py-1 text-[11px] font-semibold rounded-md transition-colors"
          :class="!stacked ? 'bg-white text-brand-harmony shadow-sm' : 'text-carbon-2 hover:text-brand-harmony'"
          :aria-pressed="!stacked"
          data-testid="regional-trend-lines"
          @click="stacked = false"
        >Lines</button>
        <button
          type="button"
          class="px-3 py-1 text-[11px] font-semibold rounded-md transition-colors"
          :class="stacked ? 'bg-white text-brand-harmony shadow-sm' : 'text-carbon-2 hover:text-brand-harmony'"
          :aria-pressed="stacked"
          data-testid="regional-trend-stacked"
          @click="stacked = true"
        >Stacked total</button>
      </div>
    </div>

    <!-- Peak-day chip (iter-2 I4): bound to the chart's OWN day series. -->
    <p
      v-if="peakDay"
      class="mb-2 text-[11px] text-carbon-2"
      data-testid="regional-trend-peak-day"
    >
      Peak day: <b>{{ shortDay(peakDay.day) }}</b> · {{ fmtUsd(peakDay.totalUsd) }}
    </p>

    <ChartTrend
      :series="series"
      :forecast-from="forecastFrom"
      :stacked="stacked"
      :value-format="compactUsd"
      :height="300"
      :trailing-mean-days="TRAILING_MEAN_DAYS"
    />

    <p
      v-if="forecastFrom"
      class="mt-2 text-[11px] text-carbon-3 italic"
      data-testid="regional-trend-projected-note"
    >
      dashed = run-rate projection to month-end
    </p>
    <!-- I5 cross-link: this usage card's §B sibling is the chargeback trend. -->
    <LaneSwitchLink label="See the chargeback trend" />
  </UiCard>
</template>
