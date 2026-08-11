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
import { categoryUnion, escapeHtml, shortDay, trailingMean } from './chart-utils'

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
  /**
   * An explicit colour, for series whose `key` is NOT an identity the vendor
   * registry knows — model-tier bands, for one, which are an ORDINAL scale
   * rather than a lane. `colorForKey` would resolve every one of them to the
   * same neutral "other" hue and the chart would render six indistinguishable
   * areas.
   *
   * Still the token, never a hex: callers resolve it through
   * `useChartTheme().readVar`, so a rebrand or a dark theme flows in exactly as
   * it does for the keyed path. Absent ⇒ `colorForKey(key)`, unchanged.
   */
  color?: string
  /**
   * A PRE-COMPUTED smoothed line for this series, for the cases where the plain
   * trailing mean of `data` would be the wrong statistic. Only ever read when
   * `trailingMeanDays` is on; absent ⇒ the chart takes the trailing mean of the
   * series' own points, which is right for a level (dollars, headcount).
   *
   * It exists for RATIO series: spend-per-active-developer holds no value on a
   * day nobody was active, so its week average is Σnumerator ÷ Σdenominator
   * (chart-utils `trailingRatioMean`) and only the card holds both sides. The
   * points are matched by x, so a mean that skips a day leaves a gap here too.
   */
  mean?: TrendPoint[]
}

const props = withDefaults(
  defineProps<{
    series: TrendSeries[]
    /**
     * Empty-state sentence. Additive — omitted keeps the original wording
     * byte-for-byte, so no existing call site moves.
     *
     * Pass one wherever the chart does not measure SPEND, or measures a subset
     * of it. The default says "no spend in this window yet … as sessions land",
     * which on the active-developer chart was false twice over: that chart
     * counts PEOPLE, not money, and it counts them in the `claude-code` /
     * `copilot-cli` lanes only — so on a cost centre whose spend is Claude Chat
     * and the coding agent it printed "no spend" directly above a spend trend
     * showing spend over the same window. `TrendArea` carries the identical prop
     * for the identical reason.
     */
    emptyLabel?: string
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
    /**
     * Draw an N-day TRAILING MEAN bold on top of each series, with the daily
     * line kept faint underneath (prototype fix 5). Pass 7 for the weekday
     * cycle — see `trailingMean` in chart-utils for why seven and not five.
     *
     * The daily line STAYS. The dips are real and worth seeing; the bold line
     * is the answer to "is this going up", which the sawtooth was hiding.
     *
     * IGNORED IN STACKED MODE, deliberately. Stacked areas answer composition,
     * and a mean line over a stack belongs to no band in it — there would be
     * nothing on screen saying which series the bold line was the mean OF.
     */
    trailingMeanDays?: number
  }>(),
  {
    forecastFrom: undefined,
    stacked: false,
    smooth: false,
    valueFormat: undefined,
    height: 260,
    legend: true,
    totalTail: undefined,
    trailingMeanDays: 0,
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

// Stacked mode has no honest place for a mean line (see the prop's doc).
const meanDays = computed(() =>
  !props.stacked && props.trailingMeanDays >= 2 ? props.trailingMeanDays : 0,
)

/**
 * The trailing-mean line per series, or `null` for a series that has none.
 *
 * SEPARATE FROM `option` so ONE decision drives all three things that depend on
 * it: the bold stroke, the demotion of the daily line under it, and the key line
 * naming the two strokes. Deriving the key from anything else — a card counting
 * days, say — is how a caption comes to describe a picture that is not there.
 *
 * A window shorter than the mean's own — a young tenant, a narrow custom range, a
 * scope where only a handful of days carry spend — yields all nulls, correctly:
 * no point has a full week behind it. That series gets `null` here, so its daily
 * line keeps full weight and no key is printed. Demoting a line to a hairline
 * under an ABSENT bold one would hand that reader a fainter chart in exchange for
 * nothing.
 *
 * Computed from the ACTUAL segment, not the aligned one: the projected tail is
 * null there, so the mean stops at the forecast boundary rather than averaging a
 * run-rate the reader is being shown as a projection.
 */
const meanByIndex = computed<Array<Array<number | null> | null>>(() => {
  const w = meanDays.value
  if (!w) return props.series.map(() => null)
  const cats = categories.value
  const fi = forecastIdx.value
  return props.series.map((ser) => {
    const map = new Map(ser.data.map((p) => [p.x, p.y]))
    const actual = cats.map((c, i) =>
      fi >= 0 && i >= fi ? null : map.has(c) ? (map.get(c) as number) : 0,
    )
    const supplied = ser.mean ? new Map(ser.mean.map((p) => [p.x, p.y])) : null
    const d = supplied
      ? cats.map((c) => (supplied.has(c) ? (supplied.get(c) as number) : null))
      : trailingMean(actual, w)
    return d.some((v) => v != null) ? d : null
  })
})

/** Whether ANY series ended up with a mean — the gate on the key line below. */
const meanDrawn = computed(() => meanByIndex.value.some((d) => d !== null))

const option = computed<ECOption>(() => {
  const cats = categories.value
  const fi = forecastIdx.value
  const stacked = props.stacked
  const carbon3 = readVar('--carbon-3')
  const calm2 = readVar('--calm-2')

  const series: NonNullable<ECOption['series']> = []
  let bandPlaced = false

  props.series.forEach((ser, si) => {
    // An explicit colour wins; otherwise the vendor registry resolves the key.
    const color = ser.color ?? colorForKey(ser.key)
    const map = new Map(ser.data.map((p) => [p.x, p.y]))
    const aligned = cats.map((c) => (map.has(c) ? (map.get(c) as number) : 0))

    // Solid actual segment (null once projected).
    const actual = aligned.map((v, i) => (fi < 0 || i < fi ? v : null))
    const hasProjection = fi >= 0 && fi < cats.length
    const meanData = meanByIndex.value[si] ?? null

    series.push({
      name: ser.name,
      type: 'line',
      data: actual,
      smooth: props.smooth,
      showSymbol: false,
      symbol: 'circle',
      symbolSize: 8,
      connectNulls: false,
      // Demoted to a faint hairline when a mean is drawn over it: the daily
      // shape stays legible, the trend reads off the bold line.
      lineStyle: meanData ? { width: 1, color, opacity: 0.3 } : { width: 2, color },
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

    /*
     * The bold N-day trailing mean, LAST so it draws over its own daily line.
     *
     * It carries the SAME series name as the daily line, which is what keeps the
     * legend to one entry per series and the tooltip to one row per series (the
     * tooltip dedupes by name and the daily line was pushed first, so the hovered
     * number stays that DAY's value, never the smoothed one).
     */
    if (meanData) {
      series.push({
        name: ser.name,
        type: 'line',
        data: meanData,
        smooth: props.smooth,
        showSymbol: false,
        /*
         * The ONE series that bridges. A week's mean is defined on a day the
         * daily line has no point for (a ratio series' empty day still sits
         * inside a week that has data), and that day is not a category here, so
         * breaking the bold line there would draw a discontinuity the statistic
         * does not have. The daily line keeps `connectNulls: false` — its gaps
         * ARE the fact.
         */
        connectNulls: true,
        lineStyle: { width: 2.4, color },
        itemStyle: { color },
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
    <template v-if="hasData">
      <VChart
        :option="option"
        :style="{ height: `${height}px`, width: '100%' }"
        autoresize
        :aria-label="`Trend over time — ${series.map((s) => s.name).join(', ')}${
          meanDrawn ? `; daily, with a ${trailingMeanDays}-day trailing mean drawn bold` : ''
        }`"
        data-testid="chart-trend"
      />
      <!--
        The key for the two strokes, rendered HERE rather than by the card,
        because this component is the only thing that knows whether a mean was
        actually drawn. On a window too short for a full one there is no bold
        line and the daily line keeps full weight, so a card-owned caption would
        be describing a picture that is not on screen.
      -->
      <p
        v-if="meanDrawn"
        class="mt-2 text-[11px] text-carbon-3"
        data-testid="chart-trend-mean-key"
      >
        faint = daily · <b class="text-carbon-2">bold = {{ trailingMeanDays }}-day mean</b>
      </p>
    </template>
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center" data-testid="chart-trend-empty">
      {{ emptyLabel ?? 'No spend in this window yet — the chart fills in as sessions land.' }}
    </p>
    <template #fallback>
      <div :style="{ height: `${height}px` }" class="w-full animate-pulse bg-calm-1/40 rounded-lg" />
    </template>
  </ClientOnly>
</template>
