<script setup lang="ts">
/*
 * ChartsDonutChart — composition donut with centre label (SVG). Slices in
 * caller order (cost-share desc by convention); palette via shared scale. A
 * slice may pin its own `color` (fixed identity colours, e.g. vendor lanes —
 * a missing slice must not repaint the others); otherwise the indexed palette.
 */
import { computed } from 'vue'
import { seriesColor } from '../../composables/useChartScale'

const props = withDefaults(
  defineProps<{
    slices: Array<{ label: string; value: number; title?: string; color?: string }>
    centerLabel?: string
    centerSub?: string
    size?: number
    /** Accessible name for the chart (role=img needs one — WCAG A). */
    ariaLabel?: string
  }>(),
  { centerLabel: undefined, centerSub: undefined, size: 132, ariaLabel: 'Composition chart' },
)

const R = 60
const STROKE = 18
const C = 2 * Math.PI * R

const total = computed(() => props.slices.reduce((a, s) => a + Math.max(0, s.value), 0))
const arcs = computed(() => {
  let offset = 0
  return props.slices
    .filter((s) => s.value > 0)
    .map((s, i) => {
      const frac = total.value > 0 ? s.value / total.value : 0
      const arc = {
        ...s,
        color: s.color ?? seriesColor(i),
        dash: `${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}`,
        offset: -offset * C,
        frac,
      }
      offset += frac
      return arc
    })
})
</script>

<template>
  <div class="flex items-center gap-4" data-testid="donut-chart">
    <svg v-if="total > 0" :width="size" :height="size" viewBox="0 0 160 160" role="img" :aria-label="ariaLabel">
      <circle cx="80" cy="80" :r="R" fill="none" stroke="var(--calm-2, #eee)" :stroke-width="STROKE" />
      <circle
        v-for="a in arcs"
        :key="a.label"
        cx="80" cy="80" :r="R" fill="none"
        :stroke="a.color" :stroke-width="STROKE"
        :stroke-dasharray="a.dash" :stroke-dashoffset="a.offset"
        transform="rotate(-90 80 80)"
      >
        <title>{{ a.title ?? `${a.label} — ${Math.round(a.frac * 100)}%` }}</title>
      </circle>
      <text x="80" y="78" text-anchor="middle" class="fill-carbon" font-size="16" font-weight="700">
        {{ centerLabel }}
      </text>
      <text x="80" y="94" text-anchor="middle" class="fill-carbon-3" font-size="9">
        {{ centerSub }}
      </text>
    </svg>
    <p v-else class="text-xs text-carbon-3 italic py-6">Nothing here yet.</p>
    <ul v-if="total > 0" class="space-y-1 min-w-0">
      <li v-for="a in arcs" :key="a.label" class="flex items-center gap-1.5 text-[11px] text-carbon-2">
        <span class="inline-block w-2 h-2 rounded-sm shrink-0" :style="{ background: a.color }" aria-hidden="true" />
        <span class="truncate">{{ a.label }}</span>
        <span class="text-carbon-3 shrink-0">{{ Math.round(a.frac * 100) }}%</span>
      </li>
    </ul>
  </div>
</template>
