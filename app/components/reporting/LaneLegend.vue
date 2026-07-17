<script setup lang="ts">
/*
 * LaneLegend — the ONE page-level lane legend per /reporting scope view (and per
 * standalone page): lane-visuals design V1 item 5 (r1-F5, r2-3).
 *
 * CONTRACT: the entries are the UNION of lanes actually rendered by the page's
 * cards THIS period, COMPUTED BY THE SCOPE VIEW/CONTAINER from the card series
 * data it already owns (the container performs every card's fetch; the folded
 * remainder appears as its single "Other surfaces" entry). Cards themselves
 * render NO legends on pages that carry this component. There is deliberately
 * NO provide/inject and no registration mechanism — this component is a passive
 * renderer, so the legend updates atomically with the page's data: no
 * registration timing, no hydration risk, no flicker.
 *
 * Colours are the FIXED per-lane registry colours (vendorLaneColor — colour
 * follows the lane id, never its position); the folded remainder wears the
 * neutral kit hue. Identity is never colour-alone: the swatch sits beside the
 * label, and every chart keeps its tooltips.
 *
 * A single lane renders nothing (dataviz: one series is named by the card
 * title, a one-entry legend is noise).
 */
import { computed } from 'vue'
import { vendorLaneColor, VENDOR_LANE_COLORS } from '../../composables/useChartScale'
import type { Vendor } from '#shared/usage/vendor'
import { FOLDED_LANE_ID } from './charts/fold-lanes'

export interface LaneLegendEntry {
  /** Registry lane id, or the kit's folded-remainder id (`other-lanes`). */
  lane: string
  label: string
}

const props = defineProps<{ lanes: LaneLegendEntry[] }>()

function laneSwatch(lane: string): string {
  if (lane === FOLDED_LANE_ID) return 'var(--carbon-3)'
  if (lane in VENDOR_LANE_COLORS) return vendorLaneColor(lane as Vendor)
  return 'var(--carbon-3)'
}

const entries = computed(() =>
  props.lanes.map((l) => ({ ...l, color: laneSwatch(l.lane) })),
)
</script>

<template>
  <div
    v-if="entries.length >= 2"
    class="flex flex-wrap gap-x-4 gap-y-1.5"
    data-testid="lane-legend"
    role="list"
    aria-label="Lane colour legend"
  >
    <span
      v-for="e in entries"
      :key="e.lane"
      role="listitem"
      class="inline-flex items-center gap-1.5 text-[11px] text-carbon-2"
      :data-testid="`lane-legend-${e.lane}`"
    >
      <span
        class="inline-block w-2 h-2 rounded-sm shrink-0"
        :style="{ background: e.color }"
        aria-hidden="true"
      />
      {{ e.label }}
    </span>
  </div>
</template>
