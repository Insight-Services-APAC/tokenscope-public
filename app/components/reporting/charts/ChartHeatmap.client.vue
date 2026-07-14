<script setup lang="ts">
/*
 * ChartHeatmap — day-of-week × week seasonality heatmap (ECharts, SVG).
 *
 * The "exceed-the-bar" cyclical visual: real weekly seasonality from actual
 * usage, not the cosmetic weekday=1/weekend=0.25 the reference dashboard
 * synthesises. Rows are Mon..Sun (top = Mon via an inverted category axis),
 * columns are weeks. Intensity is MAGNITUDE, so the continuous visualMap is a
 * SINGLE-HUE sequential ramp — a light tint of the magnitude hue (brand-vision)
 * at the low end grading to the full hue at the high end. Never a rainbow.
 *
 * Colours resolve live from brand CSS vars via useChartTheme (readVar /
 * magnitudeColor), so a rebrand or dark theme flows in with no code change —
 * no hardcoded hex except the sibling-kit `|| fallback` idiom for the
 * SSR/missing-token degrade path.
 *
 * Client-only: <VChart> lives inside <ClientOnly> and the file is `.client.vue`,
 * so ECharts never touches `window` during SSR.
 */
import { computed } from 'vue'
import { useChartTheme } from './useChartTheme'
import { escapeHtml } from './chart-utils'

export interface HeatmapCell {
  /** Day of week, 0 = Mon .. 6 = Sun. Maps directly to the (inverted) y-axis. */
  dow: number
  /** Column index into `weeks`. */
  weekIdx: number
  value: number
}

const props = withDefaults(
  defineProps<{
    cells: HeatmapCell[]
    /** x-axis category labels; index === weekIdx (e.g. a week-start 'DD MMM'). */
    weeks: string[]
    /** Tooltip + scale-legend value formatter. Defaults to a plain number. */
    valueFormat?: (v: number) => string
    height?: number
  }>(),
  {
    valueFormat: undefined,
    height: 200,
  },
)

const { baseOption, magnitudeColor, readVar } = useChartTheme()

// Mon-first, matching cell.dow (0 = Mon). The y-axis is inverse so index 0 (Mon)
// sits at the top — the natural reading order for a week.
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

const fmt = (v: number) => (props.valueFormat ? props.valueFormat(v) : String(v))

const maxVal = computed(() => props.cells.reduce((m, c) => Math.max(m, c.value || 0), 0))

// All-zero (or empty) reads as "nothing landed yet" — same convention as the
// sibling charts, which treat an all-zero window as empty rather than a flat grid.
const hasData = computed(() => props.cells.length > 0 && maxVal.value > 0)

const option = computed<ECOption>(() => {
  const surface = readVar('--paper') || '#ffffff'
  const carbon2 = readVar('--carbon-2')
  const carbon3 = readVar('--carbon-3')
  const calm = readVar('--calm')
  const font = readVar('--font-sans')

  // Single-hue sequential ramp: light tint → full magnitude hue. The lite/sheer
  // vision tokens ARE the canonical light tints of brand-vision (magnitudeColor).
  const low = readVar('--brand-vision-sheer') || '#e5f6ff'
  const mid = readVar('--brand-vision-lite') || '#d0e2ff'
  const high = magnitudeColor()
  const max = maxVal.value

  // ECharts heatmap datum: [xIndex, yIndex, value].
  const data = props.cells.map((c) => [c.weekIdx, c.dow, c.value])

  const base = baseOption({ tooltipTrigger: 'item' })

  return {
    ...base,
    // Right margin leaves room for the vertical scale legend.
    grid: { top: 12, right: 52, bottom: 6, left: 8, containLabel: true },
    tooltip: {
      ...(base.tooltip as Record<string, unknown>),
      formatter: (raw: unknown) => {
        const p = raw as { value?: unknown; marker?: string }
        const val = p.value
        if (!Array.isArray(val) || val.length < 3) return ''
        const week = props.weeks[Number(val[0])] ?? ''
        const day = DAY_NAMES[Number(val[1])] ?? ''
        const v = Number(val[2])
        return (
          `${p.marker ?? ''}${escapeHtml(week)} · ${escapeHtml(day)}: ` +
          `<b>${escapeHtml(fmt(v))}</b>`
        )
      },
    },
    // Continuous single-hue scale, recessive on the right rail.
    visualMap: {
      type: 'continuous',
      min: 0,
      max,
      orient: 'vertical',
      right: 8,
      top: 'middle',
      itemWidth: 10,
      itemHeight: 96,
      calculable: false,
      inRange: { color: [low, mid, high] },
      text: [fmt(max), fmt(0)],
      textGap: 6,
      textStyle: { color: carbon3, fontSize: 10, fontFamily: font },
    },
    xAxis: {
      type: 'category',
      data: props.weeks,
      splitArea: { show: false },
      axisLine: { lineStyle: { color: calm } },
      axisTick: { show: false },
      axisLabel: { color: carbon3, fontSize: 10 },
    },
    yAxis: {
      type: 'category',
      data: [...DAY_NAMES],
      inverse: true, // Mon (index 0) at the top
      splitArea: { show: false },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: carbon2, fontSize: 11 },
    },
    series: [
      {
        type: 'heatmap',
        data,
        // Rounded cells with a surface-coloured gap between them.
        itemStyle: { borderColor: surface, borderWidth: 2, borderRadius: 3 },
        emphasis: { itemStyle: { borderColor: carbon3, borderWidth: 2 } },
      },
    ],
  }
})
</script>

<template>
  <ClientOnly>
    <VChart
      v-if="hasData"
      :option="option"
      :style="{ height: `${height}px`, width: '100%' }"
      autoresize
      :aria-label="`Seasonality heatmap — day of week by week, ${weeks.length} weeks`"
      data-testid="chart-heatmap"
    />
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center" data-testid="chart-heatmap-empty">
      No activity in this window yet — the heatmap fills in as sessions land.
    </p>
    <template #fallback>
      <div :style="{ height: `${height}px` }" class="w-full animate-pulse bg-calm-1/40 rounded-lg" />
    </template>
  </ClientOnly>
</template>
