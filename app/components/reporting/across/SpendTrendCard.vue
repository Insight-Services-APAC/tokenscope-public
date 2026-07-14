<script setup lang="ts">
/*
 * SpendTrendCard — the centrepiece day-grain spend trend (ChartTrend).
 *
 * Two provider series (Claude Code = hunger, Copilot = vision) over the selected
 * window. For the in-progress month the builder appends a run-rate tail; the
 * `forecastFrom` boundary makes ChartTrend render it DASHED + muted under the
 * "projected" band. A local Lines ⇄ Stacked toggle flips the series between plain
 * lines and stacked areas (the stacked total reads as the company spend curve).
 * Axis + tooltip use a compact $ format so the whole-company scale stays legible.
 */
import { ref } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartTrend from '../charts/ChartTrend.client.vue'
import type { TrendSeries } from './build-trend'

defineProps<{
  series: TrendSeries[]
  /** First projected day; when set the tail renders dashed (in-progress month). */
  forecastFrom?: string
  /** Inclusive window label, e.g. "2026-07-01 → 2026-07-31". */
  windowLabel?: string
}>()

const stacked = ref(false)

/** Compact $ for axis/tooltip — whole-company sums run to thousands. */
function compactUsd(v: number): string {
  const a = Math.abs(v)
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (a >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}
</script>

<template>
  <UiCard data-testid="across-trend-card">
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
          data-testid="across-trend-lines"
          @click="stacked = false"
        >Lines</button>
        <button
          type="button"
          class="px-3 py-1 text-[11px] font-semibold rounded-md transition-colors"
          :class="stacked ? 'bg-white text-brand-harmony shadow-sm' : 'text-carbon-2 hover:text-brand-harmony'"
          :aria-pressed="stacked"
          data-testid="across-trend-stacked"
          @click="stacked = true"
        >Stacked total</button>
      </div>
    </div>

    <ChartTrend
      :series="series"
      :forecast-from="forecastFrom"
      :stacked="stacked"
      :value-format="compactUsd"
      :height="300"
    />

    <p
      v-if="forecastFrom"
      class="mt-2 text-[11px] text-carbon-3 italic"
      data-testid="across-trend-projected-note"
    >
      Dashed line (shaded band when stacked) = run-rate projection to month-end — provisional, not a settled figure.
    </p>
  </UiCard>
</template>
