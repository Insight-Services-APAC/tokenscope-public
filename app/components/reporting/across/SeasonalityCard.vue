<script setup lang="ts">
/*
 * SeasonalityCard — "When spend happens" (the AEUF-exceed cyclical visual: REAL
 * day-of-week × week seasonality from actual usage, not the reference dashboard's
 * cosmetic weekday=1/weekend=0.25 synth).
 *
 * Wraps the ChartHeatmap kit component. The endpoint returns ISO-week keys
 * (`YYYY-Www`); we relabel each to its Monday date (`DD MMM`) for a legible x-axis
 * while preserving order (so every cell's `weekIdx` still indexes correctly).
 * Intensity is MAGNITUDE → the kit paints a single-hue sequential ramp (never a
 * rainbow); the value scale is compact $.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartHeatmap from '../charts/ChartHeatmap.client.vue'
import LaneSwitchLink from '../LaneSwitchLink.vue'
import { isoWeekLabel } from '../charts/chart-utils'
import type { Seasonality } from '#shared/reports/types'

const props = defineProps<{
  seasonality: Seasonality | null
  /** Window label echoed in the subtitle (rolling window or custom range). */
  windowLabel?: string
}>()

/** Relabel `YYYY-Www` → `DD MMM` (the week's Monday); fall back to the raw key.
 *  Shared with the Regional seasonality card via the chart-kit helper. */
const weekLabels = computed<string[]>(() => (props.seasonality?.weeks ?? []).map(isoWeekLabel))

const cells = computed(() => props.seasonality?.cells ?? [])

/** Compact $ for the tooltip + scale legend — bucket sums run to thousands. */
function compactUsd(v: number): string {
  const a = Math.abs(v)
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (a >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}
</script>

<template>
  <UiCard data-testid="across-seasonality-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-3">
      <div class="min-w-0">
        <div class="text-sm font-semibold text-carbon-1">When spend happens</div>
        <div class="text-[11px] text-carbon-3 truncate">
          Day-of-week seasonality from actual usage<template v-if="windowLabel"> · {{ windowLabel }}</template>
        </div>
      </div>
    </div>

    <p v-if="!seasonality" class="text-xs text-carbon-3 italic py-8 text-center">Loading seasonality…</p>
    <ChartHeatmap
      v-else
      :cells="cells"
      :weeks="weekLabels"
      :value-format="compactUsd"
      :height="220"
    />
    <!-- I5 cross-link: this usage card's §B sibling is the chargeback day-of-week card. -->
    <LaneSwitchLink label="See when chargeback happens" />
  </UiCard>
</template>
