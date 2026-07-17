<script setup lang="ts">
/*
 * RegionalSeasonality — the real day-of-week × week seasonality heatmap for one
 * region (ChartHeatmap).
 *
 * The AEUF-exceed "cyclical" visual: actual usage from v_complete_usage.ts_event,
 * not a synthesised weekday/weekend curve. Intensity is MAGNITUDE, so ChartHeatmap
 * paints a single-hue sequential ramp (light → brand-vision) — never a rainbow.
 * Week labels are the week's Monday date (`DD MMM`, shared with the Across card);
 * the full week + day still show in the tooltip.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartHeatmap from '../charts/ChartHeatmap.client.vue'
import LaneSwitchLink from '../LaneSwitchLink.vue'
import { isoWeekLabel } from '../charts/chart-utils'
import { fmtUsd } from '../../../composables/useFormat'
import type { Seasonality } from '#shared/reports/types'

const props = defineProps<{ seasonality: Seasonality }>()

// Relabel each ISO week `YYYY-Www` to its Monday date (`DD MMM`), identical to the
// Across flagship — the heatmap keys cells by weekIdx so relabelling is safe.
const weeks = computed(() => props.seasonality.weeks.map(isoWeekLabel))
</script>

<template>
  <UiCard data-testid="regional-seasonality">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Seasonality</div>
      <div class="text-[11px] text-carbon-3">Spend by day of week × week · real cyclical pattern</div>
    </div>
    <div class="text-[11px] text-carbon-3 mb-3">Where the region's week actually concentrates — weekday rhythm, not a synthesised curve.</div>

    <ChartHeatmap
      :cells="seasonality.cells"
      :weeks="weeks"
      :value-format="(v) => fmtUsd(v)"
      :height="220"
    />
    <!-- I5 cross-link: this usage card's §B sibling is the chargeback day-of-week card. -->
    <LaneSwitchLink label="See when chargeback happens" />
  </UiCard>
</template>
