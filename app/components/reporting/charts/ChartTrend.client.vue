<script setup lang="ts">
/*
 * ChartTrend — multi-series line / stacked-area over time (ECharts, SVG).
 *
 * Colours key off the DATAVIZ-validated provider split (Claude=hunger,
 * Copilot=vision) via useChartTheme().colorForKey. When `forecastFrom` is set,
 * the trailing segment (x ≥ forecastFrom) renders as a DASHED, muted twin
 * series under a faint "projected" band — the visual grammar for a PROVISIONAL,
 * still-settling figure. One tooltip lists every series at the hovered day.
 *
 * Client-only: the <VChart> lives inside <ClientOnly> and the file is a
 * `.client.vue`, so ECharts never touches `window` during SSR.
 */
import { computed } from 'vue'
import { useChartTheme } from './useChartTheme'
import { categoryUnion, escapeHtml, shortDay } from './chart-utils'

export interface TrendPoint {
  x: string
  y: number
}
export interface TrendSeries {
  /** Legend / tooltip label. */
  name: string
  /** Colour key — a tool code (`claude-code` / `copilot-cli`) or vendor name. */
  key: string
  data: TrendPoint[]
}

const props = withDefaults(
  defineProps<{
    series: TrendSeries[]
    /** First x-value of the projected tail; from here the line goes dashed + muted. */
    forecastFrom?: string
    /** Stack the series as filled areas rather than plain lines. */
    stacked?: boolean
    smooth?: boolean
    /** Tooltip / axis value formatter. Defaults to a plain number. */
    valueFormat?: (v: number) => string
    height?: number
    /**
     * Render the in-chart legend (default, ≥2 series). Pages carrying ONE
     * page-level LaneLegend (lane-visuals V1 item 5 — cards render NO legends
     * there) pass false; identity then lives in the page legend + tooltips.
     */
    legend?: boolean
    /**
     * A run-rate continuation of the TOTAL (lane-visuals V2): rendered as ONE
     * dashed, muted neutral line on top of the (typically stacked) series —
     * the stacked areas end cleanly at the boundary and the tail carries the
     * projection. Its first point should be the last ACTUAL total so the line
     * visually connects. Its x-values extend the category axis.
     */
    totalTail?: TrendPoint[]
  }>(),
  {
    forecastFrom: undefined,
    stacked: false,
    smooth: false,
    valueFormat: undefined,
    height: 260,
    legend: true,
    totalTail: undefined,
  },
)

const { baseOption, colorForKey, readVar } = useChartTheme()

const fmt = (v: number) => (props.valueFormat ? props.valueFormat(v) : String(v))

const categories = computed(() =>
  categoryUnion([...props.series.map((s) => s.data), props.totalTail ?? []]),
)

// Boundary index: first category that is projected (-1 when no forecast).
const forecastIdx = computed(() =>
  props.forecastFrom ? categories.value.indexOf(props.forecastFrom) : -1,
)

const hasData = computed(
  () =>
    props.series.length > 0 &&
    categories.value.length > 0 &&
    props.series.some((s) => s.data.some((p) => p.y > 0)),
)

// Legend only for ≥2 series (dataviz: a single series is named by the title),
// and only when the page has not taken over identity via a page-level LaneLegend.
const showLegend = computed(() => props.legend && props.series.length >= 2)

const option = computed<ECOption>(() => {
  const cats = categories.value
  const fi = forecastIdx.value
  const stacked = props.stacked
  const carbon3 = readVar('--carbon-3')
  const calm2 = readVar('--calm-2')

  const series: NonNullable<ECOption['series']> = []
  let bandPlaced = false

  props.series.forEach((ser) => {
    const color = colorForKey(ser.key)
    const map = new Map(ser.data.map((p) => [p.x, p.y]))
    const aligned = cats.map((c) => (map.has(c) ? (map.get(c) as number) : 0))

    // Solid actual segment (null once projected).
    const actual = aligned.map((v, i) => (fi < 0 || i < fi ? v : null))
    const hasProjection = fi >= 0 && fi < cats.length
    series.push({
      name: ser.name,
      type: 'line',
      data: actual,
      smooth: props.smooth,
      showSymbol: false,
      symbol: 'circle',
      symbolSize: 8,
      connectNulls: false,
      lineStyle: { width: 2, color },
      itemStyle: { color },
      emphasis: { focus: 'series' },
      ...(stacked ? { stack: 'total', areaStyle: { color, opacity: 0.1 } } : {}),
      // Shade the projected region once, on the first series (BOTH modes — in
      // stacked mode this band is the ONLY projection indicator, see below).
      ...(!bandPlaced && hasProjection
        ? {
            markArea: {
              silent: true,
              itemStyle: { color: carbon3, opacity: 0.05 },
              data: [[{ xAxis: cats[fi] as string }, { xAxis: cats[cats.length - 1] as string }]],
            },
          }
        : {}),
    })
    if (!bandPlaced && hasProjection) bandPlaced = true

    // Dashed projected twin — LINE MODE ONLY. It overlaps the last actual point by
    // one so the dashed line visually connects. In STACKED mode a per-vendor twin
    // would either double-count the junction day (shared 'total' stack) or leave a
    // drop-to-zero notch at the boundary (no shared non-null x) — so in stacked mode
    // the projection is shown by the shaded band alone; the actual areas end cleanly
    // at today.
    if (hasProjection && !stacked) {
      const start = Math.max(0, fi - 1)
      const forecast = aligned.map((v, i) => (i >= start ? v : null))
      series.push({
        name: ser.name,
        type: 'line',
        data: forecast,
        smooth: props.smooth,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 2, color, type: 'dashed', opacity: 0.65 },
        itemStyle: { color, opacity: 0.65 },
        emphasis: { focus: 'series' },
      })
    }
  })

  // Run-rate tail on the TOTAL (lane-visuals V2): ONE dashed, muted NEUTRAL line
  // on top of the stack — never a per-lane projection, never a brand hue (it is
  // an annotation of the total, not a lane). Kept out of the legend (legend.data
  // lists the real series only); the tooltip names it on projected days.
  if (props.totalTail?.length) {
    const tailMap = new Map(props.totalTail.map((p) => [p.x, p.y]))
    series.push({
      name: 'Projected total',
      type: 'line',
      data: cats.map((c) => (tailMap.has(c) ? (tailMap.get(c) as number) : null)),
      smooth: props.smooth,
      showSymbol: false,
      connectNulls: false,
      lineStyle: { width: 2, color: carbon3, type: 'dashed', opacity: 0.8 },
      itemStyle: { color: carbon3, opacity: 0.8 },
      emphasis: { focus: 'series' },
    })
  }

  return {
    ...baseOption({ tooltipTrigger: 'axis' }),
    ...(showLegend.value
      ? {
          legend: {
            top: 0,
            icon: 'roundRect',
            itemWidth: 10,
            itemHeight: 3,
            itemGap: 16,
            textStyle: { color: readVar('--carbon-2'), fontSize: 12 },
            // Unique names only — the dashed twins share names, so this dedupes.
            data: props.series.map((s) => s.name),
          },
          grid: { top: 36, right: 16, bottom: 24, left: 16, containLabel: true },
        }
      : {}),
    tooltip: {
      ...(baseOption({ tooltipTrigger: 'axis' }).tooltip as Record<string, unknown>),
      formatter: (raw: unknown) => {
        const arr = (Array.isArray(raw) ? raw : [raw]) as Array<{
          axisValueLabel?: string
          dataIndex?: number
          seriesName?: string
          value?: unknown
          marker?: string
        }>
        if (!arr.length) return ''
        const idx = arr[0]?.dataIndex ?? -1
        const projected = fi >= 0 && idx >= fi
        const head = `${escapeHtml(shortDay(arr[0]?.axisValueLabel ?? ''))}${
          projected ? ' · projected' : ''
        }`
        const seen = new Set<string>()
        const rows: string[] = []
        for (const p of arr) {
          const v = p.value
          if (v == null || typeof v !== 'number') continue
          const name = p.seriesName ?? ''
          if (seen.has(name)) continue
          seen.add(name)
          rows.push(
            `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.6">` +
              `<span>${p.marker ?? ''}${escapeHtml(name)}</span>` +
              `<b>${escapeHtml(fmt(v))}</b></div>`,
          )
        }
        return `<div style="font-weight:600;margin-bottom:4px">${head}</div>${rows.join('')}`
      },
    },
    xAxis: {
      type: 'category',
      data: cats,
      boundaryGap: false,
      axisLine: { lineStyle: { color: readVar('--calm') } },
      axisTick: { show: false },
      axisLabel: { color: carbon3, fontSize: 10, formatter: (v: string) => shortDay(v) },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: carbon3, fontSize: 10, formatter: (v: number) => fmt(v) },
      splitLine: { lineStyle: { color: calm2, width: 1 } },
    },
    series,
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
      :aria-label="`Trend over time — ${series.map((s) => s.name).join(', ')}`"
      data-testid="chart-trend"
    />
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center" data-testid="chart-trend-empty">
      No spend in this window yet — the chart fills in as sessions land.
    </p>
    <template #fallback>
      <div :style="{ height: `${height}px` }" class="w-full animate-pulse bg-calm-1/40 rounded-lg" />
    </template>
  </ClientOnly>
</template>
