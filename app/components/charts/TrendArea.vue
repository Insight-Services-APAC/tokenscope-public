<script setup lang="ts">
/*
 * ChartsTrendArea — daily spend area chart (SVG, no chart dependency,
 * brief §6.6). Sparse day series in; dense padded run rendered. Native
 * title tooltips per day point. Empty window → quiet empty state.
 */
import { computed } from 'vue'
import { niceMax, padDays } from '../../composables/useChartScale'

const props = withDefaults(
  defineProps<{
    series: Array<{ day: string; cost_usd: string }>
    windowDays: number
    height?: number
    /**
     * Format a value (axis tick + point tooltip). Additive — when omitted, the
     * original `$`-prefixed behaviour is preserved exactly (axis: whole dollars
     * ≥ 10 else 2dp; tooltip: 2dp), so existing call sites are unchanged. Pass a
     * formatter to retire the `$` hardwire (e.g. tokens / credits).
     */
    format?: (v: number) => string
  }>(),
  { height: 160, format: undefined },
)

// Defaults reproduce the pre-existing output byte-for-byte per render site.
const fmtAxis = (v: number) =>
  props.format ? props.format(v) : v >= 10 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`
const fmtPoint = (v: number) => (props.format ? props.format(v) : `$${v.toFixed(2)}`)

const W = 720
const PAD = { top: 10, right: 8, bottom: 22, left: 46 }

const dense = computed(() =>
  padDays(
    props.series.map((s) => ({ day: s.day, value: Number(s.cost_usd) })),
    props.windowDays,
    (day) => ({ day, value: 0 }),
  ),
)
const max = computed(() => niceMax(Math.max(...dense.value.map((d) => d.value), 0)))
const hasData = computed(() => dense.value.some((d) => d.value > 0))

const innerW = computed(() => W - PAD.left - PAD.right)
const innerH = computed(() => props.height - PAD.top - PAD.bottom)
const x = (i: number) =>
  PAD.left + (dense.value.length <= 1 ? 0 : (i / (dense.value.length - 1)) * innerW.value)
const y = (v: number) => PAD.top + innerH.value * (1 - v / max.value)

const linePath = computed(() =>
  dense.value.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' '),
)
const areaPath = computed(
  () =>
    `${linePath.value} L${x(dense.value.length - 1).toFixed(1)},${(PAD.top + innerH.value).toFixed(1)} L${PAD.left},${(PAD.top + innerH.value).toFixed(1)} Z`,
)
const gridLines = computed(() => [0.25, 0.5, 0.75, 1].map((f) => ({ f, yv: y(max.value * f) })))
// First-of-window, mid, last labels keep the axis readable at 30 or 90 days
// (deduped — a 1–2 day window must not stack identical labels).
const xLabels = computed(() => {
  const d = dense.value
  if (!d.length) return []
  const idx = [...new Set([0, Math.floor(d.length / 2), d.length - 1])]
  return idx.map((i) => ({ i, label: d[i]!.day.slice(5) }))
})
</script>

<template>
  <div data-testid="trend-area">
    <svg v-if="hasData" :viewBox="`0 0 ${W} ${height}`" class="w-full" role="img" aria-label="Daily spend trend">
      <line
        v-for="g in gridLines"
        :key="g.f"
        :x1="PAD.left" :x2="W - PAD.right" :y1="g.yv" :y2="g.yv"
        stroke="var(--calm-2, #eee)" stroke-width="1"
      />
      <text
        v-for="g in gridLines"
        :key="'t' + g.f"
        :x="PAD.left - 6" :y="g.yv + 3"
        text-anchor="end" class="fill-carbon-3" font-size="9"
      >{{ fmtAxis(max * g.f) }}</text>
      <path :d="areaPath" fill="var(--brand-harmony)" opacity="0.10" />
      <path :d="linePath" fill="none" stroke="var(--brand-harmony)" stroke-width="2" />
      <g v-for="(d, i) in dense" :key="d.day">
        <circle v-if="d.value > 0" :cx="x(i)" :cy="y(d.value)" r="2.5" fill="var(--brand-harmony)">
          <title>{{ d.day }} — {{ fmtPoint(d.value) }}</title>
        </circle>
      </g>
      <text
        v-for="l in xLabels"
        :key="l.i"
        :x="x(l.i)" :y="height - 6"
        text-anchor="middle" class="fill-carbon-3" font-size="9"
      >{{ l.label }}</text>
    </svg>
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center">
      No spend in this window yet — the chart fills in as sessions land.
    </p>
  </div>
</template>
